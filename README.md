# 📦 Skladový asistent (Mobilní PWA terminál)

Rychlá, plně klientská JavaScriptová webová aplikace (PWA) pro skladníky, FEFO hlídání expirací a mobilní inventury ve skladech **Boršice**, **Valmez** a komisních skladech.

🌐 **Živá aplikace (GitHub Pages):** `https://lada008.github.io/sklad-app/`

---

## ⚡ Proč se aplikace už nikdy neuspává

Původní verze běžela na Streamlit Community Cloud, který se po nečinnosti uspával a při výpadku signálu ztrácel WebSocket spojení. Nová verze je přepsaná do **čistého JavaScriptu (ES moduly + PWA)** bez závislosti na serveru:

- **Žádné uspávání serveru:** Statická aplikace hostovaná na GitHub Pages CDN reaguje okamžitě 24/7.
- **100% offline provoz (Service Worker):** Po prvním otevření funguje vyhledávání, FEFO, inventura i hlášení nesrovnalostí i v hale bez signálu.
- **Instalace na plochu mobilu (PWA):** Na Androidu i iOS lze přidat na domovskou obrazovku a spouštět na celou obrazovku jako nativní terminál.
- **Režim skladu (Displej nezhasne):** Nativní **Screen Wake Lock API** přímo v hlavním okně (už není omezený sandboxem iframu) + záložní video režim pro starší iOS a automatické obnovení po návratu do aplikace.
- **Lokální ukládání bez ztráty dat:** Inventura, hlášení, vlastní balení i lokálně nahraný Excel se ukládají přímo v zařízení (`localStorage` + `IndexedDB`).

---

## ✨ Hlavní funkce a vylepšení

### 🔍 Okamžité vyhledávání (bez diakritiky)
- Bleskové filtrování při psaní po více slovech najednou (např. `folpan valmez`, `bizon 151bo`, `moridlo`), včetně živého našeptávače a historie posledních hledání.
- Rychlý horní přepínač skladu (**Vše / Boršice / Valmez / Komise**) s počtem produktů a čipy kategorií.
- Skener čárových/QR kódů zadní kamerou (na podporovaných mobilních prohlížečích).
- Přepočet množství na kanystry, krabice, pytle i celé palety + možnost upravit si vlastní balení u každého produktu.
- Přímé akce u každé šarže: **⚠️ Hlásit** (předvyplní formulář nesrovnalosti) a **📋 Inventura**.

### ⏱️ Hlídač expirací & FEFO (Novinka)
- Okamžitý přehled šarží podle pásem: **Expirováno**, **Do 90 dní**, **3–6 měsíců** a **6–12 měsíců**.
- Živý odpočet zbývajících dní a export seznamu do českého CSV.

### 📋 Vylepšená mobilní inventura
- Přepínač **🙈 Slepá inventura / Kontrolní režim** (v kontrolním režimu aktivní jedno-klikové tlačítko **✅ Sedí**).
- **Rychlá kalkulačka balení** (zadej počet kanystrů/pytlů × velikost balení) a tlačítka `−1× / +1× / +4× / +10×` pro snadné zadávání na mobilu.
- Filtry **Zbývá / Hotovo / Rozdíly / Vše**, možnost zrušit chybný záznam a export do CSV (UTF-8 s BOM a středníkem pro bezproblémové otevření v českém Excelu).

### ⚠️ Hlášení nesrovnalostí
- Předvyplnění jedním klepnutím z detailu šarže nebo výběrem ze skladu + rychlé štítky důvodů (*Rozbitý obal*, *Záměna šarže*, *Chybí fyzicky*…).

### 🌿 Automatická denní synchronizace ÚKZÚZ (eAGRI POR) & agronomické filtry
- **Denní plánovač (`.github/workflows/sync-ukzuz.yml`):** Každý den ve **03:05 SEČ** (a kdykoliv ručně přes `workflow_dispatch`) spustí `scripts/update_ukzuz.py`, stáhne aktuální otevřený export registru POR z portálu eAGRI (`https://mze.gov.cz/public/app/eagriapp/por/DataKeStazeni.aspx`), očistí data na **Platné rozhodnutí** a **Do spotřebování zásob** a sloučí listy *Rozhodnutí*, *Údaje*, *Účinné látky*, *Plodiny* a *Dávkování/Použití* do `public/data/por_aktualni.json`.
- **Volitelné nahrání do Firebase Firestore:** Pokud je v GitHub Secrets nastaven `FIREBASE_SERVICE_ACCOUNT_JSON`, skript automaticky uloží data i do Firestore kolekce `ukzuz_registr`.
- **Chytrý panel filtrů pro obchodníka i sklad:**
  - **Rychlé záložky podle plodin (stříkání):** *Vše | Obiloviny | Řepka | Réva vinná | Kukuřice | Brambory/Cukrovka | Sady/Zelenina | Ostatní* + rozklikávací tabulka konkrétních plodin, škodlivých organismů a dávek.
  - **Multiselect účinných látek:** Našeptávač ze všech účinných látek v databázi (nebo kliknutí přímo na účinnou látku na kartě přípravku).
  - **Bezpečnostní přepínače:** `📦 Pouze skladem (> 0 MJ)`, `💧 Povolené v OP II. st. (vody)` (skryje přípravky vyloučené v OP II. st.) a `🐝 Bezpečné pro včely` (skryje `ZNV`, `NV`, `SPe8`).
  - **Výrazné varovné odznaky:** Červený/oranžový štítek `⚠️ OP II.st.` a `🐝 Včely: ZNV / NV / SPe8` přímo v hlavičce každého přípravku.
- **Funkce „🔄 Alternativy skladem“ (náhrady):**
  - Jedním kliknutím vyhledá dostupné položky z aktuálního skladu (`> 0 MJ`) a rozdělí je na **1. Přesná náhrada (stejná účinná látka + porovnání koncentrace)** a **2. Alternativa ze stejné chemické skupiny (stejný mechanismus účinku + stejná plodina)** při plném respektování aktivních filtrů (např. *Povolené v OP II. st.* nebo *Bezpečné pro včely*).
- **Záložní ruční import:** V záložce **Data** zůstává tlačítko **„Nahrát soubor POR ručně“** (podporuje `.xlsx`, `.xml`, `.csv` i `.json`), kdyby ministerstvo v budoucnu změnilo URL exportu.

### ☁️ Synchronizace přes Google Apps Script, Agromanuál, hnojiva a mobilní objednávky
- **Živá synchronizace s Google Tabulkou (`AgroSklad_Databaze`):**
  - Při startu aplikace i po kliknutí na **🔄 Obnovit data** se provede `GET` dotaz na nasazený Google Apps Script Web App (`sklad`, `zakaznici`, `objednavky`, `last_sklad_update`).
  - Všechny `POST` požadavky používají `Content-Type: text/plain;charset=utf-8` a `redirect: "follow"` (bez CORS preflight `OPTIONS` blokace).
  - V záložce **Data** lze URL adresu Google Apps Scriptu i cílový e-mail pro objednávky (`ladislav.penaz@lukrom.cz`) kdykoliv upravit.
- **Okamžité propsání skladu z PC do mobilu (`update_sklad`):**
  - Při nahrání `sklad.xlsx` na PC se sklad automaticky odešle přes `POST` (`{ "action": "update_sklad", "items": [...] }`) do Google Tabulky a aktualizuje `last_sklad_update` v horní liště všem obchodníkům.
- **Agromanuál & poznámky k hnojivům:**
  - U každé skladové položky (včetně hnojiv a položek nespárovaných s ÚKZÚZ) je tlačítko **📘 Otevřít v Agromanuálu**, které otevře vyhledávání očištěného názvu přípravku na `agromanual.cz`.
  - Možnost ručně (přímo na kartě produktu nebo v záložce *Data*) či hromadně z Excelu doplnit **účinné prvky, doporučené tank-mixy a aplikační poznámky** k hnojivům a biostimulantům.
- **Mobilní objednávky (`Objednávky`):**
  - Našeptávač zákazníků z listu `Zakaznici` (podporuje plné sloupce z Business Centralu i zjednodušené tabulky s `Číslo` + `Název` nebo jen `Název`), řazený podle nejvyššího obratu.
  - Po výběru zákazníka zobrazí kontakt, výchozí lokaci a diskrétní oranžové upozornění při `Zůstatek po splatnosti (LCY) > 0`.
  - Výběr termínu doručení (**Do kdy doručit** + rychlá tlačítka `Ihned / Zítra`, `Do 3 dnů`, `Tento týden`), lokace závozu, položek ze skladu s kontrolou volného množství a odeslání objednávky (`action: "new_order"`) do Google Tabulky i na e-mail `ladislav.penaz@lukrom.cz`.
  - Správa stavů objednávek (`Nová`, `Vychystává se`, `Expedováno`, `Storno`) a přiřazení šarže (`action: "update_order_status"`).

### ⚙️ Aktualizace dat z Business Central (`sklad.xlsx`)
Data lze aktualizovat dvěma způsoby:
1. **Přímo v prohlížeči (záložka Data):** Vyber nebo přetáhni čerstvý `sklad.xlsx` — vestavěný streaming parser ho rozbalí, uloží do `IndexedDB` a rovnou synchronizuje do Google Tabulky (`update_sklad`) pro všechny mobilní terminály.
2. **Pro celý tým přes GitHub:** Nahraj nový `sklad.xlsx` do repozitáře (větev `main`). GitHub Action automaticky přegeneruje kompaktní `data/stock.json` (~150 KB místo 4,6 MB) a nasadí novou verzi na GitHub Pages.

---

## 💻 Lokální spuštění a přegenerování dat

```bash
# Přegenerování data/stock.json ze sklad.xlsx (pouze standardní Python 3)
python3 scripts/build-stock-json.py

# Ruční stažení a aktualizace registru ÚKZÚZ → public/data/por_aktualni.json
python3 scripts/update_ukzuz.py

# Lokální webový server pro testování
python3 -m http.server 8080
```

Aplikace pak běží na `http://localhost:8080`.
