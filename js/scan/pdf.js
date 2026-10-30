// Kleiner PDF-Schreiber: je Seite ein JPEG-Bild, darüber (unsichtbar) der erkannte Text, damit man im PDF suchen und markieren kann.

const enc = new TextEncoder();

/** Text für eine PDF-Zeichenkette in WinAnsi (cp1252) kodieren. */
function winAnsi(s) {
  const out = [];
  for (const ch of s) {
    const c = ch.codePointAt(0);
    let b = 63;
    if (c >= 32 && c < 127) b = c;
    else if (c >= 160 && c <= 255) b = c;
    else if (c === 0x20ac) b = 128;
    else if (c === 0x2013) b = 150;
    else if (c === 0x2014) b = 151;
    else if (c === 0x201e) b = 132;
    else if (c === 0x201c) b = 147;
    else if (c === 0x201d) b = 148;
    else if (c === 0x2018 || c === 0x2019) b = 39;
    if (b === 40 || b === 41 || b === 92) out.push(92);
    out.push(b);
  }
  return Uint8Array.from(out);
}

let measure = null;
function emWidth(text) {
  if (!measure) { const c = document.createElement('canvas').getContext('2d'); c.font = '100px Helvetica, Arial, sans-serif'; measure = c; }
  return measure.measureText(text).width / 100;
}

const num = (v) => (Math.round(v * 100) / 100).toString();

/** pages: [{ jpeg: Uint8Array, w, h, words: [{ text, x0, y0, x1, y1 }] }] (Pixel); dpi bestimmt die Seitengröße. */
export function buildPdf(pages, { title = 'Scan', dpi = 150 } = {}) {
  const parts = [];
  const offsets = [];
  let pos = 0;
  const push = (u8) => { parts.push(u8); pos += u8.length; };
  const str = (s) => push(enc.encode(s));
  const obj = (n, body) => { offsets[n] = pos; str(`${n} 0 obj\n${body}\nendobj\n`); };
  const stream = (n, dict, data) => {
    offsets[n] = pos;
    str(`${n} 0 obj\n<< ${dict} /Length ${data.length} >>\nstream\n`);
    push(data); str('\nendstream\nendobj\n');
  };
  push(Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 10, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 10]));
  const total = 4 + pages.length * 3;                    // 1 Katalog, 2 Seitenbaum, 3 Schrift, 4 Info, dann je Seite 3
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  const kids = pages.map((_, i) => `${5 + i * 3} 0 R`).join(' ');
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const d = new Date();
  const p2 = (x) => String(x).padStart(2, '0');
  const stamp = `D:${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  const t = winAnsi(title);
  offsets[4] = pos;
  str('4 0 obj\n<< /Title ('); push(t); str(`) /Producer (Orbit NAS) /CreationDate (${stamp}) >>\nendobj\n`);
  pages.forEach((p, i) => {
    const pg = 5 + i * 3, ct = pg + 1, im = pg + 2;
    const k = 72 / dpi, W = p.w * k, H = p.h * k;
    obj(pg, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(W)} ${num(H)}] /Resources << /XObject << /Im0 ${im} 0 R >> /Font << /F1 3 0 R >> >> /Contents ${ct} 0 R >>`);
    let c = `q ${num(W)} 0 0 ${num(H)} 0 0 cm /Im0 Do Q\n`;
    const body = [];
    if (p.words?.length) {
      body.push(enc.encode('BT 3 Tr\n'));
      for (const w of p.words) {
        const text = (w.text || '').trim();
        if (!text) continue;
        const hpx = Math.max(2, w.y1 - w.y0), size = hpx * k * 0.85;
        const wantPt = (w.x1 - w.x0) * k, natural = emWidth(text) * size;
        const tz = natural > 0 ? Math.min(400, Math.max(20, (wantPt / natural) * 100)) : 100;
        body.push(enc.encode(`/F1 ${num(size)} Tf ${num(tz)} Tz 1 0 0 1 ${num(w.x0 * k)} ${num(H - w.y1 * k + hpx * k * 0.2)} Tm (`));
        body.push(winAnsi(text));
        body.push(enc.encode(') Tj\n'));
      }
      body.push(enc.encode('ET\n'));
    }
    const cbytes = enc.encode(c);
    const len = cbytes.length + body.reduce((a, b) => a + b.length, 0);
    const all = new Uint8Array(len);
    let o = 0; all.set(cbytes, o); o += cbytes.length;
    for (const b of body) { all.set(b, o); o += b.length; }
    stream(ct, '', all);
    stream(im, `/Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`, p.jpeg);
  });
  const xref = pos;
  str(`xref\n0 ${total + 1}\n0000000000 65535 f \n`);
  for (let n = 1; n <= total; n++) str(String(offsets[n]).padStart(10, '0') + ' 00000 n \n');
  str(`trailer\n<< /Size ${total + 1} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}
