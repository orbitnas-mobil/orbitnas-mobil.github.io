// Dokument erkennen, entzerren und aufhellen – ohne Fremdbibliothek, rein auf ImageData.

const clamp = (v, a = 0, b = 255) => (v < a ? a : v > b ? b : v);

/** Papierkanten im verkleinerten Bild suchen. Liefert vier Ecken [TL, TR, BR, BL] in Bildpunkten oder null. */
export function detectQuad(img) {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const g = new Float32Array(n);
  for (let i = 0; i < n; i++) g[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  const b = boxBlur(boxBlur(g, w, h, 2), w, h, 2);
  // Otsu-Schwelle
  const hist = new Float64Array(256);
  for (let i = 0; i < n; i++) hist[clamp(b[i] | 0)]++;
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let wB = 0, sB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = n - wB; if (!wF) break;
    sB += t * hist[t];
    const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) ** 2;
    if (v > best) { best = v; thr = t; }
  }
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = b[i] > thr ? 1 : 0;
  // größte helle Fläche
  const seen = new Uint8Array(n), stack = new Int32Array(n);
  let top = null;
  for (let s = 0; s < n; s++) {
    if (!mask[s] || seen[s]) continue;
    let sp = 0, area = 0;
    let tl = null, tr = null, br = null, bl = null, tlv = 1e9, trv = -1e9, brv = -1e9, blv = 1e9;
    stack[sp++] = s; seen[s] = 1;
    while (sp) {
      const p = stack[--sp], x = p % w, y = (p / w) | 0;
      area++;
      const a = x + y, d = x - y;
      if (a < tlv) { tlv = a; tl = [x, y]; }
      if (a > brv) { brv = a; br = [x, y]; }
      if (d > trv) { trv = d; tr = [x, y]; }
      if (d < blv) { blv = d; bl = [x, y]; }
      if (x > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[sp++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - w] && !seen[p - w]) { seen[p - w] = 1; stack[sp++] = p - w; }
      if (y < h - 1 && mask[p + w] && !seen[p + w]) { seen[p + w] = 1; stack[sp++] = p + w; }
    }
    if (!top || area > top.area) top = { area, quad: [tl, tr, br, bl] };
  }
  if (!top || top.area < n * 0.15) return null;
  const q = top.quad;
  const qa = Math.abs(q[0][0] * (q[1][1] - q[3][1]) + q[1][0] * (q[2][1] - q[0][1]) + q[2][0] * (q[3][1] - q[1][1]) + q[3][0] * (q[0][1] - q[2][1])) / 2;
  if (qa < n * 0.2 || qa > n * 0.995) return null;       // zu klein oder das ganze Bild
  if (qa < top.area * 0.9) return null;                    // keine vernünftige Vierecksform
  return q;
}

function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    let acc = 0, cnt = 0; const o = y * w;
    for (let x = -r; x <= r; x++) if (x >= 0 && x < w) { acc += src[o + x]; cnt++; }
    for (let x = 0; x < w; x++) {
      tmp[o + x] = acc / cnt;
      const add = x + r + 1, rem = x - r;
      if (add < w) { acc += src[o + add]; cnt++; }
      if (rem >= 0) { acc -= src[o + rem]; cnt--; }
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0, cnt = 0;
    for (let y = -r; y <= r; y++) if (y >= 0 && y < h) { acc += tmp[y * w + x]; cnt++; }
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / cnt;
      const add = y + r + 1, rem = y - r;
      if (add < h) { acc += tmp[add * w + x]; cnt++; }
      if (rem >= 0) { acc -= tmp[rem * w + x]; cnt--; }
    }
  }
  return out;
}

/** Achtgleichungssystem für die perspektivische Abbildung (Ziel-Rechteck -> Quellpunkte). */
function homography(dst, src) {
  const A = [], B = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = dst[i], [u, v] = src[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); B.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); B.push(v);
  }
  for (let c = 0; c < 8; c++) {
    let p = c; for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [B[c], B[p]] = [B[p], B[c]];
    for (let r = c + 1; r < 8; r++) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      B[r] -= f * B[c];
    }
  }
  const x = new Array(8);
  for (let r = 7; r >= 0; r--) {
    let s = B[r]; for (let k = r + 1; k < 8; k++) s -= A[r][k] * x[k];
    x[r] = s / A[r][r];
  }
  return x;
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Viereck (in Pixeln von srcCanvas) zu einem geraden Rechteck entzerren. maxSide begrenzt die längere Seite. */
export function warp(srcCanvas, quad, maxSide = 2000) {
  const [tl, tr, br, bl] = quad;
  let W = Math.max(dist(tl, tr), dist(bl, br)), H = Math.max(dist(tl, bl), dist(tr, br));
  const k = Math.min(1, maxSide / Math.max(W, H));
  W = Math.max(16, Math.round(W * k)); H = Math.max(16, Math.round(H * k));
  const sctx = srcCanvas.getContext('2d', { willReadFrequently: true });
  const S = sctx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);
  const sw = S.width, sh = S.height, sd = S.data;
  const m = homography([[0, 0], [W, 0], [W, H], [0, H]], quad);
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const octx = out.getContext('2d');
  const O = octx.createImageData(W, H), od = O.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dn = m[6] * x + m[7] * y + 1;
      const u = (m[0] * x + m[1] * y + m[2]) / dn, v = (m[3] * x + m[4] * y + m[5]) / dn;
      const x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0;
      const o = (y * W + x) * 4;
      if (x0 < 0 || y0 < 0 || x0 >= sw - 1 || y0 >= sh - 1) { od[o] = od[o + 1] = od[o + 2] = 255; od[o + 3] = 255; continue; }
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
      for (let c = 0; c < 3; c++) {
        od[o + c] = sd[i00 + c] * (1 - fx) * (1 - fy) + sd[i10 + c] * fx * (1 - fy) + sd[i01 + c] * (1 - fx) * fy + sd[i11 + c] * fx * fy;
      }
      od[o + 3] = 255;
    }
  }
  octx.putImageData(O, 0, 0);
  return out;
}

/** Hintergrund (Papier) ausgleichen: Schatten und Gelbstich verschwinden, Schrift wird kräftig.
 *  mode: 'farbe' | 'dokument' (Grau) | 'sw' (Schwarz-Weiß). Liefert eine neue Leinwand. */
export function enhance(canvas, mode = 'dokument') {
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const I = ctx.getImageData(0, 0, W, H), d = I.data;
  const B = 8, bw = Math.ceil(W / B), bh = Math.ceil(H / B);
  let bg = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    let mx = 0;
    for (let y = by * B; y < Math.min(H, by * B + B); y++) for (let x = bx * B; x < Math.min(W, bx * B + B); x++) {
      const i = (y * W + x) * 4, l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (l > mx) mx = l;
    }
    bg[by * bw + bx] = mx;
  }
  bg = boxBlur(boxBlur(bg, bw, bh, 2), bw, bh, 2);
  for (let y = 0; y < H; y++) {
    const fy = Math.min(bh - 1, y / B), y0 = Math.floor(fy), y1 = Math.min(bh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(bw - 1, x / B), x0 = Math.floor(fx), x1 = Math.min(bw - 1, x0 + 1), tx = fx - x0;
      const b = Math.max(40, (bg[y0 * bw + x0] * (1 - tx) + bg[y0 * bw + x1] * tx) * (1 - ty) + (bg[y1 * bw + x0] * (1 - tx) + bg[y1 * bw + x1] * tx) * ty);
      const i = (y * W + x) * 4, f = 255 / b;
      if (mode === 'farbe') {
        d[i] = clamp(d[i] * f); d[i + 1] = clamp(d[i + 1] * f); d[i + 2] = clamp(d[i + 2] * f);
      } else {
        let l = clamp((0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) * f);
        l = clamp((l - 70) * (255 / (235 - 70)));
        if (mode === 'sw') l = l < 150 ? 0 : 255;
        d[i] = d[i + 1] = d[i + 2] = l;
      }
    }
  }
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  out.getContext('2d').putImageData(I, 0, 0);
  return out;
}

export function rotate(canvas, quarter) {
  const q = ((quarter % 4) + 4) % 4;
  if (!q) return canvas;
  const out = document.createElement('canvas');
  out.width = q % 2 ? canvas.height : canvas.width;
  out.height = q % 2 ? canvas.width : canvas.height;
  const c = out.getContext('2d');
  c.translate(out.width / 2, out.height / 2);
  c.rotate((q * Math.PI) / 2);
  c.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return out;
}

/** Foto laden (Drehung aus den EXIF-Daten beachten) und auf maxSide verkleinern. */
export async function loadPhoto(file, maxSide = 2400) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch {
    bmp = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('Das Foto konnte nicht gelesen werden.')); im.src = URL.createObjectURL(file); });
  }
  const bw = bmp.width || bmp.naturalWidth, bh = bmp.height || bmp.naturalHeight;
  const k = Math.min(1, maxSide / Math.max(bw, bh));
  const c = document.createElement('canvas');
  c.width = Math.round(bw * k); c.height = Math.round(bh * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c;
}

/** Ganzes Foto -> erkannte Ecken in Foto-Pixeln (oder null). */
export function findDocument(canvas) {
  const k = Math.min(1, 360 / Math.max(canvas.width, canvas.height));
  const s = document.createElement('canvas');
  s.width = Math.max(8, Math.round(canvas.width * k)); s.height = Math.max(8, Math.round(canvas.height * k));
  const c = s.getContext('2d', { willReadFrequently: true });
  c.drawImage(canvas, 0, 0, s.width, s.height);
  const q = detectQuad(c.getImageData(0, 0, s.width, s.height));
  return q ? q.map(([x, y]) => [x / k, y / k]) : null;
}
