#!/usr/bin/env python3
"""
Automatická denní synchronizace registru přípravků na ochranu rostlin ÚKZÚZ (eAGRI).

Funkce:
1. Stáhne aktuální otevřený export registru POR ze stránek MZe/eAGRI:
   https://mze.gov.cz/public/app/eagriapp/por/DataKeStazeni.aspx
   (primárně denní XLSX export ~12 MB, záložně XML export ~100 MB).
2. Očistí data: ponechá pouze přípravky se stavem „Platné rozhodnutí“
   a „Do spotřebování zásob“.
3. Sloučí k nim z listů Rozhodnutí, Údaje, Účinné látky, Plodiny a Dávkování/Použití:
   - registrační číslo, platnost rozhodnutí, termín doprodeje a spotřeby zásob,
   - účinné látky (název, množství, měrná jednotka, chemická skupina / mechanismus účinku),
   - omezení pro ochranná pásma vod (PHO: OP II.st. vs. povolen - / - - + textový detail),
   - riziko pro včely (ZNV, NV, SPe8, DO, nebo bez omezení - - + textový detail),
   - registrované plodiny a dávkování seskupené do hlavních kategorií stříkání:
     Obiloviny, Řepka, Réva vinná, Kukuřice, Brambory a cukrovka, Sady a zelenina, Ostatní
     + konkrétní plodiny, škodlivé organismy, dávky a ochranné lhůty v detailu.
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

# Hlavní agronomické kategorie stříkání
CROP_CATEGORY_ORDER = (
    "obiloviny",
    "repka",
    "reva",
    "kukurice",
    "brambory_cukrovka",
    "sady_zelenina",
    "ostatni",
)

CROP_RULES: list[tuple[str, tuple[str, ...]]] = [
    (
        "obiloviny",
        (
            "psenic",
            "jecmen",
            "zito",
            "tritikal",
            "oves",
            "obilnin",
            "obilovin",
            "spald",
            "sladovn",
        ),
    ),
    (
        "repka",
        (
            "repk",
            "horcic",
            "brukvovit",
            "lnick",
        ),
    ),
    (
        "reva",
        (
            "reva",
            "revy",
            "reve",
            "vinic",
            "vinn",
        ),
    ),
    (
        "kukurice",
        (
            "kukuric",
            "cirok",
            "proso",
        ),
    ),
    (
        "brambory_cukrovka",
        (
            "brambor",
            "batat",
            "cukrovk",
            "repa cukrov",
            "repa krmn",
            "repa sal",
            "repa cerven",
            "krmna repa",
            "cukrova repa",
        ),
    ),
    (
        "sady_zelenina",
        (
            "jablon",
            "hrusn",
            "slivon",
            "tresn",
            "visn",
            "merunk",
            "broskvon",
            "jadrov",
            "peckov",
            "ovocn",
            "sady",
            "jahod",
            "malin",
            "ostruzin",
            "rybiz",
            "angrest",
            "boruvk",
            "orech",
            "oresak",
            "lisk",
            "zelenin",
            "rajc",
            "paprik",
            "okurk",
            "cibul",
            "cesnek",
            "por",
            "mrkev",
            "petrzel",
            "celer",
            "zeli",
            "kapust",
            "kvetak",
            "brokolic",
            "salat",
            "spenat",
            "hrach zahrad",
            "fazol",
            "tykv",
            "cuket",
            "meloun",
            "redkv",
            "chrest",
            "rebarb",
        ),
    ),
]

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
PKG_REL_NS = "{http://schemas.openxmlformats.org/package/2006/relationships}"

USER_AGENT = (
    "Mozilla/5.0 (compatible; SkladovyAsistent-UKZUZ-Sync/2.0; "
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


def clean_dose_text(value: str | None) -> str:
    s = clean_ws(value)
    s = re.sub(r"\s*,\s*$", "", s)
    s = re.sub(r"\s+,", ",", s)
    return s.strip()


def classify_crop_categories(crop_text: str | None) -> set[str]:
    norm = normalize_text(crop_text)
    if not norm:
        return set()
    matched: set[str] = set()
    for cat_key, keywords in CROP_RULES:
        if any(kw in norm for kw in keywords):
            matched.add(cat_key)
    if not matched:
        matched.add("ostatni")
    return matched


def parse_date_to_iso(raw: str | None) -> str | None:
    s = clean_ws(raw)
    if not s:
        return None
    m_iso = re.match(r"^(\d{4})-(\d{2})-(\d{2})", s)
    if m_iso:
        return f"{m_iso.group(1)}-{m_iso.group(2)}-{m_iso.group(3)}"
    m_cz = re.match(r"^(\d{1,2})\.(\d{1,2})\.(\d{4})", s)
    if m_cz:
        return f"{m_cz.group(3)}-{int(m_cz.group(2)):02d}-{int(m_cz.group(1)):02d}"
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

    display_code = "OP II.st." if restricted and ("op ii" in norm or c == "OP II.st.") else (
        c if c and c not in ("-", "- -") else "Bez omezení"
    )

    return {
        "code": display_code,
        "restricted": restricted,
        "text": full or (display_code if restricted else "Přípravek není vyloučen z použití v OP II. stupně zdrojů vod."),
    }


def classify_bees(code: str, meaning: str, note: str) -> dict[str, Any]:
    c = clean_ws(code).rstrip(".")
    full = _join_meaning_note(meaning, note)
    cu = c.upper()
    norm = normalize_text(f"{c} {full}")

    if cu == "ZNV" or "zvlast nebezpecny pro vcely" in norm:
        std_code = "ZNV"
        level = "danger"
        label = "ZNV — Zvlášť nebezpečný pro včely"
    elif cu == "NV" or "nebezpecny pro vcely" in norm:
        std_code = "NV"
        level = "warn"
        label = "NV — Nebezpečný pro včely"
    elif cu == "SPE8" or "spe8" in norm or "spe 8" in norm:
        std_code = "SPe8"
        level = "warn"
        label = "SPe8 — Nebezpečný pro včely"
    elif cu == "DO" or "cmelak" in norm or "opylovac" in norm or "sklenik" in norm:
        std_code = "DO"
        level = "info"
        label = "DO — Další omezení (opylovači)"
    else:
        std_code = "OK"
        level = "ok"
        label = "Bez omezení pro včely"

    return {
        "code": std_code,
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
    code = (bees.get("code") or "").upper()
    if code == "ZNV":
        return 5
    if code in ("NV", "SPE8"):
        return 4
    if code == "DO":
        return 2
    return 1


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

        # 1. Sloučení účinných látek (název, množství, jednotka, koncentrace, chemická skupina)
        ul_list = primary.get("ul") or []
        if not ul_list:
            for alt in dec_list[1:]:
                if alt.get("ul"):
                    ul_list = alt["ul"]
                    break

        seen_ul: set[tuple[str, str]] = set()
        clean_ul: list[dict[str, str]] = []
        groups: list[str] = []
        seen_groups: set[str] = set()

        for u in ul_list:
            un = clean_ws(u.get("n"))
            uq = clean_ws(u.get("q"))
            uu = clean_ws(u.get("u"))
            uc = clean_ws(u.get("c")) or (f"{uq} {uu}".strip() if uq else uu)
            ug = clean_ws(u.get("g"))
            if not un:
                continue
            key = (un.lower(), uc.lower())
            if key not in seen_ul:
                seen_ul.add(key)
                entry: dict[str, str] = {"n": un}
                if uq:
                    entry["q"] = uq
                if uu:
                    entry["u"] = uu
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

        # 2. Nejrelevantnější PHO a Včely napříč aktivními rozhodnutími
        best_pho = primary.get("pho")
        for alt in dec_list[1:]:
            if pho_severity(alt.get("pho")) > pho_severity(best_pho):
                best_pho = alt.get("pho")

        best_bees = primary.get("bees")
        for alt in dec_list[1:]:
            if bee_severity(alt.get("bees")) > bee_severity(best_bees):
                best_bees = alt.get("bees")

        # 3. Sloučení plodin, hlavních kategorií stříkání a dávkování
        cg_set: set[str] = set()
        crops_list: list[str] = []
        seen_crops: set[str] = set()
        uses_list: list[dict[str, str]] = []
        seen_uses: set[tuple[str, str, str]] = set()

        for dec in dec_list:
            for cg in dec.get("cg") or ():
                cg_set.add(cg)
            for cr in dec.get("crops") or ():
                cr_clean = clean_ws(cr)
                cr_norm = normalize_text(cr_clean)
                if cr_clean and cr_norm not in seen_crops:
                    seen_crops.add(cr_norm)
                    crops_list.append(cr_clean)
            for u in dec.get("uses") or ():
                c_txt = clean_ws(u.get("c"))
                p_txt = clean_ws(u.get("p"))
                d_txt = clean_dose_text(u.get("d"))
                ol_txt = clean_ws(u.get("ol"))
                if not c_txt:
                    continue
                ukey = (normalize_text(c_txt), normalize_text(p_txt), normalize_text(d_txt))
                if ukey not in seen_uses:
                    seen_uses.add(ukey)
                    use_entry: dict[str, str] = {"c": c_txt}
                    if p_txt:
                        use_entry["p"] = p_txt
                    if d_txt:
                        use_entry["d"] = d_txt
                    if ol_txt:
                        use_entry["ol"] = ol_txt
                    uses_list.append(use_entry)
                if normalize_text(c_txt) not in seen_crops:
                    seen_crops.add(normalize_text(c_txt))
                    crops_list.append(c_txt)

        ordered_cg = [cat for cat in CROP_CATEGORY_ORDER if cat in cg_set]

        item: dict[str, Any] = {
            "name": name,
            "reg": clean_ws(primary.get("reg")),
            "status": primary["status"],
            "validTo": primary.get("validTo"),
            "marketTo": primary.get("marketTo"),
            "useTo": primary.get("useTo"),
            "fn": clean_ws(primary.get("fn")),
            "holder": clean_ws(primary.get("holder")),
            "eco": bool(primary.get("eco")),
            "ul": clean_ul,
            "groups": groups,
            "pho": best_pho or classify_pho("", "", ""),
            "bees": best_bees or classify_bees("", "", ""),
            "cg": ordered_cg,
            "crops": crops_list[:25],
            "uses": uses_list[:18],
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

        def find_sheet(exact_or_prefix: str, exclude_vs: bool = True) -> str | None:
            for name, target in sheets.items():
                n = normalize_text(name)
                if exclude_vs and "vs." in n:
                    continue
                if n == exact_or_prefix or n.startswith(exact_or_prefix):
                    return target
            return None

        sh_rozh = find_sheet("rozhodnuti") or next(iter(sheets.values()))
        sh_udaje = find_sheet("udaje")
        sh_ul = find_sheet("ucinne latky")
        sh_pouziti = find_sheet("pouziti")
        sh_davkovani = find_sheet("davkovani")
        sh_plodiny = find_sheet("plodiny")

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
                "cg": set(),
                "crops": [],
                "uses": [],
            }
            decisions_by_key[(name, dec_id)] = rec

        decs_by_id: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for rec in decisions_by_key.values():
            if rec["decId"]:
                decs_by_id[rec["decId"]].append(rec)

        def get_targets(name: str, dec_id: str) -> list[dict[str, Any]]:
            if (name, dec_id) in decisions_by_key:
                return [decisions_by_key[(name, dec_id)]]
            return decs_by_id.get(dec_id, [])

        # List 2: Údaje (Ochranná pásma vod + Riziko pro včely)
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

                targets = get_targets(clean_ws(row.get("Obchodní název přípravku")), dec_id)
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

        # List 3: Účinné látky + množství + jednotka + chemická skupina
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

                targets = get_targets(clean_ws(row.get("Obchodní název přípravku")), dec_id)
                ul_obj = {"n": ul_name, "q": qty, "u": unit, "c": conc, "g": group}
                for t in targets:
                    t["ul"].append(ul_obj)

        # List 6: Dávkování (Plodina + Škodlivý organismus + Celá dávka textem)
        if sh_davkovani:
            for row in _iter_xlsx_sheet(zf, sh_davkovani, ss):
                dec_id = clean_ws(row.get("Id rozhodnutí"))
                if dec_id not in allowed_dec_ids:
                    continue
                crop = clean_ws(row.get("Plodina, oblast použití"))
                if not crop:
                    continue
                pest = clean_ws(row.get("Škodlivý organismus, jiný účel použití"))
                whole_dose = clean_dose_text(row.get("Celá dávka textem"))
                if not whole_dose:
                    d_val = clean_ws(row.get("Dávkování"))
                    d_mj = clean_ws(row.get("Měrná jednotka"))
                    d_ext = clean_ws(row.get("Textový doplněk u dávkování"))
                    whole_dose = clean_dose_text(f"{d_val} {d_mj} {d_ext}")

                cats = classify_crop_categories(crop)
                targets = get_targets(clean_ws(row.get("Obchodní název přípravku")), dec_id)
                use_obj = {"c": crop, "p": pest, "d": whole_dose}
                for t in targets:
                    t["cg"].update(cats)
                    t["uses"].append(use_obj)

        # List 5: Použití (doplnění Ochranné lhůty nebo záznamu, pokud Dávkování chybělo)
        if sh_pouziti:
            for row in _iter_xlsx_sheet(zf, sh_pouziti, ss):
                dec_id = clean_ws(row.get("Id rozhodnutí"))
                if dec_id not in allowed_dec_ids:
                    continue
                crop = clean_ws(row.get("Plodina, oblast použití"))
                if not crop:
                    continue
                pest = clean_ws(row.get("Škodlivý organismus, jiný účel použití"))
                dose = clean_dose_text(row.get("Dávkování"))
                ol = clean_ws(row.get("Ochranná lhůta"))
                cats = classify_crop_categories(crop)
                targets = get_targets(clean_ws(row.get("Obchodní název přípravku")), dec_id)
                for t in targets:
                    t["cg"].update(cats)
                    if not t["uses"]:
                        t["uses"].append({"c": crop, "p": pest, "d": dose, "ol": ol})

        # List 9: Plodiny (číselníkové názvy plodin + výpis plodin)
        if sh_plodiny:
            for row in _iter_xlsx_sheet(zf, sh_plodiny, ss):
                dec_id = clean_ws(row.get("Id rozhodnutí"))
                if dec_id not in allowed_dec_ids:
                    continue
                crop_name = clean_ws(row.get("Název"))
                web_crop = clean_ws(
                    row.get("Výpis plodin podle webové prezentace (bez vazby na číselník)")
                )
                targets = get_targets(clean_ws(row.get("Obchodní název přípravku")), dec_id)
                for label in (crop_name, web_crop):
                    if label:
                        cats = classify_crop_categories(label)
                        for t in targets:
                            t["cg"].update(cats)
                            t["crops"].append(label)

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
                ul_list.append({"n": un, "q": qty, "u": mj, "c": conc, "g": ", ".join(sk_parts)})

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

            cg_set: set[str] = set()
            crops_list: list[str] = []
            uses_list: list[dict[str, str]] = []
            for pouz in rozh.findall("POUZITI"):
                plod = _child_text(pouz, "PLODINA")
                so = _child_text(pouz, "SO")
                davka = clean_dose_text(_child_text(pouz, "DAVKA"))
                ol = _child_text(pouz, "OL")
                if plod:
                    cg_set.update(classify_crop_categories(plod))
                    crops_list.append(plod)
                    uses_list.append({"c": plod, "p": so, "d": davka, "ol": ol})

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
                "cg": cg_set,
                "crops": crops_list,
                "uses": uses_list,
            }
            for nm in trade_names:
                decisions.append({**base, "name": nm})

        elem.clear()

    return merge_decisions_to_products(decisions)


# ---------------------------------------------------------------------------
# Parser 3: Záložní CSV export
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

        ul_str = norm_row.get("ucinne latky") or norm_row.get("ucinna latka") or ""
        grp_str = norm_row.get("chemicka skupina") or norm_row.get("skupiny") or ""
        ul_list = [{"n": clean_ws(p), "c": "", "g": grp_str} for p in re.split(r"[;,]+", ul_str) if clean_ws(p)]

        plod = norm_row.get("plodina") or norm_row.get("plodina, oblast pouziti") or ""
        davka = clean_dose_text(norm_row.get("davkovani") or norm_row.get("cela davka textem") or "")
        cg_set = classify_crop_categories(plod) if plod else set()

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
            "cg": cg_set,
            "crops": [plod] if plod else [],
            "uses": [{"c": plod, "d": davka}] if plod else [],
        })

    return merge_decisions_to_products(decisions)


# ---------------------------------------------------------------------------
# Stahování z eAGRI
# ---------------------------------------------------------------------------

def discover_export_urls(index_url: str = POR_INDEX_URL) -> list[tuple[str, str, str]]:
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

    seen = {u for _, u, _ in candidates}
    if POR_XLSX_FALLBACK not in seen:
        candidates.append(("xlsx", POR_XLSX_FALLBACK, "export.xlsx"))
    if POR_XML_FALLBACK not in seen:
        candidates.append(("xml", POR_XML_FALLBACK, "export.xml"))

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
    col_ref.document("_meta").set(payload["meta"])

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
    bee_warn = sum(1 for p in products if p.get("bees", {}).get("code") in ("ZNV", "NV", "SPe8"))

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
