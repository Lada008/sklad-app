/**
 * Záložka 5: Aktualizace skladových dat (.xlsx přímo v prohlížeči),
 * správa vlastních balení, záloha/obnova, PWA instalace a bezpečný reset.
 */

import {
  escapeHtml,
  formatQty,
  getCzechFileTimestamp,
  triggerFileDownload,
} from './domain.js';
import {
  clearInventoryRecords,
  clearLocalStockData,
  clearReports,
  exportFullBackup,
  importFullBackup,
  saveCustomPacks,
  saveLocalStockData,
} from './storage.js';
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
        <h2 class="section-title">Data skladu &amp; správa</h2>
        <p class="section-sub">Nahraj čerstvý export z Business Central (.xlsx) — zpracuje se přímo v prohlížeči.</p>
      </div>
    </div>

    <div class="card" id="data-status-card"></div>

    <div class="card" style="margin-top: 12px;">
      <h3 class="section-title" style="margin-bottom: 4px;">🔄 Nahrát nový Excel (sklad.xlsx)</h3>
      <p class="section-sub" style="margin-bottom: 12px;">Zpracování probíhá lokálně bez serveru (i offline) a zůstane uloženo v tomto zařízení.</p>

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

      <div id="xlsx-extra-actions" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;"></div>
    </div>

    <div class="card" style="margin-top: 12px;" id="custom-packs-card"></div>

    <div class="card" style="margin-top: 12px;">
      <h3 class="section-title" style="margin-bottom: 4px;">💾 Přenos a záloha dat</h3>
      <p class="section-sub" style="margin-bottom: 12px;">Zálohuj nebo přenes inventuru, hlášení a vlastní balení mezi telefony.</p>
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

  const statusCard = document.getElementById('data-status-card');
  const dropzone = document.getElementById('xlsx-dropzone');
  const fileInput = document.getElementById('xlsx-file-input');
  const progressBox = document.getElementById('xlsx-progress');
  const progressText = document.getElementById('xlsx-progress-text');
  const progressPct = document.getElementById('xlsx-progress-pct');
  const progressBar = document.getElementById('xlsx-progress-bar');
  const extraActionsEl = document.getElementById('xlsx-extra-actions');
  const customPacksCard = document.getElementById('custom-packs-card');
  const pwaCard = document.getElementById('pwa-install-card');
  const backupExportBtn = document.getElementById('backup-export-btn');
  const backupImportBtn = document.getElementById('backup-import-btn');
  const backupImportInput = document.getElementById('backup-import-input');
  const resetConfirm = document.getElementById('reset-confirm-check');
  const resetInvBtn = document.getElementById('reset-inv-btn');
  const resetRepBtn = document.getElementById('reset-rep-btn');

  // --- Upload Excelu ---
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

    progressBox.hidden = false;
    progressBar.style.width = '3%';
    progressPct.textContent = '3 %';
    progressText.textContent = `Načítám ${file.name}…`;

    try {
      const arrayBuffer = await file.arrayBuffer();
      const parsed = await parseBusinessCentralXlsx(arrayBuffer, file.name, (pct, msg) => {
        progressBar.style.width = `${pct}%`;
        progressPct.textContent = `${pct} %`;
        progressText.textContent = msg;
      });

      await saveLocalStockData(parsed);
      ctx.applyStockDataset(parsed);
      ctx.toast(
        `✅ Načteno ${parsed.meta.batchCount} šarží (${parsed.meta.productCount} produktů)`,
        'success'
      );
      setTimeout(() => {
        progressBox.hidden = true;
      }, 1200);
    } catch (err) {
      progressBox.hidden = true;
      ctx.toast(`❌ Chyba Excelu: ${err.message || err}`, 'danger');
    }
  }

  extraActionsEl.addEventListener('click', async (e) => {
    if (e.target.closest('#revert-default-stock-btn')) {
      await clearLocalStockData();
      await ctx.reloadDefaultStock();
      ctx.toast('Obnovena výchozí data z repozitáře', 'success');
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

  function renderStatusCard() {
    const m = ctx.state.meta || {};
    const sizeMb = m.sourceSizeBytes ? (m.sourceSizeBytes / (1024 * 1024)).toFixed(2) : null;
    const isLocal = Boolean(m.isLocalOverride);

    statusCard.innerHTML = `
      <div class="section-header" style="margin-bottom: 10px;">
        <h3 class="section-title">📊 Aktuální skladová data</h3>
        <span class="exp-pill ${isLocal ? 'is-warning' : 'is-ok'}">${isLocal ? 'Lokálně nahraný Excel' : 'Výchozí data z repozitáře'}</span>
      </div>
      <div class="inv-kpi-row">
        <div class="inv-kpi">
          <div class="inv-kpi-val">${m.productCount ?? 0}</div>
          <div class="inv-kpi-lbl">Produktů</div>
        </div>
        <div class="inv-kpi">
          <div class="inv-kpi-val">${m.batchCount ?? 0}</div>
          <div class="inv-kpi-lbl">Akt. šarží</div>
        </div>
        <div class="inv-kpi">
          <div class="inv-kpi-val">${m.ledgerRows ? m.ledgerRows.toLocaleString('cs-CZ') : '—'}</div>
          <div class="inv-kpi-lbl">Řádků BC</div>
        </div>
        <div class="inv-kpi">
          <div class="inv-kpi-val">${sizeMb ? `${sizeMb} MB` : '—'}</div>
          <div class="inv-kpi-lbl">Zdroj</div>
        </div>
      </div>
      <div style="margin-top: 10px; font-size: 0.82rem; color: var(--ink-muted);">
        Soubor: <strong style="color: var(--ink);">${escapeHtml(m.sourceFile || 'stock.json')}</strong> ·
        Aktualizováno: <strong style="color: var(--ink);">${escapeHtml(m.updatedAt || '—')}</strong>
      </div>
    `;

    extraActionsEl.innerHTML = `
      ${isLocal ? '<button type="button" id="revert-default-stock-btn" class="btn btn-sm">↩ Obnovit výchozí data z repozitáře</button>' : ''}
      <button type="button" id="export-stock-json-btn" class="btn btn-sm">📥 Stáhnout kompaktní stock.json</button>
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
        Celý Skladový asistent běží jako čistá JavaScriptová PWA přímo v telefonu. Žádný spící server, žádné rozpadlé WebSocket spojení — funguje okamžitě i bez signálu uvnitř haly.
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
    renderStatusCard();
    renderCustomPacks();
    renderPwaCard();
  }

  return { render };
}
