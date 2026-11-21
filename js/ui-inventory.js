/**
 * Záložka 3: Mobilní inventura.
 * - Slepá inventura / Kontrolní režim (přepínač)
 * - Rychlá kalkulačka balení (počet balení × krok) a +/- tlačítka pro pohodlné počítání v rukavicích
 * - Okamžité ukládání do localStorage, souhrn rozdílů a export do českého CSV
 */

import {
  escapeHtml,
  formatNumberRaw,
  formatQty,
  getCzechFileTimestamp,
  getCzechNowStr,
  normalizeText,
  prepocetNaBaleni,
  toCsv,
  triggerFileDownload,
  ziskejKrokBaleni,
} from './domain.js';
import { saveInventoryRecords } from './storage.js';

const SECTIONS = [
  { id: 'Boršice (Sklad + Komise Boršice)', label: '🏢 Boršice (Sklad + Komise Boršice)', recordName: 'Boršice (Vč. komisí)' },
  { id: 'Valmez (Sklad + Komise Valmez)', label: '🏭 Valmez (Sklad + Komise Valmez)', recordName: 'Valmez (Vč. komisí)' },
  { id: 'Jen všechny komise', label: '🤝 Jen všechny komise', recordName: 'Všechny komise' },
  { id: 'Všechny sklady', label: '📦 Všechny sklady dohromady', recordName: 'Všechny sklady' },
];

const INV_PAGE_SIZE = 40;

export function createInventoryTab(ctx) {
  let filterView = 'pending'; // 'pending' | 'done' | 'diff' | 'all'
  let searchText = '';
  let expandedKeys = new Set();
  let visibleLimit = INV_PAGE_SIZE;

  const panel = document.getElementById('tab-inventory');

  panel.innerHTML = `
    <div class="section-header">
      <div>
        <h2 class="section-title">Mobilní inventura</h2>
        <p class="section-sub">Záznamy se ukládají okamžitě do zařízení a neztratí se ani bez signálu.</p>
      </div>
      <button type="button" id="inv-export-btn" class="btn btn-sm">📥 Export CSV</button>
    </div>

    <div class="inv-progress-card">
      <div class="field">
        <label for="inv-section-select">Který úsek počítáš?</label>
        <select id="inv-section-select" class="select">
          ${SECTIONS.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.label)}</option>`).join('')}
        </select>
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
        <input type="search" id="inv-search-input" class="search-input" placeholder="Rychlé vyhledání v inventuře (název, kód, šarže)…" autocomplete="off" />
        <button type="button" id="inv-search-clear" class="search-action-btn" aria-label="Vymazat filtr" hidden>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round">
            <path d="M18 6 6 18M6 6l12 12"></path>
          </svg>
        </button>
      </div>
    </div>

    <div id="inv-filter-chips" class="chip-row" style="margin-bottom: 10px;"></div>
    <div id="inv-list"></div>
    <div id="inv-diff-summary"></div>
  `;

  const sectionSelect = document.getElementById('inv-section-select');
  const blindToggle = document.getElementById('inv-blind-toggle');
  const progressArea = document.getElementById('inv-progress-area');
  const searchInput = document.getElementById('inv-search-input');
  const searchClear = document.getElementById('inv-search-clear');
  const filterChips = document.getElementById('inv-filter-chips');
  const listEl = document.getElementById('inv-list');
  const diffSummaryEl = document.getElementById('inv-diff-summary');
  const exportBtn = document.getElementById('inv-export-btn');

  sectionSelect.addEventListener('change', () => {
    ctx.setPrefs({ invSection: sectionSelect.value });
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

  exportBtn.addEventListener('click', () => {
    const records = Object.values(ctx.state.inventory);
    if (!records.length) {
      ctx.toast('Zatím nejsou uloženy žádné záznamy inventury.', 'warn');
      return;
    }
    const headers = ['Čas', 'Úsek', 'Kód zboží', 'Popis', 'Šarže', 'Systém', 'Fyzicky', 'Rozdíl'];
    const rows = records
      .sort((a, b) => (a.section + a.name).localeCompare(b.section + b.name, 'cs'))
      .map((r) => [r.time, r.section, r.code, r.name, r.lot, r.system, r.actual, r.diff]);
    const csv = toCsv(headers, rows, ';');
    triggerFileDownload(csv, `inventura_${getCzechFileTimestamp()}.csv`);
    ctx.toast(`Staženo CSV s ${records.length} záznamy`, 'success');
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
      const current = parseFloat(input.value.replace(',', '.')) || 0;
      const next = Math.max(0, Math.round((current + delta) * 1000) / 1000);
      input.value = formatNumberRaw(next);
      return;
    }

    const matchBtn = e.target.closest('[data-inv-match]');
    if (matchBtn) {
      const key = matchBtn.dataset.invMatch;
      const item = findItemByKey(key);
      if (item) saveEntry(item, item.system);
      return;
    }

    const undoBtn = e.target.closest('[data-inv-undo]');
    if (undoBtn) {
      const key = undoBtn.dataset.invUndo;
      delete ctx.state.inventory[key];
      saveInventoryRecords(ctx.state.inventory);
      ctx.toast('Záznam inventury byl zrušen', 'warn');
      render();
      return;
    }

    if (e.target.closest('#inv-load-more')) {
      visibleLimit += INV_PAGE_SIZE;
      renderListOnly();
    }
  });

  listEl.addEventListener('input', (e) => {
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
    saveEntry(item, Number(raw));
  });

  function getActiveSection() {
    const id = ctx.state.prefs.invSection;
    return SECTIONS.find((s) => s.id === id) || SECTIONS[0];
  }

  function getSectionItems() {
    const section = getActiveSection();
    let base = ctx.state.items;
    if (section.id === 'Boršice (Sklad + Komise Boršice)') {
      base = base.filter((i) => i.wh === 'Boršice');
    } else if (section.id === 'Valmez (Sklad + Komise Valmez)') {
      base = base.filter((i) => i.wh === 'Valmez');
    } else if (section.id === 'Jen všechny komise') {
      base = base.filter((i) => String(i.loc || '').startsWith('K.'));
    }

    // Seskupení podle (kód, popis, šarže) — shodné s původní logikou
    const map = new Map();
    for (const row of base) {
      const key = `${row.c}|${row.lot}|${section.recordName}`;
      let entry = map.get(key);
      if (!entry) {
        entry = {
          key,
          section: section.recordName,
          code: row.c,
          name: row.n,
          lot: row.lot,
          system: 0,
          search: normalizeText(`${row.n} ${row.c} ${row.lot}`),
        };
        map.set(key, entry);
      }
      entry.system = Math.round((entry.system + row.q) * 10000) / 10000;
    }

    return Array.from(map.values())
      .filter((x) => x.system > 0)
      .sort((a, b) => a.name.localeCompare(b.name, 'cs') || a.lot.localeCompare(b.lot, 'cs'));
  }

  function findItemByKey(key) {
    return getSectionItems().find((i) => i.key === key) || null;
  }

  function saveEntry(item, actualVal) {
    const actual = Math.round(actualVal * 1000) / 1000;
    const diff = Math.round((actual - item.system) * 1000) / 1000;

    ctx.state.inventory[item.key] = {
      time: getCzechNowStr(),
      section: item.section,
      code: item.code,
      name: item.name,
      lot: item.lot,
      system: item.system,
      actual,
      diff,
    };
    saveInventoryRecords(ctx.state.inventory);
    expandedKeys.delete(item.key);

    if (diff === 0) {
      ctx.toast(`✅ ${item.name}: Vše sedí (${formatQty(item.system)} j.)`, 'success');
    } else {
      const sign = diff > 0 ? '+' : '';
      ctx.toast(`⚠️ ${item.name}: Uloženo s rozdílem ${sign}${formatQty(diff)} j.`, 'warn');
    }
    ctx.updateBadges();
    render();
  }

  function render() {
    const section = getActiveSection();
    sectionSelect.value = section.id;
    blindToggle.checked = Boolean(ctx.state.prefs.blindMode);

    const items = getSectionItems();
    const inv = ctx.state.inventory;

    let doneCount = 0;
    let diffCount = 0;
    for (const it of items) {
      const rec = inv[it.key];
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
    renderDiffSummary();
  }

  function renderListOnly(precomputedItems = null) {
    const items = precomputedItems || getSectionItems();
    const inv = ctx.state.inventory;
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
      const rec = inv[it.key];
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

    // Pokud uživatel vyhledává a našlo se <= 3 položky, automaticky je rozbal pro okamžité zadání
    const autoExpand = tokens.length > 0 && filtered.length <= 3;

    const shown = filtered.slice(0, visibleLimit);
    const remaining = filtered.length - shown.length;

    const html = shown
      .map((it) => {
        const rec = inv[it.key];
        const isDone = Boolean(rec);
        const isDiff = isDone && rec.diff !== 0;
        const isOpen = autoExpand || expandedKeys.has(it.key);
        const statusClass = isDone ? (isDiff ? 'is-diff' : 'is-ok') : 'is-pending';
        const step = ziskejKrokBaleni(it.code, it.name, customPacks);
        const packInfo = prepocetNaBaleni(it.code, it.name, it.system, customPacks);

        let rightBadge = '';
        if (isDone) {
          const sign = rec.diff > 0 ? '+' : '';
          rightBadge = isDiff
            ? `<span class="diff-badge is-diff">${sign}${formatQty(rec.diff)} j.</span>`
            : `<span class="diff-badge is-ok">✓ ${formatQty(rec.actual)} j.</span>`;
        } else if (!blindMode) {
          rightBadge = `<span class="mono" style="font-size:0.8rem;font-weight:700;color:var(--ink-muted)">${formatQty(it.system)} j.</span>`;
        }

        let bodyHtml = '';
        if (isOpen) {
          const infoLine = isDone
            ? `<span>Kód: <strong class="mono">${escapeHtml(it.code)}</strong> · Systém: <strong>${formatQty(it.system)} j.</strong> <em>(${escapeHtml(packInfo)})</em></span>
               <span>Zadáno: <strong>${formatQty(rec.actual)} j.</strong> (${isDiff ? `<strong style="color:var(--danger)">Rozdíl ${rec.diff > 0 ? '+' : ''}${formatQty(rec.diff)} j.</strong>` : '<strong style="color:var(--brand-700)">Sedí</strong>'})</span>`
            : blindMode
              ? `<span>Kód: <strong class="mono">${escapeHtml(it.code)}</strong></span><span>Očekáváno: <strong>❓ slepá inventura</strong></span>`
              : `<span>Kód: <strong class="mono">${escapeHtml(it.code)}</strong></span><span>V systému: <strong>${formatQty(it.system)} j.</strong> <em>(${escapeHtml(packInfo)})</em></span>`;

          const defaultVal = isDone ? formatNumberRaw(rec.actual) : '';
          const step4 = Math.round(step * 4 * 1000) / 1000;
          const step10 = Math.round(step * 10 * 1000) / 1000;

          bodyHtml = `
            <div class="inv-item-body">
              <div class="inv-info-strip">${infoLine}</div>
              <form data-inv-form="${escapeHtml(it.key)}">
                ${
                  step !== 1
                    ? `<div class="inv-pack-helper">
                         <span>📦 Rychlý přepočet:</span>
                         <input type="number" min="0" step="1" inputmode="decimal" placeholder="ks" data-pack-multiplier="${step}" aria-label="Počet celých balení" />
                         <span>balení × <strong class="mono">${formatQty(step)}</strong></span>
                       </div>`
                    : ''
                }
                <div class="field">
                  <label>Fyzicky napočítáno celkem (krok po ${formatQty(step)})</label>
                  <input class="input mono" type="number" name="actual" min="0" step="any" inputmode="decimal" value="${defaultVal}" placeholder="Zadej počet v l / kg / ks…" />
                </div>

                <div class="stepper-row">
                  <button type="button" class="stepper-btn" data-step-delta="${-step}">−${formatQty(step)}</button>
                  <button type="button" class="stepper-btn" data-step-delta="${step}">+${formatQty(step)}</button>
                  <button type="button" class="stepper-btn" data-step-delta="${step4}">+${formatQty(step4)}</button>
                  <button type="button" class="stepper-btn" data-step-delta="${step10}">+${formatQty(step10)}</button>
                </div>

                <div class="inv-action-row">
                  <button type="submit" class="btn btn-primary">💾 Uložit stav</button>
                  ${
                    !blindMode
                      ? `<button type="button" class="btn" data-inv-match="${escapeHtml(it.key)}">✅ Sedí (${formatQty(it.system)} j.)</button>`
                      : isDone
                        ? `<button type="button" class="btn btn-soft-danger" data-inv-undo="${escapeHtml(it.key)}">↩ Zrušit záznam</button>`
                        : `<button type="button" class="btn" data-step-delta="${-999999}">0 (Prázdné)</button>`
                  }
                </div>
                ${
                  !blindMode && isDone
                    ? `<div style="margin-top:8px;"><button type="button" class="btn btn-soft-danger btn-sm btn-block" data-inv-undo="${escapeHtml(it.key)}">↩ Zrušit tento záznam</button></div>`
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
                <div class="inv-item-sub">Šarže: <strong class="mono">${escapeHtml(it.lot)}</strong> · ${escapeHtml(it.code)}</div>
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

  function renderDiffSummary() {
    const diffs = Object.values(ctx.state.inventory).filter((r) => r.diff !== 0);
    if (!diffs.length) {
      diffSummaryEl.innerHTML = '';
      return;
    }

    diffSummaryEl.innerHTML = `
      <div class="card" style="margin-top: 16px; border-color: var(--danger-border);">
        <div class="section-header" style="margin-bottom: 10px;">
          <h3 class="section-title" style="color: var(--danger-dark);">⚠️ Souhrn zjištěných rozdílů (${diffs.length})</h3>
        </div>
        ${diffs
          .map(
            (r) => `
          <div class="callout callout-expired" style="margin-top: 8px;">
            <span class="callout-icon">📦</span>
            <div>
              <strong>${escapeHtml(r.name)}</strong> (Šarže: <span class="mono">${escapeHtml(r.lot)}</span> · ${escapeHtml(r.section)})<br>
              Systém: <strong>${formatQty(r.system)}</strong> → Fyzicky: <strong>${formatQty(r.actual)}</strong>
              (<strong>Rozdíl: ${r.diff > 0 ? '+' : ''}${formatQty(r.diff)} j.</strong>)
            </div>
          </div>
        `
          )
          .join('')}
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
