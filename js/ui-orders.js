/**
 * Záložka: Objednávky (pro obchodníky v terénu, kancelář i skladníky).
 * - Mobilní objednávkový formulář s našeptávačem zákazníků z listu `Zakaznici`
 *   (seřazeno od odběratelů s nejvyšším obratem; zobrazuje kontakt, výchozí lokaci
 *   a diskrétní oranžové upozornění při `Zůstatek po splatnosti (LCY) > 0`).
 * - Pole „Do kdy doručit“ s rychlými tlačítky (`Ihned / Zítra`, `Do 3 dnů`, `Tento týden`),
 *   výběr střediska/lokace závozu, položky ze skladu s kontrolou volného množství a poznámka.
 * - Odeslání přes POST `{ action: "new_order", notify_email, order }` do Google Apps Scriptu
 *   s potvrzením uložení do Google Tabulky a odeslání na e-mail.
 * - Přehled a správa přijatých objednávek (`update_order_status`: Nová / Vychystává se / Vychystáno / Expedováno / Storno + šarže).
 */

import {
  detectBaseUnit,
  escapeHtml,
  formatIsoDateCz,
  formatNumberRaw,
  formatQty,
  getCzechFileTimestamp,
  getPackagingInfo,
  groupByProduct,
  normalizeText,
  prepocetNaBaleni,
  toCsv,
  triggerFileDownload,
  ziskejKrokBaleni,
} from './domain.js';
import {
  DEFAULT_NOTIFY_EMAIL,
  gasCreateOrder,
  gasUpdateOrderStatus,
} from './gas-api.js';

const DELIVERY_LOCATIONS = [
  'Boršice',
  'Valmez',
  'Staré Město',
  'Zlín',
  'Uherský Brod',
  'Slavičín',
  'Komise Boršice',
  'Komise Valmez',
  'Závoz přímo k zákazníkovi',
];

const ORDER_STATUSES = [
  'Nová',
  'Vychystává se',
  'Vychystáno',
  'Expedováno',
  'Storno',
];

function computeDeliveryDateIso(preset) {
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (preset === 'tomorrow') {
    target.setDate(target.getDate() + 1);
  } else if (preset === '3days') {
    target.setDate(target.getDate() + 3);
  } else if (preset === 'thisweek') {
    const day = target.getDay(); // 0=Ne, 1=Po ... 5=Pá
    const diffToFriday = day <= 5 ? Math.max(1, 5 - day) : 2;
    target.setDate(target.getDate() + diffToFriday);
  }
  const pad = (n) => String(n).padStart(2, '0');
  return `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}`;
}

export function createOrdersTab(ctx) {
  let selectedCustomer = null;
  let customerQuery = '';
  let deliveryDate = computeDeliveryDateIso('tomorrow');
  let deliveryPreset = 'tomorrow';
  let selectedLocation = 'Boršice';
  let orderNote = '';
  let cartItems = []; // [{ cislo_zbozi, nazev, mnozstvi, mj, lokace, maxAvailable, step }]

  let itemQuery = '';
  let pickedStockProduct = null;
  let orderStatusFilter = 'all';
  let lastOrderConfirmation = null;

  const panel = document.getElementById('tab-orders');

  panel.innerHTML = `
    <div class="section-header">
      <div>
        <h2 class="section-title">🛒 Objednávky &amp; expedice</h2>
        <p class="section-sub">Zadej novou objednávku z terénu nebo odbav přijaté objednávky ze skladu.</p>
      </div>
      <div style="display:flex;gap:6px;">
        <button type="button" id="ord-refresh-btn" class="btn btn-sm">🔄 Obnovit</button>
        <button type="button" id="ord-export-csv-btn" class="btn btn-sm">📥 Export CSV</button>
      </div>
    </div>

    <div id="ord-confirmation-banner" hidden></div>

    <!-- 1. Mobilní objednávkový formulář -->
    <div class="card">
      <div class="section-header" style="margin-bottom: 10px;">
        <h3 class="section-title">📝 Nová objednávka</h3>
        <span class="exp-pill is-ok" id="ord-email-target-pill"></span>
      </div>

      <form id="order-form" class="form-stack" autocomplete="off">
        <div class="form-grid-2">
          <div class="field">
            <label for="ord-salesperson">Obchodník *</label>
            <input id="ord-salesperson" class="input" placeholder="Jméno obchodníka (např. Peňáz)…" required />
          </div>
          <div class="field">
            <label for="ord-location">Středisko / lokace závozu *</label>
            <select id="ord-location" class="select">
              ${DELIVERY_LOCATIONS.map((l) => `<option value="${escapeHtml(l)}">${escapeHtml(l)}</option>`).join('')}
            </select>
          </div>
        </div>

        <!-- Výběr zákazníka z listu Zakaznici -->
        <div class="field" style="position: relative;" id="ord-cust-wrap">
          <label for="ord-cust-input">Odběratel (zákazník) * <span id="ord-cust-total-lbl" style="font-weight:500;color:var(--ink-muted);"></span></label>
          <div class="search-input-shell" style="border-radius: var(--radius-md); padding: 2px 6px 2px 12px;">
            <input
              type="search"
              id="ord-cust-input"
              class="search-input"
              style="padding: 8px 4px; font-size: 0.94rem;"
              placeholder="Hledej název, IČ nebo číslo zákazníka (nejvyšší obrat nahoře)…"
              autocomplete="off"
              required
            />
            <button type="button" id="ord-cust-clear" class="search-action-btn" title="Zrušit výběr zákazníka" hidden>✕</button>
          </div>
          <div id="ord-cust-dropdown" class="autocomplete-list" role="listbox" hidden></div>
        </div>

        <!-- Detail vybraného zákazníka + upozornění na zůstatek po splatnosti -->
        <div id="ord-cust-card" hidden></div>

        <!-- Ruční doplnění IČ / kontaktu (pokud v tabulce chybí) -->
        <div class="form-grid-2">
          <div class="field">
            <label for="ord-cust-ic">IČ / Číslo zákazníka</label>
            <input id="ord-cust-ic" class="input mono" placeholder="IČ nebo číslo v BC…" />
          </div>
          <div class="field">
            <label for="ord-cust-contact">Kontakt / telefon na zákazníka</label>
            <input id="ord-cust-contact" class="input" placeholder="Telefon nebo kontaktní osoba…" />
          </div>
        </div>

        <!-- Do kdy doručit + rychlá tlačítka -->
        <div class="field">
          <label for="ord-delivery-date">📅 Do kdy doručit *</label>
          <div class="ord-date-row">
            <input type="date" id="ord-delivery-date" class="input mono" required />
            <div class="chip-row" id="ord-date-presets" style="padding: 0;">
              <button type="button" class="chip is-active" data-date-preset="tomorrow">⚡ Ihned / Zítra</button>
              <button type="button" class="chip" data-date-preset="3days">📅 Do 3 dnů</button>
              <button type="button" class="chip" data-date-preset="thisweek">🗓️ Tento týden</button>
            </div>
          </div>
        </div>

        <!-- Přidání položek ze skladu s kontrolou volného množství -->
        <div class="ord-items-box">
          <div class="ord-items-head">
            <span style="font-weight:800;font-size:0.88rem;">📦 Položky objednávky</span>
            <span id="ord-cart-count" class="exp-pill is-ok">0 položek</span>
          </div>

          <div class="ord-item-picker" id="ord-item-picker-wrap">
            <div style="position: relative; flex: 2 1 220px;">
              <input
                type="search"
                id="ord-item-search"
                class="input"
                placeholder="Vyhledej přípravek nebo hnojivo ze skladu…"
                autocomplete="off"
              />
              <div id="ord-item-dropdown" class="autocomplete-list" role="listbox" hidden></div>
            </div>
            <div style="display:flex;gap:6px;flex: 1 1 180px;">
              <input
                type="number"
                id="ord-item-qty"
                class="input mono"
                min="0.001"
                step="any"
                inputmode="decimal"
                placeholder="Množství…"
              />
              <button type="button" id="ord-add-item-btn" class="btn btn-primary">+ Přidat</button>
            </div>
          </div>
          <div id="ord-item-stock-hint" class="ord-stock-hint" hidden></div>
          <div id="ord-item-quick-steppers" class="ord-quick-steppers" hidden></div>

          <div id="ord-cart-list" class="ord-cart-list"></div>
        </div>

        <div class="field">
          <label for="ord-note">Poznámka k objednávce / závozu</label>
          <textarea id="ord-note" class="textarea" style="min-height:66px;" placeholder="Např. volat hodinu předem, složit na středisku…"></textarea>
        </div>

        <button type="submit" id="ord-submit-btn" class="btn btn-primary btn-block">
          🚀 Odeslat objednávku do Google Tabulky a na e-mail
        </button>
      </form>
    </div>

    <!-- 2. Přehled přijatých objednávek (kancelář & skladník) -->
    <div class="card" style="margin-top: 14px;">
      <div class="section-header" style="margin-bottom: 10px;">
        <div>
          <h3 class="section-title">📋 Přijaté objednávky v Google Tabulce</h3>
          <p class="section-sub">Změna stavu nebo doplnění vychystané šarže se okamžitě propíše všem.</p>
        </div>
      </div>

      <div id="ord-status-filters" class="chip-row" style="margin-bottom: 10px;"></div>
      <div id="ord-orders-list"></div>
    </div>
  `;

  const confirmBanner = document.getElementById('ord-confirmation-banner');
  const emailTargetPill = document.getElementById('ord-email-target-pill');
  const form = document.getElementById('order-form');
  const salespersonInput = document.getElementById('ord-salesperson');
  const locationSelect = document.getElementById('ord-location');
  const custWrap = document.getElementById('ord-cust-wrap');
  const custTotalLbl = document.getElementById('ord-cust-total-lbl');
  const custInput = document.getElementById('ord-cust-input');
  const custClear = document.getElementById('ord-cust-clear');
  const custDropdown = document.getElementById('ord-cust-dropdown');
  const custCard = document.getElementById('ord-cust-card');
  const custIcInput = document.getElementById('ord-cust-ic');
  const custContactInput = document.getElementById('ord-cust-contact');
  const deliveryDateInput = document.getElementById('ord-delivery-date');
  const datePresetsEl = document.getElementById('ord-date-presets');
  const itemPickerWrap = document.getElementById('ord-item-picker-wrap');
  const itemSearchInput = document.getElementById('ord-item-search');
  const itemDropdown = document.getElementById('ord-item-dropdown');
  const itemQtyInput = document.getElementById('ord-item-qty');
  const addItemBtn = document.getElementById('ord-add-item-btn');
  const itemStockHint = document.getElementById('ord-item-stock-hint');
  const itemQuickSteppers = document.getElementById('ord-item-quick-steppers');
  const cartCountEl = document.getElementById('ord-cart-count');
  const cartListEl = document.getElementById('ord-cart-list');
  const noteInput = document.getElementById('ord-note');
  const submitBtn = document.getElementById('ord-submit-btn');
  const statusFiltersEl = document.getElementById('ord-status-filters');
  const ordersListEl = document.getElementById('ord-orders-list');
  const refreshBtn = document.getElementById('ord-refresh-btn');
  const exportCsvBtn = document.getElementById('ord-export-csv-btn');

  deliveryDateInput.value = deliveryDate;
  salespersonInput.value = ctx.state.prefs.salesperson || '';

  salespersonInput.addEventListener('change', () => {
    ctx.setPrefs({ salesperson: salespersonInput.value.trim() });
  });

  locationSelect.addEventListener('change', () => {
    selectedLocation = locationSelect.value;
    updateStockHint();
  });

  // --- Našeptávač zákazníků (seřazeno podle nejvyššího obratu) ---
  custInput.addEventListener('input', () => {
    customerQuery = custInput.value;
    selectedCustomer = null;
    custClear.hidden = !customerQuery.length;
    renderCustomerCard();
    renderCustomerDropdown();
  });

  custInput.addEventListener('focus', () => {
    renderCustomerDropdown();
  });

  custClear.addEventListener('click', () => {
    selectedCustomer = null;
    customerQuery = '';
    custInput.value = '';
    custIcInput.value = '';
    custContactInput.value = '';
    custClear.hidden = true;
    custDropdown.hidden = true;
    renderCustomerCard();
    custInput.focus();
  });

  custDropdown.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cust-idx]');
    if (!btn) return;
    const cust = ctx.state.customers[Number(btn.dataset.custIdx)];
    if (!cust) return;
    selectCustomer(cust);
  });

  function selectCustomer(cust) {
    selectedCustomer = cust;
    customerQuery = cust.nazev;
    custInput.value = cust.nazev;
    custIcInput.value = cust.ic || cust.cislo || '';
    custContactInput.value = cust.kontakt || cust.telefon || '';
    if (cust.lokace) {
      const locMatch = DELIVERY_LOCATIONS.find((l) =>
        normalizeText(l).includes(normalizeText(cust.lokace))
      );
      if (locMatch) {
        selectedLocation = locMatch;
        locationSelect.value = locMatch;
      }
    }
    custClear.hidden = false;
    custDropdown.hidden = true;
    renderCustomerCard();
  }

  function renderCustomerDropdown() {
    const customers = ctx.state.customers || [];
    if (!customers.length) {
      custDropdown.hidden = true;
      return;
    }

    const qNorm = normalizeText(customerQuery);
    const tokens = qNorm ? qNorm.split(/\s+/).filter(Boolean) : [];
    const matches = tokens.length
      ? customers.filter((c) => tokens.every((t) => c._search.includes(t))).slice(0, 25)
      : customers.slice(0, 20); // Top 20 odběratelů podle obratu

    if (!matches.length) {
      custDropdown.innerHTML = `<div style="padding:10px 12px;font-size:0.82rem;color:var(--ink-muted);">Žádný zákazník v seznamu — můžeš ho zadat ručně výše.</div>`;
      custDropdown.hidden = false;
      return;
    }

    custDropdown.innerHTML = matches
      .map((c) => {
        const idx = customers.indexOf(c);
        const overdueBadge =
          c.poSplatnosti > 0
            ? `<span class="hazard-badge is-bee-warn">Po splatnosti: ${formatQty(c.poSplatnosti)} Kč</span>`
            : '';
        return `
          <button type="button" class="ac-item" role="option" data-cust-idx="${idx}">
            <div>
              <div class="ac-item-name">${escapeHtml(c.nazev)}</div>
              <div class="ac-item-meta">
                ${c.cislo ? `Číslo/IČ: <span class="mono">${escapeHtml(c.cislo)}</span>` : ''}
                ${c.lokace ? ` · Lokace: ${escapeHtml(c.lokace)}` : ''}
                ${c.kontakt ? ` · ${escapeHtml(c.kontakt)}` : ''}
              </div>
            </div>
            ${overdueBadge || (c.obrat > 0 ? `<span class="ac-item-qty">${formatQty(c.obrat)} Kč</span>` : `<span class="ac-item-qty">TOP #${c.rowIndex + 1}</span>`)}
          </button>
        `;
      })
      .join('');
    custDropdown.hidden = false;
  }

  function renderCustomerCard() {
    if (!selectedCustomer) {
      custCard.hidden = true;
      custCard.innerHTML = '';
      return;
    }
    const c = selectedCustomer;
    const overdueHtml =
      c.poSplatnosti > 0
        ? `<div class="callout callout-fefo" style="margin-top:8px;">
             <span class="callout-icon">⚠️</span>
             <div>
               <strong>Upozornění: Zůstatek po splatnosti ${formatQty(c.poSplatnosti)} Kč (LCY)</strong><br>
               Před potvrzením závozu prosím ověř platební morálku nebo uvolnění v BC.
             </div>
           </div>`
        : '';

    custCard.hidden = false;
    custCard.innerHTML = `
      <div class="cust-selected-banner">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
          <div>
            <strong>🏢 ${escapeHtml(c.nazev)}</strong>
            ${c.cislo ? ` <span class="code-chip">Číslo/IČ: ${escapeHtml(c.cislo)}</span>` : ''}
          </div>
          ${c.lokace ? `<span class="exp-pill is-ok">📍 Výchozí lokace: ${escapeHtml(c.lokace)}</span>` : ''}
        </div>
        ${c.kontakt ? `<div style="font-size:0.8rem;color:var(--ink-secondary);margin-top:4px;">📞 Kontakt: <strong>${escapeHtml(c.kontakt)}</strong></div>` : ''}
        ${overdueHtml}
      </div>
    `;
  }

  // --- Datum doručení & rychlá tlačítka ---
  datePresetsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-date-preset]');
    if (!btn) return;
    deliveryPreset = btn.dataset.datePreset;
    deliveryDate = computeDeliveryDateIso(deliveryPreset);
    deliveryDateInput.value = deliveryDate;
    datePresetsEl.querySelectorAll('[data-date-preset]').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.datePreset === deliveryPreset);
    });
  });

  deliveryDateInput.addEventListener('change', () => {
    deliveryDate = deliveryDateInput.value;
    deliveryPreset = '';
    datePresetsEl.querySelectorAll('[data-date-preset]').forEach((b) => b.classList.remove('is-active'));
  });

  // --- Výběr položek ze skladu ---
  function getAvailableStockProducts() {
    return groupByProduct(ctx.state.items);
  }

  itemSearchInput.addEventListener('input', () => {
    itemQuery = itemSearchInput.value;
    pickedStockProduct = null;
    updateStockHint();
    renderItemDropdown();
  });

  itemSearchInput.addEventListener('focus', () => {
    renderItemDropdown();
  });

  itemDropdown.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-pick-code]');
    if (!btn) return;
    const code = btn.dataset.pickCode;
    const prod = getAvailableStockProducts().find((p) => p.code === code);
    if (!prod) return;
    selectProductForOrder(prod);
  });

  function selectProductForOrder(prod) {
    pickedStockProduct = prod;
    itemQuery = prod.name;
    itemSearchInput.value = prod.name;
    itemDropdown.hidden = true;
    const step = ziskejKrokBaleni(prod.code, prod.name, ctx.state.customPacks);
    itemQtyInput.step = String(step);
    if (!itemQtyInput.value) itemQtyInput.value = formatNumberRaw(step);
    updateStockHint();
    itemQtyInput.focus();
  }

  function getProductAvailableQty(prod) {
    if (!prod) return { total: 0, atLoc: 0 };
    const locNorm = normalizeText(selectedLocation);
    let atLoc = 0;
    for (const b of prod.batches || []) {
      if (
        normalizeText(b.wh).includes(locNorm) ||
        normalizeText(b.ln).includes(locNorm)
      ) {
        atLoc += b.q;
      }
    }
    return {
      total: Math.round(prod.totalQty * 1000) / 1000,
      atLoc: Math.round(atLoc * 1000) / 1000,
    };
  }

  function updateStockHint() {
    if (!pickedStockProduct) {
      itemStockHint.hidden = true;
      itemStockHint.innerHTML = '';
      itemQuickSteppers.hidden = true;
      itemQuickSteppers.innerHTML = '';
      return;
    }
    const { total, atLoc } = getProductAvailableQty(pickedStockProduct);
    const pkg = getPackagingInfo(pickedStockProduct.code, pickedStockProduct.name, ctx.state.customPacks);
    const uom = pkg.uomDisplay;
    const pack = prepocetNaBaleni(
      pickedStockProduct.code,
      pickedStockProduct.name,
      total,
      ctx.state.customPacks
    );
    itemStockHint.hidden = false;
    itemStockHint.innerHTML = `
      <span>Volné množství celkem: <strong>${formatQty(total)} ${uom}</strong> <em>(= ${escapeHtml(pack)})</em></span>
      ${atLoc > 0 ? ` · <span>Na středisku ${escapeHtml(selectedLocation)}: <strong>${formatQty(atLoc)} ${uom}</strong></span>` : ''}
    `;

    const curQty = parseFloat(String(itemQtyInput.value || '').replace(',', '.')) || 0;
    const curPack = curQty > 0
      ? prepocetNaBaleni(pickedStockProduct.code, pickedStockProduct.name, curQty, ctx.state.customPacks)
      : '';

    const cartonBtns = pkg.hasCarton
      ? `
          <button type="button" class="stepper-btn stepper-btn-sm" data-ord-delta="${-pkg.cartonSize}">−1 karton (−${formatQty(pkg.cartonSize)} ${uom})</button>
          <button type="button" class="stepper-btn stepper-btn-sm is-carton" data-ord-delta="${pkg.cartonSize}">+1 karton (+${formatQty(pkg.cartonSize)} ${uom})</button>
        `
      : '';

    itemQuickSteppers.hidden = false;
    itemQuickSteppers.innerHTML = `
      <div class="stepper-row stepper-row-compact">
        ${cartonBtns}
        <button type="button" class="stepper-btn stepper-btn-sm" data-ord-delta="${-pkg.unitSize}">−1 ks (−${formatQty(pkg.unitSize)} ${uom})</button>
        <button type="button" class="stepper-btn stepper-btn-sm" data-ord-delta="${pkg.unitSize}">+1 ks (+${formatQty(pkg.unitSize)} ${uom})</button>
      </div>
      ${curPack ? `<div class="ord-qty-preview">Zadáno: <strong>${formatQty(curQty)} ${uom}</strong> = <strong>${escapeHtml(curPack)}</strong></div>` : ''}
    `;
  }

  itemQuickSteppers.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-ord-delta]');
    if (!btn || !pickedStockProduct) return;
    const delta = parseFloat(btn.dataset.ordDelta);
    const cur = parseFloat(String(itemQtyInput.value || '').replace(',', '.')) || 0;
    const next = Math.max(0, Math.round((cur + delta) * 1000) / 1000);
    itemQtyInput.value = next > 0 ? formatNumberRaw(next) : '';
    updateStockHint();
  });

  itemQtyInput.addEventListener('input', () => {
    if (pickedStockProduct) updateStockHint();
  });

  function renderItemDropdown() {
    const prods = getAvailableStockProducts();
    const qNorm = normalizeText(itemQuery);
    const tokens = qNorm ? qNorm.split(/\s+/).filter(Boolean) : [];
    const matches = tokens.length
      ? prods
          .filter((p) =>
            p.batches.some((b) => tokens.every((t) => b._search.includes(t)))
          )
          .slice(0, 20)
      : prods.slice(0, 15);

    if (!matches.length) {
      itemDropdown.hidden = true;
      return;
    }

    itemDropdown.innerHTML = matches
      .map((p) => {
        const uom = detectBaseUnit(p.name).toUpperCase();
        const pack = prepocetNaBaleni(p.code, p.name, p.totalQty, ctx.state.customPacks);
        return `
          <button type="button" class="ac-item" role="option" data-pick-code="${escapeHtml(p.code)}">
            <div>
              <div class="ac-item-name">${escapeHtml(p.name)}</div>
              <div class="ac-item-meta"><span class="mono">${escapeHtml(p.code)}</span> · ${p.cat.icon} ${escapeHtml(p.cat.label)} · ${escapeHtml(pack)}</div>
            </div>
            <span class="ac-item-qty">${formatQty(p.totalQty)} ${uom}</span>
          </button>
        `;
      })
      .join('');
    itemDropdown.hidden = false;
  }

  addItemBtn.addEventListener('click', () => {
    addCurrentItemToCart();
  });

  itemQtyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addCurrentItemToCart();
    }
  });

  function addCurrentItemToCart() {
    let prod = pickedStockProduct;
    if (!prod && itemSearchInput.value.trim()) {
      const q = normalizeText(itemSearchInput.value.trim());
      prod = getAvailableStockProducts().find((p) => normalizeText(p.name) === q || normalizeText(p.code) === q);
    }
    if (!prod) {
      ctx.toast('Vyber prosím nejprve položku ze skladu z našeptávače.', 'warn');
      itemSearchInput.focus();
      return;
    }

    const qty = parseFloat(String(itemQtyInput.value || '').replace(',', '.'));
    if (!qty || qty <= 0) {
      ctx.toast('Zadej platné množství (> 0).', 'danger');
      itemQtyInput.focus();
      return;
    }

    const { total } = getProductAvailableQty(prod);
    const uom = detectBaseUnit(prod.name).toUpperCase();

    const existingIdx = cartItems.findIndex(
      (i) => i.cislo_zbozi === prod.code && i.lokace === selectedLocation
    );
    const nextTotalQty = existingIdx >= 0 ? cartItems[existingIdx].mnozstvi + qty : qty;

    if (nextTotalQty > total) {
      ctx.toast(
        `⚠️ Pozor: požadované množství (${formatQty(nextTotalQty)} ${uom}) převyšuje volný sklad (${formatQty(total)} ${uom}).`,
        'warn'
      );
    }

    if (existingIdx >= 0) {
      cartItems[existingIdx].mnozstvi = Math.round(nextTotalQty * 1000) / 1000;
    } else {
      cartItems.push({
        cislo_zbozi: prod.code,
        nazev: prod.name,
        mnozstvi: Math.round(qty * 1000) / 1000,
        mj: uom === 'KG' ? 'KG' : 'L',
        lokace: selectedLocation,
        maxAvailable: total,
      });
    }

    pickedStockProduct = null;
    itemQuery = '';
    itemSearchInput.value = '';
    itemQtyInput.value = '';
    itemStockHint.hidden = true;
    itemQuickSteppers.hidden = true;
    itemQuickSteppers.innerHTML = '';
    renderCart();
  }

  cartListEl.addEventListener('click', (e) => {
    const stepBtn = e.target.closest('[data-cart-delta]');
    if (stepBtn) {
      const idx = Number(stepBtn.dataset.cartIdx);
      const delta = parseFloat(stepBtn.dataset.cartDelta);
      if (cartItems[idx]) {
        const next = Math.round((cartItems[idx].mnozstvi + delta) * 1000) / 1000;
        if (next <= 0) {
          cartItems.splice(idx, 1);
        } else {
          cartItems[idx].mnozstvi = next;
        }
        renderCart();
      }
      return;
    }

    const rmBtn = e.target.closest('[data-cart-rm]');
    if (!rmBtn) return;
    const idx = Number(rmBtn.dataset.cartRm);
    cartItems.splice(idx, 1);
    renderCart();
  });

  cartListEl.addEventListener('change', (e) => {
    const qtyIn = e.target.closest('[data-cart-qty]');
    if (!qtyIn) return;
    const idx = Number(qtyIn.dataset.cartQty);
    const val = parseFloat(String(qtyIn.value || '').replace(',', '.'));
    if (val > 0 && cartItems[idx]) {
      cartItems[idx].mnozstvi = Math.round(val * 1000) / 1000;
      renderCart();
    }
  });

  function renderCart() {
    cartCountEl.textContent = `${cartItems.length} ${cartItems.length === 1 ? 'položka' : cartItems.length >= 2 && cartItems.length <= 4 ? 'položky' : 'položek'}`;
    if (!cartItems.length) {
      cartListEl.innerHTML = `<div class="ord-cart-empty">Zatím nejsou přidány žádné položky. Vyber přípravek výše nebo klikni na „🛒 Objednat“ přímo na kartě produktu v katalogu.</div>`;
      return;
    }

    cartListEl.innerHTML = cartItems
      .map((it, idx) => {
        const overStock = it.maxAvailable > 0 && it.mnozstvi > it.maxAvailable;
        const pkg = getPackagingInfo(it.cislo_zbozi, it.nazev, ctx.state.customPacks);
        const pack = prepocetNaBaleni(it.cislo_zbozi, it.nazev, it.mnozstvi, ctx.state.customPacks);
        const uom = pkg.uomDisplay;
        return `
          <div class="ord-cart-item ${overStock ? 'is-overstock' : ''}">
            <div class="ord-cart-main">
              <div style="font-weight:800;font-size:0.88rem;">${escapeHtml(it.nazev)}</div>
              <div style="font-size:0.76rem;color:var(--ink-secondary);margin-top:2px;">
                <span class="mono">${escapeHtml(it.cislo_zbozi)}</span> · Sklad: <strong>${escapeHtml(it.lokace)}</strong> ·
                <strong>${formatQty(it.mnozstvi)} ${escapeHtml(it.mj)} = ${escapeHtml(pack)}</strong>
                ${overStock ? `<span style="color:var(--danger);font-weight:700;"> (Skladem jen ${formatQty(it.maxAvailable)} ${escapeHtml(it.mj)})</span>` : ''}
              </div>
              <div class="ord-cart-steppers">
                ${
                  pkg.hasCarton
                    ? `<button type="button" class="stepper-btn stepper-btn-xs" data-cart-idx="${idx}" data-cart-delta="${-pkg.cartonSize}">−1 kart.</button>
                       <button type="button" class="stepper-btn stepper-btn-xs is-carton" data-cart-idx="${idx}" data-cart-delta="${pkg.cartonSize}">+1 kart. (+${formatQty(pkg.cartonSize)} ${uom})</button>`
                    : ''
                }
                <button type="button" class="stepper-btn stepper-btn-xs" data-cart-idx="${idx}" data-cart-delta="${-pkg.unitSize}">−1 ks</button>
                <button type="button" class="stepper-btn stepper-btn-xs" data-cart-idx="${idx}" data-cart-delta="${pkg.unitSize}">+1 ks (+${formatQty(pkg.unitSize)} ${uom})</button>
              </div>
            </div>
            <div class="ord-cart-controls">
              <input type="number" class="input mono ord-cart-qty-input" min="0.001" step="any" value="${formatNumberRaw(it.mnozstvi)}" data-cart-qty="${idx}" aria-label="Množství" />
              <span class="mono" style="font-size:0.8rem;font-weight:700;">${escapeHtml(it.mj)}</span>
              <button type="button" class="btn btn-soft-danger btn-sm" data-cart-rm="${idx}" title="Odebrat položku">✕</button>
            </div>
          </div>
        `;
      })
      .join('');
  }

  document.addEventListener('click', (e) => {
    if (!panel.contains(e.target)) {
      custDropdown.hidden = true;
      itemDropdown.hidden = true;
      return;
    }
    if (!custWrap.contains(e.target)) custDropdown.hidden = true;
    if (!itemPickerWrap.contains(e.target)) itemDropdown.hidden = true;
  });

  // --- Odeslání nové objednávky do Google Apps Scriptu ---
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const obchodnik = salespersonInput.value.trim();
    const zakaznikNazev = (selectedCustomer?.nazev || custInput.value).trim();
    if (!obchodnik) {
      ctx.toast('Vyplň prosím jméno obchodníka.', 'danger');
      salespersonInput.focus();
      return;
    }
    if (!zakaznikNazev) {
      ctx.toast('Vyber nebo napiš jméno zákazníka.', 'danger');
      custInput.focus();
      return;
    }
    if (!cartItems.length) {
      ctx.toast('Přidej do objednávky alespoň jednu položku ze skladu.', 'danger');
      itemSearchInput.focus();
      return;
    }

    ctx.setPrefs({ salesperson: obchodnik });

    const notifyEmail = ctx.state.prefs.notifyEmail || DEFAULT_NOTIFY_EMAIL;
    const orderPayload = {
      obchodnik,
      zakaznik_cislo: String(selectedCustomer?.cislo || custIcInput.value.trim() || ''),
      zakaznik_nazev: zakaznikNazev,
      zakaznik_ic: String(custIcInput.value.trim() || selectedCustomer?.ic || selectedCustomer?.cislo || ''),
      zakaznik_kontakt: String(custContactInput.value.trim() || selectedCustomer?.kontakt || ''),
      lokace: locationSelect.value,
      termin_dodani: deliveryDateInput.value,
      poznamka: noteInput.value.trim(),
      items: cartItems.map((it) => ({
        cislo_zbozi: it.cislo_zbozi,
        nazev: it.nazev,
        mnozstvi: Number(it.mnozstvi),
        mj: it.mj,
        lokace: it.lokace,
      })),
    };

    submitBtn.disabled = true;
    const origText = submitBtn.innerHTML;
    submitBtn.innerHTML = `<span class="btn-spinner"></span> Odesílám do Google Tabulky a na ${escapeHtml(notifyEmail)}…`;

    try {
      const resp = await gasCreateOrder(orderPayload, notifyEmail, ctx.state.prefs.gasUrl);
      const orderId = resp.order_id || `OBJ-${Date.now()}`;

      lastOrderConfirmation = {
        orderId,
        customer: zakaznikNazev,
        email: notifyEmail,
        itemsCount: cartItems.length,
        time: new Date().toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' }),
      };

      // Vyčistit formulář pro další objednávku
      cartItems = [];
      selectedCustomer = null;
      customerQuery = '';
      custInput.value = '';
      custIcInput.value = '';
      custContactInput.value = '';
      custClear.hidden = true;
      noteInput.value = '';
      renderCustomerCard();
      renderCart();
      renderConfirmationBanner();

      ctx.toast(
        `✅ Objednávka ${orderId} uložena do Google Tabulky a odeslána na ${notifyEmail}`,
        'success'
      );
      await ctx.syncFromGas({ silent: true });
    } catch (err) {
      ctx.toast(
        `❌ Chyba při odesílání objednávky: ${err.message || 'zkontroluj internetové připojení'}`,
        'danger'
      );
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = origText;
    }
  });

  function renderConfirmationBanner() {
    if (!lastOrderConfirmation) {
      confirmBanner.hidden = true;
      confirmBanner.innerHTML = '';
      return;
    }
    const c = lastOrderConfirmation;
    confirmBanner.hidden = false;
    confirmBanner.innerHTML = `
      <div class="callout" style="background:var(--brand-50);border:1.5px solid var(--brand-600);color:var(--brand-950);margin-bottom:12px;justify-content:space-between;align-items:center;">
        <div style="display:flex;gap:10px;align-items:flex-start;">
          <span class="callout-icon">✅</span>
          <div>
            <strong>Objednávka <span class="mono">${escapeHtml(c.orderId)}</span> byla uložena do Google Tabulky!</strong><br>
            Odběratel: <strong>${escapeHtml(c.customer)}</strong> (${c.itemsCount} pol.) · E-mailová notifikace odeslána na <strong>${escapeHtml(c.email)}</strong> (${escapeHtml(c.time)}).
          </div>
        </div>
        <button type="button" class="btn btn-sm" id="ord-dismiss-confirm">OK</button>
      </div>
    `;
    document.getElementById('ord-dismiss-confirm')?.addEventListener('click', () => {
      lastOrderConfirmation = null;
      renderConfirmationBanner();
    });
  }

  // --- Správa přijatých objednávek (update_order_status) ---
  statusFiltersEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-ord-filter]');
    if (!btn) return;
    orderStatusFilter = btn.dataset.ordFilter;
    renderOrdersHistory();
  });

  ordersListEl.addEventListener('click', async (e) => {
    const saveBtn = e.target.closest('[data-save-order-id]');
    if (!saveBtn) return;
    const orderId = saveBtn.dataset.saveOrderId;
    const card = saveBtn.closest('[data-order-card]');
    if (!card) return;
    const stav = card.querySelector('select[name="stav"]').value;
    const sarze = card.querySelector('input[name="sarze"]').value.trim();

    saveBtn.disabled = true;
    const orig = saveBtn.innerHTML;
    saveBtn.innerHTML = `<span class="btn-spinner"></span> Ukládám…`;

    try {
      await gasUpdateOrderStatus(orderId, stav, sarze, ctx.state.prefs.gasUrl);
      const found = ctx.state.orders.find((o) => o.id === orderId);
      if (found) {
        found.stav = stav;
        found.sarze = sarze;
      }
      ctx.updateBadges();
      renderOrdersHistory();
      ctx.toast(`✅ Stav objednávky ${orderId} změněn na „${stav}“`, 'success');
    } catch (err) {
      ctx.toast(`❌ Nepodařilo se uložit stav: ${err.message}`, 'danger');
      saveBtn.disabled = false;
      saveBtn.innerHTML = orig;
    }
  });

  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    const orig = refreshBtn.innerHTML;
    refreshBtn.innerHTML = `<span class="btn-spinner"></span> Obnovuji…`;
    await ctx.syncFromGas({ silent: false });
    refreshBtn.disabled = false;
    refreshBtn.innerHTML = orig;
  });

  exportCsvBtn.addEventListener('click', () => {
    const orders = ctx.state.orders || [];
    if (!orders.length) {
      ctx.toast('Žádné objednávky k exportu.', 'warn');
      return;
    }
    const headers = [
      'ID objednávky',
      'Datum zadání',
      'Stav',
      'Obchodník',
      'Číslo zákazníka',
      'Zákazník',
      'IČ',
      'Lokace',
      'Termín dodání',
      'Položky',
      'Poznámka',
      'Vychystané šarže',
    ];
    const rows = orders.map((o) => [
      o.id,
      o.datumZadani,
      o.stav,
      o.obchodnik,
      o.zakaznikCislo,
      o.zakaznikNazev,
      o.zakaznikIc,
      o.lokace,
      o.terminDodani,
      o.polozkyPrehled,
      o.poznamka,
      o.sarze,
    ]);
    triggerFileDownload(toCsv(headers, rows, ';'), `objednavky_${getCzechFileTimestamp()}.csv`);
    ctx.toast(`Exportováno ${orders.length} objednávek do CSV`, 'success');
  });

  function renderOrdersHistory() {
    const orders = ctx.state.orders || [];
    const counts = { all: orders.length };
    for (const s of ORDER_STATUSES) counts[s] = 0;
    for (const o of orders) counts[o.stav] = (counts[o.stav] || 0) + 1;

    statusFiltersEl.innerHTML = [
      `<button type="button" class="chip ${orderStatusFilter === 'all' ? 'is-active' : ''}" data-ord-filter="all">Vše <span class="chip-count">${orders.length}</span></button>`,
      ...ORDER_STATUSES.map(
        (s) =>
          `<button type="button" class="chip ${orderStatusFilter === s ? 'is-active' : ''}" data-ord-filter="${escapeHtml(s)}">${escapeHtml(s)} <span class="chip-count">${counts[s] || 0}</span></button>`
      ),
    ].join('');

    const filtered =
      orderStatusFilter === 'all'
        ? orders
        : orders.filter((o) => o.stav === orderStatusFilter);

    if (!filtered.length) {
      ordersListEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">📭</div>
          <h3>Žádné objednávky v tomto stavu</h3>
          <p>Jakmile obchodník odešle objednávku z mobilu nebo PC, okamžitě se zobrazí zde.</p>
        </div>
      `;
      return;
    }

    ordersListEl.innerHTML = filtered
      .map((o) => {
        const statusTone =
          o.stav === 'Nová'
            ? 'is-warning'
            : o.stav === 'Vychystáno' || o.stav === 'Expedováno'
              ? 'is-ok'
              : o.stav === 'Storno'
                ? 'is-expired'
                : 'is-pho-restricted';

        const itemsHtml = o.items?.length
          ? `<div class="ord-card-items">
               ${o.items
                 .map((it) => {
                   const pack = prepocetNaBaleni(it.cislo_zbozi, it.nazev, it.mnozstvi, ctx.state.customPacks);
                   return `<div class="ord-card-item-row">
                        <span><strong>${escapeHtml(it.nazev)}</strong> <span class="mono" style="color:var(--ink-muted)">(${escapeHtml(it.cislo_zbozi || '')})</span></span>
                        <span class="mono" style="font-weight:800;">${formatQty(it.mnozstvi)} ${escapeHtml(it.mj || 'j.')} <span style="font-weight:600;color:var(--ink-muted);">(= ${escapeHtml(pack)})</span> · ${escapeHtml(it.lokace || o.lokace)}</span>
                      </div>`;
                 })
                 .join('')}
             </div>`
          : `<div class="ord-card-items">${escapeHtml(o.polozkyPrehled)}</div>`;

        return `
          <article class="report-card" data-order-card="${escapeHtml(o.id)}">
            <div class="report-card-head">
              <div>
                <div style="font-weight:800;font-size:0.96rem;">
                  ${escapeHtml(o.zakaznikNazev || 'Zákazník')}
                  ${o.zakaznikIc ? `<span class="code-chip">IČ: ${escapeHtml(o.zakaznikIc)}</span>` : ''}
                </div>
                <div style="font-size:0.78rem;color:var(--ink-muted);margin-top:3px;">
                  <strong class="mono">${escapeHtml(o.id)}</strong> · Zadáno: ${escapeHtml(o.datumZadani)} ·
                  Obchodník: <strong>${escapeHtml(o.obchodnik || '—')}</strong> ·
                  Středisko: <strong>${escapeHtml(o.lokace || '—')}</strong> ·
                  Doručit do: <strong>${escapeHtml(formatIsoDateCz(o.terminDodani))}</strong>
                </div>
              </div>
              <span class="exp-pill ${statusTone}">${escapeHtml(o.stav)}</span>
            </div>

            ${itemsHtml}
            ${o.poznamka ? `<div class="report-note">💬 ${escapeHtml(o.poznamka)}</div>` : ''}

            <div class="ord-status-bar">
              <select name="stav" class="select" style="min-height:36px;padding:5px 10px;font-size:0.82rem;">
                ${ORDER_STATUSES.map((s) => `<option value="${escapeHtml(s)}" ${s === o.stav ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('')}
              </select>
              <input
                type="text"
                name="sarze"
                class="input mono"
                style="min-height:36px;padding:5px 10px;font-size:0.82rem;"
                placeholder="Vychystaná šarže (např. 26G2444)…"
                value="${escapeHtml(o.sarze || '')}"
              />
              <button type="button" class="btn btn-primary btn-sm" data-save-order-id="${escapeHtml(o.id)}">
                💾 Uložit stav
              </button>
            </div>
          </article>
        `;
      })
      .join('');
  }

  /**
   * Přidá produkt do rozpracované objednávky přímo z katalogu.
   */
  function prefillProductToOrder(productCode, warehouseHint = '') {
    const prod = getAvailableStockProducts().find((p) => p.code === productCode);
    if (!prod) return;
    if (warehouseHint === 'Valmez' || warehouseHint === 'Boršice') {
      selectedLocation = warehouseHint;
      locationSelect.value = warehouseHint;
    }
    const step = ziskejKrokBaleni(prod.code, prod.name, ctx.state.customPacks);
    const { total } = getProductAvailableQty(prod);
    const uom = detectBaseUnit(prod.name).toUpperCase();

    const existing = cartItems.find(
      (i) => i.cislo_zbozi === prod.code && i.lokace === selectedLocation
    );
    if (existing) {
      existing.mnozstvi = Math.round((existing.mnozstvi + step) * 1000) / 1000;
    } else {
      cartItems.push({
        cislo_zbozi: prod.code,
        nazev: prod.name,
        mnozstvi: step,
        mj: uom === 'KG' ? 'KG' : 'L',
        lokace: selectedLocation,
        maxAvailable: total,
      });
    }
    render();
    ctx.toast(`🛒 Přidáno do objednávky: ${prod.name} (${formatQty(step)} ${uom})`, 'success');
  }

  function render() {
    const notifyEmail = ctx.state.prefs.notifyEmail || DEFAULT_NOTIFY_EMAIL;
    emailTargetPill.textContent = `📧 Notifikace: ${notifyEmail}`;
    const custCount = (ctx.state.customers || []).length;
    custTotalLbl.textContent = custCount > 0 ? `(${custCount.toLocaleString('cs-CZ')} v databázi)` : '';
    renderCustomerCard();
    renderCart();
    renderConfirmationBanner();
    renderOrdersHistory();
  }

  return { render, prefillProductToOrder };
}
