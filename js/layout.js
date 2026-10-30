// Aufbau dieses Geräts: welche Reiter unten stehen (und in welcher Reihenfolge) und was auf der Startseite „Orbit“ erscheint.
// Gilt nur auf diesem Gerät, wird nicht mit dem PC abgeglichen (Aussehen schon, Positionen und Sichtbarkeit nicht).

import { kv } from './db.js';
import { ADDONS } from './addons/store.js';

const KEY = 'ui:layout';
export const MAX_TABS = 5;

/** Alles, was als Reiter unten oder als Kachel auf der Startseite stehen kann. Neue Add-ons erscheinen hier automatisch. */
export function features() {
  return [
    { id: 'a', title: 'Orbit', icon: 'grid', color: '#6366F1', href: '#/a', tabOnly: true },
    { id: 'nas', title: 'NAS', icon: 'folder', color: '#4F8CFF', href: '#/orte' },
    { id: 'zuletzt', title: 'Zuletzt', icon: 'clock', color: '#94A3B8', href: '#/zuletzt', tabOnly: true },
    ...ADDONS.filter((a) => !a.hidden).map((a) => ({ id: a.id, title: a.title, icon: a.icon, color: a.color, href: '#/a/' + a.id })),
    { id: 'scan', title: 'Scan', icon: 'camera', color: '#FFD24A', href: '#/scan' },
    { id: 'einstellungen', title: 'Einstellungen', icon: 'gear', color: '#94A3B8', href: '#/einstellungen', tabOnly: true, fixed: true },
  ];
}
export const featureById = (id) => features().find((f) => f.id === id);

const DEFAULT = { tabs: ['a', 'nas', 'notes', 'scan', 'einstellungen'], hubOrder: [], hubHidden: [] };
let cur = null;
const listeners = new Set();
export const onLayout = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

export async function loadLayout() {
  if (!cur) cur = { ...DEFAULT, ...((await kv.get(KEY)) || {}) };
  return cur;
}
export async function saveLayout(patch) {
  cur = { ...(await loadLayout()), ...patch };
  await kv.set(KEY, cur);
  listeners.forEach((f) => f());
}

/** Reiter unten: nur Bekanntes, „Einstellungen“ immer dabei, höchstens MAX_TABS. */
export function tabList() {
  const l = cur || DEFAULT, known = new Set(features().map((f) => f.id));
  let ids = l.tabs.filter((id, i, a) => known.has(id) && a.indexOf(id) === i);
  if (!ids.includes('einstellungen')) ids.push('einstellungen');
  ids = ids.slice(0, MAX_TABS);
  if (!ids.includes('einstellungen')) ids[ids.length - 1] = 'einstellungen';
  return ids.map(featureById);
}

/** Startseite: gewählte Reihenfolge, Neues (auch künftige Add-ons) hinten dran, Ausgeblendetes weg. Mit all = true auch Ausgeblendetes. */
export function hubList(all = false) {
  const l = cur || DEFAULT, items = features().filter((f) => !f.tabOnly);
  const pos = (id) => { const i = l.hubOrder.indexOf(id); return i < 0 ? 1e6 + items.findIndex((f) => f.id === id) : i; };
  const sorted = items.slice().sort((a, b) => pos(a.id) - pos(b.id));
  return all ? sorted : sorted.filter((f) => !l.hubHidden.includes(f.id));
}

/** Welcher Reiter leuchtet für die aktuelle Seite? */
export function activeTab(page, parts, tabs) {
  const ids = tabs.map((t) => t.id);
  if (page === 'a') return parts[1] && ids.includes(parts[1]) ? parts[1] : 'a';
  if (['orte', 'd', 'alle', 'suche', 'fritz'].includes(page)) return 'nas';
  return page;
}
