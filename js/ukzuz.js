/**
 * Modul pro registr přípravků na ochranu rostlin ÚKZÚZ (eAGRI POR).
 * - Čištění názvů položek z Business Central od velikostí balení a poznámek dodavatele
 * - Inteligentní párování se skladem (název, kompaktní název, registrační číslo, ID, tolerance překlepu)
 * - Kategorizace plodin (Obiloviny, Řepka, Réva vinná, Kukuřice, Brambory a cukrovka, Sady a zelenina, Ostatní)
 * - Vyhledávání alternativ ze skladu (1. Přesná náhrada se stejnou účinnou látkou, 2. Alternativa ze stejné chemické skupiny + stejná plodina)
 * - Záložní ruční nahrání souboru POR (.xlsx, .xml, .csv, .json) přímo v prohlížeči
 */

import { getCzechNowStr, normalizeText } from './domain.js';
import { readZipEntries, readEntryAsText, getEntryCompressedSlice } from './xlsx-parser.js';

export const CROP_CATEGORIES = [
  { key: 'all', label: 'Vše', icon: '🌿' },
  { key: 'obiloviny', label: 'Obiloviny', icon: '🌾' },
  { key: 'repka', label: 'Řepka', icon: '🌼' },
  { key: 'reva', label: 'Réva vinná', icon: '🍇' },
  { key: 'kukurice', label: 'Kukuřice', icon: '🌽' },
  { key: 'brambory_cukrovka', label: 'Brambory/Cukrovka', icon: '🥔' },
  { key: 'sady_zelenina', label: 'Sady/Zelenina', icon: '🍎' },
  { key: 'ostatni', label: 'Ostatní', icon: '🌱' },
];

export const CROP_CATEGORY_LABELS = Object.fromEntries(
  CROP_CATEGORIES.map((c) => [c.key, `${c.icon} ${c.label}`])
);

const CROP_RULES = [
  ['obiloviny', ['psenic', 'jecmen', 'zito', 'tritikal', 'oves', 'obilnin', 'obilovin', 'spald', 'sladovn']],
  ['repka', ['repk', 'horcic', 'brukvovit', 'lnick']],
  ['reva', ['reva', 'revy', 'reve', 'vinic', 'vinn']],
  ['kukurice', ['kukuric', 'cirok', 'proso']],
  ['brambory_cukrovka', ['brambor', 'batat', 'cukrovk', 'repa cukrov', 'repa krmn', 'repa sal', 'repa cerven', 'krmna repa', 'cukrova repa']],
  [
    'sady_zelenina',
    [
      'jablon', 'hrusn', 'slivon', 'tresn', 'visn', 'merunk', 'broskvon', 'jadrov', 'peckov',
      'ovocn', 'sady', 'jahod', 'malin', 'ostruzin', 'rybiz', 'angrest', 'boruvk', 'orech',
      'oresak', 'lisk', 'zelenin', 'rajc', 'paprik', 'okurk', 'cibul', 'cesnek', 'por',
      'mrkev', 'petrzel', 'celer', 'zeli', 'kapust', 'kvetak', 'brokolic', 'salat', 'spenat',
      'hrach zahrad', 'fazol', 'tykv', 'cuket', 'meloun', 'redkv', 'chrest', 'rebarb',
    ],
  ],
];

export function classifyCropCategories(cropText) {
  const norm = normalizeText(cropText);
  if (!norm) return [];
  const out = [];
  for (const [key, kwList] of CROP_RULES) {
    if (kwList.some((kw) => norm.includes(kw))) {
      out.push(key);
    }
  }
  if (!out.length) out.push('ostatni');
  return out;
}

const FORMULATION_CODES = new Set([
  'ec', 'sc', 'wg', 'wdg', 'wp', 'sl', 'se', 'cs', 'ew', 'sg', 'od', 'fs', 'me',
  'ul', 'df', 'gr', 'dc', 'dp', 'ds', 'eg', 'eo', 'es', 'gb', 'ge', 'gl', 'gw',
  'hn', 'kk', 'kl', 'kn', 'la', 'ls', 'mg', 'of', 'ol', 'op', 'pa', 'pc', 'po',
  'pr', 'ps', 'rb', 'sb', 'so', 'sp', 'ss', 'st', 'su', 'tb', 'tc', 'tk', 'vp',
  'ws', 'wt', 'zc', 'ze', 'zw',
]);

/**
 * Očistí název položky z Business Central od velikostí balení (5L, 20 L, 10 KG, bal., 4x5L…),
 * akčních přívlastků (- maxipack, - XXL) a dodavatelských závorek ((BAYER), (FMC)…).
 */
export function cleanBcProductName(rawName) {
  if (!rawName) return '';
  let s = String(rawName).replace(/\u00a0/g, ' ').trim();
  s = s.replace(/\([^)]*\)/g, ' ');
  s = s.replace(/\b\d+\s*[xX*×]\s*\d+(?:[.,]\d+)?\s*(?:l|litr(?:ů|y)?|kg|g|ml|ks)\b/gi, ' ');
  s = s.replace(/\b\d+(?:[.,]\d+)?\s*(?:l|litr(?:ů|y)?|kg|g|ml)\b(?:\s*[-–]?\s*bal\.?)?/gi, ' ');
  s = s.replace(/(?:^|\s)[-–]\s*(?:maxipack|multipack|pack|xxl|xl|akce|bal\.?|bal[ií][cč]ek)\b/gi, ' ');
  s = s.replace(/\b(?:bal\.?|bal[ií][cč]ek|kanystr|pytel|krabice|l[aá]hev|maxipack|multipack)\b/gi, ' ');
  s = s.replace(/\s+L\s*$/, ' ');
  s = s.replace(/[\s\-–/,+.:]+$/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function toCompact(str) {
  return normalizeText(str).replace(/[^a-z0-9]+/g, '');
}

function dedupTripleChars(str) {
  return str.replace(/(.)\1{2,}/g, '$1$1');
}

function stripTrailingFormulation(name) {
  const tokens = normalizeText(name)
    .replace(/[^a-z0-9\s]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  while (tokens.length > 1 && FORMULATION_CODES.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  return tokens.join('');
}

/**
 * Sestaví rychlý vyhledávací index pro párování přípravků ze skladu s registrem ÚKZÚZ.
 */
export function buildPorIndex(porItems = []) {
  const byNorm = new Map();
  const byCompact = new Map();
  const byDedupCompact = new Map();
  const byReg = new Map();
  const byId = new Map();
  const byBase = new Map();
  const baseCounts = new Map();

  for (const item of porItems) {
    if (!item || !item.name) continue;
    const norm = normalizeText(item.name);
    const comp = toCompact(item.name);
    const dedup = dedupTripleChars(comp);

    if (norm && !byNorm.has(norm)) byNorm.set(norm, item);
    if (comp && !byCompact.has(comp)) byCompact.set(comp, item);
    if (dedup && !byDedupCompact.has(dedup)) byDedupCompact.set(dedup, item);

    if (item.reg) {
      const regNorm = normalizeText(item.reg).replace(/\s+/g, '');
      if (regNorm && !byReg.has(regNorm)) byReg.set(regNorm, item);
    }
    if (item.id) {
      byId.set(String(item.id).trim(), item);
    }

    const base = stripTrailingFormulation(item.name);
    if (base.length >= 4) {
      baseCounts.set(base, (baseCounts.get(base) || 0) + 1);
      if (!byBase.has(base)) byBase.set(base, item);
    }
  }

  for (const [base, count] of baseCounts.entries()) {
    if (count > 1) byBase.delete(base);
  }

  return {
    items: porItems,
    byNorm,
    byCompact,
    byDedupCompact,
    byReg,
    byId,
    byBase,
  };
}

/**
 * Spáruje položku z Business Central (název + číslo položky) se záznamem z registru ÚKZÚZ.
 */
export function matchProductToPor(productCode, productName, porIndex) {
  if (!porIndex || !porIndex.items?.length) return null;

  const codeClean = normalizeText(productCode).replace(/\s+/g, '');
  if (codeClean) {
    const byReg = porIndex.byReg.get(codeClean);
    if (byReg) return byReg;
    const byId = porIndex.byId.get(String(productCode).trim());
    if (byId) return byId;
  }

  if (!productName) return null;

  const cleaned = cleanBcProductName(productName);
  const norm = normalizeText(cleaned);
  if (norm) {
    const exact = porIndex.byNorm.get(norm);
    if (exact) return exact;
  }

  const comp = toCompact(cleaned);
  if (comp) {
    const compactHit = porIndex.byCompact.get(comp);
    if (compactHit) return compactHit;

    const dedup = dedupTripleChars(comp);
    const dedupHit = porIndex.byDedupCompact.get(dedup);
    if (dedupHit) return dedupHit;

    const dedupSingle = comp.replace(/(.)\1{2,}/g, '$1');
    const dedupSingleHit = porIndex.byCompact.get(dedupSingle);
    if (dedupSingleHit) return dedupSingleHit;
  }

  const base = stripTrailingFormulation(cleaned);
  if (base.length >= 4) {
    const baseHit = porIndex.byBase.get(base);
    if (baseHit) return baseHit;
  }

  const regInName = String(productName).match(/\b(\d{4,5}-\d[A-Z]?)\b/i);
  if (regInName) {
    const regHit = porIndex.byReg.get(normalizeText(regInName[1]));
    if (regHit) return regHit;
  }

  return null;
}

/**
 * Vytvoří vyhledávací řetězec ze záznamu ÚKZÚZ (pro hledání podle účinné látky, reg. čísla, PHO, včel, plodin).
 */
export function buildPorSearchText(por) {
  if (!por) return '';
  const ulText = (por.ul || []).map((u) => `${u.n} ${u.c || ''} ${u.g || ''}`).join(' ');
  const groups = (por.groups || []).join(' ');
  const crops = (por.crops || []).join(' ');
  const pho = por.pho?.restricted ? `pho omezeni ${por.pho.code} ${por.pho.text}` : '';
  const bees =
    por.bees?.code && por.bees.code !== 'OK'
      ? `vcely ${por.bees.code} ${por.bees.label}`
      : '';
  return normalizeText(
    `${por.name} ${por.reg || ''} ${por.status || ''} ${por.fn || ''} ${ulText} ${groups} ${crops} ${pho} ${bees}`
  );
}

/**
 * Ověří, zda záznam POR vyhovuje zvoleným bezpečnostním přepínačům (OP II. st. / Včely) a plodině.
 */
export function matchesPorSafetyAndCrop(por, { cropCategory = 'all', phoAllowedOnly = false, beeSafeOnly = false } = {}) {
  if (cropCategory && cropCategory !== 'all') {
    if (!por || !Array.isArray(por.cg) || !por.cg.includes(cropCategory)) {
      return false;
    }
  }
  if (phoAllowedOnly) {
    if (!por || por.pho?.restricted) {
      return false;
    }
  }
  if (beeSafeOnly) {
    if (!por) return false;
    const bCode = String(por.bees?.code || '').toUpperCase();
    const bLevel = String(por.bees?.level || 'ok');
    if (bCode === 'ZNV' || bCode === 'NV' || bCode === 'SPE8' || bLevel === 'danger' || bLevel === 'warn') {
      return false;
    }
  }
  return true;
}

/**
 * Ověří, zda produkt obsahuje všechny vybrané účinné látky (multiselect).
 */
export function matchesActiveSubstances(por, selectedSubstances = []) {
  if (!selectedSubstances || !selectedSubstances.length) return true;
  if (!por || !Array.isArray(por.ul) || !por.ul.length) return false;
  const prodSet = new Set(por.ul.map((u) => normalizeText(u.n)));
  return selectedSubstances.every((sel) => prodSet.has(normalizeText(sel)));
}

/**
 * Vyhledá dostupné alternativní varianty (náhrady) z aktuálního skladu (kde je volné množství > 0),
 * při plném respektování aktivních filtrů (sklad, plodina, OP II. st., bezpečné pro včely).
 *
 * Vrací:
 * - exactSubstitutes: přípravky skladem se stejnou účinnou látkou (vč. porovnání koncentrace)
 * - groupAlternatives: přípravky skladem ze stejné chemické skupiny (Skupiny) registrované do stejné plodiny
 */
export function findStockAlternatives(targetPor, targetCode, scopedStockProducts, activeFilters = {}) {
  if (!targetPor) {
    return { exactSubstitutes: [], groupAlternatives: [] };
  }

  const targetUlMap = new Map();
  for (const u of targetPor.ul || []) {
    const key = normalizeText(u.n);
    if (key) targetUlMap.set(key, u);
  }

  const targetGroups = new Set(
    (targetPor.groups || [])
      .map((g) => normalizeText(g))
      .filter((g) => g && g !== 'other')
  );

  const activeCrop = activeFilters.cropCategory && activeFilters.cropCategory !== 'all'
    ? activeFilters.cropCategory
    : null;
  const targetCrops = new Set(targetPor.cg || []);

  const exactSubstitutes = [];
  const groupAlternatives = [];
  const targetNameNorm = normalizeText(targetPor.name);

  for (const cand of scopedStockProducts) {
    if (!cand || cand.totalQty <= 0 || !cand.por) continue;
    if (targetCode && cand.code === targetCode) continue;
    if (!targetCode && normalizeText(cand.por.name) === targetNameNorm) continue;

    // Respektuj aktivní bezpečnostní a plodinové filtry obchodníka
    if (!matchesPorSafetyAndCrop(cand.por, activeFilters)) continue;

    const candUlList = cand.por.ul || [];
    const sharedUl = [];
    for (const cu of candUlList) {
      const k = normalizeText(cu.n);
      if (targetUlMap.has(k)) {
        sharedUl.push({
          name: cu.n,
          candConc: cu.c || '',
          targetConc: targetUlMap.get(k).c || '',
        });
      }
    }

    if (sharedUl.length > 0) {
      const allTargetMatched = targetUlMap.size > 0 && sharedUl.length === targetUlMap.size && candUlList.length === targetUlMap.size;
      exactSubstitutes.push({
        product: cand,
        sharedUl,
        isFullCompositionMatch: allTargetMatched,
      });
      continue;
    }

    // 2. Alternativa ze stejné chemické skupiny + stejná plodina
    const candGroups = (cand.por.groups || []).filter((g) => {
      const gn = normalizeText(g);
      return gn && gn !== 'other' && targetGroups.has(gn);
    });
    if (!candGroups.length) continue;

    const candCrops = cand.por.cg || [];
    const sharedCrops = activeCrop
      ? (candCrops.includes(activeCrop) ? [activeCrop] : [])
      : candCrops.filter((c) => targetCrops.has(c));

    // Pokud původní přípravek neměl specifikovanou plodinu, povol shodu jen podle chemické skupiny
    if (targetCrops.size > 0 && sharedCrops.length === 0) continue;

    groupAlternatives.push({
      product: cand,
      sharedGroups: candGroups,
      sharedCrops,
    });
  }

  exactSubstitutes.sort((a, b) => {
    if (a.isFullCompositionMatch !== b.isFullCompositionMatch) {
      return a.isFullCompositionMatch ? -1 : 1;
    }
    if (b.sharedUl.length !== a.sharedUl.length) {
      return b.sharedUl.length - a.sharedUl.length;
    }
    return b.product.totalQty - a.product.totalQty;
  });

  groupAlternatives.sort((a, b) => {
    if (b.sharedGroups.length !== a.sharedGroups.length) {
      return b.sharedGroups.length - a.sharedGroups.length;
    }
    return b.product.totalQty - a.product.totalQty;
  });

  return { exactSubstitutes, groupAlternatives };
}

/**
 * Vyhledá registrované alternativy v katalogu ÚKZÚZ, které aktuálně NEMÁME skladem,
 * při respektování aktivních filtrů (plodina, OP II. st., bezpečné pro včely).
 */
export function findCatalogAlternatives(
  targetPor,
  scopedStockProducts,
  allPorItems,
  activeFilters = {},
  limit = 20
) {
  if (!targetPor || !Array.isArray(allPorItems) || !allPorItems.length) {
    return {
      exactCatalog: [],
      groupCatalog: [],
      totalExactCatalog: 0,
      totalGroupCatalog: 0,
    };
  }

  const inStockPorNames = new Set();
  for (const sp of scopedStockProducts || []) {
    if (sp.totalQty > 0) {
      if (sp.por?.name) inStockPorNames.add(normalizeText(sp.por.name));
      inStockPorNames.add(normalizeText(sp.name));
    }
  }

  const targetNameNorm = normalizeText(targetPor.name);
  const targetUlMap = new Map();
  for (const u of targetPor.ul || []) {
    const key = normalizeText(u.n);
    if (key) targetUlMap.set(key, u);
  }

  const targetGroups = new Set(
    (targetPor.groups || [])
      .map((g) => normalizeText(g))
      .filter((g) => g && g !== 'other')
  );

  const activeCrop =
    activeFilters.cropCategory && activeFilters.cropCategory !== 'all'
      ? activeFilters.cropCategory
      : null;
  const targetCrops = new Set(targetPor.cg || []);

  const exactAll = [];
  const groupAll = [];

  for (const por of allPorItems) {
    if (!por || !por.name) continue;
    const pNorm = normalizeText(por.name);
    if (!pNorm || pNorm === targetNameNorm || inStockPorNames.has(pNorm)) continue;

    if (!matchesPorSafetyAndCrop(por, activeFilters)) continue;

    const candUlList = por.ul || [];
    const sharedUl = [];
    for (const cu of candUlList) {
      const k = normalizeText(cu.n);
      if (targetUlMap.has(k)) {
        sharedUl.push({
          name: cu.n,
          candConc: cu.c || '',
          targetConc: targetUlMap.get(k).c || '',
        });
      }
    }

    if (sharedUl.length > 0) {
      const allTargetMatched =
        targetUlMap.size > 0 &&
        sharedUl.length === targetUlMap.size &&
        candUlList.length === targetUlMap.size;
      exactAll.push({
        por,
        sharedUl,
        isFullCompositionMatch: allTargetMatched,
      });
      continue;
    }

    const candGroups = (por.groups || []).filter((g) => {
      const gn = normalizeText(g);
      return gn && gn !== 'other' && targetGroups.has(gn);
    });
    if (!candGroups.length) continue;

    const candCrops = por.cg || [];
    const sharedCrops = activeCrop
      ? candCrops.includes(activeCrop)
        ? [activeCrop]
        : []
      : candCrops.filter((c) => targetCrops.has(c));

    if (targetCrops.size > 0 && sharedCrops.length === 0) continue;

    groupAll.push({
      por,
      sharedGroups: candGroups,
      sharedCrops,
    });
  }

  exactAll.sort((a, b) => {
    if (a.isFullCompositionMatch !== b.isFullCompositionMatch) {
      return a.isFullCompositionMatch ? -1 : 1;
    }
    if (b.sharedUl.length !== a.sharedUl.length) {
      return b.sharedUl.length - a.sharedUl.length;
    }
    return a.por.name.localeCompare(b.por.name, 'cs');
  });

  groupAll.sort((a, b) => {
    if (b.sharedGroups.length !== a.sharedGroups.length) {
      return b.sharedGroups.length - a.sharedGroups.length;
    }
    return a.por.name.localeCompare(b.por.name, 'cs');
  });

  return {
    exactCatalog: exactAll.slice(0, limit),
    groupCatalog: groupAll.slice(0, limit),
    totalExactCatalog: exactAll.length,
    totalGroupCatalog: groupAll.length,
  };
}

// ===========================================================================
// Záložní ruční nahrání souboru POR přímo v prohlížeči (.json / .xlsx / .xml / .csv)
// ===========================================================================

function cleanWs(val) {
  if (val === null || val === undefined) return '';
  return String(val).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function cleanDoseText(val) {
  return cleanWs(val).replace(/\s*,\s*$/, '').replace(/\s+,/g, ',').trim();
}

function parseDateToIso(raw) {
  const s = cleanWs(raw);
  if (!s) return null;
  const mIso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (mIso) return `${mIso[1]}-${mIso[2]}-${mIso[3]}`;
  const mCz = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (mCz) return `${mCz[3]}-${mCz[2].padStart(2, '0')}-${mCz[1].padStart(2, '0')}`;
  const num = Number(s.replace(',', '.'));
  if (!Number.isNaN(num) && num > 20000 && num < 90000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(num) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  return null;
}

function joinMeaningNote(m, n) {
  const a = cleanWs(m);
  const b = cleanWs(n);
  if (a && b) return a.includes(b) ? a : `${a} ${b}`;
  return a || b;
}

function classifyPho(code, meaning, note) {
  const c = cleanWs(code);
  const full = joinMeaningNote(meaning, note);
  const norm = normalizeText(`${c} ${full}`);
  const unrestricted =
    c === '' ||
    c === '-' ||
    c === '- -' ||
    norm.includes('neni vyloucen') ||
    norm.includes('bez omezeni') ||
    norm.includes('bez oznaceni');
  let restricted = !unrestricted && Boolean(c || full);
  if (norm.includes('vyloucen') && !norm.includes('neni vyloucen')) restricted = true;
  const displayCode = restricted && (norm.includes('op ii') || c === 'OP II.st.')
    ? 'OP II.st.'
    : (c && c !== '-' && c !== '- -' ? c : 'Bez omezení');
  return {
    code: displayCode,
    restricted,
    text: full || (restricted ? displayCode : 'Přípravek není vyloučen z použití v OP II. stupně zdrojů vod.'),
  };
}

function classifyBees(code, meaning, note) {
  const c = cleanWs(code).replace(/\.$/, '');
  const full = joinMeaningNote(meaning, note);
  const cu = c.toUpperCase();
  const norm = normalizeText(`${c} ${full}`);
  let stdCode = 'OK';
  let level = 'ok';
  let label = 'Bez omezení pro včely';
  if (cu === 'ZNV' || norm.includes('zvlast nebezpecny pro vcely')) {
    stdCode = 'ZNV';
    level = 'danger';
    label = 'ZNV — Zvlášť nebezpečný pro včely';
  } else if (cu === 'NV' || norm.includes('nebezpecny pro vcely')) {
    stdCode = 'NV';
    level = 'warn';
    label = 'NV — Nebezpečný pro včely';
  } else if (cu === 'SPE8' || norm.includes('spe8') || norm.includes('spe 8')) {
    stdCode = 'SPe8';
    level = 'warn';
    label = 'SPe8 — Nebezpečný pro včely';
  } else if (cu === 'DO' || norm.includes('cmelak') || norm.includes('opylovac') || norm.includes('sklenik')) {
    stdCode = 'DO';
    level = 'info';
    label = 'DO — Další omezení (opylovači)';
  }
  return {
    code: stdCode,
    level,
    label,
    text: full || label,
  };
}

const PHO_SEV = (p) => (!p ? 0 : p.restricted ? 2 : 1);
const BEE_SEV = (b) => {
  if (!b) return 0;
  const c = String(b.code || '').toUpperCase();
  if (c === 'ZNV') return 5;
  if (c === 'NV' || c === 'SPE8') return 4;
  if (c === 'DO') return 2;
  return 1;
};

const CROP_ORDER = ['obiloviny', 'repka', 'reva', 'kukurice', 'brambory_cukrovka', 'sady_zelenina', 'ostatni'];

function mergeDecisions(decisions) {
  const allowed = new Set(['Platné rozhodnutí', 'Do spotřebování zásob']);
  const byName = new Map();
  for (const d of decisions) {
    const name = cleanWs(d.name);
    if (!name || !allowed.has(d.status)) continue;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(d);
  }

  const rank = (r) => {
    const s = r.status === 'Platné rozhodnutí' ? 2 : 1;
    const rs = normalizeText(r.regStatus || '');
    const t = rs.includes('standardni') || rs.includes('narodni') ? 3 : rs.includes('mensinove') ? 1 : 2;
    return `${s}_${t}_${r.validTo || '0000-00-00'}_${r.effectiveFrom || '0000-00-00'}`;
  };

  const products = [];
  for (const [name, list] of byName.entries()) {
    list.sort((a, b) => (rank(a) < rank(b) ? 1 : -1));
    const primary = list[0];
    let ulRaw = primary.ul || [];
    if (!ulRaw.length) {
      const found = list.find((x) => x.ul?.length);
      if (found) ulRaw = found.ul;
    }

    const seenUl = new Set();
    const cleanUl = [];
    const groups = [];
    const seenGrp = new Set();
    for (const u of ulRaw) {
      const un = cleanWs(u.n);
      const uq = cleanWs(u.q);
      const uu = cleanWs(u.u);
      const uc = cleanWs(u.c) || (uq ? `${uq} ${uu}`.trim() : uu);
      const ug = cleanWs(u.g);
      if (!un) continue;
      const k = `${un.toLowerCase()}|${uc.toLowerCase()}`;
      if (!seenUl.has(k)) {
        seenUl.add(k);
        const obj = { n: un };
        if (uq) obj.q = uq;
        if (uu) obj.u = uu;
        if (uc) obj.c = uc;
        if (ug) obj.g = ug;
        cleanUl.push(obj);
      }
      if (ug) {
        for (const p of ug.split(/[;,/]+/)) {
          const pc = cleanWs(p);
          if (pc && !seenGrp.has(pc.toLowerCase())) {
            seenGrp.add(pc.toLowerCase());
            groups.push(pc);
          }
        }
      }
    }

    let bestPho = primary.pho;
    let bestBees = primary.bees;
    const cgSet = new Set();
    const cropsList = [];
    const seenCrops = new Set();
    const usesList = [];
    const seenUses = new Set();

    for (const dec of list) {
      if (PHO_SEV(dec.pho) > PHO_SEV(bestPho)) bestPho = dec.pho;
      if (BEE_SEV(dec.bees) > BEE_SEV(bestBees)) bestBees = dec.bees;
      for (const cg of dec.cg || []) cgSet.add(cg);
      for (const cr of dec.crops || []) {
        const cc = cleanWs(cr);
        const cn = normalizeText(cc);
        if (cc && !seenCrops.has(cn)) {
          seenCrops.add(cn);
          cropsList.push(cc);
        }
      }
      for (const u of dec.uses || []) {
        const cTxt = cleanWs(u.c);
        const pTxt = cleanWs(u.p);
        const dTxt = cleanDoseText(u.d);
        const olTxt = cleanWs(u.ol);
        if (!cTxt) continue;
        const uk = `${normalizeText(cTxt)}|${normalizeText(pTxt)}|${normalizeText(dTxt)}`;
        if (!seenUses.has(uk)) {
          seenUses.add(uk);
          const uo = { c: cTxt };
          if (pTxt) uo.p = pTxt;
          if (dTxt) uo.d = dTxt;
          if (olTxt) uo.ol = olTxt;
          usesList.push(uo);
        }
        const cn = normalizeText(cTxt);
        if (!seenCrops.has(cn)) {
          seenCrops.add(cn);
          cropsList.push(cTxt);
        }
      }
    }

    products.push({
      name,
      reg: cleanWs(primary.reg),
      status: primary.status,
      validTo: primary.validTo || null,
      marketTo: primary.marketTo || null,
      useTo: primary.useTo || null,
      fn: cleanWs(primary.fn),
      holder: cleanWs(primary.holder),
      eco: Boolean(primary.eco),
      ul: cleanUl,
      groups,
      pho: bestPho || classifyPho('', '', ''),
      bees: bestBees || classifyBees('', '', ''),
      cg: CROP_ORDER.filter((k) => cgSet.has(k)),
      crops: cropsList.slice(0, 25),
      uses: usesList.slice(0, 18),
      ...(primary.itemId ? { id: String(primary.itemId) } : {}),
    });
  }

  products.sort((a, b) => normalizeText(a.name).localeCompare(normalizeText(b.name)));
  return products;
}

function wrapManualPayload(products, fileName) {
  return {
    meta: {
      updatedAt: getCzechNowStr(),
      updatedIso: new Date().toISOString(),
      source: fileName,
      sourceUrl: 'manual-upload',
      totalProducts: products.length,
      validCount: products.filter((p) => p.status === 'Platné rozhodnutí').length,
      stockConsumptionCount: products.filter((p) => p.status === 'Do spotřebování zásob').length,
      phoRestrictedCount: products.filter((p) => p.pho?.restricted).length,
      beeRiskCount: products.filter((p) => ['ZNV', 'NV', 'SPe8'].includes(p.bees?.code)).length,
      isLocalOverride: true,
    },
    items: products,
  };
}

function decodeXmlEntities(str) {
  if (!str || !str.includes('&')) return str;
  return str.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (_, e) => {
    if (e === 'amp') return '&';
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    if (e.startsWith('#x') || e.startsWith('#X')) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith('#')) return String.fromCodePoint(parseInt(e.slice(1), 10));
    return `&${e};`;
  });
}

async function streamXlsxSheetRows(arrayBuffer, entry, sharedStrings, onRow) {
  const slice = getEntryCompressedSlice(arrayBuffer, entry);
  let stream;
  if (entry.method === 0) {
    stream = new Blob([slice]).stream();
  } else if (entry.method === 8) {
    stream = new Blob([slice]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  } else {
    throw new Error(`Nepodporovaná ZIP komprese (${entry.method}).`);
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let headers = null;
  const rowOpenRe = /<(?:\w+:)?row\b[^>]*>/;
  const rowCloseRe = /<\/(?:\w+:)?row>/;
  const cellRe = /<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;

  const parseRow = (inner) => {
    const raw = Object.create(null);
    cellRe.lastIndex = 0;
    let m;
    while ((m = cellRe.exec(inner)) !== null) {
      const attrs = m[1];
      const body = m[2];
      if (!body) continue;
      const rM = attrs.match(/\br="([A-Z]+)\d+"/);
      if (!rM) continue;
      const col = rM[1];
      const tM = attrs.match(/\bt="([^"]+)"/);
      const type = tM ? tM[1] : '';
      if (type === 'inlineStr') {
        let txt = '';
        const tRe = /<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g;
        let tm;
        while ((tm = tRe.exec(body)) !== null) txt += decodeXmlEntities(tm[1]);
        raw[col] = txt;
      } else {
        const vM = body.match(/<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/);
        if (!vM) continue;
        raw[col] = type === 's' ? (sharedStrings[Number(vM[1])] ?? '') : decodeXmlEntities(vM[1]);
      }
    }
    if (!headers) {
      headers = Object.create(null);
      for (const [col, val] of Object.entries(raw)) {
        const c = cleanWs(val);
        if (c) headers[col] = c;
      }
      return;
    }
    const named = Object.create(null);
    for (const [col, hName] of Object.entries(headers)) {
      if (raw[col] !== undefined) named[hName] = raw[col];
    }
    onRow(named);
  };

  while (true) {
    const { value, done } = await reader.read();
    if (value) buf += decoder.decode(value, { stream: true });
    if (done) buf += decoder.decode();
    while (true) {
      const o = rowOpenRe.exec(buf);
      if (!o) {
        if (buf.length > 64) buf = buf.slice(-64);
        break;
      }
      const tail = buf.slice(o.index + o[0].length);
      const c = rowCloseRe.exec(tail);
      if (!c) {
        if (o.index > 0) buf = buf.slice(o.index);
        break;
      }
      parseRow(tail.slice(0, c.index));
      buf = tail.slice(c.index + c[0].length);
    }
    if (done) break;
  }
}

async function parseManualPorXlsx(arrayBuffer, fileName, report) {
  report(8, 'Rozbaluji strukturu POR (.xlsx)…');
  const entries = readZipEntries(arrayBuffer);
  const wbXml = await readEntryAsText(arrayBuffer, entries.get('xl/workbook.xml'));
  const relsXml = await readEntryAsText(arrayBuffer, entries.get('xl/_rels/workbook.xml.rels'));

  const relMap = new Map();
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = m[0].match(/\bId="([^"]+)"/)?.[1];
    let target = m[0].match(/\bTarget="([^"]+)"/)?.[1]?.replace(/^\/+/, '');
    if (id && target) {
      if (!target.startsWith('xl/')) target = `xl/${target}`;
      relMap.set(id, target);
    }
  }

  const sheets = new Map();
  for (const m of wbXml.matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)) {
    const name = decodeXmlEntities(m[0].match(/\bname="([^"]+)"/)?.[1] || '');
    const rid = m[0].match(/\br:id="([^"]+)"/)?.[1];
    if (name && rid && relMap.has(rid)) sheets.set(normalizeText(name), relMap.get(rid));
  }

  report(18, 'Načítám tabulku textů ÚKZÚZ…');
  const sharedStrings = [];
  const ssEntry = entries.get('xl/sharedStrings.xml');
  if (ssEntry) {
    const ssXml = await readEntryAsText(arrayBuffer, ssEntry);
    const siRe = /<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g;
    const tRe = /<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g;
    let sm;
    while ((sm = siRe.exec(ssXml)) !== null) {
      let text = '';
      tRe.lastIndex = 0;
      let tm;
      while ((tm = tRe.exec(sm[1])) !== null) text += decodeXmlEntities(tm[1]);
      sharedStrings.push(text);
    }
  }

  const findSheet = (prefix) => {
    for (const [k, v] of sheets.entries()) {
      if (k.includes('vs.')) continue;
      if (k === prefix || k.startsWith(prefix)) return entries.get(v);
    }
    return null;
  };

  const shRozh = findSheet('rozhodnuti') || entries.get(Array.from(sheets.values())[0]);
  const shUdaje = findSheet('udaje');
  const shUl = findSheet('ucinne latky');
  const shDavk = findSheet('davkovani');
  const shPouz = findSheet('pouziti');
  const shPlod = findSheet('plodiny');

  const allowed = new Set(['Platné rozhodnutí', 'Do spotřebování zásob']);
  const decByKey = new Map();
  const decsById = new Map();
  const allowedIds = new Set();

  report(32, 'Zpracovávám list Rozhodnutí…');
  await streamXlsxSheetRows(arrayBuffer, shRozh, sharedStrings, (row) => {
    const status = cleanWs(row['Aktuální stav rozhodnutí']);
    if (!allowed.has(status)) return;
    const name = cleanWs(row['Obchodní název přípravku']);
    const decId = cleanWs(row['Id rozhodnutí']);
    if (!name) return;
    if (decId) allowedIds.add(decId);

    const rec = {
      name,
      itemId: cleanWs(row['Id položky']),
      reg: cleanWs(row['Registrační číslo']),
      decId,
      holder: cleanWs(row['Držitel rozhodnutí']),
      effectiveFrom: parseDateToIso(row['Právní účinky rozhodnutí ode dne']),
      validTo: parseDateToIso(row['Platnost rozhodnutí končí dne']),
      marketTo: parseDateToIso(row['Ukončení uvádění na trh']),
      useTo: parseDateToIso(row['Používání povoleno max. do']),
      fn: cleanWs(row['Biologická funkce']),
      regStatus: cleanWs(row['Status registrace']),
      eco: normalizeText(row['Pro ekologické zemědělství']) === 'ano',
      status,
      ul: [],
      pho: null,
      bees: null,
      cg: new Set(),
      crops: [],
      uses: [],
    };
    decByKey.set(`${name}\x1f${decId}`, rec);
    if (decId) {
      if (!decsById.has(decId)) decsById.set(decId, []);
      decsById.get(decId).push(rec);
    }
  });

  const getTargets = (name, decId) => {
    const exact = decByKey.get(`${name}\x1f${decId}`);
    return exact ? [exact] : decsById.get(decId) || [];
  };

  if (shUdaje) {
    report(50, 'Zpracovávám omezení PHO a rizika pro včely…');
    await streamXlsxSheetRows(arrayBuffer, shUdaje, sharedStrings, (row) => {
      const decId = cleanWs(row['Id rozhodnutí']);
      if (!allowedIds.has(decId)) return;
      const u = normalizeText(row['Hodnocený údaj']);
      const isPho = u.includes('ochranna pasma vod');
      const isBees = u.includes('riziko pro vcely');
      if (!isPho && !isBees) return;
      const targets = getTargets(cleanWs(row['Obchodní název přípravku']), decId);
      if (isPho) {
        const p = classifyPho(row['Zkratka'], row['Význam údaje'], row['Poznámka']);
        for (const t of targets) if (PHO_SEV(p) > PHO_SEV(t.pho)) t.pho = p;
      } else {
        const b = classifyBees(row['Zkratka'], row['Význam údaje'], row['Poznámka']);
        for (const t of targets) if (BEE_SEV(b) > BEE_SEV(t.bees)) t.bees = b;
      }
    });
  }

  if (shUl) {
    report(66, 'Zpracovávám účinné látky a chemické skupiny…');
    await streamXlsxSheetRows(arrayBuffer, shUl, sharedStrings, (row) => {
      const decId = cleanWs(row['Id rozhodnutí']);
      if (!allowedIds.has(decId)) return;
      const un = cleanWs(row['Název účinné látky']);
      if (!un) return;
      const qty = cleanWs(row['Množství']);
      const mj = cleanWs(row['Měrná jednotka']);
      const conc = qty ? `${qty} ${mj}`.trim() : mj;
      const group = cleanWs(row['Skupiny']);
      const targets = getTargets(cleanWs(row['Obchodní název přípravku']), decId);
      for (const t of targets) t.ul.push({ n: un, q: qty, u: mj, c: conc, g: group });
    });
  }

  if (shDavk) {
    report(78, 'Zpracovávám dávkování a registrované plodiny…');
    await streamXlsxSheetRows(arrayBuffer, shDavk, sharedStrings, (row) => {
      const decId = cleanWs(row['Id rozhodnutí']);
      if (!allowedIds.has(decId)) return;
      const crop = cleanWs(row['Plodina, oblast použití']);
      if (!crop) return;
      const pest = cleanWs(row['Škodlivý organismus, jiný účel použití']);
      const dose = cleanDoseText(row['Celá dávka textem'] || `${row['Dávkování'] || ''} ${row['Měrná jednotka'] || ''}`);
      const cats = classifyCropCategories(crop);
      const targets = getTargets(cleanWs(row['Obchodní název přípravku']), decId);
      for (const t of targets) {
        cats.forEach((c) => t.cg.add(c));
        t.uses.push({ c: crop, p: pest, d: dose });
      }
    });
  } else if (shPouz) {
    report(78, 'Zpracovávám použití a plodiny…');
    await streamXlsxSheetRows(arrayBuffer, shPouz, sharedStrings, (row) => {
      const decId = cleanWs(row['Id rozhodnutí']);
      if (!allowedIds.has(decId)) return;
      const crop = cleanWs(row['Plodina, oblast použití']);
      if (!crop) return;
      const pest = cleanWs(row['Škodlivý organismus, jiný účel použití']);
      const dose = cleanDoseText(row['Dávkování']);
      const ol = cleanWs(row['Ochranná lhůta']);
      const cats = classifyCropCategories(crop);
      const targets = getTargets(cleanWs(row['Obchodní název přípravku']), decId);
      for (const t of targets) {
        cats.forEach((c) => t.cg.add(c));
        t.uses.push({ c: crop, p: pest, d: dose, ol });
      }
    });
  }

  if (shPlod) {
    report(90, 'Seskupuji kategorie plodin…');
    await streamXlsxSheetRows(arrayBuffer, shPlod, sharedStrings, (row) => {
      const decId = cleanWs(row['Id rozhodnutí']);
      if (!allowedIds.has(decId)) return;
      const n1 = cleanWs(row['Název']);
      const n2 = cleanWs(row['Výpis plodin podle webové prezentace (bez vazby na číselník)']);
      const targets = getTargets(cleanWs(row['Obchodní název přípravku']), decId);
      for (const lbl of [n1, n2]) {
        if (!lbl) continue;
        const cats = classifyCropCategories(lbl);
        for (const t of targets) {
          cats.forEach((c) => t.cg.add(c));
          t.crops.push(lbl);
        }
      }
    });
  }

  report(97, 'Sestavuji čistý registr ÚKZÚZ…');
  const products = mergeDecisions(Array.from(decByKey.values()));
  report(100, 'Hotovo!');
  return wrapManualPayload(products, fileName);
}

async function parseManualPorXml(file, report) {
  report(15, 'Čtu XML export ÚKZÚZ po blocích…');
  const reader = file.stream().getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let readBytes = 0;
  const totalBytes = file.size || 1;
  const decisions = [];

  const tagVal = (xml, tag) => {
    const m = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    return m ? cleanWs(decodeXmlEntities(m[1])) : '';
  };

  const processPolozka = (block) => {
    const itemId = tagVal(block, 'ID');
    const mainOjp = tagVal(block, 'OJP');
    for (const rm of block.matchAll(/<ROZHODNUTI\b[^>]*>([\s\S]*?)<\/ROZHODNUTI>/gi)) {
      const r = rm[1];
      const akt = tagVal(r, 'AKT_STAV');
      const status = akt === 'P' ? 'Platné rozhodnutí' : akt === 'Z' ? 'Do spotřebování zásob' : null;
      if (!status) continue;

      const names = [];
      for (const om of r.matchAll(/<OJP_NAZEV\b[^>]*>([\s\S]*?)<\/OJP_NAZEV>/gi)) {
        const nm = cleanWs(decodeXmlEntities(om[1]));
        if (nm && !names.includes(nm)) names.push(nm);
      }
      if (mainOjp && !names.includes(mainOjp)) names.unshift(mainOjp);

      const ul = [];
      for (const um of r.matchAll(/<UL\b[^>]*>([\s\S]*?)<\/UL>/gi)) {
        const uBlock = um[1];
        const un = tagVal(uBlock, 'NAZEV');
        if (!un) continue;
        const qty = tagVal(uBlock, 'MNOZSTVI');
        const mj = tagVal(uBlock, 'MJ');
        const groups = [];
        for (const sm of uBlock.matchAll(/<SKUP_UL\b[^>]*>([\s\S]*?)<\/SKUP_UL>/gi)) {
          const g = tagVal(sm[1], 'NAZEV_EN') || tagVal(sm[1], 'KOD');
          if (g && !groups.includes(g)) groups.push(g);
        }
        ul.push({ n: un, q: qty, u: mj, c: qty ? `${qty} ${mj}`.trim() : mj, g: groups.join(', ') });
      }

      let bestPho = null;
      let bestBees = null;
      for (const udm of r.matchAll(/<UDAJE\b([^>]*)>([\s\S]*?)<\/UDAJE>/gi)) {
        const dom = (udm[1].match(/\bdomena="([^"]+)"/i)?.[1] || '').toUpperCase();
        const body = udm[2];
        const ud = normalizeText(tagVal(body, 'UDAJ'));
        if (dom === 'VA02' || ud.includes('ochranna pasma vod')) {
          const p = classifyPho(tagVal(body, 'ZKR'), tagVal(body, 'VYZNAM'), tagVal(body, 'POZNAMKA'));
          if (PHO_SEV(p) > PHO_SEV(bestPho)) bestPho = p;
        } else if (dom === 'VA04' || ud.includes('riziko pro vcely')) {
          const b = classifyBees(tagVal(body, 'ZKR'), tagVal(body, 'VYZNAM'), tagVal(body, 'POZNAMKA'));
          if (BEE_SEV(b) > BEE_SEV(bestBees)) bestBees = b;
        }
      }

      const cg = new Set();
      const crops = [];
      const uses = [];
      for (const pm of r.matchAll(/<POUZITI\b[^>]*>([\s\S]*?)<\/POUZITI>/gi)) {
        const pb = pm[1];
        const plod = tagVal(pb, 'PLODINA');
        if (!plod) continue;
        const so = tagVal(pb, 'SO');
        const davka = cleanDoseText(tagVal(pb, 'DAVKA'));
        const ol = tagVal(pb, 'OL');
        classifyCropCategories(plod).forEach((c) => cg.add(c));
        crops.push(plod);
        uses.push({ c: plod, p: so, d: davka, ol });
      }

      const base = {
        itemId,
        reg: tagVal(r, 'REG_CISLO'),
        holder: tagVal(r, 'DRZ_ROZH'),
        effectiveFrom: parseDateToIso(tagVal(r, 'D_NABYLO_PR_MOCI')),
        validTo: parseDateToIso(tagVal(r, 'D_PLATNE_DO')),
        marketTo: parseDateToIso(tagVal(r, 'D_ZASD_SKUT')),
        useTo: parseDateToIso(tagVal(r, 'D_ZAS_SKUT')),
        fn: tagVal(r, 'B_FCE'),
        regStatus: tagVal(r, 'STATUS_REG'),
        eco: tagVal(r, 'EKO').toLowerCase() === 'true',
        status,
        ul,
        pho: bestPho,
        bees: bestBees,
        cg,
        crops,
        uses,
      };
      for (const nm of names) decisions.push({ ...base, name: nm });
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (value) {
      readBytes += value.byteLength;
      buf += decoder.decode(value, { stream: true });
    }
    if (done) buf += decoder.decode();
    while (true) {
      const start = buf.indexOf('<POLOZKA>');
      if (start === -1) {
        if (buf.length > 32) buf = buf.slice(-32);
        break;
      }
      const end = buf.indexOf('</POLOZKA>', start);
      if (end === -1) {
        if (start > 0) buf = buf.slice(start);
        break;
      }
      processPolozka(buf.slice(start, end + 10));
      buf = buf.slice(end + 10);
    }
    const pct = Math.min(94, 15 + Math.floor((readBytes / totalBytes) * 79));
    report(pct, `Zpracováno ${Math.round(readBytes / (1024 * 1024))} MB XML…`);
    if (done) break;
  }

  const products = mergeDecisions(decisions);
  report(100, 'Hotovo!');
  return wrapManualPayload(products, file.name);
}

function parseCsvLine(line, delimiter) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQ = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === delimiter) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

async function parseManualPorCsv(file, report) {
  report(30, 'Načítám CSV soubor POR…');
  const text = (await file.text()).replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw new Error('CSV soubor neobsahuje žádná data.');
  const delimiter = lines[0].includes(';') ? ';' : ',';
  const headers = parseCsvLine(lines[0], delimiter).map((h) => normalizeText(h));
  const decisions = [];

  for (let i = 1; i < lines.length; i++) {
    const vals = parseCsvLine(lines[i], delimiter);
    const row = Object.create(null);
    headers.forEach((h, idx) => {
      row[h] = cleanWs(vals[idx] || '');
    });
    const name = row['obchodni nazev pripravku'] || row['nazev pripravku'] || row['nazev'] || row['ojp'] || '';
    if (!name) continue;
    let status = row['aktualni stav rozhodnuti'] || row['stav'] || 'Platné rozhodnutí';
    if (normalizeText(status) === 'platne rozhodnuti') status = 'Platné rozhodnutí';
    else if (normalizeText(status).includes('spotrebovani')) status = 'Do spotřebování zásob';

    const ulStr = row['ucinne latky'] || row['ucinna latka'] || '';
    const grpStr = row['chemicka skupina'] || row['skupiny'] || '';
    const plod = row['plodina'] || row['plodina, oblast pouziti'] || '';
    const davka = cleanDoseText(row['davkovani'] || row['cela davka textem'] || '');
    decisions.push({
      name,
      reg: row['registracni cislo'] || row['reg_cislo'] || '',
      status,
      validTo: parseDateToIso(row['platnost rozhodnuti konci dne'] || row['platnost do']),
      marketTo: parseDateToIso(row['ukonceni uvadeni na trh']),
      useTo: parseDateToIso(row['pouzivani povoleno max. do'] || row['termin spotreby zasob']),
      fn: row['biologicka funkce'] || row['funkce'] || '',
      holder: row['drzitel rozhodnuti'] || '',
      eco: normalizeText(row['pro ekologicke zemedelstvi']) === 'ano',
      ul: ulStr
        .split(/[;,]+/)
        .map((x) => cleanWs(x))
        .filter(Boolean)
        .map((n) => ({ n, c: '', g: grpStr })),
      pho: classifyPho(row['pho'] || row['ochranna pasma vod'] || '', '', ''),
      bees: classifyBees(row['riziko pro vcely'] || row['vcely'] || '', '', ''),
      cg: new Set(plod ? classifyCropCategories(plod) : []),
      crops: plod ? [plod] : [],
      uses: plod ? [{ c: plod, d: davka }] : [],
    });
  }

  const products = mergeDecisions(decisions);
  report(100, 'Hotovo!');
  return wrapManualPayload(products, file.name);
}

/**
 * Hlavní vstup pro záložní ruční nahrání souboru POR (.json, .xlsx, .xml, .csv).
 */
export async function parseManualPorFile(file, onProgress = null) {
  const report = (pct, msg) => {
    if (typeof onProgress === 'function') onProgress(pct, msg);
  };
  const ext = (file.name.split('.').pop() || '').toLowerCase();

  if (ext === 'json') {
    report(40, 'Načítám JSON registr POR…');
    const parsed = JSON.parse(await file.text());
    const items = Array.isArray(parsed) ? parsed : parsed?.items;
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('JSON soubor neobsahuje platný seznam přípravků POR.');
    }
    report(100, 'Hotovo!');
    return {
      meta: {
        ...(parsed.meta || {}),
        updatedAt: parsed.meta?.updatedAt || getCzechNowStr(),
        source: file.name,
        totalProducts: items.length,
        validCount: items.filter((p) => p.status === 'Platné rozhodnutí').length,
        stockConsumptionCount: items.filter((p) => p.status === 'Do spotřebování zásob').length,
        isLocalOverride: true,
      },
      items,
    };
  }

  if (ext === 'xlsx') {
    const ab = await file.arrayBuffer();
    return await parseManualPorXlsx(ab, file.name, report);
  }

  if (ext === 'xml') {
    return await parseManualPorXml(file, report);
  }

  if (ext === 'csv') {
    return await parseManualPorCsv(file, report);
  }

  throw new Error('Podporované formáty jsou .xlsx, .xml, .csv nebo .json.');
}
