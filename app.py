import streamlit as st
import pandas as pd
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

# --- ČISTÝ MODERNÍ DESIGN ---
st.markdown("""
<style>
    .stApp {
        background-color: #f8fafc !important;
        color: #0f172a !important;
    }
    p, span, label, div[data-testid="stMarkdownContainer"] p {
        color: #0f172a !important;
    }

    .main-header {
        background: linear-gradient(135deg, #1b4d3e 0%, #2e7d32 100%);
        padding: 14px 18px;
        border-radius: 12px;
        margin-bottom: 14px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.08);
        display: flex;
        align-items: center;
        justify-content: space-between;
    }
    .main-header h1 {
        color: #ffffff !important;
        font-size: 1.35rem !important;
        margin: 0 !important;
        font-weight: 700 !important;
    }
    .main-header span {
        color: #ffffff !important;
        font-size: 0.85rem;
        opacity: 0.9;
    }

    div[data-testid="stRadio"] > label {
        color: #0f172a !important;
        font-weight: 700 !important;
        font-size: 0.92rem !important;
    }
    div[data-testid="stRadio"] > div {
        background: #ffffff !important;
        padding: 8px 12px !important;
        border-radius: 12px !important;
        border: 1px solid #cbd5e1 !important;
        gap: 12px !important;
    }
    div[data-testid="stRadio"] label p {
        color: #1e293b !important;
        font-weight: 600 !important;
    }

    .stTabs [data-baseweb="tab-list"] {
        gap: 4px;
        background-color: transparent;
        border-bottom: 2px solid #e2e8f0;
    }
    .stTabs [data-baseweb="tab"] {
        background-color: transparent !important;
        border: none !important;
        padding: 10px 14px !important;
        border-radius: 8px 8px 0 0 !important;
    }
    .stTabs [data-baseweb="tab"] p {
        color: #64748b !important;
        font-weight: 600 !important;
        font-size: 0.95rem !important;
    }
    .stTabs [aria-selected="true"] {
        background-color: #ffffff !important;
        border-bottom: 3px solid #2e7d32 !important;
    }
    .stTabs [aria-selected="true"] p {
        color: #2e7d32 !important;
        font-weight: 800 !important;
    }

    .product-card {
        background: #ffffff !important;
        border-radius: 14px;
        padding: 18px;
        margin-bottom: 18px;
        box-shadow: 0 3px 10px rgba(0,0,0,0.05);
        border: 1px solid #e2e8f0;
    }
    .product-title {
        font-size: 1.3rem;
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
        font-size: 0.82rem;
        padding: 4px 10px;
        border-radius: 20px;
        font-weight: 700;
        background: #dcfce7 !important;
        color: #166534 !important;
        border: 1px solid #bbf7d0;
    }

    .stock-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
        gap: 10px;
        margin: 12px 0;
    }
    .stock-box {
        background: #f8fafc !important;
        border: 1px solid #e2e8f0 !important;
        border-radius: 10px;
        padding: 10px;
        text-align: center;
    }
    .stock-box-label {
        font-size: 0.72rem !important;
        text-transform: uppercase;
        color: #64748b !important;
        font-weight: 700 !important;
        margin-bottom: 2px;
    }
    .stock-box-value {
        font-size: 1.2rem !important;
        font-weight: 800 !important;
        color: #0f172a !important;
    }

    .fefo-banner {
        background: #fffbeb !important;
        border: 1.5px solid #f59e0b !important;
        border-radius: 10px;
        padding: 12px 14px;
        margin: 12px 0;
        display: flex;
        align-items: flex-start;
        gap: 10px;
    }
    .fefo-icon {
        font-size: 1.4rem;
        line-height: 1;
    }
    .fefo-text {
        font-size: 0.92rem !important;
        color: #78350f !important;
        line-height: 1.4;
    }
    .fefo-badge {
        background: #f59e0b !important;
        color: #ffffff !important;
        padding: 2px 7px;
        border-radius: 6px;
        font-weight: 800;
        font-family: monospace;
    }

    .pallet-banner {
        background: #eff6ff !important;
        border: 1px solid #bfdbfe !important;
        border-radius: 8px;
        padding: 8px 12px;
        margin: 8px 0;
        color: #1e3a8a !important;
        font-size: 0.92rem !important;
        font-weight: 700 !important;
    }
</style>
""", unsafe_allow_html=True)

EXCEL_FILE = "sklad.xlsx"
NESROVNALOSTI_FILE = "nesrovnalosti.csv"
INV_FILE = "inventura_vysledky.csv"

LOC_MAP = {
    '151BO': '🏢 Boršice',
    '151VM': '🏭 Valmez',
    '151ST': '🏬 Staré Město',
    '151ZL': '🏬 Zlín',
    '151UB': '🏬 Uherský Brod',
    '151SL': '🏬 Slavičín',
    'NACESTE': '🚚 Na cestě'
}

def format_location_name(loc, prodejce):
    if not isinstance(loc, str):
        return '-'
    if loc in LOC_MAP:
        return LOC_MAP[loc]
    if loc.startswith('K.'):
        nazev_komise = loc[2:].upper()
        prodejce_str = str(prodejce).strip().upper()
        
        if prodejce_str in ['TRČÁLEK', 'TRCALEK']:
            return f"🤝 Komise {nazev_komise} (Valmez)"
        else:
            return f"🤝 Komise {nazev_komise} (Boršice)"
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
        return '🛡️️ Mořidlo'
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
    if not isinstance(popis, str) or qty is None or pd.isna(qty) or qty == 0:
        return f"{qty:g} j."

    m_mult = re.search(r'(\d+)\s*[xX*]\s*(\d+(?:[.,]\d+)?)\s*(l|litr|kg|g|ml)\b', popis, re.IGNORECASE)
    if m_mult:
        ks_v_baleni = float(m_mult.group(1))
        velikost_ks = float(m_mult.group(2).replace(',', '.'))
        uom_raw = m_mult.group(3).lower()

        if uom_raw in ['g', 'ml']:
            velikost_ks_base = velikost_ks / 1000.0
        else:
            velikost_ks_base = velikost_ks

        celkem_base_v_baleni = ks_v_baleni * velikost_ks_base
        if celkem_base_v_baleni > 0:
            pocet = qty / celkem_base_v_baleni
            return f"{pocet:g} balení ({m_mult.group(0).strip()})"

    m = re.search(r'(\d+(?:[.,]\d+)?)\s*(l|litr|kg|g|ml)\b', popis, re.IGNORECASE)
    if m:
        val_str = m.group(1).replace(',', '.')
        unit_size = float(val_str)
        uom_raw = m.group(2).lower()

        if uom_raw in ['g', 'ml']:
            unit_size_base = unit_size / 1000.0
            uom_base = 'kg' if uom_raw == 'g' else 'l'
        else:
            unit_size_base = unit_size
            uom_base = 'l' if uom_raw in ['l', 'litr'] else ('kg' if uom_raw == 'kg' else uom_raw)

        if unit_size_base > 0:
            pocet = qty / unit_size_base
            if abs(pocet - round(pocet)) < 0.05:
                n = int(round(pocet))
                if uom_base == 'l':
                    typ_obal = 'kanystr' if unit_size_base >= 3 else 'lahev'
                elif uom_base == 'kg':
                    typ_obal = 'pytel' if unit_size_base >= 15 else 'baleni'
                else:
                    typ_obal = 'baleni'

                text_obalu = sklonuj(n, typ_obal)
                krabice_info = ""

                if uom_base == 'l' and unit_size_base == 5 and n >= 4:
                    k = n // 4
                    zb = n % 4
                    k_text = sklonuj(k, 'krabice')
                    if zb > 0:
                        krabice_info = f" ({k_text} + {sklonuj(zb, 'kanystr')})"
                    else:
                        krabice_info = f" ({k_text})"
                elif uom_base == 'l' and (unit_size_base == 1 or unit_size == 1000) and n >= 12:
                    k = n // 12
                    zb = n % 12
                    k_text = sklonuj(k, 'krabice')
                    if zb > 0:
                        krabice_info = f" ({k_text} po 12 ks + {sklonuj(zb, 'lahev')})"
                    else:
                        krabice_info = f" ({k_text} po 12 ks)"

                puvodni_jednotka = m.group(0).strip()
                return f"{text_obalu} po {puvodni_jednotka}{krabice_info}"
            else:
                puvodni_jednotka = m.group(0).strip()
                return f"{qty:g} {uom_base} (~{pocet:.1f} balení po {puvodni_jednotka})"

    if re.search(r'\bL\b', popis):
        return f"{sklonuj(int(qty), 'lahev')} (1 l)"

    return f"{qty:g} j."

def paletova_kalkulacka(popis, qty):
    if not isinstance(popis, str) or qty is None or qty <= 0:
        return None
    if '25' in popis and 'kg' in popis.lower():
        pytle = qty / 25.0
        if pytle >= 30:
            palet = int(pytle // 40)
            zb_pytle = int(pytle % 40)
            if palet > 0:
                pal_text = sklonuj(palet, 'paleta')
                if zb_pytle == 0:
                    return f"🚜 Palety: {pal_text} (po 40 pytlích / 1 tuna)"
                return f"🚜 Palety: {pal_text} + {sklonuj(zb_pytle, 'pytel')} navrch"
            else:
                return f"🚜 Skoro paleta: {sklonuj(zb_pytle, 'pytel')} (chybí {40 - zb_pytle} do palety)"
    if re.search(r'\b5\s*l\b', popis, re.IGNORECASE):
        kanystru = qty / 5.0
        krabic = kanystru / 4.0
        if krabic >= 20:
            palet = int(krabic // 32)
            zb_krabic = int(krabic % 32)
            if palet > 0:
                pal_text = sklonuj(palet, 'paleta')
                if zb_krabic == 0:
                    return f"🚜 Palety: {pal_text} (po 32 krabicích / 640 l)"
                return f"🚜 Palety: {pal_text} + {sklonuj(zb_krabic, 'krabice')} navrch"
            else:
                return f"🚜 Skoro paleta: {sklonuj(zb_krabic, 'krabice')} (chybí {32 - zb_krabic} do palety)"
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

    mask_k = df_active['Kód lokace'].str.startswith('K.', na=False)
    
    non_k = df_active[~mask_k]
    grouped_non_k = non_k.groupby(
        ['Číslo zboží', 'Popis', 'Kód kategorie zboží', 'Kód lokace', 'Prodejce Kód', 'Číslo šarže', 'Datum expirace'],
        dropna=False,
        as_index=False
    ).agg({'Zůstatek (množství)': 'sum'})

    k_locs = df_active[mask_k]
    k_grouped = k_locs.groupby(
        ['Číslo zboží', 'Popis', 'Kód kategorie zboží', 'Kód lokace', 'Číslo šarže', 'Datum expirace'],
        dropna=False,
        as_index=False
    ).agg({'Zůstatek (množství)': 'sum'})
    
    rok_start = pd.to_datetime(f"{datetime.now().year}-01-01")
    df_rok = df[pd.to_datetime(df['Zúčtovací datum'], errors='coerce') >= rok_start].copy()
    df_rok['Číslo šarže'] = df_rok['Číslo šarže'].fillna('-')
    
    trc_mask = df_rok['Prodejce Kód'].astype(str).str.upper().isin(['TRČÁLEK', 'TRCALEK'])
    trc_batch_sums = df_rok[trc_mask].groupby(['Číslo zboží', 'Kód lokace', 'Číslo šarže'])['Množství'].sum().reset_index()
    trc_batch_sums.rename(columns={'Množství': 'Trc_Mnozstvi'}, inplace=True)
    
    merged_k = pd.merge(k_grouped, trc_batch_sums, on=['Číslo zboží', 'Kód lokace', 'Číslo šarže'], how='left')
    merged_k['Trc_Mnozstvi'] = merged_k['Trc_Mnozstvi'].fillna(0)
    
    final_rows = []
    for _, row in merged_k.iterrows():
        total = row['Zůstatek (množství)']
        trc_share = max(0, min(row['Trc_Mnozstvi'], total)) 
        ostatni_share = total - trc_share
        
        base_dict = {
            'Číslo zboží': row['Číslo zboží'],
            'Popis': row['Popis'],
            'Kód kategorie zboží': row['Kód kategorie zboží'],
            'Kód lokace': row['Kód lokace'],
            'Číslo šarže': row['Číslo šarže'],
            'Datum expirace': row['Datum expirace']
        }
        
        if trc_share > 0:
            d = base_dict.copy()
            d['Prodejce Kód'] = 'TRČÁLEK'
            d['Zůstatek (množství)'] = trc_share
            final_rows.append(d)
            
        if ostatni_share > 0:
            d = base_dict.copy()
            d['Prodejce Kód'] = 'MAN'
            d['Zůstatek (množství)'] = ostatni_share
            final_rows.append(d)
            
    if not final_rows:
        grouped = grouped_non_k
    else:
        grouped_k_final = pd.DataFrame(final_rows)
        grouped = pd.concat([grouped_non_k, grouped_k_final], ignore_index=True)

    grouped = pd.merge(grouped, posledni_prijem, on=['Číslo zboží', 'Kód lokace', 'Číslo šarže'], how='left')

    grouped['Datum_Exp_Obj'] = pd.to_datetime(grouped['Datum expirace'], errors='coerce')
    grouped['Datum_Prijmu_Obj'] = pd.to_datetime(grouped['Datum posledního příjmu'], errors='coerce')

    grouped['Expirace (stav)'] = grouped['Datum_Exp_Obj'].apply(format_expirace_semafor)
    grouped['Poslední příjem'] = grouped['Datum_Prijmu_Obj'].dt.strftime('%d.%m.%Y').fillna('-')
    grouped['Kategorie_Nazev'] = grouped['Kód kategorie zboží'].apply(format_category_name)
    
    grouped['Lokace_Nazev'] = grouped.apply(lambda row: format_location_name(row['Kód lokace'], row['Prodejce Kód']), axis=1)

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
        mask_bo = (vysledky_df['Kód lokace'] == '151BO') 
        mask_komise_bo = vysledky_df['Kód lokace'].str.startswith('K.', na=False) & ~vysledky_df['Prodejce Kód'].astype(str).str.upper().isin(['TRČÁLEK', 'TRCALEK'])
        vysledky_df = vysledky_df[mask_bo | mask_komise_bo]
        
    elif vybrana_lokace == 'Valmez':
        mask_vm = (vysledky_df['Kód lokace'] == '151VM')
        mask_komise_vm = vysledky_df['Kód lokace'].str.startswith('K.', na=False) & vysledky_df['Prodejce Kód'].astype(str).str.upper().isin(['TRČÁLEK', 'TRCALEK'])
        vysledky_df = vysledky_df[mask_vm | mask_komise_vm]
        
    elif vybrana_lokace == 'Jen Komise':
        vysledky_df = vysledky_df[vysledky_df['Kód lokace'].str.startswith('K.', na=False)]

    if vysledky_df.empty:
        st.warning(f"Pro výraz **'{dotaz_popis}'** nebyl na vybraném skladu nalezen žádný zůstatek.")
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
    st.error(f"Soubor '{EXCEL_FILE}' nebyl nalezen. Nahraj ho v záložce 'Data'.")
    stock_df = pd.DataFrame()
else:
    stock_df = load_stock_data(EXCEL_FILE)

vybrana_lokace = st.radio(
    "Filtrovat sklad:",
    ["Všechny sklady", "Boršice", "Valmez", "Jen Komise"],
    horizontal=True
)

tab_rucni, tab_inventura, tab_nesrovnalosti, tab_admin = st.tabs([
    "🔍 Hledat", "📋 Inventura", "⚠️ Hlášení", "🔄 Data"
])

# 1. HLEDÁNÍ
with tab_rucni:
    if not stock_df.empty:
        seznam_zbozi = sorted(stock_df['Popis'].dropna().unique().tolist())

        vybrany_produkt = st.selectbox(
            "⚡ Našeptávač:",
            options=seznam_zbozi,
            index=None,
            placeholder="Napiš název (např. Folpan, Bizon, Ninja)..."
        )

        st.caption("— NEBO hledej podle šarže či kódu —")
        volny_text = st.text_input("Zadej číslo šarže nebo kód:", placeholder="např. 7426507...")

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
            st.info("👆 Vyber přípravek z našeptávače nebo napiš šarži.")

# 2. MOBILNÍ INVENTURA
with tab_inventura:
    st.subheader("📋 Mobilní inventura")
    st.caption("Rozbal položku, zadej fyzický stav a potvrď.")

    if "inv_lokace" not in st.session_state:
        st.session_state.inv_lokace = "Boršice"

    st.session_state.inv_lokace = st.selectbox(
        "Který úsek počítáš?", 
        ["Boršice", "Valmez", "Všechny komise"],
        index=["Boršice", "Valmez", "Všechny komise"].index(st.session_state.inv_lokace)
    )

    if not stock_df.empty:
        inv_df = stock_df.copy()
        if st.session_state.inv_lokace == 'Boršice':
            inv_df = inv_df[(inv_df['Kód lokace'] == '151BO') | ((inv_df['Kód lokace'].str.startswith('K.')) & (~inv_df['Prodejce Kód'].astype(str).str.upper().isin(['TRČÁLEK', 'TRCALEK'])))]
        elif st.session_state.inv_lokace == 'Valmez':
            inv_df = inv_df[(inv_df['Kód lokace'] == '151VM') | ((inv_df['Kód lokace'].str.startswith('K.')) & (inv_df['Prodejce Kód'].astype(str).str.upper().isin(['TRČÁLEK', 'TRCALEK'])))]
        elif st.session_state.inv_lokace == 'Všechny komise':
            inv_df = inv_df[inv_df['Kód lokace'].str.startswith('K.', na=False)]

        inv_items = inv_df.groupby(['Číslo zboží', 'Popis', 'Číslo šarže', 'Lokace_Nazev'], dropna=False)['Zůstatek (množství)'].sum().reset_index()
        inv_items = inv_items[inv_items['Zůstatek (množství)'] > 0].sort_values('Popis')

        hotove_zaznamy = set()
        if os.path.exists(INV_FILE):
            try:
                log_df = pd.read_csv(INV_FILE, encoding='utf-8-sig')
                hotove_zaznamy = set(log_df['Kód zboží'].astype(str) + "|" + log_df['Šarže'].astype(str))
            except:
                pass

        celkem_polozek = len(inv_items)
        spocitano = len([x for _, x in inv_items.iterrows() if f"{x['Číslo zboží']}|{x['Číslo šarže']}" in hotove_zaznamy])
        
        if celkem_polozek > 0:
            st.progress(spocitano / celkem_polozek)
            st.markdown(f"**Průběh:** Spočítáno **{spocitano}** z **{celkem_polozek}** položek.")
        else:
            st.info("Na této lokaci není podle systému žádné zboží.")

        for idx, row in inv_items.iterrows():
            kod = row['Číslo zboží']
            nazev = row['Popis']
            sarze = row['Číslo šarže']
            system_stav = row['Zůstatek (množství)']
            klic = f"{kod}|{sarze}"
            
            je_hotovo = klic in hotove_zaznamy
            ikona = "🟢" if je_hotovo else "🟠"
            
            with st.expander(f"{ikona} {nazev} (Šarže: {sarze})"):
                st.markdown(f"**Kód:** {kod} | **Očekáváno:** {system_stav:g} j.")
                
                with st.form(key=f"form_{klic}"):
                    fyzicky_stav = st.number_input(
                        "Fyzicky napočítáno:", 
                        min_value=0.0, 
                        value=float(system_stav),
                        step=1.0,
                        key=f"num_{klic}"
                    )
                    
                    if st.form_submit_button("💾 Uložit stav", use_container_width=True, type="primary"):
                        zaznam = [
                            datetime.now().strftime('%d.%m.%Y %H:%M'),
                            st.session_state.inv_lokace, kod, nazev, sarze,
                            system_stav, fyzicky_stav, fyzicky_stav - system_stav
                        ]
                        
                        file_exists = os.path.exists(INV_FILE)
                        with open(INV_FILE, mode='a', newline='', encoding='utf-8-sig') as f:
                            writer = csv.writer(f)
                            if not file_exists:
                                writer.writerow(['Čas', 'Úsek', 'Kód zboží', 'Popis', 'Šarže', 'Systém', 'Fyzicky', 'Rozdíl'])
                            writer.writerow(zaznam)
                        
                        st.success("Uloženo!")
                        time.sleep(0.5)
                        st.rerun()

        if os.path.exists(INV_FILE):
            st.write("---")
            with open(INV_FILE, "r", encoding="utf-8-sig") as f_down:
                st.download_button(
                    label="📥 Stáhnout výsledky inventury (CSV)",
                    data=f_down.read(),
                    file_name=f"inventura_{datetime.now().strftime('%Y%m%d')}.csv",
                    mime="text/csv",
                    use_container_width=True
                )

# 3. ZÁLOŽKA: HLÁŠENÍ NESROVNALOSTÍ
with tab_nesrovnalosti:
    st.subheader("Hlášení")
    st.caption("Nesedí stav na skladě s realitou? Zapiš to sem pro vedoucího skladu.")

    with st.form("form_nesrovnalost", clear_on_submit=True):
        polozka_hledat = st.text_input("Název nebo kód zboží:")
        lokace_zadat = st.selectbox("Kde zboží leží:", list(LOC_MAP.values()) + ["🤝 Komise"])
        sarze_zadat = st.text_input("Číslo šarže:")
        stav_system = st.number_input("Stav v systému (ks/l):", min_value=0.0, step=1.0)
        stav_realita = st.number_input("Fyzicky napočítáno (ks/l):", min_value=0.0, step=1.0)
        poznamka = st.text_area("Poznámka:")

        odeslat = st.form_submit_button("💾 Uložit hlášení")
        if odeslat:
            if polozka_hledat:
                uloz_nesrovnalost(
                    "", polozka_hledat, lokace_zadat, sarze_zadat,
                    stav_system, stav_realita, poznamka
                )
                st.success("✅ Nesrovnalost byla uložena.")
            else:
                st.error("Vyplň prosím název zboží.")

    if os.path.exists(NESROVNALOSTI_FILE):
        st.write("---")
        st.subheader("Protokol chyb")
        df_log = pd.read_csv(NESROVNALOSTI_FILE, encoding='utf-8-sig')
        st.dataframe(df_log.tail(10), use_container_width=True, hide_index=True)

        with open(NESROVNALOSTI_FILE, "r", encoding="utf-8-sig") as f_down:
            csv_obsah = f_down.read()

        st.download_button(
            label="📥 Stáhnout protokol (CSV)",
            data=csv_obsah,
            file_name="nesrovnalosti_sklad.csv",
            mime="text/csv"
        )

# 4. ZÁLOŽKA: NAHRÁNÍ NOVÉHO EXCELU
with tab_admin:
    st.subheader("Aktualizace skladových dat")
    st.caption("Nahraj čerstvý export z Business Central.")
    
    novy_soubor = st.file_uploader("Nahraj nový soubor skladu (.xlsx)", type=["xlsx"])
    if novy_soubor is not None:
        if st.button("🚀 Přepsat data skladu a aktualizovat", type="primary"):
            with open(EXCEL_FILE, "wb") as f:
                f.write(novy_soubor.getbuffer())
            st.cache_data.clear()
            st.success("✅ Sklad byl úspěšně aktualizován!")
            st.rerun()
