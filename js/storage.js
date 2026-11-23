/**
 * Lokální perzistence dat a konfigurace Google Apps Script backendu:
 * - IndexedDB pro lokální mezipaměť skladu, ÚKZÚZ POR a zákazníků (přežije offline režim)
 * - localStorage pro konfiguraci GAS URL, e-mailu objednávek, poznámek k hnojivům,
 *   inventury, hlášení nesrovnalostí, vlastních balení a předvoleb.
 */

import { DEFAULT_GAS_URL, DEFAULT_NOTIFY_EMAIL, LEGACY_GAS_URLS } from './gas-api.js';

const DB_NAME = 'sklad_asistent_db';
const DB_VERSION = 1;
const STORE_NAME = 'datasets';
const STOCK_KEY = 'custom_stock_data';
const POR_KEY = 'custom_por_data';
const CUSTOMERS_KEY = 'cached_customers_data';

const LS_KEYS = {
  customPacks: 'sklad_custom_packs_v1',
  fertilizerNotes: 'sklad_fertilizer_notes_v1',
  inventory: 'sklad_inventory_v1',
  reports: 'sklad_reports_v1',
  recentSearches: 'sklad_recentSearches_v1',
  prefs: 'sklad_prefs_v1',
};

const DEFAULT_PREFS = {
  warehouseFilter: 'all',
  invSection: 'Boršice (Sklad + Komise Boršice)',
  blindMode: true,
  wakeLockEnabled: true,
  batchSort: 'qty', // 'qty' | 'fefo'
  gasUrl: DEFAULT_GAS_URL,
  notifyEmail: DEFAULT_NOTIFY_EMAIL,
  salesperson: '',
};

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB není k dispozici.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function idbSet(key, value) {
  const db = await openDb();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(key) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // ignore
  }
}

export function loadLocalStockData() {
  return idbGet(STOCK_KEY);
}

export function saveLocalStockData(dataset) {
  return idbSet(STOCK_KEY, dataset);
}

export function clearLocalStockData() {
  return idbDelete(STOCK_KEY);
}

export function loadLocalPorData() {
  return idbGet(POR_KEY);
}

export function saveLocalPorData(dataset) {
  return idbSet(POR_KEY, dataset);
}

export function clearLocalPorData() {
  return idbDelete(POR_KEY);
}

export function loadCachedCustomers() {
  return idbGet(CUSTOMERS_KEY);
}

export function saveCachedCustomers(customers) {
  return idbSet(CUSTOMERS_KEY, customers).catch(() => {});
}

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function loadCustomPacks() {
  return readJson(LS_KEYS.customPacks, {});
}

export function saveCustomPacks(packs) {
  return writeJson(LS_KEYS.customPacks, packs);
}

export function loadFertilizerNotes() {
  return readJson(LS_KEYS.fertilizerNotes, {});
}

export function saveFertilizerNotes(notes) {
  return writeJson(LS_KEYS.fertilizerNotes, notes);
}

export function loadInventoryRecords() {
  return readJson(LS_KEYS.inventory, {});
}

export function saveInventoryRecords(records) {
  return writeJson(LS_KEYS.inventory, records);
}

export function clearInventoryRecords() {
  try {
    localStorage.removeItem(LS_KEYS.inventory);
  } catch {
    // ignore
  }
}

export function loadReports() {
  const list = readJson(LS_KEYS.reports, []);
  return Array.isArray(list) ? list : [];
}

export function saveReports(list) {
  return writeJson(LS_KEYS.reports, list);
}

export function clearReports() {
  try {
    localStorage.removeItem(LS_KEYS.reports);
  } catch {
    // ignore
  }
}

export function loadRecentSearches() {
  const list = readJson(LS_KEYS.recentSearches, []);
  return Array.isArray(list) ? list : [];
}

export function pushRecentSearch(term) {
  const clean = String(term || '').trim();
  if (clean.length < 2) return loadRecentSearches();
  const prev = loadRecentSearches().filter((x) => x.toLowerCase() !== clean.toLowerCase());
  const next = [clean, ...prev].slice(0, 8);
  writeJson(LS_KEYS.recentSearches, next);
  return next;
}

export function clearRecentSearches() {
  try {
    localStorage.removeItem(LS_KEYS.recentSearches);
  } catch {
    // ignore
  }
}

export function loadPrefs() {
  const saved = readJson(LS_KEYS.prefs, {});
  const merged = { ...DEFAULT_PREFS, ...(saved && typeof saved === 'object' ? saved : {}) };
  if (!merged.gasUrl || LEGACY_GAS_URLS.includes(String(merged.gasUrl).trim())) {
    merged.gasUrl = DEFAULT_GAS_URL;
    writeJson(LS_KEYS.prefs, merged);
  }
  if (!merged.notifyEmail) merged.notifyEmail = DEFAULT_NOTIFY_EMAIL;
  return merged;
}

export function savePrefs(partial) {
  const next = { ...loadPrefs(), ...partial };
  if (!next.gasUrl) next.gasUrl = DEFAULT_GAS_URL;
  if (!next.notifyEmail) next.notifyEmail = DEFAULT_NOTIFY_EMAIL;
  writeJson(LS_KEYS.prefs, next);
  return next;
}

export function exportFullBackup() {
  return {
    version: 2,
    exportedAt: new Date().toISOString(),
    customPacks: loadCustomPacks(),
    fertilizerNotes: loadFertilizerNotes(),
    inventory: loadInventoryRecords(),
    reports: loadReports(),
    prefs: loadPrefs(),
  };
}

export function importFullBackup(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('Neplatný formát zálohy.');
  }
  if (data.customPacks && typeof data.customPacks === 'object') {
    saveCustomPacks(data.customPacks);
  }
  if (data.fertilizerNotes && typeof data.fertilizerNotes === 'object') {
    saveFertilizerNotes(data.fertilizerNotes);
  }
  if (data.inventory && typeof data.inventory === 'object') {
    saveInventoryRecords(data.inventory);
  }
  if (Array.isArray(data.reports)) {
    saveReports(data.reports);
  }
  if (data.prefs && typeof data.prefs === 'object') {
    savePrefs(data.prefs);
  }
}
