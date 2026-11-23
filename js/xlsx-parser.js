/**
 * Zero-dependency streaming XLSX parser pro exporty z Microsoft Dynamics 365 Business Central.
 * Běží kompletně v prohlížeči (i offline) pomocí nativního DecompressionStream API.
 * Zpracovává i 60+ MB rozbalený XML list po blocích s minimální spotřebou paměti.
 */

import { getCzechNowStr, getFyzickySklad, formatLocationPlain } from './domain.js';

const REQUIRED_COLUMNS = [
  'Číslo zboží',
  'Popis',
  'Kód kategorie zboží',
  'Kód lokace',
  'Číslo šarže',
  'Datum expirace',
  'Zůstatek (množství)',
  'Zúčtovací datum',
  'Otevřeno',
  'Prodejce Kód',
];

function isRowOpen(rawVal) {
  if (rawVal === null || rawVal === undefined) return false;
  const s = String(rawVal).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'ano' || parseNumber(s) === 1;
}

function decodeXmlEntities(str) {
  if (!str || !str.includes('&')) return str;
  return str.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (_, entity) => {
    if (entity === 'amp') return '&';
    if (entity === 'lt') return '<';
    if (entity === 'gt') return '>';
    if (entity === 'quot') return '"';
    if (entity === 'apos') return "'";
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      return String.fromCodePoint(parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith('#')) {
      return String.fromCodePoint(parseInt(entity.slice(1), 10));
    }
    return `&${entity};`;
  });
}

function excelSerialToIso(rawVal) {
  if (rawVal === null || rawVal === undefined) return null;
  const s = String(rawVal).trim();
  if (!s) return null;
  const num = Number(s);
  if (!Number.isNaN(num) && num > 0) {
    // Excel epoch: 1899-12-30 UTC
    const ms = Date.UTC(1899, 11, 30) + Math.floor(num) * 86400000;
    const d = new Date(ms);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  const czMatch = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (czMatch) {
    return `${czMatch[3]}-${czMatch[2].padStart(2, '0')}-${czMatch[1].padStart(2, '0')}`;
  }
  return null;
}

function parseNumber(rawVal) {
  if (rawVal === null || rawVal === undefined) return 0;
  const s = String(rawVal).trim().replace(',', '.');
  if (!s) return 0;
  const n = Number(s);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Přečte ZIP centrální adresář z ArrayBufferu.
 */
export function readZipEntries(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const len = bytes.length;

  // Hledání End of Central Directory (0x06054b50) od konce souboru
  const minOffset = Math.max(0, len - 65557);
  let eocdOffset = -1;
  for (let i = len - 22; i >= minOffset; i--) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x05 &&
      bytes[i + 3] === 0x06
    ) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error('Soubor není platný .xlsx (ZIP archiv nenalezen).');
  }

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);
  const decoder = new TextDecoder('utf-8');
  const entries = new Map();

  let pos = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) break;
    const method = view.getUint16(pos + 10, true);
    const compSize = view.getUint32(pos + 20, true);
    const uncompSize = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localHeaderOffset = view.getUint32(pos + 42, true);

    const name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
    entries.set(name, { name, method, compSize, uncompSize, localHeaderOffset });

    pos += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

export function getEntryCompressedSlice(buffer, entry) {
  const view = new DataView(buffer);
  const off = entry.localHeaderOffset;
  if (view.getUint32(off, true) !== 0x04034b50) {
    throw new Error(`Poškozený ZIP záznam: ${entry.name}`);
  }
  const nameLen = view.getUint16(off + 26, true);
  const extraLen = view.getUint16(off + 28, true);
  const dataStart = off + 30 + nameLen + extraLen;
  return new Uint8Array(buffer, dataStart, entry.compSize);
}

export async function readEntryAsText(buffer, entry) {
  const slice = getEntryCompressedSlice(buffer, entry);
  if (entry.method === 0) {
    return new TextDecoder('utf-8').decode(slice);
  }
  if (entry.method !== 8) {
    throw new Error(`Nepodporovaná komprese ZIP (metoda ${entry.method}).`);
  }
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Tento prohlížeč nepodporuje nativní rozbalení .xlsx (DecompressionStream). Použijte aktuální Chrome, Edge nebo Safari.');
  }
  const stream = new Blob([slice]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return await new Response(stream).text();
}

function resolveFirstSheetPath(entries, workbookXml, relsXml) {
  if (workbookXml && relsXml) {
    const sheetTags = workbookXml.match(/<(?:\w+:)?sheet\b[^>]*>/g) || [];
    let chosenRid = null;
    for (const tag of sheetTags) {
      const nameM = tag.match(/\bname="([^"]+)"/);
      const ridM = tag.match(/\br:id="([^"]+)"/);
      if (!ridM) continue;
      if (!chosenRid) chosenRid = ridM[1];
      const sheetName = nameM ? decodeXmlEntities(nameM[1]).trim().toLowerCase() : '';
      if (sheetName === 'položky zboží' || sheetName === 'polozky zbozi') {
        chosenRid = ridM[1];
        break;
      }
    }
    if (chosenRid) {
      const relRegex = /<Relationship\b[^>]*>/g;
      let m;
      while ((m = relRegex.exec(relsXml)) !== null) {
        const tag = m[0];
        const idM = tag.match(/\bId="([^"]+)"/);
        if (idM && idM[1] === chosenRid) {
          const targetM = tag.match(/\bTarget="([^"]+)"/);
          if (targetM) {
            let target = targetM[1].replace(/^\/+/, '');
            if (!target.startsWith('xl/')) target = `xl/${target}`;
            if (entries.has(target)) return target;
          }
        }
      }
    }
  }
  for (const name of Array.from(entries.keys()).sort()) {
    if (name.startsWith('xl/worksheets/sheet') && name.endsWith('.xml')) {
      return name;
    }
  }
  throw new Error('V souboru .xlsx nebyl nalezen žádný list (worksheet).');
}

function parseSharedStrings(xmlText) {
  const strings = [];
  const siRegex = /<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g;
  const tRegex = /<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g;
  let siMatch;
  while ((siMatch = siRegex.exec(xmlText)) !== null) {
    let text = '';
    tRegex.lastIndex = 0;
    let tMatch;
    while ((tMatch = tRegex.exec(siMatch[1])) !== null) {
      text += decodeXmlEntities(tMatch[1]);
    }
    strings.push(text);
  }
  return strings;
}

/**
 * Rychle extrahuje buňky z jednoho <row>...</row> úseku.
 * Pokud je předán `wantedCols`, přeskočí nepotřebné sloupce pro maximální rychlost.
 */
function parseRowCells(rowInnerXml, sharedStrings, wantedCols = null) {
  const values = Object.create(null);
  const cellRegex = /<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;
  let m;
  while ((m = cellRegex.exec(rowInnerXml)) !== null) {
    const attrs = m[1];
    const body = m[2];
    if (!body) continue;

    const rMatch = attrs.match(/\br="([A-Z]+)\d+"/);
    if (!rMatch) continue;
    const col = rMatch[1];
    if (wantedCols && !wantedCols.has(col)) continue;

    const tMatch = attrs.match(/\bt="([^"]+)"/);
    const type = tMatch ? tMatch[1] : '';

    if (type === 'inlineStr') {
      let txt = '';
      const tRegex = /<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g;
      let tm;
      while ((tm = tRegex.exec(body)) !== null) {
        txt += decodeXmlEntities(tm[1]);
      }
      values[col] = txt;
    } else {
      const vMatch = body.match(/<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/);
      if (!vMatch) continue;
      if (type === 's') {
        const idx = Number(vMatch[1]);
        values[col] = sharedStrings[idx] ?? '';
      } else {
        values[col] = decodeXmlEntities(vMatch[1]);
      }
    }
  }
  return values;
}

/**
 * Parsuje soubor .xlsx (ArrayBuffer) a vrátí kompaktní strukturu `{ meta, items }`
 * totožnou s výstupem `scripts/build-stock-json.py`.
 */
export async function parseBusinessCentralXlsx(arrayBuffer, fileName = 'sklad.xlsx', onProgress = null) {
  const report = (pct, text) => {
    if (typeof onProgress === 'function') onProgress(pct, text);
  };

  report(5, 'Čtu strukturu Excel souboru…');
  const entries = readZipEntries(arrayBuffer);

  const wbEntry = entries.get('xl/workbook.xml');
  const relsEntry = entries.get('xl/_rels/workbook.xml.rels');
  const wbXml = wbEntry ? await readEntryAsText(arrayBuffer, wbEntry) : null;
  const relsXml = relsEntry ? await readEntryAsText(arrayBuffer, relsEntry) : null;
  const sheetPath = resolveFirstSheetPath(entries, wbXml, relsXml);

  let sharedStrings = [];
  const ssEntry = entries.get('xl/sharedStrings.xml');
  if (ssEntry) {
    report(12, 'Načítám tabulku textů…');
    const ssXml = await readEntryAsText(arrayBuffer, ssEntry);
    sharedStrings = parseSharedStrings(ssXml);
  }

  const sheetEntry = entries.get(sheetPath);
  const compSlice = getEntryCompressedSlice(arrayBuffer, sheetEntry);
  const totalUncomp = sheetEntry.uncompSize || compSlice.byteLength * 10;

  let readableStream;
  if (sheetEntry.method === 0) {
    readableStream = new Blob([compSlice]).stream();
  } else if (sheetEntry.method === 8) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('Prohlížeč nepodporuje DecompressionStream pro rozbalení .xlsx.');
    }
    readableStream = new Blob([compSlice]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  } else {
    throw new Error(`Nepodporovaná komprese ZIP (${sheetEntry.method}).`);
  }

  report(18, 'Zpracovávám skladové položky…');

  const reader = readableStream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let bytesRead = 0;
  let lastProgressPct = 18;

  let colMap = null;
  let wantedCols = null;
  let totalRows = 0;

  const lastReceipt = new Map();
  const grouped = new Map();

  // Regex pro hledání kompletních řádků (bez ohledu na XML namespace prefix)
  const rowOpenRe = /<(?:\w+:)?row\b[^>]*>/;
  const rowCloseRe = /<\/(?:\w+:)?row>/;

  const processRow = (rowOpenTag, rowInner) => {
    const rAttr = rowOpenTag.match(/\br="(\d+)"/);
    const rowNum = rAttr ? Number(rAttr[1]) : 0;

    if (!colMap && (rowNum === 1 || totalRows === 0)) {
      const headers = parseRowCells(rowInner, sharedStrings, null);
      const byName = Object.create(null);
      for (const [col, val] of Object.entries(headers)) {
        const clean = String(val || '').trim();
        if (clean) byName[clean] = col;
      }
      const missing = REQUIRED_COLUMNS.filter((c) => !byName[c]);
      if (missing.length > 0) {
        throw new Error(`V Excelu chybí povinné sloupce: ${missing.join(', ')}`);
      }
      colMap = {
        kod: byName['Číslo zboží'],
        popis: byName['Popis'],
        kat: byName['Kód kategorie zboží'],
        lokace: byName['Kód lokace'],
        sarze: byName['Číslo šarže'],
        exp: byName['Datum expirace'],
        zustatek: byName['Zůstatek (množství)'],
        zuct: byName['Zúčtovací datum'],
        otevreno: byName['Otevřeno'],
        prodejce: byName['Prodejce Kód'],
      };
      wantedCols = new Set(Object.values(colMap));
      return;
    }

    if (!colMap) return;
    totalRows += 1;

    const vals = parseRowCells(rowInner, sharedStrings, wantedCols);

    // Filtruj POUZE otevřené řádky (Otevřeno == 1) a zároveň Zůstatek (množství) > 0
    if (!isRowOpen(vals[colMap.otevreno])) return;
    const zustatek = parseNumber(vals[colMap.zustatek]);
    if (zustatek <= 0) return;

    const kod = String(vals[colMap.kod] || '').trim();
    const lokace = String(vals[colMap.lokace] || '').trim();
    const sarze = String(vals[colMap.sarze] || '').trim() || '-';
    const expIso = excelSerialToIso(vals[colMap.exp]);
    const zuctIso = excelSerialToIso(vals[colMap.zuct]);

    if (zuctIso) {
      const rKey = `${kod}\x1f${lokace}\x1f${sarze}`;
      const prev = lastReceipt.get(rKey);
      if (!prev || zuctIso > prev) lastReceipt.set(rKey, zuctIso);
    }

    // Seskupuj zásoby výhradně podle Číslo zboží + Kód lokace + Číslo šarže + Datum expirace
    // a sčítej VÝHRADNĚ sloupec Zůstatek (množství)
    const gKey = `${kod}\x1f${lokace}\x1f${sarze}\x1f${expIso || ''}`;
    const existing = grouped.get(gKey);
    if (existing) {
      existing.q += zustatek;
    } else {
      const popis = String(vals[colMap.popis] || '').trim();
      const kat = String(vals[colMap.kat] || '').trim();
      const prodejce = String(vals[colMap.prodejce] || '').trim();
      const fyzSklad = getFyzickySklad(lokace, prodejce);
      const lokNazev = formatLocationPlain(lokace, prodejce);

      grouped.set(gKey, {
        c: kod,
        n: popis,
        cat: kat,
        loc: lokace,
        wh: fyzSklad,
        ln: lokNazev,
        lot: sarze,
        exp: expIso,
        q: zustatek,
      });
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (value) {
      bytesRead += value.byteLength;
      buffer += decoder.decode(value, { stream: true });
    }
    if (done) {
      buffer += decoder.decode();
    }

    // Zpracuj všechny kompletní řádky v bufferu
    while (true) {
      const openM = rowOpenRe.exec(buffer);
      if (!openM) {
        // Ponech jen krátký konec bufferu pro případ rozděleného tagu
        if (buffer.length > 64) buffer = buffer.slice(-64);
        break;
      }
      const startAfterOpen = openM.index + openM[0].length;
      const tail = buffer.slice(startAfterOpen);
      const closeM = rowCloseRe.exec(tail);
      if (!closeM) {
        // Řádek ještě neskončil — ořízni vše před openM a čekej na další chunk
        if (openM.index > 0) buffer = buffer.slice(openM.index);
        break;
      }
      const inner = tail.slice(0, closeM.index);
      processRow(openM[0], inner);
      buffer = tail.slice(closeM.index + closeM[0].length);
    }

    const pct = Math.min(92, 18 + Math.floor((bytesRead / totalUncomp) * 74));
    if (pct >= lastProgressPct + 4) {
      lastProgressPct = pct;
      report(pct, `Zpracováno ${totalRows.toLocaleString('cs-CZ')} řádků…`);
      // Povolit UI překreslení během zpracování na mobilu
      await new Promise((r) => setTimeout(r, 0));
    }

    if (done) break;
  }

  report(96, 'Sestavuji přehled aktivních šarží…');

  const items = [];
  const productCodes = new Set();
  for (const rec of grouped.values()) {
    const q = Math.round(rec.q * 10000) / 10000;
    if (q <= 0) continue;
    productCodes.add(rec.c);
    items.push({
      ...rec,
      q,
      rec: lastReceipt.get(`${rec.c}\x1f${rec.loc}\x1f${rec.lot}`) || null,
    });
  }

  items.sort((a, b) => {
    const na = a.n.toLowerCase();
    const nb = b.n.toLowerCase();
    if (na !== nb) return na < nb ? -1 : 1;
    if (a.c !== b.c) return a.c < b.c ? -1 : 1;
    const ea = a.exp || '9999-99-99';
    const eb = b.exp || '9999-99-99';
    if (ea !== eb) return ea < eb ? -1 : 1;
    return b.q - a.q;
  });

  report(100, 'Hotovo!');

  return {
    meta: {
      updatedAt: getCzechNowStr(),
      sourceFile: fileName,
      sourceSizeBytes: arrayBuffer.byteLength,
      ledgerRows: totalRows,
      batchCount: items.length,
      productCount: productCodes.size,
      isLocalOverride: true,
    },
    items,
  };
}
