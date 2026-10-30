// Start der App: eigenständig, greift selbst auf die Clouds zu. Aufbau wie die App „Dateien“:
// Tab-Leiste unten am iPhone, Seitenleiste am iPad.

import { h, icon, toast, clear } from './util.js';
import { persist } from './db.js';
import { loadSettings, route, go, unlocked, isWide, applyTheme, dirHash, isStandalone } from './ui.js';
import { loadLock, lockEnabled, showLockScreen, lockImmediately } from './lock.js';
import { loadConnections, connections, onConnections, source, addConnection } from './sources/registry.js';
import { initStore, syncStore, onStore, autoLockMinutes } from './store.js';
import { handleRedirect } from './sources/oauth.js';
import { renderBrowse, renderFolder, renderRecent, renderSearchAll, renderAll, allHash } from './files.js';
import { renderSettings } from './settings.js';
import { renderAddons } from './addons/index.js';
import { renderScan } from './scan/page.js';
import { ADDONS, syncAll } from './addons/store.js';
import { renderFritz } from './fritz.js';
import { openAddCloud, finishOAuth } from './addcloud.js';
import { srcColor } from './fileops.js';
import { loadLayout, onLayout, tabList, activeTab, hubList } from './layout.js';
import { isUploading } from './upload.js';
import { mountOpsBar } from './opsbar.js';
import { APP_VERSION } from './version.js';


const root = document.getElementById('app');
let view = null;
let side = null;
let tabsEl = null;

function paintTabs() {
  if (!tabsEl) return;
  clear(tabsEl).append(...tabList().map((t) => h('a.tab', { href: t.href, 'data-tab': t.id }, h('span.ni', icon(t.icon)), h('span.nl', t.title))));
  markTab();
}
function markTab() {
  if (!tabsEl) return;
  const { parts } = route();
  const on = activeTab(parts[0] || 'a', parts, tabList());
  tabsEl.querySelectorAll('[data-tab]').forEach((el) => el.classList.toggle('on', el.dataset.tab === on));
}
onLayout(() => { paintTabs(); paintSide(); if ((location.hash || '').startsWith('#/a') && !location.hash.startsWith('#/a/')) window.dispatchEvent(new HashChangeEvent('hashchange')); });

function shell() {
  clear(root);
  side = h('nav.sidebar');
  view = h('main.view', { id: 'view' });
  tabsEl = h('nav.tabs');
  root.append(h('div.shell', side, view, tabsEl));
  paintTabs();
  mountOpsBar(root);
  paintSide();
}

/** Seitenleiste am iPad wie in „Dateien“: Orbit, Zuletzt, Scan, Orte, Einstellungen. */
function paintSide() {
  if (!side) return;
  const { parts } = route();
  const here = parts[0] === 'd' ? 'd:' + parts[1] : parts[0] === 'a' && parts[1] ? 'a:' + parts[1] : parts[0];
  const item = (id, label, ic, href, color) => h('a.sitem' + (here === id ? '.on' : ''), { href },
    color ? h('span.srcicon.small', { style: { background: color } }, icon(ic)) : icon(ic), h('span', label));
  clear(side).append(
    h('div.side-head', h('img', { src: 'icons/icon-192.png', alt: '' }), h('b', 'Orbit NAS'), lockEnabled() ? h('button.nav-btn', { 'aria-label': 'Sperren', onclick: lockNow }, icon('lock')) : null),
    item('a', 'Orbit', 'grid', '#/a'),
    ...hubList().filter((f) => f.id !== 'nas').map((f) => item(f.id === 'scan' ? 'scan' : 'a:' + f.id, f.title, f.icon, f.href, f.id === 'scan' ? undefined : f.color)),
    h('div.side-title', 'NAS'),
    connections().filter((c) => c.type !== 'demo').length > 1 ? item('alle', 'Alle Quellen', 'layers', allHash(), 'var(--accent)') : null,
    ...connections().map((c) => item('d:' + c.id, c.name, c.type === 'demo' ? 'layers' : 'cloud', dirHash(c.id), srcColor(c.id))),
    item('fritz', 'FRITZ!NAS', 'disk', '#/fritz', '#E2001A'),
    h('button.sitem.add', { onclick: () => openAddCloud() }, icon('plus'), h('span', 'Cloud hinzufügen')),
    h('div.side-title', ''),
    item('einstellungen', 'Einstellungen', 'gear', '#/einstellungen'),
    h('div.side-foot', 'Version ' + APP_VERSION));
}

async function lockNow() { unlocked.clear(); await lockImmediately(); showLockScreen({ force: true }); }

// ---------------------------------------------------------------- Willkommen (noch keine Cloud)

function welcome() {
  clear(root).append(h('div.welcome',
    h('img.wl-logo', { src: 'icons/icon-192.png', alt: '' }),
    h('h1', 'Orbit NAS'),
    h('p.muted', 'Deine Dateien aus pCloud, OneDrive, Google Drive, Dropbox und von der FRITZ!NAS – direkt auf dem iPhone und iPad.'),
    h('button.btn.primary.big', { onclick: () => openAddCloud() }, icon('plus'), ' Cloud hinzufügen'),
    h('button.btn.big', { onclick: async () => { const c = await addConnection('demo', {}, {}); go(dirHash(c.id)); } }, 'Erst mal ausprobieren (Beispiel)'),
    h('p.muted.small', 'Die Anmeldungen bleiben nur auf diesem Gerät. Einstellungen wie Farben, Favoriten und PINs teilt die App über eine versteckte Datei in deiner Cloud mit Orbit NAS am PC.')));
  view = null;
}

// ---------------------------------------------------------------- Seiten

let rendering = 0;
async function render() {
  applyTheme();
  if (!connections().length) { if (route().parts[0] === 'fritz') { if (!view) shell(); } else { welcome(); return; } }
  if (!view || !document.body.contains(view)) shell();
  const { parts, query } = route();
  const page = parts[0] || 'a';
  markTab();
  document.documentElement.dataset.page = page;
  paintSide();
  const my = ++rendering;
  try {
    if (page === 'd') await renderFolder(view, parts[1], parts[2] ? '/' + parts[2] : '/');
    else if (page === 'alle') await renderAll(view, parts[1] ? '/' + parts[1] : '/');
    else if (page === 'orte') { view.scrollTop = 0; await renderBrowse(view); }
    else if (page === 'zuletzt') { view.scrollTop = 0; await renderRecent(view); }
    else if (page === 'scan') { view.scrollTop = 0; await renderScan(view); }
    else if (page === 'suche') await renderSearchAll(view, query.get('q') || '');
    else if (page === 'a') await renderAddons(view, parts);
    else if (page === 'fritz') { view.scrollTop = 0; await renderFritz(view); }
    else if (page === 'einstellungen') { view.scrollTop = 0; await renderSettings(view, parts); }
    else go('#/orte', { replace: true });
  } catch (e) {
    console.error(e);
    if (my === rendering) clear(view).append(h('div.empty', icon('warn', 'big'), h('p', e.message || String(e)), e.detail ? h('p.muted.small.detail', e.detail) : null));
  }
}

let knownConns = 0;
onConnections(() => {
  if (!connections().length) view = null;
  // Neue Cloud: gleich die Einstellungen vom PC holen (wer sich gerade angemeldet hat, muss die PIN nicht sofort eingeben)
  if (connections().length > knownConns) syncStore();
  knownConns = connections().length;
  render();
});
let storeTimer = null;
onStore(() => { applyTheme(); clearTimeout(storeTimer); storeTimer = setTimeout(paintSide, 200); });

// ---------------------------------------------------------------- Sperre beim Zurückkehren

let hiddenAt = null;
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
  const min = autoLockMinutes();
  if (hiddenAt && lockEnabled() && min > 0 && Date.now() - hiddenAt >= min * 60000) {
    unlocked.clear();
    await lockImmediately();
    await showLockScreen({ force: true });
  }
  hiddenAt = null;
  checkUpdate();
});

// ---------------------------------------------------------------- Updates (Service Worker) – Daten bleiben unberührt

let reg = null;
async function registerSw() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const hadController = !!navigator.serviceWorker.controller;
    reg = await navigator.serviceWorker.register('sw.js', { scope: './' });
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading || !hadController) return;
      reloading = true;
      if (isUploading() || document.querySelector('.backdrop')) { toast('Neue Version ist bereit – sie startet beim nächsten Öffnen.'); return; }
      location.reload();
    });
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      nw && nw.addEventListener('statechange', () => { if (nw.state === 'installed' && navigator.serviceWorker.controller && !isUploading()) nw.postMessage('skipWaiting'); });
    });
    if (reg.waiting && !isUploading()) reg.waiting.postMessage('skipWaiting');
  } catch (e) { console.warn('Offline-Modus nicht verfügbar', e); }
}
function checkUpdate() { if (reg) reg.update().catch(() => {}); }

// ---------------------------------------------------------------- Start

window.addEventListener('hashchange', render);
let lastWide = null;
function layout() {
  const w = isWide();
  if (w === lastWide) return;
  lastWide = w;
  document.documentElement.classList.toggle('wide', w);
}
window.addEventListener('resize', layout);

// Umzug: Die App wohnt unter einer eigenen Adresse, damit ihre Daten in Safari von anderen Seiten getrennt sind.
function movedNotice() {
  return new Promise((resolve) => {
    const box = h('div.lockscreen.moved',
      h('img.lock-logo', { src: 'icons/icon-192.png', alt: '' }),
      h('h1', 'Orbit NAS ist umgezogen'),
      h('p.muted', 'Damit die Daten der App nie mehr mit anderen Seiten vermischt werden, hat sie eine eigene Adresse:'),
      h('p', h('b', 'orbitnas-mobil.github.io')),
      h('ol.moved-steps',
        h('li', 'Unten auf „Zur neuen Adresse“ tippen.'),
        h('li', 'Dort über das Teilen-Symbol „Zum Home-Bildschirm“ wählen.'),
        h('li', 'Das alte Orbit-NAS-Symbol vom Home-Bildschirm löschen.'),
        h('li', 'In der neuen App einmal bei pCloud anmelden.')),
      h('a.btn.primary.big', { href: 'https://orbitnas-mobil.github.io/', target: '_blank', rel: 'noopener' }, 'Zur neuen Adresse'),
      h('button.link', { onclick: () => { box.remove(); resolve(); } }, 'Vorerst hier weiter'));
    document.body.append(box);
  });
}

(async function boot() {
  layout();
  if (location.hostname === 'meszcal-orbit.github.io') { document.getElementById('splash')?.remove(); await movedNotice(); }
  await loadSettings();
  await loadLock();
  await initStore();
  await loadLayout();
  await loadConnections();
  knownConns = connections().length;
  applyTheme();
  persist();
  registerSw();
  let oauth = null;
  try { oauth = await handleRedirect(); } catch (e) { oauth = { error: e.message + (e.detail ? ` (${e.detail})` : '') }; }
  document.getElementById('splash')?.remove();
  if (connections().length && lockEnabled()) await showLockScreen();
  // Beim Kaltstart der App (neue Sitzung) immer in den Orbit-Reiter, auch wenn das Home-Bildschirm-Symbol noch die alte Startadresse (#/orte) gespeichert hat
  let fresh = false;
  try { fresh = !sessionStorage.getItem('started'); sessionStorage.setItem('started', '1'); } catch { /* Safari privat */ }
  if (!location.hash || (fresh && isStandalone() && !/^#\/(einstellungen)/.test(location.hash) && !oauth) || !/^#\/(orte|d|alle|zuletzt|scan|a|einstellungen|suche|fritz)/.test(location.hash)) history.replaceState(null, '', '#/a');
  await render();
  if (oauth) await finishOAuth(oauth);
  if (connections().length) {
    // Einstellungen vom PC holen; erst danach weiß die App z. B. Farben und PINs
    const hadPin = lockEnabled();
    await syncStore();
    if (!hadPin && lockEnabled()) await showLockScreen();
    for (const c of connections()) source(c.id).catch(() => {});
    syncAll().catch(() => {});
  }
})();

// Beim Tippen Animationen anhalten: verhindert Zittern/Neuzeichnen, solange ein Eingabefeld den Cursor hat
{
  const isField = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
  document.addEventListener('focusin', (e) => { if (isField(e.target)) document.documentElement.classList.add('typing'); });
  document.addEventListener('focusout', () => { document.documentElement.classList.remove('typing'); });
}
