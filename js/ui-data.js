/**
 * Záložka: Data skladu, Google Apps Script synchronizace, Zákazníci, Poznámky k hnojivům,
 * Registr ÚKZÚZ (automatická denní synchronizace + záložní ruční nahrání POR),
 * správa vlastních balení, záloha/obnova, PWA instalace a bezpečný reset.
 */

import {
  escapeHtml,
  formatQty,
  getCzechFileTimestamp,
  normalizeText,
  triggerFileDownload,
} from './domain.js';
import {
  DEFAULT_GAS_URL,
  DEFAULT_NOTIFY_EMAIL,
  gasUpdateSklad,
  gasUpdateZakaznici,
  parseGenericTableFile,
} from './gas-api.js';
import {
  clearInventoryRecords,
  clearLocalPorData,
  clearLocalStockData,
  clearReports,
  exportFullBackup,
  importFullBackup,
  saveCustomPacks,
  saveFertilizerNotes,
  saveLocalPorData,
  saveLocalStockData,
} from './storage.js';
import { parseManualPorFile } from './ukzuz.js';
import { parseBusinessCentralXlsx } from './xlsx-parser.js';

export function createDataTab(ctx) {
  let deferredInstallPrompt = null;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    renderPwaCard();
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    renderPwaCard();
    ctx.toast('Aplikace byla nainstalována na plochu', 'success');
  });

  const panel = document.getElementById('tab-data');

  panel.innerHTML = `
    <div class="section-header">
      <div>
        <h2 class="section-title">Data skladu, Google Tabulka &amp; správa</h2>
        <p class="section-sub">Kompletní synchronizace skladu, zákazníků a objednávek mezi PC, mobilem a e-mailem.</p>
      </div>
      <button type="button" id="gas-sync-now-btn" class="btn btn-primary btn-sm">🔄 Obnovit data</button>
    </div>

    <!-- 1. Konfigurace připojení ke Google Apps Scriptu -->
    <div class="card" id="gas-config-card"></div>

    <!-- 2. Přehled aktuálního skladu -->
    <div class="card" style="margin-top: 12px;" id="data-status-card"></div>

    <!-- 3. Nahrání sklad.xlsx s automatickým odesláním do Google Tabulky (update_sklad) -->
    <div class="card" style="margin-top: 12px;">
      <h3 class="section-title" style="margin-bottom: 4px;">🔄 Nahrát nový Excel skladu (Business Central)</h3>
      <p class="section-sub" style="margin-bottom: 12px;">
        Položky se očistí od velikostí balení, spárují s ÚKZÚZ a okamžitě odešlou do Google Tabulky (<code>update_sklad</code>), aby se nový stav skladu ihned propsal všem obchodníkům do mobilu.
      </p>

      <div id="xlsx-dropzone" class="dropzone" tabindex="0" role="button" aria-label="Vybrat soubor sklad.xlsx">
        <div class="dropzone-icon">📊</div>
        <div class="dropzone-title">Klikni nebo přetáhni soubor .xlsx</div>
        <div class="dropzone-sub">Export „Položky zboží“ z Business Central (např. sklad.xlsx)</div>
        <input type="file" id="xlsx-file-input" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden />
      </div>

      <div id="xlsx-progress" class="upload-progress" hidden>
        <div style="display:flex;justify-content:space-between;font-size:0.82rem;font-weight:700;color:var(--brand-900);">
          <span id="xlsx-progress-text">Připravuji…</span>
          <span id="xlsx-progress-pct" class="mono">0 %</span>
        </div>
        <div class="progress-track" style="margin: 8px 0 0;">
          <div id="xlsx-progress-bar" class="progress-fill" style="width: 0%;"></div>
        </div>
      </div>

      <div id="xlsx-sync-result" hidden style="margin-top:10px;"></div>
      <div id="xlsx-extra-actions" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;"></div>
    </div>

    <!-- 4. Hromadné nahrání zákazníků z Excelu do Google Tabulky (update_zakaznici) -->
    <div class="card" style="margin-top: 12px;" id="customers-sync-card"></div>

    <!-- 5. Hnojiva a biostimulanty — vlastní poznámky, účinné prvky a tank-mixy -->
    <div class="card" style="margin-top: 12px;" id="fertilizer-notes-card"></div>

    <!-- 6. Registr ÚKZÚZ (eAGRI POR) -->
    <div class="card" style="margin-top: 12px;" id="ukzuz-status-card"></div>

    <!-- 7. Vlastní nastavení balení -->
    <div class="card" style="margin-top: 12px;" id="custom-packs-card"></div>

    <!-- 8. Přenos a záloha dat -->
    <div class="card" style="margin-top: 12px;">
      <h3 class="section-title" style="margin-bottom: 4px;">💾 Přenos a záloha dat</h3>
      <p class="section-sub" style="margin-bottom: 12px;">Zálohuj nebo přenes inventuru, hlášení, poznámky k hnojivům a vlastní balení.</p>
      <div class="form-grid-2">
        <button type="button" id="backup-export-btn" class="btn">📤 Exportovat zálohu (JSON)</button>
        <button type="button" id="backup-import-btn" class="btn">📥 Obnovit ze zálohy</button>
      </div>
      <input type="file" id="backup-import-input" accept="application/json,.json" hidden />
    </div>

    <div class="card" style="margin-top: 12px;" id="pwa-install-card"></div>

    <div class="card danger-zone" style="margin-top: 12px;">
      <h3 class="section-title" style="color: var(--danger-dark); margin-bottom: 4px;">🗑️ Reset inventury a hlášení</h3>
      <p class="section-sub">Před vymazáním si prosím stáhni výsledky do CSV.</p>

      <label class="checkbox-row">
        <input type="checkbox" id="reset-confirm-check" />
        <span>Potvrzuji, že chci smazat napočítaná data v tomto zařízení.</span>
      </label>

      <div class="form-grid-2">
        <button type="button" id="reset-inv-btn" class="btn btn-soft-danger" disabled>🗑️ Vynulovat inventuru</button>
        <button type="button" id="reset-rep-btn" class="btn btn-soft-danger" disabled>🗑️ Smazat hlášení</button>
      </div>
    </div>
  `;

  const gasSyncNowBtn = document.getElementById('gas-sync-now-btn');
  const gasConfigCard = document.getElementById('gas-config-card');
  const statusCard = document.getElementById('data-status-card');
  const dropzone = document.getElementById('xlsx-dropzone');
  const fileInput = document.getElementById('xlsx-file-input');
  const progressBox = document.getElementById('xlsx-progress');
  const progressText = document.getElementById('xlsx-progress-text');
  const progressPct = document.getElementById('xlsx-progress-pct');
  const progressBar = document.getElementById('xlsx-progress-bar');
  const syncResultBox = document.getElementById('xlsx-sync-result');
  const extraActionsEl = document.getElementById('xlsx-extra-actions');
  const customersCard = document.getElementById('customers-sync-card');
  const fertNotesCard = document.getElementById('fertilizer-notes-card');
  const ukzuzCard = document.getElementById('ukzuz-status-card');
  const customPacksCard = document.getElementById('custom-packs-card');
  const pwaCard = document.getElementById('pwa-install-card');
  const backupExportBtn = document.getElementById('backup-export-btn');
  const backupImportBtn = document.getElementById('backup-import-btn');
  const backupImportInput = document.getElementById('backup-import-input');
  const resetConfirm = document.getElementById('reset-confirm-check');
  const resetInvBtn = document.getElementById('reset-inv-btn');
  const resetRepBtn = document.getElementById('reset-rep-btn');

  // --- Tlačítko Obnovit data z Google Tabulky ---
  gasSyncNowBtn.addEventListener('click', async () => {
    gasSyncNowBtn.disabled = true;
    const orig = gasSyncNowBtn.innerHTML;
    gasSyncNowBtn.innerHTML = `<span class="btn-spinner"></span> Synchronizuji…`;
    await ctx.syncFromGas({ silent: false });
    gasSyncNowBtn.disabled = false;
    gasSyncNowBtn.innerHTML = orig;
  });

  // --- Konfigurace GAS URL a cílového e-mailu ---
  gasConfigCard.addEventListener('submit', async (e) => {
    if (e.target.id !== 'gas-config-form') return;
    e.preventDefault();
    const gasUrl = document.getElementById('cfg-gas-url').value.trim() || DEFAULT_GAS_URL;
    const notifyEmail = document.getElementById('cfg-notify-email').value.trim() || DEFAULT_NOTIFY_EMAIL;
    ctx.setPrefs({ gasUrl, notifyEmail });
    ctx.toast('✅ Nastavení Google Apps Scriptu a e-mailu uloženo', 'success');
    await ctx.syncFromGas({ silent: false });
  });

  gasConfigCard.addEventListener('click', (e) => {
    if (e.target.closest('#cfg-reset-defaults-btn')) {
      ctx.setPrefs({ gasUrl: DEFAULT_GAS_URL, notifyEmail: DEFAULT_NOTIFY_EMAIL });
      renderGasConfigCard();
      ctx.toast('Obnovena výchozí URL a e-mail', 'success');
    }
  });

  // --- Upload Excelu skladu z Business Central + POST update_sklad do Google Tabulky ---
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('is-dragover');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-dragover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('is-dragover');
    const file = e.dataTransfer?.files?.[0];
    if (file) handleXlsxFile(file);
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) handleXlsxFile(file);
    fileInput.value = '';
  });

  async function handleXlsxFile(file) {
    if (!file.name.toLowerCase().endsWith('.xlsx')) {
      ctx.toast('Vyber prosím soubor ve formátu .xlsx', 'danger');
      return;
    }

    syncResultBox.hidden = true;
    progressBox.hidden = false;
    progressBar.style.width = '3%';
    progressPct.textContent = '3 %';
    progressText.textContent = `Načítám ${file.name}…`;

    try {
      const arrayBuffer = await file.arrayBuffer();
      const parsed = await parseBusinessCentralXlsx(arrayBuffer, file.name, (pct, msg) => {
        const scaled = Math.min(80, Math.round(pct * 0.8));
        progressBar.style.width = `${scaled}%`;
        progressPct.textContent = `${scaled} %`;
        progressText.textContent = msg;
      });

      progressBar.style.width = '88%';
      progressPct.textContent = '88 %';
      progressText.textContent = `Odesílám ${parsed.items.length} sloučených položek do cloudu (update_sklad)…`;

      let gasUpdatedTime = parsed.meta.updatedAt;
      let gasSyncedOk = false;
      let gasErrMsg = '';

      try {
        const resp = await gasUpdateSklad(parsed.items, ctx.state.prefs.gasUrl);
        gasUpdatedTime = resp.last_sklad_update || gasUpdatedTime;
        parsed.meta.updatedAt = gasUpdatedTime;
        parsed.meta.syncedToGas = true;
        gasSyncedOk = true;
        ctx.state.gasConnected = true;
        ctx.state.lastSkladUpdate = gasUpdatedTime;
      } catch (gasErr) {
        gasErrMsg = gasErr?.message || String(gasErr);
      }

      progressBar.style.width = '100%';
      progressPct.textContent = '100 %';
      progressText.textContent = gasSyncedOk
        ? `Sklad odeslán do cloudu (${parsed.items.length} položek)`
        : 'Odeslání do cloudu selhalo';

      await saveLocalStockData(parsed);
      ctx.applyStockDataset(parsed);

      const { matchedProducts, totalProducts } = getMatchedProductStats();
      syncResultBox.hidden = false;
      if (gasSyncedOk) {
        syncResultBox.innerHTML = `
          <div class="callout" style="background:var(--brand-50);border:1px solid var(--brand-600);color:var(--brand-950);margin:0;">
            <span class="callout-icon">✅</span>
            <div>
              <strong>Sklad odeslán do cloudu (${parsed.items.length} položek)</strong><br>
              Zpracováno z ${parsed.meta.ledgerRows?.toLocaleString('cs-CZ') || '—'} pohybů v BC (pouze <code>Otevřeno == 1</code> a <code>Zůstatek &gt; 0</code>). Čas aktualizace: <strong>${escapeHtml(gasUpdatedTime)}</strong> · Spárováno s ÚKZÚZ: <strong>${matchedProducts}/${totalProducts}</strong> produktů.
            </div>
          </div>
        `;
        ctx.toast(`✅ Sklad odeslán do cloudu (${parsed.items.length} položek)`, 'success');
      } else {
        syncResultBox.innerHTML = `
          <div class="callout callout-expired" style="margin:0;">
            <span class="callout-icon">❌</span>
            <div>
              <strong>Odeslání skladu do cloudu selhalo:</strong> ${escapeHtml(gasErrMsg)}<br>
              Data jsou zatím uložena jen lokálně v tomto prohlížeči (${parsed.items.length} položek). Zkontroluj připojení nebo URL Google Apps Scriptu a klikni na „Odeslat aktuální sklad do cloudu“.
            </div>
          </div>
        `;
        ctx.toast(`❌ Chyba odeslání skladu do cloudu: ${gasErrMsg}`, 'danger');
      }

      setTimeout(() => {
        progressBox.hidden = true;
      }, 1000);
    } catch (err) {
      progressBox.hidden = true;
      ctx.toast(`❌ Chyba Excelu: ${err.message || err}`, 'danger');
    }
  }

  extraActionsEl.addEventListener('click', async (e) => {
    const pushBtn = e.target.closest('#push-stock-to-gas-btn');
    if (pushBtn) {
      pushBtn.disabled = true;
      const orig = pushBtn.innerHTML;
      pushBtn.innerHTML = `<span class="btn-spinner"></span> Odesílám do cloudu…`;
      try {
        const resp = await gasUpdateSklad(ctx.state.rawItems, ctx.state.prefs.gasUrl);
        if (resp.last_sklad_update) {
          ctx.state.lastSkladUpdate = resp.last_sklad_update;
          if (ctx.state.meta) ctx.state.meta.updatedAt = resp.last_sklad_update;
        }
        ctx.state.gasConnected = true;
        ctx.refreshAllViews();
        syncResultBox.hidden = false;
        syncResultBox.innerHTML = `
          <div class="callout" style="background:var(--brand-50);border:1px solid var(--brand-600);color:var(--brand-950);margin:0;">
            <span class="callout-icon">✅</span>
            <div><strong>Sklad odeslán do cloudu (${ctx.state.rawItems.length} položek)</strong></div>
          </div>
        `;
        ctx.toast(`✅ Sklad odeslán do cloudu (${ctx.state.rawItems.length} položek)`, 'success');
      } catch (err) {
        const msg = err?.message || String(err);
        syncResultBox.hidden = false;
        syncResultBox.innerHTML = `
          <div class="callout callout-expired" style="margin:0;">
            <span class="callout-icon">❌</span>
            <div><strong>Odeslání skladu do cloudu selhalo:</strong> ${escapeHtml(msg)}</div>
          </div>
        `;
        ctx.toast(`❌ Chyba odeslání skladu do cloudu: ${msg}`, 'danger');
      } finally {
        pushBtn.disabled = false;
        pushBtn.innerHTML = orig;
      }
      return;
    }

    if (e.target.closest('#revert-default-stock-btn')) {
      await clearLocalStockData();
      await ctx.syncFromGas({ silent: false });
      return;
    }
    if (e.target.closest('#export-stock-json-btn')) {
      const payload = {
        meta: ctx.state.meta,
        items: ctx.state.rawItems,
      };
      triggerFileDownload(
        JSON.stringify(payload),
        'stock.json',
        'application/json;charset=utf-8;'
      );
      ctx.toast('Soubor stock.json byl stažen', 'success');
    }
  });

  // --- Hromadné nahrání zákazníků z Excelu do Google Tabulky (update_zakaznici) ---
  customersCard.addEventListener('click', (e) => {
    if (e.target.closest('#cust-upload-btn')) {
      document.getElementById('cust-file-input')?.click();
    }
  });

  customersCard.addEventListener('change', async (e) => {
    if (e.target.id !== 'cust-file-input') return;
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    const btn = document.getElementById('cust-upload-btn');
    const statusBox = document.getElementById('cust-upload-status');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<span class="btn-spinner"></span> Načítám a odesílám zákazníky…`;
    }

    try {
      const rows = await parseGenericTableFile(file);
      if (!rows.length) {
        throw new Error('Soubor neobsahuje žádné řádky zákazníků.');
      }
      await gasUpdateZakaznici(rows, ctx.state.prefs.gasUrl);
      await ctx.syncFromGas({ silent: true });
      if (statusBox) {
        statusBox.hidden = false;
        statusBox.innerHTML = `
          <div class="callout" style="background:var(--brand-50);border:1px solid var(--brand-600);color:var(--brand-950);margin-top:10px;">
            <span class="callout-icon">✅</span>
            <div><strong>Nahráno ${rows.length.toLocaleString('cs-CZ')} zákazníků do listu Zakaznici!</strong></div>
          </div>
        `;
      }
      ctx.toast(`✅ Nahráno ${rows.length.toLocaleString('cs-CZ')} zákazníků do Google Tabulky`, 'success');
    } catch (err) {
      ctx.toast(`❌ Chyba nahrávání zákazníků: ${err.message}`, 'danger');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '📂 Nahrát zákazníky z Excelu (.xlsx / .csv)';
      }
    }
  });

  // --- Hnojiva a biostimulanty: ruční přidání i hromadný import z Excelu ---
  fertNotesCard.addEventListener('click', (e) => {
    const delBtn = e.target.closest('[data-del-fert]');
    if (delBtn) {
      ctx.deleteFertilizerNote(delBtn.dataset.delFert);
      ctx.toast('Poznámka k hnojivu byla smazána', 'warn');
      return;
    }
    if (e.target.closest('#fert-import-xlsx-btn')) {
      document.getElementById('fert-import-xlsx-input')?.click();
      return;
    }
    if (e.target.closest('#fert-export-json-btn')) {
      triggerFileDownload(
        JSON.stringify(ctx.state.fertilizerNotes, null, 2),
        'poznamky_hnojiva.json',
        'application/json;charset=utf-8;'
      );
      ctx.toast('Poznámky k hnojivům exportovány', 'success');
    }
  });

  fertNotesCard.addEventListener('submit', (e) => {
    if (e.target.id !== 'fert-manual-add-form') return;
    e.preventDefault();
    const targetKey = document.getElementById('fert-add-target').value.trim();
    const elements = document.getElementById('fert-add-elements').value.trim();
    const tankmix = document.getElementById('fert-add-tankmix').value.trim();
    const note = document.getElementById('fert-add-note').value.trim();
    if (!targetKey) {
      ctx.toast('Vyber nebo zadej název / kód hnojiva.', 'danger');
      return;
    }
    const found = ctx.state.items.find((i) => i.n === targetKey || i.c === targetKey);
    const key = found ? found.c : targetKey;
    const name = found ? found.n : targetKey;
    ctx.setFertilizerNote(key, { name, elements, tankmix, note });
    e.target.reset();
    ctx.toast(`🌱 Uložena poznámka pro ${name}`, 'success');
  });

  fertNotesCard.addEventListener('change', async (e) => {
    if (e.target.id !== 'fert-import-xlsx-input') return;
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    try {
      if (file.name.toLowerCase().endsWith('.json')) {
        const parsed = JSON.parse(await file.text());
        ctx.state.fertilizerNotes = { ...ctx.state.fertilizerNotes, ...parsed };
        saveFertilizerNotes(ctx.state.fertilizerNotes);
        ctx.rebuildStockEnrichment();
        ctx.toast('✅ Poznámky k hnojivům naimportovány z JSON', 'success');
        return;
      }

      const rows = await parseGenericTableFile(file);
      let imported = 0;
      const nextNotes = { ...ctx.state.fertilizerNotes };

      for (const r of rows) {
        const norm = Object.create(null);
        for (const [k, v] of Object.entries(r)) norm[normalizeText(k)] = String(v).trim();
        const codeOrName =
          norm['cislo zbozi'] ||
          norm['kod'] ||
          norm['cislo'] ||
          norm['nazev'] ||
          norm['popis'] ||
          norm['pripravek'] ||
          norm['hnojivo'] ||
          Object.values(r)[0] ||
          '';
        if (!codeOrName) continue;

        const name = norm['nazev'] || norm['popis'] || norm['hnojivo'] || codeOrName;
        const elements =
          norm['ucinne prvky'] ||
          norm['prvky'] ||
          norm['ziviny'] ||
          norm['slozeni'] ||
          norm['obsah'] ||
          '';
        const tankmix =
          norm['tank-mix'] ||
          norm['tankmix'] ||
          norm['doporucene tank-mixy'] ||
          norm['michatelnost'] ||
          '';
        const note =
          norm['poznamka'] ||
          norm['poznamky'] ||
          norm['popis pouziti'] ||
          norm['davkovani'] ||
          '';

        if (!elements && !tankmix && !note) continue;
        nextNotes[codeOrName] = { name, elements, tankmix, note };
        imported++;
      }

      ctx.state.fertilizerNotes = nextNotes;
      saveFertilizerNotes(nextNotes);
      ctx.rebuildStockEnrichment();
      ctx.toast(`✅ Naimportováno ${imported} poznámek k hnojivům z Excelu`, 'success');
    } catch (err) {
      ctx.toast(`❌ Chyba importu hnojiv: ${err.message}`, 'danger');
    }
  });

  // --- Registr ÚKZÚZ: záložní ruční nahrání POR souboru ---
  ukzuzCard.addEventListener('click', async (e) => {
    if (e.target.closest('#por-manual-upload-btn')) {
      document.getElementById('por-manual-file-input')?.click();
      return;
    }
    if (e.target.closest('#por-revert-auto-btn')) {
      await clearLocalPorData();
      await ctx.reloadDefaultPor();
      ctx.toast('Obnoven automaticky synchronizovaný registr ÚKZÚZ', 'success');
      return;
    }
    if (e.target.closest('#por-refresh-btn')) {
      await ctx.reloadDefaultPor();
      ctx.toast('Registr ÚKZÚZ znovu načten ze serveru', 'success');
    }
  });

  ukzuzCard.addEventListener('change', async (e) => {
    if (e.target.id !== 'por-manual-file-input') return;
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    const box = document.getElementById('por-upload-progress');
    const txt = document.getElementById('por-progress-text');
    const pctEl = document.getElementById('por-progress-pct');
    const bar = document.getElementById('por-progress-bar');

    if (box) box.hidden = false;
    try {
      const parsed = await parseManualPorFile(file, (pct, msg) => {
        if (bar) bar.style.width = `${pct}%`;
        if (pctEl) pctEl.textContent = `${pct} %`;
        if (txt) txt.textContent = msg;
      });
      await saveLocalPorData(parsed);
      ctx.applyPorDataset(parsed);
      ctx.toast(
        `🌿 Nahrán registr POR (${parsed.meta.totalProducts} přípravků)`,
        'success'
      );
    } catch (err) {
      if (box) box.hidden = true;
      ctx.toast(`❌ Chyba souboru POR: ${err.message || err}`, 'danger');
    }
  });

  // --- Vlastní balení ---
  customPacksCard.addEventListener('click', (e) => {
    const delBtn = e.target.closest('[data-del-pack]');
    if (delBtn) {
      ctx.deleteCustomPack(delBtn.dataset.delPack);
      ctx.toast('Vlastní balení odstraněno', 'warn');
      return;
    }
    if (e.target.closest('#export-packs-btn')) {
      triggerFileDownload(
        JSON.stringify(ctx.state.customPacks, null, 2),
        'vlastni_baleni.json',
        'application/json;charset=utf-8;'
      );
      ctx.toast('Nastavení balení staženo', 'success');
      return;
    }
    if (e.target.closest('#import-packs-btn')) {
      document.getElementById('import-packs-input')?.click();
    }
  });

  customPacksCard.addEventListener('change', async (e) => {
    if (e.target.id !== 'import-packs-input') return;
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Neplatný JSON formát');
      }
      const merged = { ...ctx.state.customPacks, ...parsed };
      ctx.state.customPacks = merged;
      saveCustomPacks(merged);
      ctx.refreshAllViews();
      ctx.toast('Vlastní balení bylo naimportováno', 'success');
    } catch (err) {
      ctx.toast(`Chyba importu: ${err.message}`, 'danger');
    }
    e.target.value = '';
  });

  // --- Záloha / Obnova ---
  backupExportBtn.addEventListener('click', () => {
    const backup = exportFullBackup();
    triggerFileDownload(
      JSON.stringify(backup, null, 2),
      `sklad_zaloha_${getCzechFileTimestamp()}.json`,
      'application/json;charset=utf-8;'
    );
    ctx.toast('Kompletní záloha stažena', 'success');
  });

  backupImportBtn.addEventListener('click', () => backupImportInput.click());
  backupImportInput.addEventListener('change', async () => {
    const file = backupImportInput.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      importFullBackup(data);
      ctx.reloadLocalState();
      ctx.toast('✅ Data byla úspěšně obnovena ze zálohy', 'success');
    } catch (err) {
      ctx.toast(`Chyba obnovy: ${err.message}`, 'danger');
    }
    backupImportInput.value = '';
  });

  // --- Reset ---
  resetConfirm.addEventListener('change', () => {
    const ok = resetConfirm.checked;
    resetInvBtn.disabled = !ok;
    resetRepBtn.disabled = !ok;
  });

  resetInvBtn.addEventListener('click', () => {
    clearInventoryRecords();
    ctx.state.inventory = {};
    resetConfirm.checked = false;
    resetInvBtn.disabled = true;
    resetRepBtn.disabled = true;
    ctx.refreshAllViews();
    ctx.toast('Inventura byla vynulována', 'warn');
  });

  resetRepBtn.addEventListener('click', () => {
    clearReports();
    ctx.state.reports = [];
    resetConfirm.checked = false;
    resetInvBtn.disabled = true;
    resetRepBtn.disabled = true;
    ctx.refreshAllViews();
    ctx.toast('Hlášení byla smazána', 'warn');
  });

  pwaCard.addEventListener('click', async (e) => {
    if (e.target.closest('#pwa-install-btn') && deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      renderPwaCard();
    }
  });

  function getMatchedProductStats() {
    const seen = new Map();
    for (const item of ctx.state.items) {
      if (!seen.has(item.c)) seen.set(item.c, Boolean(item._por));
    }
    let matchedProducts = 0;
    for (const isMatched of seen.values()) {
      if (isMatched) matchedProducts++;
    }
    return { matchedProducts, totalProducts: seen.size };
  }

  function renderGasConfigCard() {
    const gasUrl = ctx.state.prefs.gasUrl || DEFAULT_GAS_URL;
    const notifyEmail = ctx.state.prefs.notifyEmail || DEFAULT_NOTIFY_EMAIL;
    const isConnected = Boolean(ctx.state.gasConnected);

    gasConfigCard.innerHTML = `
      <div class="section-header" style="margin-bottom: 10px;">
        <div>
          <h3 class="section-title">☁️ Připojení ke Google Apps Script &amp; E-mailu</h3>
          <p class="section-sub">Sdílená databáze skladu, zákazníků a objednávek v Google Tabulce.</p>
        </div>
        <span class="exp-pill ${isConnected ? 'is-ok' : 'is-warning'}">
          ${isConnected ? '🟢 Připojeno k Google Tabulce' : '🟠 Offline / lokální mezipaměť'}
        </span>
      </div>

      <form id="gas-config-form" class="form-stack">
        <div class="field">
          <label for="cfg-gas-url">URL adresa nasazeného Google Apps Scriptu (Web App /exec)</label>
          <input id="cfg-gas-url" class="input mono" style="font-size:0.78rem;" type="url" value="${escapeHtml(gasUrl)}" required />
        </div>
        <div class="field">
          <label for="cfg-notify-email">Cílový e-mail pro odesílání nových objednávek</label>
          <input id="cfg-notify-email" class="input" type="email" value="${escapeHtml(notifyEmail)}" required />
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button type="submit" class="btn btn-primary btn-sm">💾 Uložit a synchronizovat</button>
          <button type="button" id="cfg-reset-defaults-btn" class="btn btn-sm">↩ Obnovit výchozí URL a e-mail</button>
        </div>
      </form>
    `;
  }

  function renderStatusCard() {
    const m = ctx.state.meta || {};
    const productCount = new Set(ctx.state.items.map((i) => i.c)).size;
    const batchCount = ctx.state.items.length;
    const updatedAt = ctx.state.lastSkladUpdate || m.updatedAt || '—';

    statusCard.innerHTML = `
      <div class="section-header" style="margin-bottom: 10px;">
        <h3 class="section-title">📊 Aktuální skladová data</h3>
        <span class="exp-pill is-ok">Google Tabulka (Sklad)</span>
      </div>
      <div class="inv-kpi-row">
        <div class="inv-kpi">
          <div class="inv-kpi-val">${productCount}</div>
          <div class="inv-kpi-lbl">Produktů</div>
        </div>
        <div class="inv-kpi">
          <div class="inv-kpi-val">${batchCount}</div>
          <div class="inv-kpi-lbl">Akt. šarží</div>
        </div>
        <div class="inv-kpi">
          <div class="inv-kpi-val">${(ctx.state.customers || []).length.toLocaleString('cs-CZ')}</div>
          <div class="inv-kpi-lbl">Zákazníků</div>
        </div>
        <div class="inv-kpi">
          <div class="inv-kpi-val">${(ctx.state.orders || []).length}</div>
          <div class="inv-kpi-lbl">Objednávek</div>
        </div>
      </div>
      <div style="margin-top: 10px; font-size: 0.82rem; color: var(--ink-muted);">
        Poslední aktualizace skladu (<code>last_sklad_update</code>): <strong style="color: var(--ink);">${escapeHtml(updatedAt)}</strong>
      </div>
    `;

    extraActionsEl.innerHTML = `
      <button type="button" id="push-stock-to-gas-btn" class="btn btn-sm">☁️ Odeslat aktuální sklad do Google Tabulky</button>
      <button type="button" id="export-stock-json-btn" class="btn btn-sm">📥 Stáhnout kompaktní stock.json</button>
    `;
  }

  function renderCustomersCard() {
    const custs = ctx.state.customers || [];
    const withOverdue = custs.filter((c) => c.poSplatnosti > 0).length;

    customersCard.innerHTML = `
      <div class="section-header" style="margin-bottom: 8px;">
        <div>
          <h3 class="section-title">🏢 Zákazníci (list Zakaznici)</h3>
          <p class="section-sub">Načteno <strong>${custs.length.toLocaleString('cs-CZ')}</strong> odběratelů z Google Tabulky${withOverdue > 0 ? ` (${withOverdue} se zůstatkem po splatnosti)` : ''}.</p>
        </div>
      </div>
      <p class="section-sub" style="margin-bottom: 10px;">
        Volitelně můžeš hromadně nahrát nový seznam zákazníků z Business Central (<code>.xlsx</code> nebo <code>.csv</code> se sloupci <em>Číslo, Název, IČ, DIČ, Telefonní číslo, Kontakt, Kód lokace, Zůstatek po splatnosti (LCY)</em> nebo jen <em>Číslo a Název</em>).
      </p>
      <button type="button" id="cust-upload-btn" class="btn btn-sm">📂 Nahrát zákazníky z Excelu (.xlsx / .csv)</button>
      <input type="file" id="cust-file-input" accept=".xlsx,.csv" hidden />
      <div id="cust-upload-status" hidden></div>
    `;
  }

  function renderFertilizerNotesCard() {
    const entries = Object.entries(ctx.state.fertilizerNotes || {});

    const listHtml = entries.length
      ? `<div style="margin-top:10px;max-height:220px;overflow-y:auto;">
           ${entries
             .map(
               ([key, info]) => `
             <div class="pack-rule-row">
               <div>
                 <div style="font-weight:700;font-size:0.86rem;">${escapeHtml(info.name || key)} <span class="mono" style="font-size:0.75rem;color:var(--ink-muted);">(${escapeHtml(key)})</span></div>
                 <div style="font-size:0.76rem;color:var(--ink-secondary);">
                   ${info.elements ? `<strong>Živiny:</strong> ${escapeHtml(info.elements)} · ` : ''}
                   ${info.tankmix ? `<strong>Tank-mix:</strong> ${escapeHtml(info.tankmix)} · ` : ''}
                   ${info.note ? escapeHtml(info.note) : ''}
                 </div>
               </div>
               <button type="button" class="btn btn-soft-danger btn-sm" data-del-fert="${escapeHtml(key)}">Smazat</button>
             </div>
           `
             )
             .join('')}
         </div>`
      : '<p class="section-sub" style="margin-top:8px;">Zatím nejsou uloženy žádné vlastní poznámky k hnojivům. Můžeš je doplnit přímo na kartě produktu v katalogu, formulářem níže nebo hromadným importem z Excelu.</p>';

    fertNotesCard.innerHTML = `
      <div class="section-header" style="margin-bottom: 8px;">
        <div>
          <h3 class="section-title">🌱 Hnojiva a biostimulanty — poznámky, prvky &amp; tank-mixy (${entries.length})</h3>
          <p class="section-sub">Ruční doplnění nebo hromadný import z Excelu (.xlsx / .csv se sloupci Název/Kód, Účinné prvky, Tank-mix, Poznámka).</p>
        </div>
        <div style="display:flex;gap:6px;">
          <button type="button" id="fert-import-xlsx-btn" class="btn btn-sm">📂 Import z Excelu / CSV</button>
          ${entries.length ? '<button type="button" id="fert-export-json-btn" class="btn btn-sm">📤 Export JSON</button>' : ''}
        </div>
      </div>

      <details class="pack-details" style="margin-top:6px;">
        <summary>➕ Ručně přidat poznámku k hnojivu nebo biostimulantu</summary>
        <form id="fert-manual-add-form" class="pack-form" style="margin-top:8px;">
          <div class="field">
            <label for="fert-add-target">Název nebo kód položky *</label>
            <input id="fert-add-target" class="input" placeholder="Např. YARAMILACOMPLEX nebo CHE00246…" required />
          </div>
          <div class="field">
            <label for="fert-add-elements">Účinné prvky / živiny</label>
            <input id="fert-add-elements" class="input" placeholder="Např. N 12%, P 11%, K 18%, Mg, S, mikroprvky…" />
          </div>
          <div class="field">
            <label for="fert-add-tankmix">Doporučené tank-mixy</label>
            <input id="fert-add-tankmix" class="input" placeholder="Např. mísitelné s DAM 390 a graminicidy…" />
          </div>
          <div class="field">
            <label for="fert-add-note">Poznámka / doporučení</label>
            <input id="fert-add-note" class="input" placeholder="Např. základní hnojení před setím 200–350 kg/ha…" />
          </div>
          <div class="pack-form-actions">
            <button type="submit" class="btn btn-primary btn-sm">💾 Uložit k hnojivu</button>
          </div>
        </form>
      </details>

      ${listHtml}
      <input type="file" id="fert-import-xlsx-input" accept=".xlsx,.csv,.json" hidden />
    `;
  }

  function renderUkzuzCard() {
    const pm = ctx.state.porMeta;
    const { matchedProducts, totalProducts } = getMatchedProductStats();
    const isLocal = Boolean(pm?.isLocalOverride);

    ukzuzCard.innerHTML = `
      <div class="section-header" style="margin-bottom: 10px;">
        <div>
          <h3 class="section-title">🌿 Registr ÚKZÚZ (eAGRI POR)</h3>
          <p class="section-sub">Automatická denní synchronizace ve 03:05 přes GitHub Actions (Platné + Do spotřebování zásob).</p>
        </div>
        <span class="exp-pill ${!pm ? 'is-none' : isLocal ? 'is-warning' : 'is-ok'}">
          ${!pm ? 'Nenačteno' : isLocal ? 'Ručně nahraný soubor' : 'Denní auto-sync'}
        </span>
      </div>

      <div class="inv-kpi-row">
        <div class="inv-kpi">
          <div class="inv-kpi-val">${pm?.totalProducts ? pm.totalProducts.toLocaleString('cs-CZ') : '0'}</div>
          <div class="inv-kpi-lbl">Přípravků POR</div>
        </div>
        <div class="inv-kpi">
          <div class="inv-kpi-val" style="color: var(--brand-700)">${pm?.validCount ? pm.validCount.toLocaleString('cs-CZ') : '0'}</div>
          <div class="inv-kpi-lbl">Platné</div>
        </div>
        <div class="inv-kpi">
          <div class="inv-kpi-val" style="color: var(--warn)">${pm?.stockConsumptionCount ?? 0}</div>
          <div class="inv-kpi-lbl">Do spotř. zásob</div>
        </div>
        <div class="inv-kpi">
          <div class="inv-kpi-val" style="color: var(--info)">${matchedProducts} / ${totalProducts}</div>
          <div class="inv-kpi-lbl">Spárováno BC</div>
        </div>
      </div>

      <div style="margin-top: 10px; font-size: 0.82rem; color: var(--ink-muted);">
        Poslední synchronizace: <strong style="color: var(--ink);">${escapeHtml(pm?.updatedAt || '—')}</strong>
        ${pm?.source ? ` · Zdroj: <strong style="color: var(--ink);">${escapeHtml(pm.source)}</strong>` : ''}
      </div>

      <div id="por-upload-progress" class="upload-progress" hidden>
        <div style="display:flex;justify-content:space-between;font-size:0.82rem;font-weight:700;color:var(--brand-900);">
          <span id="por-progress-text">Zpracovávám soubor POR…</span>
          <span id="por-progress-pct" class="mono">0 %</span>
        </div>
        <div class="progress-track" style="margin: 8px 0 0;">
          <div id="por-progress-bar" class="progress-fill" style="width: 0%;"></div>
        </div>
      </div>

      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;">
        <button type="button" id="por-manual-upload-btn" class="btn btn-sm">📂 Nahrát soubor POR ručně</button>
        ${
          isLocal
            ? '<button type="button" id="por-revert-auto-btn" class="btn btn-sm">↩ Vrátit automatickou synchronizaci</button>'
            : '<button type="button" id="por-refresh-btn" class="btn btn-sm">🔄 Znovu načíst</button>'
        }
      </div>
      <div style="margin-top: 6px; font-size: 0.76rem; color: var(--ink-muted);">
        Záložní ruční import přijímá denní export z eAGRI (<strong>.xlsx</strong>, <strong>.xml</strong>, <strong>.csv</strong> nebo <strong>por_aktualni.json</strong>).
      </div>
      <input type="file" id="por-manual-file-input" accept=".xlsx,.xml,.csv,.json" hidden />
    `;
  }

  function renderCustomPacks() {
    const entries = Object.entries(ctx.state.customPacks);
    const nameByCode = new Map();
    for (const i of ctx.state.items) {
      if (!nameByCode.has(i.c)) nameByCode.set(i.c, i.n);
    }

    const listHtml = entries.length
      ? entries
          .map(
            ([code, cfg]) => `
          <div class="pack-rule-row">
            <div>
              <div style="font-weight:700;font-size:0.86rem;">${escapeHtml(nameByCode.get(code) || code)}</div>
              <div style="font-size:0.76rem;color:var(--ink-muted);">
                <span class="mono">${escapeHtml(code)}</span> · 1 balení = <strong>${formatQty(cfg.velikost)}</strong> · obal: <strong>${escapeHtml(cfg.obal || 'automaticky')}</strong>
              </div>
            </div>
            <button type="button" class="btn btn-soft-danger btn-sm" data-del-pack="${escapeHtml(code)}">Smazat</button>
          </div>
        `
          )
          .join('')
      : '<p class="section-sub">Zatím nejsou uložena žádná vlastní přepsání balení. Upravit je můžeš u každého produktu v záložce Hledat.</p>';

    customPacksCard.innerHTML = `
      <div class="section-header" style="margin-bottom: 10px;">
        <h3 class="section-title">📦 Vlastní nastavení balení (${entries.length})</h3>
        <div style="display:flex;gap:6px;">
          <button type="button" id="import-packs-btn" class="btn btn-sm">📥 Import</button>
          ${entries.length ? '<button type="button" id="export-packs-btn" class="btn btn-sm">📤 Export</button>' : ''}
        </div>
      </div>
      ${listHtml}
      <input type="file" id="import-packs-input" accept="application/json,.json" hidden />
    `;
  }

  function renderPwaCard() {
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

    pwaCard.innerHTML = `
      <h3 class="section-title" style="margin-bottom: 4px;">⚡ Proč se tato aplikace nikdy neuspává</h3>
      <p class="section-sub">
        Celý Skladový asistent běží jako čistá JavaScriptová PWA přímo v telefonu a synchronizuje data s Google Tabulkou přes Google Apps Script.
      </p>
      <div style="margin-top: 12px;">
        ${
          isStandalone
            ? '<span class="exp-pill is-ok">✅ Nainstalováno jako aplikace na ploše</span>'
            : deferredInstallPrompt
              ? '<button type="button" id="pwa-install-btn" class="btn btn-primary btn-block">📲 Nainstalovat na plochu telefonu</button>'
              : '<div style="font-size:0.81rem;color:var(--ink-secondary);background:var(--surface-subtle);padding:10px 12px;border-radius:10px;border:1px solid var(--border);">💡 <strong>Tip pro mobil:</strong> V menu prohlížeče klepni na <em>„Přidat na plochu“</em> (iOS: ikona Sdílet → Přidat na plochu) a aplikace se bude spouštět na celou obrazovku jako nativní terminál.</div>'
        }
      </div>
    `;
  }

  function render() {
    renderGasConfigCard();
    renderStatusCard();
    renderCustomersCard();
    renderFertilizerNotesCard();
    renderUkzuzCard();
    renderCustomPacks();
    renderPwaCard();
  }

  return { render };
}
