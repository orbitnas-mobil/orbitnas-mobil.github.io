// Seiten für Fuel Tracker, Notizen, Reisen und Tresor: Übersicht (#/a) und je Add-on (#/a/<id>), samt Abgleich-Zeile.

import { h, icon, clear, fmtAgo, toast } from '../util.js';
import { go } from '../ui.js';
import { ADDONS, addonById, openAddon, syncAddon, onAddon, getSyncPass } from './store.js';
import { head } from './ui.js';
import { errText } from '../fileops.js';

const MODULES = {
  fuel: () => import('./fuel.js'),
  notes: () => import('./notes.js'),
  trips: () => import('./trips.js'),
  vault: () => import('./vault.js'),
};

let current = null;   // { id, off, redraw }
window.addEventListener('orbit-vault-lock', () => { if (current?.id === 'vault') current.redraw(); });

export async function renderAddons(view, parts) {
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
    const st = api.status(), pass = await getSyncPass();
    clear(footer);
    if (!pass) footer.append(h('span', 'Nur auf diesem Gerät. '), h('button.link', { onclick: () => go('#/einstellungen') }, 'Abgleich mit dem PC einrichten'));
    else if (st.busy) footer.append(h('span', 'Gleicht ab …'));
    else if (st.error) footer.append(h('span.err-text', 'Abgleich: ' + errText(st.error)), h('button.link', { onclick: () => syncAddon(id).catch(() => {}) }, 'Erneut versuchen'));
    else footer.append(h('span.muted', st.lastSync ? `Abgeglichen ${fmtAgo(st.lastSync)}` : 'Noch nicht abgeglichen'), h('button.link', { onclick: () => syncAddon(id).then(() => toast('Abgeglichen')).catch((e) => toast(errText(e), 'err')) }, 'Jetzt'));
    if (st.conflicts) footer.append(h('span.muted', ` · ${st.conflicts} Konflikt(e) gesichert`));
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
  const off = onAddon((aid, kind) => {
    if (aid !== id || !document.body.contains(box)) return;
    if (kind === 'data') draw(); else paintFooter();
  });
  current = { id, off, redraw: draw };
  await draw();
  syncAddon(id).catch(() => {});
}

async function hub(view) {
  const pass = await getSyncPass();
  const subs = new Map();
  const subText = (api) => (api.hasData() ? (api.status().lastSync ? 'Abgeglichen ' + fmtAgo(api.status().lastSync) : 'Nur auf diesem Gerät') : 'Noch leer');
  const tiles = await Promise.all(ADDONS.map(async (a) => {
    const api = await openAddon(a.id);
    const sub = h('small.muted', subText(api));
    subs.set(a.id, [api, sub]);
    return h('a.ad-tile', { href: '#/a/' + a.id, style: { '--c': a.color } }, h('span.ad-tile-i', icon(a.icon)), h('b', a.title), sub);
  }));
  clear(view).append(h('div.page.ios.ad-page',
    ...head('Orbit'),
    h('div.ad-tiles', tiles),
    !pass ? h('section.ad-card', h('b', 'Daten mit dem PC abgleichen'),
      h('p.muted', 'Am PC in Orbit unter Einstellungen › Add-on-Optionen bei jedem Add-on „Online-Abgleich“ einschalten und ein Sync-Passwort wählen. Hier dasselbe Passwort eintragen.'),
      h('button.btn.primary', { onclick: () => go('#/einstellungen') }, 'Zu den Einstellungen')) : null));
  view.scrollTop = 0;
  const off = onAddon((aid) => { const e = subs.get(aid); if (e) e[1].textContent = subText(e[0]); });
  current = { id: null, off };
  ADDONS.forEach((a) => syncAddon(a.id).catch(() => {}));
}
