// Texterkennung (Deutsch) direkt auf dem Gerät mit Tesseract. Die Dateien liegen in ocr/ und werden erst beim ersten Scan geladen
// (rund 5 MB, danach auch offline). Es verlässt nichts das Gerät.

let loading = null;
let worker = null;

function loadScript(src) {
  return new Promise((res, rej) => {
    if (window.Tesseract) return res();
    const s = document.createElement('script');
    s.src = src; s.onload = () => res(); s.onerror = () => rej(new Error('Die Texterkennung konnte nicht geladen werden.'));
    document.head.append(s);
  });
}

let onStatus = null;
async function getWorker() {
  if (worker) return worker;
  if (!loading) {
    loading = (async () => {
      await loadScript('./ocr/tesseract.min.js');
      const base = new URL('./ocr/', location.href).href;
      worker = await window.Tesseract.createWorker('deu', 1, {
        workerPath: base + 'worker.min.js', corePath: base, langPath: base + 'lang', workerBlobURL: false, gzip: true,
        logger: (m) => onStatus && onStatus(m),
      });
      return worker;
    })().catch((e) => { loading = null; throw e; });
  }
  return loading;
}

/** Leinwand lesen. Liefert { text, words: [{ text, x0, y0, x1, y1 }] } in Bildpunkten. */
export async function recognize(canvas, status) {
  onStatus = status || null;
  const w = await getWorker();
  const { data } = await w.recognize(canvas, {}, { text: true, blocks: true, tsv: true });
  let words = [];
  const collect = (blocks) => {
    for (const b of blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) for (const wd of l.words || []) {
      if (wd.text && wd.text.trim()) words.push({ text: wd.text, x0: wd.bbox.x0, y0: wd.bbox.y0, x1: wd.bbox.x1, y1: wd.bbox.y1 });
    }
  };
  if (data.words?.length) words = data.words.filter((x) => x.text?.trim()).map((x) => ({ text: x.text, x0: x.bbox.x0, y0: x.bbox.y0, x1: x.bbox.x1, y1: x.bbox.y1 }));
  else collect(data.blocks);
  if (!words.length && data.tsv) {
    for (const line of data.tsv.split('\n')) {
      const c = line.split('\t');
      if (c[0] === '5' && c[11]?.trim()) { const x = +c[6], y = +c[7]; words.push({ text: c[11], x0: x, y0: y, x1: x + +c[8], y1: y + +c[9] }); }
    }
  }
  return { text: (data.text || '').trim(), words };
}

export async function stopOcr() {
  const w = worker; worker = null; loading = null;
  if (w) { try { await w.terminate(); } catch { /* egal */ } }
}
