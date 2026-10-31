// Seiten für Fuel Tracker, Notizen, Reisen und Tresor: Übersicht (#/a) und je Add-on (#/a/<id>), samt Abgleich-Zeile.

import { h, icon, clear, fmtAgo, toast } from '../util.js';
import { go } from '../ui.js';
import { ADDONS, addonById, openAddon, onAddon, getSyncPass } from './store.js';
import { lastStand, status as standStatus, onStands } from './stands.js';
import { saveNow, openLoad, syncNow } from './stands-ui.js';
import { searchBox } from './search.js';
import { head } from './ui.js';
import { loadPrefs, animated } from './prefs.js';
import { errText } from '../fileops.js';
import { loadLayout, hubList } from '../layout.js';

const MODULES = {
  fuel: () => import('./fuel.js'),
  notes: () => import('./notes.js'),
  trips: () => import('./trips.js'),
  vault: () => import('./vault.js'),
};

let current = null;   // { id, off, redraw }
window.addEventListener('orbit-vault-lock', () => { if (current?.id === 'vault') current.redraw(); });

export async function renderAddons(view, parts) {
  await loadPrefs();
  if (current) { current.off(); current = null; }
  const id = parts[1];
  if (!id || !addonById(id)) return hub(view);
  const meta = addonById(id);
  const api = await openAddon(id);
  const mod = await MODULES[id]();
  const box = h('div.ad-root');
  const footer = h('div.ad-sync');
  clear(view).append(box, footer);
  view.scrollTop = 0;
  let drawing = 0, again = false;
  const nav = { hub: () => go('#/a'), redraw: () => draw(), meta };
  const paintFooter = async () => {
    const pass = await getSyncPass(), last = await lastStand();
    clear(footer);
    if (!pass) footer.append(h('span', 'Nur auf diesem Gerät. '), h('button.link', { onclick: () => go('#/einstellungen') }, 'Sichern und Laden einrichten'));
    else if (standStatus.busy) footer.append(h('span', 'Sichert …'));
    else if (standStatus.notice) footer.append(h('span.err-text', 'Sichern pausiert: neuerer Stand vom ' + standStatus.notice.device + '. '), h('button.link', { onclick: () => syncNow() }, 'Zusammenführen'));
    else if (standStatus.error) footer.append(h('span.err-text', 'Sichern: ' + errText(standStatus.error)), h('button.link', { onclick: () => saveNow() }, 'Erneut versuchen'));
    else footer.append(h('span.muted', last?.time ? `Gesichert ${fmtAgo(last.time)}` : 'Noch nicht gesichert'), h('button.link', { onclick: () => saveNow() }, 'Jetzt sichern'));
  };
  async function draw() {
    const my = ++drawing;
    if (!document.body.contains(box)) return;
    const top = view.scrollTop;
    const el = h('div');
    try { await mod.render(el, api, nav); } catch (e) { console.error(e); el.replaceChildren(h('div.empty', icon('warn', 'big'), h('p', e.message || String(e)))); }
    if (my !== drawing || !document.body.contains(box)) return;
    clear(box).append(el);
    view.scrollTop = top;
    paintFooter();
  }
  const off0 = onAddon((aid, kind) => {
    if (aid !== id || !document.body.contains(box)) return;
    if (kind === 'data') draw(); else paintFooter();
  });
  const off1 = onStands(() => { if (document.body.contains(box)) paintFooter(); });
  const off = () => { off0(); off1(); };
  current = { id, off, redraw: draw };
  await draw();
}

async function hub(view) {
  const pass = await getSyncPass();
  const subs = new Map();
  const subText = (api) => (api.hasData() ? 'Daten vorhanden' : 'Noch leer');
  await loadLayout();
  const tiles = await Promise.all(hubList().map(async (f) => {
    const a = addonById(f.id);
    let sub = null;
    if (a) {
      const api = await openAddon(a.id);
      sub = h('small.muted', subText(api));
      subs.set(a.id, [api, sub]);
    } else sub = h('small.muted', f.id === 'nas' ? 'Dateien in der Cloud' : 'Dokumente scannen');
    return h('a.ad-tile', { href: f.href, style: { '--c': f.color } }, h('span.ad-tile-i', icon(f.icon)), h('b', f.title), sub);
  }));
  const bad = [...subs].map(([id, [api]]) => [addonById(id), api.status()]).filter(([, st]) => st.error);
  clear(view).append(h('div.page.ios.ad-page',
    ...head('Orbit'),
    searchBox(),
    h('div.ad-orbit', { hidden: !animated() }, h('i'), h('i'), h('i')),
    h('div.ad-tiles' + (animated() ? '.anim' : ''), tiles),
    standStatus.notice ? h('div.ad-banner', h('b', 'Automatisches Sichern pausiert'), h('span', `Auf dem Gerät „${standStatus.notice.device}“ liegt ein neuerer Stand (${new Date(standStatus.notice.time).toLocaleString('de-DE')}). Deine Änderungen sind bis dahin nur auf diesem Gerät.`),
      h('button.btn.primary', { onclick: async () => { if (await syncNow()) hub(view); } }, 'Jetzt zusammenführen')) : null,
    pass ? h('button.btn.block.primary', { onclick: async () => { if (await syncNow()) hub(view); } }, 'Alles abgleichen') : null,
    pass ? h('div.btn-row', h('button.btn.block', { onclick: () => saveNow() }, 'Jetzt sichern'), h('button.btn.block', { onclick: () => openLoad(() => hub(view)) }, 'Daten laden')) : null,
    bad.length ? h('p.err-text.small', 'Abgleich-Problem bei ' + bad.map(([a]) => a.title).join(', ') + ' – Details unter Einstellungen.') : null));
  view.scrollTop = 0;
  const off = onAddon((aid) => { const e = subs.get(aid); if (e) e[1].textContent = subText(e[0]); });
  current = { id: null, off };
}
