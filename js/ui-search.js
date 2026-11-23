/**
 * Záložka 1: Katalog & mobilní pohled obchodníka / skladníka.
 * - Okamžité vyhledávání (název, účinná látka, šarže, reg. č., sklad)
 * - Rychlé záložky podle plodin (stříkání): Vše | Obiloviny | Řepka | Réva vinná | Kukuřice | Brambory/Cukrovka | Sady/Zelenina | Ostatní
 * - Multiselect filtr podle účinné látky s našeptávačem
 * - Bezpečnostní přepínače: Pouze skladem (> 0 MJ), Povolené v OP II. st. (vody), Bezpečné pro včely
 * - Výrazné barevné štítky OP II. st. a Včely: ZNV / NV / SPe8 na každé kartě
 * - Funkce „Alternativy skladem“ (1. Přesná náhrada se stejnou účinnou látkou + porovnání koncentrace, 2. Alternativa ze stejné chemické skupiny + stejná plodina) při respektování aktivních filtrů
 */

import {
  buildWhatsAppUrl,
  escapeHtml,
  evaluateExpiration,
  extractPorDoseOptions,
  filterByWarehouse,
  formatIsoDateCz,
  formatQty,
  formatQtyWithUnit,
  getPackagingInfo,
  getTodayMidnightMs,
  groupByProduct,
  normalizeText,
  PACKAGING_TYPES,
  paletovaKalkulacka,
  parseCategory,
  prepocetNaBaleni,
  shareOrCopyText,
  ziskejKrokBaleni,
} from './domain.js';
import { clearRecentSearches, loadRecentSearches, pushRecentSearch } from './storage.js';
import { buildAgromanualUrl } from './gas-api.js';
import {
  CROP_CATEGORIES,
  CROP_CATEGORY_LABELS,
  findCatalogAlternatives,
  findStockAlternatives,
  matchesActiveSubstances,
  matchesPorSafetyAndCrop,
} from './ukzuz.js';

const PAGE_SIZE = 25;

export function createSearchTab(ctx) {
  let query = '';
  let selectedExactName = null;
  let selectedCategory = 'all';
  let selectedCrop = 'all';
  let selectedSubstances = [];
  let ulSearchQuery = '';
  let inStockOnly = true;
  let phoAllowedOnly = false;
  let beeSafeOnly = false;
  let openAlternativesSet = new Set();

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

    <!-- Chytrý agronomický panel filtrů pro obchodníka i sklad -->
    <div class="agro-filter-panel">
      <!-- 1. Rychlé záložky podle plodin (stříkání) -->
      <div class="agro-filter-group">
        <div class="agro-filter-label">🌾 Plodina (stříkání):</div>
        <div id="search-crop-tabs" class="chip-row" role="tablist" aria-label="Filtr podle plodiny"></div>
      </div>

      <!-- 2. Bezpečnostní přepínače + Multiselect účinných látek -->
      <div class="agro-controls-row">
        <div id="search-safety-chips" class="safety-chips-wrap" role="group" aria-label="Bezpečnostní filtry"></div>

        <div class="ul-multiselect-wrap" id="ul-multiselect-wrap">
          <div class="ul-input-shell">
            <span class="ul-input-icon" aria-hidden="true">🧪</span>
            <input
              type="search"
              id="ul-filter-input"
              class="ul-filter-input"
              placeholder="Filtrovat účinnou látku (např. tebukonazol)…"
              autocomplete="off"
              aria-label="Filtr podle účinné látky"
            />
          </div>
          <div id="ul-dropdown" class="autocomplete-list ul-dropdown" role="listbox" hidden></div>
        </div>
      </div>

      <div id="selected-ul-tags" class="selected-ul-tags" hidden></div>
    </div>

    <div id="search-categories" class="chip-row" aria-label="Filtr podle kategorie"></div>
    <div id="search-results-area"></div>
  `;

  const inputEl = document.getElementById('search-input');
  const clearBtn = document.getElementById('search-clear-btn');
  const scanBtn = document.getElementById('search-scan-btn');
  const acEl = document.getElementById('search-autocomplete');
  const cropTabsEl = document.getElementById('search-crop-tabs');
  const safetyChipsEl = document.getElementById('search-safety-chips');
  const ulWrapEl = document.getElementById('ul-multiselect-wrap');
  const ulInputEl = document.getElementById('ul-filter-input');
  const ulDropdownEl = document.getElementById('ul-dropdown');
  const ulTagsEl = document.getElementById('selected-ul-tags');
  const catEl = document.getElementById('search-categories');
  const resultsEl = document.getElementById('search-results-area');

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

  // --- Multiselect účinných látek ---
  ulInputEl.addEventListener('input', () => {
    ulSearchQuery = ulInputEl.value;
    renderUlDropdown();
  });

  ulInputEl.addEventListener('focus', () => {
    renderUlDropdown();
  });

  ulInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      ulDropdownEl.hidden = true;
    }
  });

  ulDropdownEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-ul-pick]');
    if (!btn) return;
    const ulName = btn.dataset.ulPick;
    if (!selectedSubstances.includes(ulName)) {
      selectedSubstances.push(ulName);
    } else {
      selectedSubstances = selectedSubstances.filter((x) => x !== ulName);
    }
    ulInputEl.value = '';
    ulSearchQuery = '';
    ulDropdownEl.hidden = true;
    visibleLimit = PAGE_SIZE;
    renderSelectedUlTags();
    renderCropTabs();
    renderCategories();
    renderResults();
  });

  ulTagsEl.addEventListener('click', (e) => {
    const rmBtn = e.target.closest('[data-ul-remove]');
    if (rmBtn) {
      const target = rmBtn.dataset.ulRemove;
      selectedSubstances = selectedSubstances.filter((x) => x !== target);
      visibleLimit = PAGE_SIZE;
      renderSelectedUlTags();
      renderCropTabs();
      renderCategories();
      renderResults();
      return;
    }
    if (e.target.closest('[data-reset-all-agro]')) {
      resetAgroFilters();
    }
  });

  document.addEventListener('click', (e) => {
    if (!panel.contains(e.target)) {
      acEl.hidden = true;
      ulDropdownEl.hidden = true;
      return;
    }
    if (!e.target.closest('.search-box-wrap')) {
      acEl.hidden = true;
    }
    if (!ulWrapEl.contains(e.target)) {
      ulDropdownEl.hidden = true;
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

  cropTabsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-crop]');
    if (!btn) return;
    selectedCrop = btn.dataset.crop;
    visibleLimit = PAGE_SIZE;
    renderCropTabs();
    renderSelectedUlTags();
    renderCategories();
    renderResults();
  });

  safetyChipsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-safety]');
    if (!btn) return;
    const key = btn.dataset.safety;
    if (key === 'stock') inStockOnly = !inStockOnly;
    else if (key === 'pho') phoAllowedOnly = !phoAllowedOnly;
    else if (key === 'bees') beeSafeOnly = !beeSafeOnly;
    visibleLimit = PAGE_SIZE;
    renderSafetyChips();
    renderSelectedUlTags();
    renderCropTabs();
    renderCategories();
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

  // Delegované akce uvnitř výsledků
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

    if (e.target.closest('[data-reset-all-agro]')) {
      resetAgroFilters();
      return;
    }

    const ulChipBtn = e.target.closest('[data-filter-ul]');
    if (ulChipBtn) {
      const ulName = ulChipBtn.dataset.filterUl;
      if (!selectedSubstances.includes(ulName)) {
        selectedSubstances.push(ulName);
        visibleLimit = PAGE_SIZE;
        renderSelectedUlTags();
        renderCropTabs();
        renderCategories();
        renderResults();
      }
      return;
    }

    const altToggleBtn = e.target.closest('[data-toggle-alt]');
    if (altToggleBtn) {
      const key = altToggleBtn.dataset.toggleAlt;
      if (openAlternativesSet.has(key)) openAlternativesSet.delete(key);
      else openAlternativesSet.add(key);
      renderResults();
      return;
    }

    const jumpProdBtn = e.target.closest('[data-jump-product]');
    if (jumpProdBtn) {
      const targetName = jumpProdBtn.dataset.jumpProduct;
      inStockOnly = true;
      renderSafetyChips();
      setSearchQuery(targetName, true);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }

    const jumpCatalogBtn = e.target.closest('[data-jump-catalog-product]');
    if (jumpCatalogBtn) {
      const targetName = jumpCatalogBtn.dataset.jumpCatalogProduct;
      inStockOnly = false;
      renderSafetyChips();
      renderSelectedUlTags();
      renderCropTabs();
      setSearchQuery(targetName, true);
      window.scrollTo({ top: 0, behavior: 'smooth' });
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
        navigator.clipboard
          .writeText(code)
          .then(() => {
            ctx.toast(`Kód ${code} zkopírován do schránky`, 'success');
          })
          .catch(() => {});
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

    const orderBtn = e.target.closest('[data-order-code]');
    if (orderBtn) {
      ctx.openOrderForProduct(orderBtn.dataset.orderCode, orderBtn.dataset.orderWh || '');
      return;
    }

    const shareBtn = e.target.closest('[data-share-product]');
    if (shareBtn) {
      const code = shareBtn.dataset.shareProduct;
      const prod = getBaseProductsPool().find((p) => p.code === code);
      if (prod) {
        const text = buildProductShareText(prod);
        shareOrCopyText({ title: prod.name, text }).then((status) => {
          if (status === 'copied') ctx.toast('📋 Přehled zkopírován do schránky (vlož do WhatsAppu / e-mailu)', 'success');
          else if (status === 'shared') ctx.toast('✅ Sdíleno', 'success');
        });
      }
      return;
    }

    const dosePresetBtn = e.target.closest('[data-dose-preset]');
    if (dosePresetBtn) {
      const box = dosePresetBtn.closest('[data-calc-box]');
      const doseIn = box?.querySelector('input[name="calc_dose"]');
      if (doseIn) {
        doseIn.value = dosePresetBtn.dataset.dosePreset;
        updateDosageCalc(box);
      }
      return;
    }

    const haPresetBtn = e.target.closest('[data-ha-preset]');
    if (haPresetBtn) {
      const box = haPresetBtn.closest('[data-calc-box]');
      const haIn = box?.querySelector('input[name="calc_ha"]');
      if (haIn) {
        haIn.value = haPresetBtn.dataset.haPreset;
        updateDosageCalc(box);
      }
      return;
    }

    const calcOrderBtn = e.target.closest('[data-calc-order]');
    if (calcOrderBtn) {
      const code = calcOrderBtn.dataset.calcOrder;
      const wh = calcOrderBtn.dataset.calcWh || '';
      const qty = parseFloat(calcOrderBtn.dataset.calcQty || '0');
      if (code && qty > 0) {
        ctx.openOrderForProduct(code, wh, qty);
      }
      return;
    }

    const calcShareBtn = e.target.closest('[data-calc-share]');
    if (calcShareBtn) {
      const text = calcShareBtn.dataset.calcShare || '';
      const title = calcShareBtn.dataset.calcTitle || 'Kalkulace dávkování';
      shareOrCopyText({ title, text }).then((status) => {
        if (status === 'copied') ctx.toast('📋 Kalkulace zkopírována do schránky', 'success');
        else if (status === 'shared') ctx.toast('✅ Kalkulace sdílena', 'success');
      });
      return;
    }

    const resetPackBtn = e.target.closest('[data-reset-pack]');
    if (resetPackBtn) {
      const code = resetPackBtn.dataset.resetPack;
      ctx.deleteCustomPack(code);
      ctx.toast('Obnoveno automatické rozpoznání balení', 'success');
      return;
    }

    const resetFertBtn = e.target.closest('[data-reset-fert]');
    if (resetFertBtn) {
      const key = resetFertBtn.dataset.resetFert;
      ctx.deleteFertilizerNote(key);
      ctx.toast('Poznámka k hnojivu byla odstraněna', 'warn');
      return;
    }

    if (e.target.closest('#search-load-more')) {
      visibleLimit += PAGE_SIZE;
      renderResults();
    }
  });

  resultsEl.addEventListener('input', (e) => {
    const calcInput = e.target.closest('[data-calc-box] input');
    if (!calcInput) return;
    const box = calcInput.closest('[data-calc-box]');
    if (box) updateDosageCalc(box);
  });

  function buildProductShareText(prod) {
    const customPacks = ctx.state.customPacks;
    const lines = [`📦 ${prod.name}`];
    if (!prod.isCatalogOnly && prod.code) lines.push(`Kód: ${prod.code}`);
    if (prod.por?.ul?.length) {
      const ulStr = prod.por.ul.map((u) => `${u.n}${u.c ? ` (${u.c})` : ''}`).join(' + ');
      lines.push(`🧪 Účinná látka: ${ulStr}`);
    }
    if (prod.por) {
      const pho = prod.por.pho?.restricted ? `Omezení (${prod.por.pho.code || 'OP II. st.'})` : 'Povolen v OP II. st.';
      const bees = prod.por.bees?.code && prod.por.bees.code !== 'OK' ? prod.por.bees.code : 'Bez omezení';
      lines.push(`💧 Vody (PHO): ${pho} · 🐝 Včely: ${bees}`);
    }
    if (prod.fert) {
      if (prod.fert.elements || prod.fert.prvky) lines.push(`🌱 Živiny: ${prod.fert.elements || prod.fert.prvky}`);
      if (prod.fert.tankmix) lines.push(`🔄 Tank-mix: ${prod.fert.tankmix}`);
      if (prod.fert.note || prod.fert.poznamka) lines.push(`📝 Poznámka: ${prod.fert.note || prod.fert.poznamka}`);
    }
    if (prod.totalQty > 0) {
      const pack = prepocetNaBaleni(prod.code, prod.name, prod.totalQty, customPacks);
      lines.push(`📊 Skladem: ${formatQtyWithUnit(prod.totalQty, prod.name)} (= ${pack})`);
    } else {
      lines.push(`📊 Skladem: 0 (katalog ÚKZÚZ)`);
    }
    return lines.join('\n');
  }

  function updateDosageCalc(box) {
    const outEl = box.querySelector('[data-calc-output]');
    if (!outEl) return;
    const code = box.dataset.calcCode || '';
    const name = box.dataset.calcName || '';
    const wh = box.dataset.calcWh || '';
    const stockQty = parseFloat(box.dataset.calcStock || '0') || 0;
    const isCatalogOnly = box.dataset.calcCatalog === '1';

    const ha = parseFloat(String(box.querySelector('input[name="calc_ha"]')?.value || '').replace(',', '.'));
    const dose = parseFloat(String(box.querySelector('input[name="calc_dose"]')?.value || '').replace(',', '.'));

    if (!ha || ha <= 0 || !dose || dose <= 0) {
      outEl.innerHTML = `<div style="font-size:0.78rem;color:var(--ink-muted);">Zadej výměru (ha) a dávku pro výpočet potřeby a počtu kartonů.</div>`;
      return;
    }

    const pkg = getPackagingInfo(code, name, ctx.state.customPacks);
    const uom = pkg.uomDisplay;
    const exactNeed = Math.round(ha * dose * 1000) / 1000;
    // Zaokrouhlení nahoru na celá jednotková balení (např. kanystry po 5 L)
    const unitStep = pkg.unitSize > 0 ? pkg.unitSize : 1;
    const roundedNeed = Math.round(Math.ceil((exactNeed - 1e-6) / unitStep) * unitStep * 1000) / 1000;
    const packStr = prepocetNaBaleni(code, name, roundedNeed, ctx.state.customPacks);

    const stockOk = stockQty >= roundedNeed;
    const missing = Math.round((roundedNeed - stockQty) * 1000) / 1000;
    const stockLine = isCatalogOnly
      ? `<span style="color:var(--ink-muted);">Položka není skladem (katalog ÚKZÚZ)</span>`
      : stockOk
        ? `<span style="color:var(--brand-700);font-weight:700;">✅ Skladem dostatek (${formatQty(stockQty)} ${uom})</span>`
        : `<span style="color:var(--danger);font-weight:700;">⚠️ Skladem jen ${formatQty(stockQty)} ${uom} (chybí ${formatQty(missing)} ${uom})</span>`;

    const shareText = [
      `🧮 Kalkulace dávkování: ${name}`,
      `Výměra: ${formatQty(ha)} ha · Dávka: ${formatQty(dose)} ${uom}/ha`,
      `Čistá potřeba: ${formatQty(exactNeed)} ${uom}`,
      `K odběru (celá balení): ${formatQty(roundedNeed)} ${uom} = ${packStr}`,
      !isCatalogOnly ? (stockOk ? `Skladem: dostatek (${formatQty(stockQty)} ${uom})` : `Skladem: ${formatQty(stockQty)} ${uom}`) : '',
    ]
      .filter(Boolean)
      .join('\n');

    outEl.innerHTML = `
      <div class="calc-result-box">
        <div class="calc-result-row">
          <span>Čistá potřeba (${formatQty(ha)} ha × ${formatQty(dose)} ${uom}/ha):</span>
          <strong class="mono">${formatQty(exactNeed)} ${uom}</strong>
        </div>
        <div class="calc-result-row is-highlight">
          <span>K odběru (celá balení po ${formatQty(unitStep)} ${uom}):</span>
          <strong>${formatQty(roundedNeed)} ${uom} = ${escapeHtml(packStr)}</strong>
        </div>
        <div style="font-size:0.78rem;margin-top:4px;">${stockLine}</div>
        <div class="calc-result-actions">
          ${
            !isCatalogOnly && stockQty > 0
              ? `<button type="button" class="btn btn-primary btn-sm" data-calc-order="${escapeHtml(code)}" data-calc-wh="${escapeHtml(wh)}" data-calc-qty="${roundedNeed}">🛒 Přidat ${formatQty(roundedNeed)} ${uom} do objednávky</button>`
              : ''
          }
          <button type="button" class="btn btn-sm" data-calc-share="${escapeHtml(shareText)}" data-calc-title="${escapeHtml(name)}">📤 Sdílet kalkulaci</button>
          <a href="${escapeHtml(buildWhatsAppUrl(shareText))}" target="_blank" rel="noopener noreferrer" class="btn btn-sm">💬 WhatsApp</a>
        </div>
      </div>
    `;
  }

  resultsEl.addEventListener('submit', (e) => {
    const fertForm = e.target.closest('[data-fert-form]');
    if (fertForm) {
      e.preventDefault();
      const code = fertForm.dataset.fertForm;
      const name = fertForm.dataset.fertName || '';
      const elements = fertForm.querySelector('input[name="elements"]').value.trim();
      const tankmix = fertForm.querySelector('input[name="tankmix"]').value.trim();
      const note = fertForm.querySelector('textarea[name="note"]').value.trim();
      ctx.setFertilizerNote(code, { name, elements, tankmix, note });
      ctx.toast('🌱 Poznámky a tank-mix k přípravku uloženy', 'success');
      return;
    }

    const form = e.target.closest('[data-pack-form]');
    if (!form) return;
    e.preventDefault();
    const code = form.dataset.packForm;
    const size = parseFloat(form.querySelector('input[name="velikost"]').value.replace(',', '.'));
    const ksVKartonuRaw = form.querySelector('input[name="ksVKartonu"]')?.value.trim();
    const ksVKartonu = ksVKartonuRaw ? parseInt(ksVKartonuRaw, 10) : null;
    const obal = form.querySelector('select[name="obal"]').value;
    if (!size || size <= 0) {
      ctx.toast('Zadej platnou velikost 1 kusu (> 0).', 'danger');
      return;
    }
    ctx.setCustomPack(code, size, obal, ksVKartonu);
    ctx.toast('Nastavení balení a kartonů uloženo', 'success');
  });

  function resetAgroFilters() {
    selectedCrop = 'all';
    selectedSubstances = [];
    inStockOnly = true;
    phoAllowedOnly = false;
    beeSafeOnly = false;
    selectedCategory = 'all';
    visibleLimit = PAGE_SIZE;
    render();
  }

  function getScopedItems() {
    return filterByWarehouse(ctx.state.items, ctx.state.prefs.warehouseFilter);
  }

  function getScopedStockProducts() {
    return groupByProduct(getScopedItems());
  }

  /**
   * Vrátí kandidátní produkty podle stavu přepínače „Pouze skladem (> 0 MJ)“.
   * Pokud je vypnutý, doplní ke skladovým položkám i ostatní registrované přípravky z ÚKZÚZ (s 0 j. skladem),
   * aby obchodník mohl najít i přípravek, který skladem není, a jedním klikem k němu vyhledat náhradu skladem.
   */
  function getBaseProductsPool() {
    const stockProducts = getScopedStockProducts();
    if (inStockOnly) {
      return stockProducts;
    }

    const matchedPorNames = new Set();
    for (const sp of stockProducts) {
      if (sp.por?.name) matchedPorNames.add(normalizeText(sp.por.name));
      matchedPorNames.add(normalizeText(sp.name));
    }

    const combined = [...stockProducts];
    for (const por of ctx.state.porItems || []) {
      const pNorm = normalizeText(por.name);
      if (matchedPorNames.has(pNorm)) continue;
      const catInfo = parseCategory(por.fn || 'CHEMIE');
      const ulText = (por.ul || []).map((u) => `${u.n} ${u.c || ''} ${u.g || ''}`).join(' ');
      const cropsText = (por.crops || []).join(' ');
      combined.push({
        code: por.reg ? `POR-${por.reg}` : `POR-${por.id || pNorm}`,
        name: por.name,
        cat: catInfo,
        por,
        totalQty: 0,
        batches: [],
        isCatalogOnly: true,
        _search: normalizeText(
          `${por.name} ${por.reg || ''} ${por.fn || ''} ${ulText} ${(por.groups || []).join(' ')} ${cropsText}`
        ),
      });
    }
    return combined;
  }

  function productMatchesAgroFilters(prod, { ignoreCrop = false, ignoreCat = false } = {}) {
    if (inStockOnly && prod.totalQty <= 0) return false;
    if (!ignoreCat && selectedCategory !== 'all' && prod.cat?.key !== selectedCategory) return false;

    const safetyOpts = {
      cropCategory: ignoreCrop ? 'all' : selectedCrop,
      phoAllowedOnly,
      beeSafeOnly,
    };
    if (!matchesPorSafetyAndCrop(prod.por, safetyOpts)) return false;
    if (!matchesActiveSubstances(prod.por, selectedSubstances)) return false;
    return true;
  }

  function productMatchesQuery(prod, qTrim) {
    if (selectedExactName) {
      return prod.name === selectedExactName;
    }
    if (!qTrim) return true;
    const tokens = normalizeText(qTrim).split(/\s+/).filter(Boolean);
    if (prod.isCatalogOnly) {
      return tokens.every((t) => prod._search.includes(t));
    }
    return prod.batches.some((b) => tokens.every((t) => b._search.includes(t)));
  }

  /**
   * Seznam všech účinných látek s počtem odpovídajících přípravků pro našeptávač/multiselect.
   */
  function getAvailableActiveSubstances() {
    const pool = getBaseProductsPool();
    const counts = new Map();
    const displayNames = new Map();

    for (const prod of pool) {
      if (!prod.por?.ul?.length) continue;
      if (!matchesPorSafetyAndCrop(prod.por, { cropCategory: selectedCrop, phoAllowedOnly, beeSafeOnly })) {
        continue;
      }
      for (const u of prod.por.ul) {
        const norm = normalizeText(u.n);
        if (!norm) continue;
        if (!displayNames.has(norm)) displayNames.set(norm, u.n);
        counts.set(norm, (counts.get(norm) || 0) + 1);
      }
    }

    return Array.from(counts.entries())
      .map(([norm, count]) => ({ norm, name: displayNames.get(norm), count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'cs'));
  }

  function renderUlDropdown() {
    const allUl = getAvailableActiveSubstances();
    const qNorm = normalizeText(ulSearchQuery);
    const filtered = qNorm
      ? allUl.filter((item) => item.norm.includes(qNorm))
      : allUl.slice(0, 30);

    if (!filtered.length) {
      ulDropdownEl.innerHTML = `<div style="padding:10px 12px;font-size:0.82rem;color:var(--ink-muted);">Žádná účinná látka neodpovídá „${escapeHtml(ulSearchQuery)}“</div>`;
      ulDropdownEl.hidden = false;
      return;
    }

    ulDropdownEl.innerHTML = filtered
      .slice(0, 35)
      .map((item) => {
        const isSelected = selectedSubstances.some((s) => normalizeText(s) === item.norm);
        return `
          <button type="button" class="ac-item ${isSelected ? 'is-selected' : ''}" role="option" aria-selected="${isSelected}" data-ul-pick="${escapeHtml(item.name)}">
            <div class="ac-item-name">${isSelected ? '✓ ' : ''}${escapeHtml(item.name)}</div>
            <span class="ac-item-qty">${item.count} přípr.</span>
          </button>
        `;
      })
      .join('');
    ulDropdownEl.hidden = false;
  }

  function renderSelectedUlTags() {
    const hasAgroReset =
      selectedCrop !== 'all' ||
      selectedSubstances.length > 0 ||
      !inStockOnly ||
      phoAllowedOnly ||
      beeSafeOnly;

    if (!selectedSubstances.length && !hasAgroReset) {
      ulTagsEl.hidden = true;
      ulTagsEl.innerHTML = '';
      return;
    }

    const tagsHtml = selectedSubstances
      .map(
        (ul) => `
        <span class="ul-active-tag">
          <span>🧪 ${escapeHtml(ul)}</span>
          <button type="button" class="ul-tag-remove" data-ul-remove="${escapeHtml(ul)}" aria-label="Odebrat ${escapeHtml(ul)}">✕</button>
        </span>
      `
      )
      .join('');

    const resetBtn = hasAgroReset
      ? `<button type="button" class="btn btn-ghost btn-sm" data-reset-all-agro="1">↺ Resetovat filtry</button>`
      : '';

    ulTagsEl.innerHTML = `${tagsHtml}${resetBtn}`;
    ulTagsEl.hidden = false;
  }

  function renderCropTabs() {
    const pool = getBaseProductsPool();
    const counts = new Map();
    let totalMatching = 0;

    for (const prod of pool) {
      if (!productMatchesAgroFilters(prod, { ignoreCrop: true, ignoreCat: true })) continue;
      totalMatching++;
      for (const cg of prod.por?.cg || []) {
        counts.set(cg, (counts.get(cg) || 0) + 1);
      }
    }

    cropTabsEl.innerHTML = CROP_CATEGORIES.map((c) => {
      const cnt = c.key === 'all' ? totalMatching : counts.get(c.key) || 0;
      const active = selectedCrop === c.key;
      return `
        <button type="button" class="chip crop-tab-chip ${active ? 'is-active' : ''}" data-crop="${c.key}" role="tab" aria-selected="${active}">
          <span>${c.icon} ${escapeHtml(c.label)}</span>
          <span class="chip-count">${cnt}</span>
        </button>
      `;
    }).join('');
  }

  function renderSafetyChips() {
    safetyChipsEl.innerHTML = `
      <button type="button" class="chip safety-chip ${inStockOnly ? 'is-active' : ''}" data-safety="stock" aria-pressed="${inStockOnly}" title="Zobrazit pouze položky skladem (> 0 MJ). Vypnutím zobrazíš celý katalog ÚKZÚZ.">
        <span>📦 Pouze skladem (&gt; 0 MJ)</span>
      </button>
      <button type="button" class="chip safety-chip is-pho-safe ${phoAllowedOnly ? 'is-active' : ''}" data-safety="pho" aria-pressed="${phoAllowedOnly}" title="Skryje přípravky vyloučené v ochranném pásmu II. stupně vod (OP II. st.)">
        <span>💧 Povolené v OP II. st. (vody)</span>
      </button>
      <button type="button" class="chip safety-chip is-bee-safe ${beeSafeOnly ? 'is-active' : ''}" data-safety="bees" aria-pressed="${beeSafeOnly}" title="Skryje přípravky nebezpečné a zvlášť nebezpečné pro včely (ZNV, NV, SPe8)">
        <span>🐝 Bezpečné pro včely</span>
      </button>
    `;
  }

  function renderAutocomplete() {
    const qNorm = normalizeText(query);
    if (!qNorm || selectedExactName) {
      acEl.hidden = true;
      return;
    }
    const pool = getBaseProductsPool().filter(
      (p) => productMatchesAgroFilters(p) && productMatchesQuery(p, query)
    );
    const products = pool.slice(0, 8);

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
          <div class="ac-item-meta">${escapeHtml(p.code)} · ${p.cat.icon} ${escapeHtml(p.cat.label)}${p.por?.ul?.length ? ` · ${escapeHtml(p.por.ul.map((u) => u.n).join(' + '))}` : ''}</div>
        </div>
        <span class="ac-item-qty">${p.totalQty > 0 ? `${formatQty(p.totalQty)} j.` : '0 j.'}</span>
      </button>
    `
      )
      .join('');
    acEl.hidden = false;
  }

  function renderCategories() {
    const pool = getBaseProductsPool().filter((p) =>
      productMatchesAgroFilters(p, { ignoreCat: true })
    );
    const counts = new Map();
    const labels = new Map();

    for (const prod of pool) {
      const k = prod.cat.key;
      labels.set(k, prod.cat);
      counts.set(k, (counts.get(k) || 0) + 1);
    }

    const sortedCats = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
    if (selectedCategory !== 'all' && !counts.has(selectedCategory)) {
      selectedCategory = 'all';
    }

    const chips = [
      `<button type="button" class="chip ${selectedCategory === 'all' ? 'is-active' : ''}" data-cat="all">Všechny typy <span class="chip-count">${pool.length}</span></button>`,
      ...sortedCats.map(([key, cnt]) => {
        const info = labels.get(key);
        return `<button type="button" class="chip ${selectedCategory === key ? 'is-active' : ''}" data-cat="${escapeHtml(key)}">${info.icon} ${escapeHtml(info.label)} <span class="chip-count">${cnt}</span></button>`;
      }),
    ];

    catEl.innerHTML = chips.join('');
  }

  function renderResults() {
    if (ctx.state.items.length === 0 && (!ctx.state.porItems || ctx.state.porItems.length === 0)) {
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
    const hasFilter = Boolean(
      qTrim ||
        selectedExactName ||
        selectedCategory !== 'all' ||
        selectedCrop !== 'all' ||
        selectedSubstances.length > 0 ||
        !inStockOnly ||
        phoAllowedOnly ||
        beeSafeOnly
    );

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
          <h3>Katalog přípravků, agronomické filtry &amp; náhrady skladem</h3>
          <p>Napiš název přípravku, účinnou látku nebo šarži, případně vyber <strong>plodinu stříkání</strong> (Obiloviny, Řepka, Réva…), <strong>účinnou látku</strong> nebo přepni <strong>Povolené v OP II. st. / Bezpečné pro včely</strong>.</p>
        </div>
        ${recentHtml}
      `;
      return;
    }

    const pool = getBaseProductsPool();
    const products = pool.filter(
      (prod) => productMatchesAgroFilters(prod) && productMatchesQuery(prod, qTrim)
    );

    if (products.length === 0) {
      resultsEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🔍</div>
          <h3>Nic nebylo nalezeno</h3>
          <p>Zvolené kombinaci filtrů neodpovídá žádný přípravek${inStockOnly ? ' skladem' : ''}.</p>
          <div style="margin-top: 12px;">
            <button type="button" class="btn btn-sm" data-reset-all-agro="1">↺ Resetovat agronomické filtry</button>
          </div>
        </div>
      `;
      return;
    }

    const batchSort = ctx.state.prefs.batchSort || 'qty';
    const shown = products.slice(0, visibleLimit);
    const remaining = products.length - shown.length;
    const todayMs = getTodayMidnightMs();
    const customPacks = ctx.state.customPacks;
    const scopedStockProducts = getScopedStockProducts();

    const toolbarHtml = `
      <div class="results-bar">
        <span>Nalezeno přípravků: <strong>${products.length}</strong>${remaining > 0 ? ` (zobrazeno ${shown.length})` : ''}</span>
        <div class="sort-pills" role="group" aria-label="Řazení šarží">
          <button type="button" class="sort-pill ${batchSort === 'qty' ? 'is-active' : ''}" data-batch-sort="qty">Dle množství</button>
          <button type="button" class="sort-pill ${batchSort === 'fefo' ? 'is-active' : ''}" data-batch-sort="fefo">FEFO (expirace)</button>
        </div>
      </div>
    `;

    const cardsHtml = shown
      .map((prod) =>
        renderProductCard(prod, batchSort, todayMs, customPacks, scopedStockProducts)
      )
      .join('');
    const loadMoreHtml =
      remaining > 0
        ? `<button type="button" id="search-load-more" class="btn btn-block">Zobrazit další přípravky (zbývá ${remaining})</button>`
        : '';

    resultsEl.innerHTML = toolbarHtml + cardsHtml + loadMoreHtml;
  }

  /**
   * Vykreslí výrazné barevné bezpečnostní odznaky (OP II. st. a Včely: ZNV / NV / SPe8) přímo v hlavičce karty.
   */
  function renderHeaderHazardBadges(por) {
    if (!por) return '';
    const badges = [];

    if (por.pho?.restricted) {
      badges.push(
        `<span class="hazard-badge is-pho-warn" title="${escapeHtml(por.pho.text || 'Vyloučeno v OP II. st.')}">⚠️ ${escapeHtml(por.pho.code || 'OP II. st.')}</span>`
      );
    }

    const bCode = String(por.bees?.code || 'OK').toUpperCase();
    if (bCode === 'ZNV') {
      badges.push(
        `<span class="hazard-badge is-bee-danger" title="${escapeHtml(por.bees.text || '')}">🐝 Včely: ZNV</span>`
      );
    } else if (bCode === 'NV' || bCode === 'SPE8') {
      badges.push(
        `<span class="hazard-badge is-bee-warn" title="${escapeHtml(por.bees.text || '')}">🐝 Včely: ${escapeHtml(por.bees.code)}</span>`
      );
    }

    return badges.join('');
  }

  function renderProductCard(prod, batchSort, todayMs, customPacks, scopedStockProducts) {
    const packText = prod.totalQty > 0
      ? prepocetNaBaleni(prod.code, prod.name, prod.totalQty, customPacks)
      : 'Není skladem (katalog ÚKZÚZ)';
    const palletText = prod.totalQty > 0
      ? paletovaKalkulacka(prod.code, prod.name, prod.totalQty, customPacks)
      : null;

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

    const batchesHtml = sortedBatches.length
      ? `
        <div class="batch-section-label">Rozpis po lokacích a šaržích (${prod.batches.length})</div>
        <div class="batch-list">
          ${sortedBatches
            .map((b) => {
              const bPack = prepocetNaBaleni(prod.code, prod.name, b.q, customPacks);
              const expInfo = evaluateExpiration(b.exp, todayMs);
              const recDate = formatIsoDateCz(b.rec);
              return `
                <div class="batch-row ${expInfo.status === 'expired' ? 'is-expired' : ''}">
                  <div class="batch-top">
                    <span class="batch-loc">${escapeHtml(b._locDisplay)}</span>
                    <span class="batch-qty num">${formatQtyWithUnit(b.q, prod.name)} <span class="batch-qty-pack">(= ${escapeHtml(bPack)})</span></span>
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
            .join('')}
        </div>
      `
      : '';

    const defaultSize = ziskejKrokBaleni(prod.code, prod.name, customPacks);
    const hasCustom = Boolean(customPacks[prod.code]);
    const defaultObal = customPacks[prod.code]?.obal || 'automaticky';
    const hazardBadgesHtml = renderHeaderHazardBadges(prod.por);
    const porHtml = renderPorPanel(prod, scopedStockProducts, customPacks);
    const fertHtml = renderFertilizerPanel(prod);
    const agromanualUrl = buildAgromanualUrl(prod.name, prod.por?.name || null);
    const primaryWh = prod.batches?.[0]?.wh || '';

    return `
      <article class="product-card ${prod.totalQty <= 0 ? 'is-out-of-stock' : ''}">
        <div class="product-head">
          <div>
            <h2 class="product-name">${escapeHtml(prod.name)}</h2>
            <div class="product-subrow">
              ${
                !prod.isCatalogOnly
                  ? `<button type="button" class="code-chip" data-copy-code="${escapeHtml(prod.code)}" title="Kliknutím zkopíruješ kód">
                       <span>${escapeHtml(prod.code)}</span>
                       <span aria-hidden="true">⧉</span>
                     </button>`
                  : ''
              }
              ${prod.por?.reg && prod.por.reg !== '-' ? `<span class="code-chip" title="Registrační číslo ÚKZÚZ">ÚKZÚZ: ${escapeHtml(prod.por.reg)}</span>` : ''}
              ${hazardBadgesHtml}
              ${prod.por?.eco ? '<span class="exp-pill is-ok">🌱 EKO</span>' : ''}
              ${hasCustom ? '<span class="exp-pill is-ok">Vlastní balení</span>' : ''}
            </div>
          </div>
          <span class="cat-badge">${prod.cat.icon} ${escapeHtml(prod.cat.label)}</span>
        </div>

        <div class="stock-metrics">
          <div class="metric-tile">
            <div class="metric-label">Skladem celkem</div>
            <div class="metric-value num" style="${prod.totalQty <= 0 ? 'color:var(--ink-muted)' : ''}">${formatQtyWithUnit(prod.totalQty, prod.name)}</div>
          </div>
          <div class="metric-tile">
            <div class="metric-label">Kartony &amp; kusy</div>
            <div class="metric-value is-pack">${escapeHtml(packText)}</div>
          </div>
        </div>

        <!-- Rychlé akce: Otevřít v Agromanuálu + Sdílet + Objednat -->
        <div class="card-quick-actions">
          <a href="${escapeHtml(agromanualUrl)}" target="_blank" rel="noopener noreferrer" class="btn btn-sm agromanual-btn" title="Vyhledat očištěný název přípravku nebo hnojiva na Agromanuál.cz">
            <span>📘 Agromanuál</span>
            <span aria-hidden="true">↗</span>
          </a>
          <button type="button" class="btn btn-sm" data-share-product="${escapeHtml(prod.code)}" title="Sdílet přehled přes WhatsApp / SMS / e-mail nebo zkopírovat">
            📤 Sdílet
          </button>
          ${
            !prod.isCatalogOnly && prod.totalQty > 0
              ? `<button type="button" class="btn btn-primary btn-sm" data-order-code="${escapeHtml(prod.code)}" data-order-wh="${escapeHtml(primaryWh)}">
                   🛒 Přidat do objednávky
                 </button>`
              : ''
          }
        </div>

        ${(() => {
          const pkg = getPackagingInfo(prod.code, prod.name, customPacks);
          const uom = pkg.uomDisplay;
          const doseOpts = extractPorDoseOptions(prod.por?.uses || []);
          const defaultDose = doseOpts[0]?.dose || '';
          const doseChipsHtml = doseOpts.length
            ? `<div class="chip-row chip-row-wrap" style="padding:0;margin-bottom:8px;">
                 ${doseOpts
                   .map(
                     (o) =>
                       `<button type="button" class="chip" data-dose-preset="${o.dose}">${escapeHtml(o.label)}</button>`
                   )
                   .join('')}
               </div>`
            : '';
          return `
            <details class="pack-details" style="margin-top:8px;">
              <summary>🧮 Kalkulačka dávkování (ha → ${uom} / kartony → objednávka)</summary>
              <div
                class="dosage-calc-box"
                data-calc-box="1"
                data-calc-code="${escapeHtml(prod.code)}"
                data-calc-name="${escapeHtml(prod.name)}"
                data-calc-wh="${escapeHtml(primaryWh)}"
                data-calc-stock="${prod.totalQty}"
                data-calc-catalog="${prod.isCatalogOnly ? '1' : '0'}"
              >
                ${doseChipsHtml}
                <div class="form-grid-2">
                  <div class="field">
                    <label>Výměra (ha)</label>
                    <input class="input mono" type="number" name="calc_ha" min="0.1" step="any" inputmode="decimal" placeholder="např. 85" />
                  </div>
                  <div class="field">
                    <label>Dávka (${uom}/ha)</label>
                    <input class="input mono" type="number" name="calc_dose" min="0.001" step="any" inputmode="decimal" value="${defaultDose}" placeholder="např. 0.8" />
                  </div>
                </div>
                <div class="chip-row" style="padding:0;margin:6px 0 8px;">
                  <button type="button" class="chip" data-ha-preset="10">10 ha</button>
                  <button type="button" class="chip" data-ha-preset="25">25 ha</button>
                  <button type="button" class="chip" data-ha-preset="50">50 ha</button>
                  <button type="button" class="chip" data-ha-preset="100">100 ha</button>
                </div>
                <div data-calc-output>
                  <div style="font-size:0.78rem;color:var(--ink-muted);">Zadej výměru (ha) a dávku pro výpočet potřeby a počtu kartonů.</div>
                </div>
              </div>
            </details>
          `;
        })()}

        ${palletHtml}
        ${fefoHtml}
        ${fertHtml}
        ${porHtml}
        ${batchesHtml}

        ${
          !prod.isCatalogOnly
            ? `<div class="card-drawers-row">
                 <details class="pack-details">
                   <summary>🌱 Poznámky, živiny &amp; tank-mix (hnojiva / biostimulanty)</summary>
                   <form class="pack-form" data-fert-form="${escapeHtml(prod.code)}" data-fert-name="${escapeHtml(prod.name)}">
                     <div class="field">
                       <label>Účinné prvky / živiny (např. N 12%, P 11%, K 18%, B, Zn)</label>
                       <input class="input" type="text" name="elements" value="${escapeHtml(prod.fert?.elements || prod.fert?.prvky || '')}" placeholder="Např. B 150 g/l, Mo, aminokyseliny…" />
                     </div>
                     <div class="field">
                       <label>Doporučené tank-mixy</label>
                       <input class="input" type="text" name="tankmix" value="${escapeHtml(prod.fert?.tankmix || '')}" placeholder="Např. kompatibilní s fungicidy a DAM 390…" />
                     </div>
                     <div class="field" style="grid-column: 1 / -1;">
                       <label>Vlastní agronomická poznámka / dávkování</label>
                       <textarea class="textarea" name="note" style="min-height:58px;" placeholder="Např. aplikovat na list v BBCH 30–51 v dávce 1–2 l/ha…">${escapeHtml(prod.fert?.note || prod.fert?.poznamka || '')}</textarea>
                     </div>
                     <div class="pack-form-actions">
                       <button type="submit" class="btn btn-primary btn-sm">💾 Uložit poznámku</button>
                       ${prod.fert ? `<button type="button" class="btn btn-soft-danger btn-sm" data-reset-fert="${escapeHtml(prod.code)}">Smazat poznámku</button>` : ''}
                     </div>
                   </form>
                 </details>

                 <details class="pack-details">
                   <summary>⚙️ Upravit přepočet kusů a kartonů pro tento produkt</summary>
                   <form class="pack-form" data-pack-form="${escapeHtml(prod.code)}">
                     <div class="field">
                       <label>Velikost 1 kusu (l / kg)</label>
                       <input class="input mono" type="number" name="velikost" step="any" min="0.001" value="${defaultSize}" required />
                     </div>
                     <div class="field">
                       <label>Kusů v kartonu (balení)</label>
                       <input class="input mono" type="number" name="ksVKartonu" step="1" min="1" value="${getPackagingInfo(prod.code, prod.name, customPacks).piecesPerCarton || ''}" placeholder="např. 4 nebo 12" />
                     </div>
                     <div class="field" style="grid-column: 1 / -1;">
                       <label>Typ jednotkového obalu</label>
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
               </div>`
            : ''
        }
      </article>
    `;
  }

  function renderFertilizerPanel(prod) {
    const f = prod.fert;
    const elements = f?.elements || f?.prvky || '';
    const tankmix = f?.tankmix || '';
    const note = f?.note || f?.poznamka || '';
    if (!f || (!elements && !tankmix && !note)) return '';
    return `
      <div class="fert-panel">
        <div class="por-header">
          <span class="por-title">🌾 Agronomická karta &amp; živiny (Hnojivo / Biostimulant)</span>
        </div>
        ${elements ? `<div class="por-row"><span class="por-label">Účinné prvky / složení:</span> <strong class="por-val">${escapeHtml(elements)}</strong></div>` : ''}
        ${tankmix ? `<div class="por-row"><span class="por-label">Doporučené tank-mixy:</span> <span class="por-val">${escapeHtml(tankmix)}</span></div>` : ''}
        ${note ? `<div class="por-row"><span class="por-label">Poznámka:</span> <span class="por-val">${escapeHtml(note)}</span></div>` : ''}
      </div>
    `;
  }

  function renderPorPanel(prod, scopedStockProducts, customPacks) {
    const por = prod.por;
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
    const phoBadgeHtml = phoRestricted
      ? `<span class="hazard-badge is-pho-warn">💧 PHO: ${escapeHtml(por.pho.code || 'OP II. st.')}</span>`
      : `<span class="exp-pill is-ok">💧 PHO: Povolen (- / - -)</span>`;

    const bCode = String(por.bees?.code || 'OK').toUpperCase();
    let beeBadgeHtml = `<span class="exp-pill is-ok">🐝 Včely: Bez omezení (- -)</span>`;
    if (bCode === 'ZNV') {
      beeBadgeHtml = `<span class="hazard-badge is-bee-danger">🐝 Včely: ZNV (zvlášť nebezpečný)</span>`;
    } else if (bCode === 'NV' || bCode === 'SPE8') {
      beeBadgeHtml = `<span class="hazard-badge is-bee-warn">🐝 Včely: ${escapeHtml(por.bees.code)} (nebezpečný)</span>`;
    } else if (bCode === 'DO') {
      beeBadgeHtml = `<span class="exp-pill is-pho-restricted">🐝 Včely: DO (opylovači)</span>`;
    }

    const ulHtml = por.ul?.length
      ? `<div class="por-row">
           <span class="por-label">Účinné látky:</span>
           <span class="por-val">${por.ul
             .map(
               (u) =>
                 `<button type="button" class="ul-inline-btn" data-filter-ul="${escapeHtml(u.n)}" title="Filtrovat přípravky s účinnou látkou ${escapeHtml(u.n)}"><strong>${escapeHtml(u.n)}</strong>${u.c ? ` <span class="mono">${escapeHtml(u.c)}</span>` : ''}</button>`
             )
             .join(' · ')}</span>
         </div>`
      : '';

    const groupsHtml = por.groups?.length
      ? `<div class="por-row">
           <span class="por-label">Skupina (MoA):</span>
           <span class="por-val">${escapeHtml(por.groups.join(', '))}</span>
         </div>`
      : '';

    // Kategorie plodin + detail plodin a dávkování
    const cgChips = (por.cg || [])
      .map((k) => `<span class="crop-mini-pill">${escapeHtml(CROP_CATEGORY_LABELS[k] || k)}</span>`)
      .join('');

    const cropsHtml = cgChips
      ? `<div class="por-row por-crops-row">
           <span class="por-label">Plodiny:</span>
           <span class="por-crop-pills">${cgChips}</span>
         </div>`
      : '';

    const usesList = por.uses || [];
    const usesHtml = usesList.length
      ? `<details class="por-legal-details">
           <summary>📋 Registrované plodiny a dávkování (${usesList.length})</summary>
           <div class="por-uses-table">
             ${usesList
               .map(
                 (u) => `
               <div class="por-use-item">
                 <div class="por-use-top">
                   <strong class="por-use-crop">${escapeHtml(u.c)}</strong>
                   ${u.d ? `<span class="por-use-dose mono">${escapeHtml(u.d)}</span>` : ''}
                 </div>
                 ${
                   u.p || u.ol
                     ? `<div class="por-use-sub">
                          ${u.p ? `<span>ŠO: ${escapeHtml(u.p)}</span>` : ''}
                          ${u.ol ? `<span>OL: <strong>${escapeHtml(u.ol)}</strong></span>` : ''}
                        </div>`
                     : ''
                 }
               </div>
             `
               )
               .join('')}
           </div>
         </details>`
      : '';

    const showLegalDetails = phoRestricted || bCode !== 'OK';
    const legalDetailsHtml = showLegalDetails
      ? `<details class="por-legal-details">
           <summary>⚖️ Přesné znění omezení PHO a rizika pro včely</summary>
           <div class="por-legal-body">
             <div><strong>Ochranná pásma vod (PHO):</strong> ${escapeHtml(por.pho?.text || 'Bez omezení')}</div>
             <div><strong>Riziko pro včely:</strong> ${escapeHtml(por.bees?.text || 'Bez označení')}</div>
           </div>
         </details>`
      : '';

    // Výpočet alternativ skladem při respektování aktivních filtrů obchodníka
    const altKey = `${prod.code}||${por.name}`;
    const isAltOpen = openAlternativesSet.has(altKey);
    const activeFilters = {
      cropCategory: selectedCrop,
      phoAllowedOnly,
      beeSafeOnly,
    };
    const { exactSubstitutes, groupAlternatives } = findStockAlternatives(
      por,
      prod.isCatalogOnly ? null : prod.code,
      scopedStockProducts,
      activeFilters
    );
    const totalAlts = exactSubstitutes.length + groupAlternatives.length;

    let altDrawerHtml = '';
    if (isAltOpen) {
      const catalogAlts = findCatalogAlternatives(
        por,
        scopedStockProducts,
        ctx.state.porItems || [],
        activeFilters,
        20
      );
      altDrawerHtml = renderAlternativesDrawer(
        prod,
        exactSubstitutes,
        groupAlternatives,
        catalogAlts,
        activeFilters,
        customPacks
      );
    }

    return `
      <div class="por-panel ${isStockUse ? 'is-stock-use' : ''}">
        <div class="por-header">
          <span class="por-title">🏛️ Registr ÚKZÚZ · ${escapeHtml(por.name)}</span>
          <span class="exp-pill ${statusClass}">${escapeHtml(por.status)}</span>
        </div>
        ${datesParts.length ? `<div class="por-dates">${datesParts.join(' &nbsp;|&nbsp; ')}</div>` : ''}
        <div class="por-pills">
          ${phoBadgeHtml}
          ${beeBadgeHtml}
        </div>
        ${ulHtml}
        ${groupsHtml}
        ${cropsHtml}
        ${usesHtml}
        ${legalDetailsHtml}

        <div class="por-alt-bar">
          <button type="button" class="btn btn-sm por-alt-btn ${isAltOpen ? 'is-active' : ''}" data-toggle-alt="${escapeHtml(altKey)}">
            <span>🔄 Alternativy (skladem + mimo sklad)</span>
            <span class="alt-count-badge">${totalAlts} skladem</span>
          </button>
        </div>
        ${altDrawerHtml}
      </div>
    `;
  }

  function renderAlternativesDrawer(
    prod,
    exactSubstitutes,
    groupAlternatives,
    catalogAlts,
    activeFilters,
    customPacks
  ) {
    const activeFilterNotes = [];
    if (activeFilters.cropCategory && activeFilters.cropCategory !== 'all') {
      activeFilterNotes.push(CROP_CATEGORY_LABELS[activeFilters.cropCategory] || activeFilters.cropCategory);
    }
    if (activeFilters.phoAllowedOnly) activeFilterNotes.push('💧 Povolené v OP II. st.');
    if (activeFilters.beeSafeOnly) activeFilterNotes.push('🐝 Bezpečné pro včely');

    const filterNoteHtml = activeFilterNotes.length
      ? `<div class="alt-filter-note">Respektovány aktivní filtry: <strong>${activeFilterNotes.map(escapeHtml).join(' · ')}</strong></div>`
      : '';

    const {
      exactCatalog = [],
      groupCatalog = [],
      totalExactCatalog = 0,
      totalGroupCatalog = 0,
    } = catalogAlts || {};
    const hasAnyStock = exactSubstitutes.length > 0 || groupAlternatives.length > 0;
    const hasAnyCatalog = exactCatalog.length > 0 || groupCatalog.length > 0;

    if (!hasAnyStock && !hasAnyCatalog) {
      return `
        <div class="alt-drawer">
          ${filterNoteHtml}
          <div class="alt-empty">Pro tento přípravek nebyla nalezena žádná alternativa (skladem ani v registru ÚKZÚZ) vyhovující zvoleným filtrům.</div>
        </div>
      `;
    }

    const renderAltItem = (cand, detailLineHtml) => {
      const pack = prepocetNaBaleni(cand.code, cand.name, cand.totalQty, customPacks);
      const badges = renderHeaderHazardBadges(cand.por);
      const locs = Array.from(new Set(cand.batches.map((b) => b._locDisplay))).join(', ');
      return `
        <div class="alt-card">
          <div class="alt-card-top">
            <div>
              <button type="button" class="alt-product-link" data-jump-product="${escapeHtml(cand.name)}">
                ${escapeHtml(cand.name)} →
              </button>
              <div class="alt-card-sub">
                <span class="mono">${escapeHtml(cand.code)}</span>
                ${cand.por?.reg ? ` · ÚKZÚZ: <span class="mono">${escapeHtml(cand.por.reg)}</span>` : ''}
                ${locs ? ` · ${escapeHtml(locs)}` : ''}
              </div>
            </div>
            <div class="alt-qty-box">
              <div class="alt-qty-val num">${formatQtyWithUnit(cand.totalQty, cand.name)}</div>
              <div class="alt-qty-pack">${escapeHtml(pack)}</div>
            </div>
          </div>
          <div class="alt-detail-line">${detailLineHtml}</div>
          ${badges ? `<div class="por-pills" style="margin-top:4px;">${badges}</div>` : ''}
        </div>
      `;
    };

    const renderCatalogAltItem = (por, detailLineHtml) => {
      const badges = renderHeaderHazardBadges(por);
      const agroUrl = buildAgromanualUrl(por.name, por.name);
      return `
        <div class="alt-card is-catalog-only">
          <div class="alt-card-top">
            <div>
              <button type="button" class="alt-product-link" data-jump-catalog-product="${escapeHtml(por.name)}">
                ${escapeHtml(por.name)} →
              </button>
              <div class="alt-card-sub">
                ${por.reg ? `ÚKZÚZ: <span class="mono">${escapeHtml(por.reg)}</span>` : 'Registr ÚKZÚZ'}
                ${por.status ? ` · ${escapeHtml(por.status)}` : ''}
                · <a href="${escapeHtml(agroUrl)}" target="_blank" rel="noopener noreferrer" style="color:var(--brand-700);font-weight:700;">📘 Agromanuál ↗</a>
              </div>
            </div>
            <div class="alt-qty-box">
              <span class="exp-pill is-none">Není skladem</span>
            </div>
          </div>
          <div class="alt-detail-line">${detailLineHtml}</div>
          ${badges ? `<div class="por-pills" style="margin-top:4px;">${badges}</div>` : ''}
        </div>
      `;
    };

    const exactHtml = exactSubstitutes.length
      ? `
        <div class="alt-group">
          <div class="alt-group-title is-exact">✅ Přesná náhrada SKLADEM — stejná účinná látka (${exactSubstitutes.length})</div>
          ${exactSubstitutes
            .map(({ product: cand, sharedUl }) => {
              const ulComp = (cand.por?.ul || [])
                .map((u) => `<strong>${escapeHtml(u.n)}</strong>${u.c ? ` <span class="mono">${escapeHtml(u.c)}</span>` : ''}`)
                .join(' + ');
              const targetComp = sharedUl
                .filter((s) => s.targetConc && s.candConc && s.targetConc !== s.candConc)
                .map((s) => `původně ${escapeHtml(s.targetConc)}`)
                .join(', ');
              return renderAltItem(
                cand,
                `Složení: ${ulComp}${targetComp ? ` <span class="alt-conc-diff">(${targetComp})</span>` : ' <span class="alt-conc-match">(shodná koncentrace)</span>'}`
              );
            })
            .join('')}
        </div>
      `
      : `<div class="alt-group"><div class="alt-group-title is-exact">✅ Přesná náhrada SKLADEM — stejná účinná látka (0 skladem)</div></div>`;

    const groupHtml = groupAlternatives.length
      ? `
        <div class="alt-group">
          <div class="alt-group-title is-moa">🧬 Alternativa SKLADEM — stejná chemická skupina + plodina (${groupAlternatives.length})</div>
          ${groupAlternatives
            .map(({ product: cand, sharedGroups, sharedCrops }) => {
              const ulComp = (cand.por?.ul || [])
                .map((u) => `<strong>${escapeHtml(u.n)}</strong>${u.c ? ` <span class="mono">${escapeHtml(u.c)}</span>` : ''}`)
                .join(' + ');
              const cropsLabels = sharedCrops
                .map((c) => CROP_CATEGORY_LABELS[c] || c)
                .join(', ');
              return renderAltItem(
                cand,
                `Skupina: <strong>${escapeHtml(sharedGroups.join(', '))}</strong>${cropsLabels ? ` · Plodina: <strong>${escapeHtml(cropsLabels)}</strong>` : ''}<br>Účinná látka: ${ulComp}`
              );
            })
            .join('')}
        </div>
      `
      : '';

    const exactCatalogHtml = exactCatalog.length
      ? `
        <div class="alt-group">
          <div class="alt-group-title is-catalog">📋 Přesná náhrada MIMO SKLAD (nemáme skladem) — stejná účinná látka (${totalExactCatalog}${totalExactCatalog > exactCatalog.length ? `, zobrazeno ${exactCatalog.length}` : ''})</div>
          ${exactCatalog
            .map(({ por: cPor, sharedUl }) => {
              const ulComp = (cPor.ul || [])
                .map((u) => `<strong>${escapeHtml(u.n)}</strong>${u.c ? ` <span class="mono">${escapeHtml(u.c)}</span>` : ''}`)
                .join(' + ');
              const targetComp = sharedUl
                .filter((s) => s.targetConc && s.candConc && s.targetConc !== s.candConc)
                .map((s) => `původně ${escapeHtml(s.targetConc)}`)
                .join(', ');
              return renderCatalogAltItem(
                cPor,
                `Složení: ${ulComp}${targetComp ? ` <span class="alt-conc-diff">(${targetComp})</span>` : ' <span class="alt-conc-match">(shodná koncentrace)</span>'}`
              );
            })
            .join('')}
        </div>
      `
      : '';

    const groupCatalogHtml = groupCatalog.length
      ? `
        <details class="por-legal-details" ${!hasAnyStock && !exactCatalog.length ? 'open' : ''}>
          <summary>📋 Další alternativy MIMO SKLAD — stejná chemická skupina + plodina (${totalGroupCatalog}${totalGroupCatalog > groupCatalog.length ? `, prvních ${groupCatalog.length}` : ''})</summary>
          <div class="alt-group" style="margin-top:8px;">
            ${groupCatalog
              .map(({ por: cPor, sharedGroups, sharedCrops }) => {
                const ulComp = (cPor.ul || [])
                  .map((u) => `<strong>${escapeHtml(u.n)}</strong>${u.c ? ` <span class="mono">${escapeHtml(u.c)}</span>` : ''}`)
                  .join(' + ');
                const cropsLabels = sharedCrops
                  .map((c) => CROP_CATEGORY_LABELS[c] || c)
                  .join(', ');
                return renderCatalogAltItem(
                  cPor,
                  `Skupina: <strong>${escapeHtml(sharedGroups.join(', '))}</strong>${cropsLabels ? ` · Plodina: <strong>${escapeHtml(cropsLabels)}</strong>` : ''}<br>Účinná látka: ${ulComp}`
                );
              })
              .join('')}
          </div>
        </details>
      `
      : '';

    return `
      <div class="alt-drawer">
        ${filterNoteHtml}
        ${exactHtml}
        ${groupHtml}
        ${exactCatalogHtml}
        ${groupCatalogHtml}
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
    renderCropTabs();
    renderSafetyChips();
    renderSelectedUlTags();
    renderCategories();
    renderResults();
  }

  return { render, setSearchQuery };
}
