// Stände („Jetzt sichern“ / „Daten laden“): ein Stand ist EINE verschlüsselte Datei mit allen Add-ons und den Einstellungen.
//   <Abgleich-Ordner>/Staende/<JJJJMMTT-HHMMSS in UTC>-<Gerät>.orbit      Gerät: iPhone, iPad oder PC
// Inhalt (AES-256-GCM wie die Add-on-Dateien, Passwort = Sync-Passwort): {"v":1,"addons":{<pc-id>:{schlüssel:text}},"einstellungen":{…}}
// Gesichert wird nie automatisch über einen vorhandenen Stand hinweg: es entsteht immer eine neue Datei. Geladen wird nur auf Wunsch.

import { kv } from '../db.js';
import { source, connById } from '../sources/registry.js';
import * as settingsStore from '../store.js';
import { applyShared } from './prefs.js';
import { ADDONS, openAddon, persist, emit, checkVersion, mkdirs, snapshotLocal, encryptSync, decryptSync, getSyncPass, getSyncLoc, loadSyncLoc, syncSource, SyncError } from './store.js';

export class StandNewerError extends SyncError {
  constructor(stand) { super(`Auf einem anderen Gerät (${stand.device}) liegt ein neuerer Stand vom ${new Date(stand.time).toLocaleString('de-DE')}.`); this.stand = stand; }
}

export const STAND_DIR = 'Staende';
const NAME_RE = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(.+)\.orbit$/;
const pad = (n) => String(n).padStart(2, '0');
export const device = () => settingsStore.devName();
const nameFor = (t, dev) => { const d = new Date(t); return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}-${dev}.orbit`; };
export const parseName = (name) => { const m = NAME_RE.exec(name); return m ? { time: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]), device: m[7] } : null; };
const dirOf = (folder) => '/' + folder + '/' + STAND_DIR;

export const status = { lastSave: 0, error: null, notice: null, busy: false };
const listeners = new Set();
export const onStands = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const note = () => listeners.forEach((fn) => { try { fn(status); } catch (e) { console.error(e); } });

async function ctx() {
  const pass = await getSyncPass();
  if (!pass) throw new SyncError('Bitte zuerst ein Sync-Passwort eintragen (Einstellungen › Sichern und Laden).');
  await loadSyncLoc();
  const src = await syncSource();
  if (!src) throw new SyncError('Keine Cloud angemeldet.');
  return { pass, src, folder: getSyncLoc().folder };
}

/** Alle Daten dieses Geräts (Add-ons + Einstellungen) als ein Stand. */
export async function collect() {
  const addons = {};
  for (const m of ADDONS) {
    const api = await openAddon(m.id);
    if (m.id === 'fuel') { try { await (await import('./fuel.js')).materialize(api); } catch { /* egal */ } }
    if (Object.keys(api.internal.data).length) addons[m.pc] = { ...api.internal.data };
  }
  return { v: 1, addons, einstellungen: settingsStore.getDoc() };
}
const countOf = (addons) => Object.values(addons || {}).reduce((n, d) => n + Object.values(d).reduce((k, v) => { try { const x = JSON.parse(v); return k + (Array.isArray(x) ? x.length : 1); } catch { return k + 1; } }, 0), 0);
export const hasData = (c) => Object.keys(c.addons).length > 0;

export async function listStands() {
  const { src, folder } = await ctx();
  let items = [];
  try { items = await src.list(dirOf(folder)); } catch { items = []; }
  return items.filter((x) => !x.isFolder).map((x) => { const p = parseName(x.name); return p ? { name: x.name, path: dirOf(folder) + '/' + x.name, time: p.time, device: p.device, size: x.size || 0, item: x } : null; })
    .filter(Boolean).sort((a, b) => b.time - a.time);
}

const lastKey = 'stand:last';
const baseKey = 'stand:base';   // Daten des zuletzt gesicherten/geladenen Stands = Basis fürs Zusammenführen
export const lastStand = () => kv.get(lastKey);

/** Neueren Stand eines anderen Geräts suchen (neuer als der, den dieses Gerät zuletzt geladen oder geschrieben hat). */
export async function findNewer(stands) {
  const last = (await kv.get(lastKey)) || { time: 0 };
  const me = device();
  return (stands || await listStands()).find((s) => s.device !== me && s.time > last.time) || null;
}

let saving = null;
/** Neuen Stand schreiben. Liegt ein neuerer Stand eines anderen Geräts vor, wird nur mit force:true geschrieben (nach Laden/Zusammenführen). */
export function saveStand({ force = false, auto = false } = {}) {
  if (saving) return saving;
  saving = (async () => {
    status.busy = true; note();
    try {
      const { pass, src, folder } = await ctx();
      const data = await collect();
      if (!hasData(data)) { if (auto) return null; throw new SyncError('Es gibt noch keine Daten zum Sichern.'); }
      if (!force) { const newer = await findNewer(); if (newer) throw new StandNewerError(newer); }
      const t = Math.max(Date.now(), ((await kv.get(lastKey))?.time || 0) + 1000);   // nie denselben Dateinamen zweimal
      const name = nameFor(t, device());
      await mkdirs(src, [...folder.split('/'), STAND_DIR]);
      const text = await encryptSync(pass, JSON.stringify(data), device(), new Date(t));
      await src.writeText(dirOf(folder) + '/' + name, text);
      await kv.set(lastKey, { name, time: parseName(name).time });
      await kv.set(baseKey, data.addons);
      await kv.set('stand:dirty', false);
      dirty = false;
      status.lastSave = t; status.error = null; status.notice = null;
      let mirrorError = null;
      try { await mirrorWrite(name, text); } catch (e) { mirrorError = e; }
      autoPrune().catch(() => {});
      return { name, mirrorError };
    } catch (e) {
      if (e instanceof StandNewerError) status.notice = e.stand; else status.error = e;
      throw e;
    } finally { status.busy = false; saving = null; note(); }
  })();
  return saving;
}

// ---------------------------------------------------------------- Laden

export async function readStand(stand) {
  const { pass, src } = await ctx();
  const text = await src.readText(stand.path);
  if (!text) throw new SyncError('Dieser Stand ist nicht mehr lesbar.');
  const d = await decryptSync(pass, text);
  const j = JSON.parse(d.text);
  if (!j || typeof j !== 'object' || (j.v || 1) > 1) throw new SyncError('Dieser Stand stammt aus einer neueren Version von Orbit. Bitte erst die App aktualisieren.');
  return { addons: j.addons && typeof j.addons === 'object' ? j.addons : {}, einstellungen: j.einstellungen || null };
}

/** Wie viele Einträge hat der Stand, wie viele hat dieses Gerät? (für die Rückfrage beim Laden eines kleineren Stands) */
export async function compare(stand) {
  const inc = await readStand(stand);
  const cur = await collect();
  return { incoming: countOf(inc.addons), current: countOf(cur.addons), data: inc };
}

/** Stand übernehmen (ersetzt die Daten) oder – mit merge:true – mit den Daten dieses Geräts zusammenführen. Vorher wird der jetzige Stand lokal gesichert. */
export async function loadStand(stand, { merge: doMerge = false, data } = {}) {
  const inc = data || (await readStand(stand));
  const base = doMerge ? ((await kv.get(baseKey)) || null) : null;
  const newBase = {};
  for (const m of ADDONS) {
    // Add-ons, die im Stand gar nicht vorkommen, bleiben unverändert (nie leer überschreiben)
    if (!Object.prototype.hasOwnProperty.call(inc.addons, m.pc)) { const cur = (await openAddon(m.id)).internal.data; if (Object.keys(cur).length) newBase[m.pc] = { ...cur }; continue; }
    const api = await openAddon(m.id), a = api.internal;
    await snapshotLocal(a.pc, a.data, 'Vor Laden', true);
    const incoming = inc.addons[m.pc] || {};
    // Zusammenführen mit Basis (= zuletzt gesicherter/geladener Stand): so bleiben Löschungen gelöscht
    a.data = doMerge ? mergeStand(a.data, incoming, base ? (base[m.pc] || {}) : null) : { ...incoming };
    if (Object.keys(a.data).length) newBase[m.pc] = { ...a.data };
    checkVersion(a); a.rev++; a.lastEdit = Date.now(); a.base = { ...a.data }; a.lastSync = Date.now(); a.error = null;
    await persist(a); await applyShared(m.id, a.data); emit(m.id, 'data');
  }
  if (inc.einstellungen && !doMerge) await settingsStore.replaceDoc(inc.einstellungen);
  await kv.set(lastKey, { name: stand.name, time: stand.time });
  await kv.set(baseKey, doMerge ? inc.addons : newBase);
  status.notice = null; note();
}

/** Neueren Stand eines anderen Geräts mit den eigenen Daten mischen und danach als neuen Stand sichern. */
export async function mergeAndSave(stand) {
  await loadStand(stand, { merge: true });
  return saveStand({ force: true });
}

// ---------------------------------------------------------------- Verwalten

export async function deleteStands(stands) {
  const { src } = await ctx();
  let n = 0;
  for (const s of stands) { await src.remove(s.item); n++; }
  return n;
}
/** Alles löschen, was älter als N Tage ist; die neuesten 3 Stände bleiben immer. */
export async function pruneOlderThan(days) {
  const all = await listStands();
  const limit = Date.now() - days * 86400000;
  return deleteStands(all.slice(3).filter((s) => s.time < limit));
}

/** Zusammenführen ohne Datenverlust (gleich wie PC StandFile.MergeData):
 *  – Einträge, die es hier im letzten Stand (base) gab und die hier gelöscht wurden, bleiben gelöscht.
 *  – Alles andere aus dem fremden Stand kommt dazu; was dort fehlt, wird hier nie gelöscht.
 *  – Gleiche ID, beide anders: hat sich hier seit base nichts geändert, gilt der fremde Inhalt, sonst der eigene. */
export function mergeStand(local, remote, base) {
  const J = (v) => { try { return JSON.parse(v); } catch { return undefined; } };
  const isRec = (a) => Array.isArray(a) && a.every((x) => x && typeof x === 'object' && x.id != null);
  const out = { ...local };
  for (const [k, rv] of Object.entries(remote || {})) {
    const has = Object.prototype.hasOwnProperty.call(local, k);
    const inBase = base && Object.prototype.hasOwnProperty.call(base, k);
    if (!has) { if (!inBase) out[k] = rv; continue; }              // hier gelöscht -> bleibt gelöscht
    const L = J(local[k]), R = J(rv), B = inBase ? J(base[k]) : undefined;
    if (isRec(L) && isRec(R)) {
      const bMap = new Map(isRec(B) ? B.map((x) => [String(x.id), JSON.stringify(x)]) : []);
      const res = L.map((x) => {
        const r = R.find((y) => String(y.id) === String(x.id));
        return r && bMap.get(String(x.id)) === JSON.stringify(x) ? r : x;
      });
      const ids = new Set(L.map((x) => String(x.id)));
      for (const y of R) { const id = String(y.id); if (!ids.has(id) && !bMap.has(id)) { res.push(y); ids.add(id); } }
      out[k] = JSON.stringify(res);
    } else if (inBase && local[k] === base[k]) out[k] = rv;            // hier unverändert -> fremde Änderung übernehmen
  }
  return out;
}

/** Nach jedem Sichern: eigene Stände älter als 30 Tage löschen und höchstens 50 eigene behalten; die neuesten 3 bleiben immer. */
async function autoPrune() {
  const mine = (await listStands()).filter((s) => s.device === device());
  const limit = Date.now() - 30 * 86400000;
  const old = mine.filter((s, i) => i >= 3 && (s.time < limit || i >= 50));
  if (old.length) await deleteStands(old);
}

// ---------------------------------------------------------------- Zusätzlich spiegeln

export const getMirror = async () => (await kv.get('stand:mirror')) || null;
export const setMirror = (m) => kv.set('stand:mirror', m && m.cloudId ? { cloudId: m.cloudId, folder: String(m.folder || 'Orbit Stände').replace(/\\/g, '/').split('/').map((x) => x.trim()).filter(Boolean).join('/') || 'Orbit Stände' } : null);
async function mirrorWrite(name, text) {
  const m = await getMirror();
  if (!m || !connById(m.cloudId)) return;
  const src = await source(m.cloudId);
  await mkdirs(src, m.folder.split('/'));
  await src.writeText('/' + m.folder + '/' + name, text);
}

// ---------------------------------------------------------------- Selbsttätig sichern (nach Änderungen, gesammelt)

let dirty = false, timer = null;
const DELAY = 90000;
export function markChanged() {
  dirty = true; kv.set('stand:dirty', true).catch(() => {});
  clearTimeout(timer); timer = setTimeout(autoSave, DELAY);
}
export async function autoSave() {
  clearTimeout(timer); timer = null;
  if (!dirty) return;
  try { await saveStand({ auto: true }); } catch (e) { if (!(e instanceof StandNewerError)) console.warn('Sichern:', e); }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && dirty) autoSave(); });
window.addEventListener('pagehide', () => { if (dirty) autoSave(); });

/** Beim App-Start: liegt ein neuerer Stand eines anderen Geräts vor? Offene Änderungen vom letzten Mal sichern. */
export async function startup() {
  try {
    if (!(await getSyncPass())) return null;
    dirty = !!(await kv.get('stand:dirty'));
    const newer = await findNewer();
    status.notice = newer; note();
    if (dirty && !newer) autoSave();
    return newer;
  } catch (e) { status.error = e; note(); return null; }
}
