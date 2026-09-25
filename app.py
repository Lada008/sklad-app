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

st.set_page_config(page_title="Skladový asistent", page_icon="📦", layout="centered")

# Bezpečné načtení API klíče (z cloudu nebo výchozí lokální)
API_KEY = st.secrets.get("GEMINI_API_KEY", "AQ.Ab8RN6JmbhByHR5ACrJp3NAIXu3mmONbyWT4hdMt_iVrqr8kmQ")
# Výchozí PIN pro vstup do aplikace
DEFAULT_PIN = st.secrets.get("APP_PIN", "1234")

EXCEL_FILE = "sklad.xlsx"
NESROVNALOSTI_FILE = "nesrovnalosti.csv"

# --- PŘIHLAŠOVACÍ OBRAZOVKA (PIN) ---
if "authenticated" not in st.session_state:
    st.session_state.authenticated = False

if not st.session_state.authenticated:
    st.title("🔒 Vstup do skladu")
    st.write("Zadej přístupový PIN pro otevření aplikace:")
    pin_vstup = st.text_input("Přístupový PIN:", type="password")
    
    if st.button("Vstoupit do aplikace", use_container_width=True):
        if pin_vstup == DEFAULT_PIN:
            st.session_state.authenticated = True
            st.rerun()
        else:
            st.error("❌ Nesprávný PIN. Zkus to znovu.")
    st.stop()

# --- DEFINICE FUNKCÍ A PŘEVODŮ ---
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
    # Pytle 25 kg (40 pytlů = 1 tuna)
    if '25' in popis and 'kg' in popis.lower():
        pytle = qty / 25.0
        if pytle >= 30:
            palet = int(pytle // 40)
            zb_pytle = int(pytle % 40)
            pal_text = sklonuj(palet, 'paleta')
            if zb_pytle == 0:
                return f"🚜 **Palety:** {pal_text} (po 40 pytlích / 1 tuna)"
            return f"🚜 **Palety:** {pal_text} + {sklonuj(zb_pytle, 'pytel')} navrch"
    # Kanystry 5 L (4 ks v krabici, 32 krabic na paletě = 640 L)
    if re.search(r'\b5\s*l\b', popis, re.IGNORECASE):
        kanystru = qty / 5.0
        krabic = kanystru / 4.0
        if krabic >= 20:
            palet = int(krabic // 32)
            zb_krabic = int(krabic % 32)
            pal_text = sklonuj(palet, 'paleta')
            if zb_krabic == 0:
                return f"🚜 **Palety:** {pal_text} (po 32 krabicích / 640 l)"
            return f"🚜 **Palety:** {pal_text} + {sklonuj(zb_krabic, 'krabice')} navrch"
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
    # Filtrace podle vybrané lokace
    if vybrana_lokace == 'Boršice':
        vysledky_df = vysledky_df[vysledky_df['Kód lokace'] == '151BO']
    elif vybrana_lokace == 'Valmez':
        vysledky_df = vysledky_df[vysledky_df['Kód lokace'] == '151VM']
    elif vybrana_lokace == 'Jen Komise':
        vysledky_df = vysledky_df[vysledky_df['Kód lokace'].str.startswith('K.', na=False)]

    if vysledky_df.empty:
        st.warning(f"Pro '{dotaz_popis}' nebyl pro zvolený filtr '{vybrana_lokace}' nalezen žádný zůstatek.")
        return

    # Seskupení pro každý produkt zvlášť (zabraňuje míchání různých přípravků dohromady)
    produkty = vysledky_df.groupby(['Číslo zboží', 'Popis', 'Kategorie_Nazev'], sort=False)
    
    for (kod_zbozi, nazev_zbozi, kategorie), skupina in produkty:
        celkem_ks = skupina['Zůstatek (množství)'].sum()
        baleni_celkem = prepocet_na_baleni(nazev_zbozi, celkem_ks)
        palety_text = paletova_kalkulacka(nazev_zbozi, celkem_ks)

        st.markdown(f"### {nazev_zbozi} `[{kategorie}]`")
        st.caption(f"Kód zboží: `{kod_zbozi}`")
        st.success(f"**Celkem skladem:** {celkem_ks:g} jednotek | **📦 {baleni_celkem}**")
        
        if palety_text:
            st.info(palety_text)

        # FEFO RÁDCE: Kterou šarži naložit dřív pro tento produkt
        valid_exp = skupina[skupina['Datum_Exp_Obj'].notna()].sort_values('Datum_Exp_Obj')
        if not valid_exp.empty:
            fefo_top = valid_exp.iloc[0]
            st.warning(
                f"👉 **DOPORUČENÍ K VÝDEJI (FEFO):** Přednostně vyskladni šarži `{fefo_top['Číslo šarže']}` "
                f"na lokaci **{fefo_top['Lokace_Nazev']}** (nejdřívější expirace: {fefo_top['Datum_Exp_Obj'].strftime('%d.%m.%Y')})!"
            )

        # Tabulka šarží tohoto konkrétního produktu
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
        st.write("---")

# --- HLAVNÍ APLIKACE PO PŘIHLÁŠENÍ ---
if not os.path.exists(EXCEL_FILE):
    st.error(f"Soubor '{EXCEL_FILE}' nebyl nalezen. Nahraj ho prosím v záložce 'Aktualizovat sklad'.")
    stock_df = pd.DataFrame()
else:
    stock_df = load_stock_data(EXCEL_FILE)

st.title("📦 Skladový asistent")

# Přepínač skladů přímo nahoře
vybrana_lokace = st.radio(
    "Filtrovat sklad:",
    ["Všechny sklady", "Boršice", "Valmez", "Jen Komise"],
    horizontal=True
)

tab_foto, tab_rucni, tab_nesrovnalosti, tab_admin = st.tabs([
    "📷 Vyfotit štítek", "🔍 Hledání", "⚠️ Hlášení", "🔄 Aktualizovat sklad"
])

# 1. ZÁLOŽKA: FOCENÍ
with tab_foto:
    uploaded_photo = st.file_uploader(
        "Klepni sem a vyfoť štítek, kanystr nebo krabici", 
        type=["jpg", "jpeg", "png"]
    )

    if uploaded_photo and not stock_df.empty:
        image = Image.open(uploaded_photo)
        st.image(image, caption="Pořízený snímek", use_container_width=True)
        st.info("Analyzuji fotografii pomocí AI...")

        prompt = """
        Prohlédni si tento obrázek chemického nebo zemědělského přípravku / etikety / krabice.
        Najdi:
        1. Obchodní název přípravku (např. RETAFOS, BELKAR, IRAZU, YARAMILA, BIZON, FOLPAN, CARYX).
        2. Kód zboží, pokud je vidět (např. CHE01414).

        Vrať výhradně čistý JSON:
        {"nazev": "SEM_NAZEV", "kod": null}
        """

        # Rychlý model a záložní modely proti chybě 503
        modely_k_vyzkouseni = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash"]
        response = None
        posledni_chyba = None

        client = genai.Client(api_key=API_KEY)

        for model_name in modely_k_vyzkouseni:
            try:
                response = client.models.generate_content(
                    model=model_name,
                    contents=[image, prompt]
                )
                if response and response.text:
                    break
            except Exception as e:
                posledni_chyba = e
                time.sleep(1)
                continue

        if not response or not response.text:
            st.error(f"Chyba při komunikaci s AI: {posledni_chyba}")
        else:
            cisty_text = response.text.strip().replace("```json", "").replace("```", "").strip()
            try:
                data = json.loads(cisty_text)
                hledany_nazev = data.get("nazev", "").strip()
                hledany_kod = data.get("kod")

                st.write(f"🔍 **Rozpoznáno z fotky:** `{hledany_nazev}`")

                mask = stock_df['Popis'].str.contains(hledany_nazev, case=False, na=False)
                if hledany_kod:
                    mask = mask | (stock_df['Číslo zboží'].astype(str) == str(hledany_kod))

                zobraz_vysledky(stock_df[mask], hledany_nazev, vybrana_lokace)
            except Exception as parse_err:
                st.error(f"Nepodařilo se zpracovat odpověď: {cisty_text}")

# 2. ZÁLOŽKA: HLEDÁNÍ A NAŠEPTÁVAČ
with tab_rucni:
    if not stock_df.empty:
        seznam_zbozi = sorted(stock_df['Popis'].dropna().unique().tolist())

        vybrany_produkt = st.selectbox(
            "⚡ Našeptávač (začni psát název přípravku):",
            options=seznam_zbozi,
            index=None,
            placeholder="Napiš pár písmen (např. Folpan, Bizon, Sekator, Caryx)..."
        )

        st.caption("— NEBO hledej podle čísla šarže či kódu —")
        volny_text = st.text_input("Zadej číslo šarže nebo kód zboží:", placeholder="např. 7426507, CHE00912...")

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
            st.info("👆 Vyber přípravek z našeptávače výše nebo zadej šarži do pole.")

# 3. ZÁLOŽKA: HLÁŠENÍ NESROVNALOSTÍ
with tab_nesrovnalosti:
    st.subheader("⚠️ Záznam nesrovnalosti v regálu")
    st.caption("Nesedí stav na skladě s realitou? Zapiš to sem pro vedoucího skladu.")

    with st.form("form_nesrovnalost", clear_on_submit=True):
        polozka_hledat = st.text_input("Název nebo kód zboží:")
        lokace_zadat = st.selectbox("Kde zboží leží:", list(LOC_MAP.values()) + ["🤝 Komise"])
        sarze_zadat = st.text_input("Číslo šarže (pokud je známo):")
        stav_system = st.number_input("Stav v aplikaci / systému (ks/l):", min_value=0.0, step=1.0)
        stav_realita = st.number_input("Fyzicky napočítáno v regálu (ks/l):", min_value=0.0, step=1.0)
        poznamka = st.text_area("Poznámka (např. poškozený kanystr, chybí 2 krabice):")

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
    st.caption("Zde můžeš nahrát nový čerstvý export z Business Central bez nutnosti zasahovat do kódu.")
    
    novy_soubor = st.file_uploader("Nahraj nový soubor skladu (.xlsx)", type=["xlsx"])
    if novy_soubor is not None:
        if st.button("🚀 Přepsat data skladu a aktualizovat", type="primary"):
            with open(EXCEL_FILE, "wb") as f:
                f.write(novy_soubor.getbuffer())
            st.cache_data.clear()
            st.success("✅ Sklad byl úspěšně aktualizován novými daty!")
            st.rerun()
