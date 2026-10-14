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
    ]
    file_exists = os.path.exists(NESROVNALOSTI_FILE)
    with open(NESROVNALOSTI_FILE, mode='a', newline='', encoding='utf-8-sig') as f:
        writer = csv.writer(f)
        if not file_exists:
            writer.writerow(['Čas hlášení', 'Kód zboží', 'Popis', 'Lokace', 'Číslo šarže', 'Stav systém', 'Stav fyzicky', 'Rozdíl', 'Poznámka'])
        writer.writerow(zaznam)

def zobraz_vysledky(vysledky_df, dotaz_popis, vybrana_lokace):
    if vybrana_lokace == 'Boršice': 
        vysledky_df = vysledky_df[vysledky_df['Fyzicky_Sklad'] == 'Boršice']
    elif vybrana_lokace == 'Valmez': 
        vysledky_df = vysledky_df[vysledky_df['Fyzicky_Sklad'] == 'Valmez']
    elif vybrana_lokace == 'Jen Komise': 
        vysledky_df = vysledky_df[vysledky_df['Kód lokace'].astype(str).str.startswith('K.', na=False)]

    if vysledky_df.empty:
        st.warning(f"Pro výraz **'{dotaz_popis}'** nebyl na vybraném skladu ({vybrana_lokace}) nalezen žádný zůstatek.")
        return

    produkty = vysledky_df.groupby(['Číslo zboží', 'Popis', 'Kategorie_Nazev'], sort=False)
    customs = get_custom_packs()
    
    for (kod_zbozi, nazev_zbozi, kategorie), skupina in produkty:
        celkem_ks = skupina['Zůstatek (množství)'].sum()
        baleni_celkem = prepocet_na_baleni(kod_zbozi, nazev_zbozi, celkem_ks)
        palety_text = paletova_kalkulacka(kod_zbozi, nazev_zbozi, celkem_ks)

        st.markdown(f"""
        <div class="product-card">
            <div class="product-title">
                <span>{nazev_zbozi}</span>
                <span class="category-badge">{kategorie}</span>
            </div>
            <div style="margin-bottom: 10px;">
                <span class="product-code">KÓD: {kod_zbozi}</span>
            </div>
            <div class="stock-grid">
                <div class="stock-box">
                    <div class="stock-box-label">Skladem celkem</div>
                    <div class="stock-box-value">{celkem_ks:g} j.</div>
                </div>
                <div class="stock-box">
                    <div class="stock-box-label">V přepočtu</div>
                    <div class="stock-box-value" style="font-size: 0.98rem;">{baleni_celkem}</div>
                </div>
            </div>
        </div>
        """, unsafe_allow_html=True)

        default_vel = ziskej_krok_baleni(kod_zbozi, nazev_zbozi)
        default_obal = customs.get(str(kod_zbozi), {}).get("obal", "automaticky")

        with st.expander("⚙️ Úprava balení (uloží se natrvalo)"):
            with st.form(key=f"form_baleni_{kod_zbozi}"):
                nova_velikost = st.number_input("Velikost 1 balení (l/kg):", value=float(default_vel), min_value=0.001, step=1.0)
                seznam_obalu = ["automaticky", "krabice", "kanystr", "pytel", "balení", "láhev"]
                idx_obalu = seznam_obalu.index(default_obal) if default_obal in seznam_obalu else 0
                novy_obal = st.selectbox("Typ obalu:", seznam_obalu, index=idx_obalu)
                
                if st.form_submit_button("💾 Uložit jako výchozí pro tento produkt", use_container_width=True):
                    save_custom_pack(kod_zbozi, nova_velikost, novy_obal)
                    st.success("Nastavení uloženo!")
                    time.sleep(0.4)
                    st.rerun()

        if palety_text:
            st.markdown(f'<div class="pallet-banner">{palety_text}</div>', unsafe_allow_html=True)

        valid_exp = skupina[skupina['Datum_Exp_Obj'].notna()].sort_values('Datum_Exp_Obj')
        if not valid_exp.empty:
            fefo_top = valid_exp.iloc[0]
            loc_disp = fefo_top['Lokace_Nazev']
            st.markdown(f"""
            <div class="fefo-banner">
                <div class="fefo-icon">👉</div>
                <div class="fefo-text">
                    <strong>FEFO VÝDEJ (nejstarší expirace):</strong><br>
                    Šarže <span class="fefo-badge">{fefo_top['Číslo šarže']}</span> 
                    na lokaci <strong>{loc_disp}</strong> 
                    (Exp: <strong>{fefo_top['Datum_Exp_Obj'].strftime('%d.%m.%Y')}</strong>)
                </div>
            </div>
            """, unsafe_allow_html=True)

        st.markdown("📍 **Rozpis po lokacích a šaržích:**")
        prehled = skupina.sort_values(by='Zůstatek (množství)', ascending=False)
        
        for _, row in prehled.iterrows():
            bal_str = prepocet_na_baleni(kod_zbozi, row['Popis'], row['Zůstatek (množství)'])
            st.markdown(f"""
            <div class="mobile-detail-card">
                <strong>{row['Lokace_Nazev']}</strong> &nbsp;—&nbsp; <strong>{row['Zůstatek (množství)']:g} j.</strong> <i>({bal_str})</i><br>
                <span style="color:#64748b;">Šarže:</span> <b>{row['Číslo šarže']}</b> &nbsp;|&nbsp; 
                <span style="color:#64748b;">Exp:</span> {row['Expirace (stav)']} &nbsp;|&nbsp;
                <span style="color:#64748b;">Příjem:</span> {row['Poslední příjem']}
            </div>
            """, unsafe_allow_html=True)
            
        st.write("---")

# --- ZJIŠTĚNÍ ČASU POSLEDNÍ AKTUALIZACE EXCELU ---
posledni_aktualizace = "Neznámý čas"
if os.path.exists(EXCEL_FILE):
    mtime = os.path.getmtime(EXCEL_FILE)
    posledni_aktualizace = datetime.fromtimestamp(mtime).strftime('%d.%m.%Y %H:%M')

# --- HLAVNÍ APLIKACE ---
st.markdown(f"""
<div class="main-header">
    <h1>📦 Skladový asistent</h1>
    <div class="header-info">
        <span class="badge-terminal">Mobilní terminál</span>
        <span class="update-time">Aktualizováno: {posledni_aktualizace}</span>
    </div>
</div>
""", unsafe_allow_html=True)

if not os.path.exists(EXCEL_FILE):
    st.error(f"Soubor '{EXCEL_FILE}' nebyl nalezen. Nahraj ho prosím v záložce '🔄 Data'.")
    stock_df = pd.DataFrame()
else:
    stock_df = load_stock_data(EXCEL_FILE)

vybrana_lokace = st.selectbox(
    "📍 Vyber sklad pro hledání:",
    ["Všechny sklady", "Boršice", "Valmez", "Jen Komise"],
    index=0
)

tab_rucni, tab_inventura, tab_nesrovnalosti, tab_admin = st.tabs([
    "🔍 Hledat", "📋 Inventura", "⚠️ Hlášení", "🔄 Data"
])

# 1. HLEDÁNÍ
with tab_rucni:
    if not stock_df.empty:
        seznam_zbozi = sorted(stock_df['Popis'].dropna().unique().tolist())

        vybrany_produkt = st.selectbox(
            "⚡ Našeptávač zboží:",
            options=seznam_zbozi,
            index=None,
            placeholder="Napiš název (např. Folpan, Bizon)..."
        )

        volny_text = st.text_input("Nebo hledej podle šarže / kódu / části názvu:", placeholder="např. 7426507...")

        if vybrany_produkt:
            vysledky = stock_df[stock_df['Popis'] == vybrany_produkt]
            zobraz_vysledky(vysledky, vybrany_produkt, vybrana_lokace)
        elif volny_text.strip():
            text_clean = volny_text.strip()
            mask_text = (
                stock_df['Popis'].str.contains(text_clean, case=False, na=False, regex=False) |
                stock_df['Číslo zboží'].astype(str).str.contains(text_clean, case=False, na=False, regex=False) |
                stock_df['Číslo šarže'].astype(str).str.contains(text_clean, case=False, na=False, regex=False)
            )
            vysledky = stock_df[mask_text]
            zobraz_vysledky(vysledky, text_clean, vybrana_lokace)
        else:
            st.info("👆 Vyber přípravek z našeptávače nebo napiš šarži / kód.")

# 2. MOBILNÍ INVENTURA
with tab_inventura:
    st.subheader("📋 Mobilní inventura")

    inv_moznosti = [
        "Boršice (Sklad + Komise Boršice)", 
        "Valmez (Sklad + Komise Valmez)", 
        "Jen všechny komise"
    ]
    
    if "inv_lokace" not in st.session_state or st.session_state.inv_lokace not in inv_moznosti:
        st.session_state.inv_lokace = inv_moznosti[0]

    st.session_state.inv_lokace = st.selectbox(
        "Který úsek počítáš?", 
        inv_moznosti,
        index=inv_moznosti.index(st.session_state.inv_lokace)
    )

    if not stock_df.empty:
        inv_df = stock_df.copy()
        if st.session_state.inv_lokace == "Boršice (Sklad + Komise Boršice)":
            inv_df = inv_df[inv_df['Fyzicky_Sklad'] == 'Boršice']
            lokace_zaznamu = "Boršice (Vč. komisí)"
        elif st.session_state.inv_lokace == "Valmez (Sklad + Komise Valmez)":
            inv_df = inv_df[inv_df['Fyzicky_Sklad'] == 'Valmez']
            lokace_zaznamu = "Valmez (Vč. komisí)"
        else:
            inv_df = inv_df[inv_df['Kód lokace'].astype(str).str.startswith('K.', na=False)]
            lokace_zaznamu = "Všechny komise"

        inv_items = inv_df.groupby(['Číslo zboží', 'Popis', 'Číslo šarže'], dropna=False)['Zůstatek (množství)'].sum().reset_index()
        inv_items = inv_items[inv_items['Zůstatek (množství)'] > 0].sort_values('Popis')

        hotove_zaznamy = {}
        log_df = pd.DataFrame()
        if os.path.exists(INV_FILE):
            try:
                log_df = pd.read_csv(INV_FILE, encoding='utf-8-sig')
                log_df = log_df.drop_duplicates(subset=['Kód zboží', 'Šarže', 'Úsek'], keep='last')
                for _, r in log_df.iterrows():
                    klic = f"{r['Kód zboží']}|{r['Šarže']}|{r['Úsek']}"
                    hotove_zaznamy[klic] = r['Rozdíl']
            except Exception:
                pass

        celkem_polozek = len(inv_items)
        spocitano = len([x for _, x in inv_items.iterrows() if f"{x['Číslo zboží']}|{x['Číslo šarže']}|{lokace_zaznamu}" in hotove_zaznamy])
        
        if celkem_polozek > 0:
            st.progress(spocitano / celkem_polozek)
            st.markdown(f"**Průběh:** Spočítáno **{spocitano}** z **{celkem_polozek}** položek ({int(spocitano/celkem_polozek*100)} %).")
            
            dostupne_nazvy = sorted(inv_items['Popis'].unique().tolist())
            hledany_nazev = st.selectbox(
                "🔍 Rychlé vyhledání v inventuře:",
                options=dostupne_nazvy,
                index=None,
                placeholder="Vyber produkt pro okamžité zadání..."
            )
            
            st.write("---")
            
            skupina_vyhledano = []
            skupina_zbyva = []
            skupina_hotovo = []
            
            for idx, row in inv_items.iterrows():
                klic_zaznamu = f"{row['Číslo zboží']}|{row['Číslo šarže']}|{lokace_zaznamu}"
                je_hotovo = klic_zaznamu in hotove_zaznamy
                rozdil = hotove_zaznamy.get(klic_zaznamu, 0.0)
                data_karty = (idx, row, je_hotovo, rozdil, klic_zaznamu, lokace_zaznamu)
                
                if hledany_nazev and row['Popis'] == hledany_nazev:
                    skupina_vyhledano.append(data_karty)
                elif je_hotovo:
                    skupina_hotovo.append(data_karty)
                else:
                    skupina_zbyva.append(data_karty)

            def vykresli_kartu(idx, row, je_hotovo, rozdil, klic_zaznamu, lokace_nazev, rozbaleno=False):
                kod = row['Číslo zboží']
                nazev = row['Popis']
                sarze = row['Číslo šarže']
                system_stav = row['Zůstatek (množství)']
                
                ikona = "🟢" if (je_hotovo and rozdil == 0) else ("🔴" if je_hotovo else "🟠")
                
                with st.expander(f"{ikona} {nazev} (Šarže: {sarze})", expanded=rozbaleno):
                    if je_hotovo:
                        st.markdown(f"**Kód:** `{kod}` | **V systému:** {system_stav:g} j. *({prepocet_na_baleni(kod, nazev, system_stav)})*")
                        barva_textu = "#16a34a" if rozdil == 0 else "#dc2626"
                        st.markdown(f"Zadáno: **{system_stav + rozdil:g} j.** (<span style='color:{barva_textu}; font-weight:bold'>Rozdíl: {rozdil:g} j.</span>)", unsafe_allow_html=True)
                    else:
                        st.markdown(f"**Kód:** `{kod}` | **Očekáváno:** ❓ *(slepá inventura)*")
                    
                    krok = ziskej_krok_baleni(kod, nazev)
                    
                    with st.form(key=f"inv_form_{idx}"):
                        fyzicky_stav = st.number_input(
                            f"Fyzicky napočítáno (krok po {krok:g}):", 
                            min_value=0.0, 
                            value=float(system_stav + rozdil) if je_hotovo else None,
                            step=float(krok),
                            placeholder="Zadej počet v l/kg/ks...",
                            key=f"inv_num_{idx}"
                        )
                        
                        if st.form_submit_button("💾 Uložit stav", use_container_width=True, type="primary"):
                            if fyzicky_stav is None:
                                st.error("Zadej prosím počet (i kdyby to byla 0)!")
                            else:
                                akt_rozdil = round(fyzicky_stav - system_stav, 3)
                                zaznam = [
                                    datetime.now().strftime('%d.%m.%Y %H:%M'),
                                    lokace_nazev, kod, nazev, sarze,
                                    system_stav, fyzicky_stav, akt_rozdil
                                ]
                                
                                file_exists = os.path.exists(INV_FILE)
                                with open(INV_FILE, mode='a', newline='', encoding='utf-8-sig') as f:
                                    writer = csv.writer(f)
                                    if not file_exists:
                                        writer.writerow(['Čas', 'Úsek', 'Kód zboží', 'Popis', 'Šarže', 'Systém', 'Fyzicky', 'Rozdíl'])
                                    writer.writerow(zaznam)
                                
                                if akt_rozdil == 0:
                                    st.success(f"Všechno sedí! 👍 (Systém: {system_stav:g} j.)")
                                else:
                                    st.error(f"⚠ Uloženo s rozdílem {akt_rozdil:g} j. (Systém: {system_stav:g} j.)")
                                    
                                time.sleep(0.8)
                                st.rerun()

            if skupina_vyhledano:
                st.markdown("#### 🔍 Právě vyhledáno")
                for karta in skupina_vyhledano:
                    vykresli_kartu(*karta, rozbaleno=True)
                st.write("---")

            if skupina_zbyva:
                st.markdown(f"#### 🟠 Zbývá spočítat ({len(skupina_zbyva)})")
                for karta in skupina_zbyva:
                    vykresli_kartu(*karta, rozbaleno=False)

            if skupina_hotovo:
                st.markdown(f"#### 🟢 Již spočítáno ({len(skupina_hotovo)})")
                for karta in skupina_hotovo:
                    vykresli_kartu(*karta, rozbaleno=False)
                    
        else:
            st.info("Na této lokaci není podle systému žádné zboží.")

        if not log_df.empty:
            chyby_df = log_df[log_df['Rozdíl'] != 0].copy()
            if not chyby_df.empty:
                st.write("---")
                st.subheader("⚠️ Souhrn zjištěných rozdílů")
                for _, r in chyby_df.iterrows():
                    st.error(f"📦 **{r['Popis']}** (Šarže: {r['Šarže']} | {r['Úsek']})\n\n"
                             f"Systém: {r['Systém']:g} ➔ Fyzicky: {r['Fyzicky']:g} **(Rozdíl: {r['Rozdíl']:g} j.)**")

        if os.path.exists(INV_FILE):
            st.write("---")
            with open(INV_FILE, "r", encoding="utf-8-sig") as f_down:
                st.download_button(
                    label="📥 Stáhnout výsledky inventury (CSV)",
                    data=f_down.read(),
                    file_name=f"inventura_{datetime.now().strftime('%Y%m%d_%H%M')}.csv",
                    mime="text/csv",
                    use_container_width=True
                )

# 3. ZÁLOŽKA: HLÁŠENÍ NESROVNALOSTÍ
with tab_nesrovnalosti:
    st.subheader("⚠️ Hlášení nesrovnalosti")
    st.caption("Narazil jsi na rozdíl mimo inventuru? Zapiš ho sem.")

    with st.form("form_nesrovnalost", clear_on_submit=True):
        if not stock_df.empty:
            moznosti_zbozi = ["--- Vyber ze seznamu nebo napiš níže ---"] + sorted(stock_df['Popis'].dropna().unique().tolist())
            vyber_zbozi = st.selectbox("Vyber zboží:", moznosti_zbozi)
        else:
            vyber_zbozi = "---"
            
        polozka_rucne = st.text_input("Nebo napiš název / kód ručně:")
        lokace_zadat = st.selectbox("Kde zboží leží:", list(LOC_MAP.values()) + ["🤝 Komise Boršice", "🤝 Komise Valmez"])
        sarze_zadat = st.text_input("Číslo šarže:")
        
        col1, col2 = st.columns(2)
        with col1:
            stav_system = st.number_input("Stav v systému (l/kg):", min_value=0.0, step=1.0)
        with col2:
            stav_realita = st.number_input("Fyzicky napočítáno:", min_value=0.0, step=1.0)
            
        poznamka = st.text_area("Poznámka (např. rozbitý kanystr, záměna šarže):")

        if st.form_submit_button("💾 Uložit hlášení", use_container_width=True, type="primary"):
            final_polozka = polozka_rucne.strip() if polozka_rucne.strip() else (vyber_zbozi if not vyber_zbozi.startswith("---") else "")
            if final_polozka:
                uloz_nesrovnalost(
                    "", final_polozka, lokace_zadat, sarze_zadat,
                    stav_system, stav_realita, poznamka
                )
                st.success("✅ Nesrovnalost byla uložena.")
            else:
                st.error("Vyber nebo vyplň název zboží.")

    if os.path.exists(NESROVNALOSTI_FILE):
        st.write("---")
        try:
            nesr_df = pd.read_csv(NESROVNALOSTI_FILE, encoding="utf-8-sig")
            st.markdown(f"**Uložená hlášení ({len(nesr_df)}):**")
            st.dataframe(nesr_df, use_container_width=True, hide_index=True)
        except Exception:
            pass
            
        with open(NESROVNALOSTI_FILE, "r", encoding="utf-8-sig") as f_down:
            st.download_button(
                label="📥 Stáhnout hlášení (CSV)",
                data=f_down.read(),
                file_name="nesrovnalosti_sklad.csv",
                mime="text/csv",
                use_container_width=True
            )

# 4. ZÁLOŽKA: NAHRÁNÍ NOVÉHO EXCELU A SPRÁVA
with tab_admin:
    st.subheader("🔄 Aktualizace skladových dat")
    st.caption("Nahraj čerstvý export z Business Central (.xlsx).")
    
    novy_soubor = st.file_uploader("Vyber soubor (.xlsx)", type=["xlsx"])
    if novy_soubor is not None:
        if st.button("🚀 Přepsat data skladu", type="primary", use_container_width=True):
            with open(EXCEL_FILE, "wb") as f:
                f.write(novy_soubor.getbuffer())
            st.cache_data.clear()
            st.success("✅ Data skladu byla úspěšně aktualizována!")
            time.sleep(0.8)
            st.rerun()

    st.write("---")
    st.subheader("📦 Záloha vlastních balení")
    if os.path.exists(CUSTOM_PACK_FILE):
        with open(CUSTOM_PACK_FILE, "r", encoding="utf-8") as f_json:
            st.download_button(
                label="📥 Stáhnout nastavení balení (vlastni_baleni.json)",
                data=f_json.read(),
                file_name="vlastni_baleni.json",
                mime="application/json",
                use_container_width=True
            )

    st.write("---")
    st.subheader("🗑️ Reset inventury a hlášení")
    potvrzeni_smazani = st.checkbox("Potvrzuji, že chci smazat napočítaná data (před smazáním si stáhni CSV!)")
    
    col_del1, col_del2 = st.columns(2)
    with col_del1:
        if st.button("🗑️ Vynulovat inventuru", disabled=not potvrzeni_smazani, use_container_width=True):
            if os.path.exists(INV_FILE):
                os.remove(INV_FILE)
            st.success("Inventura byla vynulována.")
            time.sleep(0.8)
            st.rerun()
    with col_del2:
        if st.button("🗑️ Smazat hlášení", disabled=not potvrzeni_smazani, use_container_width=True):
            if os.path.exists(NESROVNALOSTI_FILE):
                os.remove(NESROVNALOSTI_FILE)
            st.success("Hlášení byla smazána.")
            time.sleep(0.8)
            st.rerun()
