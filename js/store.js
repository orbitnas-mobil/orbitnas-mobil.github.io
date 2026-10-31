// Gemeinsame Einstellungen mit dem PC: /.orbitnas/einstellungen.json in der Haupt-Cloud (Format: EINSTELLUNGEN.md).
// Jeder Eintrag hat t (Zeit der letzten Änderung, ISO in UTC); beim Zusammenführen gewinnt der jüngere, bei Gleichstand del:true.
// Unbekannte Felder und Einträge (z. B. "lokal:" vom PC) werden unverändert mitgeschrieben.

import { kv } from './db.js';
import { mainConnection, source, ensureKeys } from './sources/registry.js';

export const FILE = '/.orbitnas/einstellungen.json';
const SINGLES = ['design', 'autoLock', 'showHiddenButton', 'appPin', 'security', 'iconStyle'];
const LISTS = ['folderStyles', 'favorites', 'hidden', 'ignored', 'readOnly', 'locks'];
const KEEP_DAYS = 90;

let doc = { v: 1 };
let dirty = false;
let firstDone = false;   // Beim allerersten Abgleich gewinnt die vorhandene Datei (wie am PC)
const listeners = new Set();
export const onStore = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => listeners.forEach((fn) => { try { fn(doc); } catch (e) { console.error(e); } });
export const status = { lastRead: null, lastWrite: null, error: null, busy: false };

const now = () => new Date().toISOString();
const tOf = (x) => Date.parse(x?.t || '') || 0;
const lc = (s) => (s || '').toLowerCase();
const listKey = (e) => lc(e.cloud) + '\n' + lc(e.path);
export const devName = () => (/iPad|Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1 ? 'iPad' : 'iPhone');

function newer(a, b) {
  if (!a) return b;
  if (!b) return a;
  const ta = tOf(a), tb = tOf(b);
  if (ta !== tb) return ta > tb ? a : b;
  if (a.del && !b.del) return a;
  return b;
}

/** Führt zwei Stände zusammen (a = dieses Gerät, b = aus der Cloud). */
export function merge(a = {}, b = {}) {
  const out = { ...a, ...b };
  for (const k of SINGLES) { const v = newer(a[k], b[k]); if (v) out[k] = v; else delete out[k]; }
  const colors = {};
  for (const k of new Set([...Object.keys(a.sourceColors || {}), ...Object.keys(b.sourceColors || {})])) colors[k] = newer(a.sourceColors?.[k], b.sourceColors?.[k]);
  out.sourceColors = colors;
  for (const k of LISTS) {
    const m = new Map();
    for (const e of b[k] || []) if (e && e.cloud != null) m.set(listKey(e), e);
    for (const e of a[k] || []) if (e && e.cloud != null) m.set(listKey(e), newer(e, m.get(listKey(e))));
    out[k] = [...m.values()];
  }
  out.v = 1;
  return out;
}

/** Eigene Werte vor dem ersten Abgleich: t = 1970, damit die vorhandene Datei gewinnt. */
function aged(d) {
  const old = new Date(0).toISOString();
  for (const k of SINGLES) if (d[k]) d[k].t = old;
  for (const e of Object.values(d.sourceColors || {})) if (e) e.t = old;
  for (const k of LISTS) for (const e of d[k] || []) e.t = old;
}

function purge(d) {
  const limit = Date.now() - KEEP_DAYS * 86400000;
  for (const k of LISTS) d[k] = (d[k] || []).filter((e) => !(e.del && tOf(e) < limit));
  for (const [k, e] of Object.entries(d.sourceColors || {})) if (e?.del && tOf(e) < limit) delete d.sourceColors[k];
  return d;
}

const stable = (x) => JSON.stringify(x, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((kk) => [kk, v[kk]])) : v));
const sameContent = (a, b) => { const strip = ({ updated, device, ...r }) => r; return stable(strip(a || {})) === stable(strip(b || {})); };

// ---------------------------------------------------------------- Laden und Schreiben

export async function initStore() {
  const saved = await kv.get('einstellungen');
  if (saved) { doc = saved.doc || { v: 1 }; dirty = !!saved.dirty; firstDone = !!saved.firstDone; }
  emit();
}
const saveLocal = () => kv.set('einstellungen', { doc, dirty, firstDone });

async function mainSource() {
  const A = await import('./addons/store.js');
  await A.loadSyncLoc();
  return A.syncSource();
}

async function readRemote(src) {
  const A = await import('./addons/store.js');
  // neuer Ort im Abgleich-Ordner; ältere Geräte/Stände liegen noch in /.orbitnas
  const text = (await src.readText(A.settingsFilePath())) || (await src.readText(FILE));
  if (!text) return {};
  try { const j = JSON.parse(text); return j && typeof j === 'object' ? j : {}; } catch { return {}; }
}

let syncing = null;
/** Datei lesen und zusammenführen; gibt es eigene, noch nicht geschriebene Änderungen, wird geschrieben. */
export function syncStore() {
  if (syncing) return syncing;
  syncing = (async () => {
    status.busy = true;
    try {
      const src = await mainSource();
      if (!src) return;
      const remote = await readRemote(src);
      if (!firstDone && Object.keys(remote).length > 1) aged(doc);
      firstDone = true;
      const merged = merge(doc, remote);
      status.lastRead = Date.now();
      if (dirty && !sameContent(merged, remote)) await write(src, merged);
      else { doc = merged; dirty = false; await saveLocal(); }
      status.error = null;
    } catch (e) {
      status.error = e;
    } finally {
      status.busy = false;
      syncing = null;
      emit();
    }
  })();
  return syncing;
}

async function write(src, merged) {
  // direkt vor dem Schreiben noch einmal lesen, damit nichts verloren geht
  const latest = merge(merged, await readRemote(src));
  const out = purge({ ...latest, v: 1, updated: now(), device: devName() });
  const A = await import('./addons/store.js');
  await A.ensureSyncFolder(src);
  await src.writeText(A.settingsFilePath(), JSON.stringify(out, null, 2));
  doc = out;
  dirty = false;
  status.lastWrite = Date.now();
  await saveLocal();
}

let writeTimer = null;
async function changed() {
  dirty = true;
  await saveLocal();
  emit();
  import('./addons/ledger.js').then((m) => m.markChanged()).catch(() => {});
}

/** Stand aus einer gesicherten Datei übernehmen: alle Einträge gelten als „jetzt“ geändert. */
export async function replaceDoc(d) {
  const t = now();
  const x = JSON.parse(JSON.stringify(d || { v: 1 }));
  for (const k of SINGLES) if (x[k]) x[k].t = t;
  for (const e of Object.values(x.sourceColors || {})) if (e) e.t = t;
  for (const k of LISTS) for (const e of x[k] || []) e.t = t;
  doc = x; dirty = false; firstDone = true;
  await saveLocal(); emit();
}

// ---------------------------------------------------------------- Lesen für die Oberfläche

const live = (e) => e && !e.del;
export const getDoc = () => doc;
export const design = () => (live(doc.design) ? doc.design : null);
export const appPin = () => (live(doc.appPin) && doc.appPin.hash ? doc.appPin : null);
export const security = () => (live(doc.security) && doc.security.hash ? doc.security : null);
export const autoLockMinutes = () => (live(doc.autoLock) ? Number(doc.autoLock.minutes) || 0 : 0);
export const showHiddenButton = () => (live(doc.showHiddenButton) ? doc.showHiddenButton.on !== false : true);
/** Symbole gefüllt (Standard) oder nur als Umriss – wie am PC. */
export const iconsFilled = () => !(live(doc.iconStyle) && doc.iconStyle.style === 'outline');
export const sourceColor = (key) => { const e = doc.sourceColors?.[key]; return live(e) ? e.color : null; };

export const entries = (list, cloud) => (doc[list] || []).filter((e) => live(e) && (!cloud || lc(e.cloud) === lc(cloud)));
export const entry = (list, cloud, path) => entries(list, cloud).find((e) => lc(e.path) === lc(path));
/** Gilt ein Eintrag für diesen Pfad oder einen Ordner darüber (z. B. PIN, Schreibschutz)? Liefert den nächsten darüber. */
export function inherited(list, cloud, path) {
  const p = lc(path);
  let best = null;
  for (const e of entries(list, cloud)) {
    const ep = lc(e.path);
    if (ep === '' || p === ep || p.startsWith(ep + '/')) if (!best || ep.length > best.path.length) best = e;
  }
  return best;
}

// ---------------------------------------------------------------- Ändern (t = jetzt)

export async function setSingle(name, value) {
  doc[name] = value ? { ...value, t: now(), del: false } : { ...(doc[name] || {}), t: now(), del: true };
  await changed();
}

export async function setSourceColor(key, color) {
  doc.sourceColors = doc.sourceColors || {};
  doc.sourceColors[key] = color ? { color, t: now(), del: false } : { ...(doc.sourceColors[key] || {}), t: now(), del: true };
  await changed();
}

/** Listen-Eintrag setzen (value = Felder) oder löschen (value = null). */
export async function setEntry(list, cloud, path, value) {
  const arr = (doc[list] = doc[list] || []);
  const i = arr.findIndex((e) => lc(e.cloud) === lc(cloud) && lc(e.path) === lc(path));
  const base = { cloud, path };
  const e = value ? { ...base, ...value, t: now(), del: false } : { ...(i >= 0 ? arr[i] : base), t: now(), del: true };
  if (i >= 0) arr[i] = e; else arr.push(e);
  await changed();
}

/** Mehrere Einträge in einem Rutsch, alle mit derselben Zeit (z. B. Ordnerstil in allen Clouds). */
export async function setEntries(list, changes) {
  const t = now();
  const arr = (doc[list] = doc[list] || []);
  for (const { cloud, path, value } of changes) {
    const i = arr.findIndex((e) => lc(e.cloud) === lc(cloud) && lc(e.path) === lc(path));
    const e = value ? { cloud, path, ...value, t, del: false } : { ...(i >= 0 ? arr[i] : { cloud, path }), t, del: true };
    if (i >= 0) arr[i] = e; else arr.push(e);
  }
  if (changes.length) await changed();
}

/** Nach Umbenennen/Verschieben: Einträge unter dem alten Pfad mitnehmen (Favoriten, Farben, PINs …). */
export async function movePaths(cloud, from, to) {
  const f = lc(from);
  let any = false;
  for (const list of LISTS) {
    for (const e of entries(list, cloud)) {
      const ep = lc(e.path);
      if (ep === f || ep.startsWith(f + '/')) {
        const np = to + e.path.slice(from.length);
        const { t, del, cloud: c, path, ...rest } = e;
        await setEntryQuiet(list, cloud, e.path, null);
        await setEntryQuiet(list, cloud, np, { ...rest, ...(list === 'favorites' && ep === f ? { name: np.split('/').pop() } : {}) });
        any = true;
      }
    }
  }
  if (any) await changed();
}
async function setEntryQuiet(list, cloud, path, value) {
  const arr = (doc[list] = doc[list] || []);
  const i = arr.findIndex((e) => lc(e.cloud) === lc(cloud) && lc(e.path) === lc(path));
  const e = value ? { cloud, path, ...value, t: now(), del: false } : { ...(i >= 0 ? arr[i] : { cloud, path }), t: now(), del: true };
  if (i >= 0) arr[i] = e; else arr.push(e);
}

/** Gelöschte Ordner: Einträge darunter als gelöscht markieren. */
export async function forgetPaths(cloud, path) {
  const f = lc(path);
  let any = false;
  for (const list of LISTS) for (const e of entries(list, cloud)) { const ep = lc(e.path); if (ep === f || ep.startsWith(f + '/')) { await setEntryQuiet(list, cloud, e.path, null); any = true; } }
  if (any) await changed();
}

