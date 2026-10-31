// Einstellungen als gruppierte Liste wie in iOS. Was in der Einstellungsdatei steht (Design, PIN, Sicherheitsfrage,
// Auto-Sperre, Auge-Knopf, Ignorierte), gilt auch am PC. Anmeldungen, Face ID und die 24 Stunden bleiben auf diesem Gerät.

import { h, icon, fmtSize, fmtAgo, toast, confirmDialog, promptDialog, clear, sheet } from './util.js';
import { cache, usage, persist, kv } from './db.js';
import { connections, connById, connByKey, source, removeConnection, renameConnection, mainConnection, PROVIDERS } from './sources/registry.js';
import * as store from './store.js';
import { settings, saveSettings, applyTheme, isStandalone, go, dirHash } from './ui.js';
import { THEMES, ACCENTS } from './theme.js';
import { lock, saveLock, activePin, faceIdAvailable, enrollFaceId, enrollCredential, disableFaceId, setOwnPin, removePin, checkFaceId } from './lock.js';
import { securityQuestion, askSecurity, editSecurity } from './secq.js';
import { openAddCloud, relogin } from './addcloud.js';
import { openFritz, fritzConfigured } from './fritz.js';
import { pageHead } from './files.js';
import { srcColor, setIgnored, errText } from './fileops.js';
import { APP_VERSION } from './version.js';
import { loadPrefs, pref, setPrefs } from './addons/prefs.js';
import { formSheet, parseNum } from './addons/ui.js';
import { deleteSecret } from './secrets.js';
import { features, hubList, tabList, loadLayout, saveLayout, MAX_TABS } from './layout.js';
import { loadSyncLoc, getSyncLoc, setSyncLoc, normFolder, localSnapshots, cloudVersions, readCloudVersion, restoreAddon, snapshotLocal, syncLog } from './addons/store.js';
import { ADDONS, resetCloudSync, overwriteCloudFromHere, getSyncPass, setSyncPass, syncAddon, syncAll, firstError, syncByHand, openAddon, importExportZip } from './addons/store.js';

const group = (title, foot, ...rows) => h('section.group', title ? h('h2.group-title', title) : null, h('div.group-body', rows), foot ? h('p.group-foot', foot) : null);
const navRow = (ic, color, title, sub, onclick, value = '') => h('button.row', { onclick },
  ic ? h('span.srcicon', { style: { background: color } }, icon(ic)) : null,
  h('span.row-main', h('span.row-title', title), sub ? h('small.row-sub', sub) : null), value ? h('span.row-value', value) : null, icon('chevron', 'chev'));
const toggleRow = (title, sub, on, onchange, disabled = false) => h('label.row.toggle' + (disabled ? '.dim' : ''),
  h('span.row-main', h('span.row-title', title), sub ? h('small.row-sub', sub) : null),
  h('input.ios-switch', { type: 'checkbox', checked: on, disabled, onchange: (e) => onchange(e.target.checked, e.target) }));
const infoRow = (title, value) => h('div.row.info', h('span.row-main', h('span.row-title', title)), h('span.row-value', value));
const actRow = (title, onclick, danger = false) => h('button.row.act' + (danger ? '.danger' : ''), { onclick }, h('span.row-title', title));

export async function renderSettings(view, parts = []) {
  if (parts[1] === 'cloud' && parts[2]) return renderCloud(view, parts[2]);
  const page = h('div.page.ios.settings');
  clear(view).append(page);
  page.append(...pageHead({ title: 'Einstellungen' }));
  const rerender = () => renderSettings(view);

  // Clouds
  const main = mainConnection();
  page.append(group('Clouds', 'Hier meldest du dich bei deinen Clouds an. Die Anmeldungen bleiben nur auf diesem Gerät.',
    ...connections().map((c) => navRow('cloud', srcColor(c.id), c.name, c.email || PROVIDERS[c.type]?.name, () => go('#/einstellungen/cloud/' + c.id), c.id === main?.id && c.type !== 'demo' ? 'Haupt-Cloud' : '')),
    h('button.row.add', { onclick: () => openAddCloud() }, h('span.srcicon.plain', icon('plus')), h('span.row-main', h('span.row-title', 'Cloud hinzufügen'))),
    navRow('disk', '#E2001A', 'FRITZ!NAS', (await fritzConfigured()) ? 'Eingerichtet in der App „Dateien“' : 'Einrichten', () => openFritz())));

  // Abgleich der Einstellungen mit dem PC
  const st = store.status;
  page.append(group('Abgleich mit dem PC', 'Farben, Symbole, Favoriten, Versteckte, Ignorierte, Schreibschutz, PINs, Sicherheitsfrage und Design stehen in einer versteckten Datei in der Haupt-Cloud. PC und Handy lesen sie alle 2 Minuten. Dateien selbst werden nicht abgeglichen – jedes Gerät greift direkt auf die Clouds zu.',
    infoRow('Haupt-Cloud', main && main.type !== 'demo' ? main.name : 'keine'),
    infoRow('Zuletzt gelesen', st.lastRead ? fmtAgo(st.lastRead) : '–'),
    st.lastWrite ? infoRow('Zuletzt geschrieben', fmtAgo(st.lastWrite)) : null,
    st.error ? h('div.row.info', h('span.row-main', h('span.row-title.err-text', 'Fehler'), h('small.row-sub', errText(st.error)))) : null,
    main && main.type !== 'demo' ? actRow('Jetzt abgleichen', async () => { await store.syncStore(); toast(store.status.error ? errText(store.status.error) : 'Abgeglichen', store.status.error ? 'err' : ''); rerender(); }) : null));

  page.append(...await orbitGroup(rerender));
  page.append(await addonPrefsGroup(rerender));
  page.append(await addonsGroup(rerender));
  page.append(appearance(rerender));
  page.append(await security(rerender));

  // Ignorierte Ordner
  const ig = store.entries('ignored');
  page.append(group('Ignorierte Ordner', 'Diese Ordner sind überall ausgeblendet – auch am PC und wenn „Versteckte zeigen“ an ist. Nur hier machst du sie wieder sichtbar.',
    ...(ig.length ? ig.map((e) => {
      const c = connByKey(e.cloud);
      return h('div.row', h('span.ficon', icon('ignore')), h('span.row-main', h('span.row-title', e.path.split('/').pop() || '(oberste Ebene)'), h('small.row-sub', (c ? c.name : e.cloud.startsWith('lokal:') ? 'am PC' : e.cloud) + (e.path.includes('/') ? ' › ' + e.path.split('/').slice(0, -1).join(' › ') : ''))),
        h('button.btn.small', { onclick: async () => {
          if (c) await setIgnored(c.id, '/' + e.path, false); else await store.setEntry('ignored', e.cloud, e.path, null);
          toast('Wird wieder angezeigt'); rerender();
        } }, 'Anzeigen'));
    }) : [h('div.row.info', h('span.row-main', h('small.row-sub', 'Keine. Lange auf einen Ordner drücken → „Dauerhaft ignorieren …“.')))])));

  // Über
  const u = await usage();
  const persisted = await persist();
  page.append(group('Über Orbit NAS', 'Updates kommen automatisch beim Öffnen. Deine Daten bleiben dabei unverändert. Keine Werbung, keine Analyse; die App spricht nur mit deinen Clouds.',
    infoRow('Version', 'Orbit NAS Mobil ' + APP_VERSION),
    infoRow('Als App installiert', isStandalone() ? 'ja' : 'nein (Safari)'),
    infoRow('Daten auf diesem Gerät', u ? fmtSize(u.usage) + (persisted ? ' · dauerhaft' : '') : '–'),
    actRow('Nach Update suchen', checkUpdate),
    actRow('Zwischenspeicher leeren', async () => { await cache.clear(); if ('caches' in window) await caches.delete('orbitnas-thumbs'); toast('Zwischenspeicher geleert'); rerender(); })));
}

function appearance(rerender) {
  const d = store.design();
  const curTheme = d?.theme && THEMES[d.theme] ? d.theme : settings.theme;
  const curAccent = d ? d.accent : settings.accent;
  const pick = async (theme, accent) => {
    settings.theme = theme; settings.accent = accent; saveSettings();
    await store.setSingle('design', { theme, accent: accent || null });
    applyTheme();
    rerender();
  };
  const custom = h('input.color', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(curAccent || '') ? curAccent : THEMES[curTheme]?.accent || '#6366F1' });
  return group('Aussehen', 'Dieselben Designs wie am PC. Eine Änderung gilt auch dort.',
    h('div.row.block', h('div.themes', Object.entries(THEMES).map(([name, t]) => h('button.theme' + (name === curTheme ? '.on' : ''), { onclick: () => pick(name, null) },
      h('span.tprev', { style: { background: t.grad ? `linear-gradient(135deg, ${t.bg}, ${t.grad})` : t.bg, borderColor: t.border } },
        h('span', { style: { background: t.side } }), h('span', { style: { background: t.surface, borderColor: t.border } }), h('i', { style: { background: t.accent } })),
      h('span', name))))),
    h('div.row.block', h('div.label', 'Akzentfarbe'),
      h('div.swatches', ACCENTS.map((c) => h('button.swatch' + ((curAccent || '').toLowerCase() === c.toLowerCase() ? '.on' : ''), { style: { background: c }, 'aria-label': c, onclick: () => pick(curTheme, c) }))),
      h('div.row-input', custom, h('button.btn.small', { onclick: () => pick(curTheme, custom.value) }, 'Eigene Farbe'), h('button.btn.small', { onclick: () => pick(curTheme, null) }, 'Farbe des Designs'))),
    toggleRow('Symbole gefüllt', 'Ordner und Dateien in voller Farbe. Aus: nur als Umriss. Gilt auch am PC.', store.iconsFilled(),
      async (on) => { await store.setSingle('iconStyle', { style: on ? 'filled' : 'outline' }); toast('Gespeichert'); }),
    toggleRow('Knopf „Versteckte zeigen“', 'Im Menü eines Ordners. Ist er aus, bleiben Versteckte immer verborgen (auch am PC).', store.showHiddenButton(),
      async (on) => { await store.setSingle('showHiddenButton', { on }); if (!on) { settings.showHidden = false; saveSettings(); } toast('Gespeichert'); }));
}

async function security(rerender) {
  const pin = activePin();
  const faceOk = await faceIdAvailable();
  const minutes = store.autoLockMinutes();
  const sel = h('select.input.compact', { onchange: async (e) => { await store.setSingle('autoLock', { minutes: Number(e.target.value) }); toast('Gespeichert'); } },
    [[0, 'aus'], [1, '1 Minute'], [2, '2 Minuten'], [5, '5 Minuten'], [15, '15 Minuten'], [30, '30 Minuten']].map(([v, l]) => h('option', { value: v, selected: minutes === v }, l)));
  const sq = securityQuestion();
  return group('Sicherheit', 'Die Programm-PIN und die Sicherheitsfrage gelten am PC und auf allen Geräten. Face ID und „24 Stunden entsperrt“ gelten nur hier. Ordner schützt du mit langem Drücken → „Mit PIN schützen …“.',
    infoRow('Programm-PIN', pin ? (pin.isPin ? `${pin.length} Ziffern` : 'Passwort') : 'keine'),
    actRow(pin ? 'PIN ändern' : 'PIN festlegen', async () => { if (await setOwnPin()) { toast('PIN gespeichert – gilt auch am PC'); rerender(); } }),
    pin ? actRow('PIN entfernen', async () => {
      if (await askSecurity('PIN abschalten') && await confirmDialog('Programm-PIN entfernen? Das gilt auch am PC.', { ok: 'Entfernen', danger: true })) { await removePin(); rerender(); }
    }, true) : null,
    faceOk ? toggleRow('Mit Face ID entsperren', 'iOS speichert dafür einen Passkey „Orbit NAS“. Die PIN bleibt als Ersatz.', !!lock.faceId, async (on, el) => {
      if (on && !pin) { el.checked = false; toast('Bitte zuerst eine PIN festlegen.', 'err'); return; }
      try {
        if (on) { await enrollFaceId(); if (!(await checkFaceId())) throw new Error('Face ID wurde nicht bestätigt.'); toast('Face ID ist eingerichtet'); }
        else { await disableFaceId(); toast('Face ID ausgeschaltet'); }
      } catch (e) { el.checked = false; await disableFaceId(); if (e.name !== 'NotAllowedError') toast(e.message, 'err'); }
    }) : infoRow('Face ID', 'auf diesem Gerät nicht verfügbar'),
    toggleRow('24 Stunden entsperrt bleiben', 'Nach dem Entsperren 24 Stunden keine Programm-PIN auf diesem Gerät. Das Schloss sperrt sofort. Ordner-PINs gelten weiter.', lock.stay24h !== false, async (on) => { lock.stay24h = on; await saveLock(); toast('Gespeichert'); }),
    h('label.row', h('span.row-main', h('span.row-title', 'Automatisch sperren'), h('small.row-sub', 'Wenn die App so lange im Hintergrund war (gilt auch am PC)')), sel),
    infoRow('Sicherheitsfrage', sq ? '„' + sq.question + '“' : 'keine'),
    actRow(sq ? 'Sicherheitsfrage ändern' : 'Sicherheitsfrage festlegen', async () => { if (await editSecurity()) rerender(); }),
    sq ? actRow('Sicherheitsfrage entfernen', async () => { if (await editSecurity({ remove: true })) rerender(); }, true) : null);
}

// ---------------------------------------------------------------- eine Cloud

async function renderCloud(view, id) {
  const c = connById(id);
  if (!c) { go('#/einstellungen', { replace: true }); return; }
  const page = h('div.page.ios.settings');
  clear(view).append(page);
  page.append(...pageHead({ title: c.name, back: { label: 'Einstellungen', onclick: () => go('#/einstellungen') } }));
  const acc = h('span.row-value', '…');
  const space = h('span.row-value', '…');
  const state = h('small.row-sub', 'Prüfe …');
  page.append(group('Konto', null,
    h('div.row.info', h('span.row-main', h('span.row-title', 'Anmeldung'), state)),
    h('div.row.info', h('span.row-main', h('span.row-title', 'Konto')), acc),
    h('div.row.info', h('span.row-main', h('span.row-title', 'Speicher')), space),
    infoRow('Anbieter', PROVIDERS[c.type]?.name || c.type),
    mainConnection()?.id === c.id && c.type !== 'demo' ? infoRow('Einstellungsdatei', 'liegt hier (Haupt-Cloud)') : null));
  source(id).then((s) => s.info()).then((me) => {
    acc.textContent = me.email || '–';
    space.textContent = me.total ? `${fmtSize(me.used)} von ${fmtSize(me.total)}` : '–';
    state.textContent = 'Angemeldet'; state.className = 'row-sub ok-text';
  }).catch((e) => { acc.textContent = c.email || '–'; space.textContent = '–'; state.textContent = errText(e); state.className = 'row-sub err-text'; });
  page.append(group('', null,
    actRow('Öffnen', () => go(dirHash(id))),
    actRow('Umbenennen', async () => { const n = await promptDialog('', c.name, { title: 'Name', ok: 'Speichern' }); if (n) { await renameConnection(id, n); renderCloud(view, id); } }),
    c.type !== 'demo' ? actRow('Neu anmelden', () => relogin(id)) : null,
    actRow(c.type === 'demo' ? 'Beispiel entfernen' : 'Von diesem Gerät entfernen', async () => {
      if (!(await confirmDialog(`„${c.name}“ von diesem Gerät entfernen? In der Cloud wird nichts gelöscht. Die Anmeldung wird hier vergessen.`, { ok: 'Entfernen', danger: true }))) return;
      await removeConnection(id);
      toast('Entfernt');
      go('#/einstellungen');
    }, true)));
}

async function checkUpdate() {
  const reg = await navigator.serviceWorker?.getRegistration();
  if (!reg) { location.reload(); return; }
  await reg.update();
  if (reg.waiting || reg.installing) toast('Neue Version wird geladen …'); else toast('Du hast die neueste Version.');
}

// Frühere Stände (lokal + Cloud) wiederherstellen, Sicherung per Knopf, Abgleich-Protokoll
const fmtT = (t) => new Date(t).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const cloudTime = (name) => { const d = /^(\d{4})(\d{2})(\d{2})\.orbit$/.exec(name); if (d) return `${d[3]}.${d[2]}.${d[1]} (Tagesstand)`; const m = /(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(name); return m ? `${m[3]}.${m[2]}. ${m[4]}:${m[5]}` : name.replace('.orbit', ''); };
async function historySheet() {
  const body = h('div');
  const s = sheet(body, { title: 'Frühere Stände', wide: true });
  const show = async (meta) => {
    if (!meta) return home();
    body.replaceChildren(h('p.muted', 'Lädt …'));
    let locals = [], clouds = [], cerr = '';
    try { locals = await localSnapshots(meta.pc); } catch { /* leer */ }
    try { clouds = await cloudVersions(meta.id); } catch (e) { cerr = errText(e); }
    const ask = async (label, load) => {
      if (!(await confirmDialog(`Den Stand „${label}“ von ${meta.title} wiederherstellen? Der jetzige Stand wird vorher gesichert (hier und in der Cloud).`, { title: 'Wiederherstellen?', ok: 'Weiter', danger: true }))) return;
      if (!(await confirmDialog('Wirklich? Die Daten dieses Add-ons werden durch diesen Stand ersetzt und auch an deine anderen Geräte weitergegeben.', { title: 'Zweite Bestätigung', ok: 'Ja, wiederherstellen', danger: true }))) return;
      try { const d = await load(); await restoreAddon(meta.id, d.data); toast('Wiederhergestellt.'); s.close(); } catch (e) { toast('Nicht möglich: ' + errText(e), 'err'); }
    };
    const row = (t, sub, onclick) => h('button.row', { onclick }, h('span.row-main', h('span.row-title', t), sub ? h('small.row-sub', sub) : null), icon('chevron', 'chev'));
    body.replaceChildren(
      h('button.btn', { onclick: () => show(null) }, '‹ Zurück'),
      h('h3', meta.title),
      h('button.btn.primary', { onclick: async () => { const api = await openAddon(meta.id); await snapshotLocal(meta.pc, api.internal.data, 'Von Hand', true); toast('Stand gesichert.'); show(meta); } }, 'Jetzt Stand sichern'),
      h('h4', 'Auf diesem Gerät'),
      locals.length ? h('div.group-body', locals.map((x) => row(fmtT(x.t), x.label, () => ask(fmtT(x.t), async () => ({ data: x.data }))))) : h('p.muted', 'Noch keine Stände.'),
      h('h4', 'In der Cloud'),
      cerr ? h('p.err-text', cerr) : clouds.length ? h('div.group-body', clouds.map((x) => row(cloudTime(x.name), x.name.startsWith('vor-') ? 'Vor einer Wiederherstellung' : /^\d{8}\.orbit$/.test(x.name) ? 'Täglicher Gesamtstand' : x.name.startsWith('mobil-') ? 'Vom Handy gesichert' : x.name, () => ask(cloudTime(x.name), () => readCloudVersion(x.path))))) : h('p.muted', 'Noch keine Stände in der Cloud.'),
    );
  };
  const home = async (_m) => {
    const log = await syncLog();
    body.replaceChildren(
      h('p.muted', 'Stände werden nie automatisch gelöscht. Wähle ein Add-on:'),
      h('div.group-body', ADDONS.filter((m) => !m.hidden).map((m) => h('button.row', { onclick: () => show(m) }, h('span.row-main', h('span.row-title', m.title)), icon('chevron', 'chev')))),
      h('h4', 'Abgleich-Protokoll'),
      log.length ? h('pre.muted', { style: { whiteSpace: 'pre-wrap', fontSize: '12px', maxHeight: '35vh', overflow: 'auto' } }, log.slice(0, 40).map((l) => `${fmtT(l.t)}  ${(ADDONS.find((a) => a.id === l.id)?.title) || l.id}: ${l.text}`).join('\n')) : h('p.muted', 'Noch nichts protokolliert.'),
    );
  };
  home();
}

// Quelle und Ordner für den Abgleich wählen (nur dieses Gerät; Geräte mit demselben Ordner gleichen sich ab)
async function pickSyncFolder(rerender) {
  await loadSyncLoc();
  const loc = getSyncLoc();
  const conns = connections().filter((c) => c.type !== 'demo');
  if (!conns.length) { toast('Es ist keine Cloud angemeldet.', 'err'); return; }
  const sel = h('select.input', conns.map((c) => h('option', { value: c.id, selected: c.id === (loc.cloudId || mainConnection()?.id) }, c.name)));
  const path = h('input.input', { type: 'text', value: loc.folder, autocapitalize: 'off', autocorrect: 'off', spellcheck: false });
  const list = h('div.group-body');
  const msg = h('p.muted.small', '');
  const load = async () => {
    msg.textContent = 'Lädt …'; clear(list);
    try {
      const src = await source(sel.value);
      const items = (await src.list('/' + path.value.split('/').map((x) => x.trim()).filter(Boolean).join('/'))).filter((i) => i.isFolder).sort((a, b) => a.name.localeCompare(b.name, 'de'));
      for (const i of items) list.append(h('button.row', { type: 'button', onclick: () => { path.value = (path.value.trim() ? path.value.replace(/\/+$/, '') + '/' : '') + i.name; load(); } }, h('span.row-main', h('span.row-title', i.name)), icon('chevron', 'chev')));
      msg.textContent = items.length ? 'Ordner antippen zum Öffnen. Den Pfad oben kannst du auch eintippen.' : 'Keine Unterordner. Der Ordner wird beim Abgleich angelegt, falls es ihn noch nicht gibt.';
    } catch (e) { msg.textContent = 'Nicht lesbar (wird beim Abgleich angelegt): ' + errText(e); }
  };
  sel.addEventListener('change', load);
  const body = h('div.dialog-body',
    h('p.muted.small', 'Gilt für alle Add-ons. Geräte mit demselben Ordner gleichen sich ab, ein anderer Ordner ist eine eigene Gruppe. Das musst du auf jedem Gerät einstellen. Beim Wechsel wird nichts gelöscht.'),
    h('label.ad-field', h('span.ad-label', 'Quelle'), sel),
    h('label.ad-field', h('span.ad-label', 'Ordner'), path),
    h('button.btn', { type: 'button', onclick: () => { const p = path.value.split('/').filter(Boolean); p.pop(); path.value = p.join('/'); load(); } }, 'Eine Ebene hoch'),
    list, msg);
  const diag = h('pre.muted.small', { style: { whiteSpace: 'pre-wrap', userSelect: 'text' } }, '');
  const test = async () => {
    const out = [];
    const show = () => { diag.textContent = out.join('\n'); };
    const step = async (name, fn) => {
      try { const r = await fn(); out.push('OK  ' + name + (r ? ' – ' + r : '')); } catch (e) { out.push('FEHLER  ' + name + ': ' + (e.message || e) + (e.detail ? ' [' + e.detail + ']' : '')); }
      show();
    };
    const folder = '/' + normFolder(path.value);
    let src;
    await step('Anmelden bei ' + (conns.find((c) => c.id === sel.value)?.name || '?'), async () => { src = await source(sel.value); return (await src.info()).email; });
    if (!src) return;
    await step('Hauptordner lesen', async () => (await src.list('/')).length + ' Einträge');
    await step('Ordner anlegen ' + folder, async () => { let cur = ''; for (const n of folder.split('/').filter(Boolean)) { try { await src.mkdir(cur || '/', n); } catch (e) { if (e.code !== 2004) throw e; } cur += '/' + n; } });
    await step('Ordner lesen', async () => (await src.list(folder)).length + ' Einträge');
    await step('Testdatei schreiben', async () => { await src.writeText(folder + '/orbit-test.txt', 'test ' + new Date().toISOString()); });
    await step('Testdatei lesen', async () => (await src.readText(folder + '/orbit-test.txt'))?.slice(0, 20));
    out.push('Fertig. Bitte diese Zeilen als Screenshot schicken.'); show();
  };
  body.append(h('button.btn', { type: 'button', onclick: test }, 'Verbindung testen'), diag);
  const s = sheet(body, { title: 'Abgleich-Ordner' });
  body.append(h('div.btn-row', h('button.btn', { type: 'button', onclick: () => s.close() }, 'Abbrechen'),
    h('button.btn.primary', { type: 'button', onclick: async () => { await setSyncLoc(sel.value, path.value); s.close(); toast('Gespeichert. Nächster Abgleich führt dort zusammen.'); rerender(); } }, 'Übernehmen')));
  load();
}

// Aufbau dieses Geräts: untere Leiste und Startseite „Orbit“ (nur hier, wird nicht mit dem PC abgeglichen)
async function orbitGroup(rerender) {
  const l = await loadLayout();
  const tabs = tabList().map((t) => t.id);
  const moveIn = (arr, id, d) => { const i = arr.indexOf(id), j = i + d; if (i < 0 || j < 0 || j >= arr.length) return arr; const a = arr.slice(); [a[i], a[j]] = [a[j], a[i]]; return a; };
  const arrows = (up, down) => h('span.row-arrows', h('button.link', { 'aria-label': 'Nach oben', onclick: (e) => { e.stopPropagation(); up(); } }, '▲'), h('button.link', { 'aria-label': 'Nach unten', onclick: (e) => { e.stopPropagation(); down(); } }, '▼'));
  const apply = async (patch) => { await saveLayout(patch); rerender(); };
  const tabRows = features().filter((f) => !f.fixed).map((f) => ({ f, on: tabs.includes(f.id) }));
  const ordered = [...tabs.filter((id) => id !== 'einstellungen').map((id) => tabRows.find((r) => r.f.id === id)), ...tabRows.filter((r) => !r.on)].filter(Boolean);
  const barRows = ordered.map(({ f, on }) => h('div.row.toggle',
    h('span.srcicon', { style: { background: f.color } }, icon(f.icon)),
    h('span.row-main', h('span.row-title', f.title)),
    on ? arrows(() => apply({ tabs: [...moveIn(tabs.filter((i) => i !== 'einstellungen'), f.id, -1), 'einstellungen'] }), () => apply({ tabs: [...moveIn(tabs.filter((i) => i !== 'einstellungen'), f.id, 1), 'einstellungen'] })) : null,
    h('input.ios-switch', { type: 'checkbox', checked: on, onchange: async (e) => {
      const cur = tabs.filter((i) => i !== 'einstellungen');
      if (e.target.checked) { if (cur.length >= MAX_TABS - 1) { e.target.checked = false; toast('Höchstens ' + MAX_TABS + ' Reiter (mit Einstellungen)', 'err'); return; } cur.push(f.id); }
      else cur.splice(cur.indexOf(f.id), 1);
      apply({ tabs: [...cur, 'einstellungen'] });
    } })));
  const hub = hubList(true);
  const hubRows = hub.map((f) => h('div.row.toggle',
    h('span.srcicon', { style: { background: f.color } }, icon(f.icon)),
    h('span.row-main', h('span.row-title', f.title)),
    arrows(() => apply({ hubOrder: moveIn(hub.map((x) => x.id), f.id, -1) }), () => apply({ hubOrder: moveIn(hub.map((x) => x.id), f.id, 1) })),
    h('input.ios-switch', { type: 'checkbox', checked: !l.hubHidden.includes(f.id), onchange: (e) => apply({ hubOrder: hub.map((x) => x.id), hubHidden: e.target.checked ? l.hubHidden.filter((i) => i !== f.id) : [...l.hubHidden, f.id] }) })));
  return [
    group('Orbit – untere Leiste', 'Bis zu ' + MAX_TABS + ' Reiter; „Einstellungen“ bleibt immer dabei. Gilt nur auf diesem Gerät.', ...barRows),
    group('Orbit – Startseite', 'Reihenfolge und Sichtbarkeit der Kacheln. Neue Add-ons erscheinen automatisch am Ende. Gilt nur auf diesem Gerät.', ...hubRows),
  ];
}

// Fuel Tracker, Notizen, Reisen, Tresor: Sync-Passwort (dasselbe wie am PC) und Stand je Add-on
async function addonsGroup(rerender) {
  await loadSyncLoc();
  const pass = await getSyncPass();
  const rows = [];
  for (const a of ADDONS) {
    const api = await openAddon(a.id), st = api.status();
    rows.push(navRow(a.icon, a.color, a.title + ' jetzt abgleichen', st.error ? errText(st.error) : st.lastSync ? 'Abgeglichen ' + fmtAgo(st.lastSync) : api.hasData() ? 'Nur auf diesem Gerät' : 'Noch leer', async () => {
      if (!pass) { toast('Erst das Sync-Passwort eintragen', 'err'); return; }
      try { await syncByHand(a.id); toast(a.title + ': abgeglichen'); } catch (e) { toast(errText(e), 'err'); }
      rerender();
    }));
  }
  return group('Orbit-Add-ons (Fuel Tracker, Notizen, Reisen, Tresor)',
    'Die Daten liegen verschlüsselt in der Haupt-Cloud (Ordner .orbitnas/addons) und werden mit Orbit am PC abgeglichen. Dafür am PC pro Add-on „Online-Abgleich“ einschalten und hier dasselbe Sync-Passwort eintragen. Das Passwort bleibt nur auf diesem Gerät.',
    infoRow('Sync-Passwort', pass ? 'gesetzt' : 'fehlt'),
    navRow('clock', '#F59E0B', 'Frühere Stände & Protokoll', 'Wiederherstellen, Stand sichern, Abgleich-Verlauf', historySheet),
    navRow('folder', '#4F8CFF', 'Abgleich-Ordner wählen …', 'Quelle: ' + (connById(getSyncLoc().cloudId)?.name || mainConnection()?.name || 'keine') + ', Ordner: /' + normFolder(getSyncLoc().folder), () => pickSyncFolder(rerender)),
    actRow(pass ? 'Sync-Passwort ändern …' : 'Sync-Passwort eintragen …', async () => {
      if (pass) {
        const old = await promptDialog('Zur Sicherheit: aktuelles Sync-Passwort eingeben.', '', { title: 'Altes Passwort', ok: 'Weiter' });
        if (old == null) return;
        if (old !== pass) { toast('Das alte Passwort stimmt nicht.', 'err'); return; }
      }
      const p = await promptDialog('Dasselbe Passwort wie in Orbit am PC (Einstellungen › Add-on-Optionen).', '', { title: pass ? 'Neues Sync-Passwort' : 'Sync-Passwort', ok: 'Speichern' });
      if (p == null || !p) return;
      if (pass) { const p2 = await promptDialog('Neues Passwort zur Kontrolle noch einmal eingeben.', '', { title: 'Wiederholen', ok: 'Speichern' }); if (p2 !== p) { toast('Die beiden Eingaben passen nicht zusammen.', 'err'); return; } }
      await setSyncPass(p);
      toast('Gespeichert. Gleiche ab …');
      const bad = firstError(await syncAll());
      toast(bad ? errText(bad) : 'Abgeglichen', bad ? 'err' : '');
      rerender();
    }),
    actRow('Daten aus Orbit-Export importieren …', () => {
      const inp = h('input', { type: 'file', multiple: true, accept: '.zip,application/zip', hidden: true });
      inp.addEventListener('change', async () => {
        const msgs = [];
        for (const f of inp.files) {
          try { const r = await importExportZip(f); msgs.push(`${r.addon.title}: ${r.added} neu`); } catch (e) { msgs.push(errText(e)); }
        }
        inp.remove();
        toast(msgs.join(' · ') || 'Nichts gewählt', msgs.some((m) => /gehört|fehlt|beschädigt|Unbekannt|JSON/.test(m)) ? 'err' : '');
        rerender();
      });
      document.body.append(inp); inp.click();
    }),
    pass ? actRow('Cloud mit dem Stand dieses Handys überschreiben …', async () => {
      if (!(await confirmDialog('Der Stand dieses Handys (Fuel Tracker, Notizen, Reisen, Tresor, Scans) wird zum alleinigen Stand in der Cloud. Was dort bisher liegt, wird ersetzt (die alte Datei bleibt im Ordner „zurueckgesetzt“ erhalten). Am PC danach „Cloud-Stand übernehmen“ wählen, nicht zusammenführen.', { title: 'Cloud überschreiben?', danger: true, ok: 'Weiter' }))) return;
      if (!(await confirmDialog('Wirklich sicher? Die Cloud-Daten werden jetzt durch den Stand dieses Handys ersetzt.', { title: 'Zweite Bestätigung', danger: true, ok: 'Ja, überschreiben' }))) return;
      try { const n = await overwriteCloudFromHere(); toast(`Fertig: ${n} Add-on(s) in die Cloud geschrieben`); } catch (e) { toast('Nicht möglich: ' + errText(e), 'err'); }
      rerender();
    }, true) : null,
    actRow('Passwort vergessen – Abgleich zurücksetzen …', async () => {
      if (!(await confirmDialog('Die verschlüsselten Abgleichdateien aller Add-ons in der Cloud (Ordner .orbitnas/addons) werden beiseitegelegt – ohne das alte Passwort kann sie niemand lesen. Deine Daten auf diesem Gerät bleiben und werden mit einem neuen Sync-Passwort wieder hochgeladen. Daten, die nur am PC liegen, kommen erst zurück, wenn du dort ebenfalls zurücksetzt und dasselbe neue Passwort einträgst.', { title: 'Abgleich zurücksetzen?', danger: true, ok: 'Zurücksetzen' }))) return;
      try { await resetCloudSync(); } catch (e) { toast('Zurücksetzen nicht möglich: ' + errText(e), 'err'); rerender(); return; }
      const p = await promptDialog('Neues Sync-Passwort (dasselbe wie am PC nach dem Zurücksetzen dort).', '', { title: 'Neues Sync-Passwort', ok: 'Speichern' });
      if (p) {
        await setSyncPass(p);
        const bad = firstError(await syncAll());
        toast(bad ? errText(bad) : 'Zurückgesetzt und neu abgeglichen', bad ? 'err' : '');
      } else toast('Zurückgesetzt. Ohne neues Passwort ruht der Abgleich.');
      rerender();
    }, true),
    pass ? actRow('Sync-Passwort entfernen', async () => { await setSyncPass(''); rerender(); }, true) : null,
    pass ? actRow('Jetzt alle abgleichen', async () => {
      const bad = firstError(await syncAll());
      toast(bad ? errText(bad) : 'Abgeglichen', bad ? 'err' : '');
      rerender();
    }) : null,
    ...rows);
}

// Einstellungen für Startbildschirm, Fuel Tracker, Notizen und Tresor (nur auf diesem Gerät)
async function addonPrefsGroup(rerender) {
  await loadPrefs();
  const comma = (n) => String(n).replace('.', ',');
  const fuel = async () => {
    const api = await openAddon('fuel');
    const vs = api.get('vehicles', []);
    const defs = [{ id: 'bmw_diesel', name: 'BMW Diesel', kind: 'diesel', consumption: 5.3 }, { id: 'tesla_model3', name: 'Tesla Model 3', kind: 'strom', consumption: 15 }];
    const list = vs.length ? vs.filter((v) => !v.archived) : defs;
    formSheet({
      title: 'Fuel Tracker',
      fields: [
        { key: 'veh', label: 'Fahrzeug vorausgewählt', type: 'select', options: list.map((v) => ({ value: v.id, label: v.name })), value: pref('fuelVehicle') },
        { key: 'price', label: 'Strompreis vorbelegt (Cent pro kWh)', type: 'number', value: comma(pref('fuelPrice')), hint: 'Beim Eintrag jederzeit änderbar.' },
        { key: 'wk', label: 'Kilometer pro Arbeitstag', type: 'number', value: comma(pref('workKm')) },
        { key: 'charts', label: 'Diagramme anzeigen', type: 'check', value: pref('fuelCharts') },
        ...list.map((v) => ({ key: 'c_' + v.id, label: `Verbrauch ${v.name} (${v.kind === 'strom' ? 'kWh' : 'l'}/100 km)`, type: 'number', value: comma(v.consumption) })),
      ],
      onSubmit: async (v) => {
        const price = parseNum(v.price), wk = parseNum(v.wk);
        if (price == null || price <= 0 || wk == null || wk <= 0) return 'Bitte Preis und Kilometer als Zahl eingeben.';
        const cons = {};
        for (const x of list) { const c = parseNum(v['c_' + x.id]); if (c == null || c <= 0) return `Bitte den Verbrauch für ${x.name} angeben.`; cons[x.id] = c; }
        await setPrefs({ fuelVehicle: v.veh, fuelPrice: price, workKm: wk, fuelCharts: v.charts });
        const base = vs.length ? vs : defs.map((d) => ({ ...d, archived: false }));
        await api.set('vehicles', base.map((x) => (cons[x.id] != null && cons[x.id] !== Number(x.consumption) ? { ...x, consumption: cons[x.id] } : x)));
        toast('Gespeichert'); rerender();
      },
    });
  };
  const notes = () => formSheet({
    title: 'Notizen',
    fields: [{ key: 'color', label: 'Standardfarbe neuer Notizen', type: 'select', options: ['Indigo', 'Lila', 'Grün', 'Gelb', 'Rosa', 'Blau'], value: pref('notesColor') }],
    onSubmit: async (v) => { await setPrefs({ notesColor: v.color }); toast('Gespeichert'); rerender(); },
  });
  const vault = () => formSheet({
    title: 'Tresor',
    fields: [
      { key: 'min', label: 'Automatisch sperren nach (Minuten)', type: 'select', options: ['1', '2', '3', '5', '10', '15'], value: String(pref('vaultMinutes')) },
      { key: 'face', label: 'Mit Face ID öffnen', type: 'check', value: pref('vaultFace'), hint: 'Nur für den Tresor (die App selbst bleibt davon unberührt). Das Master-Passwort bleibt verschlüsselt auf diesem Gerät. Beim ersten Mal das Passwort einmal von Hand eingeben.' },
    ],
    onSubmit: async (v) => {
      if (v.face && !(await kv.get('vault:face'))?.id) {
        try {
          if (!(await faceIdAvailable())) return 'Face ID ist auf diesem Gerät nicht verfügbar.';
          await kv.set('vault:face', { id: await enrollCredential(), created: new Date().toISOString() });
        } catch (e) { return 'Face ID konnte nicht eingerichtet werden: ' + (e.message || e); }
      }
      if (!v.face) { await deleteSecret('vaultPw'); await kv.del('vault:face'); }
      await setPrefs({ vaultMinutes: Number(v.min), vaultFace: v.face });
      toast('Gespeichert'); rerender();
    },
  });
  return group('Add-on-Einstellungen', 'Gelten nur auf diesem Gerät.',
    toggleRow('Animationen im Startbildschirm', 'Orbit-Reiter', pref('animations'), async (on) => { await setPrefs({ animations: on }); }),
    navRow('fuel', '#00D4FF', 'Fuel Tracker', `${pref('fuelPrice')} ct/kWh · ${pref('workKm')} km/Arbeitstag`, fuel),
    navRow('note', '#A855F7', 'Notizen', 'Standardfarbe ' + pref('notesColor'), notes),
    navRow('lock', '#3DFFA2', 'Tresor', `Sperre nach ${pref('vaultMinutes')} Min.${pref('vaultFace') ? ' · Face ID' : ''}`, vault));
}
