/**
 * Záložka 3: Mobilní & PC inventura s obousměrnou synchronizací přes Google Tabulku (list `Inventura`).
 * - Slepá inventura / Kontrolní režim (přepínač)
 * - Rychlá tlačítka po celých kartonech (+1 karton = +20 L / +12 L) i po jednotlivých kusech/kanystrech (+1 ks = +5 L / +1 L / +10 L)
 * - Živý rozpad na celé kartony a volné kusy (např. "55 L = 2 kartony + 3 kanystry po 5 L")
 * - Okamžité odeslání každého záznamu přes POST (`action: "save_inventura"`) do Google Tabulky (list `Inventura`)
 * - Přehledná tabulka všech záznamů z cloudu (GET pole `inventura`) se zvýrazněním rozdílů oproti BC a exportem do Excelu (.xlsx)
 */

import {
  buildXlsxBlob,
  escapeHtml,
  formatIsoDateCz,
  formatNumberRaw,
  formatQty,
  formatQtyWithUnit,
  getCzechFileTimestamp,
  getCzechNowStr,
  getPackagingInfo,
  normalizeText,
  prepocetNaBaleni,
  triggerFileDownload,
} from './domain.js';
import { gasSaveInventura } from './gas-api.js';
import { saveInventoryRecords } from './storage.js';

const SECTIONS = [
  { id: 'Boršice (Sklad + Komise Boršice)', label: '🏢 Boršice (Sklad + Komise Boršice)', recordName: 'Boršice (Vč. komisí)' },
  { id: 'Valmez (Sklad + Komise Valmez)', label: '🏭 Valmez (Sklad + Komise Valmez)', recordName: 'Valmez (Vč. komisí)' },
  { id: 'Jen všechny komise', label: '🤝 Jen všechny komise', recordName: 'Všechny komise' },
  { id: 'Všechny sklady', label: '📦 Všechny sklady dohromady', recordName: 'Všechny sklady' },
];

const INV_PAGE_SIZE = 40;

export function buildInventoryKey(code, loc, lot, exp) {
  return `${String(code || '').trim()}|${String(loc || '').trim()}|${String(lot || '-').trim()}|${String(exp || '').trim()}`;
}

export function createInventoryTab(ctx) {
  let filterView = 'pending'; // 'pending' | 'done' | 'diff' | 'all'
  let searchText = '';
  let expandedKeys = new Set();
  let visibleLimit = INV_PAGE_SIZE;
  let tableFilterDiffOnly = false;

  const panel = document.getElementById('tab-inventory');

  panel.innerHTML = `
    <div class="section-header">
      <div>
        <h2 class="section-title">📋 Inventura (Mobil ↔ PC)</h2>
        <p class="section-sub">Každý zápis se okamžitě ukládá lokálně i do Google Tabulky (list <code>Inventura</code>) pro okamžité zobrazení na PC.</p>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        <button type="button" id="inv-refresh-cloud-btn" class="btn btn-sm">🔄 Obnovit z cloudu</button>
        <button type="button" id="inv-export-xlsx-btn" class="btn btn-primary btn-sm">📊 Export do Excelu (.xlsx)</button>
      </div>
    </div>

    <div id="inv-unsynced-banner" hidden style="margin-bottom: 10px;"></div>

    <div class="inv-progress-card">
      <div class="field">
        <label for="inv-section-select">Který úsek počítáš?</label>
        <select id="inv-section-select" class="select">
          ${SECTIONS.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.label)}</option>`).join('')}
        </select>
      </div>

      <div class="field" style="margin-top: 10px;">
        <label>Způsob počítání inventury</label>
        <div id="inv-mode-switch" class="chip-row" style="padding: 0;" role="group" aria-label="Režim inventury">
          <button type="button" class="chip" data-inv-mode="lot">🏷️ Podle šarží a lokací</button>
          <button type="button" class="chip" data-inv-mode="total">📦 Celkový součet přípravku (vč. komisí, bez šarží)</button>
        </div>
      </div>

      <div class="switch-row">
        <div>
          <div class="switch-label">🙈 Slepá inventura</div>
          <div class="switch-sub">Skrývá stav ze systému před uložením. Vypnutím zapneš tlačítko „Sedí“.</div>
        </div>
        <label class="toggle-switch">
          <input type="checkbox" id="inv-blind-toggle" />
          <span class="toggle-slider"></span>
        </label>
      </div>

      <div id="inv-progress-area"></div>
    </div>

    <div class="search-box-wrap" style="margin-bottom: 10px;">
      <div class="search-input-shell">
        <svg class="search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="8"></circle>
          <path d="m21 21-4.3-4.3"></path>
        </svg>
        <input type="search" id="inv-search-input" class="search-input" placeholder="Rychlé vyhledání v inventuře (název, kód, lokace, šarže)…" autocomplete="off" />
        <button type="button" id="inv-search-clear" class="search-action-btn" aria-label="Vymazat filtr" hidden>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round">
            <path d="M18 6 6 18M6 6l12 12"></path>
          </svg>
        </button>
      </div>
    </div>

    <div id="inv-filter-chips" class="chip-row" style="margin-bottom: 10px;"></div>
    <div id="inv-list"></div>
    <div id="inv-cloud-table-wrap"></div>
  `;

  const sectionSelect = document.getElementById('inv-section-select');
  const modeSwitch = document.getElementById('inv-mode-switch');
  const blindToggle = document.getElementById('inv-blind-toggle');
  const progressArea = document.getElementById('inv-progress-area');
  const searchInput = document.getElementById('inv-search-input');
  const searchClear = document.getElementById('inv-search-clear');
  const filterChips = document.getElementById('inv-filter-chips');
  const listEl = document.getElementById('inv-list');
  const cloudTableWrap = document.getElementById('inv-cloud-table-wrap');
  const unsyncedBanner = document.getElementById('inv-unsynced-banner');
  const refreshCloudBtn = document.getElementById('inv-refresh-cloud-btn');
  const exportXlsxBtn = document.getElementById('inv-export-xlsx-btn');

  sectionSelect.addEventListener('change', () => {
    ctx.setPrefs({ invSection: sectionSelect.value });
    visibleLimit = INV_PAGE_SIZE;
    expandedKeys.clear();
    render();
  });

  modeSwitch.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-inv-mode]');
    if (!btn) return;
    ctx.setPrefs({ invMode: btn.dataset.invMode });
    visibleLimit = INV_PAGE_SIZE;
    expandedKeys.clear();
    render();
  });

  blindToggle.addEventListener('change', () => {
    ctx.setPrefs({ blindMode: blindToggle.checked });
    render();
  });

  searchInput.addEventListener('input', () => {
    searchText = searchInput.value;
    searchClear.hidden = !searchText.length;
    visibleLimit = INV_PAGE_SIZE;
    renderListOnly();
  });

  searchClear.addEventListener('click', () => {
    searchText = '';
    searchInput.value = '';
    searchClear.hidden = true;
    visibleLimit = INV_PAGE_SIZE;
    renderListOnly();
  });

  filterChips.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-inv-filter]');
    if (!chip) return;
    filterView = chip.dataset.invFilter;
    visibleLimit = INV_PAGE_SIZE;
    render();
  });

  refreshCloudBtn.addEventListener('click', async () => {
    refreshCloudBtn.disabled = true;
    const orig = refreshCloudBtn.innerHTML;
    refreshCloudBtn.innerHTML = `<span class="btn-spinner"></span> Stahuji…`;
    await ctx.syncFromGas({ silent: false });
    refreshCloudBtn.disabled = false;
    refreshCloudBtn.innerHTML = orig;
  });

  unsyncedBanner.addEventListener('click', async (e) => {
    const pushBtn = e.target.closest('#inv-push-unsynced-btn');
    if (!pushBtn) return;
    const unsynced = Object.values(ctx.state.inventory).filter((r) => r && r.synced === false);
    if (!unsynced.length) return;
    pushBtn.disabled = true;
    pushBtn.innerHTML = `<span class="btn-spinner"></span> Odesílám (${unsynced.length})…`;
    try {
      const payload = unsynced.map(toGasRecord);
      await gasSaveInventura(payload, ctx.state.prefs.gasUrl);
      for (const r of unsynced) {
        if (ctx.state.inventory[r.key]) {
          ctx.state.inventory[r.key].synced = true;
        }
      }
      saveInventoryRecords(ctx.state.inventory);
      ctx.toast(`✅ Odesláno ${unsynced.length} záznamů inventury do Google Tabulky`, 'success');
      await ctx.syncFromGas({ silent: true });
    } catch (err) {
      ctx.toast(`❌ Odeslání inventury selhalo: ${err.message}`, 'danger');
      render();
    }
  });

  exportXlsxBtn.addEventListener('click', () => {
    const records = getAllMergedRecords();
    if (!records.length) {
      ctx.toast('Zatím nejsou uloženy žádné záznamy inventury.', 'warn');
      return;
    }
    const headers = [
      'Čas zápisu',
      'Číslo zboží',
      'Název',
      'Lokace',
      'Šarže',
      'Expirace',
      'Stav BC',
      'Skutečný stav',
      'Rozdíl',
      'Krabice / balení',
      'Poznámka',
      'Stav',
    ];
    const rows = records.map((r) => [
      r.time || '',
      r.code || '',
      r.name || '',
      r.loc || '',
      r.lot || '-',
      r.exp ? formatIsoDateCz(r.exp) : '',
      Number(r.system) || 0,
      Number(r.actual) || 0,
      Number(r.diff) || 0,
      r.kartonyText || '',
      r.note || '',
      r.diff === 0 ? 'Sedí' : r.diff < 0 ? 'Manko' : 'Přebytek',
    ]);
    const blob = buildXlsxBlob('Inventura', headers, rows);
    triggerFileDownload(blob, `inventura_${getCzechFileTimestamp()}.xlsx`);
    ctx.toast(`📊 Stažen Excel (inventura.xlsx) s ${records.length} záznamy`, 'success');
  });

  cloudTableWrap.addEventListener('click', (e) => {
    const toggleDiffBtn = e.target.closest('[data-cloud-table-filter]');
    if (toggleDiffBtn) {
      tableFilterDiffOnly = toggleDiffBtn.dataset.cloudTableFilter === 'diff';
      renderCloudTable();
    }
  });

  // Delegované události na seznamu položek
  listEl.addEventListener('click', (e) => {
    const toggleBtn = e.target.closest('[data-inv-toggle]');
    if (toggleBtn) {
      const key = toggleBtn.dataset.invToggle;
      if (expandedKeys.has(key)) expandedKeys.delete(key);
      else expandedKeys.add(key);
      renderListOnly();
      return;
    }

    const stepBtn = e.target.closest('[data-step-delta]');
    if (stepBtn) {
      const card = stepBtn.closest('.inv-item');
      const input = card?.querySelector('input[name="actual"]');
      if (!input) return;
      const delta = parseFloat(stepBtn.dataset.stepDelta);
      const current = parseFloat(String(input.value || '').replace(',', '.')) || 0;
      const next = Math.max(0, Math.round((current + delta) * 1000) / 1000);
      input.value = formatNumberRaw(next);
      updateLivePackPreview(card, next);
      return;
    }

    const matchBtn = e.target.closest('[data-inv-match]');
    if (matchBtn) {
      const key = matchBtn.dataset.invMatch;
      const item = findItemByKey(key);
      const card = matchBtn.closest('.inv-item');
      const note = card?.querySelector('input[name="poznamka"]')?.value.trim() || '';
      if (item) saveEntry(item, item.system, note);
      return;
    }

    const undoBtn = e.target.closest('[data-inv-undo]');
    if (undoBtn) {
      const key = undoBtn.dataset.invUndo;
      delete ctx.state.inventory[key];
      saveInventoryRecords(ctx.state.inventory);
      ctx.toast('Lokální záznam inventury byl zrušen', 'warn');
      ctx.updateBadges();
      render();
      return;
    }

    if (e.target.closest('#inv-load-more')) {
      visibleLimit += INV_PAGE_SIZE;
      renderListOnly();
    }
  });

  listEl.addEventListener('input', (e) => {
    const actualIn = e.target.closest('input[name="actual"]');
    if (actualIn) {
      const card = actualIn.closest('.inv-item');
      const val = parseFloat(String(actualIn.value || '').replace(',', '.'));
      updateLivePackPreview(card, Number.isNaN(val) ? null : val);
      return;
    }

    const packCountInput = e.target.closest('[data-pack-multiplier]');
    if (!packCountInput) return;
    const step = parseFloat(packCountInput.dataset.packMultiplier);
    const count = parseFloat(packCountInput.value.replace(',', '.'));
    const card = packCountInput.closest('.inv-item');
    const actualInput = card?.querySelector('input[name="actual"]');
    if (!actualInput) return;
    if (!Number.isNaN(count) && count >= 0) {
      const total = Math.round(count * step * 1000) / 1000;
      actualInput.value = formatNumberRaw(total);
      updateLivePackPreview(card, total);
    }
  });

  listEl.addEventListener('submit', (e) => {
    const form = e.target.closest('[data-inv-form]');
    if (!form) return;
    e.preventDefault();
    const key = form.dataset.invForm;
    const item = findItemByKey(key);
    if (!item) return;

    const raw = form.querySelector('input[name="actual"]').value.trim().replace(',', '.');
    if (raw === '' || Number.isNaN(Number(raw)) || Number(raw) < 0) {
      ctx.toast('Zadej prosím platný počet (i kdyby to byla 0).', 'danger');
      return;
    }
    const note = form.querySelector('input[name="poznamka"]')?.value.trim() || '';
    saveEntry(item, Number(raw), note);
  });

  function updateLivePackPreview(card, val) {
    if (!card) return;
    const previewEl = card.querySelector('[data-live-pack-preview]');
    if (!previewEl) return;
    const code = previewEl.dataset.itemCode || '';
    const name = previewEl.dataset.itemName || '';
    if (val === null || val === undefined || Number.isNaN(val) || val < 0) {
      previewEl.textContent = '';
      return;
    }
    const packStr = prepocetNaBaleni(code, name, val, ctx.state.customPacks);
    previewEl.innerHTML = `Rozpad: <strong>${formatQtyWithUnit(val, name)} = ${escapeHtml(packStr)}</strong>`;
  }

  function getActiveSection() {
    const id = ctx.state.prefs.invSection;
    return SECTIONS.find((s) => s.id === id) || SECTIONS[0];
  }

  function getInvMode() {
    return ctx.state.prefs.invMode === 'total' ? 'total' : 'lot';
  }

  function getSectionItems() {
    const section = getActiveSection();
    const invMode = getInvMode();
    let base = ctx.state.items;
    if (section.id === 'Boršice (Sklad + Komise Boršice)') {
      base = base.filter((i) => i.wh === 'Boršice');
    } else if (section.id === 'Valmez (Sklad + Komise Valmez)') {
      base = base.filter((i) => i.wh === 'Valmez');
    } else if (section.id === 'Jen všechny komise') {
      base = base.filter((i) => String(i.loc || '').startsWith('K.'));
    }

    const map = new Map();

    if (invMode === 'total') {
      // Celkový součet přípravku na vybraném úseku — bez rozlišení šarží, expirací i bez rozlišení vlastní sklad vs. komise
      for (const row of base) {
        const key = buildInventoryKey(row.c, section.recordName, 'VŠE (součet)', '');
        let entry = map.get(key);
        if (!entry) {
          entry = {
            key,
            isTotalMode: true,
            section: section.recordName,
            code: row.c,
            name: row.n,
            loc: section.recordName,
            locDisplay: `${section.recordName} (vše dohromady)`,
            lot: 'VŠE (součet)',
            exp: '',
            system: 0,
            batchCount: 0,
            locSums: new Map(),
            searchParts: new Set([row.n, row.c]),
          };
          map.set(key, entry);
        }
        entry.system = Math.round((entry.system + row.q) * 10000) / 10000;
        entry.batchCount += 1;
        const locLbl = row._locDisplay || row.ln || row.loc;
        entry.locSums.set(locLbl, Math.round(((entry.locSums.get(locLbl) || 0) + row.q) * 10000) / 10000);
        entry.searchParts.add(row.loc);
        entry.searchParts.add(row.ln);
        entry.searchParts.add(row.lot);
      }

      return Array.from(map.values())
        .filter((x) => x.system > 0)
        .map((x) => ({
          ...x,
          breakdownText: Array.from(x.locSums.entries())
            .map(([lbl, q]) => `${lbl}: ${formatQtyWithUnit(q, x.name)}`)
            .join(' + '),
          search: normalizeText(Array.from(x.searchParts).join(' ')),
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'cs'));
    }

    // Režim podle šarží a lokací: (Číslo zboží + Kód lokace + Číslo šarže + Datum expirace)
    for (const row of base) {
      const expIso = row.exp || '';
      const key = buildInventoryKey(row.c, row.loc, row.lot, expIso);
      let entry = map.get(key);
      if (!entry) {
        entry = {
          key,
          isTotalMode: false,
          section: section.recordName,
          code: row.c,
          name: row.n,
          loc: row.loc,
          locDisplay: row._locDisplay || row.ln || row.loc,
          lot: row.lot,
          exp: expIso,
          system: 0,
          search: normalizeText(`${row.n} ${row.c} ${row.loc} ${row.ln} ${row.lot}`),
        };
        map.set(key, entry);
      }
      entry.system = Math.round((entry.system + row.q) * 10000) / 10000;
    }

    return Array.from(map.values())
      .filter((x) => x.system > 0)
      .sort(
        (a, b) =>
          a.name.localeCompare(b.name, 'cs') ||
          a.loc.localeCompare(b.loc, 'cs') ||
          a.lot.localeCompare(b.lot, 'cs')
      );
  }

  function findItemByKey(key) {
    return getSectionItems().find((i) => i.key === key) || null;
  }

  function findRecordForItem(item) {
    const inv = ctx.state.inventory || {};
    if (inv[item.key]) return inv[item.key];
    // Fallback spárování podle (code, loc, lot) pokud v Google Tabulce chyběla expirace
    const altKey = buildInventoryKey(item.code, item.loc, item.lot, '');
    if (inv[altKey]) return inv[altKey];
    return null;
  }

  function toGasRecord(rec) {
    return {
      cislo_zbozi: rec.code || '',
      nazev: rec.name || '',
      lokace: rec.loc || rec.section || '',
      sarze: rec.lot || '-',
      expirace: rec.exp ? formatIsoDateCz(rec.exp) : '',
      stav_bc: Number(rec.system) || 0,
      skutecny_stav: Number(rec.actual) || 0,
      rozdil: Number(rec.diff) || 0,
      kartony_text: rec.kartonyText || '',
      poznamka: rec.note || '',
    };
  }

  async function saveEntry(item, actualVal, note = '') {
    const actual = Math.round(actualVal * 1000) / 1000;
    const diff = Math.round((actual - item.system) * 1000) / 1000;
    const packStr = prepocetNaBaleni(item.code, item.name, actual, ctx.state.customPacks);
    const kartonyText = `${formatQtyWithUnit(actual, item.name)} = ${packStr}`;

    const localRec = {
      key: item.key,
      time: getCzechNowStr(),
      section: item.section,
      code: item.code,
      name: item.name,
      loc: item.loc,
      lot: item.lot,
      exp: item.exp || '',
      system: item.system,
      actual,
      diff,
      kartonyText,
      note: String(note || '').trim(),
      synced: false,
    };

    ctx.state.inventory[item.key] = localRec;
    saveInventoryRecords(ctx.state.inventory);
    expandedKeys.delete(item.key);
    ctx.updateBadges();
    render();

    // Okamžité odeslání POST (`action: "save_inventura"`, `records: [...]`) do Google Tabulky (list `Inventura`)
    try {
      await gasSaveInventura([toGasRecord(localRec)], ctx.state.prefs.gasUrl);
      if (ctx.state.inventory[item.key]) {
        ctx.state.inventory[item.key].synced = true;
        saveInventoryRecords(ctx.state.inventory);
      }
      // Přidej / aktualizuj i v cloudInventory pro okamžité zobrazení v tabulce níže
      const existingIdx = (ctx.state.cloudInventory || []).findIndex(
        (c) =>
          c.cislo_zbozi === localRec.code &&
          c.lokace === localRec.loc &&
          c.sarze === localRec.lot &&
          (c.expirace || '') === (localRec.exp || '')
      );
      const cloudRow = {
        ...toGasRecord(localRec),
        expirace: localRec.exp || '',
        cas: localRec.time,
        synced: true,
      };
      if (existingIdx >= 0) {
        ctx.state.cloudInventory[existingIdx] = cloudRow;
      } else {
        ctx.state.cloudInventory = [cloudRow, ...(ctx.state.cloudInventory || [])];
      }

      if (diff === 0) {
        ctx.toast(`✅ ${item.name}: Sedí (${formatQtyWithUnit(actual, item.name)}) · uloženo do cloudu`, 'success');
      } else {
        const sign = diff > 0 ? '+' : '';
        ctx.toast(
          `⚠️ ${item.name}: Rozdíl ${sign}${formatQtyWithUnit(diff, item.name)} · uloženo do cloudu`,
          'warn'
        );
      }
      render();
    } catch (err) {
      ctx.toast(
        `⚠️ Uloženo lokálně, ale odeslání do Google Tabulky selhalo: ${err.message}`,
        'danger'
      );
      render();
    }
  }

  function getAllMergedRecords() {
    const map = new Map();
    for (const row of ctx.state.cloudInventory || []) {
      const key = buildInventoryKey(row.cislo_zbozi, row.lokace, row.sarze, row.expirace);
      map.set(key, {
        key,
        time: row.cas || '',
        code: row.cislo_zbozi,
        name: row.nazev,
        loc: row.lokace,
        lot: row.sarze,
        exp: row.expirace || '',
        system: row.stav_bc,
        actual: row.skutecny_stav,
        diff: row.rozdil,
        kartonyText: row.kartony_text || prepocetNaBaleni(row.cislo_zbozi, row.nazev, row.skutecny_stav, ctx.state.customPacks),
        note: row.poznamka || '',
        synced: true,
      });
    }
    for (const rec of Object.values(ctx.state.inventory || {})) {
      if (!rec) continue;
      const key = rec.key || buildInventoryKey(rec.code, rec.loc, rec.lot, rec.exp);
      if (!map.has(key) || rec.synced === false) {
        map.set(key, {
          key,
          time: rec.time || '',
          code: rec.code || '',
          name: rec.name || '',
          loc: rec.loc || rec.section || '',
          lot: rec.lot || '-',
          exp: rec.exp || '',
          system: rec.system ?? 0,
          actual: rec.actual ?? 0,
          diff: rec.diff ?? 0,
          kartonyText: rec.kartonyText || prepocetNaBaleni(rec.code, rec.name, rec.actual, ctx.state.customPacks),
          note: rec.note || '',
          synced: rec.synced !== false,
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => {
      // Rozdíly a nejnovější záznamy navrchu
      if ((a.diff !== 0) !== (b.diff !== 0)) return a.diff !== 0 ? -1 : 1;
      return (a.name || '').localeCompare(b.name || '', 'cs');
    });
  }

  function render() {
    const section = getActiveSection();
    const invMode = getInvMode();
    sectionSelect.value = section.id;
    blindToggle.checked = Boolean(ctx.state.prefs.blindMode);
    modeSwitch.querySelectorAll('[data-inv-mode]').forEach((btn) => {
      const active = btn.dataset.invMode === invMode;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', String(active));
    });

    const unsyncedCount = Object.values(ctx.state.inventory || {}).filter(
      (r) => r && r.synced === false
    ).length;
    if (unsyncedCount > 0) {
      unsyncedBanner.hidden = false;
      unsyncedBanner.innerHTML = `
        <div class="callout callout-fefo" style="margin:0;justify-content:space-between;align-items:center;">
          <div style="display:flex;gap:8px;align-items:center;">
            <span class="callout-icon">📡</span>
            <div><strong>${unsyncedCount} ${unsyncedCount === 1 ? 'záznam čeká' : 'záznamů čeká'} na odeslání do Google Tabulky</strong></div>
          </div>
          <button type="button" id="inv-push-unsynced-btn" class="btn btn-primary btn-sm">☁️ Odeslat do cloudu</button>
        </div>
      `;
    } else {
      unsyncedBanner.hidden = true;
      unsyncedBanner.innerHTML = '';
    }

    const items = getSectionItems();
    let doneCount = 0;
    let diffCount = 0;
    for (const it of items) {
      const rec = findRecordForItem(it);
      if (rec) {
        doneCount++;
        if (rec.diff !== 0) diffCount++;
      }
    }
    const total = items.length;
    const pending = total - doneCount;
    const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;

    progressArea.innerHTML = `
      <div class="progress-track" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100">
        <div class="progress-fill" style="width: ${pct}%"></div>
      </div>
      <div class="inv-kpi-row">
        <div class="inv-kpi">
          <div class="inv-kpi-val">${total}</div>
          <div class="inv-kpi-lbl">Celkem</div>
        </div>
        <div class="inv-kpi">
          <div class="inv-kpi-val" style="color: var(--brand-700)">${doneCount} (${pct}%)</div>
          <div class="inv-kpi-lbl">Hotovo</div>
        </div>
        <div class="inv-kpi">
          <div class="inv-kpi-val" style="color: var(--warn)">${pending}</div>
          <div class="inv-kpi-lbl">Zbývá</div>
        </div>
        <div class="inv-kpi">
          <div class="inv-kpi-val" style="color: ${diffCount > 0 ? 'var(--danger)' : 'var(--ink-muted)'}">${diffCount}</div>
          <div class="inv-kpi-lbl">Rozdíly</div>
        </div>
      </div>
    `;

    filterChips.innerHTML = `
      <button type="button" class="chip is-warn ${filterView === 'pending' ? 'is-active' : ''}" data-inv-filter="pending">🟠 Zbývá <span class="chip-count">${pending}</span></button>
      <button type="button" class="chip ${filterView === 'done' ? 'is-active' : ''}" data-inv-filter="done">🟢 Hotovo <span class="chip-count">${doneCount}</span></button>
      <button type="button" class="chip is-danger ${filterView === 'diff' ? 'is-active' : ''}" data-inv-filter="diff">🔴 Rozdíly <span class="chip-count">${diffCount}</span></button>
      <button type="button" class="chip ${filterView === 'all' ? 'is-active' : ''}" data-inv-filter="all">📋 Vše <span class="chip-count">${total}</span></button>
    `;

    renderListOnly(items);
    renderCloudTable();
  }

  function renderListOnly(precomputedItems = null) {
    const items = precomputedItems || getSectionItems();
    const blindMode = Boolean(ctx.state.prefs.blindMode);
    const customPacks = ctx.state.customPacks;

    if (items.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">📦</div>
          <h3>Na tomto úseku není žádné zboží</h3>
          <p>Vyber jiný skladový úsek nebo aktualizuj data.</p>
        </div>
      `;
      return;
    }

    const qNorm = normalizeText(searchText);
    const tokens = qNorm ? qNorm.split(/\s+/).filter(Boolean) : [];

    let filtered = items.filter((it) => {
      if (tokens.length && !tokens.every((t) => it.search.includes(t))) return false;
      const rec = findRecordForItem(it);
      if (filterView === 'pending') return !rec;
      if (filterView === 'done') return Boolean(rec);
      if (filterView === 'diff') return Boolean(rec && rec.diff !== 0);
      return true;
    });

    if (filtered.length === 0) {
      const msg =
        filterView === 'pending' && !tokens.length
          ? '🎉 Skvělá práce! Všechny položky na tomto úseku jsou spočítané.'
          : 'Žádná položka neodpovídá zvolenému filtru.';
      listEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">${filterView === 'pending' && !tokens.length ? '🎉' : '🔍'}</div>
          <h3>${msg}</h3>
        </div>
      `;
      return;
    }

    const autoExpand = tokens.length > 0 && filtered.length <= 3;
    const shown = filtered.slice(0, visibleLimit);
    const remaining = filtered.length - shown.length;

    const html = shown
      .map((it) => {
        const rec = findRecordForItem(it);
        const isDone = Boolean(rec);
        const isDiff = isDone && rec.diff !== 0;
        const isOpen = autoExpand || expandedKeys.has(it.key);
        const statusClass = isDone ? (isDiff ? 'is-diff' : 'is-ok') : 'is-pending';
        const pkg = getPackagingInfo(it.code, it.name, customPacks);
        const uom = pkg.uomDisplay;
        const packInfo = prepocetNaBaleni(it.code, it.name, it.system, customPacks);

        let rightBadge = '';
        if (isDone) {
          const sign = rec.diff > 0 ? '+' : '';
          const syncIcon = rec.synced === false ? '⏳ ' : '☁️ ';
          rightBadge = isDiff
            ? `<span class="diff-badge is-diff">${syncIcon}${sign}${formatQtyWithUnit(rec.diff, it.name)}</span>`
            : `<span class="diff-badge is-ok">${syncIcon}✓ ${formatQtyWithUnit(rec.actual, it.name)}</span>`;
        } else if (!blindMode) {
          rightBadge = `<span class="mono" style="font-size:0.8rem;font-weight:700;color:var(--ink-muted)">${formatQtyWithUnit(it.system, it.name)}</span>`;
        }

        let bodyHtml = '';
        if (isOpen) {
          const expCz = it.exp ? formatIsoDateCz(it.exp) : '—';
          const metaHeader = it.isTotalMode
            ? `<span>Kód: <strong class="mono">${escapeHtml(it.code)}</strong> · <strong>Celkový součet</strong> (${escapeHtml(it.section)}, vlastní + komise)</span>`
            : `<span>Kód: <strong class="mono">${escapeHtml(it.code)}</strong> · Lokace: <strong>${escapeHtml(it.locDisplay)}</strong> · Exp: <strong>${expCz}</strong></span>`;
          const breakdownLine =
            it.isTotalMode && !blindMode && it.breakdownText
              ? `<span style="width:100%;font-size:0.75rem;color:var(--ink-muted);">Složení v BC: ${escapeHtml(it.breakdownText)}</span>`
              : '';
          const infoLine = isDone
            ? `${metaHeader}
               <span>BC: <strong>${formatQtyWithUnit(it.system, it.name)}</strong> <em>(= ${escapeHtml(packInfo)})</em></span>
               <span>Zadáno: <strong>${formatQtyWithUnit(rec.actual, it.name)}</strong> (${isDiff ? `<strong style="color:var(--danger)">Rozdíl ${rec.diff > 0 ? '+' : ''}${formatQtyWithUnit(rec.diff, it.name)}</strong>` : '<strong style="color:var(--brand-700)">Sedí</strong>'})</span>
               ${breakdownLine}`
            : blindMode
              ? `${metaHeader}<span>Očekáváno: <strong>❓ slepá inventura</strong></span>`
              : `${metaHeader}
                 <span>V BC: <strong>${formatQtyWithUnit(it.system, it.name)} = ${escapeHtml(packInfo)}</strong></span>
                 ${breakdownLine}`;

          const defaultVal = isDone ? formatNumberRaw(rec.actual) : '';
          const defaultNote = isDone ? rec.note || '' : '';
          const defaultPreview = isDone
            ? `Rozpad: <strong>${formatQtyWithUnit(rec.actual, it.name)} = ${escapeHtml(prepocetNaBaleni(it.code, it.name, rec.actual, customPacks))}</strong>`
            : '';

          const stepButtonsHtml = pkg.hasCarton
            ? `
                <button type="button" class="stepper-btn" data-step-delta="${-pkg.unitSize}">−${formatQty(pkg.unitSize)} ${uom}<br><small>−1 ks</small></button>
                <button type="button" class="stepper-btn" data-step-delta="${pkg.unitSize}">+${formatQty(pkg.unitSize)} ${uom}<br><small>+1 ks</small></button>
                <button type="button" class="stepper-btn" data-step-delta="${-pkg.cartonSize}">−${formatQty(pkg.cartonSize)} ${uom}<br><small>−1 krabice</small></button>
                <button type="button" class="stepper-btn is-carton" data-step-delta="${pkg.cartonSize}">+${formatQty(pkg.cartonSize)} ${uom}<br><small>+1 krab. (${pkg.piecesPerCarton} ks)</small></button>
              `
            : `
                <button type="button" class="stepper-btn" data-step-delta="${-pkg.unitSize}">−${formatQty(pkg.unitSize)} ${uom}<br><small>−1 ks</small></button>
                <button type="button" class="stepper-btn is-carton" data-step-delta="${pkg.unitSize}">+${formatQty(pkg.unitSize)} ${uom}<br><small>+1 ks</small></button>
                <button type="button" class="stepper-btn" data-step-delta="${Math.round(pkg.unitSize * 5 * 1000) / 1000}">+${formatQty(pkg.unitSize * 5)} ${uom}<br><small>+5 ks</small></button>
                <button type="button" class="stepper-btn" data-step-delta="${Math.round(pkg.unitSize * 10 * 1000) / 1000}">+${formatQty(pkg.unitSize * 10)} ${uom}<br><small>+10 ks</small></button>
              `;

          bodyHtml = `
            <div class="inv-item-body">
              <div class="inv-info-strip">${infoLine}</div>
              <form data-inv-form="${escapeHtml(it.key)}">
                ${
                  pkg.hasCarton
                    ? `<div class="inv-pack-helper">
                         <span>📦 Rychlý přepočet:</span>
                         <input type="number" min="0" step="1" inputmode="decimal" placeholder="krab." data-pack-multiplier="${pkg.cartonSize}" aria-label="Počet celých krabic" />
                         <span><strong>krabic</strong> (× <strong class="mono">${pkg.piecesPerCarton} ks</strong> = <strong class="mono">${formatQty(pkg.cartonSize)} ${uom}</strong>)</span>
                       </div>`
                    : pkg.unitSize !== 1
                      ? `<div class="inv-pack-helper">
                           <span>📦 Rychlý přepočet:</span>
                           <input type="number" min="0" step="1" inputmode="decimal" placeholder="ks" data-pack-multiplier="${pkg.unitSize}" aria-label="Počet kusů" />
                           <span><strong>kusů</strong> (× <strong class="mono">${formatQty(pkg.unitSize)} ${uom}</strong>)</span>
                         </div>`
                      : ''
                }
                <div class="field">
                  <label>Fyzicky napočítáno celkem (${uom} · 1 ks = ${formatQty(pkg.unitSize)} ${uom}${pkg.hasCarton ? `, 1 krabice = ${pkg.piecesPerCarton} ks = ${formatQty(pkg.cartonSize)} ${uom}` : ''})</label>
                  <input class="input mono" type="number" name="actual" min="0" step="any" inputmode="decimal" value="${defaultVal}" placeholder="Zadej počet v ${uom}…" />
                </div>

                <div class="inv-live-pack" data-live-pack-preview="1" data-item-code="${escapeHtml(it.code)}" data-item-name="${escapeHtml(it.name)}">${defaultPreview}</div>

                <div class="stepper-row">
                  ${stepButtonsHtml}
                </div>

                <div class="field" style="margin-top:8px;">
                  <label>Poznámka (volitelné — poškozený obal, chybí etiketa…)</label>
                  <input class="input" type="text" name="poznamka" value="${escapeHtml(defaultNote)}" placeholder="Např. 1 kanystr načatý, přesunuto…" />
                </div>

                <div class="inv-action-row">
                  <button type="submit" class="btn btn-primary">☁️ Uložit &amp; odeslat</button>
                  ${
                    !blindMode
                      ? `<button type="button" class="btn" data-inv-match="${escapeHtml(it.key)}">✅ Sedí (${formatQtyWithUnit(it.system, it.name)})</button>`
                      : isDone
                        ? `<button type="button" class="btn btn-soft-danger" data-inv-undo="${escapeHtml(it.key)}">↩ Zrušit záznam</button>`
                        : `<button type="button" class="btn" data-step-delta="${-999999}">0 (Prázdné)</button>`
                  }
                </div>
                ${
                  !blindMode && isDone
                    ? `<div style="margin-top:8px;"><button type="button" class="btn btn-soft-danger btn-sm btn-block" data-inv-undo="${escapeHtml(it.key)}">↩ Zrušit tento lokální záznam</button></div>`
                    : ''
                }
              </form>
            </div>
          `;
        }

        return `
          <div class="inv-item ${statusClass}">
            <button type="button" class="inv-item-head" data-inv-toggle="${escapeHtml(it.key)}" aria-expanded="${isOpen}">
              <span class="inv-status-dot ${statusClass}" aria-hidden="true"></span>
              <div class="inv-item-main">
                <div class="inv-item-name">${escapeHtml(it.name)}</div>
                <div class="inv-item-sub">
                  ${
                    it.isTotalMode
                      ? `<strong>Celkový součet</strong> (vlastní + komise · ${it.batchCount} ${it.batchCount === 1 ? 'šarže' : it.batchCount >= 2 && it.batchCount <= 4 ? 'šarže' : 'šarží'}) · <span class="mono">${escapeHtml(it.code)}</span>`
                      : `<strong>${escapeHtml(it.locDisplay)}</strong> · Šarže: <strong class="mono">${escapeHtml(it.lot)}</strong>${it.exp ? ` · Exp: ${formatIsoDateCz(it.exp)}` : ''}`
                  }
                  ${!blindMode ? `<br><span style="color:var(--ink-secondary);">${escapeHtml(packInfo)}</span>` : ''}
                </div>
              </div>
              ${rightBadge}
            </button>
            ${bodyHtml}
          </div>
        `;
      })
      .join('');

    const loadMoreHtml =
      remaining > 0
        ? `<button type="button" id="inv-load-more" class="btn btn-block" style="margin-top: 8px;">Zobrazit dalších ${Math.min(INV_PAGE_SIZE, remaining)} položek (zbývá ${remaining})</button>`
        : '';

    listEl.innerHTML = html + loadMoreHtml;
  }

  function renderCloudTable() {
    const allRecords = getAllMergedRecords();
    const diffRecords = allRecords.filter((r) => r.diff !== 0);
    const shown = tableFilterDiffOnly ? diffRecords : allRecords;

    if (!allRecords.length) {
      cloudTableWrap.innerHTML = `
        <div class="card" style="margin-top: 16px;">
          <div class="section-header" style="margin-bottom: 6px;">
            <h3 class="section-title">☁️ Zapsané záznamy inventury (Google Tabulka)</h3>
          </div>
          <p class="section-sub">Zatím nejsou v listu <code>Inventura</code> žádné záznamy. Jakmile skladník uloží položku v mobilu, objeví se zde i na PC.</p>
        </div>
      `;
      return;
    }

    cloudTableWrap.innerHTML = `
      <div class="card" style="margin-top: 16px; ${diffRecords.length ? 'border-color: var(--danger-border);' : ''}">
        <div class="section-header" style="margin-bottom: 10px;">
          <div>
            <h3 class="section-title">☁️ Zapsané záznamy inventury (${allRecords.length})</h3>
            <p class="section-sub">Synchronizováno s Google Tabulkou (list <code>Inventura</code>) · Rozdíly oproti BC: <strong style="color:${diffRecords.length ? 'var(--danger)' : 'var(--brand-700)'}">${diffRecords.length}</strong></p>
          </div>
          <div class="chip-row" style="padding:0;">
            <button type="button" class="chip ${!tableFilterDiffOnly ? 'is-active' : ''}" data-cloud-table-filter="all">Vše (${allRecords.length})</button>
            <button type="button" class="chip is-danger ${tableFilterDiffOnly ? 'is-active' : ''}" data-cloud-table-filter="diff">⚠️ Jen rozdíly (${diffRecords.length})</button>
          </div>
        </div>

        <div class="inv-table-scroll">
          <table class="inv-cloud-table">
            <thead>
              <tr>
                <th>Kód / Název</th>
                <th>Lokace &amp; Šarže</th>
                <th class="num">Stav BC</th>
                <th class="num">Skutečný</th>
                <th class="num">Rozdíl</th>
                <th>Krabice / balení</th>
                <th>Poznámka</th>
              </tr>
            </thead>
            <tbody>
              ${shown
                .map((r) => {
                  const rowCls =
                    r.diff < 0
                      ? 'is-row-manko'
                      : r.diff > 0
                        ? 'is-row-prebytek'
                        : 'is-row-ok';
                  const diffLabel =
                    r.diff === 0
                      ? '<span class="diff-badge is-ok">✓ Sedí</span>'
                      : `<span class="diff-badge is-diff">${r.diff > 0 ? '+' : ''}${formatQtyWithUnit(r.diff, r.name)}</span>`;
                  return `
                    <tr class="${rowCls}">
                      <td>
                        <div style="font-weight:700;">${escapeHtml(r.name)}</div>
                        <div class="mono" style="font-size:0.74rem;color:var(--ink-muted);">${escapeHtml(r.code)}${r.time ? ` · ${escapeHtml(r.time)}` : ''}${r.synced === false ? ' · ⏳ nesync.' : ''}</div>
                      </td>
                      <td>
                        <div><strong>${escapeHtml(r.loc || '—')}</strong></div>
                        <div class="mono" style="font-size:0.74rem;color:var(--ink-muted);">Š: ${escapeHtml(r.lot)}${r.exp ? ` · Exp: ${formatIsoDateCz(r.exp)}` : ''}</div>
                      </td>
                      <td class="num mono">${formatQtyWithUnit(r.system, r.name)}</td>
                      <td class="num mono"><strong>${formatQtyWithUnit(r.actual, r.name)}</strong></td>
                      <td class="num">${diffLabel}</td>
                      <td style="font-size:0.8rem;">${escapeHtml(r.kartonyText || '—')}</td>
                      <td style="font-size:0.8rem;color:var(--ink-secondary);">${escapeHtml(r.note || '—')}</td>
                    </tr>
                  `;
                })
                .join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  function focusProduct(productName, warehouseHint) {
    if (warehouseHint === 'Valmez') {
      ctx.setPrefs({ invSection: 'Valmez (Sklad + Komise Valmez)' });
    } else if (warehouseHint === 'Boršice') {
      ctx.setPrefs({ invSection: 'Boršice (Sklad + Komise Boršice)' });
    }
    filterView = 'all';
    searchText = productName || '';
    searchInput.value = searchText;
    searchClear.hidden = !searchText.length;
    render();
  }

  return { render, focusProduct };
}
