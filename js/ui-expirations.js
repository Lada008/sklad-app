/**
 * Záložka 2: Hlídač expirací & FEFO přehled.
 * Okamžitý přehled expirovaných a brzy expirujících šarží s exportem do CSV.
 */

import {
  escapeHtml,
  evaluateExpiration,
  filterByWarehouse,
  formatIsoDateCz,
  formatQty,
  getCzechFileTimestamp,
  getTodayMidnightMs,
  normalizeText,
  prepocetNaBaleni,
  toCsv,
  triggerFileDownload,
} from './domain.js';

export function createExpirationsTab(ctx) {
  let activeBucket = 'expired'; // 'expired' | '90' | '180' | '365'
  let filterText = '';

  const panel = document.getElementById('tab-expirations');

  panel.innerHTML = `
    <div class="section-header">
      <div>
        <h2 class="section-title">Hlídač expirací &amp; FEFO</h2>
        <p class="section-sub">Šarže seřazené od nejbližší expirace podle vybraného skladu.</p>
      </div>
      <button type="button" id="exp-export-btn" class="btn btn-sm">📥 Export CSV</button>
    </div>

    <div id="exp-summary" class="exp-summary-grid" role="tablist" aria-label="Pásma expirace"></div>

    <div class="search-box-wrap" style="margin-bottom: 12px;">
      <div class="search-input-shell">
        <svg class="search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="8"></circle>
          <path d="m21 21-4.3-4.3"></path>
        </svg>
        <input type="search" id="exp-filter-input" class="search-input" placeholder="Filtrovat v expiracích (název, šarže, lokace)…" autocomplete="off" />
      </div>
    </div>

    <div id="exp-list"></div>
  `;

  const summaryEl = document.getElementById('exp-summary');
  const filterInput = document.getElementById('exp-filter-input');
  const listEl = document.getElementById('exp-list');
  const exportBtn = document.getElementById('exp-export-btn');

  filterInput.addEventListener('input', () => {
    filterText = filterInput.value;
    renderList();
  });

  summaryEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-bucket]');
    if (!btn) return;
    activeBucket = btn.dataset.bucket;
    render();
  });

  listEl.addEventListener('click', (e) => {
    const detailBtn = e.target.closest('[data-goto-product]');
    if (detailBtn) {
      ctx.openSearchForProduct(detailBtn.dataset.gotoProduct);
      return;
    }
    const reportBtn = e.target.closest('[data-report-idx]');
    if (reportBtn) {
      const item = ctx.state.items[Number(reportBtn.dataset.reportIdx)];
      if (item) ctx.openReportForItem(item);
    }
  });

  exportBtn.addEventListener('click', () => {
    const { list } = getBucketedData();
    if (!list.length) {
      ctx.toast('V tomto pásmu nejsou žádné položky k exportu.', 'warn');
      return;
    }
    const customPacks = ctx.state.customPacks;
    const headers = ['Kód zboží', 'Popis', 'Lokace', 'Fyzický sklad', 'Šarže', 'Datum expirace', 'Zbývá dní', 'Množství', 'Přepočet balení', 'Poslední příjem'];
    const rows = list.map(({ item, exp }) => [
      item.c,
      item.n,
      item.ln,
      item.wh,
      item.lot,
      exp.dateCz,
      exp.days,
      item.q,
      prepocetNaBaleni(item.c, item.n, item.q, customPacks),
      formatIsoDateCz(item.rec),
    ]);
    const csv = toCsv(headers, rows, ';');
    triggerFileDownload(csv, `expirace_${activeBucket}_${getCzechFileTimestamp()}.csv`);
    ctx.toast(`Exportováno ${list.length} šarží do CSV`, 'success');
  });

  function getBucketedData() {
    const scoped = filterByWarehouse(ctx.state.items, ctx.state.prefs.warehouseFilter);
    const todayMs = getTodayMidnightMs();
    const buckets = { expired: [], '90': [], '180': [], '365': [] };

    for (const item of scoped) {
      if (!item.exp) continue;
      const exp = evaluateExpiration(item.exp, todayMs);
      if (exp.days === null) continue;
      if (exp.days < 0) buckets.expired.push({ item, exp });
      else if (exp.days <= 90) buckets['90'].push({ item, exp });
      else if (exp.days <= 180) buckets['180'].push({ item, exp });
      else if (exp.days <= 365) buckets['365'].push({ item, exp });
    }

    for (const key of Object.keys(buckets)) {
      buckets[key].sort((a, b) => a.exp.days - b.exp.days);
    }

    // Pokud je výchozí bucket prázdný a uživatel ještě neklikl, ponecháme ho vybraný ale čitelný
    let list = buckets[activeBucket] || [];
    const fNorm = normalizeText(filterText);
    if (fNorm) {
      const tokens = fNorm.split(/\s+/).filter(Boolean);
      list = list.filter(({ item }) => tokens.every((t) => item._search.includes(t)));
    }

    return { buckets, list };
  }

  function render() {
    const { buckets } = getBucketedData();

    const defs = [
      { key: 'expired', label: 'Expirováno', tone: 'is-danger', count: buckets.expired.length },
      { key: '90', label: 'Do 90 dní', tone: 'is-danger', count: buckets['90'].length },
      { key: '180', label: '3–6 měsíců', tone: 'is-warn', count: buckets['180'].length },
      { key: '365', label: '6–12 měsíců', tone: 'is-soon', count: buckets['365'].length },
    ];

    summaryEl.innerHTML = defs
      .map(
        (d) => `
      <button type="button" class="exp-stat-btn ${activeBucket === d.key ? 'is-active' : ''}" data-bucket="${d.key}" role="tab" aria-selected="${activeBucket === d.key}">
        <span class="exp-stat-num ${d.tone}">${d.count}</span>
        <span class="exp-stat-lbl">${d.label}</span>
      </button>
    `
      )
      .join('');

    renderList();
  }

  function renderList() {
    const { list } = getBucketedData();
    const customPacks = ctx.state.customPacks;

    if (list.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">✅</div>
          <h3>V tomto pásmu je čisto</h3>
          <p>Žádná šarže neodpovídá vybranému filtru expirace.</p>
        </div>
      `;
      return;
    }

    listEl.innerHTML = list
      .map(({ item, exp }) => {
        const pack = prepocetNaBaleni(item.c, item.n, item.q, customPacks);
        return `
          <article class="exp-card ${exp.status === 'expired' ? 'is-expired' : ''}">
            <div class="exp-card-top">
              <div>
                <div class="exp-card-title">${escapeHtml(item.n)}</div>
                <div style="font-size: 0.78rem; color: var(--ink-muted); margin-top: 2px;">
                  <span class="mono">${escapeHtml(item.c)}</span> · ${item._cat.icon} ${escapeHtml(item._cat.label)}
                </div>
              </div>
              <span class="exp-pill is-${exp.status}">${escapeHtml(exp.badge)}</span>
            </div>
            <div class="batch-top">
              <span class="batch-loc">${escapeHtml(item._locDisplay)}</span>
              <span class="batch-qty num">${formatQty(item.q)} j. <span class="batch-qty-pack">(${escapeHtml(pack)})</span></span>
            </div>
            <div class="batch-meta">
              <div class="batch-meta-items">
                <span>Šarže: <strong class="mono">${escapeHtml(item.lot)}</strong></span>
                <span>Příjem: <span class="num">${formatIsoDateCz(item.rec)}</span></span>
              </div>
              <div class="batch-actions">
                <button type="button" class="batch-action-link" data-goto-product="${escapeHtml(item.n)}">🔍 Detail</button>
                <button type="button" class="batch-action-link" data-report-idx="${item._idx}">⚠️ Hlásit</button>
              </div>
            </div>
          </article>
        `;
      })
      .join('');
  }

  return { render };
}
