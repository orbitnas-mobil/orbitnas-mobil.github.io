// Daten der Add-ons (Fuel Tracker, Notizen, Reisen, Tresor) auf diesem Gerät und ihr Online-Abgleich mit Orbit am PC.
// Format wie am PC (PluginSync.cs): je Add-on eine verschlüsselte Datei /.orbitnas/addons/<id>/daten.orbit in der Haupt-Cloud
// (AES-256-GCM, Schlüssel per PBKDF2-SHA256 aus dem Sync-Passwort), darin {"speicher": {schlüssel: text}}.
// Zusammenführen: Dreiwege je Schlüssel; Listen mit "id" werden zusätzlich je Eintrag zusammengeführt, damit nichts verloren geht.

import { kv } from '../db.js';
import { saveSecret, loadSecret, deleteSecret } from '../secrets.js';
import { mainConnection, source, ensureKeys } from '../sources/registry.js';
import { devName } from '../store.js';

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

async function persist(a) { await kv.set('addon:' + a.pc, { data: a.data, base: a.base, lastSync: a.lastSync, conflicts: a.conflicts, lastEdit: a.lastEdit }); }

export async function openAddon(id) {
  const meta = addonById(id);
  if (mem.has(meta.pc)) return mem.get(meta.pc).api;
  const saved = (await kv.get('addon:' + meta.pc)) || {};
  const a = { pc: meta.pc, id, data: saved.data || {}, base: saved.base || null, lastSync: saved.lastSync || null, conflicts: saved.conflicts || [], lastEdit: saved.lastEdit || 0, rev: 0, error: null, busy: false, readOnly: false };
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

const remoteDir = (pc) => '/.orbitnas/addons/' + pc;
const remoteFile = (pc) => remoteDir(pc) + '/daten.orbit';
const running = new Map();
const timers = new Map();

async function mainSrc() {
  await ensureKeys();
  const c = mainConnection();
  if (!c || c.type === 'demo') return null;
  return source(c.id);
}

async function ensureDirs(src, pc) {
  for (const [parent, name] of [['/', '.orbitnas'], ['/.orbitnas', 'addons'], ['/.orbitnas/addons', pc], [remoteDir(pc), 'versionen']]) {
    try { await src.mkdir(parent, name); } catch { /* gibt es schon */ }
  }
}

/** Passwort vergessen: verschlüsselte Cloud-Dateien aller Add-ons beiseitelegen (bleiben in „zurueckgesetzt“ erhalten), Passwort vergessen.
 *  Lokale Daten bleiben unverändert und gehen mit dem neuen Passwort wieder hoch. Gibt die Zahl beiseitegelegter Dateien zurück. */
export async function resetCloudSync() {
  const src = await mainSrc();
  if (!src) throw new SyncError('Keine Haupt-Cloud angemeldet.');
  let n = 0;
  for (const meta of ADDONS) {
    const text = await src.readText(remoteFile(meta.pc));
    if (text != null) {
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
      await src.writeText(remoteDir(meta.pc) + '/zurueckgesetzt/' + stamp + '.orbit', text);
      const it = (await src.list(remoteDir(meta.pc))).find((x) => x.name === 'daten.orbit');
      if (it) await src.remove(it);
      n++;
    }
    const api = await openAddon(meta.id), a = api.internal;
    a.base = null; a.lastSync = null; a.error = null;
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
    await ensureDirs(src, meta.pc);
    const old = await src.readText(remoteFile(meta.pc));
    if (old != null) {
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
      await src.writeText(remoteDir(meta.pc) + '/zurueckgesetzt/' + stamp + '.orbit', old);
    }
    await src.writeText(remoteFile(meta.pc), await encryptSync(pass, js({ speicher: a.data }), devName()));
    a.base = { ...a.data }; a.lastSync = Date.now(); a.error = null;
    await persist(a); emit(meta.id, 'status');
    n++;
  }
  return n;
}

export function scheduleSync(id, ms = 3000) {
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => { timers.delete(id); syncAddon(id).catch(() => {}); }, ms));
}
/** Wartende Änderungen sofort hochladen (z. B. wenn die App in den Hintergrund geht – iOS hält dann Zeitgeber an). */
function flushPending() { for (const [id, t] of [...timers]) { clearTimeout(t); timers.delete(id); syncAddon(id).catch(() => {}); } }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushPending(); });
window.addEventListener('pagehide', flushPending);

/** Gleicht ein Add-on ab. Gibt { skipped } zurück, wenn kein Sync-Passwort oder keine Cloud da ist. */
export function syncAddon(id) {
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
        const remoteText = await src.readText(remoteFile(a.pc));
        let remote = null, remoteTime = 0, payload = {};
        if (remoteText) {
          const d = await decryptSync(pass, remoteText);
          payload = JSON.parse(d.text) || {};
          remote = payload.speicher && typeof payload.speicher === 'object' ? payload.speicher : {};
          remoteTime = d.time;
        }
        if (remote && Number(remote.dataVersion) > DATA_VERSION) {
          a.data = { ...remote }; a.readOnly = true; a.lastSync = Date.now(); a.error = null; await persist(a); emit(id, 'data'); return { readOnly: true };
        }
        if (!remote && !Object.keys(a.data).length) { a.lastSync = Date.now(); a.error = null; return { nothing: true }; }
        const conflicts = [];
        const merged = merge(a.data, remote, a.base, a.lastEdit >= remoteTime, conflicts);
        const changesLocal = !same(merged, a.data);
        const changesRemote = !remote || !same(merged, remote);
        if (a.rev !== rev0) continue;          // inzwischen etwas geändert: nochmal
        if (changesRemote) {
          if (!remote) await ensureDirs(src, a.pc);
          const again = await src.readText(remoteFile(a.pc));
          if (again !== remoteText) continue;  // anderes Gerät hat geschrieben: nochmal
          if (remoteText) { try { await src.writeText(remoteDir(a.pc) + '/versionen/mobil-letzte.orbit', remoteText); } catch { /* nicht schlimm */ } }
          const text = await encryptSync(pass, js({ ...payload, speicher: merged }), devName());
          await src.writeText(remoteFile(a.pc), text);
        }
        if (a.rev !== rev0) continue;
        if (changesLocal) { a.data = merged; checkVersion(a); }
        a.base = { ...merged };
        a.lastSync = Date.now(); a.error = null;
        if (conflicts.length) a.conflicts = [...a.conflicts, ...conflicts].slice(-20);
        await persist(a);
        emit(id, changesLocal ? 'data' : 'status');
        return { pulled: changesLocal, pushed: changesRemote, conflicts: conflicts.length };
      }
      throw new SyncError('Die Daten ändern sich gerade – wird gleich erneut abgeglichen.');
    } catch (e) {
      a.error = e;
      if (!(e instanceof SyncError)) scheduleSync(id, 120000);
      throw e;
    } finally {
      a.busy = false; running.delete(id); emit(id);
    }
  })();
  running.set(id, p);
  return p;
}

export async function syncAll() {
  const out = {};
  for (const a of ADDONS) { try { out[a.id] = await syncAddon(a.id); } catch (e) { out[a.id] = { error: e }; } }
  return out;
}

let lastAll = 0;
export function syncSoon() { if (document.visibilityState === 'visible' && Date.now() - lastAll > 15000) { lastAll = Date.now(); syncAll().catch(() => {}); } }
setInterval(syncSoon, 60000);
window.addEventListener('online', () => { lastAll = 0; syncSoon(); });
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
