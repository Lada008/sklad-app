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

    .stTabs [data-baseweb="tab-list"] {
        gap: 4px;
        background-color: transparent;
        border-bottom: 2px solid #e2e8f0;
    }
    .stTabs [data-baseweb="tab"] {
        background-color: transparent !important;
        border: none !important;
        padding: 10px 10px !important;
        border-radius: 8px 8px 0 0 !important;
    }
    .stTabs [data-baseweb="tab"] p {
        color: #64748b !important;
        font-weight: 600 !important;
        font-size: 0.90rem !important;
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
        padding: 16px;
        margin-bottom: 8px;
        box-shadow: 0 3px 10px rgba(0,0,0,0.05);
        border: 1px solid #e2e8f0;
    }
    .product-title {
        font-size: 1.2rem;
        font-weight: 800;
        color: #0f172a !important;
        margin-bottom: 6px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 6px;
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
        font-size: 0.75rem;
        padding: 4px 8px;
        border-radius: 20px;
        font-weight: 700;
        background: #dcfce7 !important;
        color: #166534 !important;
        border: 1px solid #bbf7d0;
    }

    .stock-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
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
        font-size: 0.65rem !important;
        text-transform: uppercase;
        color: #64748b !important;
        font-weight: 700 !important;
        margin-bottom: 2px;
    }
    .stock-box-value {
        font-size: 1.1rem !important;
        font-weight: 800 !important;
        color: #0f172a !important;
    }

    .fefo-banner {
        background: #fffbeb !important;
        border: 1px solid #f59e0b !important;
        border-radius: 10px;
        padding: 10px 12px;
        margin: 12px 0;
        display: flex;
        align-items: flex-start;
        gap: 10px;
    }
    .fefo-icon {
        font-size: 1.2rem;
        line-height: 1;
    }
    .fefo-text {
        font-size: 0.85rem !important;
        color: #78350f !important;
        line-height: 1.4;
    }
    .fefo-badge {
        background: #f59e0b !important;
        color: #ffffff !important;
        padding: 2px 6px;
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
        font-size: 0.85rem !important;
        font-weight: 700 !important;
    }

    .mobile-detail-card {
        background: #ffffff;
        border-radius: 8px;
        padding: 12px;
        margin-bottom: 8px;
        font-size: 0.85rem;
        border-left: 4px solid #2e7d32;
        box-shadow: 0 2px 4px rgba(0,0,0,0.04);
        border: 1px solid #e2e8f0;
        border-left-width: 4px;
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
    if jednotka == 'kanystr': return f"{pocet} kanystr" if p == 1 else (f"{pocet} kanystry" if 2 <= p <= 4 else f"{pocet} kanystrů")
    if jednotka == 'krabice': return f"{pocet} krabice" if 1 <= p <= 4 else f"{pocet} krabic"
    if jednotka == 'lahev': return f"{pocet} láhev" if p == 1 else (f"{pocet} láhve" if 2 <= p <= 4 else f"{pocet} lahví")
    if jednotka == 'pytel': return f"{pocet} pytel" if p == 1 else (f"{pocet} pytle" if 2 <= p <= 4 else f"{pocet} pytlů")
    if jednotka == 'kus': return f"{pocet} kus" if p == 1 else (f"{pocet} kusy" if 2 <= p <= 4 else f"{pocet} kusů")
    if jednotka == 'paleta': return f"{pocet} celá paleta" if p == 1 else (f"{pocet} celé palety" if 2 <= p <= 4 else f"{pocet} celých palet")
    if jednotka == 'baleni': return f"{pocet} balení"
    return f"{pocet} {jednotka}"

def ziskej_krok_baleni(popis):
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

# VYLEPŠENÁ FUNKCE - Umožňuje vnucení libovolné velikosti balení z UI
def prepocet_na_baleni(popis, qty, unit_size_base=None):
    if not isinstance(popis, str) or qty is None or pd.isna(qty) or qty == 0: 
        return f"{qty:g} j."

    uom_base = 'l'
    if re.search(r'\b(kg|g)\b', popis, re.IGNORECASE): uom_base = 'kg'

    # Pokud si uživatel velikost balení nepřepsal ručně, použijeme chytrou detekci multipacků
    if unit_size_base is None:
        m_mult = re.search(r'(\d+)\s*[xX*]\s*(\d+(?:[.,]\d+)?)\s*(l|litr|kg|g|ml)\b', popis, re.IGNORECASE)
        if m_mult:
            ks_v_baleni = float(m_mult.group(1))
            velikost_ks = float(m_mult.group(2).replace(',', '.'))
            u_raw = m_mult.group(3).lower()
            v_base = velikost_ks / 1000.0 if u_raw in ['g', 'ml'] else velikost_ks
            celkem_base_v_baleni = ks_v_baleni * v_base
            if celkem_base_v_baleni > 0:
                pocet = qty / celkem_base_v_baleni
                return f"{pocet:g} balení ({m_mult.group(0).strip()})"
                
        unit_size_base = ziskej_krok_baleni(popis)

    if unit_size_base > 0:
        pocet = qty / unit_size_base
        if abs(pocet - round(pocet)) < 0.05:
            n = int(round(pocet))
            if uom_base == 'l': typ_obal = 'kanystr' if unit_size_base >= 3 else 'lahev'
            elif uom_base == 'kg': typ_obal = 'pytel' if unit_size_base >= 15 else 'baleni'
            else: typ_obal = 'baleni'

            text_obalu = sklonuj(n, typ_obal)
            krabice_info = ""

            if uom_base == 'l' and unit_size_base == 5 and n >= 4:
                k = n // 4
                zb = n % 4
                if zb > 0: krabice_info = f" ({sklonuj(k, 'krabice')} + {sklonuj(zb, 'kanystr')})"
                else: krabice_info = f" ({sklonuj(k, 'krabice')})"
            elif uom_base == 'l' and (unit_size_base == 1) and n >= 12:
                k = n // 12
                zb = n % 12
                if zb > 0: krabice_info = f" ({sklonuj(k, 'krabice')} po 12 ks + {sklonuj(zb, 'lahev')})"
                else: krabice_info = f" ({sklonuj(k, 'krabice')} po 12 ks)"

            return f"{text_obalu} po {unit_size_base:g} {uom_base}{krabice_info}"
        else:
            return f"{qty:g} {uom_base} (~{pocet:.1f} balení po {unit_size_base:g} {uom_base})"
            
    return f"{qty:g} j."

def paletova_kalkulacka(popis, qty, unit_size_base=None):
    if not isinstance(popis, str) or qty is None or qty <= 0: return None
    
    uom_base = 'l'
    if re.search(r'\b(kg|g)\b', popis, re.IGNORECASE): uom_base = 'kg'
        
    if unit_size_base is None:
        unit_size_base = ziskej_krok_baleni(popis)

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
        default_vel = ziskej_krok_baleni(nazev_zbozi)
        
        # Přečtení uživatelské hodnoty ze session state, aby se stihla použít v přepočtu níže
        klic_velikosti = f"velikost_{kod_zbozi}"
        if klic_velikosti in st.session_state:
            vlastni_velikost = st.session_state[klic_velikosti]
        else:
            vlastni_velikost = default_vel

        baleni_celkem = prepocet_na_baleni(nazev_zbozi, celkem_ks, vlastni_velikost)
        palety_text = paletova_kalkulacka(nazev_zbozi, celkem_ks, vlastni_velikost)

        st.markdown(f"""
        <div class="product-card" style="margin-bottom: 8px;">
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
        </div>
        """, unsafe_allow_html=True)

        # Elegantní expander pro úpravu rovnou pod rámečkem
        with st.expander("⚙️ Úprava velikosti balení (přepočet)"):
            st.number_input(
                "Nastav přesnou velikost 1 balení (l/kg):", 
                value=float(default_vel), 
                min_value=0.001, 
                step=1.0 if default_vel >= 1 else 0.5,
                key=klic_velikosti
            )

        if palety_text:
            st.markdown(f'<div class="pallet-banner">{palety_text}</div>', unsafe_allow_html=True)

        valid_exp = skupina[skupina['Datum_Exp_Obj'].notna()].sort_values('Datum_Exp_Obj')
        if not valid_exp.empty:
            fefo_top = valid_exp.iloc[0]
            st.markdown(f"""
            <div class="fefo-banner">
                <div class="fefo-icon">👉</div>
                <div class="fefo-text">
                    <strong>FEFO VÝDEJ:</strong><br>
                    Šarže <span class="fefo-badge">{fefo_top['Číslo šarže']}</span> 
                    lokace <strong>{fefo_top['Lokace_Nazev']}</strong> 
                    (Exp: <strong>{fefo_top['Datum_Exp_Obj'].strftime('%d.%m.%Y')}</strong>).
                </div>
            </div>
            """, unsafe_allow_html=True)

        st.write("📍 **Kde přesně to leží:**")
        prehled = skupina.sort_values(by='Zůstatek (množství)', ascending=False)
        
        for _, row in prehled.iterrows():
            bal_str = prepocet_na_baleni(row['Popis'], row['Zůstatek (množství)'], vlastni_velikost)
            st.markdown(f"""
            <div class="mobile-detail-card">
                <strong>{row['Lokace_Nazev']}</strong> &nbsp;—&nbsp; {row['Zůstatek (množství)']:g} j. <i>({bal_str})</i><br>
                <span style="color:#64748b;">Šarže:</span> {row['Číslo šarže']} | <span style="color:#64748b;">Exp:</span> {row['Expirace (stav)']}
            </div>
            """, unsafe_allow_html=True)
            
        st.write("---")

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

vybrana_lokace = st.selectbox(
    "📍 Vyber sklad:",
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

        volny_text = st.text_input("Nebo hledej podle šarže / kódu:", placeholder="např. 7426507...")

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

        hotove_zaznamy = {}
        log_df = pd.DataFrame()
        if os.path.exists(INV_FILE):
            try:
                log_df = pd.read_csv(INV_FILE, encoding='utf-8-sig')
                log_df = log_df.drop_duplicates(subset=['Kód zboží', 'Šarže', 'Úsek'], keep='last')
                for _, r in log_df.iterrows():
                    klic = f"{r['Kód zboží']}|{r['Šarže']}|{r['Úsek']}"
                    hotove_zaznamy[klic] = r['Rozdíl']
            except:
                pass

        celkem_polozek = len(inv_items)
        spocitano = len([x for _, x in inv_items.iterrows() if f"{x['Číslo zboží']}|{x['Číslo šarže']}|{x['Lokace_Nazev']}" in hotove_zaznamy])
        
        if celkem_polozek > 0:
            st.progress(spocitano / celkem_polozek)
            st.markdown(f"**Průběh:** Spočítáno **{spocitano}** z **{celkem_polozek}** položek.")
            
            dostupne_nazvy = sorted(inv_items['Popis'].unique().tolist())
            hledany_nazev = st.selectbox(
                "🔍 Rychlé vyhledání (našeptávač):",
                options=dostupne_nazvy,
                index=None,
                placeholder="Vyber produkt..."
            )
            
            st.write("---")
            
            skupina_vyhledano = []
            skupina_zbyva = []
            skupina_hotovo = []
            
            for idx, row in inv_items.iterrows():
                klic_zaznamu = f"{row['Číslo zboží']}|{row['Číslo šarže']}|{row['Lokace_Nazev']}"
                je_hotovo = klic_zaznamu in hotove_zaznamy
                rozdil = hotove_zaznamy.get(klic_zaznamu, 0.0)
                data_karty = (idx, row, je_hotovo, rozdil, klic_zaznamu)
                
                if hledany_nazev and row['Popis'] == hledany_nazev:
                    skupina_vyhledano.append(data_karty)
                elif je_hotovo:
                    skupina_hotovo.append(data_karty)
                else:
                    skupina_zbyva.append(data_karty)

            def vykresli_kartu(idx, row, je_hotovo, rozdil, klic_zaznamu, rozbaleno=False):
                kod = row['Číslo zboží']
                nazev = row['Popis']
                sarze = row['Číslo šarže']
                system_stav = row['Zůstatek (množství)']
                lokace_nazev = row['Lokace_Nazev']
                
                ikona = "🟢" if (je_hotovo and rozdil == 0) else ("🔴" if je_hotovo else "🟠")
                
                with st.expander(f"{ikona} {nazev} (Šarže: {sarze} | {lokace_nazev})", expanded=rozbaleno):
                    if je_hotovo:
                        st.markdown(f"**Kód:** {kod} | **V systému bylo:** {system_stav:g} j.")
                        barva_textu = "green" if rozdil == 0 else "red"
                        st.markdown(f"Zadáno: **{system_stav + rozdil:g} j.** (<span style='color:{barva_textu}; font-weight:bold'>Rozdíl: {rozdil:g} j.</span>)", unsafe_allow_html=True)
                    else:
                        st.markdown(f"**Kód:** {kod} | **Očekáváno:** ❓ *(slepá inventura)*")
                    
                    krok = ziskej_krok_baleni(nazev)
                    
                    with st.form(key=f"inv_form_{idx}"):
                        fyzicky_stav = st.number_input(
                            "Fyzicky napočítáno:", 
                            min_value=0.0, 
                            value=float(system_stav + rozdil) if je_hotovo else None,
                            step=float(krok),
                            placeholder="Zadej počet...",
                            key=f"inv_num_{idx}"
                        )
                        
                        if st.form_submit_button("💾 Uložit stav", use_container_width=True, type="primary"):
                            if fyzicky_stav is None:
                                st.error("Zadej prosím počet (i kdyby to byla 0)!")
                            else:
                                akt_rozdil = fyzicky_stav - system_stav
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
                                    st.success(f"Všechno sedí! 👍 (Systém hlásil {system_stav:g} j.)")
                                else:
                                    st.error(f"⚠ Uloženo s rozdílem {akt_rozdil:g} j. (Systém hlásil {system_stav:g} j.)")
                                    
                                time.sleep(1.5)
                                st.rerun()

            if skupina_vyhledano:
                st.write("#### 🔍 Právě vyhledáno")
                for karta in skupina_vyhledano:
                    vykresli_kartu(*karta, rozbaleno=True)
                st.write("---")

            if skupina_zbyva:
                st.write("#### 🟠 Zbývá spočítat")
                for karta in skupina_zbyva:
                    vykresli_kartu(*karta, rozbaleno=False)

            if skupina_hotovo:
                st.write("#### 🟢 Již hotové")
                for karta in skupina_hotovo:
                    vykresli_kartu(*karta, rozbaleno=False)
                    
        else:
            st.info("Na této lokaci není podle systému žádné zboží.")

        if not log_df.empty:
            chyby_df = log_df[log_df['Rozdíl'] != 0].copy()
            if not chyby_df.empty:
                st.write("---")
                st.subheader("⚠️ Zjištěné rozdíly")
                for _, r in chyby_df.iterrows():
                    st.error(f"📦 **{r['Popis']}** (Šarže: {r['Šarže']})\n\n"
                             f"Systém: {r['Systém']:g} ➔ Fyzicky: {r['Fyzicky']:g} **(Rozdíl: {r['Rozdíl']:g} j.)**")

        if os.path.exists(INV_FILE):
            st.write("---")
            with open(INV_FILE, "r", encoding="utf-8-sig") as f_down:
                st.download_button(
                    label="📥 Stáhnout inventuru (CSV)",
                    data=f_down.read(),
                    file_name=f"inventura_{datetime.now().strftime('%Y%m%d')}.csv",
                    mime="text/csv",
                    use_container_width=True
                )

# 3. ZÁLOŽKA: HLÁŠENÍ NESROVNALOSTÍ
with tab_nesrovnalosti:
    st.subheader("⚠️️ Hlášení")
    st.caption("Nesedí stav mimo inventuru? Zapiš to sem.")

    with st.form("form_nesrovnalost", clear_on_submit=True):
        polozka_hledat = st.text_input("Název nebo kód zboží:")
        lokace_zadat = st.selectbox("Kde zboží leží:", list(LOC_MAP.values()) + ["🤝 Komise"])
        sarze_zadat = st.text_input("Číslo šarže:")
        stav_system = st.number_input("Stav v systému (ks/l):", min_value=0.0, step=1.0)
        stav_realita = st.number_input("Fyzicky napočítáno (ks/l):", min_value=0.0, step=1.0)
        poznamka = st.text_area("Poznámka:")

        if st.form_submit_button("💾 Uložit hlášení", use_container_width=True):
            if polozka_hledat:
                uloz_nesrovnalost(
                    "", polozka_hledat, lokace_zadat, sarze_zadat,
                    stav_system, stav_realita, poznamka
                )
                st.success("✅ Nesrovnalost uložena.")
            else:
                st.error("Vyplň název zboží.")

    if os.path.exists(NESROVNALOSTI_FILE):
        st.write("---")
        with open(NESROVNALOSTI_FILE, "r", encoding="utf-8-sig") as f_down:
            st.download_button(
                label="📥 Stáhnout hlášení (CSV)",
                data=f_down.read(),
                file_name="nesrovnalosti_sklad.csv",
                mime="text/csv",
                use_container_width=True
            )

# 4. ZÁLOŽKA: NAHRÁNÍ NOVÉHO EXCELU
with tab_admin:
    st.subheader("🔄 Aktualizace dat")
    st.caption("Nahraj export z Business Central.")
    
    novy_soubor = st.file_uploader("Vyber soubor (.xlsx)", type=["xlsx"])
    if novy_soubor is not None:
        if st.button("🚀 Přepsat data skladu", type="primary", use_container_width=True):
            with open(EXCEL_FILE, "wb") as f:
                f.write(novy_soubor.getbuffer())
            st.cache_data.clear()
            st.success("✅ Aktualizováno!")
            time.sleep(1)
            st.rerun()
