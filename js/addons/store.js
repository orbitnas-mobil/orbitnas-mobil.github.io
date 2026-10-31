// Daten der Add-ons (Fuel Tracker, Notizen, Reisen, Tresor) auf diesem Gerät und ihr Online-Abgleich mit Orbit am PC.
// Format wie am PC (PluginSync.cs): je Add-on eine verschlüsselte Datei /.orbitnas/addons/<id>/daten.orbit in der Haupt-Cloud
// (AES-256-GCM, Schlüssel per PBKDF2-SHA256 aus dem Sync-Passwort), darin {"speicher": {schlüssel: text}}.
// Zusammenführen: Dreiwege je Schlüssel; Listen mit "id" werden zusätzlich je Eintrag zusammengeführt, damit nichts verloren geht.

import { kv } from '../db.js';
import { saveSecret, loadSecret, deleteSecret } from '../secrets.js';
import { mainConnection, source, ensureKeys, connById } from '../sources/registry.js';
import { devName } from '../store.js';
import { applyShared } from './prefs.js';
import { confirmDialog } from '../util.js';

export const ADDONS = [
  { id: 'fuel', pc: 'de.dennis.orbit-fuel', title: 'Fuel Tracker', icon: 'fuel', color: '#00D4FF' },
  { id: 'notes', pc: 'de.dennis.orbit-notes', title: 'Notizen', icon: 'note', color: '#A855F7' },
  { id: 'trips', pc: 'de.dennis.orbit-trips', title: 'Reisen', icon: 'plane', color: '#FF3DCB' },
  { id: 'vault', pc: 'de.dennis.orbit-vault', title: 'Tresor', icon: 'lock', color: '#3DFFA2' },
  { id: 'scans', pc: 'de.dennis.orbit-scans', title: 'Scans', icon: 'camera', color: '#FFD24A', hidden: true },
];
export const addonById = (id) => ADDONS.find((a) => a.id === id);

const AAD = new TextEncoder().encode('orbit-addon-sync-1');
const ITER = 210000;
const DATA_VERSION = 1;

// ---------------------------------------------------------------- Verschlüsselung (wie SyncCrypto am PC)

const b64 = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveGcm(pass, salt, iter) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptSync(pass, plainText, device, time = new Date()) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveGcm(pass, salt, ITER);
  const out = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: AAD, tagLength: 128 }, key, new TextEncoder().encode(plainText)));
  const ct = out.slice(0, out.length - 16);
  const tag = out.slice(out.length - 16);
  return JSON.stringify({ v: 1, kdf: 'pbkdf2-sha256', iter: ITER, salt: b64(salt), nonce: b64(nonce), tag: b64(tag), data: b64(ct), time: time.toISOString(), device });
}

export class SyncError extends Error {}

export async function decryptSync(pass, text) {
  let o;
  try { o = JSON.parse(text); } catch { throw new SyncError('Die Abgleichdatei in der Cloud ist unlesbar. Es wurde nichts verändert.'); }
  try {
    const iter = Number(o.iter);
    if (!(iter >= 1000 && iter <= 5000000)) throw new Error('iter');
    const key = await deriveGcm(pass, unb64(o.salt), iter);
    const ct = unb64(o.data), tag = unb64(o.tag);
    const joined = new Uint8Array(ct.length + tag.length);
    joined.set(ct); joined.set(tag, ct.length);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(o.nonce), additionalData: AAD, tagLength: 128 }, key, joined);
    return { text: new TextDecoder().decode(plain), time: Date.parse(o.time) || 0, device: o.device || '?' };
  } catch (e) {
    if (e instanceof SyncError) throw e;
    throw new SyncError('Das Sync-Passwort passt nicht zu den Daten in der Cloud (oder die Datei ist beschädigt). Es wurde nichts verändert.');
  }
}

// ---------------------------------------------------------------- Zusammenführen (rein, testbar)

const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const eq = (a, b, k) => has(a, k) === has(b, k) && (!has(a, k) || a[k] === b[k]);
const same = (a, b) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => eq(a, b, k));
const parseList = (s) => { try { const x = JSON.parse(s); return Array.isArray(x) && x.every((e) => e && typeof e === 'object' && !Array.isArray(e) && e.id != null) ? x : null; } catch { return null; } };
const js = (x) => JSON.stringify(x);

/** Listen mit id: je Eintrag dreifach zusammenführen. Gibt den neuen Text zurück oder null (dann gilt die Gesamtregel). */
export function mergeRecords(lText, rText, bText, localIsNewer) {
  const l = parseList(lText), r = parseList(rText);
  if (!l || !r) return null;
  const b = bText != null ? parseList(bText) : null;
  const L = new Map(l.map((e) => [String(e.id), e])), R = new Map(r.map((e) => [String(e.id), e]));
  const B = new Map((b || []).map((e) => [String(e.id), e]));
  const order = [...R.keys(), ...[...L.keys()].filter((k) => !R.has(k))];
  for (const k of B.keys()) if (!order.includes(k)) order.push(k);
  const out = [];
  for (const id of order) {
    const lv = L.get(id), rv = R.get(id), bv = B.get(id);
    const e = (x, y) => (x === undefined && y === undefined) || (x !== undefined && y !== undefined && js(x) === js(y));
    let pick;
    if (e(lv, rv)) pick = lv;
    else if (b && e(lv, bv)) pick = rv;
    else if (b && e(rv, bv)) pick = lv;
    else if (lv === undefined) pick = rv;
    else if (rv === undefined) pick = lv;
    else pick = localIsNewer ? lv : rv;
    if (pick !== undefined) out.push(pick);
  }
  return js(out);
}

/** Dreiwege-Zusammenführung je Schlüssel (wie PluginSyncEngine.Merge); conflicts bekommt die unterlegene Fassung. */
export function merge(local, remote, base, localIsNewer, conflicts = []) {
  if (!remote) return { ...local };
  const out = {};
  const keys = new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(base || {})]);
  for (const k of keys) {
    let present = true, pick;
    if (eq(local, remote, k)) { present = has(local, k); pick = local[k]; }
    else if (base && eq(local, base, k)) { present = has(remote, k); pick = remote[k]; }
    else if (base && eq(remote, base, k)) { present = has(local, k); pick = local[k]; }
    else if (!has(local, k)) pick = remote[k];
    else if (!has(remote, k)) pick = local[k];
    else {
      const m = mergeRecords(local[k], remote[k], base?.[k], localIsNewer);
      if (m != null) pick = m;
      else {
        pick = localIsNewer ? local[k] : remote[k];
        conflicts.push({ key: k, value: localIsNewer ? remote[k] : local[k], at: Date.now() });
      }
    }
    if (present) out[k] = pick;
  }
  return out;
}

// ---------------------------------------------------------------- Lokale Daten je Add-on

const mem = new Map();    // pcId → { data, base, rev, lastSync, error, conflicts, readOnly, lastEdit }
const listeners = new Set();
export const onAddon = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = (id, kind = 'status') => listeners.forEach((fn) => { try { fn(id, kind); } catch (e) { console.error(e); } });

async function persist(a) { await kv.set('addon:' + a.pc, { data: a.data, base: a.base, lastSync: a.lastSync, conflicts: a.conflicts, lastEdit: a.lastEdit, meta: a.meta, migrated: a.migrated }); }

export async function openAddon(id) {
  const meta = addonById(id);
  if (mem.has(meta.pc)) return mem.get(meta.pc).api;
  const saved = (await kv.get('addon:' + meta.pc)) || {};
  const a = { pc: meta.pc, id, data: saved.data || {}, base: saved.base || null, meta: saved.meta || null, migrated: !!saved.migrated, lastSync: saved.lastSync || null, conflicts: saved.conflicts || [], lastEdit: saved.lastEdit || 0, rev: 0, error: null, busy: false, readOnly: false };
  const api = {
    id, pc: meta.pc,
    /** Wert eines Schlüssels als JS-Wert (Listen/Objekte), sonst fallback. */
    get(key, fallback = null) {
      const raw = a.data[key];
      if (raw == null || raw === '') return fallback;
      try { return JSON.parse(raw); } catch { return fallback; }
    },
    raw: (key) => a.data[key] ?? null,
    async set(key, value) {
      if (a.readOnly) throw new Error('Diese Daten stammen aus einer neueren Version von Orbit. Bitte erst die App aktualisieren.');
      snapshotLocal(a.pc, a.data).catch(() => {});
      a.data[key] = typeof value === 'string' ? value : js(value);
      if (!has(a.data, 'dataVersion')) a.data.dataVersion = String(DATA_VERSION);
      a.rev++; a.lastEdit = Date.now();
      await persist(a);
      emit(id, 'data');
      scheduleSync(id, 600);
    },
    async remove(key) { delete a.data[key]; a.rev++; a.lastEdit = Date.now(); await persist(a); emit(id, 'data'); scheduleSync(id, 600); },
    status: () => ({ lastSync: a.lastSync, error: a.error, busy: a.busy, readOnly: a.readOnly, conflicts: a.conflicts.length }),
    hasData: () => Object.keys(a.data).length > 0,
    internal: a,
  };
  a.api = api;
  mem.set(meta.pc, a);
  checkVersion(a);
  return api;
}

function checkVersion(a) {
  const v = Number(a.data.dataVersion);
  a.readOnly = Number.isFinite(v) && v > DATA_VERSION;
}

// ---------------------------------------------------------------- Sync-Passwort

let passCache;
export async function getSyncPass() {
  if (passCache === undefined) passCache = (await loadSecret('addonSyncPass'))?.pass || '';
  return passCache;
}
export async function setSyncPass(pass) {
  passCache = pass || '';
  if (pass) await saveSecret('addonSyncPass', { pass }); else await deleteSecret('addonSyncPass');
}

// ---------------------------------------------------------------- Abgleich

// Quelle und Ordner des Abgleichs (nur auf diesem Gerät): Geräte mit demselben Ordner gleichen sich untereinander ab.
export const DEFAULT_FOLDER = 'Orbit_NAS/Orbit Struktur/Einstellungs Sync';
let syncLoc = { cloudId: null, folder: DEFAULT_FOLDER };
export const normFolder = (f) => { const t = String(f || '').replace(/\\/g, '/').split('/').map((x) => x.trim()).filter(Boolean).join('/'); return t || DEFAULT_FOLDER; };
export async function loadSyncLoc() { const s = await kv.get('addon:sync'); if (s) syncLoc = { cloudId: s.cloudId || null, folder: normFolder(s.folder) }; return syncLoc; }
export const getSyncLoc = () => syncLoc;
/** Quelle/Ordner festlegen. Der gemeinsame Stand wird vergessen, damit der erste Abgleich nur zusammenführt (nichts gilt als „gelöscht“). */
export async function setSyncLoc(cloudId, folder) {
  syncLoc = { cloudId: cloudId || null, folder: normFolder(folder) };
  await kv.set('addon:sync', syncLoc);
  for (const m of ADDONS) { const api = await openAddon(m.id); api.internal.base = null; api.internal.meta = null; api.internal.migrated = false; await persist(api.internal); emit(m.id, 'status'); }
}
const remoteDir = (pc) => '/' + syncLoc.folder + '/addons/' + pc;
const remoteFile = (pc) => remoteDir(pc) + '/daten.orbit';
const running = new Map();
const timers = new Map();

async function mainSrc() {
  await ensureKeys();
  await loadSyncLocOnce();
  const chosen = syncLoc.cloudId ? connById(syncLoc.cloudId) : null;
  const c = chosen && chosen.type !== 'demo' ? chosen : mainConnection();
  if (!c || c.type === 'demo') return null;
  return source(c.id);
}

/** Quelle des Abgleichs (gewählte Cloud, sonst Haupt-Cloud) – auch für die Einstellungsdatei. */
export const syncSource = () => mainSrc();
/** Abgleich-Ordner samt Unterordnern anlegen (Einstellungsdatei liegt direkt darin). */
export async function ensureSyncFolder(src) {
  let cur = '';
  for (const name of syncLoc.folder.split('/')) {
    try { await src.mkdir(cur || '/', name); } catch { /* gibt es schon */ }
    cur += '/' + name;
  }
}
export const settingsFilePath = () => '/' + syncLoc.folder + '/einstellungen.json';

async function ensureDirs(src, pc) {
  let cur = '';
  for (const name of [...syncLoc.folder.split('/'), 'addons', pc, 'versionen']) {
    try { await src.mkdir(cur || '/', name); } catch { /* gibt es schon */ }
    cur += '/' + name;
  }
}

/** Passwort vergessen: verschlüsselte Cloud-Dateien aller Add-ons beiseitelegen (bleiben in „zurueckgesetzt“ erhalten), Passwort vergessen.
 *  Lokale Daten bleiben unverändert und gehen mit dem neuen Passwort wieder hoch. Gibt die Zahl beiseitegelegter Dateien zurück. */
export async function resetCloudSync() {
  const src = await mainSrc();
  if (!src) throw new SyncError('Keine Haupt-Cloud angemeldet.');
  let n = 0;
  for (const meta of ADDONS) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    let top = [];
    try { top = await src.list(remoteDir(meta.pc)); } catch { top = []; }
    const aside = top.filter((x) => (x.isFolder && (x.name === 'eintraege' || x.name === 'werte')) || (!x.isFolder && x.name === 'daten.orbit'));
    if (aside.length) {
      await mkdirs(src, [...syncLoc.folder.split('/'), 'addons', meta.pc, 'zurueckgesetzt', stamp]);
      const to = remoteDir(meta.pc) + '/zurueckgesetzt/' + stamp;
      for (const it of aside) await src.move(it, to);
      n++;
    }
    const api = await openAddon(meta.id), a = api.internal;
    a.base = null; a.meta = null; a.migrated = false; a.lastSync = null; a.error = null;
    await persist(a);
    emit(meta.id, 'status');
  }
  await setSyncPass('');
  return n;
}

/** „Schnitt“: den Stand dieses Geräts als alleinigen Stand in die Cloud schreiben (ersetzt die Cloud-Dateien, kein Zusammenführen).
 *  Die bisherige Cloud-Datei bleibt in „zurueckgesetzt“ erhalten. Gibt die Zahl überschriebener Add-ons zurück. */
export async function overwriteCloudFromHere() {
  const pass = await getSyncPass();
  if (!pass) throw new SyncError('Bitte zuerst ein Sync-Passwort eintragen.');
  const src = await mainSrc();
  if (!src) throw new SyncError('Keine Haupt-Cloud angemeldet.');
  let n = 0;
  for (const meta of ADDONS) {
    const api = await openAddon(meta.id), a = api.internal;
    if (meta.id === 'fuel') { try { await (await import('./fuel.js')).materialize(api); } catch { /* egal */ } }
    if (!Object.keys(a.data).length) continue;
    await snapshotLocal(a.pc, a.data, 'Vor Überschreiben der Cloud', true);
    const L = await listRecs(src, a.pc);
    const pushed = await pushRecs(src, a.pc, pass, a.data, L, a.meta);
    a.meta = pushed.meta; a.migrated = true; a.base = { ...a.data }; a.lastSync = Date.now(); a.error = null;
    await persist(a); emit(meta.id, 'status');
    n++;
  }
  return n;
}

// ---------------------------------------------------------------- Einzeldatei-Abgleich (ab 4.0)
// Jeder Eintrag (Auto, Tankung, Notiz …) ist eine eigene verschlüsselte Datei:
//   <Ordner>/addons/<pc-id>/eintraege/<Schlüssel>/<id>.<Zeit>.orbit   (.del = gelöscht)   für Listen mit id
//   <Ordner>/addons/<pc-id>/werte/<Schlüssel>.<Zeit>.orbit                                  für einzelne Werte
// Geschrieben werden nur geänderte Einträge, nie der ganze Bestand. Die alte Gesamtdatei daten.orbit wird nur noch einmal zum Übernehmen gelesen.

const REC_AAD = new TextEncoder().encode('orbit-rec-1');
const RECRE = /^(.*)\.(\d{10,})\.(orbit|del)$/;
const safeName = (x) => String(x).replace(/[^A-Za-z0-9_-]/g, (c) => (c.charCodeAt(0) < 256 ? '~' + c.charCodeAt(0).toString(16).padStart(2, '0') : '~u' + c.charCodeAt(0).toString(16).padStart(4, '0')));
const unsafeName = (x) => String(x).replace(/~u([0-9a-f]{4})|~([0-9a-f]{2})/g, (_, u, h) => String.fromCharCode(parseInt(u || h, 16)));
const canon = (x) => (Array.isArray(x) ? x.map(canon) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x);
const canonText = (s) => { try { return js(canon(JSON.parse(s))); } catch { return String(s); } };
const asList = (s) => { const l = parseList(s); if (!l) return null; const ids = new Set(l.map((e) => String(e.id))); return ids.size === l.length && !ids.has('') ? l : null; };
const recKeys = new Map();
async function recKey(pass, pc) {
  const ck = pass + '\n' + pc;
  if (!recKeys.has(ck)) {
    const salt = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('orbit-rec-1|' + pc))).slice(0, 16);
    recKeys.set(ck, await deriveGcm(pass, salt, ITER));
  }
  return recKeys.get(ck);
}
async function encRec(pass, pc, obj) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const out = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: REC_AAD, tagLength: 128 }, await recKey(pass, pc), new TextEncoder().encode(js(obj))));
  return js({ v: 2, nonce: b64(nonce), tag: b64(out.slice(out.length - 16)), data: b64(out.slice(0, out.length - 16)), device: devName() });
}
async function decRec(pass, pc, text) {
  try {
    const o = JSON.parse(text);
    const ct = unb64(o.data), tag = unb64(o.tag);
    const joined = new Uint8Array(ct.length + tag.length); joined.set(ct); joined.set(tag, ct.length);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(o.nonce), additionalData: REC_AAD, tagLength: 128 }, await recKey(pass, pc), joined);
    return JSON.parse(new TextDecoder().decode(plain));
  } catch { throw new SyncError('Das Sync-Passwort passt nicht zu den Daten in der Cloud (oder eine Datei ist beschädigt). Es wurde nichts verändert.'); }
}
async function pool(tasks, n = 6) {
  const out = new Array(tasks.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, async () => { while (i < tasks.length) { const k = i++; out[k] = await tasks[k](); } }));
  return out;
}
const mkdirs = async (src, parts) => { let cur = ''; for (const n of parts) { try { await src.mkdir(cur || '/', n); } catch { /* gibt es schon */ } cur += '/' + n; } };

/** Einzeldateien in der Cloud auflisten. any = es gibt schon welche. */
async function listRecs(src, pc) {
  const root = remoteDir(pc);
  const out = { any: false, lists: new Map(), vals: new Map(), top: [] };
  try { out.top = await src.list(root); } catch { out.top = []; }
  const folder = (n) => out.top.find((x) => x.name === n && x.isFolder);
  const add = (map, id, it, m) => {
    const e = map.get(id) || { best: null, all: [] };
    const v = { t: Number(m[2]), del: m[3] === 'del', item: it };
    e.all.push(v); if (!e.best || v.t > e.best.t) e.best = v;
    map.set(id, e);
  };
  if (folder('eintraege')) {
    out.any = true;
    const kd = await src.list(root + '/eintraege');
    await pool(kd.filter((f) => f.isFolder).map((f) => async () => {
      const map = new Map();
      for (const it of await src.list(root + '/eintraege/' + f.name)) { const m = RECRE.exec(it.name); if (m) add(map, unsafeName(m[1]), it, m); }
      out.lists.set(unsafeName(f.name), map);
    }));
  }
  if (folder('werte')) {
    out.any = true;
    for (const it of await src.list(root + '/werte')) { const m = RECRE.exec(it.name); if (m) add(out.vals, unsafeName(m[1]), it, m); }
  }
  return out;
}

/** Aus den Einzeldateien den Gesamtstand (Schlüssel → Text) bauen. Unveränderte Einträge kommen aus dem Zwischenspeicher (base + meta), nur Neues wird geladen. */
async function assembleRemote(src, pc, pass, L, base, meta) {
  const remote = {}; let newest = 0; const jobs = [];
  for (const [key, map] of L.lists) {
    const bl = has(base, key) ? asList(base[key]) : null;
    const bm = new Map((bl || []).map((e) => [String(e.id), e]));
    const recs = [];
    for (const [id, e] of [...map.entries()].sort((a, b) => a[1].best.t - b[1].best.t || (a[0] < b[0] ? -1 : 1))) {
      newest = Math.max(newest, e.best.t);
      if (e.best.del) continue;
      const slot = { id }; recs.push(slot); e.slot = slot;
      const cached = meta?.L?.[key]?.[id] === e.best.t ? bm.get(id) : undefined;
      if (cached !== undefined) slot.rec = cached;
      else jobs.push(async () => { slot.rec = (await decRec(pass, pc, await src.readText(e.best.item.path))).v; });
    }
    remote['\u0000L' + key] = recs;
  }
  for (const [key, e] of L.vals) {
    newest = Math.max(newest, e.best.t);
    if (e.best.del) continue;
    const cached = meta?.V?.[key] === e.best.t && has(base, key) ? base[key] : undefined;
    if (cached !== undefined) e.val = cached;
    else jobs.push(async () => { e.val = (await decRec(pass, pc, await src.readText(e.best.item.path))).v; });
  }
  await pool(jobs);
  const out = {};
  for (const k of Object.keys(remote)) out[k.slice(2)] = js(remote[k].map((x) => x.rec).filter((x) => x !== undefined));
  for (const [key, e] of L.vals) if (!e.best.del && e.val !== undefined) out[key] = e.val;
  for (const [key, map] of L.lists) for (const [, e] of map) if (!e.best.del && e.slot) e.json = canonText(js(e.slot.rec));
  return { remote: out, newest };
}

/** Sicherheitsstopp: würde dieser Abgleich viele Einträge auf einmal löschen (hier oder in der Cloud), passiert nichts, bis der Nutzer es bestätigt. */
function bulkDeleteCheck(local, merged, L) {
  const lines = [];
  for (const [key, val] of Object.entries(local)) {
    const l = asList(val); if (!l || l.length < 2) continue;
    const m = has(merged, key) ? asList(merged[key]) : [];
    const ids = new Set((m || []).map((e) => String(e.id)));
    const gone = l.filter((e) => !ids.has(String(e.id))).length;
    if (gone >= 2 && gone >= l.length / 2) lines.push(`${gone} von ${l.length} Einträgen („${key}“) würden hier gelöscht`);
  }
  for (const [key, val] of Object.entries(local)) {
    if (asList(val) || val == null || val === '' || val === '[]' || val === '{}') continue;
    const m = has(merged, key) ? merged[key] : null;
    if (m == null || m === '' || m === '[]') lines.push(`„${key}“ würde hier geleert`);
  }
  for (const [key, map] of L ? L.lists : []) {
    const live = [...map.values()].filter((e) => !e.best.del).length; if (live < 2) continue;
    const m = has(merged, key) ? asList(merged[key]) : [];
    const ids = new Set((m || []).map((e) => String(e.id)));
    const gone = [...map.entries()].filter(([id, e]) => !e.best.del && !ids.has(id)).length;
    if (gone >= 2 && gone >= live / 2) lines.push(`${gone} von ${live} Einträgen („${key}“) würden in der Cloud gelöscht`);
  }
  return lines;
}
export class BulkDeleteError extends SyncError {}

/** Geänderte Einträge schreiben (neue Datei, danach ältere Fassungen derselben Id entfernen). Gibt die Zahl geschriebener Dateien zurück. */
async function pushRecs(src, pc, pass, merged, L, meta) {
  const root = remoteDir(pc);
  const ops = [];
  const made = new Set();
  const dir = async (parts) => { const k = parts.join('/'); if (made.has(k)) return; made.add(k); await mkdirs(src, [...syncLoc.folder.split('/'), 'addons', pc, ...parts]); };
  for (const [key, val] of Object.entries(merged)) {
    const lst = asList(val);
    if (lst) {
      const cur = L?.lists.get(key) || new Map();
      const ids = new Set();
      for (const rec of lst) {
        const id = String(rec.id); ids.add(id);
        const e = cur.get(id);
        if (!e || e.best.del || e.json !== canonText(js(rec))) ops.push({ L: true, key, id, e, rec });
      }
      for (const [id, e] of cur) if (!ids.has(id) && !e.best.del) ops.push({ L: true, key, id, e, del: true });
    } else {
      const e = L?.vals.get(key);
      if (!e || e.best.del || e.val !== val) ops.push({ L: false, key, id: key, e, rec: val });
    }
  }
  const nm = { L: {}, V: {} };
  for (const [key, map] of L?.lists || []) for (const [id, e] of map) if (!e.best.del) (nm.L[key] ||= {})[id] = e.best.t;
  for (const [key, e] of L?.vals || []) if (!e.best.del) nm.V[key] = e.best.t;
  let n = 0;
  await pool(ops.map((o) => async () => {
    const t = Math.max(Date.now(), (o.e?.best?.t || 0) + 1);
    const sub = o.L ? ['eintraege', safeName(o.key)] : ['werte'];
    await dir(sub);
    const path = root + '/' + sub.join('/') + '/' + safeName(o.id) + '.' + t + (o.del ? '.del' : '.orbit');
    await src.writeText(path, await encRec(pass, pc, o.del ? { id: o.id, key: o.key, t, del: true } : { id: o.id, key: o.key, t, v: o.rec }));
    if (!o.del) for (const old of o.e?.all || []) { try { await src.remove(old.item); } catch { /* bleibt eben liegen */ } }
    if (o.L) { if (o.del) delete nm.L[o.key]?.[o.id]; else (nm.L[o.key] ||= {})[o.id] = t; } else nm.V[o.key] = t;
    n++;
  }), 5);
  return { n, meta: nm };
}

const lastDaily = new Map();
/** Pro Tag ein vollständiger Stand (staende/JJJJMMTT.orbit, nie gelöscht). */
async function dailySnapshot(src, pc, pass, data) {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  if (lastDaily.get(pc) === day || !Object.keys(data).length) return;
  const dir = remoteDir(pc) + '/staende';
  let have = [];
  try { have = await src.list(dir); } catch { have = []; }
  if (!have.some((x) => x.name === day + '.orbit')) {
    await mkdirs(src, [...syncLoc.folder.split('/'), 'addons', pc, 'staende']);
    await src.writeText(dir + '/' + day + '.orbit', await encryptSync(pass, js({ speicher: data }), devName()));
  }
  lastDaily.set(pc, day);
}

// ---------------------------------------------------------------- Frühere Stände (lokal + Cloud) und Abgleich-Protokoll

const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const SNAP_MIN_GAP = 30 * 60 * 1000;
/** Lokalen Stand des Add-ons sichern (nie gelöscht; höchstens ein automatischer Stand je 30 Minuten). */
export async function snapshotLocal(pc, data, label = 'Automatisch', force = false) {
  if (!data || !Object.keys(data).length) return;
  const list = (await kv.get('snap:' + pc)) || [];
  const last = list[list.length - 1];
  if (!force && last && Date.now() - last.t < SNAP_MIN_GAP && JSON.stringify(last.data) === JSON.stringify(data)) return;
  if (!force && last && Date.now() - last.t < SNAP_MIN_GAP) return;
  list.push({ t: Date.now(), label, data: { ...data } });
  await kv.set('snap:' + pc, list);
}
export async function localSnapshots(pc) { return ((await kv.get('snap:' + pc)) || []).slice().reverse(); }

const LOG_MAX = 150;
export async function logSync(id, text, kind = 'info') {
  try {
    const l = (await kv.get('sync:log')) || [];
    l.push({ t: Date.now(), id, text, kind });
    await kv.set('sync:log', l.slice(-LOG_MAX));
  } catch { /* egal */ }
}
export async function syncLog() { return ((await kv.get('sync:log')) || []).slice().reverse(); }

/** Stände in der Cloud (versionen/*.orbit), neueste zuerst. */
export async function cloudVersions(id) {
  const meta = addonById(id);
  const src = await mainSrc();
  if (!src) throw new SyncError('Keine Cloud angemeldet.');
  const out = [];
  for (const sub of ['staende', 'versionen']) {
    let items = [];
    try { items = await src.list(remoteDir(meta.pc) + '/' + sub); } catch { items = []; }
    for (const x of items) if (!x.isFolder && /\.orbit$/.test(x.name)) out.push({ name: x.name, path: remoteDir(meta.pc) + '/' + sub + '/' + x.name });
  }
  return out.sort((a, b) => (a.name < b.name ? 1 : -1));
}
export async function readCloudVersion(path) {
  const pass = await getSyncPass();
  if (!pass) throw new SyncError('Bitte zuerst ein Sync-Passwort eintragen.');
  const src = await mainSrc();
  const text = await src.readText(path);
  if (!text) throw new SyncError('Dieser Stand ist nicht mehr lesbar.');
  const d = await decryptSync(pass, text);
  const sp = JSON.parse(d.text)?.speicher;
  return { data: sp && typeof sp === 'object' ? sp : {}, time: d.time };
}
/** Früheren Stand wiederherstellen: aktuellen Stand zuerst sichern (lokal + Cloud), dann ersetzen und in die Cloud schreiben. */
export async function restoreAddon(id, data) {
  const meta = addonById(id);
  const api = await openAddon(id), a = api.internal;
  await snapshotLocal(meta.pc, a.data, 'Vor Wiederherstellung', true);
  const pass = await getSyncPass();
  const src = pass ? await mainSrc() : null;
  const before = { ...a.data };
  a.data = { ...data }; checkVersion(a); a.rev++; a.lastEdit = Date.now();
  if (src) {
    if (Object.keys(before).length) {
      await mkdirs(src, [...syncLoc.folder.split('/'), 'addons', meta.pc, 'staende']);
      await src.writeText(remoteDir(meta.pc) + '/staende/vor-wiederherstellung-' + stamp() + '.orbit', await encryptSync(pass, js({ speicher: before }), devName()));
    }
    // Cloud: der aktuelle Stand ist durch den Tagesstand/die Einzeldateien-Historie gesichert; Wiederherstellung schreibt die Einträge des alten Stands zurück, später gelöschte werden markiert
    const L = await listRecs(src, meta.pc);
    const pushed = await pushRecs(src, meta.pc, pass, a.data, L, a.meta);
    a.meta = pushed.meta; a.migrated = true;
    a.base = { ...a.data }; a.lastSync = Date.now(); a.error = null;
  }
  await persist(a); await applyShared(id, a.data); emit(id, 'data');
  await logSync(id, 'Früherer Stand wiederhergestellt' + (src ? ' und in die Cloud geschrieben' : ' (nur auf diesem Gerät)'), 'warn');
}

/** Änderung merken: abgeglichen wird erst beim App-Start, per „Jetzt abgleichen“ oder wenn die App in den Hintergrund geht (ein Lauf, eine Anmeldung). */
export function scheduleSync(id) { timers.set(id, true); }
export const hasPending = () => timers.size > 0;
/** Wartende Änderungen in EINEM Lauf hochladen, wenn die App verlassen wird. */
function flushPending() { if (!timers.size) return; const ids = [...timers.keys()]; timers.clear(); syncAll(ids).catch(() => {}); }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushPending(); });
window.addEventListener('pagehide', flushPending);

const lastCloudVer = new Map();
/** Jeden Cloud-Stand (höchstens alle 30 Minuten) als eigene Datei mit Zeitstempel behalten – wird nie gelöscht. */
async function cloudVersionMaybe(src, pc, text) {
  if (Date.now() - (lastCloudVer.get(pc) || 0) < SNAP_MIN_GAP) return;
  lastCloudVer.set(pc, Date.now());
  await src.writeText(remoteDir(pc) + '/versionen/mobil-' + stamp() + '.orbit', text);
}

/** Gleicht ein Add-on ab. Gibt { skipped } zurück, wenn kein Sync-Passwort oder keine Cloud da ist. */
export function syncAddon(id, opts = {}) {
  if (running.has(id)) return running.get(id);
  const p = (async () => {
    const api = await openAddon(id);
    const a = api.internal;
    a.busy = true; emit(id);
    try {
      const pass = await getSyncPass();
      if (!pass) return { skipped: 'Kein Sync-Passwort' };
      const src = await mainSrc();
      if (!src) return { skipped: 'Keine Cloud' };
      for (let attempt = 0; attempt < 3; attempt++) {
        const rev0 = a.rev;
        const L = await listRecs(src, a.pc);
        let remote = null, remoteTime = 0, fromLegacy = false;
        if (L.any) {
          const r = await assembleRemote(src, a.pc, pass, L, a.base, a.meta);
          remote = r.remote; remoteTime = r.newest;
        } else if (!a.migrated || !a.base) {
          // noch keine Einzeldateien: die alte Gesamtdatei einmal als Quelle übernehmen
          const legacy = await src.readText(remoteFile(a.pc));
          if (legacy) {
            const d = await decryptSync(pass, legacy);
            const sp = JSON.parse(d.text)?.speicher;
            remote = sp && typeof sp === 'object' ? sp : {};
            remoteTime = d.time; fromLegacy = true;
          }
        }
        if (remote && Number(remote.dataVersion) > DATA_VERSION) {
          a.data = { ...remote }; a.readOnly = true; a.lastSync = Date.now(); a.error = null; await persist(a); emit(id, 'data'); return { readOnly: true };
        }
        if (!remote && !Object.keys(a.data).length) { a.lastSync = Date.now(); a.error = null; return { nothing: true }; }
        const conflicts = [];
        const merged = merge(a.data, remote, fromLegacy ? null : a.base, a.lastEdit >= remoteTime, conflicts);
        const changesLocal = !same(merged, a.data);
        if (!opts.allowBulk) {
          const bad = bulkDeleteCheck(a.data, merged, L);
          if (bad.length) throw new BulkDeleteError('Sicherheitsstopp: ' + bad.join('; ') + '. Es wurde nichts verändert. Unter „Frühere Stände“ kannst du einen Stand zurückholen, oder die Löschung mit „Trotzdem abgleichen“ bestätigen.');
        }
        if (a.rev !== rev0) continue;          // inzwischen etwas geändert: nochmal
        if (changesLocal) await snapshotLocal(a.pc, a.data, 'Vor Abgleich', true);
        const pushed = await pushRecs(src, a.pc, pass, merged, L, a.meta);
        if (a.rev !== rev0) { a.meta = pushed.meta; continue; }
        if (changesLocal) { a.data = merged; checkVersion(a); }
        a.meta = pushed.meta; a.migrated = true;
        await applyShared(id, a.data);
        a.base = { ...merged };
        a.lastSync = Date.now(); a.error = null;
        if (conflicts.length) a.conflicts = [...a.conflicts, ...conflicts].slice(-20);
        await persist(a);
        emit(id, changesLocal ? 'data' : 'status');
        try { await dailySnapshot(src, a.pc, pass, merged); } catch { /* nicht schlimm */ }
        const changesRemote = pushed.n > 0;
        if (changesLocal || changesRemote) await logSync(id, (fromLegacy ? 'Alte Gesamtdatei übernommen, ' : '') + (changesLocal ? 'Daten aus der Cloud übernommen' : '') + (changesLocal && changesRemote ? ', ' : '') + (changesRemote ? `${pushed.n} Eintrag/Einträge in die Cloud geschrieben` : '') + (conflicts.length ? ` (${conflicts.length} Konflikt(e))` : ''));
        return { pulled: changesLocal, pushed: changesRemote, conflicts: conflicts.length };
      }
      throw new SyncError('Die Daten ändern sich gerade – wird gleich erneut abgeglichen.');
    } catch (e) {
      a.error = e;
      if (e instanceof BulkDeleteError) a.guard = true;
      logSync(id, 'Fehler: ' + (e?.message || e), 'err');
      throw e;
    } finally {
      a.busy = false; running.delete(id); emit(id);
    }
  })();
  running.set(id, p);
  return p;
}

/** Von Hand abgleichen; bei einem Sicherheitsstopp (viele Löschungen) nachfragen und auf Wunsch trotzdem abgleichen. */
export async function syncByHand(id) {
  try { return await syncAddon(id); } catch (e) {
    if (!(e instanceof BulkDeleteError)) throw e;
    if (!(await confirmDialog(e.message.replace(/ Es wurde nichts verändert.*$/, ''), { title: 'Viele Löschungen', ok: 'Trotzdem abgleichen', danger: true }))) throw e;
    return syncAddon(id, { allowBulk: true });
  }
}

let allRun = null;
/** Alle Add-ons nacheinander (nie gleichzeitig) abgleichen; bei pCloud-Sperre sofort aufhören. */
export function syncAll(ids) {
  if (allRun) return allRun;
  allRun = (async () => {
    const out = {};
    for (const a of ADDONS) {
      if (ids && !ids.includes(a.id)) continue;
      try { out[a.id] = await syncAddon(a.id); } catch (e) { out[a.id] = { error: e }; if (e?.code === 4000) break; }
    }
    lastAll = Date.now();
    return out;
  })().finally(() => { allRun = null; });
  return allRun;
}
export function firstError(res) { return Object.values(res).find((r) => r?.error)?.error || null; }

let locLoaded = false;
async function loadSyncLocOnce() { if (!locLoaded) { locLoaded = true; await loadSyncLoc(); } }
let lastAll = Date.now();
/** Nur nach längerer Abwesenheit (über 15 Minuten) beim Zurückkehren in die App; kein Zeitgeber mehr. */
export function syncSoon() { if (document.visibilityState === 'visible' && Date.now() - lastAll > 15 * 60000) syncAll().catch(() => {}); }
document.addEventListener('visibilitychange', syncSoon);

// ---------------------------------------------------------------- Import aus dem Orbit-Export (Daten-*.zip)

/** Liest eine Export-ZIP (meta.json + speicher.json), ordnet sie dem Add-on zu und ergänzt die Daten (nichts wird überschrieben). */
export async function importExportZip(file) {
  const { firstFileFromZip } = await import('../unzip.js');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const dec = (u8) => JSON.parse(new TextDecoder().decode(u8).replace(/^\uFEFF/, ''));
  const meta = dec(await firstFileFromZip(bytes, 'meta.json'));
  const speicher = dec(await firstFileFromZip(bytes, 'speicher.json'));
  const addon = ADDONS.find((a) => a.pc === meta.id);
  if (!addon) throw new Error(`„${file.name}“ gehört zu keinem Add-on dieser App (${meta.name || meta.id}).`);
  const api = await openAddon(addon.id);
  let added = 0;
  for (const [k, v] of Object.entries(speicher)) {
    if (k === 'dataVersion') continue;
    const cur = api.raw(k);
    if (cur == null) { await api.set(k, v); added += parseList(v)?.length ?? 1; continue; }
    const l = parseList(cur), r = parseList(v);
    if (l && r) {
      const have = new Set(l.map((e) => String(e.id)));
      const extra = r.filter((e) => !have.has(String(e.id)));
      if (extra.length) { await api.set(k, js([...l, ...extra])); added += extra.length; }
    }
  }
  scheduleSync(addon.id, 500);
  return { addon, added };
}
