# 📦 Skladový asistent (Mobilní terminál)

Optimalizovaná aplikace pro skladníky a inventury v prostředí skladů Boršice, Valašské Meziříčí a komisních skladů.

---

## 🚀 Provedené úpravy a vyladění

### 1. Ochrana proti uspávání aplikace (Anti-Sleep & Keep-Alive)
- **Klient / Mobilní zařízení (Screen Wake Lock):**
  - Implementován widget **Režim skladu (Displej nezhasne)** přímo pod hlavičkou.
  - Využívá moderní **Screen Wake Lock API** (`navigator.wakeLock`) i fallback pro iOS Safari / starší Androidy (tichý hardware video stream).
  - Obrazovka mobilu/tabletu ve skladu **nezhasíná**, takže skladník nemusí telefon neustále odemykat.
  - Při návratu do aplikace (po přepnutí do jiné aplikace a zpět) se zámek obrazovky automaticky znovu aktivuje.
  - Každých 25 sekund odesílá tichý heartbeat ping na server, který brání rozpadu WebSocket relace (žádné zasekávání na *"Connecting..."*).
- **Server / Streamlit Community Cloud (GitHub Actions Keep-Alive):**
  - Vylepšen workflow v `.github/workflows/keep-alive.yml`.
  - Pinguje aplikaci každých 12 minut plným `GET` požadavkem s realistickými hlavičkami prohlížeče na kořenovou URL i na `/_stcore/health`.
  - Zahrnuta ochrana proti automatickému uspání GitHub Actions po 60 dnech neaktivity repozitáře.

> 💡 **Tip pro 100% jistotu probuzení Streamlit Cloud:**  
> Pokud chcete absolutní nezávislost na GitHubu, nastavte si zdarma monitor na [cron-job.org](https://cron-job.org/) nebo [UptimeRobot](https://uptimerobot.com/):  
> - **URL:** `https://sklad-asistent.streamlit.app/`  
> - **Interval:** každých 10 minut  
> - **Metoda:** HTTP GET  

---

### 2. Vyladění výkonu a vyhledávání
- **Rychlé multi-token vyhledávání:**
  - Vytvořen předpočítaný index spojující název, kód zboží, šarži i lokaci.
  - Vyhledávat lze více slovy najednou (např. `Folpan Valmez`, `Bizon 151BO`, `kanystr 5l`).
- **Disková a paměťová mezipaměť (Disk Caching):**
  - Data z 4.6MB Excelu se ukládají pomocí `@st.cache_data(persist="disk")`. Po probuzení serveru nebo restartu je načtení bleskové (desetiny sekundy místo několika sekund).
  - Našeptávač zboží je cachovaný zvlášť, což eliminuje zasekávání při psaní na mobilu.
- **Ochrana paměti mobilních telefonů:**
  - Omezeno vykreslování na maximálně 35 karet najednou s informací pro uživatele, aby slabší telefony nezamrzaly při zobrazení stovek produktů.

---

### 3. Vyladění mobilní inventury
- **Rychlé filtry:**
  - `🟠 Zbývá spočítat` — skladník vidí pouze položky, které ještě nezpracoval.
  - `🟢 Již hotovo` — přehled hotových položek.
  - `📋 Všechny položky`.
- **Tlačítko „✅ Sedí“:**
  - Pokud se fyzický stav shoduje se stavem v systému, stačí jedno kliknutí a stav je okamžitě uložen.
- **Okamžitá odezva (Toasty):**
  - Nahrazeno umělé čekání `time.sleep(0.8)` za moderní notifikaci `st.toast`, takže zadávání inventury je plynulé a svižné.

---

### 4. Vylepšené FEFO a expirace
- Pokud je šarže již po expiraci, aplikace zobrazí zřetelné červené varování **⚠️ POZOR — EXPIROVÁNO (před X dny)**.
- Při platné expiraci ukazuje přesný počet zbývajících dní a doporučenou šarži k výdeji (FEFO).

---

## 💻 Spuštění lokálně

```bash
pip install -r requirements.txt
streamlit run app.py
```
Aplikace běží na `http://localhost:8501`.
