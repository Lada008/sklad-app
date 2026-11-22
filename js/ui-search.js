/**
 * Záložka 1: Okamžité vyhledávání, našeptávač, filtry kategorií, skener čárových kódů a karty produktů.
 */

import {
  escapeHtml,
  evaluateExpiration,
  filterByWarehouse,
  formatIsoDateCz,
  formatQty,
  getTodayMidnightMs,
  groupByProduct,
  normalizeText,
  PACKAGING_TYPES,
  paletovaKalkulacka,
  prepocetNaBaleni,
  ziskejKrokBaleni,
} from './domain.js';
import { clearRecentSearches, loadRecentSearches, pushRecentSearch } from './storage.js';

const PAGE_SIZE = 25;

export function createSearchTab(ctx) {
  let query = '';
  let selectedExactName = null;
  let selectedCategory = 'all';
  let visibleLimit = PAGE_SIZE;
  let scannerStream = null;
  let scannerRaf = null;

  const panel = document.getElementById('tab-search');

  panel.innerHTML = `
    <div class="search-box-wrap">
      <div class="search-input-shell">
        <svg class="search-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="8"></circle>
          <path d="m21 21-4.3-4.3"></path>
        </svg>
        <input
          type="search"
          id="search-input"
          class="search-input"
          placeholder="Hledej přípravek, účinnou látku, šarži, reg. č. nebo sklad…"
          autocomplete="off"
          autocorrect="off"
          spellcheck="false"
          aria-label="Vyhledávání zboží"
        />
        <button type="button" id="search-clear-btn" class="search-action-btn" title="Vymazat hledání" aria-label="Vymazat hledání" hidden>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round">
            <path d="M18 6 6 18M6 6l12 12"></path>
          </svg>
        </button>
        <button type="button" id="search-scan-btn" class="search-action-btn" title="Skenovat čárový/QR kód kamerou" aria-label="Skenovat kód kamerou" hidden>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 7V5a2 2 0 0 1 2-2h2"></path>
            <path d="M17 3h2a2 2 0 0 1 2 2v2"></path>
            <path d="M21 17v2a2 2 0 0 1-2 2h-2"></path>
            <path d="M7 21H5a2 2 0 0 1-2-2v-2"></path>
            <line x1="7" y1="12" x2="17" y2="12"></line>
          </svg>
        </button>
      </div>
      <div id="search-autocomplete" class="autocomplete-list" role="listbox" hidden></div>
    </div>

    <div id="search-categories" class="chip-row" aria-label="Filtr podle kategorie"></div>
    <div id="search-results-area"></div>
  `;

  const inputEl = document.getElementById('search-input');
  const clearBtn = document.getElementById('search-clear-btn');
  const scanBtn = document.getElementById('search-scan-btn');
  const acEl = document.getElementById('search-autocomplete');
  const catEl = document.getElementById('search-categories');
  const resultsEl = document.getElementById('search-results-area');

  // Zobraz tlačítko skeneru, pokud prohlížeč podporuje kameru + BarcodeDetector
  if ('BarcodeDetector' in window && navigator.mediaDevices?.getUserMedia) {
    scanBtn.hidden = false;
  }

  let debounceTimer = null;

  inputEl.addEventListener('input', () => {
    query = inputEl.value;
    selectedExactName = null;
    visibleLimit = PAGE_SIZE;
    clearBtn.hidden = !query.length;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      renderAutocomplete();
      renderResults();
    }, 60);
  });

  inputEl.addEventListener('focus', () => {
    if (query.trim().length >= 1 && !selectedExactName) {
      renderAutocomplete();
    }
  });

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      acEl.hidden = true;
      if (query.trim().length >= 2) {
        pushRecentSearch(query.trim());
      }
      renderResults();
    } else if (e.key === 'Escape') {
      acEl.hidden = true;
    }
  });

  document.addEventListener('click', (e) => {
    if (!panel.contains(e.target)) {
      acEl.hidden = true;
    } else if (!e.target.closest('.search-box-wrap')) {
      acEl.hidden = true;
    }
  });

  clearBtn.addEventListener('click', () => {
    query = '';
    selectedExactName = null;
    visibleLimit = PAGE_SIZE;
    inputEl.value = '';
    clearBtn.hidden = true;
    acEl.hidden = true;
    inputEl.focus();
    renderResults();
  });

  scanBtn.addEventListener('click', () => openBarcodeScanner());

  acEl.addEventListener('click', (e) => {
    const itemBtn = e.target.closest('[data-ac-name]');
    if (!itemBtn) return;
    const name = itemBtn.dataset.acName;
    selectedExactName = name;
    query = name;
    inputEl.value = name;
    clearBtn.hidden = false;
    acEl.hidden = true;
    visibleLimit = PAGE_SIZE;
    pushRecentSearch(name);
    renderResults();
  });

  catEl.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-cat]');
    if (!chip) return;
    selectedCategory = chip.dataset.cat;
    visibleLimit = PAGE_SIZE;
    renderCategories();
    renderResults();
  });

  // Delegované akce uvnitř výsledků (kopírování kódu, uložení balení, řazení, report, inventura, stránkování)
  resultsEl.addEventListener('click', (e) => {
    const recentChip = e.target.closest('[data-recent]');
    if (recentChip) {
      setSearchQuery(recentChip.dataset.recent);
      return;
    }

    if (e.target.closest('#clear-recent-btn')) {
      clearRecentSearches();
      renderResults();
      return;
    }

    const sortBtn = e.target.closest('[data-batch-sort]');
    if (sortBtn) {
      ctx.setPrefs({ batchSort: sortBtn.dataset.batchSort });
      renderResults();
      return;
    }

    const codeBtn = e.target.closest('[data-copy-code]');
    if (codeBtn) {
      const code = codeBtn.dataset.copyCode;
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(code).then(() => {
          ctx.toast(`Kód ${code} zkopírován do schránky`, 'success');
        }).catch(() => {});
      }
      return;
    }

    const reportBtn = e.target.closest('[data-report-idx]');
    if (reportBtn) {
      const item = ctx.state.items[Number(reportBtn.dataset.reportIdx)];
      if (item) ctx.openReportForItem(item);
      return;
    }

    const invBtn = e.target.closest('[data-inv-product]');
    if (invBtn) {
      ctx.openInventoryForProduct(invBtn.dataset.invProduct, invBtn.dataset.invWh);
      return;
    }

    const resetPackBtn = e.target.closest('[data-reset-pack]');
    if (resetPackBtn) {
      const code = resetPackBtn.dataset.resetPack;
      ctx.deleteCustomPack(code);
      ctx.toast('Obnoveno automatické rozpoznání balení', 'success');
      return;
    }

    if (e.target.closest('#search-load-more')) {
      visibleLimit += PAGE_SIZE;
      renderResults();
    }
  });

  resultsEl.addEventListener('submit', (e) => {
    const form = e.target.closest('[data-pack-form]');
    if (!form) return;
    e.preventDefault();
    const code = form.dataset.packForm;
    const size = parseFloat(form.querySelector('input[name="velikost"]').value.replace(',', '.'));
    const obal = form.querySelector('select[name="obal"]').value;
    if (!size || size <= 0) {
      ctx.toast('Zadej platnou velikost balení (> 0).', 'danger');
      return;
    }
    ctx.setCustomPack(code, size, obal);
    ctx.toast('Nastavení balení uloženo', 'success');
  });

  function getScopedItems() {
    return filterByWarehouse(ctx.state.items, ctx.state.prefs.warehouseFilter);
  }

  function renderAutocomplete() {
    const qNorm = normalizeText(query);
    if (!qNorm || selectedExactName) {
      acEl.hidden = true;
      return;
    }
    const tokens = qNorm.split(/\s+/).filter(Boolean);
    const scoped = getScopedItems();
    const matches = scoped.filter((item) => tokens.every((t) => item._search.includes(t)));
    const products = groupByProduct(matches).slice(0, 8);

    if (products.length < 2) {
      acEl.hidden = true;
      return;
    }

    acEl.innerHTML = products
      .map(
        (p) => `
      <button type="button" class="ac-item" role="option" data-ac-name="${escapeHtml(p.name)}">
        <div>
          <div class="ac-item-name">${escapeHtml(p.name)}</div>
          <div class="ac-item-meta">${escapeHtml(p.code)} · ${p.cat.icon} ${escapeHtml(p.cat.label)} · ${p.batches.length} ${p.batches.length === 1 ? 'šarže' : p.batches.length <= 4 ? 'šarže' : 'šarží'}</div>
        </div>
        <span class="ac-item-qty">${formatQty(p.totalQty)} j.</span>
      </button>
    `
      )
      .join('');
    acEl.hidden = false;
  }

  function renderCategories() {
    const scoped = getScopedItems();
    const counts = new Map();
    const labels = new Map();
    const seenProdPerCat = new Map();

    for (const item of scoped) {
      const k = item._cat.key;
      if (!seenProdPerCat.has(k)) {
        seenProdPerCat.set(k, new Set());
        labels.set(k, item._cat);
      }
      seenProdPerCat.get(k).add(item.c);
    }

    for (const [k, set] of seenProdPerCat.entries()) {
      counts.set(k, set.size);
    }

    const totalProds = new Set(scoped.map((i) => i.c)).size;
    const sortedCats = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);

    if (selectedCategory !== 'all' && !counts.has(selectedCategory)) {
      selectedCategory = 'all';
    }

    const chips = [
      `<button type="button" class="chip ${selectedCategory === 'all' ? 'is-active' : ''}" data-cat="all">Vše <span class="chip-count">${totalProds}</span></button>`,
      ...sortedCats.map(([key, cnt]) => {
        const info = labels.get(key);
        return `<button type="button" class="chip ${selectedCategory === key ? 'is-active' : ''}" data-cat="${escapeHtml(key)}">${info.icon} ${escapeHtml(info.label)} <span class="chip-count">${cnt}</span></button>`;
      }),
    ];

    catEl.innerHTML = chips.join('');
  }

  function renderResults() {
    const scoped = getScopedItems();
    if (ctx.state.items.length === 0) {
      resultsEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">📦</div>
          <h3>Žádná skladová data</h3>
          <p>Nahraj export <strong>sklad.xlsx</strong> z Business Central v záložce <strong>Data</strong>.</p>
        </div>
      `;
      return;
    }

    const qTrim = query.trim();
    const hasFilter = Boolean(qTrim || selectedExactName || selectedCategory !== 'all');

    if (!hasFilter) {
      const recents = loadRecentSearches();
      const recentHtml = recents.length
        ? `
          <div class="recent-block">
            <div class="recent-head">
              <span>Naposledy hledáno</span>
              <button type="button" id="clear-recent-btn" class="btn btn-ghost btn-sm">Vymazat</button>
            </div>
            <div class="chip-row chip-row-wrap">
              ${recents.map((r) => `<button type="button" class="chip" data-recent="${escapeHtml(r)}">🕒 ${escapeHtml(r)}</button>`).join('')}
            </div>
          </div>
        `
        : '';

      resultsEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🔎</div>
          <h3>Rychlé vyhledávání ve skladu</h3>
          <p>Napiš název přípravku, kód, šarži nebo více slov najednou (např. <strong>Folpan Valmez</strong>, <strong>Bizon 151BO</strong>), případně vyber kategorii výše.</p>
        </div>
        ${recentHtml}
      `;
      return;
    }

    let filtered = scoped;
    if (selectedCategory !== 'all') {
      filtered = filtered.filter((i) => i._cat.key === selectedCategory);
    }

    if (selectedExactName) {
      filtered = filtered.filter((i) => i.n === selectedExactName);
    } else if (qTrim) {
      const tokens = normalizeText(qTrim).split(/\s+/).filter(Boolean);
      filtered = filtered.filter((item) => tokens.every((t) => item._search.includes(t)));
    }

    const products = groupByProduct(filtered);

    if (products.length === 0) {
      resultsEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🔍</div>
          <h3>Nic nebylo nalezeno</h3>
          <p>Pro hledání <strong>„${escapeHtml(qTrim || selectedCategory)}“</strong> není na vybraném skladu žádný zůstatek.</p>
        </div>
      `;
      return;
    }

    const batchSort = ctx.state.prefs.batchSort || 'qty';
    const shown = products.slice(0, visibleLimit);
    const remaining = products.length - shown.length;
    const todayMs = getTodayMidnightMs();
    const customPacks = ctx.state.customPacks;

    const toolbarHtml = `
      <div class="results-bar">
        <span>Nalezeno produktů: <strong>${products.length}</strong>${remaining > 0 ? ` (zobrazeno ${shown.length})` : ''}</span>
        <div class="sort-pills" role="group" aria-label="Řazení šarží">
          <button type="button" class="sort-pill ${batchSort === 'qty' ? 'is-active' : ''}" data-batch-sort="qty">Dle množství</button>
          <button type="button" class="sort-pill ${batchSort === 'fefo' ? 'is-active' : ''}" data-batch-sort="fefo">FEFO (expirace)</button>
        </div>
      </div>
    `;

    const cardsHtml = shown.map((prod) => renderProductCard(prod, batchSort, todayMs, customPacks)).join('');
    const loadMoreHtml =
      remaining > 0
        ? `<button type="button" id="search-load-more" class="btn btn-block">Zobrazit další produkty (zbývá ${remaining})</button>`
        : '';

    resultsEl.innerHTML = toolbarHtml + cardsHtml + loadMoreHtml;
  }

  function renderProductCard(prod, batchSort, todayMs, customPacks) {
    const packText = prepocetNaBaleni(prod.code, prod.name, prod.totalQty, customPacks);
    const palletText = paletovaKalkulacka(prod.code, prod.name, prod.totalQty, customPacks);

    // FEFO: nejbližší šarže s datem expirace
    const withExp = prod.batches
      .filter((b) => b.exp)
      .sort((a, b) => (a.exp < b.exp ? -1 : a.exp > b.exp ? 1 : 0));

    let fefoHtml = '';
    if (withExp.length > 0) {
      const top = withExp[0];
      const expInfo = evaluateExpiration(top.exp, todayMs);
      if (expInfo.status === 'expired') {
        fefoHtml = `
          <div class="callout callout-expired">
            <span class="callout-icon">⚠️</span>
            <div>
              <strong>POZOR — EXPIROVÁNO!</strong><br>
              Šarže <span class="lot-pill is-expired">${escapeHtml(top.lot)}</span>
              na lokaci <strong>${escapeHtml(top._locDisplay)}</strong>
              (exp. <strong>${expInfo.dateCz}</strong> — před ${Math.abs(expInfo.days)} dny). Zkontroluj před výdejem!
            </div>
          </div>
        `;
      } else {
        fefoHtml = `
          <div class="callout callout-fefo">
            <span class="callout-icon">👉</span>
            <div>
              <strong>FEFO VÝDEJ (vydat nejdříve):</strong><br>
              Šarže <span class="lot-pill">${escapeHtml(top.lot)}</span>
              na lokaci <strong>${escapeHtml(top._locDisplay)}</strong>
              (exp. <strong>${expInfo.dateCz}</strong> — zbývá ${expInfo.days} dní)
            </div>
          </div>
        `;
      }
    }

    const palletHtml = palletText
      ? `<div class="callout callout-pallet"><span class="callout-icon">🚜</span><div>${escapeHtml(palletText)}</div></div>`
      : '';

    const sortedBatches = [...prod.batches].sort((a, b) => {
      if (batchSort === 'fefo') {
        const ea = a.exp || '9999-99-99';
        const eb = b.exp || '9999-99-99';
        if (ea !== eb) return ea < eb ? -1 : 1;
      }
      return b.q - a.q;
    });

    const batchesHtml = sortedBatches
      .map((b) => {
        const bPack = prepocetNaBaleni(prod.code, prod.name, b.q, customPacks);
        const expInfo = evaluateExpiration(b.exp, todayMs);
        const recDate = formatIsoDateCz(b.rec);
        return `
          <div class="batch-row ${expInfo.status === 'expired' ? 'is-expired' : ''}">
            <div class="batch-top">
              <span class="batch-loc">${escapeHtml(b._locDisplay)}</span>
              <span class="batch-qty num">${formatQty(b.q)} j. <span class="batch-qty-pack">(${escapeHtml(bPack)})</span></span>
            </div>
            <div class="batch-meta">
              <div class="batch-meta-items">
                <span>Šarže: <strong class="mono">${escapeHtml(b.lot)}</strong></span>
                <span class="exp-pill is-${expInfo.status}">${escapeHtml(expInfo.badge)}</span>
                <span>Příjem: <span class="num">${recDate}</span></span>
              </div>
              <div class="batch-actions">
                <button type="button" class="batch-action-link" data-report-idx="${b._idx}" title="Nahlásit nesrovnalost k této šarži">⚠️ Hlásit</button>
                <button type="button" class="batch-action-link" data-inv-product="${escapeHtml(prod.name)}" data-inv-wh="${escapeHtml(b.wh)}" title="Otevřít v inventuře">📋 Inventura</button>
              </div>
            </div>
          </div>
        `;
      })
      .join('');

    const defaultSize = ziskejKrokBaleni(prod.code, prod.name, customPacks);
    const hasCustom = Boolean(customPacks[prod.code]);
    const defaultObal = customPacks[prod.code]?.obal || 'automaticky';
    const porHtml = renderPorPanel(prod.por);

    return `
      <article class="product-card">
        <div class="product-head">
          <div>
            <h2 class="product-name">${escapeHtml(prod.name)}</h2>
            <div class="product-subrow">
              <button type="button" class="code-chip" data-copy-code="${escapeHtml(prod.code)}" title="Kliknutím zkopíruješ kód">
                <span>${escapeHtml(prod.code)}</span>
                <span aria-hidden="true">⧉</span>
              </button>
              ${prod.por?.reg && prod.por.reg !== '-' ? `<span class="code-chip" title="Registrační číslo ÚKZÚZ">ÚKZÚZ: ${escapeHtml(prod.por.reg)}</span>` : ''}
              ${prod.por?.eco ? '<span class="exp-pill is-ok">🌱 EKO</span>' : ''}
              ${hasCustom ? '<span class="exp-pill is-ok">Vlastní balení</span>' : ''}
            </div>
          </div>
          <span class="cat-badge">${prod.cat.icon} ${escapeHtml(prod.cat.label)}</span>
        </div>

        <div class="stock-metrics">
          <div class="metric-tile">
            <div class="metric-label">Skladem celkem</div>
            <div class="metric-value num">${formatQty(prod.totalQty)} j.</div>
          </div>
          <div class="metric-tile">
            <div class="metric-label">V přepočtu</div>
            <div class="metric-value is-pack">${escapeHtml(packText)}</div>
          </div>
        </div>

        ${palletHtml}
        ${fefoHtml}
        ${porHtml}

        <div class="batch-section-label">Rozpis po lokacích a šaržích (${prod.batches.length})</div>
        <div class="batch-list">${batchesHtml}</div>

        <details class="pack-details">
          <summary>⚙️ Upravit přepočet balení pro tento produkt</summary>
          <form class="pack-form" data-pack-form="${escapeHtml(prod.code)}">
            <div class="field">
              <label>Velikost 1 balení (l / kg)</label>
              <input class="input mono" type="number" name="velikost" step="any" min="0.001" value="${defaultSize}" required />
            </div>
            <div class="field">
              <label>Typ obalu</label>
              <select class="select" name="obal">
                ${PACKAGING_TYPES.map((opt) => `<option value="${opt.value}" ${opt.value === defaultObal ? 'selected' : ''}>${opt.label}</option>`).join('')}
              </select>
            </div>
            <div class="pack-form-actions">
              <button type="submit" class="btn btn-primary btn-sm">💾 Uložit pro produkt</button>
              ${hasCustom ? `<button type="button" class="btn btn-sm" data-reset-pack="${escapeHtml(prod.code)}">Obnovit automatiku</button>` : ''}
            </div>
          </form>
        </details>
      </article>
    `;
  }

  function renderPorPanel(por) {
    if (!por) return '';

    const isStockUse = por.status === 'Do spotřebování zásob';
    const statusClass = isStockUse ? 'is-warning' : 'is-ok';

    const validStr = por.validTo ? formatIsoDateCz(por.validTo) : null;
    const marketStr = por.marketTo ? formatIsoDateCz(por.marketTo) : null;
    const useStr = por.useTo ? formatIsoDateCz(por.useTo) : null;

    const datesParts = [];
    if (validStr) datesParts.push(`Platnost do <strong>${validStr}</strong>`);
    if (isStockUse && marketStr) datesParts.push(`Doprodej do <strong>${marketStr}</strong>`);
    if (useStr && (isStockUse || useStr !== validStr)) {
      datesParts.push(`Spotřeba zásob max. do <strong>${useStr}</strong>`);
    }

    const phoRestricted = Boolean(por.pho?.restricted);
    const phoClass = phoRestricted ? 'is-pho-restricted' : 'is-ok';
    const phoBadge = phoRestricted
      ? `💧 PHO: ${escapeHtml(por.pho.code || 'Omezení')}`
      : '💧 PHO: Bez omezení';

    const beeLevel = por.bees?.level || 'ok';
    const beeClass =
      beeLevel === 'danger'
        ? 'is-expired'
        : beeLevel === 'warn'
          ? 'is-warning'
          : beeLevel === 'info'
            ? 'is-pho-restricted'
            : 'is-ok';
    const beeBadge =
      beeLevel === 'danger'
        ? '🐝 ZNV — Zvlášť nebezpečný pro včely'
        : beeLevel === 'warn'
          ? '🐝 NV — Nebezpečný pro včely'
          : beeLevel === 'info'
            ? '🐝 DO — Opylovači'
            : '🐝 Včely: Bez označení';

    const ulHtml = por.ul?.length
      ? `<div class="por-row">
           <span class="por-label">Účinné látky:</span>
           <span class="por-val">${por.ul
             .map((u) => `<strong>${escapeHtml(u.n)}</strong>${u.c ? ` <span class="mono">${escapeHtml(u.c)}</span>` : ''}`)
             .join(' · ')}</span>
         </div>`
      : '';

    const groupsHtml = por.groups?.length
      ? `<div class="por-row">
           <span class="por-label">Chemická skupina:</span>
           <span class="por-val">${escapeHtml(por.groups.join(', '))}</span>
         </div>`
      : '';

    const showDetails = phoRestricted || beeLevel !== 'ok';
    const detailsHtml = showDetails
      ? `<details class="por-legal-details">
           <summary>Zobrazit přesné znění omezení PHO a rizika pro včely</summary>
           <div class="por-legal-body">
             <div><strong>Ochranná pásma vod (PHO):</strong> ${escapeHtml(por.pho?.text || 'Bez omezení')}</div>
             <div><strong>Riziko pro včely:</strong> ${escapeHtml(por.bees?.text || 'Bez označení')}</div>
           </div>
         </details>`
      : '';

    return `
      <div class="por-panel ${isStockUse ? 'is-stock-use' : ''}">
        <div class="por-header">
          <span class="por-title">🏛️ Registr ÚKZÚZ · ${escapeHtml(por.name)}</span>
          <span class="exp-pill ${statusClass}">${escapeHtml(por.status)}</span>
        </div>
        ${datesParts.length ? `<div class="por-dates">${datesParts.join(' &nbsp;|&nbsp; ')}</div>` : ''}
        <div class="por-pills">
          <span class="exp-pill ${phoClass}">${phoBadge}</span>
          <span class="exp-pill ${beeClass}">${beeBadge}</span>
        </div>
        ${ulHtml}
        ${groupsHtml}
        ${detailsHtml}
      </div>
    `;
  }

  // --- Skener čárových kódů ---
  async function openBarcodeScanner() {
    const modal = document.getElementById('scanner-modal');
    const video = document.getElementById('scanner-video');
    const status = document.getElementById('scanner-status');
    const closeBtn = document.getElementById('scanner-close-btn');

    modal.hidden = false;
    status.textContent = 'Spouštím zadní kameru…';

    const stopScanner = () => {
      if (scannerRaf) cancelAnimationFrame(scannerRaf);
      scannerRaf = null;
      if (scannerStream) {
        scannerStream.getTracks().forEach((t) => t.stop());
        scannerStream = null;
      }
      video.srcObject = null;
      modal.hidden = true;
    };

    closeBtn.onclick = stopScanner;
    modal.onclick = (e) => {
      if (e.target === modal) stopScanner();
    };

    try {
      scannerStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      video.srcObject = scannerStream;
      await video.play();
      status.textContent = 'Namiř na čárový kód nebo QR kód produktu / šarže…';

      const detector = new window.BarcodeDetector();
      const tick = async () => {
        if (!scannerStream) return;
        try {
          const codes = await detector.detect(video);
          if (codes.length > 0 && codes[0].rawValue) {
            const val = codes[0].rawValue.trim();
            stopScanner();
            setSearchQuery(val);
            ctx.toast(`Naskenováno: ${val}`, 'success');
            return;
          }
        } catch {
          // ignore frame error
        }
        scannerRaf = requestAnimationFrame(tick);
      };
      scannerRaf = requestAnimationFrame(tick);
    } catch {
      status.textContent = 'Nepodařilo se spustit kameru. Zkontroluj oprávnění prohlížeče.';
    }
  }

  function setSearchQuery(text, exact = false) {
    query = text || '';
    selectedExactName = exact ? text : null;
    selectedCategory = 'all';
    visibleLimit = PAGE_SIZE;
    inputEl.value = query;
    clearBtn.hidden = !query.length;
    acEl.hidden = true;
    if (query.trim().length >= 2) pushRecentSearch(query.trim());
    renderCategories();
    renderResults();
  }

  function render() {
    renderCategories();
    renderResults();
  }

  return { render, setSearchQuery };
}
