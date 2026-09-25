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
    .stApp {
        background-color: #f4f6f8 !important;
        color: #1e293b !important;
    }
    
    p, span, label, div[data-testid="stMarkdownContainer"] p {
        color: #1e293b !important;
    }

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

API_KEY = st.secrets.get("GEMINI_API_KEY", "AQ.Ab8RN6JmbhByHR5ACrJp3NAIXu3mmONbyWT4hdMt_iVrqr8kmQ")
EXCEL_FILE = "sklad.xlsx"
NESROVNALOSTI_FILE = "nesrovnalosti.csv"

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
                    typ_obal = 'pytel' if unit_size >= 15 else 'baleni'
                else:
                    typ_obal = 'baleni'

                text_obalu = sklonuj(n, typ_obal)

                krabice_info = ""
                if uom == 'l' and unit_size == 5 and n >= 4:
                    k = n // 4
                    zb = n % 4
                    k_text = sklonuj(k, 'krabice')
                    if zb > 0:
                        krabice_info = f" ({k_text} + {sklonuj(zb, 'kanystr')})"
                    else:
                        krabice_info = f" ({k_text})"
                elif uom == 'l' and unit_size == 1 and n >= 12:
                    k = n // 12
                    zb = n % 12
                    k_text = sklonuj(k, 'krabice')
                    if zb > 0:
                        krabice_info = f" ({k_text} po 12 ks + {sklonuj(zb, 'lahev')})"
                    else:
                        krabice_info = f" ({k_text} po 12 ks)"

                return f"{text_obalu} po {unit_size:g} {uom}{krabice_info}"
            else:
                return f"{qty:g} {uom} (~{pocet:.1f} balení po {unit_size:g} {uom})"

    if re.search(r'\bL\b', popis, re.IGNORECASE):
        return f"{sklonuj(int(qty), 'lahev')} (1 l)"

    return f"{qty:g} ks"

def paletova_kalkulacka(popis, qty):
    if not isinstance(popis, str) or qty is None:
        return None
    if '25' in popis and 'kg' in popis.lower():
        pytle = qty / 25.0
        if pytle >= 30:
            palet = int(pytle // 40)
            zb_pytle = int(pytle % 40)
            pal_text = sklonuj(palet, 'paleta')
            if zb_pytle == 0:
                return f"🚜 Palety: {pal_text} (po 40 pytlích / 1 tuna)"
            return f"🚜 Palety: {pal_text} + {sklonuj(zb_pytle, 'pytel')} navrch"
    if re.search(r'\b5\s*l\b', popis, re.IGNORECASE):
        kanystru = qty / 5.0
        krabic = kanystru / 4.0
        if krabic >= 20:
            palet = int(krabic // 32)
            zb_krabic = int(krabic % 32)
            pal_text = sklonuj(palet, 'paleta')
            if zb_krabic == 0:
                return f"🚜 Palety: {pal_text} (po 32 krabicích / 640 l)"
            return f"🚜 Palety: {pal_text} + {sklonuj(zb_krabic, 'krabice')} navrch"
    return None

def format_expirace_semafor(dt_obj):
    if pd.isna(dt_obj):
        return "⚪ Bez data"
    dnes = pd.Timestamp.now().normalize()
    dny = (dt_obj - dnes).days
    datum_str = dt_obj.strftime('%d.%m.%Y')
    if dny < 0:
        return f"🔴 EXPIROVÁNO ({datum_str})"
    elif dny <= 90:
        return f"🔴 Za {dny} dní ({datum_str})"
    elif dny <= 180:
        return f"🟠 Za {dny//30} měs. ({datum_str})"
    elif dny <= 365:
        return f"🟡 Do roka ({datum_str})"
    else:
        return f"🟢 {datum_str}"

@st.cache_data
def load_stock_data(filepath):
    cols = [
        'Číslo zboží', 'Popis', 'Kód kategorie zboží', 'Kód lokace', 'Kód Střediska', 
        'Číslo šarže', 'Datum expirace', 'Zůstatek (množství)',
        'Zúčtovací datum', 'Množství'
    ]
    df = pd.read_excel(filepath, usecols=cols)

    prijmy = df[df['Množství'] > 0].copy()
    prijmy['Číslo šarže'] = prijmy['Číslo šarže'].fillna('-')
    posledni_prijem = prijmy.groupby(['Číslo zboží', 'Kód lokace', 'Číslo šarže'])['Zúčtovací datum'].max().reset_index()
    posledni_prijem.rename(columns={'Zúčtovací datum': 'Datum posledního příjmu'}, inplace=True)

    df_active = df[df['Zůstatek (množství)'] > 0].copy()
    df_active['Číslo šarže'] = df_active['Číslo šarže'].fillna('-')

    grouped = df_active.groupby(
        ['Číslo zboží', 'Popis', 'Kód kategorie zboží', 'Kód lokace', 'Číslo šarže', 'Datum expirace'],
        dropna=False,
        as_index=False
    ).agg({'Zůstatek (množství)': 'sum'})

    grouped = pd.merge(grouped, posledni_prijem, on=['Číslo zboží', 'Kód lokace', 'Číslo šarže'], how='left')

    grouped['Datum_Exp_Obj'] = pd.to_datetime(grouped['Datum expirace'], errors='coerce')
    grouped['Datum_Prijmu_Obj'] = pd.to_datetime(grouped['Datum posledního příjmu'], errors='coerce')

    grouped['Expirace (stav)'] = grouped['Datum_Exp_Obj'].apply(format_expirace_semafor)
    grouped['Poslední příjem'] = grouped['Datum_Prijmu_Obj'].dt.strftime('%d.%m.%Y').fillna('-')
    grouped['Lokace_Nazev'] = grouped['Kód lokace'].apply(format_location_name)
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
        vysledky_df = vysledky_df[vysledky_df['Kód lokace'] == '151BO']
    elif vybrana_lokace == 'Valmez':
        vysledky_df = vysledky_df[vysledky_df['Kód lokace'] == '151VM']
    elif vybrana_lokace == 'Jen Komise':
        vysledky_df = vysledky_df[vysledky_df['Kód lokace'].str.startswith('K.', na=False)]

    if vysledky_df.empty:
        st.warning(f"Pro výraz **'{dotaz_popis}'** nebyl na vybraném skladu **'{vybrana_lokace}'** nalezen žádný zůstatek.")
        return

    produkty = vysledky_df.groupby(['Číslo zboží', 'Popis', 'Kategorie_Nazev'], sort=False)
    
    for (kod_zbozi, nazev_zbozi, kategorie), skupina in produkty:
        celkem_ks = skupina['Zůstatek (množství)'].sum()
        baleni_celkem = prepocet_na_baleni(nazev_zbozi, celkem_ks)
        palety_text = paletova_kalkulacka(nazev_zbozi, celkem_ks)

        st.markdown(f"""
        <div class="product-card">
            <div class="product-title">
                <span>{nazev_zbozi}</span>
                <span class="category-badge">{kategorie}</span>
            </div>
            <div style="margin-bottom: 12px;">
                <span class="product-code">KÓD: {kod_zbozi}</span>
            </div>
            <div class="stock-grid">
                <div class="stock-box">
                    <div class="stock-box-label">Skladem celkem</div>
                    <div class="stock-box-value">{celkem_ks:g} j.</div>
                </div>
                <div class="stock-box">
                    <div class="stock-box-label">V přepočtu</div>
                    <div class="stock-box-value" style="font-size: 0.95rem;">{baleni_celkem}</div>
                </div>
            </div>
        """, unsafe_allow_html=True)

        if palety_text:
            st.markdown(f'<div class="pallet-banner">{palety_text}</div>', unsafe_allow_html=True)

        valid_exp = skupina[skupina['Datum_Exp_Obj'].notna()].sort_values('Datum_Exp_Obj')
        if not valid_exp.empty:
            fefo_top = valid_exp.iloc[0]
            st.markdown(f"""
            <div class="fefo-banner">
                <div class="fefo-icon">👉</div>
                <div class="fefo-text">
                    <strong>DOPORUČENÍ K VÝDEJI (FEFO):</strong><br>
                    Přednostně vyskladni šarži <span class="fefo-badge">{fefo_top['Číslo šarže']}</span> 
                    na lokaci <strong>{fefo_top['Lokace_Nazev']}</strong> 
                    (nejdřívější expirace: <strong>{fefo_top['Datum_Exp_Obj'].strftime('%d.%m.%Y')}</strong>).
                </div>
            </div>
            """, unsafe_allow_html=True)

        prehled = skupina.copy()
        prehled['Krabice / Balení'] = prehled.apply(
            lambda r: prepocet_na_baleni(r['Popis'], r['Zůstatek (množství)']), axis=1
        )

        tabulka = prehled[[
            'Lokace_Nazev', 'Zůstatek (množství)', 'Krabice / Balení', 
            'Číslo šarže', 'Expirace (stav)', 'Poslední příjem'
        ]].sort_values(by='Zůstatek (množství)', ascending=False)
        tabulka.rename(columns={'Lokace_Nazev': 'Lokace skladu'}, inplace=True)

        st.dataframe(tabulka, use_container_width=True, hide_index=True)
        st.markdown('</div>', unsafe_allow_html=True)

# --- HLAVNÍ APLIKACE ---
st.markdown("""
<div class="main-header">
    <h1>📦 Skladový asistent</h1>
    <span>Mobilní terminál</span>
</div>
""", unsafe_allow_html=True)

if not os.path.exists(EXCEL_FILE):
    st.error(f"Soubor '{EXCEL_FILE}' nebyl nalezen. Nahraj ho prosím v záložce 'Aktualizovat'.")
    stock_df = pd.DataFrame()
else:
    stock_df = load_stock_data(EXCEL_FILE)

vybrana_lokace = st.radio(
    "Filtrovat sklad:",
    ["Všechny sklady", "Boršice", "Valmez", "Jen Komise"],
    horizontal=True
)

tab_foto, tab_rucni, tab_nesrovnalosti, tab_admin = st.tabs([
    "📷 Vyfotit obal", "🔍 Hledání", "⚠️ Hlášení", "🔄 Aktualizovat"
])

# 1. ZÁLOŽKA: VYFOTIT OBAL
with tab_foto:
    st.write("**Namiř foťák na kanystr, pytel nebo krabici a klepni na spoušť:**")
    foto_obal = st.camera_input("Vyfotit obal", label_visibility="collapsed")

    if foto_obal and not stock_df.empty:
        image = Image.open(foto_obal)
        with st.spinner("AI čte etiketu a hledá zásoby..."):
            prompt = """
            Prohlédni si tento obrázek chemického nebo zemědělského přípravku / etikety / krabice.
            Najdi:
            1. Obchodní název přípravku (např. RETAFOS, BELKAR, IRAZU, YARAMILA, BIZON, FOLPAN, CARYX, NINJA).
            2. Kód zboží, pokud je vidět (např. CHE01414).

            Vrať výhradně čistý JSON:
            {"nazev": "SEM_NAZEV", "kod": null}
            """

            modely_k_vyzkouseni = ["gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-3.5-flash"]
            response = None
            posledni_chyba = None

            client = genai.Client(api_key=API_KEY)

            for model_name in modely_k_vyzkouseni:
                for pokus in range(2):
                    try:
                        response = client.models.generate_content(
                            model=model_name,
                            contents=[image, prompt]
                        )
                        if response and response.text:
                            break
                    except Exception as e:
                        posledni_chyba = e
                        time.sleep(1.2)
                if response and response.text:
                    break

            if not response or not response.text:
                st.error(f"Chyba při komunikaci s AI: {posledni_chyba}")
            else:
                cisty_text = re.sub(r'```(?:json)?', '', response.text).strip()
                try:
                    data = json.loads(cisty_text)
                    hledany_nazev = data.get("nazev", "").strip()
                    hledany_kod = data.get("kod")

                    st.markdown(f"🔍 **Rozpoznáno z fotky:** `{hledany_nazev}`")

                    mask = stock_df['Popis'].str.contains(hledany_nazev, case=False, na=False)
                    if hledany_kod:
                        mask = mask | (stock_df['Číslo zboží'].astype(str) == str(hledany_kod))

                    zobraz_vysledky(stock_df[mask], hledany_nazev, vybrana_lokace)
                except Exception as parse_err:
                    st.error(f"Nepodařilo se zpracovat odpověď AI: {cisty_text}")

# 2. ZÁLOŽKA: HLEDÁNÍ A NAŠEPTÁVAČ
with tab_rucni:
    if not stock_df.empty:
        seznam_zbozi = sorted(stock_df['Popis'].dropna().unique().tolist())

        vybrany_produkt = st.selectbox(
            "⚡ Našeptávač (začni psát název přípravku):",
            options=seznam_zbozi,
            index=None,
            placeholder="Napiš pár písmen (např. Folpan, Bizon, Ninja, Caryx)..."
        )

        st.caption("— NEBO hledej podle čísla šarže či kódu zboží —")
        volny_text = st.text_input("Zadej číslo šarže nebo kód:", placeholder="např. 7426507, CHE00912...")

        if vybrany_produkt:
            vysledky = stock_df[stock_df['Popis'] == vybrany_produkt]
            zobraz_vysledky(vysledky, vybrany_produkt, vybrana_lokace)
        elif volny_text.strip():
            text_clean = volny_text.strip()
            mask_text = (
                stock_df['Popis'].str.contains(text_clean, case=False, na=False) |
                stock_df['Číslo zboží'].astype(str).str.contains(text_clean, case=False, na=False) |
                stock_df['Číslo šarže'].astype(str).str.contains(text_clean, case=False, na=False)
            )
            vysledky = stock_df[mask_text]
            zobraz_vysledky(vysledky, text_clean, vybrana_lokace)
        else:
            st.info("👆 Vyber přípravek z našeptávače výše nebo napiš šarži do pole.")

# 3. ZÁLOŽKA: HLÁŠENÍ NESROVNALOSTÍ
with tab_nesrovnalosti:
    st.subheader("⚠️ Záznam nesrovnalosti v regálu")
    st.caption("Nesedí stav na skladě s realitou? Zapiš to sem pro vedoucího skladu.")

    with st.form("form_nesrovnalost", clear_on_submit=True):
        polozka_hledat = st.text_input("Název nebo kód zboží:")
        lokace_zadat = st.selectbox("Kde zboží leží:", list(LOC_MAP.values()) + ["🤝 Komise"])
        sarze_zadat = st.text_input("Číslo šarže (pokud je známo):")
        stav_system = st.number_input("Stav v systému (ks/l):", min_value=0.0, step=1.0)
        stav_realita = st.number_input("Fyzicky napočítáno v regálu (ks/l):", min_value=0.0, step=1.0)
        poznamka = st.text_area("Poznámka (např. poškozený obal, chybí krabice):")

        odeslat = st.form_submit_button("💾 Uložit hlášení")
        if odeslat:
            if polozka_hledat:
                uloz_nesrovnalost(
                    "", polozka_hledat, lokace_zadat, sarze_zadat,
                    stav_system, stav_realita, poznamka
                )
                st.success("✅ Nesrovnalost byla uložena do protokolu.")
            else:
                st.error("Vyplň prosím název zboží.")

    if os.path.exists(NESROVNALOSTI_FILE):
        st.write("---")
        st.subheader("📋 Protokol nahlášených chyb")
        df_log = pd.read_csv(NESROVNALOSTI_FILE, encoding='utf-8-sig')
        st.dataframe(df_log.tail(10), use_container_width=True, hide_index=True)

        with open(NESROVNALOSTI_FILE, "rb") as f:
            st.download_button(
                label="📥 Stáhnout protokol nesrovnalostí (CSV)",
                data=f,
                file_name="nesrovnalosti_sklad.csv",
                mime="text/csv"
            )

# 4. ZÁLOŽKA: NAHRÁNÍ NOVÉHO EXCELU
with tab_admin:
    st.subheader("🔄 Aktualizace skladových dat")
    st.caption("Nahraj čerstvý export z Business Central pro aktualizaci zásob.")
    
    novy_soubor = st.file_uploader("Nahraj nový soubor skladu (.xlsx)", type=["xlsx"])
    if novy_soubor is not None:
        if st.button("🚀 Přepsat data skladu a aktualizovat", type="primary"):
            with open(EXCEL_FILE, "wb") as f:
                f.write(novy_soubor.getbuffer())
            st.cache_data.clear()
            st.success("✅ Sklad byl úspěšně aktualizován!")
            st.rerun()
