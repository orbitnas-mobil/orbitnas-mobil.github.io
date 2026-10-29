// Kleine Helfer für Oberfläche, Formatierung und Dialoge.

// append()/replaceChildren() sollen leere Teile (null/false) einfach weglassen statt „null“ anzuzeigen.
for (const name of ['append', 'replaceChildren']) {
  const orig = Element.prototype[name];
  Element.prototype[name] = function (...nodes) { return orig.apply(this, nodes.flat(Infinity).filter((n) => n != null && n !== false)); };
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Baut ein Element: h('div.klasse', {onclick}, kind1, kind2 …). Texte werden immer sicher eingesetzt. */
export function h(tag, attrs, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className += (el.className ? ' ' : '') + v;
    else if (k === 'style' && typeof v === 'object') { for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv; } }
    else if (k === 'html') el.innerHTML = v; // nur für eigene, feste Symbole
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) { while (el.firstChild) el.firstChild.remove(); return el; }

export function fmtSize(bytes) {
  if (bytes == null || isNaN(bytes)) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, n = Number(bytes);
  while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
  return (i === 0 ? n : n.toLocaleString('de-DE', { maximumFractionDigits: n < 10 ? 1 : 0 })) + ' ' + u[i];
}

export function fmtDate(d, withTime = true) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date)) return '';
  const opts = { day: '2-digit', month: '2-digit', year: 'numeric' };
  if (withTime) Object.assign(opts, { hour: '2-digit', minute: '2-digit' });
  return date.toLocaleString('de-DE', opts);
}

export function fmtAgo(d) {
  if (!d) return 'nie';
  const date = d instanceof Date ? d : new Date(d);
  const s = (Date.now() - date.getTime()) / 1000;
  if (s < 60) return 'gerade eben';
  if (s < 3600) return `vor ${Math.round(s / 60)} Min.`;
  if (s < 86400) return `vor ${Math.round(s / 3600)} Std.`;
  if (s < 86400 * 2) return 'gestern';
  return fmtDate(date, false);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function uid() {
  const a = crypto.getRandomValues(new Uint8Array(9));
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/** Normalisiert für die Suche: klein, ohne Akzente (ä → a usw. bleibt über NFD erhalten). */
export function norm(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function extOf(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

// Dateiarten, Farben und Typnamen genau wie am PC (FileKinds.cs).
const KINDS = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'heic', 'heif', 'tif', 'tiff', 'raw', 'cr2', 'nef', 'arw', 'dng', 'svg', 'ico'],
  video: ['mp4', 'm4v', 'mkv', 'avi', 'mov', 'wmv', 'webm', 'mpg', 'mpeg', 'ts', 'm2ts', 'mts', '3gp', 'flv', 'vob'],
  audio: ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus', 'wma', 'aiff'],
  pdf: ['pdf'],
  document: ['doc', 'docx', 'odt', 'rtf', 'pages'],
  sheet: ['xls', 'xlsx', 'ods', 'csv', 'numbers'],
  slides: ['ppt', 'pptx', 'odp', 'key'],
  archive: ['zip', '7z', 'rar', 'tar', 'gz', 'bz2', 'xz', 'iso'],
  code: ['cs', 'js', 'py', 'html', 'css', 'json', 'xml', 'ps1', 'bat', 'cmd', 'sh', 'yml', 'yaml'],
  text: ['txt', 'md', 'log', 'ini', 'nfo'],
  program: ['exe', 'msi', 'apk', 'dll'],
};
export function kindOf(name, isFolder) {
  if (isFolder) return 'folder';
  const e = extOf(name);
  for (const [k, list] of Object.entries(KINDS)) if (list.includes(e)) return k;
  return 'other';
}
export const KIND_COLOR = {
  folder: '#F5B544', image: '#EC4899', video: '#A855F7', audio: '#F97316', pdf: '#EF4444', document: '#2B579A', sheet: '#217346',
  slides: '#D24726', archive: '#F5B544', code: '#14B8A6', text: '#9CA3AF', program: '#3B82F6', other: '#9CA3AF',
};
export function typeName(name, kind) {
  return {
    folder: 'Ordner', image: 'Bild', video: 'Video', audio: 'Musik / Audio', pdf: 'PDF-Dokument', document: 'Textdokument', sheet: 'Tabelle',
    slides: 'Präsentation', archive: 'Archiv', code: 'Code', text: 'Textdatei', program: 'Programm',
  }[kind] || (extOf(name) ? extOf(name).toUpperCase() + '-Datei' : 'Datei');
}
export const kindIcon = {
  folder: 'folder', image: 'image', video: 'video', audio: 'audio', pdf: 'pdf', document: 'doc', sheet: 'sheet', slides: 'slides',
  archive: 'archive', code: 'code', text: 'doc', program: 'program', other: 'file',
};

// ---------------------------------------------------------------- Symbole (eigene SVGs, kein Fremdinhalt)

const P = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  folder: 'M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  search: 'M10.5 3a7.5 7.5 0 0 1 5.9 12.1l4.3 4.3-1.4 1.4-4.3-4.3A7.5 7.5 0 1 1 10.5 3zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z',
  upload: 'M12 3l5 5-1.4 1.4L13 6.8V16h-2V6.8L8.4 9.4 7 8zM4 18h16v2H4z',
  more: 'M5 10a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm7 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm7 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4z',
  file: 'M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm7 1.5V9h5.5z',
  image: 'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 12 4-5 3 4 2-2.5L20 16V6H4zm11-8.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z',
  video: 'M4 5h11a2 2 0 0 1 2 2v2.5l5-3v11l-5-3V17a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z',
  audio: 'M9 18a3 3 0 1 1-2-2.8V5l12-2v12a3 3 0 1 1-2-2.8V6.4L9 7.7z',
  pdf: 'M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm1 12v4h1.5v-1.3h.8a1.4 1.4 0 0 0 0-2.7zm1.5 1h.7a.4.4 0 0 1 0 .7h-.7zm3-1v4h1.4a2 2 0 0 0 0-4zm1.4 1a1 1 0 0 1 0 2v-2zm2.6-1v4h1.4v-1.4h1.4v-1h-1.4V15H17v-1z',
  doc: 'M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm2 10v1.5h8V12zm0 3.5V17h8v-1.5zm0-7V10h4V8.5z',
  archive: 'M6 2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm4 2v2h2V4zm2 2v2h2V6zm-2 2v2h2V8zm2 2v2h2v-2zm-2 2v4h4v-4z',
  cloud: 'M7 19a5 5 0 0 1-.8-9.9A6.5 6.5 0 0 1 18.6 8 5.5 5.5 0 0 1 18 19z',
  disk: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm13 9.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM5 7v5h14V7z',
  pc: 'M3 4h18a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-7v2h3v2H7v-2h3v-2H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm1 2v9h16V6z',
  back: 'M15.4 4.6 8 12l7.4 7.4-1.4 1.4L5.2 12 14 3.2z',
  close: 'M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4z',
  check: 'M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z',
  list: 'M3 5h18v2H3zm0 6h18v2H3zm0 6h18v2H3z',
  grid: 'M3 3h8v8H3zm10 0h8v8h-8zM3 13h8v8H3zm10 0h8v8h-8z',
  sort: 'M7 3l4 4H8v10H6V7H3zm10 18-4-4h3V7h2v10h3z',
  lock: 'M7 10V7a5 5 0 0 1 10 0v3h1a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V11a1 1 0 0 1 1-1zm2 0h6V7a3 3 0 0 0-6 0z',
  face: 'M4 4h4v2H6v2H4zm12 0h4v4h-2V6h-2zM4 16h2v2h2v2H4zm14 0h2v4h-4v-2h2zM9 9h1.5v2H9zm4.5 0H15v2h-1.5zM12 9.5v4h-1.2v1.2H13V9.5zM8.8 15.6a4.6 4.6 0 0 0 6.4 0l.9.9a5.8 5.8 0 0 1-8.2 0z',
  star: 'M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9z',
  eye: 'M12 5c5 0 9 4.5 10 7-1 2.5-5 7-10 7S3 14.5 2 12c1-2.5 5-7 10-7zm0 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm0 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4z',
  eyeOff: 'M3.3 2 22 20.7l-1.3 1.3-3.4-3.4A11 11 0 0 1 12 20c-5 0-9-4.5-10-7a14 14 0 0 1 4-5.1L2 3.3zM12 4c5 0 9 4.5 10 7a13 13 0 0 1-2.8 4L16 11.8V11a4 4 0 0 0-4-4h-.8L8.6 4.4A10 10 0 0 1 12 4z',
  share: 'M12 2l4.5 4.5-1.4 1.4L13 5.8V15h-2V5.8L8.9 7.9 7.5 6.5zM5 10h3v2H6v8h12v-8h-2v-2h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V11a1 1 0 0 1 1-1z',
  trash: 'M9 3h6l1 2h4v2H4V5h4zm-3 6h12l-1 12H7z',
  edit: 'M4 17.2V20h2.8l8.3-8.3-2.8-2.8zm13.7-7.5a1 1 0 0 0 0-1.4l-2-2a1 1 0 0 0-1.4 0l-1.5 1.5 3.4 3.4z',
  copy: 'M8 3h11a2 2 0 0 1 2 2v11h-2V5H8zM5 7h10a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z',
  move: 'M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zm9 3v2.5H7v2h5V16l4-3.5z',
  plusFolder: 'M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zm8 4v2.5H8.5v2H11V17h2v-2.5h2.5v-2H13V10z',
  info: 'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm-1 8v7h2v-7zm0-4v2h2V6z',
  download: 'M11 3h2v9.2l2.6-2.6L17 11l-5 5-5-5 1.4-1.4 2.6 2.6zM4 18h16v2H4z',
  sync: 'M12 4a8 8 0 0 1 7.4 5H17v2h6V5h-2v2.7A10 10 0 0 0 2 12h2a8 8 0 0 1 8-8zm8 8a8 8 0 0 1-15.4 3H7v-2H1v6h2v-2.7A10 10 0 0 0 22 12z',
  shield: 'M12 2l8 3v6c0 5-3.4 9.4-8 11-4.6-1.6-8-6-8-11V5zm-1.2 13.4 6-6-1.4-1.4-4.6 4.6-2.2-2.2-1.4 1.4z',
  chart: 'M4 20V10h3v10zm6.5 0V4h3v16zM17 20v-7h3v7z',
  task: 'M9 2h6v2h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h3zm1 2v1h4V4zm-.5 12.4 6.4-6.4-1.4-1.4-5 5-2-2-1.4 1.4z',
  export: 'M6 2h8l6 6v4h-2V9h-5V4H6v16h6v2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm12 12 4 4-4 4v-3h-5v-2h5z',
  camera: 'M9 3h6l1.5 2H20a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h3.5zm3 4.5a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0 2a3 3 0 1 1 0 6 3 3 0 0 1 0-6z',
  photos: 'M12 2a4 4 0 0 1 3.5 6A4 4 0 0 1 18 14.5 4 4 0 0 1 12 18a4 4 0 0 1-6-3.5A4 4 0 0 1 8.5 8 4 4 0 0 1 12 2z',
  select: 'M4 4h6v6H4zm1.5 1.5v3h3v-3zM14 4h6v6h-6zM4 14h6v6H4zm10 0h6v6h-6zm1.5 1.5v3h3v-3z',
  play: 'M8 5v14l11-7z',
  pause: 'M6 5h4v14H6zm8 0h4v14h-4z',
  warn: 'M12 2 1 21h22zm-1 7h2v6h-2zm0 8h2v2h-2z',
  forward: 'M8.6 4.6 16 12l-7.4 7.4 1.4 1.4 8.8-8.8L10 3.2z',
  up: 'M12 4l7 7-1.4 1.4L13 7.8V20h-2V7.8l-4.6 4.6L5 11z',
  chevron: 'M9.4 6 8 7.4l4.6 4.6L8 16.6 9.4 18l6-6z',
  chevronDown: 'M6 9.4 7.4 8l4.6 4.6L16.6 8 18 9.4l-6 6z',
  gear: 'M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3h-4l-.4 2.7a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1c.5.4 1.1.7 1.7 1L11 21h4l.4-2.7c.6-.3 1.2-.6 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z',
  log: 'M5 3h14a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm2 4v2h10V7zm0 4v2h10v-2zm0 4v2h6v-2z',
  plus: 'M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7z',
  cut: 'M9.6 7.6A3.5 3.5 0 1 0 8 9.4l2.6 2.6L8 14.6a3.5 3.5 0 1 0 1.6 1.8L12 14l7 7h3L9.6 7.6zM6.5 8A1.5 1.5 0 1 1 6.5 5a1.5 1.5 0 0 1 0 3zm0 11a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zM19 3l-6 6 2 2 7-8z',
  paste: 'M9 2h6v2h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h3zm1 2v1h4V4zM6 6v14h12V6h-2v1H8V6z',
  sheet: 'M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm1 10v7h10v-7zm1.5 1.5h3v1.5h-3zm4.5 0h3v1.5h-3zm-4.5 3h3V18h-3zm4.5 0h3V18h-3z',
  slides: 'M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm1 10v6h10v-6zm2 1.5h6v3H9z',
  code: 'M8.6 7.4 4 12l4.6 4.6L7.2 18l-6-6 6-6zm6.8 0L16.8 6l6 6-6 6-1.4-1.4L20 12z',
  program: 'M3 4h18a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm1 4v10h16V8zm2 2 3 2-3 2z',
  heart: 'M12 21s-8-5.2-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 5.8-8 11-8 11z',
  music: 'M9 18a3 3 0 1 1-2-2.8V5l12-2v12a3 3 0 1 1-2-2.8V6.4L9 7.7z',
  work: 'M9 3h6a2 2 0 0 1 2 2v1h3a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3V5a2 2 0 0 1 2-2zm0 3h6V5H9z',
  ignore: 'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zM5.7 7.1A8 8 0 0 0 16.9 18.3zm1.4-1.4 11.2 11.2A8 8 0 0 0 7.1 5.7z',
  palette: 'M12 2a10 10 0 0 0 0 20c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2h2.4A4.6 4.6 0 0 0 22 10.8C22 5.9 17.5 2 12 2zM6.5 13a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3-4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3 4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z',
  layers: 'M12 2 22 7l-10 5L2 7zm-7.8 8.4L12 14.3l7.8-3.9L22 11.5l-10 5-10-5zm0 4.5L12 18.8l7.8-3.9L22 16l-10 5-10-5z',
  path: 'M4 4h6v2H6v12h12v-4h2v6H4zm10 0h6v6h-2V7.4l-6.3 6.3-1.4-1.4L16.6 6H14z',
  cloudCheck: 'M7 19a5 5 0 0 1-.8-9.9A6.5 6.5 0 0 1 18.6 8 5.5 5.5 0 0 1 18 19zm3.2-3.6 5.3-5.3-1.4-1.4-3.9 3.9-1.9-1.9-1.4 1.4z',
  clock: 'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm0 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16zm-1 3h2v5.4l3.6 2.1-1 1.7L11 13.6z',
  fuel: 'M5 3h8a1 1 0 0 1 1 1v7h1a2 2 0 0 1 2 2v4a1 1 0 0 0 2 0V9l-2-2 1.4-1.4 3.1 3.1V17a3 3 0 0 1-6 0v-4h-1v8H4V4a1 1 0 0 1 1-1zm1 2v5h6V5z',
  note: 'M5 3h14a2 2 0 0 1 2 2v10l-6 6H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm1 4v2h12V7zm0 4v2h12v-2zm0 4v2h6v-2zm10 5 4-4h-4z',
  plane: 'M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z',
  link: 'M10.6 13.4a1 1 0 0 1 0-1.4l3-3a1 1 0 1 1 1.4 1.4l-3 3a1 1 0 0 1-1.4 0zM8.5 18a3.5 3.5 0 0 1-2.5-6l2-2 1.4 1.4-2 2a1.5 1.5 0 0 0 2.2 2.2l2-2 1.4 1.4-2 2a3.5 3.5 0 0 1-2.5 1zm6.1-4.6-1.4-1.4 2-2a1.5 1.5 0 0 0-2.2-2.2l-2 2L9.6 8.4l2-2a3.5 3.5 0 0 1 5 5z',
};
export function icon(name, cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'ic ' + cls);
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', P[name] || P.file);
  svg.append(p);
  return svg;
}

// ---------------------------------------------------------------- Meldungen und Dialoge

let toastTimer;
export function toast(text, kind = '') {
  let t = $('#toast');
  if (!t) { t = h('div', { id: 'toast', role: 'status' }); document.body.append(t); }
  t.className = 'toast show ' + kind;
  t.textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

/** Öffnet ein Blatt (unten am iPhone, mittig am iPad). Gibt { el, close } zurück. */
export function sheet(content, { title, wide = false, onClose } = {}) {
  const backdrop = h('div.backdrop');
  const box = h('div.sheet' + (wide ? '.wide' : ''), { role: 'dialog', 'aria-modal': 'true' });
  const close = () => {
    backdrop.classList.remove('show');
    setTimeout(() => backdrop.remove(), 200);
    document.removeEventListener('keydown', onKey);
    onClose && onClose();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  if (title) box.append(h('div.sheet-head', h('h2', title), h('button.icon-btn', { onclick: close, 'aria-label': 'Schließen' }, icon('close'))));
  box.append(content);
  backdrop.append(box);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(backdrop);
  requestAnimationFrame(() => backdrop.classList.add('show'));
  return { el: box, close };
}

/** Auswahlliste (Aktionsblatt) wie ein Kontextmenü. items: [{ label, icon, danger, onclick, disabled, hint }] oder '-' als Trennlinie. */
export function actionSheet(title, items) {
  const list = h('div.actions');
  const s = sheet(list, { title });
  const clean = items.filter(Boolean).filter((it, i, a) => it !== '-' || (i > 0 && a[i - 1] !== '-' && i < a.length - 1));
  for (const it of clean) {
    if (it === '-') { list.append(h('div.action-sep')); continue; }
    list.append(h('button.action' + (it.danger ? '.danger' : ''), {
      disabled: it.disabled,
      onclick: () => { s.close(); it.onclick && it.onclick(); },
    }, it.icon ? icon(it.icon) : null, h('span', it.label, it.hint ? h('small', it.hint) : null)));
  }
  return s;
}

export function confirmDialog(text, { title = 'Bitte bestätigen', ok = 'OK', danger = false, cancel = 'Abbrechen' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const body = h('div.dialog-body', h('p', text));
    const s = sheet(body, { title, onClose: () => { if (!done) resolve(false); } });
    body.append(h('div.btn-row',
      cancel ? h('button.btn', { onclick: () => { done = true; s.close(); resolve(false); } }, cancel) : null,
      h('button.btn.primary' + (danger ? '.danger' : ''), { onclick: () => { done = true; s.close(); resolve(true); } }, ok)));
  });
}

export function promptDialog(text, value = '', { title = 'Eingabe', ok = 'OK', placeholder = '', select } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const input = h('input.input', { value, placeholder, autocapitalize: 'off', autocorrect: 'off', spellcheck: false });
    const finish = (v) => { done = true; s.close(); resolve(v); };
    const body = h('form.dialog-body', { onsubmit: (e) => { e.preventDefault(); finish(input.value.trim()); } },
      text ? h('p', text) : null, input,
      h('div.btn-row', h('button.btn', { type: 'button', onclick: () => finish(null) }, 'Abbrechen'), h('button.btn.primary', { type: 'submit' }, ok)));
    const s = sheet(body, { title, onClose: () => { if (!done) resolve(null); } });
    setTimeout(() => {
      input.focus();
      if (select) input.setSelectionRange(0, select(value));
    }, 250);
  });
}

/** Datei an das Teilen-Menü von iOS geben (dort: „In Dateien sichern“, AirDrop …), sonst herunterladen. */
export async function shareOrDownload(blob, filename) {
  const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return true; }
    catch (e) { if (e.name === 'AbortError') return false; }
  }
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return true;
}

export function loadScript(src) {
  return new Promise((resolve, reject) => {
    if ([...document.scripts].some((s) => s.src.endsWith(src))) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Baustein konnte nicht geladen werden: ' + src));
    document.head.append(s);
  });
}

/** Pfad eines einfarbigen Symbols (für zusammengesetzte Symbole). */
export const iconPath = (name) => P[name] || P.file;
