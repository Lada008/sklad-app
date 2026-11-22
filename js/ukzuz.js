/**
 * Modul pro registr přípravků na ochranu rostlin ÚKZÚZ (eAGRI POR).
 * - Čištění názvů položek z Business Central od velikostí balení a poznámek dodavatele
 * - Inteligentní párování se skladem (název, kompaktní název, registrační číslo, ID, tolerance překlepu)
 * - Záložní ruční nahrání souboru POR (.xlsx, .xml, .csv, .json) přímo v prohlížeči
 */

import { getCzechNowStr, normalizeText } from './domain.js';
import { readZipEntries, readEntryAsText, getEntryCompressedSlice } from './xlsx-parser.js';

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

  // Závorky s balením nebo dodavatelem: (5L), (BAYER), (FMC), (AG Novachem), (Innvigo)
  s = s.replace(/\([^)]*\)/g, ' ');
  // Násobná balení: 4x5L, 12 x 1 l, 2*10kg
  s = s.replace(/\b\d+\s*[xX*×]\s*\d+(?:[.,]\d+)?\s*(?:l|litr(?:ů|y)?|kg|g|ml|ks)\b/gi, ' ');
  // Jednotlivá balení: 5L, 20 L, 10 KG, 1 L bal., 500ML, 250G
  s = s.replace(/\b\d+(?:[.,]\d+)?\s*(?:l|litr(?:ů|y)?|kg|g|ml)\b(?:\s*[-–]?\s*bal\.?)?/gi, ' ');
  // Obchodní a balicí přívlastky
  s = s.replace(/(?:^|\s)[-–]\s*(?:maxipack|multipack|pack|xxl|xl|akce|bal\.?|bal[ií][cč]ek)\b/gi, ' ');
  s = s.replace(/\b(?:bal\.?|bal[ií][cč]ek|kanystr|pytel|krabice|l[aá]hev|maxipack|multipack)\b/gi, ' ');
  // Osamocené velké L na konci (např. "RETAFOS PRIM L")
  s = s.replace(/\s+L\s*$/, ' ');
  // Koncové oddělovače
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

  // Ponech jen jednoznačné základní názvy (bez kolizí), aby nedocházelo k chybným shodám
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

  // 1. Shoda podle registračního čísla nebo ID položky (pokud je v kódu)
  const codeClean = normalizeText(productCode).replace(/\s+/g, '');
  if (codeClean) {
    const byReg = porIndex.byReg.get(codeClean);
    if (byReg) return byReg;
    const byId = porIndex.byId.get(String(productCode).trim());
    if (byId) return byId;
  }

  if (!productName) return null;

  // 2. Přesná shoda na očištěném názvu
  const cleaned = cleanBcProductName(productName);
  const norm = normalizeText(cleaned);
  if (norm) {
    const exact = porIndex.byNorm.get(norm);
    if (exact) return exact;
  }

  // 3. Kompaktní shoda bez mezer a interpunkce (např. "ACTELIC 50EC" ↔ "Actellic 50 EC")
  const comp = toCompact(cleaned);
  if (comp) {
    const compactHit = porIndex.byCompact.get(comp);
    if (compactHit) return compactHit;

    // 4. Tolerance trojitých písmen (např. "CYPERKILLL MAX" -> "Cyperkill Max")
    const dedup = dedupTripleChars(comp);
    const dedupHit = porIndex.byDedupCompact.get(dedup);
    if (dedupHit) return dedupHit;
    // Zkusit zredukovat zdvojená písmena u překlepů typu "cyperkilll" -> "cyperkill"
    const dedupSingle = comp.replace(/(.)\1{2,}/g, '$1');
    const dedupSingleHit = porIndex.byCompact.get(dedupSingle);
    if (dedupSingleHit) return dedupSingleHit;
  }

  // 5. Jednoznačná shoda po odstranění kódu formulace (EC/WG/WP/SC…)
  const base = stripTrailingFormulation(cleaned);
  if (base.length >= 4) {
    const baseHit = porIndex.byBase.get(base);
    if (baseHit) return baseHit;
  }

  // 6. Registrační číslo obsažené přímo v názvu (např. "4956-1")
  const regInName = String(productName).match(/\b(\d{4,5}-\d[A-Z]?)\b/i);
  if (regInName) {
    const regHit = porIndex.byReg.get(normalizeText(regInName[1]));
    if (regHit) return regHit;
  }

  return null;
}

/**
 * Vytvoří vyhledávací řetězec ze záznamu ÚKZÚZ (pro hledání podle účinné látky, reg. čísla, PHO, včel).
 */
export function buildPorSearchText(por) {
  if (!por) return '';
  const ulText = (por.ul || []).map((u) => `${u.n} ${u.c || ''} ${u.g || ''}`).join(' ');
  const groups = (por.groups || []).join(' ');
  const pho = por.pho?.restricted ? `pho omezeni ${por.pho.code} ${por.pho.text}` : '';
  const bees =
    por.bees?.level && por.bees.level !== 'ok'
      ? `vcely ${por.bees.code} ${por.bees.label}`
      : '';
  return normalizeText(
    `${por.name} ${por.reg || ''} ${por.status || ''} ${por.fn || ''} ${ulText} ${groups} ${pho} ${bees}`
  );
}

// ===========================================================================
// Záložní ruční nahrání souboru POR přímo v prohlížeči (.json / .xlsx / .xml / .csv)
// ===========================================================================

function cleanWs(val) {
  if (val === null || val === undefined) return '';
  return String(val).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
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
  return {
    code: c && c !== '-' && c !== '- -' ? c : 'Bez omezení',
    restricted,
    text: full || (c && c !== '-' && c !== '- -' ? c : 'Bez omezení v PHO'),
  };
}

function classifyBees(code, meaning, note) {
  const c = cleanWs(code);
  const full = joinMeaningNote(meaning, note);
  const cu = c.toUpperCase();
  const norm = normalizeText(`${c} ${full}`);
  let level = 'ok';
  let label = 'Bez označení (přijatelný pro včely)';
  if (cu === 'ZNV' || norm.includes('zvlast nebezpecny pro vcely')) {
    level = 'danger';
    label = 'ZNV — Zvlášť nebezpečný pro včely';
  } else if (cu === 'NV' || norm.includes('nebezpecny pro vcely')) {
    level = 'warn';
    label = 'NV — Nebezpečný pro včely';
  } else if (cu === 'DO' || norm.includes('cmelak') || norm.includes('opylovac') || norm.includes('sklenik')) {
    level = 'info';
    label = 'DO — Další omezení (opylovači)';
  }
  return {
    code: c && c !== '-' && c !== '- -' ? c : 'OK',
    level,
    label,
    text: full || label,
  };
}

const PHO_SEV = (p) => (!p ? 0 : p.restricted ? 2 : 1);
const BEE_SEV = (b) => (!b ? 0 : { ok: 1, info: 2, warn: 3, danger: 4 }[b.level] || 0);

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
      const uc = cleanWs(u.c);
      const ug = cleanWs(u.g);
      if (!un) continue;
      const k = `${un.toLowerCase()}|${uc.toLowerCase()}`;
      if (!seenUl.has(k)) {
        seenUl.add(k);
        const obj = { n: un };
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
    for (const alt of list.slice(1)) {
      if (PHO_SEV(alt.pho) > PHO_SEV(bestPho)) bestPho = alt.pho;
      if (BEE_SEV(alt.bees) > BEE_SEV(bestBees)) bestBees = alt.bees;
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
      beeRiskCount: products.filter((p) => p.bees?.level === 'warn' || p.bees?.level === 'danger').length,
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
  report(10, 'Rozbaluji strukturu POR (.xlsx)…');
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

  report(22, 'Načítám tabulku textů ÚKZÚZ…');
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
    for (const [k, v] of sheets.entries()) if (k.startsWith(prefix)) return entries.get(v);
    return null;
  };

  const shRozh = findSheet('rozhodnuti') || entries.get(Array.from(sheets.values())[0]);
  const shUdaje = findSheet('udaje');
  const shUl = findSheet('ucinne latky');

  const allowed = new Set(['Platné rozhodnutí', 'Do spotřebování zásob']);
  const decByKey = new Map();
  const decsById = new Map();
  const allowedIds = new Set();

  report(40, 'Zpracovávám list Rozhodnutí…');
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
    };
    decByKey.set(`${name}\x1f${decId}`, rec);
    if (decId) {
      if (!decsById.has(decId)) decsById.set(decId, []);
      decsById.get(decId).push(rec);
    }
  });

  if (shUdaje) {
    report(65, 'Zpracovávám omezení PHO a rizika pro včely…');
    await streamXlsxSheetRows(arrayBuffer, shUdaje, sharedStrings, (row) => {
      const decId = cleanWs(row['Id rozhodnutí']);
      if (!allowedIds.has(decId)) return;
      const u = normalizeText(row['Hodnocený údaj']);
      const isPho = u.includes('ochranna pasma vod');
      const isBees = u.includes('riziko pro vcely');
      if (!isPho && !isBees) return;
      const name = cleanWs(row['Obchodní název přípravku']);
      const exact = decByKey.get(`${name}\x1f${decId}`);
      const targets = exact ? [exact] : decsById.get(decId) || [];
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
    report(85, 'Zpracovávám účinné látky a chemické skupiny…');
    await streamXlsxSheetRows(arrayBuffer, shUl, sharedStrings, (row) => {
      const decId = cleanWs(row['Id rozhodnutí']);
      if (!allowedIds.has(decId)) return;
      const un = cleanWs(row['Název účinné látky']);
      if (!un) return;
      const qty = cleanWs(row['Množství']);
      const mj = cleanWs(row['Měrná jednotka']);
      const conc = qty ? `${qty} ${mj}`.trim() : mj;
      const group = cleanWs(row['Skupiny']);
      const name = cleanWs(row['Obchodní název přípravku']);
      const exact = decByKey.get(`${name}\x1f${decId}`);
      const targets = exact ? [exact] : decsById.get(decId) || [];
      for (const t of targets) t.ul.push({ n: un, c: conc, g: group });
    });
  }

  report(96, 'Sestavuji čistý registr ÚKZÚZ…');
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
        ul.push({ n: un, c: qty ? `${qty} ${mj}`.trim() : mj, g: groups.join(', ') });
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
