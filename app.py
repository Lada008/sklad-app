import streamlit as st
import pandas as pd
import os
import re
from datetime import datetime
import csv
import time
import json

st.set_page_config(
    page_title="Skladový asistent", 
    page_icon="📦", 
    layout="centered",
    initial_sidebar_state="collapsed"
)

# --- SJEDNOCENÝ MODERNÍ SVĚTLÝ DESIGN (ODOLNÝ PROTI DARK MODU) ---
st.markdown("""
<style>
    /* Celkové pozadí a text */
    .stApp {
        background-color: #f1f5f9 !important;
        color: #0f172a !important;
    }
    p, span, label, h1, h2, h3, h4, div[data-testid="stMarkdownContainer"] p {
        color: #0f172a !important;
    }

    /* Oprava tmavých vstupních polí v Dark Modu */
    div[data-baseweb="select"] > div,
    div[data-baseweb="input"] > div,
    div[data-baseweb="base-input"],
    textarea {
        background-color: #ffffff !important;
        color: #0f172a !important;
        border: 1px solid #cbd5e1 !important;
        border-radius: 10px !important;
    }
    input, textarea, div[data-baseweb="select"] span {
        color: #0f172a !important;
        -webkit-text-fill-color: #0f172a !important;
    }
    input::placeholder, textarea::placeholder {
        color: #94a3b8 !important;
        -webkit-text-fill-color: #94a3b8 !important;
    }
    /* Rozbalovací menu (dropdown list) */
    ul[data-baseweb="menu"] {
        background-color: #ffffff !important;
        border: 1px solid #cbd5e1 !important;
    }
    li[data-baseweb="option"] {
        color: #0f172a !important;
        background-color: #ffffff !important;
    }
    li[data-baseweb="option"]:hover {
        background-color: #dcfce7 !important;
    }

    /* Expandery a formuláře */
    div[data-testid="stExpander"] {
        background-color: #ffffff !important;
        border: 1px solid #e2e8f0 !important;
        border-radius: 10px !important;
        margin-bottom: 8px !important;
        box-shadow: 0 1px 3px rgba(0,0,0,0.03);
    }
    div[data-testid="stForm"] {
        background-color: #ffffff !important;
        border: 1px solid #e2e8f0 !important;
        border-radius: 12px !important;
        padding: 14px !important;
    }

    /* Hlavička */
    .main-header {
        background: linear-gradient(135deg, #14532d 0%, #16a34a 100%);
        padding: 16px 20px;
        border-radius: 14px;
        margin-bottom: 16px;
        box-shadow: 0 6px 16px rgba(22, 101, 52, 0.18);
        display: flex;
        align-items: center;
        justify-content: space-between;
    }
    .main-header h1 {
        color: #ffffff !important;
        font-size: 1.35rem !important;
        margin: 0 !important;
        font-weight: 800 !important;
        letter-spacing: -0.3px;
    }
    .header-info {
        text-align: right;
    }
    .main-header .badge-terminal {
        background: rgba(255, 255, 255, 0.2);
        color: #ffffff !important;
        padding: 3px 9px;
        border-radius: 20px;
        font-size: 0.75rem;
        font-weight: 600;
        display: inline-block;
        margin-bottom: 3px;
    }
    .main-header .update-time {
        color: #e2e8f0 !important;
        font-size: 0.72rem;
        display: block;
        opacity: 0.95;
    }

    /* Záložky (Tabs) */
    .stTabs [data-baseweb="tab-list"] {
        gap: 6px;
        background-color: #e2e8f0;
        padding: 4px;
        border-radius: 12px;
        border-bottom: none;
    }
    .stTabs [data-baseweb="tab"] {
        background-color: transparent !important;
        border: none !important;
        padding: 8px 14px !important;
        border-radius: 8px !important;
        flex: 1;
        justify-content: center;
    }
    .stTabs [data-baseweb="tab"] p {
        color: #475569 !important;
        font-weight: 600 !important;
        font-size: 0.9rem !important;
    }
    .stTabs [aria-selected="true"] {
        background-color: #ffffff !important;
        box-shadow: 0 2px 6px rgba(0,0,0,0.08);
        border-bottom: none !important;
    }
    .stTabs [aria-selected="true"] p {
        color: #15803d !important;
        font-weight: 800 !important;
    }

    /* Karta produktu */
    .product-card {
        background: #ffffff !important;
        border-radius: 14px;
        padding: 18px;
        margin-bottom: 10px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.05);
        border: 1px solid #cbd5e1;
    }
    .product-title {
        font-size: 1.25rem;
        font-weight: 800;
        color: #0f172a !important;
        margin-bottom: 8px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 8px;
    }
    .product-code {
        font-size: 0.82rem;
        font-family: monospace;
        background: #f1f5f9;
        padding: 4px 10px;
        border-radius: 6px;
        color: #334155 !important;
        font-weight: 700;
        border: 1px solid #e2e8f0;
    }
    .category-badge {
        font-size: 0.78rem;
        padding: 4px 10px;
        border-radius: 20px;
        font-weight: 700;
        background: #dcfce7 !important;
        color: #166534 !important;
        border: 1px solid #bbf7d0;
    }

    /* Skladová mřížka */
    .stock-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
        margin: 14px 0 4px 0;
    }
    .stock-box {
        background: #f8fafc !important;
        border: 1px solid #e2e8f0 !important;
        border-radius: 10px;
        padding: 12px 10px;
        text-align: center;
    }
    .stock-box-label {
        font-size: 0.68rem !important;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: #64748b !important;
        font-weight: 700 !important;
        margin-bottom: 4px;
    }
    .stock-box-value {
        font-size: 1.15rem !important;
        font-weight: 800 !important;
        color: #0f172a !important;
    }

    /* FEFO a Palety */
    .fefo-banner {
        background: #fffbeb !important;
        border: 1px solid #f59e0b !important;
        border-left: 5px solid #f59e0b !important;
        border-radius: 10px;
        padding: 12px 14px;
        margin: 10px 0;
        display: flex;
        align-items: center;
        gap: 12px;
    }
    .fefo-icon {
        font-size: 1.3rem;
    }
    .fefo-text {
        font-size: 0.88rem !important;
        color: #78350f !important;
        line-height: 1.45;
    }
    .fefo-badge {
        background: #d97706 !important;
        color: #ffffff !important;
        padding: 2px 7px;
        border-radius: 5px;
        font-weight: 800;
        font-family: monospace;
    }

    .pallet-banner {
        background: #eff6ff !important;
        border: 1px solid #bfdbfe !important;
        border-left: 5px solid #3b82f6 !important;
        border-radius: 10px;
        padding: 10px 14px;
        margin: 8px 0;
        color: #1e3a8a !important;
        font-size: 0.88rem !important;
        font-weight: 700 !important;
    }

    /* Detail lokací */
    .mobile-detail-card {
        background: #ffffff;
        border-radius: 10px;
        padding: 12px 14px;
        margin-bottom: 8px;
        font-size: 0.88rem;
        border: 1px solid #e2e8f0;
        border-left: 4px solid #16a34a;
        box-shadow: 0 2px 5px rgba(0,0,0,0.03);
    }
    .mobile-detail-card strong {
        color: #0f172a;
        font-size: 0.95rem;
    }
</style>
""", unsafe_allow_html=True)

EXCEL_FILE = "sklad.xlsx"
NESROVNALOSTI_FILE = "nesrovnalosti.csv"
INV_FILE = "inventura_vysledky.csv"
CUSTOM_PACK_FILE = "vlastni_baleni.json"
TIME_FILE = "cas_aktualizace.txt"

LOC_MAP = {
    '151BO': '🏢 Boršice',
    '151VM': '🏭 Valmez',
    '151ST': '🏬 Staré Město',
    '151ZL': '🏬 Zlín',
    '151UB': '🏬 Uherský Brod',
    '151SL': '🏬 Slavičín',
    'NACESTE': '🚚 Na cestě'
}

def get_custom_packs():
    if "custom_packs" not in st.session_state:
        if os.path.exists(CUSTOM_PACK_FILE):
            try:
                with open(CUSTOM_PACK_FILE, 'r', encoding='utf-8') as f:
                    st.session_state.custom_packs = json.load(f)
            except Exception:
                st.session_state.custom_packs = {}
        else:
            st.session_state.custom_packs = {}
    return st.session_state.custom_packs

def save_custom_pack(kod, velikost, obal):
    data = get_custom_packs()
    data[str(kod)] = {"velikost": velikost, "obal": obal}
    st.session_state.custom_packs = data
    with open(CUSTOM_PACK_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def get_fyzicky_sklad(loc, prodejce):
    loc_str = str(loc)
    prod_str = str(prodejce).strip().upper()
    if loc_str == '151BO': return 'Boršice'
    if loc_str == '151VM': return 'Valmez'
    if loc_str.startswith('K.'):
        if prod_str in ['TRČÁLEK', 'TRCALEK']: return 'Valmez'
        return 'Boršice'
    return loc_str

def format_location_name(loc, prodejce):
    if not isinstance(loc, str): return '-'
    if loc in LOC_MAP: return LOC_MAP[loc]
    if loc.startswith('K.'):
        nazev_komise = loc[2:].upper()
        prodejce_str = str(prodejce).strip().upper()
        if prodejce_str in ['TRČÁLEK', 'TRCALEK']: return f"🤝 Komise {nazev_komise} (Valmez)"
        else: return f"🤝 Komise {nazev_komise} (Boršice)"
    return loc

def format_category_name(cat):
    if not isinstance(cat, str): return 'Ostatní'
    c = cat.upper()
    if 'HERBICID' in c or c.startswith('H '): return '🌿 Herbicid'
    if 'FUNGICID' in c or c.startswith('F '): return '🍄 Fungicid'
    if 'INSEKTICID' in c or c.startswith('I '): return '🐛 Insekticid'
    if 'HNOJIV' in c or 'SH' in c or 'PH' in c: return '🌾 Hnojivo'
    if 'GRAMIN' in c: return '🌱 Graminicid'
    if 'MOŘID' in c: return '🛡 Mořidlo'
    if 'REGULÁTOR' in c or 'RR' in c: return '⚡ Regulátor'
    if 'ADITIV' in c or c.startswith('A '): return '💧 Aditivum'
    if 'BIO' in c: return '🌱 Bio'
    if 'MALÉ BALENÍ' in c or 'MB' in c: return '📦 Malé balení'
    return cat

def sklonuj(pocet, jednotka):
    p = abs(pocet)
    j = jednotka.lower()
    if j == 'kanystr': return f"{pocet} kanystr" if p == 1 else (f"{pocet} kanystry" if 2 <= p <= 4 else f"{pocet} kanystrů")
    if j == 'krabice': return f"{pocet} krabice" if 1 <= p <= 4 else f"{pocet} krabic"
    if j in ['lahev', 'láhev']: return f"{pocet} láhev" if p == 1 else (f"{pocet} láhve" if 2 <= p <= 4 else f"{pocet} lahví")
    if j == 'pytel': return f"{pocet} pytel" if p == 1 else (f"{pocet} pytle" if 2 <= p <= 4 else f"{pocet} pytlů")
    if j == 'kus': return f"{pocet} kus" if p == 1 else (f"{pocet} kusy" if 2 <= p <= 4 else f"{pocet} kusů")
    if j == 'paleta': return f"{pocet} celá paleta" if p == 1 else (f"{pocet} celé palety" if 2 <= p <= 4 else f"{pocet} celých palet")
    if j in ['baleni', 'balení']: return f"{pocet} balení"
    return f"{pocet} {jednotka}"

def ziskej_krok_baleni(kod, popis):
    customs = get_custom_packs()
    kod_str = str(kod)
    if kod_str in customs and customs[kod_str].get('velikost', 0) > 0:
        return float(customs[kod_str]['velikost'])

    if not isinstance(popis, str): return 1.0
    m_mult = re.search(r'(\d+)\s*[xX*]\s*(\d+(?:[.,]\d+)?)\s*(l|litr|kg|g|ml)\b', popis, re.IGNORECASE)
    if m_mult:
        v = float(m_mult.group(2).replace(',', '.'))
        u = m_mult.group(3).lower()
        if u in ['g', 'ml']: v /= 1000.0
        return max(0.001, float(v))
        
    m = re.search(r'(\d+(?:[.,]\d+)?)\s*(l|litr|kg|g|ml)\b', popis, re.IGNORECASE)
    if m:
        v = float(m.group(1).replace(',', '.'))
        u = m.group(2).lower()
        if u in ['g', 'ml']: v /= 1000.0
        return max(0.001, float(v))
    return 1.0

def prepocet_na_baleni(kod, popis, qty):
    if not isinstance(popis, str) or qty is None or pd.isna(qty) or qty == 0: 
        return f"{qty:g} j."

    uom_base = 'l'
    if re.search(r'(?i)(kg|g)\b', popis): uom_base = 'kg'

    customs = get_custom_packs()
    kod_str = str(kod)
    typ_obalu = "automaticky"
    unit_size_base = 0.0

    if kod_str in customs and customs[kod_str].get('velikost', 0) > 0:
        unit_size_base = float(customs[kod_str]['velikost'])
        typ_obalu = customs[kod_str].get('obal', 'automaticky')

    if unit_size_base <= 0:
        m_mult = re.search(r'(\d+)\s*[xX*]\s*(\d+(?:[.,]\d+)?)\s*(l|litr|kg|g|ml)\b', popis, re.IGNORECASE)
        if m_mult:
            ks_v_baleni = float(m_mult.group(1))
            velikost_ks = float(m_mult.group(2).replace(',', '.'))
            u_raw = m_mult.group(3).lower()
            v_base = velikost_ks / 1000.0 if u_raw in ['g', 'ml'] else velikost_ks
            unit_size_base = ks_v_baleni * v_base
        else:
            m = re.search(r'(\d+(?:[.,]\d+)?)\s*(l|litr|kg|g|ml)\b', popis, re.IGNORECASE)
            if m:
                unit_size = float(m.group(1).replace(',', '.'))
                u_raw = m.group(2).lower()
                unit_size_base = unit_size / 1000.0 if u_raw in ['g', 'ml'] else unit_size
            elif re.search(r'\bL\b', popis):
                unit_size_base = 1.0

    if unit_size_base <= 0:
        return f"{qty:g} j."

    if typ_obalu == "automaticky":
        if uom_base == 'l': typ_obalu = 'kanystr' if unit_size_base >= 3 else 'láhev'
        elif uom_base == 'kg': typ_obalu = 'pytel' if unit_size_base >= 15 else 'balení'
        else: typ_obalu = 'balení'

    cele_baleni = int(qty // unit_size_base)
    zbytek = round(qty % unit_size_base, 3)

    if abs(unit_size_base - zbytek) < 0.02:
        cele_baleni += 1
        zbytek = 0.0

    krabice_info = ""
    is_custom_obal = kod_str in customs and customs[kod_str].get('obal') != 'automaticky'
    
    if not is_custom_obal:
        if uom_base == 'l' and unit_size_base == 5 and cele_baleni >= 4:
            k = cele_baleni // 4
            zb_k = cele_baleni % 4
            krabice_info = f" ({sklonuj(k, 'krabice')} + {sklonuj(zb_k, 'kanystr')})" if zb_k > 0 else f" ({sklonuj(k, 'krabice')})"
        elif uom_base == 'l' and (unit_size_base == 1 or unit_size_base == 1000) and cele_baleni >= 12:
            k = cele_baleni // 12
            zb_k = cele_baleni % 12
            krabice_info = f" ({sklonuj(k, 'krabice')} po 12 ks + {sklonuj(zb_k, 'láhev')})" if zb_k > 0 else f" ({sklonuj(k, 'krabice')} po 12 ks)"

    if cele_baleni > 0 and zbytek > 0:
        return f"{sklonuj(cele_baleni, typ_obalu)} + {zbytek:g} {uom_base} navíc"
    elif cele_baleni > 0 and zbytek == 0:
        return f"{sklonuj(cele_baleni, typ_obalu)} po {unit_size_base:g} {uom_base}{krabice_info}"
    else:
        return f"{zbytek:g} {uom_base}"

def paletova_kalkulacka(kod, popis, qty):
    if not isinstance(popis, str) or qty is None or qty <= 0: return None
    uom_base = 'l'
    if re.search(r'(?i)(kg|g)\b', popis): uom_base = 'kg'
        
    unit_size_base = ziskej_krok_baleni(kod, popis)

    if uom_base == 'kg' and unit_size_base == 25:
        pytle = qty / 25.0
        if pytle >= 30:
            palet = int(pytle // 40)
            zb_pytle = int(pytle % 40)
            if palet > 0:
                if zb_pytle == 0: return f"🚜 Palety: {sklonuj(palet, 'paleta')} (po 40 pytlích / 1 tuna)"
                return f"🚜 Palety: {sklonuj(palet, 'paleta')} + {sklonuj(zb_pytle, 'pytel')} navrch"
            else: return f"🚜 Skoro paleta: {sklonuj(zb_pytle, 'pytel')} (chybí {40 - zb_pytle} do palety)"
            
    if uom_base == 'l' and unit_size_base == 5:
        kanystru = qty / 5.0
        krabic = kanystru / 4.0
        if krabic >= 20:
            palet = int(krabic // 32)
            zb_krabic = int(krabic % 32)
            if palet > 0:
                if zb_krabic == 0: return f"🚜 Palety: {sklonuj(palet, 'paleta')} (po 32 krabicích / 640 l)"
                return f"🚜 Palety: {sklonuj(palet, 'paleta')} + {sklonuj(zb_krabic, 'krabice')} navrch"
            else: return f"🚜 Skoro paleta: {sklonuj(zb_krabic, 'krabice')} (chybí {32 - zb_krabic} do palety)"
    return None

def format_expirace_semafor(dt_obj):
    if pd.isna(dt_obj): return "⚪ Bez data"
    dnes = pd.Timestamp.now().normalize()
    dny = (dt_obj - dnes).days
    datum_str = dt_obj.strftime('%d.%m.%Y')
    if dny < 0: return f"🔴 EXPIROVÁNO ({datum_str})"
    elif dny <= 90: return f"🔴 Za {dny} dní ({datum_str})"
    elif dny <= 180: return f"🟠 Za {dny//30} měs. ({datum_str})"
    elif dny <= 365: return f"🟡 Do roka ({datum_str})"
    else: return f"🟢 {datum_str}"

@st.cache_data
def load_stock_data(filepath):
    cols = [
        'Číslo zboží', 'Popis', 'Kód kategorie zboží', 'Kód lokace', 'Kód Střediska', 
        'Číslo šarže', 'Datum expirace', 'Zůstatek (množství)',
        'Zúčtovací datum', 'Množství', 'Prodejce Kód'
    ]
    try:
        df = pd.read_excel(filepath, usecols=cols)
    except ValueError:
        st.error("❌ Nahraný Excel nemá správnou strukturu (chybí potřebné sloupce).")
        return pd.DataFrame()

    prijmy = df[df['Množství'] > 0].copy()
    prijmy['Číslo šarže'] = prijmy['Číslo šarže'].fillna('-')
    posledni_prijem = prijmy.groupby(['Číslo zboží', 'Kód lokace', 'Číslo šarže'])['Zúčtovací datum'].max().reset_index()
    posledni_prijem.rename(columns={'Zúčtovací datum': 'Datum posledního příjmu'}, inplace=True)

    df_active = df[df['Zůstatek (množství)'] > 0].copy()
    df_active['Číslo šarže'] = df_active['Číslo šarže'].fillna('-')

    df_active['Fyzicky_Sklad'] = df_active.apply(lambda row: get_fyzicky_sklad(row['Kód lokace'], row['Prodejce Kód']), axis=1)
    df_active['Lokace_Nazev'] = df_active.apply(lambda row: format_location_name(row['Kód lokace'], row['Prodejce Kód']), axis=1)

    grouped = df_active.groupby(
        ['Číslo zboží', 'Popis', 'Kód kategorie zboží', 'Kód lokace', 'Fyzicky_Sklad', 'Lokace_Nazev', 'Číslo šarže', 'Datum expirace'],
        dropna=False,
        as_index=False
    ).agg({'Zůstatek (množství)': 'sum'})

    grouped = pd.merge(grouped, posledni_prijem, on=['Číslo zboží', 'Kód lokace', 'Číslo šarže'], how='left')

    grouped['Datum_Exp_Obj'] = pd.to_datetime(grouped['Datum expirace'], errors='coerce')
    grouped['Datum_Prijmu_Obj'] = pd.to_datetime(grouped['Datum posledního příjmu'], errors='coerce')

    grouped['Expirace (stav)'] = grouped['Datum_Exp_Obj'].apply(format_expirace_semafor)
    grouped['Poslední příjem'] = grouped['Datum_Prijmu_Obj'].dt.strftime('%d.%m.%Y').fillna('-')
    grouped['Kategorie_Nazev'] = grouped['Kód kategorie zboží'].apply(format_category_name)
    
    return grouped

def uloz_nesrovnalost(kod_zbozi, popis, lokace, sarze, system_stav, real_stav, poznamka):
    zaznam = [
        datetime.now().strftime('%d.%m.%Y %H:%M'),
        kod_zbozi, popis, lokace, sarze,
        system_stav, real_stav, real_stav - system_stav, poznamka
