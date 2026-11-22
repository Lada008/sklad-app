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

### 🌿 Automatická denní synchronizace ÚKZÚZ (eAGRI POR)
- **Denní plánovač (`.github/workflows/sync-ukzuz.yml`):** Každý den ve **03:05 SEČ** (a kdykoliv ručně přes `workflow_dispatch`) spustí `scripts/update_ukzuz.py`, stáhne aktuální otevřený export registru POR z portálu eAGRI (`https://mze.gov.cz/public/app/eagriapp/por/DataKeStazeni.aspx`), očistí data na **Platné rozhodnutí** a **Do spotřebování zásob** a uloží výstup do `public/data/por_aktualni.json`.
- **Volitelné nahrání do Firebase Firestore:** Pokud je v GitHub Secrets nastaven `FIREBASE_SERVICE_ACCOUNT_JSON`, skript automaticky uloží data i do Firestore kolekce `ukzuz_registr`.
- **Automatické párování se skladem z Business Central:** Aplikace při startu i při nahrání nového `sklad.xlsx` automaticky očistí názvy položek od velikostí balení (`5L`, `20 L`, `10 KG`, `bal.`…) a spáruje je s registrem ÚKZÚZ (zobrazí registrační číslo, platnost / termín spotřeby zásob, účinné látky s koncentrací, chemickou skupinu, PHO i riziko pro včely — a umožní podle nich vyhledávat).
- **Záložní ruční import:** V záložce **Data** zůstává tlačítko **„Nahrát soubor POR ručně“** (podporuje `.xlsx`, `.xml`, `.csv` i `.json`), kdyby ministerstvo v budoucnu změnilo URL exportu.

### ⚙️ Aktualizace dat z Business Central (`sklad.xlsx`)
Data lze aktualizovat dvěma způsoby:
1. **Přímo v prohlížeči (záložka Data):** Vyber nebo přetáhni čerstvý `sklad.xlsx` — vestavěný streaming parser ho rozbalí a uloží do `IndexedDB` za ~1–2 sekundy bez potřeby serveru.
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
