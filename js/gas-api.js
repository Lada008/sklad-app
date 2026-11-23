/**
 * Klient pro komunikaci s nasazeným Google Apps Script Web App backendem.
 * - Řeší CORS v prohlížeči: všechny POST požadavky odesílá s hlavičkou
 *   `Content-Type: text/plain;charset=utf-8` a `redirect: "follow"`, aby prohlížeč
 *   neposílal preflight OPTIONS dotaz.
 * - Normalizuje data vrácená z Google Tabulky (Sklad, Zakaznici, Objednavky).
 * - Obsahuje parsery pro hromadný import zákazníků a poznámek k hnojivům z Excelu (.xlsx / .csv).
 */

import { formatLocationPlain, getFyzickySklad, normalizeText } from './domain.js';
import { cleanBcProductName } from './ukzuz.js';
import {
  getEntryCompressedSlice,
  readEntryAsText,
  readZipEntries,
} from './xlsx-parser.js';

export const DEFAULT_GAS_URL =
  'https://script.google.com/macros/s/AKfycbxePeToJLxZwQrNZ8ceiZHF1IMVfa8EfUoy-gTqWNqaVihNySAiP9hX2d9P3o5Lj5FJew/exec';

export const DEFAULT_NOTIFY_EMAIL = 'ladislav.penaz@lukrom.cz';

/**
 * Převede datum vrácené z Google Sheets (např. "2028-01-31T23:00:00.000Z" v CET/CEST)
 * na čisté lokální ISO datum "YYYY-MM-DD" v pásmu Europe/Prague.
 */
export function normalizeSheetDateIso(val) {
  if (val === null || val === undefined || val === '') return null;
  const s = String(val).trim();
  if (!s) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) {
      try {
        const parts = new Intl.DateTimeFormat('cs-CZ', {
          timeZone: 'Europe/Prague',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).formatToParts(d);
        const get = (t) => parts.find((p) => p.type === t)?.value || '';
        return `${get('year')}-${get('month')}-${get('day')}`;
      } catch {
        return s.slice(0, 10);
      }
    }
    return s.slice(0, 10);
  }

  const mCz = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (mCz) {
    return `${mCz[3]}-${mCz[2].padStart(2, '0')}-${mCz[1].padStart(2, '0')}`;
  }
  return s;
}

/**
 * Formátuje časové razítko objednávky z Google Sheets do čitelného českého formátu.
 */
export function formatSheetDateTimeCz(val) {
  if (!val) return '—';
  const s = String(val).trim();
  if (/^\d{2}\.\d{2}\.\d{4}/.test(s)) return s;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    try {
      const parts = new Intl.DateTimeFormat('cs-CZ', {
        timeZone: 'Europe/Prague',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).formatToParts(d);
      const get = (t) => parts.find((p) => p.type === t)?.value || '';
      return `${get('day')}.${get('month')}.${get('year')} ${get('hour')}:${get('minute')}`;
    } catch {
      return s;
    }
  }
  return s;
}

/**
 * Normalizuje položky skladu vrácené z Google Apps Scriptu do interního formátu aplikace.
 */
export function normalizeGasStockItems(rawSklad = []) {
  if (!Array.isArray(rawSklad)) return [];
  const out = [];
  for (const r of rawSklad) {
    if (!r || typeof r !== 'object') continue;
    const c = String(r.c ?? r['Číslo zboží'] ?? '').trim();
    const n = String(r.n ?? r['Popis'] ?? '').trim();
    const q = Number(String(r.q ?? r['Zůstatek (množství)'] ?? 0).replace(',', '.'));
    if (!n || Number.isNaN(q) || q <= 0) continue;

    const cat = String(r.cat ?? r['Kód kategorie zboží'] ?? '').trim();
    const loc = String(r.loc ?? r['Kód lokace'] ?? '').trim();
    const prod = String(r.prodejce ?? r['Prodejce Kód'] ?? '').trim();
    const wh = String(r.wh || getFyzickySklad(loc, prod)).trim();
    const ln = String(r.ln || formatLocationPlain(loc, prod)).trim();
    const lotRaw = r.lot ?? r['Číslo šarže'];
    const lot = lotRaw !== null && lotRaw !== undefined && String(lotRaw).trim() !== ''
      ? String(lotRaw).trim()
      : '-';

    out.push({
      c,
      n,
      cat,
      loc,
      wh,
      ln,
      lot,
      exp: normalizeSheetDateIso(r.exp ?? r['Datum expirace']),
      q: Math.round(q * 10000) / 10000,
      rec: normalizeSheetDateIso(r.rec ?? r['Datum posledního příjmu']),
    });
  }
  return out;
}

function parseLooseNumber(val) {
  if (val === null || val === undefined || val === '') return 0;
  if (typeof val === 'number') return Number.isNaN(val) ? 0 : val;
  const cleaned = String(val)
    .replace(/\s+/g, '')
    .replace(/\u00a0/g, '')
    .replace(',', '.')
    .replace(/[^0-9.-]/g, '');
  const n = Number(cleaned);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Normalizuje seznam zákazníků z listu `Zakaznici`.
 * Funguje jak při plných sloupcích z Business Central (`Číslo`, `Název`, `IČ`, `DIČ`,
 * `Telefonní číslo`, `Kontakt`, `Kód lokace`, `Zůstatek po splatnosti (LCY)`, `Obrat`),
 * tak i v případě, že jsou v tabulce vyplněny jen `Číslo` a `Název` nebo pouze `Název`.
 * Zachovává původní pořadí řádků jako fallback řazení podle obratu.
 */
export function normalizeCustomers(rawCustomers = []) {
  if (!Array.isArray(rawCustomers)) return [];

  const getField = (obj, candidates) => {
    for (const k of candidates) {
      if (obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== '') {
        return obj[k];
      }
    }
    const normMap = Object.create(null);
    for (const [rk, rv] of Object.entries(obj)) {
      normMap[normalizeText(rk)] = rv;
    }
    for (const k of candidates) {
      const nk = normalizeText(k);
      if (normMap[nk] !== undefined && normMap[nk] !== null && String(normMap[nk]).trim() !== '') {
        return normMap[nk];
      }
    }
    return '';
  };

  const list = [];
  rawCustomers.forEach((raw, idx) => {
    if (!raw || typeof raw !== 'object') return;
    const nazev = String(
      getField(raw, ['Název', 'Nazev', 'Name', 'Zákazník', 'Zakaznik', 'Odběratel'])
    ).trim();
    const cislo = String(
      getField(raw, ['Číslo', 'Cislo', 'No.', 'Kód', 'Kod', 'ID'])
    ).trim();
    if (!nazev && !cislo) return;

    const ic = String(getField(raw, ['IČ', 'IC', 'IČO', 'ICO']) || cislo).trim();
    const dic = String(getField(raw, ['DIČ', 'DIC'])).trim();
    const telefon = String(
      getField(raw, ['Telefonní číslo', 'Telefonni cislo', 'Telefon', 'Mobil', 'Phone'])
    ).trim();
    const kontaktOsoba = String(
      getField(raw, ['Kontakt', 'Kontaktní osoba', 'Kontaktni osoba', 'Email', 'E-mail'])
    ).trim();
    const lokace = String(
      getField(raw, ['Kód lokace', 'Kod lokace', 'Lokace', 'Sklad', 'Středisko'])
    ).trim();
    const poSplatnosti = parseLooseNumber(
      getField(raw, [
        'Zůstatek po splatnosti (LCY)',
        'Zustatek po splatnosti (LCY)',
        'Zůstatek po splatnosti',
        'Po splatnosti',
        'Dluh',
      ])
    );
    const obrat = parseLooseNumber(
      getField(raw, [
        'Obrat',
        'Obrat (LCY)',
        'Prodej (LCY)',
        'Částka prodeje',
        'Zůstatek (LCY)',
      ])
    );

    const kontaktParts = [kontaktOsoba, telefon].filter(Boolean);
    const kontaktCombined = kontaktParts.join(' · ');

    list.push({
      rowIndex: idx,
      cislo,
      nazev: nazev || cislo,
      ic,
      dic,
      telefon,
      kontakt: kontaktCombined,
      kontaktOsoba,
      lokace,
      poSplatnosti,
      obrat,
      _search: normalizeText(`${nazev} ${cislo} ${ic} ${dic} ${kontaktCombined} ${lokace}`),
    });
  });

  // Řazení: nejvyšší obrat nahoře; pokud obrat není zadán (0), zachovej pořadí v tabulce Zakaznici (kde jsou odběratelé seřazeni dle obratu)
  list.sort((a, b) => {
    if (b.obrat !== a.obrat) return b.obrat - a.obrat;
    return a.rowIndex - b.rowIndex;
  });

  return list;
}

/**
 * Normalizuje seznam objednávek vrácený z Google Apps Scriptu.
 */
export function normalizeOrders(rawOrders = []) {
  if (!Array.isArray(rawOrders)) return [];
  const out = [];
  for (const r of rawOrders) {
    if (!r || typeof r !== 'object') continue;
    const id = String(r.ID_objednavky ?? r.order_id ?? r.id ?? '').trim();
    if (!id) continue;

    let items = [];
    if (Array.isArray(r.items)) {
      items = r.items;
    } else if (r.Polozky_JSON) {
      try {
        const parsed = JSON.parse(r.Polozky_JSON);
        if (Array.isArray(parsed)) items = parsed;
      } catch {
        // ignore invalid JSON
      }
    }

    out.push({
      id,
      datumZadani: formatSheetDateTimeCz(r.Datum_zadani ?? r.created_at),
      stav: String(r.Stav ?? r.stav ?? 'Nová').trim() || 'Nová',
      obchodnik: String(r.Obchodnik ?? r.obchodnik ?? '').trim(),
      zakaznikCislo: String(r.Zakaznik_cislo ?? r.zakaznik_cislo ?? '').trim(),
      zakaznikNazev: String(r.Zakaznik_nazev ?? r.zakaznik_nazev ?? '').trim(),
      zakaznikIc: String(r.Zakaznik_IC ?? r.zakaznik_ic ?? '').trim(),
      zakaznikKontakt: String(r.Zakaznik_kontakt ?? r.zakaznik_kontakt ?? '').trim(),
      lokace: String(r.Lokace ?? r.lokace ?? '').trim(),
      terminDodani: normalizeSheetDateIso(r.Termin_dodani ?? r.termin_dodani) || String(r.Termin_dodani ?? '').trim(),
      polozkyPrehled: String(r.Polozky_prehled ?? '').trim(),
      poznamka: String(r.Poznamka ?? r.poznamka ?? '').trim(),
      sarze: String(r.Vychystane_sarze ?? r.sarze ?? '').trim(),
      items,
    });
  }
  return out;
}

/**
 * Normalizuje záznamy inventury vrácené z Google Apps Scriptu (list `Inventura`).
 */
export function normalizeInventura(rawInventura = []) {
  if (!Array.isArray(rawInventura)) return [];
  const out = [];
  for (const r of rawInventura) {
    if (!r || typeof r !== 'object') continue;
    const cislo_zbozi = String(
      r.cislo_zbozi ?? r['Číslo zboží'] ?? r['Kód zboží'] ?? r.code ?? r.c ?? ''
    ).trim();
    const nazev = String(
      r.nazev ?? r['Název'] ?? r['Popis'] ?? r.name ?? r.n ?? ''
    ).trim();
    if (!cislo_zbozi && !nazev) continue;

    const lokace = String(
      r.lokace ?? r['Lokace'] ?? r['Kód lokace'] ?? r.loc ?? ''
    ).trim();
    const sarzeRaw = r.sarze ?? r['Šarže'] ?? r['Číslo šarže'] ?? r.lot;
    const sarze = sarzeRaw !== null && sarzeRaw !== undefined && String(sarzeRaw).trim() !== ''
      ? String(sarzeRaw).trim()
      : '-';
    const expRaw = r.expirace ?? r['Expirace'] ?? r['Datum expirace'] ?? r.exp ?? '';
    const expirace = normalizeSheetDateIso(expRaw) || String(expRaw || '').trim();
    const stav_bc = parseLooseNumber(r.stav_bc ?? r['Stav BC'] ?? r['Systém'] ?? r.system ?? 0);
    const skutecny_stav = parseLooseNumber(
      r.skutecny_stav ?? r['Skutečný stav'] ?? r['Fyzicky'] ?? r.actual ?? 0
    );
    const rozdilRaw = r.rozdil ?? r['Rozdíl'] ?? r.diff;
    const rozdil =
      rozdilRaw !== undefined && rozdilRaw !== null && String(rozdilRaw).trim() !== ''
        ? parseLooseNumber(rozdilRaw)
        : Math.round((skutecny_stav - stav_bc) * 1000) / 1000;
    const kartony_text = String(
      r.kartony_text ?? r['Kartony'] ?? r['Kartony / balení'] ?? r.kartony ?? ''
    ).trim();
    const poznamka = String(
      r.poznamka ?? r['Poznámka'] ?? r.note ?? ''
    ).trim();
    const cas = formatSheetDateTimeCz(
      r.datum ?? r.cas ?? r.timestamp ?? r['Datum'] ?? r['Čas'] ?? r.time ?? ''
    );

    out.push({
      cislo_zbozi,
      nazev,
      lokace,
      sarze,
      expirace,
      stav_bc: Math.round(stav_bc * 1000) / 1000,
      skutecny_stav: Math.round(skutecny_stav * 1000) / 1000,
      rozdil: Math.round(rozdil * 1000) / 1000,
      kartony_text,
      poznamka,
      cas,
      synced: true,
    });
  }
  return out;
}

function parseGasJsonResponse(rawText, contextLabel) {
  const trimmed = String(rawText || '').trim();
  if (!trimmed) {
    throw new Error(`Prázdná odpověď z Google Apps Scriptu (${contextLabel}).`);
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const snippet = trimmed.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
    throw new Error(`Neplatná JSON odpověď z Google Apps Scriptu (${contextLabel}): ${snippet}`);
  }
}

/**
 * Zavolá GET na Google Apps Script Web App a vrátí `{ lastSkladUpdate, sklad, zakaznici, objednavky, inventura }`.
 */
export async function gasGetAll(gasUrl = DEFAULT_GAS_URL) {
  const url = String(gasUrl || DEFAULT_GAS_URL).trim();
  const sep = url.includes('?') ? '&' : '?';
  const res = await fetch(`${url}${sep}_t=${Date.now()}`, {
    method: 'GET',
    redirect: 'follow',
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} při načítání z Google Apps Scriptu`);
  }
  const data = parseGasJsonResponse(await res.text(), 'GET');
  if (data.status && data.status !== 'ok') {
    throw new Error(data.message || 'Google Apps Script vrátil chybu.');
  }

  return {
    lastSkladUpdate: data.last_sklad_update || null,
    sklad: normalizeGasStockItems(data.sklad || []),
    zakaznici: normalizeCustomers(data.zakaznici || []),
    objednavky: normalizeOrders(data.objednavky || []),
    inventura: normalizeInventura(data.inventura || []),
  };
}

/**
 * Zavolá POST na Google Apps Script Web App s `Content-Type: text/plain;charset=utf-8`
 * a `redirect: "follow"` (bez CORS preflight OPTIONS dotazu).
 */
export async function gasPostAction(payload, gasUrl = DEFAULT_GAS_URL) {
  const url = String(gasUrl || DEFAULT_GAS_URL).trim();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain;charset=utf-8',
    },
    body: JSON.stringify(payload),
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} při odesílání do Google Apps Scriptu`);
  }
  const data = parseGasJsonResponse(await res.text(), `POST ${payload?.action || ''}`);
  if (data.status && data.status !== 'ok') {
    throw new Error(data.message || 'Chyba při zpracování v Google Apps Scriptu.');
  }
  return data;
}

export async function gasUpdateSklad(items, gasUrl = DEFAULT_GAS_URL) {
  // Odesílej pouze kompaktní sloučené skladové řádky (nikdy interní vyhledávací/ÚKZÚZ pole)
  const cleanItems = (items || []).map((i) => ({
    c: i.c || '',
    n: i.n || '',
    cat: i.cat || '',
    loc: i.loc || '',
    wh: i.wh || '',
    ln: i.ln || '',
    lot: i.lot || '-',
    exp: i.exp || null,
    q: Number(i.q) || 0,
    rec: i.rec || null,
  }));
  return await gasPostAction({ action: 'update_sklad', items: cleanItems }, gasUrl);
}

export async function gasSaveInventura(records, gasUrl = DEFAULT_GAS_URL) {
  return await gasPostAction({ action: 'save_inventura', records }, gasUrl);
}

export async function gasUpdateZakaznici(customers, gasUrl = DEFAULT_GAS_URL) {
  return await gasPostAction({ action: 'update_zakaznici', customers }, gasUrl);
}

export async function gasCreateOrder(order, notifyEmail = DEFAULT_NOTIFY_EMAIL, gasUrl = DEFAULT_GAS_URL) {
  return await gasPostAction(
    {
      action: 'new_order',
      notify_email: String(notifyEmail || DEFAULT_NOTIFY_EMAIL).trim(),
      order,
    },
    gasUrl
  );
}

export async function gasUpdateOrderStatus(orderId, stav, sarze = '', gasUrl = DEFAULT_GAS_URL) {
  return await gasPostAction(
    {
      action: 'update_order_status',
      order_id: orderId,
      stav,
      sarze,
    },
    gasUrl
  );
}

/**
 * Vytvoří URL pro přímé vyhledání očištěného názvu přípravku nebo hnojiva na Agromanuál.cz.
 */
export function buildAgromanualUrl(rawProductName, porName = null) {
  const baseName = porName ? String(porName).trim() : cleanBcProductName(rawProductName);
  const query = baseName || String(rawProductName || '').trim();
  return `https://www.agromanual.cz/cz/hledani?hledej-slovo_1=${encodeURIComponent(query)}`;
}

// ===========================================================================
// Obecný parser tabulky (.xlsx / .csv) pro import Zákazníků a Poznámek k hnojivům
// ===========================================================================

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
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

/**
 * Načte libovolný první list z .xlsx nebo .csv souboru jako pole objektů `{ [hlavicka]: hodnota }`.
 */
export async function parseGenericTableFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();

  if (ext === 'csv') {
    const text = (await file.text()).replace(/^\uFEFF/, '');
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return [];
    const delim = lines[0].includes(';') ? ';' : lines[0].includes('\t') ? '\t' : ',';
    const headers = parseCsvLine(lines[0], delim);
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const vals = parseCsvLine(lines[i], delim);
      const obj = Object.create(null);
      let hasVal = false;
      headers.forEach((h, idx) => {
        if (h && vals[idx] !== undefined && vals[idx] !== '') {
          obj[h] = vals[idx];
          hasVal = true;
        }
      });
      if (hasVal) rows.push(obj);
    }
    return rows;
  }

  if (ext !== 'xlsx') {
    throw new Error('Podporované formáty jsou .xlsx nebo .csv');
  }

  const ab = await file.arrayBuffer();
  const entries = readZipEntries(ab);

  const sharedStrings = [];
  const ssEntry = entries.get('xl/sharedStrings.xml');
  if (ssEntry) {
    const ssXml = await readEntryAsText(ab, ssEntry);
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

  let sheetEntry = null;
  for (const name of Array.from(entries.keys()).sort()) {
    if (name.startsWith('xl/worksheets/sheet') && name.endsWith('.xml')) {
      sheetEntry = entries.get(name);
      break;
    }
  }
  if (!sheetEntry) throw new Error('V souboru .xlsx nebyl nalezen žádný list.');

  const slice = getEntryCompressedSlice(ab, sheetEntry);
  const stream =
    sheetEntry.method === 0
      ? new Blob([slice]).stream()
      : new Blob([slice]).stream().pipeThrough(new DecompressionStream('deflate-raw'));

  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let headers = null;
  const rows = [];
  const rowOpenRe = /<(?:\w+:)?row\b[^>]*>/;
  const rowCloseRe = /<\/(?:\w+:)?row>/;
  const cellRe = /<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;

  const processRow = (inner) => {
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
        raw[col] = txt.trim();
      } else {
        const vM = body.match(/<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/);
        if (!vM) continue;
        const val = type === 's' ? (sharedStrings[Number(vM[1])] ?? '') : decodeXmlEntities(vM[1]);
        raw[col] = String(val).trim();
      }
    }
    if (!headers) {
      if (Object.keys(raw).length === 0) return;
      headers = raw;
      return;
    }
    const obj = Object.create(null);
    let hasVal = false;
    for (const [col, hName] of Object.entries(headers)) {
      if (hName && raw[col] !== undefined && raw[col] !== '') {
        obj[hName] = raw[col];
        hasVal = true;
      }
    }
    if (hasVal) rows.push(obj);
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
      processRow(tail.slice(0, c.index));
      buf = tail.slice(c.index + c[0].length);
    }
    if (done) break;
  }

  return rows;
}
