// Kassenbuch (Handy 5.0): jede Änderung wird zu einer kleinen Buchung, die nie überschrieben oder gelöscht wird.
// Ablage: <Abgleich-Ordner>/Kassenbuch/<JJJJMMTT-HHMMSS>-<Gerät>-<Kennung>.orbitlog – je Gerät und Tag eine verschlüsselte Datei
// (AES-GCM wie die Stände, Passwort = Sync-Passwort). Jedes Gerät liest alle Dateien der anderen Geräte und rechnet daraus den Stand.

import { kv } from '../db.js';
import { ADDONS, openAddon, persist, emit, checkVersion, mkdirs, snapshotLocal, encryptSync, decryptSync, getSyncPass, getSyncLoc, loadSyncLoc, syncSource, SyncError } from './store.js';
import { applyShared } from './prefs.js';
import { collect, device, logEntry, listStands, readStand } from './stands.js';
import { diff, fold, materialize, countDiff } from './ledger-core.js';

export const DIR = 'Kassenbuch';
const KEY = 'ledger';
const SEP = '\u0001';
export const status = { busy: false, error: null, lastSync: 0, bulk: [], pending: false };
const listeners = new Set();
export const onLedger = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const note = () => listeners.forEach((fn) => { try { fn(status); } catch (e) { console.error(e); } });

const pad = (n) => String(n).padStart(2, '0');
const stampOf = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
const dayOf = (name) => name.slice(0, 8);
const rid = () => [...crypto.getRandomValues(new Uint8Array(3))].map((b) => b.toString(16).padStart(2, '0')).join('');

async function load() {
  const l = (await kv.get(KEY)) || {};
  return { id: l.id || rid(), base: l.base || null, own: l.own || [], files: l.files || {}, first: l.first ?? !l.base };
}
const save = (l) => kv.set(KEY, l);

const dirOf = (folder) => '/' + folder + '/' + DIR;
export const lastSyncTime = async () => (await kv.get('ledger:last')) || 0;

async function ctx() {
  const pass = await getSyncPass();
  if (!pass) throw new SyncError('Bitte zuerst ein Sync-Passwort eintragen (Einstellungen › Abgleich).');
  await loadSyncLoc();
  const src = await syncSource();
  if (!src) throw new SyncError('Keine Cloud angemeldet.');
  return { pass, src, folder: getSyncLoc().folder };
}

const allEntries = (l) => [...l.own.flatMap((f) => f.entries), ...Object.values(l.files).flat()];

async function applyData(newData, { force = false } = {}) {
  for (const m of ADDONS) {
    const api = await openAddon(m.id), a = api.internal;
    const data = newData[m.pc] || {};
    if (JSON.stringify(data) === JSON.stringify(a.data)) continue;
    await snapshotLocal(m.pc, a.data, 'Vor Abgleich', force);
    a.data = { ...data };
    checkVersion(a); a.rev++; a.lastEdit = Date.now(); a.base = { ...a.data }; a.lastSync = Date.now(); a.error = null;
    await persist(a); await applyShared(m.id, a.data); emit(m.id, 'data');
  }
}

async function upload(l, c) {
  for (const f of l.own) {
    if (f.up) continue;
    const text = await encryptSync(c.pass, JSON.stringify({ v: 1, s: l.id, d: device(), entries: f.entries }), device(), new Date());
    await mkdirs(c.src, [...c.folder.split('/'), DIR]);
    await c.src.writeText(dirOf(c.folder) + '/' + f.name, text);
    f.up = true;
  }
}

async function pull(l, c) {
  let items = [];
  try { items = await c.src.list(dirOf(c.folder)); } catch { items = []; }
  const yesterday = stampOf(new Date(Date.now() - 86400000)).slice(0, 8);
  let n = 0;
  for (const it of items) {
    if (it.isFolder || !it.name.endsWith('.orbitlog') || it.name.endsWith('-' + l.id + '.orbitlog')) continue;
    if (l.files[it.name] && dayOf(it.name) < yesterday) continue;   // ältere Tagesdateien ändern sich nicht mehr
    const text = await c.src.readText(dirOf(c.folder) + '/' + it.name);
    if (!text) continue;
    const j = JSON.parse((await decryptSync(c.pass, text)).text);
    if (!j || !Array.isArray(j.entries)) throw new SyncError('Eine Datei im Kassenbuch ist unlesbar: ' + it.name);
    if (!l.files[it.name] || l.files[it.name].length !== j.entries.length) n++;
    l.files[it.name] = j.entries;
  }
  return n;
}

function append(l, entries) {
  if (!entries.length) return;
  const today = stampOf(new Date()).slice(0, 8);
  let f = l.own[l.own.length - 1];
  if (!f || dayOf(f.name) !== today) { f = { name: `${stampOf(new Date())}-${device()}-${l.id}.orbitlog`, entries: [], up: false }; l.own.push(f); }
  f.entries.push(...entries); f.up = false;
}

let running = null, again = null;
/** Abgleichen: eigene Änderungen buchen, hochladen, fremde Buchungen holen, Stand berechnen und übernehmen. */
export function syncNow(opts = {}) {
  if (running) { again = { ...(again || {}), ...opts, confirm: new Set([...(again?.confirm || []), ...(opts.confirm || [])]), restore: new Set([...(again?.restore || []), ...(opts.restore || [])]) }; return running; }
  running = (async () => {
    status.busy = true; note();
    try {
      let result = { changed: false, merged: 0 };
      for (let round = 0; round < 3; round++) {
        const c = await ctx();
        const l = await load();
        const cur = (await collect()).addons;
        const first = l.base === null;
        const allow = new Set(opts.confirm || []);
        const d = diff(l.base || {}, cur, { t: first ? 1 : Date.now(), s: l.id, d: device() }, allow);
        append(l, d.entries);
        let upErr = null;
        try { await upload(l, c); } catch (e) { upErr = e; }
        let pulled = 0, pullErr = null;
        try { pulled = await pull(l, c); } catch (e) { pullErr = e; }
        if (pullErr instanceof SyncError) { await save(l); throw pullErr; }
        const skip = new Set(d.bulk.map((b) => b.a + SEP + b.k));
        for (const k of opts.restore || []) skip.delete(k);
        const state = fold(allEntries(l));
        const out = materialize(state, cur, skip);
        // inzwischen am Gerät geändert? Dann noch einmal von vorn, damit nichts überschrieben wird
        const cur2 = (await collect()).addons;
        if (JSON.stringify(cur2) !== JSON.stringify(cur)) { await save(l); continue; }
        const changed = JSON.stringify(out) !== JSON.stringify(cur);
        if (changed) await applyData(out);
        const base = JSON.parse(JSON.stringify(out));
        for (const b of d.bulk) if (skip.has(b.a + SEP + b.k)) { (base[b.a] ||= {}); const old = (l.base || {})[b.a]?.[b.k]; if (old === undefined) delete base[b.a][b.k]; else base[b.a][b.k] = old; }
        l.base = base;
        await save(l);
        status.bulk = d.bulk.filter((b) => skip.has(b.a + SEP + b.k));
        status.pending = l.own.some((f) => !f.up);
        const err = upErr || pullErr;
        if (err) throw err;
        status.error = null; status.lastSync = Date.now();
        await kv.set('ledger:last', status.lastSync);
        result = { changed, merged: pulled, wrote: d.entries.length };
        if (d.entries.length || changed) logEntry(opts.auto ? 'Automatisch abgeglichen' : 'Abgeglichen', `${d.entries.length} eigene Buchungen, ${changed ? 'Daten aktualisiert' : 'nichts zu übernehmen'}`).catch(() => {});
        break;
      }
      return result;
    } catch (e) { status.error = e; logEntry('Abgleich fehlgeschlagen', e.message || String(e)).catch(() => {}); throw e; }
    finally { status.busy = false; running = null; note(); if (again) { const o = again; again = null; setTimeout(() => syncNow({ ...o, auto: true }).catch(() => {}), 50); } }
  })();
  return running;
}

// ---------------------------------------------------------------- selbsttätig
let timer = null;
export function markChanged() { status.pending = true; note(); clearTimeout(timer); timer = setTimeout(() => autoSync(), 15000); }
export async function autoSync() {
  clearTimeout(timer); timer = null;
  try { if (!(await getSyncPass())) return; await syncNow({ auto: true }); } catch (e) { console.warn('Abgleich:', e); }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && status.pending) autoSync(); else if (document.visibilityState === 'visible') autoSync(); });
window.addEventListener('pagehide', () => { if (status.pending) autoSync(); });
export async function startup() { await autoSync(); }

// ---------------------------------------------------------------- Löschungen bestätigen / zurückholen
/** Viele Löschungen auf einmal: bestätigen (dann werden sie gebucht) oder zurückholen (Daten aus dem Kassenbuch). */
export const confirmBulk = (list) => syncNow({ confirm: new Set(list.map((b) => b.a + SEP + b.k)) });
export const restoreBulk = (list) => syncNow({ restore: new Set(list.map((b) => b.a + SEP + b.k)) });
export const addonTitle = (pc) => ADDONS.find((m) => m.pc === pc)?.title || pc;

// ---------------------------------------------------------------- Früheren Stand holen
/** Zeitpunkte aus dem Kassenbuch (ein Eintrag je Tag, Ende des Tages) plus alte Stände (Altbestand). */
export async function historyPoints() {
  const l = await load();
  const days = new Map();
  for (const e of allEntries(l)) { if (e.t <= 1) continue; const k = new Date(e.t).toLocaleDateString('de-DE'); days.set(k, Math.max(days.get(k) || 0, e.t)); }
  const points = [...days].map(([label, t]) => ({ kind: 'ledger', t, label: 'Stand vom ' + label + ' (Ende des Tages)' })).sort((a, b) => b.t - a.t);
  let legacy = [];
  try { legacy = (await listStands()).map((s) => ({ kind: 'stand', t: s.time, label: 'Alter Stand von ' + new Date(s.time).toLocaleString('de-DE') + ' (' + s.device + ')', stand: s })); } catch { legacy = []; }
  return [...points, ...legacy];
}
export async function targetFor(point) {
  if (point.kind === 'stand') return (await readStand(point.stand)).addons;
  const l = await load();
  return materialize(fold(allEntries(l), point.t), {});
}
export async function previewFor(point) {
  const target = await targetFor(point);
  const cur = (await collect()).addons;
  return { target, counts: countDiff(cur, target) };
}
/** Daten auf den gewählten Stand setzen (vorher lokale Sicherung) und als neue Buchungen eintragen. */
export async function restore(point, target) {
  target = target || (await targetFor(point));
  await applyData(target, { force: true });
  const cur = (await collect()).addons;
  const l = await load();
  const keys = diff(l.base || {}, cur, { t: 0, s: '', d: '' }).bulk.map((b) => b.a + SEP + b.k);   // der Nutzer hat die Vorschau gesehen: Löschungen gelten als bestätigt
  logEntry('Früheren Stand geholt', point.label).catch(() => {});
  return syncNow({ confirm: new Set(keys) });
}

export const legacyAvailable = async () => { try { return (await listStands()).length > 0; } catch { return false; } };
