import streamlit as st
import pandas as pd
from google import genai
from PIL import Image
import json
import os
import re
from datetime import datetime
import csv
import time

st.set_page_config(
    page_title="Skladový asistent", 
    page_icon="📦", 
    layout="centered",
    initial_sidebar_state="collapsed"
)

# --- MODERNÍ SKLADOVÝ DESIGN S VYSOKÝM KONTRASTEM (CSS) ---
st.markdown("""
<style>
    /* Základní barvy - vynucení kontrastu pro Dark i Light mode */
    .stApp {
        background-color: #f4f6f8 !important;
        color: #1e293b !important;
    }
    
    /* Všechny běžné texty, popisky a odstavce */
    p, span, label, div[data-testid="stMarkdownContainer"] p {
        color: #1e293b !important;
    }

    /* Horní lišta / titulek */
    .main-header {
        background: linear-gradient(135deg, #1b4d3e 0%, #2e7d32 100%);
        padding: 16px 20px;
        border-radius: 14px;
        margin-bottom: 16px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.08);
        display: flex;
        align-items: center;
        justify-content: space-between;
    }
    .main-header h1 {
        color: #ffffff !important;
        font-size: 1.5rem !important;
        margin: 0 !important;
        font-weight: 700 !important;
    }
    .main-header span {
        color: #ffffff !important;
    }

    /* Přepínač skladů (Radio buttons) */
    div[data-testid="stRadio"] > label {
        color: #0f172a !important;
        font-weight: 700 !important;
        font-size: 0.95rem !important;
    }
    div[data-testid="stRadio"] > div {
        background: #ffffff !important;
        padding: 8px 12px !important;
        border-radius: 12px !important;
        border: 1px solid #cbd5e1 !important;
        gap: 16px !important;
    }
    div[data-testid="stRadio"] label p {
        color: #1e293b !important;
        font-weight: 600 !important;
    }

    /* Záložky (Tabs) */
    .stTabs [data-baseweb="tab-list"] {
        gap: 6px;
        background-color: transparent;
    }
    .stTabs [data-baseweb="tab"] {
        background-color: #ffffff !important;
        border-radius: 8px 8px 0 0 !important;
        padding: 8px 16px !important;
        border: 1px solid #cbd5e1 !important;
        border-bottom: none !important;
    }
    .stTabs [data-baseweb="tab"] p {
        color: #334155 !important;
        font-weight: 700 !important;
    }
    .stTabs [aria-selected="true"] {
        background-color: #2e7d32 !important;
    }
    .stTabs [aria-selected="true"] p {
        color: #ffffff !important;
    }

    /* Karta produktu */
    .product-card {
        background: #ffffff !important;
        border-radius: 14px;
        padding: 18px 20px;
        margin-bottom: 20px;
        box-shadow: 0 4px 14px rgba(0,0,0,0.06);
        border: 1px solid #cbd5e1;
    }
    .product-title {
        font-size: 1.35rem;
        font-weight: 800;
        color: #0f172a !important;
        margin-bottom: 6px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 8px;
    }
    .product-code {
        font-size: 0.85rem;
        font-family: monospace;
        background: #f1f5f9;
        padding: 3px 8px;
        border-radius: 6px;
        color: #334155 !important;
        font-weight: 600;
    }
    .category-badge {
        font-size: 0.85rem;
        padding: 4px 12px;
        border-radius: 20px;
        font-weight: 700;
        background: #dcfce7 !important;
        color: #166534 !important;
        border: 1px solid #bbf7d0;
    }

    /* Dlaždice s čísly */
    .stock-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
        gap: 12px;
        margin: 14px 0;
    }
    .stock-box {
        background: #f8fafc !important;
        border: 1px solid #cbd5e1 !important;
        border-radius: 10px;
        padding: 12px;
        text-align: center;
    }
    .stock-box-label {
        font-size: 0.75rem !important;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: #64748b !important;
        font-weight: 700 !important;
        margin-bottom: 4px;
    }
    .stock-box-value {
        font-size: 1.25rem !important;
        font-weight: 800 !important;
        color: #0f172a !important;
    }

    /* FEFO Rámeček */
    .fefo-banner {
        background: #fffbeb !important;
        border: 2px solid #f59e0b !important;
        border-radius: 12px;
        padding: 14px 16px;
        margin: 14px 0;
        display: flex;
        align-items: flex-start;
        gap: 12px;
    }
    .fefo-icon {
        font-size: 1.6rem;
        line-height: 1;
    }
    .fefo-text {
        font-size: 0.95rem !important;
        color: #78350f !important;
        line-height: 1.45;
    }
    .fefo-badge {
        background: #f59e0b !important;
        color: #ffffff !important;
        padding: 2px 8px;
        border-radius: 6px;
        font-weight: 800;
        font-family: monospace;
    }

    /* Paletový box */
    .pallet-banner {
        background: #eff6ff !important;
        border: 1.5px solid #93c5fd !important;
        border-radius: 10px;
        padding: 10px 14px;
        margin: 10px 0;
        color: #1e3a8a !important;
        font-size: 0.95rem !important;
        font-weight: 700 !important;
    }
</style>
""", unsafe_allow_html=True)

# Bezpečné načtení API klíče
API_KEY = st.secrets.get("GEMINI_API_KEY", "AQ.Ab8RN6JmbhByHR5ACrJp3NAIXu3mmONbyWT4hdMt_iVrqr8kmQ")

EXCEL_FILE = "sklad.xlsx"
NESROVNALOSTI_FILE = "nesrovnalosti.csv"

# --- DEFINICE PŘEVODŮ A MAPOVÁNÍ ---
LOC_MAP = {
    '151BO': '🏢 Boršice',
    '151VM': '🏭 Valmez',
    '151ST': '🏬 Staré Město',
    '151ZL': '🏬 Zlín',
    '151UB': '🏬 Uherský Brod',
    '151SL': '🏬 Slavičín',
    'NACESTE': '🚚 Na cestě'
}

def format_location_name(loc):
    if not isinstance(loc, str):
        return '-'
    if loc in LOC_MAP:
        return LOC_MAP[loc]
    if loc.startswith('K.'):
        return f"🤝 Komise {loc[2:].upper()}"
    return loc

def format_category_name(cat):
    if not isinstance(cat, str):
        return 'Ostatní'
    c = cat.upper()
    if 'HERBICID' in c or c.startswith('H '):
        return '🌿 Herbicid'
    if 'FUNGICID' in c or c.startswith('F '):
        return '🍄 Fungicid'
    if 'INSEKTICID' in c or c.startswith('I '):
        return '🐛 Insekticid'
    if 'HNOJIV' in c or 'SH' in c or 'PH' in c:
        return '🌾 Hnojivo'
    if 'GRAMIN' in c:
        return '🌱 Graminicid'
    if 'MOŘID' in c:
        return '🛡️ Mořidlo'
    if 'REGULÁTOR' in c or 'RR' in c:
        return '⚡ Regulátor'
    if 'ADITIV' in c or c.startswith('A '):
        return '💧 Aditivum'
    if 'BIO' in c:
        return '🌱 Bio'
    if 'MALÉ BALENÍ' in c or 'MB' in c:
        return '📦 Malé balení'
    return cat

def sklonuj(pocet, jednotka):
    p = abs(pocet)
    if jednotka == 'kanystr':
        return f"{pocet} kanystr" if p == 1 else (f"{pocet} kanystry" if 2 <= p <= 4 else f"{pocet} kanystrů")
    if jednotka == 'krabice':
        return f"{pocet} krabice" if 1 <= p <= 4 else f"{pocet} krabic"
    if jednotka == 'lahev':
        return f"{pocet} láhev" if p == 1 else (f"{pocet} láhve" if 2 <= p <= 4 else f"{pocet} lahví")
    if jednotka == 'pytel':
        return f"{pocet} pytel" if p == 1 else (f"{pocet} pytle" if 2 <= p <= 4 else f"{pocet} pytlů")
    if jednotka == 'kus':
        return f"{pocet} kus" if p == 1 else (f"{pocet} kusy" if 2 <= p <= 4 else f"{pocet} kusů")
    if jednotka == 'paleta':
        return f"{pocet} celá paleta" if p == 1 else (f"{pocet} celé palety" if 2 <= p <= 4 else f"{pocet} celých palet")
    if jednotka == 'baleni':
        return f"{pocet} balení"
    return f"{pocet} {jednotka}"

def prepocet_na_baleni(popis, qty):
    if not isinstance(popis, str) or qty is None:
        return f"{qty:g} ks"

    m_mult = re.search(r'(\d+)\s*[xX*]\s*(\d+(?:[.,]\d+)?)\s*(l|litr|kg|g|ml)\b', popis, re.IGNORECASE)
    if m_mult:
        return f"{qty:g} balení ({m_mult.group(0)})"

    m = re.search(r'(\d+(?:[.,]\d+)?)\s*(l|litr|kg|g|ml)\b', popis, re.IGNORECASE)
    if m:
        val_str = m.group(1).replace(',', '.')
        unit_size = float(val_str)
        uom_raw = m.group(2).lower()

        if uom_raw in ['ml', 'g'] and qty < 1000 and unit_size >= 10:
            return f"{sklonuj(int(qty), 'baleni')} ({m.group(0).strip()})"

        uom = 'l' if uom_raw in ['l', 'litr'] else ('kg' if uom_raw == 'kg' else uom_raw)

        if unit_size > 0:
            pocet = qty / unit_size
            if abs(pocet - round(pocet)) < 0.02:
                n = int(round(pocet))
                if uom == 'l':
                    typ_obal = 'kanystr' if unit_size >= 3 else 'lahev'
                elif uom == 'kg':
                    typ_obal = 'pytel' if unit_size >= 15 else
