/**
 * Záložka 4: Hlášení nesrovnalostí mimo inventuru.
 * Podporuje předvyplnění přímo z karty šarže, rychlé štítky důvodů a export CSV.
 */

import {
  escapeHtml,
  formatNumberRaw,
  formatQty,
  getCzechFileTimestamp,
  getCzechNowStr,
  REPORT_LOCATIONS,
  toCsv,
  triggerFileDownload,
} from './domain.js';
import { saveReports } from './storage.js';

const QUICK_REASONS = [
  'Rozbitý obal',
  'Záměna šarže',
  'Chybí fyzicky',
  'Přebývá fyzicky',
  'Poškozená etiketa',
  'Expirované zboží',
];

export function createReportsTab(ctx) {
  const panel = document.getElementById('tab-reports');

  panel.innerHTML = `
    <div class="section-header">
      <div>
        <h2 class="section-title">Hlášení nesrovnalosti</h2>
        <p class="section-sub">Narazil jsi na rozdíl, rozbitý kanystr nebo záměnu šarže? Zapiš ho sem.</p>
      </div>
      <button type="button" id="rep-export-btn" class="btn btn-sm">📥 Export CSV</button>
    </div>

    <div class="card">
      <form id="report-form" class="form-stack">
        <div class="field">
          <label for="rep-product">Název nebo kód zboží *</label>
          <input id="rep-product" class="input" list="rep-product-datalist" placeholder="Vyber ze seznamu nebo napiš ručně…" required autocomplete="off" />
          <datalist id="rep-product-datalist"></datalist>
          <input type="hidden" id="rep-code" />
        </div>

        <div id="rep-batch-suggestions" hidden></div>

        <div class="form-grid-2">
          <div class="field">
            <label for="rep-location">Kde zboží leží</label>
            <select id="rep-location" class="select">
              ${REPORT_LOCATIONS.map((l) => `<option value="${escapeHtml(l)}">${escapeHtml(l)}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label for="rep-lot">Číslo šarže</label>
            <input id="rep-lot" class="input mono" placeholder="např. 268969" autocomplete="off" />
          </div>
        </div>

        <div class="form-grid-2">
          <div class="field">
            <label for="rep-system">Stav v systému (l / kg)</label>
            <input id="rep-system" class="input mono" type="number" min="0" step="any" inputmode="decimal" value="0" />
          </div>
          <div class="field">
            <label for="rep-actual">Fyzicky napočítáno</label>
            <input id="rep-actual" class="input mono" type="number" min="0" step="any" inputmode="decimal" value="0" />
          </div>
        </div>

        <div class="field">
          <label>Rychlý důvod</label>
          <div class="chip-row chip-row-wrap" id="rep-reason-chips">
            ${QUICK_REASONS.map((r) => `<button type="button" class="chip" data-reason="${escapeHtml(r)}">+ ${escapeHtml(r)}</button>`).join('')}
          </div>
        </div>

        <div class="field">
          <label for="rep-note">Poznámka</label>
          <textarea id="rep-note" class="textarea" placeholder="Např. rozbitý 5l kanystr, záměna šarže…"></textarea>
        </div>

        <button type="submit" class="btn btn-primary btn-block">💾 Uložit hlášení</button>
      </form>
    </div>

    <div id="rep-history" style="margin-top: 16px;"></div>
  `;

  const form = document.getElementById('report-form');
  const productInput = document.getElementById('rep-product');
  const productDatalist = document.getElementById('rep-product-datalist');
  const codeInput = document.getElementById('rep-code');
  const batchSuggEl = document.getElementById('rep-batch-suggestions');
  const locationSelect = document.getElementById('rep-location');
  const lotInput = document.getElementById('rep-lot');
  const systemInput = document.getElementById('rep-system');
  const actualInput = document.getElementById('rep-actual');
  const noteInput = document.getElementById('rep-note');
  const reasonChips = document.getElementById('rep-reason-chips');
  const historyEl = document.getElementById('rep-history');
  const exportBtn = document.getElementById('rep-export-btn');

  productInput.addEventListener('change', () => updateBatchSuggestions());
  productInput.addEventListener('input', () => {
    codeInput.value = '';
    updateBatchSuggestions();
  });

  batchSuggEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-pick-batch]');
    if (!btn) return;
    const item = ctx.state.items[Number(btn.dataset.pickBatch)];
    if (item) prefillFromItem(item);
  });

  reasonChips.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-reason]');
    if (!btn) return;
    const text = btn.dataset.reason;
    const cur = noteInput.value.trim();
    noteInput.value = cur ? `${cur}, ${text}` : text;
    noteInput.focus();
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = productInput.value.trim();
    if (!name) {
      ctx.toast('Vyber nebo napiš název zboží.', 'danger');
      return;
    }

    const system = parseFloat(systemInput.value.replace(',', '.')) || 0;
    const actual = parseFloat(actualInput.value.replace(',', '.')) || 0;
    const diff = Math.round((actual - system) * 1000) / 1000;

    // Pokud nebyl kód předvyplněn, zkusíme ho najít podle přesného názvu
    let code = codeInput.value.trim();
    if (!code) {
      const found = ctx.state.items.find((i) => i.n === name);
      if (found) code = found.c;
    }

    const record = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      time: getCzechNowStr(),
      code,
      name,
      location: locationSelect.value,
      lot: lotInput.value.trim() || '-',
      system,
      actual,
      diff,
      note: noteInput.value.trim(),
    };

    ctx.state.reports.unshift(record);
    saveReports(ctx.state.reports);

    form.reset();
    codeInput.value = '';
    systemInput.value = '0';
    actualInput.value = '0';
    batchSuggEl.hidden = true;

    ctx.toast('✅ Hlášení bylo úspěšně uloženo', 'success');
    ctx.updateBadges();
    renderHistory();
  });

  historyEl.addEventListener('click', (e) => {
    const delBtn = e.target.closest('[data-delete-report]');
    if (!delBtn) return;
    const id = delBtn.dataset.deleteReport;
    ctx.state.reports = ctx.state.reports.filter((r) => r.id !== id);
    saveReports(ctx.state.reports);
    ctx.toast('Hlášení bylo odstraněno', 'warn');
    ctx.updateBadges();
    renderHistory();
  });

  exportBtn.addEventListener('click', () => {
    const list = ctx.state.reports;
    if (!list.length) {
      ctx.toast('Zatím nejsou uložena žádná hlášení.', 'warn');
      return;
    }
    const headers = ['Čas hlášení', 'Kód zboží', 'Popis', 'Lokace', 'Číslo šarže', 'Stav systém', 'Stav fyzicky', 'Rozdíl', 'Poznámka'];
    const rows = list.map((r) => [r.time, r.code, r.name, r.location, r.lot, r.system, r.actual, r.diff, r.note]);
    const csv = toCsv(headers, rows, ';');
    triggerFileDownload(csv, `nesrovnalosti_sklad_${getCzechFileTimestamp()}.csv`);
    ctx.toast(`Exportováno ${list.length} hlášení do CSV`, 'success');
  });

  function ensureLocationOption(locLabel) {
    if (!locLabel) return;
    const exists = Array.from(locationSelect.options).some((o) => o.value === locLabel);
    if (!exists) {
      const opt = document.createElement('option');
      opt.value = locLabel;
      opt.textContent = locLabel;
      locationSelect.appendChild(opt);
    }
    locationSelect.value = locLabel;
  }

  function updateBatchSuggestions() {
    const val = productInput.value.trim();
    if (!val) {
      batchSuggEl.hidden = true;
      return;
    }
    const matches = ctx.state.items.filter((i) => i.n === val).slice(0, 6);
    if (!matches.length) {
      batchSuggEl.hidden = true;
      return;
    }
    batchSuggEl.hidden = false;
    batchSuggEl.innerHTML = `
      <div style="font-size:0.76rem;font-weight:700;color:var(--ink-muted);margin-bottom:5px;">Předvyplnit ze skladové šarže:</div>
      <div class="chip-row chip-row-wrap">
        ${matches
          .map(
            (m) => `
          <button type="button" class="chip" data-pick-batch="${m._idx}">
            ${escapeHtml(m._locDisplay)} · <span class="mono">${escapeHtml(m.lot)}</span> (${formatQty(m.q)} j.)
          </button>
        `
          )
          .join('')}
      </div>
    `;
  }

  function prefillFromItem(item) {
    productInput.value = item.n;
    codeInput.value = item.c;
    ensureLocationOption(item._locDisplay);
    lotInput.value = item.lot === '-' ? '' : item.lot;
    systemInput.value = formatNumberRaw(item.q);
    actualInput.value = '';
    batchSuggEl.hidden = true;
    actualInput.focus();
  }

  function renderDatalist() {
    const uniqueNames = Array.from(new Set(ctx.state.items.map((i) => i.n))).sort((a, b) =>
      a.localeCompare(b, 'cs')
    );
    productDatalist.innerHTML = uniqueNames.map((n) => `<option value="${escapeHtml(n)}"></option>`).join('');
  }

  function renderHistory() {
    const list = ctx.state.reports;
    if (!list.length) {
      historyEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">📝</div>
          <h3>Zatím žádná uložená hlášení</h3>
          <p>Uložená hlášení nesrovnalostí se zobrazí zde a půjdou exportovat do CSV.</p>
        </div>
      `;
      return;
    }

    historyEl.innerHTML = `
      <div class="section-header" style="margin-bottom: 10px;">
        <h3 class="section-title">Uložená hlášení (${list.length})</h3>
      </div>
      ${list
        .map((r) => {
          const sign = r.diff > 0 ? '+' : '';
          const diffClass = r.diff === 0 ? 'is-ok' : 'is-diff';
          return `
            <article class="report-card">
              <div class="report-card-head">
                <div>
                  <div style="font-weight:800;font-size:0.95rem;">${escapeHtml(r.name)}</div>
                  <div style="font-size:0.78rem;color:var(--ink-muted);margin-top:2px;">
                    ${escapeHtml(r.time)} · ${escapeHtml(r.location)}${r.code ? ` · <span class="mono">${escapeHtml(r.code)}</span>` : ''}
                  </div>
                </div>
                <span class="diff-badge ${diffClass}">${sign}${formatQty(r.diff)} j.</span>
              </div>
              <div class="batch-meta" style="margin-top: 8px;">
                <div class="batch-meta-items">
                  <span>Šarže: <strong class="mono">${escapeHtml(r.lot)}</strong></span>
                  <span>Systém: <strong>${formatQty(r.system)}</strong> → Fyzicky: <strong>${formatQty(r.actual)}</strong></span>
                </div>
                <button type="button" class="batch-action-link" data-delete-report="${escapeHtml(r.id)}">🗑️ Smazat</button>
              </div>
              ${r.note ? `<div class="report-note">${escapeHtml(r.note)}</div>` : ''}
            </article>
          `;
        })
        .join('')}
    `;
  }

  function render() {
    renderDatalist();
    renderHistory();
  }

  return { render, prefillFromItem };
}
