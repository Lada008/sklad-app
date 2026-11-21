#!/usr/bin/env python3
"""
Převádí export z Microsoft Dynamics 365 Business Central (sklad.xlsx)
do kompaktního souboru data/stock.json pro okamžité načtení v prohlížeči.
Používá pouze standardní knihovnu Pythonu 3 (žádné externí závislosti).
"""

from __future__ import annotations

import json
import os
import sys
import zipfile
import xml.etree.ElementTree as ET
from collections import defaultdict
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
PKG_REL_NS = "{http://schemas.openxmlformats.org/package/2006/relationships}"

LOC_MAP = {
    "151BO": "Boršice",
    "151VM": "Valmez",
    "151ST": "Staré Město",
    "151ZL": "Zlín",
    "151UB": "Uherský Brod",
    "151SL": "Slavičín",
    "NACESTE": "Na cestě",
}

REQUIRED_COLUMNS = [
    "Číslo zboží",
    "Popis",
    "Kód kategorie zboží",
    "Kód lokace",
    "Číslo šarže",
    "Datum expirace",
    "Zůstatek (množství)",
    "Zúčtovací datum",
    "Množství",
    "Prodejce Kód",
]


def excel_serial_to_iso(raw_val: str | None) -> str | None:
    if raw_val is None:
        return None
    s = str(raw_val).strip()
    if not s:
        return None
    try:
        num = float(s)
        if num <= 0:
            return None
        dt = datetime(1899, 12, 30) + timedelta(days=num)
        return dt.strftime("%Y-%m-%d")
    except ValueError:
        pass
    for fmt in ("%Y-%m-%d", "%d.%m.%Y", "%Y-%m-%dT%H:%M:%S", "%d.%m.%Y %H:%M:%S"):
        try:
            return datetime.strptime(s[:19], fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


def parse_number(raw_val: str | None) -> float:
    if raw_val is None:
        return 0.0
    s = str(raw_val).strip().replace(",", ".")
    if not s:
        return 0.0
    try:
        return float(s)
    except ValueError:
        return 0.0


def get_fyzicky_sklad(loc: str, prodejce: str) -> str:
    loc_str = str(loc or "").strip()
    prod_str = str(prodejce or "").strip().upper()
    if loc_str == "151BO":
        return "Boršice"
    if loc_str == "151VM":
        return "Valmez"
    if loc_str.startswith("K."):
        if prod_str in ("TRČÁLEK", "TRCALEK"):
            return "Valmez"
        return "Boršice"
    return loc_str


def format_location_name(loc: str, prodejce: str) -> str:
    loc_str = str(loc or "").strip()
    if not loc_str:
        return "-"
    if loc_str in LOC_MAP:
        return LOC_MAP[loc_str]
    if loc_str.startswith("K."):
        nazev_komise = loc_str[2:].upper()
        prod_str = str(prodejce or "").strip().upper()
        if prod_str in ("TRČÁLEK", "TRCALEK"):
            return f"Komise {nazev_komise} (Valmez)"
        return f"Komise {nazev_komise} (Boršice)"
    return loc_str


def resolve_first_sheet_path(zf: zipfile.ZipFile) -> str:
    names = set(zf.namelist())
    if "xl/workbook.xml" in names and "xl/_rels/workbook.xml.rels" in names:
        wb_root = ET.fromstring(zf.read("xl/workbook.xml"))
        sheet_el = wb_root.find(f".//{NS}sheets/{NS}sheet")
        if sheet_el is not None:
            rid = sheet_el.attrib.get(f"{REL_NS}id")
            if rid:
                rels_root = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
                for rel in rels_root.findall(f"{PKG_REL_NS}Relationship"):
                    if rel.attrib.get("Id") == rid:
                        target = rel.attrib.get("Target", "").lstrip("/")
                        if not target.startswith("xl/"):
                            target = "xl/" + target
                        if target in names:
                            return target
    for candidate in sorted(names):
        if candidate.startswith("xl/worksheets/sheet") and candidate.endswith(".xml"):
            return candidate
    raise FileNotFoundError("V souboru .xlsx nebyl nalezen žádný list (worksheet).")


def load_shared_strings(zf: zipfile.ZipFile) -> list[str]:
    if "xl/sharedStrings.xml" not in zf.namelist():
        return []
    strings: list[str] = []
    for _, elem in ET.iterparse(zf.open("xl/sharedStrings.xml")):
        if elem.tag == f"{NS}si":
            parts = [t.text or "" for t in elem.iter(f"{NS}t")]
            strings.append("".join(parts))
            elem.clear()
    return strings


def col_letters(cell_ref: str) -> str:
    out = []
    for ch in cell_ref:
        if ch.isalpha():
            out.append(ch)
        else:
            break
    return "".join(out)


def extract_cell_value(cell: ET.Element, shared_strings: list[str]) -> str | None:
    t = cell.attrib.get("t")
    if t == "inlineStr":
        is_el = cell.find(f"{NS}is")
        if is_el is None:
            return ""
        return "".join(x.text or "" for x in is_el.iter(f"{NS}t"))
    v_el = cell.find(f"{NS}v")
    if v_el is None or v_el.text is None:
        return None
    if t == "s":
        idx = int(v_el.text)
        return shared_strings[idx] if 0 <= idx < len(shared_strings) else ""
    return v_el.text


def build_stock_data(excel_path: str) -> dict:
    file_size = os.path.getsize(excel_path)
    total_rows = 0

    # Poslední příjem podle (kod, lokace, sarze) -> ISO datum
    last_receipt: dict[tuple[str, str, str], str] = {}
    # Aktivní zůstatky podle (kod, popis, kat, lokace, fyzicky_sklad, lokace_nazev, sarze, exp_iso)
    grouped: dict[tuple[str, str, str, str, str, str, str, str | None], float] = defaultdict(float)

    with zipfile.ZipFile(excel_path, "r") as zf:
        sheet_path = resolve_first_sheet_path(zf)
        shared_strings = load_shared_strings(zf)

        col_map: dict[str, str] = {}
        wanted_letters: set[str] = set()

        for _, elem in ET.iterparse(zf.open(sheet_path)):
            if elem.tag != f"{NS}row":
                continue

            row_idx = int(elem.attrib.get("r", "0") or 0)
            if row_idx == 1:
                header_by_name: dict[str, str] = {}
                for cell in elem:
                    ref = cell.attrib.get("r", "")
                    col = col_letters(ref)
                    val = (extract_cell_value(cell, shared_strings) or "").strip()
                    if val:
                        header_by_name[val] = col
                missing = [c for c in REQUIRED_COLUMNS if c not in header_by_name]
                if missing:
                    raise ValueError(f"V Excelu chybí povinné sloupce: {', '.join(missing)}")
                col_map = {name: header_by_name[name] for name in REQUIRED_COLUMNS}
                wanted_letters = set(col_map.values())
                elem.clear()
                continue

            total_rows += 1
            row_vals: dict[str, str | None] = {}
            for cell in elem:
                ref = cell.attrib.get("r", "")
                col = col_letters(ref)
                if col in wanted_letters:
                    row_vals[col] = extract_cell_value(cell, shared_strings)
            elem.clear()

            mnozstvi = parse_number(row_vals.get(col_map["Množství"]))
            zustatek = parse_number(row_vals.get(col_map["Zůstatek (množství)"]))

            if mnozstvi <= 0 and zustatek <= 0:
                continue

            kod = str(row_vals.get(col_map["Číslo zboží"]) or "").strip()
            lokace = str(row_vals.get(col_map["Kód lokace"]) or "").strip()
            sarze = str(row_vals.get(col_map["Číslo šarže"]) or "").strip() or "-"

            if mnozstvi > 0:
                zuct_iso = excel_serial_to_iso(row_vals.get(col_map["Zúčtovací datum"]))
                if zuct_iso:
                    rkey = (kod, lokace, sarze)
                    prev = last_receipt.get(rkey)
                    if prev is None or zuct_iso > prev:
                        last_receipt[rkey] = zuct_iso

            if zustatek > 0:
                popis = str(row_vals.get(col_map["Popis"]) or "").strip()
                kat = str(row_vals.get(col_map["Kód kategorie zboží"]) or "").strip()
                prodejce = str(row_vals.get(col_map["Prodejce Kód"]) or "").strip()
                exp_iso = excel_serial_to_iso(row_vals.get(col_map["Datum expirace"]))

                fyz_sklad = get_fyzicky_sklad(lokace, prodejce)
                lok_nazev = format_location_name(lokace, prodejce)

                gkey = (kod, popis, kat, lokace, fyz_sklad, lok_nazev, sarze, exp_iso)
                grouped[gkey] += zustatek

    items = []
    product_codes = set()
    for (kod, popis, kat, lokace, fyz_sklad, lok_nazev, sarze, exp_iso), qty in grouped.items():
        qty_rounded = round(qty, 4)
        if qty_rounded <= 0:
            continue
        product_codes.add(kod)
        items.append({
            "c": kod,
            "n": popis,
            "cat": kat,
            "loc": lokace,
            "wh": fyz_sklad,
            "ln": lok_nazev,
            "lot": sarze,
            "exp": exp_iso,
            "q": qty_rounded,
            "rec": last_receipt.get((kod, lokace, sarze)),
        })

    items.sort(key=lambda x: (x["n"].lower(), x["c"], x["exp"] or "9999-99-99", -x["q"]))

    now_cz = datetime.now(ZoneInfo("Europe/Prague")).strftime("%d.%m.%Y %H:%M")

    return {
        "meta": {
            "updatedAt": now_cz,
            "sourceFile": os.path.basename(excel_path),
            "sourceSizeBytes": file_size,
            "ledgerRows": total_rows,
            "batchCount": len(items),
            "productCount": len(product_codes),
        },
        "items": items,
    }


def main() -> int:
    excel_path = sys.argv[1] if len(sys.argv) > 1 else "sklad.xlsx"
    out_path = sys.argv[2] if len(sys.argv) > 2 else os.path.join("data", "stock.json")

    if not os.path.exists(excel_path):
        print(f"Chyba: soubor '{excel_path}' neexistuje.", file=sys.stderr)
        return 1

    data = build_stock_data(excel_path)
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))

    out_kb = os.path.getsize(out_path) / 1024
    meta = data["meta"]
    print(
        f"Vygenerováno {out_path} ({out_kb:.1f} KB): "
        f"{meta['batchCount']} aktivních šarží, {meta['productCount']} produktů "
        f"(z {meta['ledgerRows']} řádků)."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
