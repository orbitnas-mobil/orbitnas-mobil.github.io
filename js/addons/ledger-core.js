// Kassenbuch: reiner Kern ohne Browser-Abhängigkeiten (läuft auch in Node). Dieselbe Logik steht am PC in LedgerCore.cs;
// beide werden mit denselben Testfällen (tests/ledger-vectors.json) geprüft.
//
// Daten: { <add-on-id>: { <schlüssel>: <text> } }. Ein Schlüssel ist entweder eine Liste von Einträgen mit "id"
// (Listenmodus) oder ein einzelner Wert (Wertmodus).
// Buchung: { t: ms, s: Geräte-Kennung, d: Gerätename, a: add-on, k: schlüssel, i: eintrags-id | null, o: 'put' | 'del' | 'set', v }
//   put: v = Eintrag (Objekt), del: Eintrag gelöscht, set: v = Text oder null (Schlüssel entfernt).
// Regel: je (a, k, i) gilt die jüngste Buchung (bei gleicher Zeit die mit der größeren Kennung s). Gelöscht wird nur durch eine Buchung.

export const BULK_MIN = 4;     // ab so vielen Löschungen auf einmal …
export const BULK_SHARE = 0.5; // … und mindestens dieser Anteil der Einträge wird gefragt

const parse = (s) => { try { return JSON.parse(s); } catch { return undefined; } };
export const isRecList = (s) => { if (typeof s !== 'string') return false; const a = parse(s); return Array.isArray(a) && a.every((x) => x && typeof x === 'object' && !Array.isArray(x) && x.id != null); };
const recMap = (s) => { const m = new Map(); const a = typeof s === 'string' ? parse(s) : null; if (Array.isArray(a)) for (const x of a) m.set(String(x.id), JSON.stringify(x)); return m; };

/** Neue Buchungen: Unterschied zwischen dem letzten abgeglichenen Stand (base) und den jetzigen Daten (cur). */
export function diff(base, cur, { t, s, d }, allow = new Set()) {
  const entries = [], bulk = [];
  const addons = new Set([...Object.keys(base || {}), ...Object.keys(cur || {})]);
  for (const a of [...addons].sort()) {
    const B = (base || {})[a] || {}, C = (cur || {})[a] || {};
    for (const k of [...new Set([...Object.keys(B), ...Object.keys(C)])].sort()) {
      const bv = B[k], cv = C[k];
      if (bv === cv) continue;
      const listMode = (cv === undefined || isRecList(cv)) && (bv === undefined || isRecList(bv));
      if (!listMode) { entries.push({ t, s, d, a, k, i: null, o: 'set', v: cv === undefined ? null : cv }); continue; }
      const bm = recMap(bv), cm = recMap(cv);
      const mine = [];
      for (const [id, js] of cm) if (bm.get(id) !== js) mine.push({ t, s, d, a, k, i: id, o: 'put', v: JSON.parse(js) });
      const dels = [];
      for (const id of bm.keys()) if (!cm.has(id)) dels.push({ t, s, d, a, k, i: id, o: 'del', v: null });
      if (dels.length >= BULK_MIN && dels.length >= bm.size * BULK_SHARE && !allow.has(a + '\u0001' + k)) { bulk.push({ a, k, dels: dels.length, total: bm.size }); continue; }
      entries.push(...mine, ...dels);
    }
  }
  return { entries, bulk };
}

const newer = (x, y) => x.t > y.t || (x.t === y.t && String(x.s) > String(y.s));

/** Je (a, k, i) die jüngste Buchung. untilMs: nur Buchungen bis zu dieser Zeit (für „früheren Stand holen“). */
export function fold(entries, untilMs = Infinity) {
  const st = new Map();
  for (const e of entries) {
    if (e.t > untilMs) continue;
    const key = e.a + '\u0001' + e.k + '\u0001' + (e.i == null ? '' : e.i);
    const old = st.get(key);
    if (!old || newer(e, old)) st.set(key, e);
  }
  return st;
}

/** Daten aus dem Zustand aufbauen. local: jetzige Daten (für die Reihenfolge und für ausgenommene Schlüssel). skip: Set "a\u0001k". */
export function materialize(state, local, skip = new Set()) {
  const by = new Map(); // a\u0001k -> { rec: Map(id -> entry), set: entry }
  for (const e of state.values()) {
    const g = e.a + '\u0001' + e.k;
    if (!by.has(g)) by.set(g, { a: e.a, k: e.k, rec: new Map(), set: null });
    const o = by.get(g);
    if (e.o === 'set') o.set = e; else o.rec.set(String(e.i), e);
  }
  const out = {};
  for (const [a, d] of Object.entries(local || {})) out[a] = { ...d };
  for (const [g, o] of by) {
    if (skip.has(g)) continue;
    const { a, k } = o;
    out[a] ||= {};
    if (o.rec.size) {
      const live = new Map();
      for (const [id, e] of o.rec) if (e.o === 'put') live.set(id, e);
      const res = [], seen = new Set();
      const cur = typeof out[a][k] === 'string' ? parse(out[a][k]) : null;
      if (Array.isArray(cur)) for (const x of cur) { const id = String(x && x.id); if (live.has(id) && !seen.has(id)) { res.push(live.get(id).v); seen.add(id); } }
      const rest = [...live].filter(([id]) => !seen.has(id)).sort((x, y) => x[1].t - y[1].t || (String(x[0]) < String(y[0]) ? -1 : 1));
      for (const [, e] of rest) res.push(e.v);
      out[a][k] = JSON.stringify(res);
    } else if (o.set) {
      if (o.set.v === null) delete out[a][k]; else out[a][k] = o.set.v;
    }
  }
  for (const a of Object.keys(out)) if (!Object.keys(out[a]).length) delete out[a];
  return out;
}

/** Zählt, was beim Wechsel von cur auf target neu ist, sich ändert oder wegfällt (je Add-on). */
export function countDiff(cur, target) {
  const res = {};
  for (const a of new Set([...Object.keys(cur || {}), ...Object.keys(target || {})])) {
    const C = (cur || {})[a] || {}, T = (target || {})[a] || {};
    let neu = 0, geaendert = 0, weg = 0;
    for (const k of new Set([...Object.keys(C), ...Object.keys(T)])) {
      if (C[k] === T[k]) continue;
      if ((C[k] === undefined || isRecList(C[k])) && (T[k] === undefined || isRecList(T[k]))) {
        const cm = recMap(C[k]), tm = recMap(T[k]);
        for (const [id, js] of tm) { if (!cm.has(id)) neu++; else if (cm.get(id) !== js) geaendert++; }
        for (const id of cm.keys()) if (!tm.has(id)) weg++;
      } else if (C[k] === undefined) neu++; else if (T[k] === undefined) weg++; else geaendert++;
    }
    if (neu || geaendert || weg) res[a] = { neu, geaendert, weg };
  }
  return res;
}

/** Kopie der Daten ohne Add-ons/Schlüssel, die nur dem Gerät gehören (nichts nötig, Platz für spätere Regeln). */
export const cloneData = (d) => JSON.parse(JSON.stringify(d || {}));
