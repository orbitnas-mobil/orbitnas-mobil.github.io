// Liest die erste Datei aus einer ZIP-Datei (pCloud liefert Downloads für Web-Apps nur als ZIP über „getzip“).
// Unterstützt „gespeichert“ und „deflate“ sowie ZIP64.

const u16 = (v, o) => v.getUint16(o, true);
const u32 = (v, o) => v.getUint32(o, true);
const u64 = (v, o) => u32(v, o) + u32(v, o + 4) * 0x100000000;

export async function firstFileFromZip(bytes, want = null) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Ende des Inhaltsverzeichnisses suchen
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (u32(v, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Die Datei von pCloud ist beschädigt (kein ZIP).');
  let cd = u32(v, eocd + 16);
  if (cd === 0xffffffff && eocd >= 20 && u32(v, eocd - 20) === 0x07064b50) {
    const e64 = u64(v, eocd - 20 + 8);
    cd = u64(v, e64 + 48);
  }
  const count = u16(v, eocd + 10);
  let p = cd;
  for (let n = 0; n < count || count === 0xffff; n++) {
    if (p + 46 > bytes.length || u32(v, p) !== 0x02014b50) break;
    const method = u16(v, p + 10);
    let comp = u32(v, p + 20);
    let size = u32(v, p + 24);
    const nameLen = u16(v, p + 28), extraLen = u16(v, p + 30), commentLen = u16(v, p + 32);
    let local = u32(v, p + 42);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    // ZIP64-Zusatzangaben
    let e = p + 46 + nameLen;
    const eEnd = e + extraLen;
    while (e + 4 <= eEnd) {
      const id = u16(v, e), len = u16(v, e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) { size = u64(v, q); q += 8; }
        if (comp === 0xffffffff) { comp = u64(v, q); q += 8; }
        if (local === 0xffffffff) { local = u64(v, q); q += 8; }
      }
      e += 4 + len;
    }
    p = eEnd + commentLen;
    if (name.endsWith('/') || (want && name !== want)) continue;
    if (u32(v, local) !== 0x04034b50) throw new Error('Die Datei von pCloud ist beschädigt.');
    const start = local + 30 + u16(v, local + 26) + u16(v, local + 28);
    const data = bytes.subarray(start, start + comp);
    if (method === 0) return data;
    if (method === 8) {
      const out = new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')));
      return new Uint8Array(await out.arrayBuffer());
    }
    throw new Error('Unbekanntes ZIP-Format (' + method + ').');
  }
  throw new Error(want ? `In der ZIP-Datei fehlt ${want}.` : 'Die ZIP-Datei von pCloud ist leer.');
}
