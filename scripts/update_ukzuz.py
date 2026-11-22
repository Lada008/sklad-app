#!/usr/bin/env python3
"""
Automatická denní synchronizace registru přípravků na ochranu rostlin ÚKZÚZ (eAGRI).

Funkce:
1. Stáhne aktuální otevřený export registru POR ze stránek MZe/eAGRI:
   https://mze.gov.cz/public/app/eagriapp/por/DataKeStazeni.aspx
   (primárně denní XLSX export ~12 MB, záložně XML export ~100 MB).
2. Očistí data: ponechá pouze přípravky se stavem „Platné rozhodnutí“
   a „Do spotřebování zásob“.
3. Sloučí k nim registrační číslo, platnost rozhodnutí, termín spotřeby zásob,
   složení účinných látek s koncentrací, chemickou skupinu, omezení pro PHO
   (ochranná pásma vod) a riziko pro včely.
4. Uloží optimalizovaný výstup do public/data/por_aktualni.json (včetně časového razítka).
5. Pokud je nakonfigurován Firebase (FIREBASE_SERVICE_ACCOUNT_JSON nebo
   GOOGLE_APPLICATION_CREDENTIALS), nahraje data i do Firestore kolekce `ukzuz_registr`.

Používá pouze standardní knihovnu Pythonu 3 (volitelně `firebase-admin` pro Firestore).
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import re
import sys
import tempfile
import unicodedata
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

POR_INDEX_URL = "https://mze.gov.cz/public/app/eagriapp/por/DataKeStazeni.aspx"
POR_XLSX_FALLBACK = "https://mze.gov.cz/public/app/eagriapp/por/export.xlsx"
POR_XML_FALLBACK = "https://mze.gov.cz/public/app/eagriapp/por/export.xml"

DEFAULT_OUTPUT_PATH = os.path.join("public", "data", "por_aktualni.json")
FIRESTORE_COLLECTION = "ukzuz_registr"

ALLOWED_STATUSES = {
    "Platné rozhodnutí",
    "Do spotřebování zásob",
}

XML_AKT_STAV_MAP = {
    "P": "Platné rozhodnutí",
    "Z": "Do spotřebování zásob",
}

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
PKG_REL_NS = "{http://schemas.openxmlformats.org/package/2006/relationships}"

USER_AGENT = (
    "Mozilla/5.0 (compatible; SkladovyAsistent-UKZUZ-Sync/1.0; "
    "+https://github.com/Lada008/sklad-app)"
)


def normalize_text(value: str | None) -> str:
    if not value:
        return ""
    s = unicodedata.normalize("NFD", str(value))
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
    return re.sub(r"\s+", " ", s).strip().lower()


def clean_ws(value: str | None) -> str:
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value).replace("\xa0", " ")).strip()


def parse_date_to_iso(raw: str | None) -> str | None:
    s = clean_ws(raw)
    if not s:
        return None
    # ISO datetime / date
    m_iso = re.match(r"^(\d{4})-(\d{2})-(\d{2})", s)
    if m_iso:
        return f"{m_iso.group(1)}-{m_iso.group(2)}-{m_iso.group(3)}"
    # Czech DD.MM.YYYY
    m_cz = re.match(r"^(\d{1,2})\.(\d{1,2})\.(\d{4})", s)
    if m_cz:
        return f"{m_cz.group(3)}-{int(m_cz.group(2)):02d}-{int(m_cz.group(1)):02d}"
    # Excel serial number
    try:
        num = float(s.replace(",", "."))
        if 20000 < num < 90000:
            dt = datetime(1899, 12, 30) + timedelta(days=int(num))
            return dt.strftime("%Y-%m-%d")
    except ValueError:
        pass
    return None


def _join_meaning_note(meaning: str, note: str) -> str:
    m = clean_ws(meaning)
    n = clean_ws(note)
    if m and n:
        return m if n in m else f"{m} {n}"
    return m or n


def classify_pho(code: str, meaning: str, note: str) -> dict[str, Any]:
    c = clean_ws(code)
    full = _join_meaning_note(meaning, note)
    norm = normalize_text(f"{c} {full}")

    is_unrestricted = (
        c in ("", "-", "- -")
        or "neni vyloucen" in norm
        or "bez omezeni" in norm
        or "bez oznaceni" in norm
    )
    restricted = (not is_unrestricted) and bool(c or full)
    if "vyloucen" in norm and "neni vyloucen" not in norm:
        restricted = True

    return {
        "code": c if c and c not in ("-", "- -") else "Bez omezení",
        "restricted": restricted,
        "text": full or (c if c and c not in ("-", "- -") else "Bez omezení v PHO"),
    }


def classify_bees(code: str, meaning: str, note: str) -> dict[str, Any]:
    c = clean_ws(code)
    full = _join_meaning_note(meaning, note)
    cu = c.upper()
    norm = normalize_text(f"{c} {full}")

    if cu == "ZNV" or "zvlast nebezpecny pro vcely" in norm:
        level = "danger"
        label = "ZNV — Zvlášť nebezpečný pro včely"
    elif cu == "NV" or "nebezpecny pro vcely" in norm:
        level = "warn"
        label = "NV — Nebezpečný pro včely"
    elif cu == "DO" or "cmelak" in norm or "opylovac" in norm or "sklenik" in norm:
        level = "info"
        label = "DO — Další omezení (opylovači)"
    else:
        level = "ok"
        label = "Bez označení (přijatelný pro včely)"

    return {
        "code": c if c and c not in ("-", "- -") else "OK",
        "level": level,
        "label": label,
        "text": full or label,
    }


def pho_severity(pho: dict[str, Any] | None) -> int:
    if not pho:
        return 0
    return 2 if pho.get("restricted") else 1


def bee_severity(bees: dict[str, Any] | None) -> int:
    if not bees:
        return 0
    return {"ok": 1, "info": 2, "warn": 3, "danger": 4}.get(bees.get("level", "ok"), 0)


def decision_rank(rec: dict[str, Any]) -> tuple[int, int, str, str]:
    status_score = 2 if rec.get("status") == "Platné rozhodnutí" else 1
    reg_stat = normalize_text(rec.get("regStatus", ""))
    if "standardni" in reg_stat or "narodni" in reg_stat or "nizke riziko" in reg_stat:
        type_score = 3
    elif "mensinove" in reg_stat:
        type_score = 1
    else:
        type_score = 2
    return (
        status_score,
        type_score,
        rec.get("validTo") or "0000-00-00",
        rec.get("effectiveFrom") or "0000-00-00",
    )


def merge_decisions_to_products(decisions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_name: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for d in decisions:
        name = clean_ws(d.get("name"))
        if not name:
            continue
        if d.get("status") not in ALLOWED_STATUSES:
            continue
        by_name[name].append(d)

    products: list[dict[str, Any]] = []
    for name, dec_list in by_name.items():
        dec_list.sort(key=decision_rank, reverse=True)
        primary = dec_list[0]

        # Sloučení účinných látek (primární rozhodnutí, případně doplnění z ostatních)
        ul_list = primary.get("ul") or []
        if not ul_list:
            for alt in dec_list[1:]:
                if alt.get("ul"):
                    ul_list = alt["ul"]
                    break

        # Deduplikace účinných látek
        seen_ul: set[tuple[str, str]] = set()
        clean_ul: list[dict[str, str]] = []
        groups: list[str] = []
        seen_groups: set[str] = set()

        for u in ul_list:
            un = clean_ws(u.get("n"))
            uc = clean_ws(u.get("c"))
            ug = clean_ws(u.get("g"))
            if not un:
                continue
            key = (un.lower(), uc.lower())
            if key not in seen_ul:
                seen_ul.add(key)
                entry: dict[str, str] = {"n": un}
                if uc:
                    entry["c"] = uc
                if ug:
                    entry["g"] = ug
                clean_ul.append(entry)
            if ug:
                for part in re.split(r"[;,/]+", ug):
                    p = clean_ws(part)
                    if p and p.lower() not in seen_groups:
                        seen_groups.add(p.lower())
                        groups.append(p)

        # Nejrelevantnější PHO a Včely napříč aktivními rozhodnutími stejného přípravku
        best_pho = primary.get("pho")
        for alt in dec_list[1:]:
            if pho_severity(alt.get("pho")) > pho_severity(best_pho):
                best_pho = alt.get("pho")

        best_bees = primary.get("bees")
        for alt in dec_list[1:]:
            if bee_severity(alt.get("bees")) > bee_severity(best_bees):
                best_bees = alt.get("bees")

        # Termín spotřeby zásob — u 'Do spotřebování zásob' max. povolené datum
        use_to = primary.get("useTo")
        market_to = primary.get("marketTo")
        valid_to = primary.get("validTo")

        item: dict[str, Any] = {
            "name": name,
            "reg": clean_ws(primary.get("reg")),
            "status": primary["status"],
            "validTo": valid_to,
            "marketTo": market_to,
            "useTo": use_to,
            "fn": clean_ws(primary.get("fn")),
            "holder": clean_ws(primary.get("holder")),
            "eco": bool(primary.get("eco")),
            "ul": clean_ul,
            "groups": groups,
            "pho": best_pho or classify_pho("", "", ""),
            "bees": best_bees or classify_bees("", "", ""),
        }
        if primary.get("itemId"):
            item["id"] = str(primary["itemId"])
        if primary.get("mainName") and primary["mainName"] != name:
            item["mainName"] = primary["mainName"]

        products.append(item)

    products.sort(key=lambda x: normalize_text(x["name"]))
    return products


# ---------------------------------------------------------------------------
# Parser 1: Denní XLSX export z eAGRI (POR_YYYY-MM-DD.xlsx / export.xlsx)
# ---------------------------------------------------------------------------

def _load_shared_strings(zf: zipfile.ZipFile) -> list[str]:
    if "xl/sharedStrings.xml" not in zf.namelist():
        return []
    out: list[str] = []
    for _, el in ET.iterparse(zf.open("xl/sharedStrings.xml")):
        if el.tag == f"{NS}si":
            out.append("".join(t.text or "" for t in el.iter(f"{NS}t")))
            el.clear()
    return out


def _resolve_sheets(zf: zipfile.ZipFile) -> dict[str, str]:
    wb = ET.fromstring(zf.read("xl/workbook.xml"))
    rels = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
    rel_map = {
        r.attrib["Id"]: r.attrib["Target"].lstrip("/")
        for r in rels.findall(f"{PKG_REL_NS}Relationship")
    }
    sheets: dict[str, str] = {}
    for sh in wb.findall(f".//{NS}sheet"):
        name = sh.attrib.get("name", "")
        rid = sh.attrib.get(f"{REL_NS}id", "")
        target = rel_map.get(rid, "")
        if target and not target.startswith("xl/"):
            target = "xl/" + target
        if target:
            sheets[name] = target
    return sheets


def _iter_xlsx_sheet(zf: zipfile.ZipFile, target: str, ss: list[str]):
    headers: dict[str, str] | None = None
    for _, el in ET.iterparse(zf.open(target)):
        if el.tag != f"{NS}row":
            continue
        row: dict[str, str | None] = {}
        for c in el:
            ref = c.attrib.get("r", "")
            col = "".join(ch for ch in ref if ch.isalpha())
            t = c.attrib.get("t")
            if t == "inlineStr":
                v = "".join(x.text or "" for x in c.iter(f"{NS}t"))
            else:
                ve = c.find(f"{NS}v")
                v = ve.text if ve is not None else None
                if t == "s" and v is not None:
                    idx = int(v)
                    v = ss[idx] if 0 <= idx < len(ss) else ""
            row[col] = v
        el.clear()
        if headers is None:
            headers = {col: clean_ws(val) for col, val in row.items() if val}
        else:
            yield {headers[col]: val for col, val in row.items() if col in headers}


def parse_ukzuz_xlsx(xlsx_path: str) -> list[dict[str, Any]]:
    with zipfile.ZipFile(xlsx_path, "r") as zf:
        ss = _load_shared_strings(zf)
        sheets = _resolve_sheets(zf)

        def find_sheet(prefixes: tuple[str, ...]) -> str | None:
            for name, target in sheets.items():
                n = normalize_text(name)
                if any(n.startswith(p) for p in prefixes):
                    return target
            return None

        sh_rozh = find_sheet(("rozhodnuti",)) or next(iter(sheets.values()))
        sh_udaje = find_sheet(("udaje",))
        sh_ul = find_sheet(("ucinne latky",))

        decisions_by_key: dict[tuple[str, str], dict[str, Any]] = {}
        allowed_dec_ids: set[str] = set()

        for row in _iter_xlsx_sheet(zf, sh_rozh, ss):
            status = clean_ws(row.get("Aktuální stav rozhodnutí"))
            if status not in ALLOWED_STATUSES:
                continue
            name = clean_ws(row.get("Obchodní název přípravku"))
            dec_id = clean_ws(row.get("Id rozhodnutí"))
            if not name:
                continue
            if dec_id:
                allowed_dec_ids.add(dec_id)

            eco_raw = normalize_text(row.get("Pro ekologické zemědělství"))
            rec = {
                "name": name,
                "itemId": clean_ws(row.get("Id položky")),
                "mainName": clean_ws(row.get("Obchodní název hlavního přípravku")),
                "reg": clean_ws(row.get("Registrační číslo")),
                "decId": dec_id,
                "holder": clean_ws(row.get("Držitel rozhodnutí")),
                "effectiveFrom": parse_date_to_iso(row.get("Právní účinky rozhodnutí ode dne")),
                "validTo": parse_date_to_iso(row.get("Platnost rozhodnutí končí dne")),
                "marketTo": parse_date_to_iso(row.get("Ukončení uvádění na trh")),
                "useTo": parse_date_to_iso(row.get("Používání povoleno max. do")),
                "fn": clean_ws(row.get("Biologická funkce")),
                "regStatus": clean_ws(row.get("Status registrace")),
                "eco": eco_raw in ("ano", "true", "1"),
                "status": status,
                "ul": [],
                "pho": None,
                "bees": None,
            }
            decisions_by_key[(name, dec_id)] = rec

        # Index podle Id rozhodnutí pro rychlé napojení (včetně alternativních obchodních jmen)
        decs_by_id: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for rec in decisions_by_key.values():
            if rec["decId"]:
                decs_by_id[rec["decId"]].append(rec)

        # List 2: Údaje (PHO + Riziko pro včely)
        if sh_udaje:
            for row in _iter_xlsx_sheet(zf, sh_udaje, ss):
                dec_id = clean_ws(row.get("Id rozhodnutí"))
                if dec_id not in allowed_dec_ids:
                    continue
                udaj = normalize_text(row.get("Hodnocený údaj"))
                is_pho = "ochranna pasma vod" in udaj
                is_bees = "riziko pro vcely" in udaj
                if not is_pho and not is_bees:
                    continue

                name = clean_ws(row.get("Obchodní název přípravku"))
                targets = (
                    [decisions_by_key[(name, dec_id)]]
                    if (name, dec_id) in decisions_by_key
                    else decs_by_id.get(dec_id, [])
                )

                code = row.get("Zkratka") or ""
                meaning = row.get("Význam údaje") or ""
                note = row.get("Poznámka") or ""

                if is_pho:
                    parsed_pho = classify_pho(code, meaning, note)
                    for t in targets:
                        if pho_severity(parsed_pho) > pho_severity(t["pho"]):
                            t["pho"] = parsed_pho
                elif is_bees:
                    parsed_bees = classify_bees(code, meaning, note)
                    for t in targets:
                        if bee_severity(parsed_bees) > bee_severity(t["bees"]):
                            t["bees"] = parsed_bees

        # List 3: Účinné látky + chemické skupiny
        if sh_ul:
            for row in _iter_xlsx_sheet(zf, sh_ul, ss):
                dec_id = clean_ws(row.get("Id rozhodnutí"))
                if dec_id not in allowed_dec_ids:
                    continue
                ul_name = clean_ws(row.get("Název účinné látky"))
                if not ul_name:
                    continue
                qty = clean_ws(row.get("Množství"))
                unit = clean_ws(row.get("Měrná jednotka"))
                conc = f"{qty} {unit}".strip() if qty else unit
                group = clean_ws(row.get("Skupiny"))

                name = clean_ws(row.get("Obchodní název přípravku"))
                targets = (
                    [decisions_by_key[(name, dec_id)]]
                    if (name, dec_id) in decisions_by_key
                    else decs_by_id.get(dec_id, [])
                )
                ul_obj = {"n": ul_name, "c": conc, "g": group}
                for t in targets:
                    t["ul"].append(ul_obj)

        return merge_decisions_to_products(list(decisions_by_key.values()))


# ---------------------------------------------------------------------------
# Parser 2: Záložní XML export z eAGRI (POR_YYYY-MM-DD.xml / export.xml)
# ---------------------------------------------------------------------------

def _child_text(elem: ET.Element, tag: str) -> str:
    child = elem.find(tag)
    return clean_ws(child.text) if child is not None and child.text else ""


def parse_ukzuz_xml(xml_path: str) -> list[dict[str, Any]]:
    decisions: list[dict[str, Any]] = []

    for _, elem in ET.iterparse(xml_path, events=("end",)):
        tag_local = elem.tag.split("}")[-1]
        if tag_local != "POLOZKA":
            continue

        item_id = _child_text(elem, "ID")
        main_ojp = _child_text(elem, "OJP")

        for rozh in elem.findall("ROZHODNUTI"):
            akt_stav = _child_text(rozh, "AKT_STAV")
            status = XML_AKT_STAV_MAP.get(akt_stav)
            if not status:
                continue

            # Obchodní jména (hlavní + případný seznam OJP_LIST)
            trade_names: list[str] = []
            for ojp_node in rozh.findall("./OJP_LIST/OJP"):
                nm = _child_text(ojp_node, "OJP_NAZEV")
                if nm and nm not in trade_names:
                    trade_names.append(nm)
            if main_ojp and main_ojp not in trade_names:
                trade_names.insert(0, main_ojp)

            ul_list: list[dict[str, str]] = []
            for ul in rozh.findall("UL"):
                un = _child_text(ul, "NAZEV")
                if not un:
                    continue
                qty = _child_text(ul, "MNOZSTVI")
                mj = _child_text(ul, "MJ")
                conc = f"{qty} {mj}".strip() if qty else mj
                sk_parts = []
                for sk in ul.findall("SKUP_UL"):
                    en = _child_text(sk, "NAZEV_EN")
                    kd = _child_text(sk, "KOD")
                    txt = en or kd
                    if txt and txt not in sk_parts:
                        sk_parts.append(txt)
                ul_list.append({"n": un, "c": conc, "g": ", ".join(sk_parts)})

            best_pho = None
            best_bees = None
            for ud in rozh.findall("UDAJE"):
                domena = (ud.attrib.get("domena") or "").upper()
                udaj_txt = normalize_text(_child_text(ud, "UDAJ"))
                zkr = _child_text(ud, "ZKR")
                vyznam = _child_text(ud, "VYZNAM")
                pozn = _child_text(ud, "POZNAMKA")
                if domena == "VA02" or "ochranna pasma vod" in udaj_txt:
                    p = classify_pho(zkr, vyznam, pozn)
                    if pho_severity(p) > pho_severity(best_pho):
                        best_pho = p
                elif domena == "VA04" or "riziko pro vcely" in udaj_txt:
                    b = classify_bees(zkr, vyznam, pozn)
                    if bee_severity(b) > bee_severity(best_bees):
                        best_bees = b

            base = {
                "itemId": item_id,
                "mainName": main_ojp,
                "reg": _child_text(rozh, "REG_CISLO"),
                "decId": _child_text(rozh, "ID"),
                "holder": _child_text(rozh, "DRZ_ROZH"),
                "effectiveFrom": parse_date_to_iso(_child_text(rozh, "D_NABYLO_PR_MOCI")),
                "validTo": parse_date_to_iso(_child_text(rozh, "D_PLATNE_DO")),
                "marketTo": parse_date_to_iso(_child_text(rozh, "D_ZASD_SKUT")),
                "useTo": parse_date_to_iso(_child_text(rozh, "D_ZAS_SKUT")),
                "fn": _child_text(rozh, "B_FCE"),
                "regStatus": _child_text(rozh, "STATUS_REG"),
                "eco": _child_text(rozh, "EKO").lower() == "true",
                "status": status,
                "ul": ul_list,
                "pho": best_pho,
                "bees": best_bees,
            }
            for nm in trade_names:
                decisions.append({**base, "name": nm})

        elem.clear()

    return merge_decisions_to_products(decisions)


# ---------------------------------------------------------------------------
# Parser 3: Záložní CSV export (pro případ ručního exportu)
# ---------------------------------------------------------------------------

def parse_ukzuz_csv(csv_path: str) -> list[dict[str, Any]]:
    raw = open(csv_path, "rb").read()
    for enc in ("utf-8-sig", "cp1250", "latin-1"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    else:
        text = raw.decode("utf-8", errors="replace")

    dialect = csv.Sniffer().sniff(text[:4096], delimiters=";,\t")
    reader = csv.DictReader(io.StringIO(text), dialect=dialect)
    decisions: list[dict[str, Any]] = []

    for row in reader:
        norm_row = {normalize_text(k): clean_ws(v) for k, v in row.items() if k}
        name = (
            norm_row.get("obchodni nazev pripravku")
            or norm_row.get("nazev pripravku")
            or norm_row.get("nazev")
            or norm_row.get("ojp")
            or ""
        )
        if not name:
            continue
        status = norm_row.get("aktualni stav rozhodnuti") or norm_row.get("stav") or "Platné rozhodnutí"
        if normalize_text(status) == "platne rozhodnuti":
            status = "Platné rozhodnutí"
        elif "spotrebovani" in normalize_text(status):
            status = "Do spotřebování zásob"
        if status not in ALLOWED_STATUSES:
            continue

        ul_str = norm_row.get("ucinne latky") or norm_row.get("ucinny latka") or norm_row.get("ucinna latka") or ""
        grp_str = norm_row.get("chemicka skupina") or norm_row.get("skupiny") or ""
        ul_list = [{"n": clean_ws(p), "c": "", "g": grp_str} for p in re.split(r"[;,]+", ul_str) if clean_ws(p)]

        decisions.append({
            "name": name,
            "reg": norm_row.get("registracni cislo") or norm_row.get("reg_cislo") or "",
            "status": status,
            "validTo": parse_date_to_iso(norm_row.get("platnost rozhodnuti konci dne") or norm_row.get("platnost do")),
            "marketTo": parse_date_to_iso(norm_row.get("ukonceni uvadeni na trh")),
            "useTo": parse_date_to_iso(norm_row.get("pouzivani povoleno max. do") or norm_row.get("termin spotreby zasob")),
            "fn": norm_row.get("biologicka funkce") or norm_row.get("funkce") or "",
            "holder": norm_row.get("drzitel rozhodnuti") or "",
            "eco": normalize_text(norm_row.get("pro ekologicke zemedelstvi")) in ("ano", "true", "1"),
            "ul": ul_list,
            "pho": classify_pho(norm_row.get("pho") or norm_row.get("ochranna pasma vod") or "", "", ""),
            "bees": classify_bees(norm_row.get("riziko pro vcely") or norm_row.get("vcely") or "", "", ""),
        })

    return merge_decisions_to_products(decisions)


# ---------------------------------------------------------------------------
# Stahování z eAGRI
# ---------------------------------------------------------------------------

def discover_export_urls(index_url: str = POR_INDEX_URL) -> list[tuple[str, str, str]]:
    """
    Stáhne stránku DataKeStazeni.aspx a najde aktuální odkazy na export (.xlsx a .xml).
    Vrací seznam (format, url, label) v preferovaném pořadí (XLSX první, XML záloha).
    """
    candidates: list[tuple[str, str, str]] = []
    try:
        req = urllib.request.Request(index_url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=25) as resp:
            html = resp.read().decode("utf-8", errors="replace")

        for m in re.finditer(r'<a\b[^>]*href=["\']([^"\']+)["\'][^>]*>(.*?)</a>', html, re.IGNORECASE | re.DOTALL):
            href = clean_ws(m.group(1))
            label = clean_ws(re.sub(r"<[^>]+>", "", m.group(2)))
            low = (href + " " + label).lower()
            full_url = urllib.parse.urljoin(index_url, href)
            if ".xlsx" in low and ("export" in low or "por_" in low):
                candidates.append(("xlsx", full_url, label or "export.xlsx"))
            elif ".xml" in low and ("export" in low or "por_" in low):
                candidates.append(("xml", full_url, label or "export.xml"))
    except Exception as exc:
        print(f"Varování: nepodařilo se načíst index {index_url}: {exc}", file=sys.stderr)

    # Fallback přímé URL
    seen = {u for _, u, _ in candidates}
    if POR_XLSX_FALLBACK not in seen:
        candidates.append(("xlsx", POR_XLSX_FALLBACK, "export.xlsx"))
    if POR_XML_FALLBACK not in seen:
        candidates.append(("xml", POR_XML_FALLBACK, "export.xml"))

    # Preferuj XLSX (12 MB vs 100 MB XML)
    candidates.sort(key=lambda item: 0 if item[0] == "xlsx" else 1)
    return candidates


def download_file(url: str, dest_path: str) -> int:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    total = 0
    with urllib.request.urlopen(req, timeout=180) as resp, open(dest_path, "wb") as out:
        while True:
            chunk = resp.read(262144)
            if not chunk:
                break
            out.write(chunk)
            total += len(chunk)
    return total


# ---------------------------------------------------------------------------
# Volitelný upload do Firebase Firestore (kolekce `ukzuz_registr`)
# ---------------------------------------------------------------------------

def upload_to_firestore(payload: dict[str, Any], collection_name: str = FIRESTORE_COLLECTION) -> bool:
    sa_json = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON", "").strip()
    sa_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", "").strip()

    if not sa_json and not (sa_path and os.path.exists(sa_path)):
        print("ℹ️ Firebase není nakonfigurován (chybí FIREBASE_SERVICE_ACCOUNT_JSON) — ukládám pouze JSON.")
        return False

    try:
        import firebase_admin
        from firebase_admin import credentials, firestore
    except ImportError:
        print(
            "⚠️ Firebase credentials jsou nastaveny, ale není nainstalován balíček `firebase-admin`.",
            file=sys.stderr,
        )
        return False

    if not firebase_admin._apps:
        if sa_json:
            cred = credentials.Certificate(json.loads(sa_json))
        else:
            cred = credentials.Certificate(sa_path)
        firebase_admin.initialize_app(cred)

    db = firestore.client()
    col_ref = db.collection(collection_name)

    # 1. Metadata dokument
    col_ref.document("_meta").set(payload["meta"])

    # 2. Dávkový zápis přípravků (max 450 na batch, limit Firestore je 500)
    batch = db.batch()
    ops = 0
    written = 0
    for item in payload["items"]:
        doc_key = re.sub(r"[^a-z0-9_-]+", "_", normalize_text(item["name"]))[:120] or f"por_{written}"
        batch.set(col_ref.document(doc_key), item)
        ops += 1
        written += 1
        if ops >= 450:
            batch.commit()
            batch = db.batch()
            ops = 0
    if ops > 0:
        batch.commit()

    print(f"🔥 Nahráno {written} přípravků do Firestore kolekce `{collection_name}`.")
    return True


# ---------------------------------------------------------------------------
# Hlavní běh
# ---------------------------------------------------------------------------

def build_payload(products: list[dict[str, Any]], source_label: str, source_url: str) -> dict[str, Any]:
    now_cz = datetime.now(ZoneInfo("Europe/Prague"))
    valid_count = sum(1 for p in products if p["status"] == "Platné rozhodnutí")
    stock_use_count = sum(1 for p in products if p["status"] == "Do spotřebování zásob")
    pho_restricted = sum(1 for p in products if p.get("pho", {}).get("restricted"))
    bee_warn = sum(1 for p in products if p.get("bees", {}).get("level") in ("warn", "danger"))

    return {
        "meta": {
            "updatedAt": now_cz.strftime("%d.%m.%Y %H:%M"),
            "updatedIso": now_cz.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "source": source_label,
            "sourceUrl": source_url,
            "totalProducts": len(products),
            "validCount": valid_count,
            "stockConsumptionCount": stock_use_count,
            "phoRestrictedCount": pho_restricted,
            "beeRiskCount": bee_warn,
        },
        "items": products,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Synchronizace registru POR ÚKZÚZ (eAGRI)")
    parser.add_argument("--input", help="Lokální soubor (.xlsx, .xml nebo .csv) místo stahování z eAGRI")
    parser.add_argument("--output", default=DEFAULT_OUTPUT_PATH, help="Cesta k výstupnímu JSON souboru")
    parser.add_argument("--skip-firebase", action="store_true", help="Přeskočit nahrání do Firebase Firestore")
    args = parser.parse_args()

    products: list[dict[str, Any]] = []
    source_label = ""
    source_url = ""

    if args.input:
        path = args.input
        if not os.path.exists(path):
            print(f"❌ Soubor neexistuje: {path}", file=sys.stderr)
            return 1
        ext = os.path.splitext(path)[1].lower()
        source_label = os.path.basename(path)
        source_url = "local"
        if ext == ".xlsx":
            products = parse_ukzuz_xlsx(path)
        elif ext == ".xml":
            products = parse_ukzuz_xml(path)
        elif ext == ".csv":
            products = parse_ukzuz_csv(path)
        else:
            print(f"❌ Nepodporovaný formát: {ext}", file=sys.stderr)
            return 1
    else:
        candidates = discover_export_urls(POR_INDEX_URL)
        last_err: Exception | None = None
        with tempfile.TemporaryDirectory(prefix="ukzuz_") as tmpdir:
            for fmt, url, label in candidates:
                dest = os.path.join(tmpdir, f"por_export.{fmt}")
                try:
                    print(f"⬇️ Stahuji {label} z {url} …")
                    size = download_file(url, dest)
                    print(f"   Staženo {size / (1024 * 1024):.2f} MB — zpracovávám ({fmt.upper()})…")
                    if fmt == "xlsx":
                        products = parse_ukzuz_xlsx(dest)
                    else:
                        products = parse_ukzuz_xml(dest)
                    if products:
                        source_label = label
                        source_url = url
                        break
                except Exception as exc:
                    last_err = exc
                    print(f"⚠️ Pokus {url} selhal: {exc}", file=sys.stderr)

        if not products:
            print(f"❌ Nepodařilo se stáhnout a zpracovat data ÚKZÚZ. Poslední chyba: {last_err}", file=sys.stderr)
            return 1

    payload = build_payload(products, source_label, source_url)

    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))

    out_kb = os.path.getsize(args.output) / 1024
    m = payload["meta"]
    print(
        f"✅ Uloženo {args.output} ({out_kb:.1f} KB): "
        f"{m['totalProducts']} přípravků "
        f"(Platné: {m['validCount']}, Do spotřebování zásob: {m['stockConsumptionCount']}, "
        f"PHO omezení: {m['phoRestrictedCount']}, Riziko pro včely: {m['beeRiskCount']})."
    )

    if not args.skip_firebase:
        upload_to_firestore(payload)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
