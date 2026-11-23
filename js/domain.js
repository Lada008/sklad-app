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
 * České skloňování obalů, kartonů a palet.
 */
export function sklonuj(pocet, jednotka) {
  const p = Math.abs(pocet);
  const j = String(jednotka || '').toLowerCase();
  const formatted = formatQty(pocet);

  if (j === 'karton') {
    return p === 1 ? `${formatted} karton` : p >= 2 && p <= 4 ? `${formatted} kartony` : `${formatted} kartonů`;
  }
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
  if (/(?:^|\s|\d)(?:kg|g)\b(?!\s*\/)/i.test(popis) || /\bkg\b/i.test(popis)) return 'kg';
  if (/(?:^|\s|\d)(?:l|litr|litrů|ml)\b(?!\s*\/)/i.test(popis) || /\bL\b/.test(popis)) return 'l';
  return 'j.';
}

/**
 * Formátuje množství s jednotkou (např. "55 L", "25 kg", "10 j.").
 */
export function formatQtyWithUnit(qty, popis) {
  const u = detectBaseUnit(popis);
  const display = u === 'l' ? 'L' : u;
  return `${formatQty(qty)} ${display}`;
}

/**
 * Automaticky určí velikost jednotkového balení a kartonu z názvu položky:
 * - 5L / 5 kg -> 1 karton = 20 L/kg (4 kanystry/kusy)
 * - 1L / 1 kg -> 1 karton = 12 L/kg (12 kusů)
 * - 10L / 10 kg -> 1 karton = 20 L/kg (2 kanystry)
 * - 20L, 50L, 1000L IBC a větší -> 1 balení = 1 kus (bez kartonu)
 */
export function getPackagingInfo(kod, popis, customPacks = {}) {
  const uom = detectBaseUnit(popis);
  const uomDisplay = uom === 'l' ? 'L' : uom;
  const kodStr = String(kod || '');
  const custom = customPacks[kodStr];
  const isCustomObal = Boolean(custom && custom.obal && custom.obal !== 'automaticky');

  let unitSize = 0;
  let typObalu = 'automaticky';

  if (custom && Number(custom.velikost) > 0) {
    unitSize = Number(custom.velikost);
    typObalu = custom.obal || 'automaticky';
  } else if (popis && typeof popis === 'string') {
    // 1. Multi-balení typu "4x5L" nebo "12x1kg" -> jednotkový kus je 5L / 1kg
    const multMatches = [...popis.matchAll(/(\d+)\s*[xX*]\s*(\d+(?:[.,]\d+)?)\s*(l|litr|litrů|kg|g|ml)\b(?!\s*\/)/gi)];
    if (multMatches.length > 0) {
      const m = multMatches[multMatches.length - 1];
      let v = parseFloat(m[2].replace(',', '.'));
      const u = m[3].toLowerCase();
      if (u === 'g' || u === 'ml') v /= 1000.0;
      unitSize = Math.max(0.001, v);
    } else {
      // 2. Standardní balení na konci názvu ("5L", "5 L", "1 KG", "10L", "20L", "1000L", "500ml", "0,5 KG")
      const singleMatches = [...popis.matchAll(/(?:^|[\s\-_(])(\d+(?:[.,]\d+)?)\s*(l|litr|litrů|kg|g|ml)\b(?!\s*\/)/gi)];
      if (singleMatches.length > 0) {
        const m = singleMatches[singleMatches.length - 1];
        let v = parseFloat(m[1].replace(',', '.'));
        const u = m[2].toLowerCase();
        if (u === 'g' || u === 'ml') v /= 1000.0;
        unitSize = Math.max(0.001, v);
      } else if (/\bIBC\b/i.test(popis)) {
        unitSize = 1000;
      } else if (/\bL\b/.test(popis)) {
        unitSize = 1.0;
      }
    }
  }

  if (unitSize <= 0) {
    unitSize = 1.0;
  }

  // Pravidla kartonů: nejprve vlastní počet kusů v kartonu (pokud je definován), jinak výchozí pravidla podle litráže/gramáže
  let piecesPerCarton = null;
  let cartonSize = null;
  const customPcs = Number(custom?.ksVKartonu || custom?.piecesPerCarton || 0);

  if (customPcs > 1) {
    piecesPerCarton = Math.round(customPcs);
    cartonSize = Math.round(unitSize * piecesPerCarton * 1000) / 1000;
  } else if (uom === 'l' || uom === 'kg') {
    const is5 = Math.abs(unitSize - 5) < 0.001;
    const is1 = Math.abs(unitSize - 1) < 0.001;
    const is10 = Math.abs(unitSize - 10) < 0.001;
    if (is5) {
      piecesPerCarton = 4;
      cartonSize = 20;
    } else if (is1) {
      piecesPerCarton = 12;
      cartonSize = 12;
    } else if (is10) {
      piecesPerCarton = 2;
      cartonSize = 20;
    }
    // 20L, 25KG, 50L, 1000L IBC a větší -> 1 balení = 1 kus (cartonSize = null)
  }

  // Typ jednotkového obalu
  let pieceType = typObalu;
  if (pieceType === 'automaticky') {
    if (uom === 'l') {
      if (unitSize >= 500) pieceType = 'kus';
      else if (unitSize >= 3) pieceType = 'kanystr';
      else pieceType = 'kus';
    } else if (uom === 'kg') {
      if (unitSize >= 15) pieceType = 'pytel';
      else pieceType = 'kus';
    } else {
      pieceType = 'kus';
    }
  }

  return {
    unitSize,
    uom,
    uomDisplay,
    pieceType,
    piecesPerCarton,
    cartonSize,
    hasCarton: Boolean(cartonSize && cartonSize > 0),
    isCustomObal,
  };
}

/**
 * Získá krok 1 balení (v l nebo kg) s respektováním vlastního nastavení.
 */
export function ziskejKrokBaleni(kod, popis, customPacks = {}) {
  return getPackagingInfo(kod, popis, customPacks).unitSize;
}

/**
 * Přepočet množství na celé kartony a volné kusy/kanystry (např. "2 kartony + 3 kanystry po 5 L").
 */
export function prepocetNaBaleni(kod, popis, qty, customPacks = {}) {
  if (!popis || typeof popis !== 'string' || qty === null || qty === undefined || Number.isNaN(Number(qty))) {
    return `${formatQty(qty || 0)} j.`;
  }
  const numQty = Number(qty);
  const info = getPackagingInfo(kod, popis, customPacks);
  const { unitSize, uomDisplay, pieceType, cartonSize, hasCarton, isCustomObal } = info;

  if (numQty === 0) {
    return `0 ${uomDisplay}`;
  }

  const signPrefix = numQty < 0 ? '−' : '';
  const absQty = Math.abs(numQty);

  if (unitSize <= 0 || info.uom === 'j.') {
    return `${signPrefix}${formatQty(absQty)} ${uomDisplay}`;
  }

  // Rozpad na celé kartony + volné kusy/kanystry (pokud má produkt kartonová pravidla)
  if (hasCarton && !isCustomObal) {
    let celeKartony = Math.floor((absQty + 1e-6) / cartonSize);
    let poKartonech = Math.round((absQty - celeKartony * cartonSize) * 1000) / 1000;
    if (poKartonech < 0.001) poKartonech = 0;

    let volneKusy = Math.floor((poKartonech + 1e-6) / unitSize);
    let zbytek = Math.round((poKartonech - volneKusy * unitSize) * 1000) / 1000;

    if (Math.abs(unitSize - zbytek) < 0.02) {
      volneKusy += 1;
      zbytek = 0;
    } else if (zbytek < 0.001) {
      zbytek = 0;
    }

    if (info.piecesPerCarton && volneKusy >= info.piecesPerCarton) {
      celeKartony += Math.floor(volneKusy / info.piecesPerCarton);
      volneKusy = volneKusy % info.piecesPerCarton;
    }

    const parts = [];
    if (celeKartony > 0) {
      parts.push(sklonuj(celeKartony, 'karton'));
    }
    if (volneKusy > 0) {
      parts.push(`${sklonuj(volneKusy, pieceType)} po ${formatQty(unitSize)} ${uomDisplay}`);
    }
    if (zbytek > 0) {
      parts.push(`${formatQty(zbytek)} ${uomDisplay} navíc`);
    }

    if (celeKartony > 0 && volneKusy === 0 && zbytek === 0) {
      const celkemKs = celeKartony * info.piecesPerCarton;
      return `${signPrefix}${sklonuj(celeKartony, 'karton')} (${sklonuj(celkemKs, pieceType)} po ${formatQty(unitSize)} ${uomDisplay})`;
    }
    if (parts.length > 0) {
      return `${signPrefix}${parts.join(' + ')}`;
    }
  }

  // Větší balení (20L, 50L, 1000L IBC) nebo vlastní obal: 1 balení = 1 kus
  let celeBaleni = Math.floor((absQty + 1e-6) / unitSize);
  let zbytek = Math.round((absQty - celeBaleni * unitSize) * 1000) / 1000;

  if (Math.abs(unitSize - zbytek) < 0.02) {
    celeBaleni += 1;
    zbytek = 0;
  } else if (zbytek < 0.001) {
    zbytek = 0;
  }

  if (celeBaleni > 0 && zbytek > 0) {
    return `${signPrefix}${sklonuj(celeBaleni, pieceType)} po ${formatQty(unitSize)} ${uomDisplay} + ${formatQty(zbytek)} ${uomDisplay} navíc`;
  }
  if (celeBaleni > 0) {
    return `${signPrefix}${sklonuj(celeBaleni, pieceType)} po ${formatQty(unitSize)} ${uomDisplay}`;
  }
  return `${signPrefix}${formatQty(zbytek)} ${uomDisplay}`;
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
  const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// --- Zero-dependency Excel (.xlsx) export (uncompressed ZIP / STORE method 0) ---
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function xmlEsc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function colIndexToLetter(idx) {
  let n = idx + 1;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function buildZipStore(files) {
  const enc = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const dataBytes = enc.encode(f.content);
    const crc = crc32(dataBytes);
    const size = dataBytes.length;

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8
    lv.setUint16(8, 0, true); // method 0 = STORE
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);

    localParts.push(local, dataBytes);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centralParts.push(central);

    offset += local.length + dataBytes.length;
  }

  const centralSize = centralParts.reduce((s, a) => s + a.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  return new Blob([...localParts, ...centralParts, eocd], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

/**
 * Vytvoří validní Excel (.xlsx) Blob s jedním listem bez externích knihoven.
 */
export function buildXlsxBlob(sheetName, headers, rows) {
  const safeSheet = xmlEsc(String(sheetName || 'Inventura').slice(0, 31));
  const allRows = [headers, ...rows];
  const rowXml = allRows
    .map((cells, rIdx) => {
      const rNum = rIdx + 1;
      const cellXml = cells
        .map((val, cIdx) => {
          const ref = `${colIndexToLetter(cIdx)}${rNum}`;
          if (rIdx > 0 && typeof val === 'number' && !Number.isNaN(val) && Number.isFinite(val)) {
            return `<c r="${ref}"><v>${val}</v></c>`;
          }
          const s = xmlEsc(val ?? '');
          return `<c r="${ref}" t="inlineStr"><is><t>${s}</t></is></c>`;
        })
        .join('');
      return `<row r="${rNum}">${cellXml}</row>`;
    })
    .join('');

  const sheetXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${rowXml}</sheetData></worksheet>`;

  const workbookXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="${safeSheet}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  const wbRelsXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
    `</Relationships>`;

  const rootRelsXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;

  const contentTypesXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `</Types>`;

  return buildZipStore([
    { name: '[Content_Types].xml', content: contentTypesXml },
    { name: '_rels/.rels', content: rootRelsXml },
    { name: 'xl/workbook.xml', content: workbookXml },
    { name: 'xl/_rels/workbook.xml.rels', content: wbRelsXml },
    { name: 'xl/worksheets/sheet1.xml', content: sheetXml },
  ]);
}

/**
 * Extrahuje použitelné dávky (l/ha nebo kg/ha) z pole `por.uses` z registru ÚKZÚZ.
 */
export function extractPorDoseOptions(porUses = []) {
  if (!Array.isArray(porUses) || !porUses.length) return [];
  const seen = new Set();
  const options = [];

  for (const u of porUses) {
    const raw = String(u?.d || '').trim();
    if (!raw) continue;
    // Najdi první číselnou hodnotu (nebo horní hranici rozsahu např. "0,5-0,8 l/ha") s jednotkou /ha
    const rangeM = raw.match(/(\d+(?:[.,]\d+)?)\s*[-–]\s*(\d+(?:[.,]\d+)?)\s*(ml|l|g|kg)\s*\/\s*ha/i);
    const singleM = raw.match(/(\d+(?:[.,]\d+)?)\s*(ml|l|g|kg)\s*\/\s*ha/i);
    let val = null;
    let unit = '';
    if (rangeM) {
      val = parseFloat(rangeM[2].replace(',', '.'));
      unit = rangeM[3].toLowerCase();
    } else if (singleM) {
      val = parseFloat(singleM[1].replace(',', '.'));
      unit = singleM[2].toLowerCase();
    }
    if (!val || Number.isNaN(val) || val <= 0) continue;
    if (unit === 'ml' || unit === 'g') val = Math.round((val / 1000) * 10000) / 10000;
    const uom = unit === 'kg' || unit === 'g' ? 'kg' : 'L';
    const crop = String(u?.c || '').trim().split(',')[0].slice(0, 22);
    const dedupKey = `${crop.toLowerCase()}|${val}|${uom}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    options.push({
      crop: crop || 'Dávka',
      dose: val,
      uom,
      label: `${crop ? `${crop}: ` : ''}${formatQty(val)} ${uom}/ha`,
    });
    if (options.length >= 6) break;
  }

  return options;
}

/**
 * Sdílení textu přes nativní Web Share API (mobil: WhatsApp, SMS, e-mail) s fallbackem do schránky.
 * Vrací 'shared' | 'copied' | 'cancelled' | 'failed'.
 */
export async function shareOrCopyText({ title = 'Skladový asistent', text = '' } = {}) {
  const cleanText = String(text || '').trim();
  if (!cleanText) return 'failed';

  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share({ title, text: cleanText });
      return 'shared';
    } catch (err) {
      if (err && err.name === 'AbortError') return 'cancelled';
      // Pokračuj fallbackem na clipboard
    }
  }

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(cleanText);
      return 'copied';
    } catch {
      // Fallback níže
    }
  }

  try {
    const ta = document.createElement('textarea');
    ta.value = cleanText;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok ? 'copied' : 'failed';
  } catch {
    return 'failed';
  }
}

export function buildWhatsAppUrl(text) {
  return `https://wa.me/?text=${encodeURIComponent(String(text || '').trim())}`;
}
