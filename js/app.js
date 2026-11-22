/**
 * Skladový asistent — hlavní řídicí modul aplikace.
 * Automaticky načítá data skladu i denně synchronizovaný registr ÚKZÚZ (POR)
 * a páruje je podle očištěného názvu nebo registračního čísla.
 */

import {
  enrichItems,
  evaluateExpiration,
  filterByWarehouse,
  getTodayMidnightMs,
} from './domain.js';
import {
  loadCustomPacks,
  loadInventoryRecords,
  loadLocalPorData,
  loadLocalStockData,
  loadPrefs,
  loadReports,
  saveCustomPacks,
  savePrefs,
} from './storage.js';
import {
  buildPorIndex,
  buildPorSearchText,
  matchProductToPor,
} from './ukzuz.js';
import { WakeLockController } from './wake-lock.js';
import { createSearchTab } from './ui-search.js';
import { createExpirationsTab } from './ui-expirations.js';
import { createInventoryTab } from './ui-inventory.js';
import { createReportsTab } from './ui-reports.js';
import { createDataTab } from './ui-data.js';

const POR_JSON_URL = './public/data/por_aktualni.json';

const state = {
  meta: null,
  rawItems: [],
  items: [],
  porMeta: null,
  porItems: [],
  porIndex: null,
  customPacks: loadCustomPacks(),
  inventory: loadInventoryRecords(),
  reports: loadReports(),
  prefs: loadPrefs(),
  activeTab: 'search',
};

const tabs = {};

// --- Toasty ---
function toast(message, tone = 'default') {
  const stack = document.getElementById('toast-stack');
  if (!stack) return;
  const el = document.createElement('div');
  el.className = `toast ${tone !== 'default' ? `is-${tone}` : ''}`;
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    el.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
    setTimeout(() => el.remove(), 220);
  }, 3000);
}

// --- Stav sítě ---
function updateNetworkIndicator() {
  const pill = document.getElementById('net-status-pill');
  const txt = document.getElementById('net-status-text');
  if (!pill || !txt) return;
  const online = navigator.onLine;
  pill.classList.toggle('is-offline', !online);
  txt.textContent = online ? 'Připraveno' : 'Offline režim';
}

// --- Wake Lock v hlavičce ---
const wakeBtn = document.getElementById('wake-toggle-btn');
const wakeController = new WakeLockController({
  enabled: state.prefs.wakeLockEnabled,
  onStatusChange: ({ enabled, mode }) => {
    if (!wakeBtn) return;
    wakeBtn.classList.toggle('is-active', enabled);
    wakeBtn.setAttribute('aria-pressed', String(enabled));
    const longLbl = wakeBtn.querySelector('.wake-label-long');
    const shortLbl = wakeBtn.querySelector('.wake-label-short');
    if (enabled) {
      if (longLbl) longLbl.textContent = mode === 'pending' ? 'Displej nezhasne (klepni)' : 'Displej nezhasne';
      if (shortLbl) shortLbl.textContent = 'Bdělý';
      wakeBtn.title = 'Režim skladu ZAPNUT — obrazovka nezhasne';
    } else {
      if (longLbl) longLbl.textContent = 'Režim spánku povolen';
      if (shortLbl) shortLbl.textContent = 'Spánek';
      wakeBtn.title = 'Režim skladu VYPNUT — obrazovka se může zhasnout';
    }
  },
});

wakeBtn?.addEventListener('click', () => {
  const next = wakeController.toggle();
  setPrefs({ wakeLockEnabled: next });
  toast(
    next ? '🔆 Režim skladu zapnut — displej nezhasne' : '🌙 Režim skladu vypnut',
    next ? 'success' : 'default'
  );
});

// --- Globální filtr skladu ---
function renderWarehouseBar() {
  const bar = document.getElementById('warehouse-strip');
  if (!bar) return;

  const current = state.prefs.warehouseFilter || 'all';
  const countProds = (filterKey) => {
    const filtered = filterByWarehouse(state.items, filterKey);
    return new Set(filtered.map((i) => i.c)).size;
  };

  const options = [
    { key: 'all', label: 'Vše', count: countProds('all') },
    { key: 'Boršice', label: 'Boršice', count: countProds('Boršice') },
    { key: 'Valmez', label: 'Valmez', count: countProds('Valmez') },
    { key: 'komise', label: 'Komise', count: countProds('komise') },
  ];

  bar.innerHTML = options
    .map(
      (o) => `
      <button type="button" class="wh-btn ${current === o.key ? 'is-active' : ''}" data-wh="${o.key}" aria-pressed="${current === o.key}">
        <span>${o.label}</span>
        <span class="wh-count">${o.count}</span>
      </button>
    `
    )
    .join('');
}

document.getElementById('warehouse-strip')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-wh]');
  if (!btn) return;
  setPrefs({ warehouseFilter: btn.dataset.wh });
  renderWarehouseBar();
  updateBadges();
  tabs.search.render();
  tabs.expirations.render();
});

// --- Hlavička: čas aktualizace skladu + synchronizace ÚKZÚZ ---
function renderHeaderMeta() {
  const stockEl = document.getElementById('header-updated-at');
  if (stockEl) {
    stockEl.textContent = state.meta?.updatedAt ? `Sklad: ${state.meta.updatedAt}` : 'Načítám data…';
  }

  const ukzuzEl = document.getElementById('header-ukzuz-at');
  const ukzuzSep = document.getElementById('header-ukzuz-sep');
  if (ukzuzEl && ukzuzSep) {
    if (state.porMeta?.updatedAt) {
      ukzuzEl.textContent = `ÚKZÚZ: ${state.porMeta.updatedAt}`;
      ukzuzEl.hidden = false;
      ukzuzSep.hidden = false;
    } else {
      ukzuzEl.hidden = true;
      ukzuzSep.hidden = true;
    }
  }
}

// --- Odznaky na záložkách ---
function updateBadges() {
  const expBadge = document.getElementById('badge-expirations');
  if (expBadge) {
    const scoped = filterByWarehouse(state.items, state.prefs.warehouseFilter);
    const todayMs = getTodayMidnightMs();
    let urgentCount = 0;
    let expiredCount = 0;
    for (const item of scoped) {
      if (!item.exp) continue;
      const e = evaluateExpiration(item.exp, todayMs);
      if (e.status === 'expired') {
        expiredCount++;
        urgentCount++;
      } else if (e.status === 'critical') {
        urgentCount++;
      }
    }
    expBadge.hidden = urgentCount === 0;
    expBadge.textContent = urgentCount > 99 ? '99+' : String(urgentCount);
    expBadge.classList.toggle('is-amber', expiredCount === 0);
  }

  const repBadge = document.getElementById('badge-reports');
  if (repBadge) {
    const n = state.reports.length;
    repBadge.hidden = n === 0;
    repBadge.textContent = String(n);
    repBadge.classList.add('is-amber');
  }

  const invBadge = document.getElementById('badge-inventory');
  if (invBadge) {
    const diffs = Object.values(state.inventory).filter((r) => r.diff !== 0).length;
    invBadge.hidden = diffs === 0;
    invBadge.textContent = String(diffs);
  }
}

// --- Přepínání záložek ---
function switchTab(tabId) {
  state.activeTab = tabId;
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    const active = btn.dataset.tab === tabId;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.hidden = panel.id !== `tab-${tabId}`;
  });
  const whWrap = document.getElementById('warehouse-strip-wrap');
  if (whWrap) {
    whWrap.hidden = tabId === 'inventory' || tabId === 'data' || tabId === 'reports';
  }
  if (tabs[tabId]?.render) {
    tabs[tabId].render();
  }
  window.scrollTo({ top: 0, behavior: 'instant' });
}

document.getElementById('app-nav')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-tab]');
  if (!btn) return;
  switchTab(btn.dataset.tab);
});

// --- Spárování skladu s aktuálním registrem ÚKZÚZ ---
function buildPorMatcher() {
  if (!state.porIndex) return null;
  const idx = state.porIndex;
  return {
    match: (code, name) => matchProductToPor(code, name, idx),
    searchText: (por) => buildPorSearchText(por),
  };
}

function rebuildEnrichedStock() {
  state.items = enrichItems(state.rawItems, buildPorMatcher());
}

// --- Sdílený kontext pro moduly ---
function setPrefs(partial) {
  state.prefs = savePrefs(partial);
}

function setCustomPack(code, velikost, obal) {
  state.customPacks[String(code)] = { velikost: Number(velikost), obal: obal || 'automaticky' };
  saveCustomPacks(state.customPacks);
  refreshAllViews();
}

function deleteCustomPack(code) {
  delete state.customPacks[String(code)];
  saveCustomPacks(state.customPacks);
  refreshAllViews();
}

function applyStockDataset(dataset) {
  state.meta = dataset.meta || {};
  state.rawItems = Array.isArray(dataset.items) ? dataset.items : [];
  rebuildEnrichedStock();
  refreshAllViews();
}

function applyPorDataset(dataset) {
  state.porMeta = dataset?.meta || null;
  state.porItems = Array.isArray(dataset?.items) ? dataset.items : [];
  state.porIndex = state.porItems.length ? buildPorIndex(state.porItems) : null;
  if (state.rawItems.length) {
    rebuildEnrichedStock();
  }
  refreshAllViews();
}

function refreshAllViews() {
  renderHeaderMeta();
  renderWarehouseBar();
  updateBadges();
  Object.values(tabs).forEach((t) => t.render && t.render());
}

function reloadLocalState() {
  state.customPacks = loadCustomPacks();
  state.inventory = loadInventoryRecords();
  state.reports = loadReports();
  state.prefs = loadPrefs();
  wakeController.setEnabled(state.prefs.wakeLockEnabled);
  refreshAllViews();
}

async function fetchDefaultStock() {
  const res = await fetch('./data/stock.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

async function fetchDefaultPor() {
  const res = await fetch(POR_JSON_URL, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

async function reloadDefaultStock() {
  try {
    const data = await fetchDefaultStock();
    applyStockDataset(data);
  } catch (err) {
    toast(`Nepodařilo se načíst výchozí data skladu: ${err.message}`, 'danger');
  }
}

async function reloadDefaultPor() {
  try {
    const data = await fetchDefaultPor();
    applyPorDataset(data);
  } catch (err) {
    toast(`Nepodařilo se načíst registr ÚKZÚZ: ${err.message}`, 'danger');
  }
}

const ctx = {
  state,
  toast,
  setPrefs,
  setCustomPack,
  deleteCustomPack,
  applyStockDataset,
  applyPorDataset,
  reloadDefaultStock,
  reloadDefaultPor,
  reloadLocalState,
  refreshAllViews,
  updateBadges,
  openReportForItem(item) {
    switchTab('reports');
    tabs.reports.prefillFromItem(item);
  },
  openInventoryForProduct(productName, warehouseHint) {
    switchTab('inventory');
    tabs.inventory.focusProduct(productName, warehouseHint);
  },
  openSearchForProduct(productName) {
    switchTab('search');
    tabs.search.setSearchQuery(productName, true);
  },
};

// --- Inicializace ---
async function bootstrap() {
  tabs.search = createSearchTab(ctx);
  tabs.expirations = createExpirationsTab(ctx);
  tabs.inventory = createInventoryTab(ctx);
  tabs.reports = createReportsTab(ctx);
  tabs.data = createDataTab(ctx);

  wakeController.init();
  updateNetworkIndicator();
  window.addEventListener('online', updateNetworkIndicator);
  window.addEventListener('offline', updateNetworkIndicator);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  const resultsEl = document.getElementById('search-results-area');
  if (resultsEl) {
    resultsEl.innerHTML = `
      <div class="loading-card">
        <div class="spinner"></div>
        <div>Načítám data skladu a registr ÚKZÚZ…</div>
      </div>
    `;
  }

  // Paralelní načtení skladu i registru ÚKZÚZ (POR)
  const [stockResult, porResult] = await Promise.allSettled([
    (async () => {
      const localStock = await loadLocalStockData();
      if (localStock && Array.isArray(localStock.items)) return localStock;
      return await fetchDefaultStock();
    })(),
    (async () => {
      const localPor = await loadLocalPorData();
      if (localPor && Array.isArray(localPor.items)) return localPor;
      return await fetchDefaultPor();
    })(),
  ]);

  if (porResult.status === 'fulfilled' && porResult.value) {
    state.porMeta = porResult.value.meta || null;
    state.porItems = Array.isArray(porResult.value.items) ? porResult.value.items : [];
    state.porIndex = state.porItems.length ? buildPorIndex(state.porItems) : null;
  }

  if (stockResult.status === 'fulfilled' && stockResult.value) {
    applyStockDataset(stockResult.value);
  } else {
    state.meta = { updatedAt: 'Chyba načtení' };
    refreshAllViews();
    toast(`Nepodařilo se načíst sklad: ${stockResult.reason?.message || 'chyba'}`, 'danger');
  }

  switchTab('search');
}

bootstrap();
