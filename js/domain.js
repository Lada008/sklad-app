/**
 * Skladový asistent — doménová logika a přepočty
 * Lokace, kategorie, skloňování, balení, palety, FEFO expirace, vyhledávání bez diakritiky.
 */

export const LOC_MAP = {
  '151BO': { label: 'Boršice', icon: '🏢' },
  '151VM': { label: 'Valmez', icon: '🏭' },
  '151ST': { label: 'Staré Město', icon: '🏬' },
  '151ZL': { label: 'Zlín', icon: '🏬' },
  '151UB': { label: 'Uherský Brod', icon: '🏬' },
  '151SL': { label: 'Slavičín', icon: '🏬' },
  'NACESTE': { label: 'Na cestě', icon: '🚚' },
};

export const REPORT_LOCATIONS = [
  '🏢 Boršice',
  '🏭 Valmez',
  '🏬 Staré Město',
  '🏬 Zlín',
  '🏬 Uherský Brod',
  '🏬 Slavičín',
  '🚚 Na cestě',
  '🤝 Komise Boršice',
  '🤝 Komise Valmez',
];

export const PACKAGING_TYPES = [
  { value: 'automaticky', label: 'Automaticky' },
  { value: 'kanystr', label: 'Kanystr' },
  { value: 'krabice', label: 'Krabice' },
  { value: 'pytel', label: 'Pytel' },
  { value: 'láhev', label: 'Láhev' },
  { value: 'balení', label: 'Balení' },
  { value: 'kus', label: 'Kus' },
];

/**
 * Odstraní diakritiku a převede na malá písmena pro rychlé tolerantní vyhledávání.
 */
export function normalizeText(str) {
  if (!str) return '';
  return String(str)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Formátuje aktuální čas v ČR (Europe/Prague): DD.MM.YYYY HH:MM
 */
export function getCzechNowStr(date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('cs-CZ', {
      timeZone: 'Europe/Prague',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(date);
    const get = (type) => parts.find((p) => p.type === type)?.value || '';
    return `${get('day')}.${get('month')}.${get('year')} ${get('hour')}:${get('minute')}`;
  } catch {
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
}

export function getCzechFileTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/**
 * Formátuje číslo čistě pro české rozhraní (bez zbytečných nul).
 */
export function formatQty(num) {
  if (num === null || num === undefined || Number.isNaN(Number(num))) return '0';
  const rounded = Math.round(Number(num) * 1000) / 1000;
  return rounded.toLocaleString('cs-CZ', { maximumFractionDigits: 3 });
}

export function formatNumberRaw(num) {
  if (num === null || num === undefined || Number.isNaN(Number(num))) return '0';
  const rounded = Math.round(Number(num) * 1000) / 1000;
  return String(rounded);
}

/**
 * Formátuje ISO datum YYYY-MM-DD na DD.MM.YYYY
 */
export function formatIsoDateCz(iso) {
  if (!iso || typeof iso !== 'string') return '-';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return `${m[3]}.${m[2]}.${m[1]}`;
}

/**
 * Vrátí dnešní půlnoc v lokálním čase pro výpočet zbývajících dní do expirace.
 */
export function getTodayMidnightMs() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

export function daysUntilIsoDate(iso, todayMs = getTodayMidnightMs()) {
  if (!iso) return null;
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const targetMs = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  return Math.round((targetMs - todayMs) / 86400000);
}

/**
 * Fyzický sklad podle kódu lokace a prodejce.
 */
export function getFyzickySklad(loc, prodejce) {
  const locStr = String(loc || '').trim();
  const prodStr = String(prodejce || '').trim().toUpperCase();
  if (locStr === '151BO') return 'Boršice';
  if (locStr === '151VM') return 'Valmez';
  if (locStr.startsWith('K.')) {
    if (prodStr === 'TRČÁLEK' || prodStr === 'TRCALEK') return 'Valmez';
    return 'Boršice';
  }
  return locStr;
}

/**
 * Čitelný název lokace včetně ikony.
 */
export function formatLocationDisplay(loc, ln) {
  const locStr = String(loc || '').trim();
  if (LOC_MAP[locStr]) {
    return `${LOC_MAP[locStr].icon} ${LOC_MAP[locStr].label}`;
  }
  if (locStr.startsWith('K.')) {
    return `🤝 ${ln || locStr}`;
  }
  return ln || locStr || '-';
}

export function formatLocationPlain(loc, prodejce) {
  const locStr = String(loc || '').trim();
  if (!locStr) return '-';
  if (LOC_MAP[locStr]) return LOC_MAP[locStr].label;
  if (locStr.startsWith('K.')) {
    const nazevKomise = locStr.slice(2).toUpperCase();
    const prodStr = String(prodejce || '').trim().toUpperCase();
    if (prodStr === 'TRČÁLEK' || prodStr === 'TRCALEK') {
      return `Komise ${nazevKomise} (Valmez)`;
    }
    return `Komise ${nazevKomise} (Boršice)`;
  }
  return locStr;
}

/**
 * Kategorie přípravku (krátký název, ikona, barevná třída).
 */
export function parseCategory(cat) {
  if (!cat || typeof cat !== 'string') {
    return { key: 'ostatni', label: 'Ostatní', icon: '📦', tone: 'neutral' };
  }
  const c = cat.toUpperCase();
  if (c.includes('HERBICID') || c.startsWith('H ') || c.startsWith('H-')) {
    return { key: 'herbicid', label: 'Herbicid', icon: '🌿', tone: 'emerald' };
  }
  if (c.includes('MOŘID') || c.includes('MORID') || c.startsWith('F-M')) {
    return { key: 'moridlo', label: 'Mořidlo', icon: '🛡️', tone: 'indigo' };
  }
  if (c.includes('FUNGICID') || c.startsWith('F ') || c.startsWith('FV ')) {
    return { key: 'fungicid', label: 'Fungicid', icon: '🍄', tone: 'teal' };
  }
  if (c.includes('INSEKTICID') || c.startsWith('I ')) {
    return { key: 'insekticid', label: 'Insekticid', icon: '🐛', tone: 'amber' };
  }
  if (c.includes('HNOJIV') || c.includes('SH') || c.includes('PH')) {
    return { key: 'hnojivo', label: 'Hnojivo', icon: '🌾', tone: 'lime' };
  }
  if (c.includes('GRAMIN')) {
    return { key: 'graminicid', label: 'Graminicid', icon: '🌱', tone: 'emerald' };
  }
  if (c.includes('REGULÁTOR') || c.includes('REGULATOR') || c.includes('RR')) {
    return { key: 'regulator', label: 'Regulátor', icon: '⚡', tone: 'sky' };
  }
  if (c.includes('ADITIV') || c.startsWith('A ')) {
    return { key: 'aditivum', label: 'Aditivum', icon: '💧', tone: 'cyan' };
  }
  if (c.includes('BIO')) {
    return { key: 'bio', label: 'Bio', icon: '🌱', tone: 'green' };
  }
  if (c.includes('MALÉ BALENÍ') || c.includes('MB')) {
    return { key: 'male', label: 'Malé balení', icon: '📦', tone: 'stone' };
  }
  if (c.includes('OSIVO')) {
    return { key: 'osivo', label: 'Osivo', icon: '🌻', tone: 'amber' };
  }
  if (c.includes('RODENTICID') || c.startsWith('R ')) {
    return { key: 'rodenticid', label: 'Rodenticid', icon: '⚠️', tone: 'rose' };
  }
  return { key: normalizeText(cat), label: cat, icon: '🧪', tone: 'neutral' };
}

/**
 * České skloňování obalů a palet.
 */
export function sklonuj(pocet, jednotka) {
  const p = Math.abs(pocet);
  const j = String(jednotka || '').toLowerCase();
  const formatted = formatQty(pocet);

  if (j === 'kanystr') {
    return p === 1 ? `${formatted} kanystr` : p >= 2 && p <= 4 ? `${formatted} kanystry` : `${formatted} kanystrů`;
  }
  if (j === 'krabice') {
    return p >= 1 && p <= 4 ? `${formatted} krabice` : `${formatted} krabic`;
  }
  if (j === 'lahev' || j === 'láhev') {
    return p === 1 ? `${formatted} láhev` : p >= 2 && p <= 4 ? `${formatted} láhve` : `${formatted} lahví`;
  }
  if (j === 'pytel') {
    return p === 1 ? `${formatted} pytel` : p >= 2 && p <= 4 ? `${formatted} pytle` : `${formatted} pytlů`;
  }
  if (j === 'kus') {
    return p === 1 ? `${formatted} kus` : p >= 2 && p <= 4 ? `${formatted} kusy` : `${formatted} kusů`;
  }
  if (j === 'paleta') {
    return p === 1 ? `${formatted} celá paleta` : p >= 2 && p <= 4 ? `${formatted} celé palety` : `${formatted} celých palet`;
  }
  if (j === 'baleni' || j === 'balení') {
    return `${formatted} balení`;
  }
  return `${formatted} ${jednotka}`;
}

/**
 * Detekce základní měrné jednotky (l / kg) z popisu produktu.
 */
export function detectBaseUnit(popis) {
  if (!popis || typeof popis !== 'string') return 'j.';
  if (/\b\d*(?:[.,]\d+)?\s*(kg|g)\b/i.test(popis) || /\bkg\b/i.test(popis)) return 'kg';
  if (/\b\d*(?:[.,]\d+)?\s*(l|litr|ml)\b/i.test(popis) || /\bL\b/.test(popis)) return 'l';
  return 'j.';
}

/**
 * Získá krok 1 balení (v l nebo kg) s respektováním vlastního nastavení.
 */
export function ziskejKrokBaleni(kod, popis, customPacks = {}) {
  const kodStr = String(kod || '');
  const custom = customPacks[kodStr];
  if (custom && Number(custom.velikost) > 0) {
    return Number(custom.velikost);
  }
  if (!popis || typeof popis !== 'string') return 1.0;

  const mMult = popis.match(/(\d+)\s*[xX*]\s*(\d+(?:[.,]\d+)?)\s*(l|litr|kg|g|ml)\b/i);
  if (mMult) {
    let v = parseFloat(mMult[2].replace(',', '.'));
    const u = mMult[3].toLowerCase();
    if (u === 'g' || u === 'ml') v /= 1000.0;
    return Math.max(0.001, v);
  }

  const m = popis.match(/(\d+(?:[.,]\d+)?)\s*(l|litr|kg|g|ml)\b/i);
  if (m) {
    let v = parseFloat(m[1].replace(',', '.'));
    const u = m[2].toLowerCase();
    if (u === 'g' || u === 'ml') v /= 1000.0;
    return Math.max(0.001, v);
  }
  return 1.0;
}

/**
 * Přepočet množství na balení (kanystry, krabice, pytle, láhve).
 */
export function prepocetNaBaleni(kod, popis, qty, customPacks = {}) {
  if (!popis || typeof popis !== 'string' || qty === null || qty === undefined || Number.isNaN(qty) || qty === 0) {
    return `${formatQty(qty || 0)} j.`;
  }

  let uomBase = 'l';
  if (/(?:kg|g)\b/i.test(popis)) uomBase = 'kg';

  const kodStr = String(kod || '');
  const custom = customPacks[kodStr];
  let typObalu = 'automaticky';
  let unitSizeBase = 0;

  if (custom && Number(custom.velikost) > 0) {
    unitSizeBase = Number(custom.velikost);
    typObalu = custom.obal || 'automaticky';
  }

  if (unitSizeBase <= 0) {
    const mMult = popis.match(/(\d+)\s*[xX*]\s*(\d+(?:[.,]\d+)?)\s*(l|litr|kg|g|ml)\b/i);
    if (mMult) {
      const ksVBaleni = parseFloat(mMult[1]);
      const velikostKs = parseFloat(mMult[2].replace(',', '.'));
      const uRaw = mMult[3].toLowerCase();
      const vBase = uRaw === 'g' || uRaw === 'ml' ? velikostKs / 1000.0 : velikostKs;
      unitSizeBase = ksVBaleni * vBase;
    } else {
      const m = popis.match(/(\d+(?:[.,]\d+)?)\s*(l|litr|kg|g|ml)\b/i);
      if (m) {
        const unitSize = parseFloat(m[1].replace(',', '.'));
        const uRaw = m[2].toLowerCase();
        unitSizeBase = uRaw === 'g' || uRaw === 'ml' ? unitSize / 1000.0 : unitSize;
      } else if (/\bL\b/.test(popis)) {
        unitSizeBase = 1.0;
      }
    }
  }

  if (unitSizeBase <= 0) {
    return `${formatQty(qty)} j.`;
  }

  if (typObalu === 'automaticky') {
    if (uomBase === 'l') typObalu = unitSizeBase >= 3 ? 'kanystr' : 'láhev';
    else if (uomBase === 'kg') typObalu = unitSizeBase >= 15 ? 'pytel' : 'balení';
    else typObalu = 'balení';
  }

  let celeBaleni = Math.floor(qty / unitSizeBase);
  let zbytek = Math.round((qty - celeBaleni * unitSizeBase) * 1000) / 1000;

  if (Math.abs(unitSizeBase - zbytek) < 0.02) {
    celeBaleni += 1;
    zbytek = 0;
  } else if (zbytek < 0.001) {
    zbytek = 0;
  }

  let krabiceInfo = '';
  const isCustomObal = Boolean(custom && custom.obal && custom.obal !== 'automaticky');

  if (!isCustomObal) {
    if (uomBase === 'l' && unitSizeBase === 5 && celeBaleni >= 4) {
      const k = Math.floor(celeBaleni / 4);
      const zbK = celeBaleni % 4;
      krabiceInfo = zbK > 0
        ? ` (${sklonuj(k, 'krabice')} + ${sklonuj(zbK, 'kanystr')})`
        : ` (${sklonuj(k, 'krabice')})`;
    } else if (uomBase === 'l' && (unitSizeBase === 1 || unitSizeBase === 1000) && celeBaleni >= 12) {
      const k = Math.floor(celeBaleni / 12);
      const zbK = celeBaleni % 12;
      krabiceInfo = zbK > 0
        ? ` (${sklonuj(k, 'krabice')} po 12 ks + ${sklonuj(zbK, 'láhev')})`
        : ` (${sklonuj(k, 'krabice')} po 12 ks)`;
    }
  }

  if (celeBaleni > 0 && zbytek > 0) {
    return `${sklonuj(celeBaleni, typObalu)} + ${formatQty(zbytek)} ${uomBase} navíc`;
  }
  if (celeBaleni > 0) {
    return `${sklonuj(celeBaleni, typObalu)} po ${formatQty(unitSizeBase)} ${uomBase}${krabiceInfo}`;
  }
  return `${formatQty(zbytek)} ${uomBase}`;
}

/**
 * Výpočet palet (25kg pytle: 40 ks / paleta; 5L kanystry: 32 krabic po 4 ks = 640 l / paleta).
 */
export function paletovaKalkulacka(kod, popis, qty, customPacks = {}) {
  if (!popis || typeof popis !== 'string' || !qty || qty <= 0) return null;
  let uomBase = 'l';
  if (/(?:kg|g)\b/i.test(popis)) uomBase = 'kg';

  const unitSizeBase = ziskejKrokBaleni(kod, popis, customPacks);

  if (uomBase === 'kg' && unitSizeBase === 25) {
    const pytle = qty / 25.0;
    if (pytle >= 30) {
      const palet = Math.floor(pytle / 40);
      const zbPytle = Math.floor(pytle % 40);
      if (palet > 0) {
        if (zbPytle === 0) return `Palety: ${sklonuj(palet, 'paleta')} (po 40 pytlích / 1 t)`;
        return `Palety: ${sklonuj(palet, 'paleta')} + ${sklonuj(zbPytle, 'pytel')} navrch`;
      }
      return `Skoro paleta: ${sklonuj(zbPytle, 'pytel')} (chybí ${40 - zbPytle} do palety)`;
    }
  }

  if (uomBase === 'l' && unitSizeBase === 5) {
    const kanystru = qty / 5.0;
    const krabic = kanystru / 4.0;
    if (krabic >= 20) {
      const palet = Math.floor(krabic / 32);
      const zbKrabic = Math.floor(krabic % 32);
      if (palet > 0) {
        if (zbKrabic === 0) return `Palety: ${sklonuj(palet, 'paleta')} (po 32 krabicích / 640 l)`;
        return `Palety: ${sklonuj(palet, 'paleta')} + ${sklonuj(zbKrabic, 'krabice')} navrch`;
      }
      return `Skoro paleta: ${sklonuj(zbKrabic, 'krabice')} (chybí ${32 - zbKrabic} do palety)`;
    }
  }

  return null;
}

/**
 * Semafor expirace (živý výpočet vůči dnešnímu dni).
 */
export function evaluateExpiration(expIso, todayMs = getTodayMidnightMs()) {
  if (!expIso) {
    return { status: 'none', days: null, badge: 'Bez data', dateCz: '-', dot: 'none' };
  }
  const days = daysUntilIsoDate(expIso, todayMs);
  const dateCz = formatIsoDateCz(expIso);
  if (days === null) {
    return { status: 'none', days: null, badge: 'Bez data', dateCz: '-', dot: 'none' };
  }
  if (days < 0) {
    return {
      status: 'expired',
      days,
      badge: `EXPIROVÁNO (${dateCz})`,
      shortLabel: `Před ${Math.abs(days)} dny`,
      dateCz,
      dot: 'expired',
    };
  }
  if (days <= 90) {
    return {
      status: 'critical',
      days,
      badge: `Za ${days} dní (${dateCz})`,
      shortLabel: `Za ${days} dní`,
      dateCz,
      dot: 'critical',
    };
  }
  if (days <= 180) {
    const months = Math.max(1, Math.floor(days / 30));
    return {
      status: 'warning',
      days,
      badge: `Za ${months} měs. (${dateCz})`,
      shortLabel: `Za ${months} měs.`,
      dateCz,
      dot: 'warning',
    };
  }
  if (days <= 365) {
    return {
      status: 'soon',
      days,
      badge: `Do roka (${dateCz})`,
      shortLabel: `Za ${days} dní`,
      dateCz,
      dot: 'soon',
    };
  }
  return {
    status: 'ok',
    days,
    badge: dateCz,
    shortLabel: dateCz,
    dateCz,
    dot: 'ok',
  };
}

/**
 * Připraví obohacené položky s předpočítaným vyhledávacím indexem bez diakritiky,
 * spárováním s registrem ÚKZÚZ (POR) a poznámkami k hnojivům / biostimulantům.
 */
export function enrichItems(rawItems, porMatcher = null, fertMatcher = null) {
  const porCache = new Map();

  return rawItems.map((item, idx) => {
    const catInfo = parseCategory(item.cat);
    const locDisplay = formatLocationDisplay(item.loc, item.ln);

    let por = null;
    let porSearch = '';
    let fert = null;
    let fertSearch = '';
    const cacheKey = `${item.c}||${item.n}`;

    if (porCache.has(cacheKey)) {
      const cached = porCache.get(cacheKey);
      por = cached.por;
      porSearch = cached.porSearch;
      fert = cached.fert;
      fertSearch = cached.fertSearch;
    } else {
      if (porMatcher) {
        por = porMatcher.match(item.c, item.n);
        porSearch = por ? porMatcher.searchText(por) : '';
      }
      if (fertMatcher) {
        const matchFn = typeof fertMatcher === 'function' ? fertMatcher : fertMatcher.match?.bind(fertMatcher);
        fert = matchFn ? matchFn(item.c, item.n) : null;
        if (fert) {
          fertSearch = normalizeText(
            `${fert.elements || fert.prvky || ''} ${fert.tankmix || ''} ${fert.note || fert.poznamka || ''}`
          );
        }
      }
      porCache.set(cacheKey, { por, porSearch, fert, fertSearch });
    }

    const searchIndex =
      normalizeText(`${item.n} ${item.c} ${item.lot} ${item.ln} ${item.wh} ${item.loc} ${catInfo.label}`) +
      (porSearch ? ` ${porSearch}` : '') +
      (fertSearch ? ` ${fertSearch}` : '');

    return {
      ...item,
      _idx: idx,
      _cat: catInfo,
      _locDisplay: locDisplay,
      _por: por,
      _fert: fert,
      _search: searchIndex,
      _nameNorm: normalizeText(item.n),
    };
  });
}

/**
 * Filtr podle globálně vybraného skladu.
 */
export function filterByWarehouse(items, warehouseFilter) {
  if (!warehouseFilter || warehouseFilter === 'all') return items;
  if (warehouseFilter === 'Boršice') return items.filter((i) => i.wh === 'Boršice');
  if (warehouseFilter === 'Valmez') return items.filter((i) => i.wh === 'Valmez');
  if (warehouseFilter === 'komise') return items.filter((i) => String(i.loc || '').startsWith('K.'));
  return items;
}

/**
 * Seskupí položky (šarže) do produktů.
 */
export function groupByProduct(items) {
  const map = new Map();
  for (const item of items) {
    const key = `${item.c}||${item.n}`;
    let group = map.get(key);
    if (!group) {
      group = {
        code: item.c,
        name: item.n,
        cat: item._cat,
        por: item._por || null,
        fert: item._fert || null,
        totalQty: 0,
        batches: [],
      };
      map.set(key, group);
    }
    group.totalQty = Math.round((group.totalQty + item.q) * 10000) / 10000;
    group.batches.push(item);
  }
  return Array.from(map.values());
}

/**
 * Bezpečné escapování HTML proti XSS (data z Excelu i od uživatele).
 */
export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Vytvoří Excel-friendly CSV (UTF-8 s BOM a středníkem pro české Excel nastavení).
 */
export function toCsv(headers, rows, delimiter = ';') {
  const esc = (val) => {
    const s = String(val ?? '');
    if (s.includes(delimiter) || s.includes('"') || s.includes('\n') || s.includes('\r')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const lines = [headers.map(esc).join(delimiter)];
  for (const row of rows) {
    lines.push(row.map(esc).join(delimiter));
  }
  return '\uFEFF' + lines.join('\r\n');
}

export function triggerFileDownload(content, filename, mimeType = 'text/csv;charset=utf-8;') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
