/**
 * Skladový asistent — hlavní řídicí modul aplikace.
 * Automaticky synchronizuje sklad, zákazníky a objednávky s nasazeným
 * Google Apps Script backendem (Google Tabulka), načítá denně aktualizovaný
 * registr ÚKZÚZ (POR) a páruje je podle očištěného názvu nebo kódu položky.
 */

import {
  enrichItems,
  evaluateExpiration,
  filterByWarehouse,
  getTodayMidnightMs,
  normalizeText,
} from './domain.js';
import {
  loadCachedCustomers,
  loadCustomPacks,
  loadFertilizerNotes,
  loadInventoryRecords,
  loadLocalPorData,
  loadLocalStockData,
  loadPrefs,
  loadReports,
  saveCachedCustomers,
  saveCustomPacks,
  saveFertilizerNotes,
  saveInventoryRecords,
  saveLocalStockData,
  savePrefs,
} from './storage.js';
import {
  buildPorIndex,
  buildPorSearchText,
  cleanBcProductName,
  matchProductToPor,
} from './ukzuz.js';
import { gasGetAll } from './gas-api.js';
import { WakeLockController } from './wake-lock.js';
import { createSearchTab } from './ui-search.js';
import { createOrdersTab } from './ui-orders.js';
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
  lastSkladUpdate: null,
  lastGasSyncAt: 0,
  gasConnected: false,
  gasSyncing: false,
  customers: [],
  orders: [],
  cloudInventory: [],
  fertilizerNotes: loadFertilizerNotes(),
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
  }, 3200);
}

// --- Stav sítě ---
function updateNetworkIndicator() {
  const pill = document.getElementById('net-status-pill');
  const txt = document.getElementById('net-status-text');
  if (!pill || !txt) return;
  const online = navigator.onLine;
  pill.classList.toggle('is-offline', !online);
  txt.textContent = online ? (state.gasConnected ? 'Online · GAS' : 'Připraveno') : 'Offline režim';
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

// --- Tlačítko Obnovit data v hlavičce ---
const headerRefreshBtn = document.getElementById('header-refresh-btn');
headerRefreshBtn?.addEventListener('click', () => {
  syncFromGas({ silent: false });
});

function setHeaderRefreshLoading(loading) {
  if (!headerRefreshBtn) return;
  headerRefreshBtn.disabled = loading;
  headerRefreshBtn.classList.toggle('is-loading', loading);
  const lbl = headerRefreshBtn.querySelector('.refresh-label-long');
  if (lbl) lbl.textContent = loading ? 'Obnovuji…' : 'Obnovit data';
}

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
  tabs.search?.render();
  tabs.expirations?.render();
});

// --- Hlavička: čas aktualizace skladu + synchronizace ÚKZÚZ ---
function renderHeaderMeta() {
  const stockEl = document.getElementById('header-updated-at');
  if (stockEl) {
    const ts = state.lastSkladUpdate || state.meta?.updatedAt;
    stockEl.textContent = ts ? `Sklad: ${ts}` : 'Načítám data…';
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
  updateNetworkIndicator();
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

  const ordBadge = document.getElementById('badge-orders');
  if (ordBadge) {
    const activeOrders = (state.orders || []).filter((o) => {
      const s = String(o.stav || 'Nová').toLowerCase();
      return s.includes('nov') || s.includes('vychyst');
    }).length;
    ordBadge.hidden = activeOrders === 0;
    ordBadge.textContent = activeOrders > 99 ? '99+' : String(activeOrders);
    ordBadge.classList.add('is-amber');
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
    whWrap.hidden =
      tabId === 'inventory' || tabId === 'data' || tabId === 'reports' || tabId === 'orders';
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

// --- Spárování skladu s aktuálním registrem ÚKZÚZ a poznámkami hnojiv ---
function buildPorMatcher() {
  if (!state.porIndex) return null;
  const idx = state.porIndex;
  return {
    match: (code, name) => matchProductToPor(code, name, idx),
    searchText: (por) => buildPorSearchText(por),
  };
}

function buildFertMatcher() {
  const notes = state.fertilizerNotes || {};
  const entries = Object.entries(notes);
  if (!entries.length) return null;

  const byKeyNorm = new Map();
  const byNameNorm = new Map();
  for (const [k, val] of entries) {
    if (!val || typeof val !== 'object') continue;
    const kn = normalizeText(k);
    if (kn) byKeyNorm.set(kn, val);
    if (val.nazev) {
      const nn = normalizeText(cleanBcProductName(val.nazev) || val.nazev);
      if (nn) byNameNorm.set(nn, val);
    }
  }

  return {
    match(code, name) {
      const cStr = String(code || '').trim();
      if (cStr && notes[cStr]) return notes[cStr];
      const cn = normalizeText(cStr);
      if (cn && byKeyNorm.has(cn)) return byKeyNorm.get(cn);

      const cleaned = cleanBcProductName(name || '');
      const nn = normalizeText(cleaned || name || '');
      if (nn) {
        if (byKeyNorm.has(nn)) return byKeyNorm.get(nn);
        if (byNameNorm.has(nn)) return byNameNorm.get(nn);
      }
      return null;
    },
  };
}

function rebuildEnrichedStock() {
  state.items = enrichItems(state.rawItems, buildPorMatcher(), buildFertMatcher());
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

function setFertilizerNote(key, noteObj) {
  const k = String(key || '').trim();
  if (!k) return;
  const nazev = String(noteObj?.nazev ?? noteObj?.name ?? '').trim();
  const prvky = String(noteObj?.prvky ?? noteObj?.elements ?? '').trim();
  const tankmix = String(noteObj?.tankmix ?? '').trim();
  const poznamka = String(noteObj?.poznamka ?? noteObj?.note ?? '').trim();
  state.fertilizerNotes[k] = {
    nazev,
    name: nazev,
    prvky,
    elements: prvky,
    tankmix,
    poznamka,
    note: poznamka,
    updatedAt: new Date().toLocaleDateString('cs-CZ'),
  };
  saveFertilizerNotes(state.fertilizerNotes);
  rebuildEnrichedStock();
  refreshAllViews();
}

function deleteFertilizerNote(key) {
  const k = String(key || '').trim();
  delete state.fertilizerNotes[k];
  saveFertilizerNotes(state.fertilizerNotes);
  rebuildEnrichedStock();
  refreshAllViews();
}

function rebuildStockEnrichment() {
  rebuildEnrichedStock();
  refreshAllViews();
}

function applyStockDataset(dataset) {
  state.meta = dataset.meta || {};
  if (dataset.meta?.updatedAt) {
    state.lastSkladUpdate = dataset.meta.updatedAt;
  }
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
  state.fertilizerNotes = loadFertilizerNotes();
  state.inventory = loadInventoryRecords();
  state.reports = loadReports();
  state.prefs = loadPrefs();
  wakeController.setEnabled(state.prefs.wakeLockEnabled);
  rebuildEnrichedStock();
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

// --- Sloučení inventury z Google Tabulky (GET pole `inventura`) s lokálními neodeslanými záznamy ---
function buildInventoryKey(code, loc, lot, exp) {
  return `${String(code || '').trim()}|${String(loc || '').trim()}|${String(lot || '-').trim()}|${String(exp || '').trim()}`;
}

function mergeCloudInventory(cloudRows = []) {
  state.cloudInventory = Array.isArray(cloudRows) ? cloudRows : [];

  const nextInv = {};
  // 1. Ponech lokální neodeslané záznamy (čekající na odeslání z offline režimu)
  for (const [k, rec] of Object.entries(state.inventory || {})) {
    if (rec && rec.synced === false) {
      nextInv[k] = rec;
    }
  }

  // 2. Zapiš všechny záznamy načtené z Google Tabulky (novější přepíšou starší pro stejnou šarži)
  for (const row of state.cloudInventory) {
    const key = buildInventoryKey(row.cislo_zbozi, row.lokace, row.sarze, row.expirace);
    nextInv[key] = {
      key,
      time: row.cas || '',
      section: row.lokace || '',
      code: row.cislo_zbozi,
      name: row.nazev,
      loc: row.lokace,
      lot: row.sarze,
      exp: row.expirace || '',
      system: row.stav_bc,
      actual: row.skutecny_stav,
      diff: row.rozdil,
      kartonyText: row.kartony_text || '',
      note: row.poznamka || '',
      synced: true,
    };
  }

  state.inventory = nextInv;
  saveInventoryRecords(state.inventory);
}

// --- Synchronizace s Google Apps Script backendem (GET) ---
async function syncFromGas({ silent = false } = {}) {
  const gasUrl = state.prefs.gasUrl;
  if (!gasUrl) {
    if (!silent) toast('URL adresa Google Apps Scriptu není nastavena.', 'warn');
    return false;
  }

  state.gasSyncing = true;
  setHeaderRefreshLoading(true);

  try {
    const res = await gasGetAll(gasUrl);
    state.gasConnected = true;
    state.lastGasSyncAt = Date.now();

    if (res.lastSkladUpdate && res.lastSkladUpdate !== 'Nikdy') {
      state.lastSkladUpdate = res.lastSkladUpdate;
    }

    if (Array.isArray(res.zakaznici) && res.zakaznici.length > 0) {
      state.customers = res.zakaznici;
      saveCachedCustomers(res.zakaznici).catch(() => {});
    }

    if (Array.isArray(res.objednavky)) {
      state.orders = res.objednavky;
    }

    if (Array.isArray(res.inventura)) {
      mergeCloudInventory(res.inventura);
    }

    if (Array.isArray(res.sklad) && res.sklad.length > 0) {
      const updatedAt =
        res.lastSkladUpdate && res.lastSkladUpdate !== 'Nikdy'
          ? res.lastSkladUpdate
          : state.meta?.updatedAt || new Date().toLocaleDateString('cs-CZ');
      const dataset = {
        meta: {
          updatedAt,
          source: 'Google Tabulka (GAS)',
          rowCount: res.sklad.length,
          productCount: new Set(res.sklad.map((i) => i.c)).size,
        },
        items: res.sklad,
      };
      state.meta = dataset.meta;
      state.rawItems = dataset.items;
      rebuildEnrichedStock();
      saveLocalStockData(dataset).catch(() => {});
    }

    refreshAllViews();
    if (!silent) {
      toast(
        `✅ Data obnovena z cloudu (${state.rawItems.length} šarží, ${state.cloudInventory.length} inventur, ${state.orders.length} objednávek)`,
        'success'
      );
    }
    return true;
  } catch (err) {
    state.gasConnected = false;
    renderHeaderMeta();
    if (!silent) {
      toast(`⚠️ Spojení s Google Tabulkou selhalo: ${err.message}`, 'danger');
    }
    return false;
  } finally {
    state.gasSyncing = false;
    setHeaderRefreshLoading(false);
  }
}

const ctx = {
  state,
  toast,
  setPrefs,
  setCustomPack,
  deleteCustomPack,
  setFertilizerNote,
  deleteFertilizerNote,
  rebuildStockEnrichment,
  applyStockDataset,
  applyPorDataset,
  reloadDefaultStock,
  reloadDefaultPor,
  reloadLocalState,
  refreshAllViews,
  updateBadges,
  syncFromGas,
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
  openOrderForProduct(code, warehouseHint) {
    switchTab('orders');
    tabs.orders.prefillProductToOrder(code, warehouseHint);
  },
};

// --- Inicializace ---
async function bootstrap() {
  tabs.search = createSearchTab(ctx);
  tabs.orders = createOrdersTab(ctx);
  tabs.expirations = createExpirationsTab(ctx);
  tabs.inventory = createInventoryTab(ctx);
  tabs.reports = createReportsTab(ctx);
  tabs.data = createDataTab(ctx);

  wakeController.init();
  updateNetworkIndicator();
  window.addEventListener('online', () => {
    updateNetworkIndicator();
    syncFromGas({ silent: true });
  });
  window.addEventListener('offline', updateNetworkIndicator);
  document.addEventListener('visibilitychange', () => {
    if (
      document.visibilityState === 'visible' &&
      navigator.onLine &&
      !state.gasSyncing &&
      Date.now() - state.lastGasSyncAt > 15000
    ) {
      syncFromGas({ silent: true });
    }
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  const resultsEl = document.getElementById('search-results-area');
  if (resultsEl) {
    resultsEl.innerHTML = `
      <div class="loading-card">
        <div class="spinner"></div>
        <div>Stahuji čerstvá data skladu, inventury a registru ÚKZÚZ z cloudu…</div>
      </div>
    `;
  }

  // 1. Registr ÚKZÚZ (POR) načti paralelně s živým GET dotazem na Google Apps Script
  const porPromise = (async () => {
    const localPor = await loadLocalPorData();
    if (localPor && Array.isArray(localPor.items) && localPor.items.length > 0) return localPor;
    return await fetchDefaultPor();
  })().catch(() => null);

  let gasOk = false;
  if (navigator.onLine !== false) {
    gasOk = await syncFromGas({ silent: true });
  }

  const porData = await porPromise;
  if (porData) {
    state.porMeta = porData.meta || null;
    state.porItems = Array.isArray(porData.items) ? porData.items : [];
    state.porIndex = state.porItems.length ? buildPorIndex(state.porItems) : null;
  }

  // 2. Fallback na lokální mezipaměť / výchozí stock.json POUZE pokud je offline nebo GAS selhal / vrátil prázdný sklad
  if (!gasOk || state.rawItems.length === 0) {
    const [stockResult, cachedCustResult] = await Promise.allSettled([
      (async () => {
        const localStock = await loadLocalStockData();
        if (localStock && Array.isArray(localStock.items) && localStock.items.length > 0) return localStock;
        return await fetchDefaultStock();
      })(),
      loadCachedCustomers(),
    ]);

    if (state.customers.length === 0 && cachedCustResult.status === 'fulfilled' && Array.isArray(cachedCustResult.value)) {
      state.customers = cachedCustResult.value;
    }

    if (stockResult.status === 'fulfilled' && stockResult.value) {
      applyStockDataset(stockResult.value);
    } else {
      state.meta = { updatedAt: 'Offline — žádná data' };
      refreshAllViews();
    }
  } else {
    // GAS vrátil čerstvá data — znovu obohať po načtení ÚKZÚZ POR
    rebuildEnrichedStock();
    refreshAllViews();
  }

  switchTab('search');
}

bootstrap();
