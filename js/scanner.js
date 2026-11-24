/**
 * Sdílený 2D skener šarží (QR, DataMatrix, Aztec, PDF417).
 * Záměrně vynechává 1D čárové kódy (EAN-13, Code 128, Code 39 aj.),
 * které bývají na krabicích hned vedle 2D kódu a při skenování matou.
 */

const TWO_D_FORMATS = ['qr_code', 'data_matrix', 'aztec', 'pdf417'];
const TWO_D_FORMAT_SET = new Set(TWO_D_FORMATS);

let activeStream = null;
let activeRaf = null;

export function isScannerSupported() {
  return typeof window !== 'undefined' && 'BarcodeDetector' in window && Boolean(navigator.mediaDevices?.getUserMedia);
}

/**
 * Z naskenovaného 2D kódu vytáhne číslo šarže.
 * Priorita:
 * 1. Shoda s aktivní šarží ze skladu (včetně varianty bez úvodních nul)
 * 2. GS1 čitelný formát se závorkami: (10)XXXXXX
 * 3. GS1 strojový DataMatrix / QR (AI 10)
 * 4. URL parametr v QR kódu (?lot=, ?batch=, ?sarze=, /10/)
 * 5. Surový očištěný text
 */
export function extractSearchTermFromScan(rawValue, items = []) {
  const raw = String(rawValue || '').trim();
  if (!raw) return { term: '', matchedType: null };

  const rawUpper = raw.toUpperCase();

  // 1. Přímá shoda s aktivní šarží ze skladu (funguje i pro QR s URL nebo dlouhý 2D kód)
  const uniqueLots = Array.from(
    new Set(
      items
        .map((i) => String(i.lot || '').trim())
        .filter((l) => l && l !== '-' && l.length >= 4)
    )
  ).sort((a, b) => b.length - a.length);

  for (const lot of uniqueLots) {
    const lotUp = lot.toUpperCase();
    if (rawUpper.includes(lotUp)) {
      return { term: lot, matchedType: 'šarže' };
    }
    const lotNoZeros = lotUp.replace(/^0+/, '');
    if (lotNoZeros.length >= 5 && rawUpper.includes(lotNoZeros)) {
      return { term: lot, matchedType: 'šarže' };
    }
  }

  // 2. GS1 čitelný formát se závorkami: např. (01)...(17)...(10)0029895964
  const parenLot = raw.match(/\(10\)([^\(\x1d\s]{3,24})/);
  if (parenLot && parenLot[1]) {
    return { term: parenLot[1].trim(), matchedType: 'GS1 šarže' };
  }

  // 3. GS1 strojový DataMatrix / QR (odstraň symbology ID ]d2, ]Q3, ]C1 a úvodní FNC1 \x1d)
  const gs = raw.replace(/^\][A-Za-z][0-9]/, '').replace(/^\x1d+/, '');
  if (/^(01\d{14}|02\d{14})/.test(gs)) {
    let pos = 0;
    const fixedAiLen = { '01': 14, '02': 14, '11': 6, '13': 6, '15': 6, '17': 6 };
    while (pos < gs.length) {
      if (gs[pos] === '\x1d') {
        pos++;
        continue;
      }
      const ai2 = gs.slice(pos, pos + 2);
      if (ai2 === '10') {
        const rest = gs.slice(pos + 2);
        const gsSep = rest.indexOf('\x1d');
        const lotVal = (gsSep >= 0 ? rest.slice(0, gsSep) : rest).trim();
        if (lotVal.length >= 3) {
          return { term: lotVal, matchedType: 'GS1 šarže' };
        }
        break;
      }
      if (fixedAiLen[ai2]) {
        pos += 2 + fixedAiLen[ai2];
      } else {
        const nextSep = gs.indexOf('\x1d', pos + 2);
        if (nextSep < 0) break;
        pos = nextSep + 1;
      }
    }
  }

  // 4. URL parametr v QR kódu (např. ?lot=... nebo ?batch=... nebo /10/...)
  const urlLot = raw.match(/(?:[?&](?:lot|batch|sarze)=|\/10\/)([^&#\/\s]{3,24})/i);
  if (urlLot && urlLot[1]) {
    return { term: decodeURIComponent(urlLot[1]).trim(), matchedType: 'QR šarže' };
  }

  return { term: raw.replace(/[\x00-\x1f]/g, '').trim(), matchedType: null };
}

/**
 * Otevře sdílený kamerový modal pouze pro 2D kódy (QR / DataMatrix).
 * 1D čárové kódy jsou vynechány.
 */
export async function openLotScanner({
  items = [],
  title = '📷 Skenovat šarži (QR / 2D kód)',
  hint = 'Namiř na QR nebo DataMatrix kód se šarží (1D čárové kódy se ignorují)…',
  onDetect,
}) {
  const modal = document.getElementById('scanner-modal');
  const titleEl = document.getElementById('scanner-title');
  const video = document.getElementById('scanner-video');
  const status = document.getElementById('scanner-status');
  const closeBtn = document.getElementById('scanner-close-btn');

  if (!modal || !video || !status || !closeBtn) return;

  const stopScanner = () => {
    if (activeRaf) cancelAnimationFrame(activeRaf);
    activeRaf = null;
    if (activeStream) {
      activeStream.getTracks().forEach((t) => t.stop());
      activeStream = null;
    }
    video.srcObject = null;
    modal.hidden = true;
  };

  // Pokud náhodou běží předchozí skener, ukonči ho
  stopScanner();

  if (titleEl) titleEl.textContent = title;
  modal.hidden = false;
  status.textContent = 'Spouštím zadní kameru…';

  closeBtn.onclick = stopScanner;
  modal.onclick = (e) => {
    if (e.target === modal) stopScanner();
  };

  try {
    activeStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });
    video.srcObject = activeStream;
    await video.play();
    status.textContent = hint;

    let detector;
    try {
      const supported =
        typeof window.BarcodeDetector.getSupportedFormats === 'function'
          ? await window.BarcodeDetector.getSupportedFormats()
          : TWO_D_FORMATS;
      const formats = TWO_D_FORMATS.filter((f) => supported.includes(f));
      if (!formats.length) {
        status.textContent = 'Tento prohlížeč nepodporuje čtení 2D kódů (QR / DataMatrix).';
        return;
      }
      detector = new window.BarcodeDetector({ formats });
    } catch {
      detector = new window.BarcodeDetector({ formats: TWO_D_FORMATS });
    }

    const tick = async () => {
      if (!activeStream) return;
      try {
        const codes = await detector.detect(video);
        const match2d = codes.find(
          (c) => c && c.rawValue && (!c.format || TWO_D_FORMAT_SET.has(String(c.format).toLowerCase()))
        );
        if (match2d) {
          const rawVal = match2d.rawValue;
          const extracted = extractSearchTermFromScan(rawVal, items);
          stopScanner();
          if (typeof onDetect === 'function') {
            onDetect({ ...extracted, rawValue: rawVal, format: match2d.format || '' });
          }
          return;
        }
      } catch {
        // ignore single frame decode error
      }
      activeRaf = requestAnimationFrame(tick);
    };
    activeRaf = requestAnimationFrame(tick);
  } catch {
    status.textContent = 'Nepodařilo se spustit kameru. Zkontroluj oprávnění prohlížeče.';
  }
}
