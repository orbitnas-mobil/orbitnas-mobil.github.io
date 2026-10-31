// Oberfläche für „Jetzt sichern“, „Daten laden“, „Stände verwalten“ und „Zusätzlich spiegeln“.

import { h, icon, toast, confirmDialog, sheet, clear, fmtSize } from '../util.js';
import { errText } from '../fileops.js';
import { connections, mainConnection } from '../sources/registry.js';
import { saveStand, syncAll, getLog, listStands, compare, loadStand, mergeAndSave, deleteStands, pruneOlderThan, StandNewerError, getMirror, setMirror, status } from './stands.js';

const fmtT = (t) => new Date(t).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
const devText = (d) => (d === 'PC' ? 'Vom PC' : 'Vom ' + d);

/** Jetzt sichern. Liegt ein neuerer Stand eines anderen Geräts vor, wird gefragt, ob zusammengeführt werden soll. */
export async function saveNow() {
  try {
    const r = await saveStand();
    toast(r?.mirrorError ? 'Gesichert (Spiegeln fehlgeschlagen: ' + errText(r.mirrorError) + ')' : 'Gesichert', r?.mirrorError ? 'err' : '');
    return true;
  } catch (e) {
    if (!(e instanceof StandNewerError)) { toast(errText(e), 'err'); return false; }
    if (await confirmDialog(e.message + ' Soll ich ihn mit deinen Daten zusammenführen und danach sichern? Neue Einträge von beiden Seiten bleiben erhalten.', { title: 'Neuerer Stand vorhanden', ok: 'Zusammenführen und sichern' })) {
      try { await mergeAndSave(e.stand); toast('Zusammengeführt und gesichert'); return true; } catch (e2) { toast(errText(e2), 'err'); return false; }
    }
    if (await confirmDialog('Nur deine Daten als neuen Stand sichern? Der neuere Stand bleibt als Datei erhalten.', { title: 'Trotzdem sichern?', ok: 'Trotzdem sichern' })) {
      try { await saveStand({ force: true }); toast('Gesichert'); return true; } catch (e2) { toast(errText(e2), 'err'); }
    }
    return false;
  }
}

/** Alles abgleichen: neuerer Stand eines anderen Geräts wird zusammengeführt, dann wird gesichert. */
export async function syncNow() {
  try {
    const r = await syncAll();
    toast((r.merged ? 'Mit Stand vom ' + r.merged.device + ' zusammengeführt und gesichert' : r.name ? 'Gesichert' : 'Schon aktuell') + (r.mirrorError ? ' (Spiegeln fehlgeschlagen)' : ''), r.mirrorError ? 'err' : '');
    return true;
  } catch (e) { toast(errText(e), 'err'); return false; }
}

/** Protokoll: was dieses Gerät wann gesichert, geladen, zusammengeführt oder aufgeräumt hat. */
export async function openLog() {
  const l = await getLog();
  sheet(h('div', l.length ? h('div.group-body', l.map((e) => h('div.row', h('span.row-main', h('span.row-title', e.what), h('small.row-sub', fmtT(e.t) + (e.detail ? ' · ' + e.detail : '')))))) : h('p.muted', 'Noch keine Einträge.')), { title: 'Protokoll', wide: true });
}

const previewText = (pv) => (pv || []).map((x) => x.skip ? `${x.title}: nicht im Stand, bleibt unverändert` : `${x.title}: ${x.neu} neu, ${x.geaendert} geändert, ${x.weg} entfallen`).join('\n');

const standRow = (s, onclick, extra) => h('button.row', { onclick },
  h('span.row-main', h('span.row-title', fmtT(s.time)), h('small.row-sub', devText(s.device) + (s.size ? ' · ' + fmtSize(s.size) : ''))), extra || icon('chevron', 'chev'));

/** Daten laden: Liste der Stände, neueste oben. */
export async function openLoad(onDone) {
  const body = h('div', h('p.muted', 'Lädt …'));
  const s = sheet(body, { title: 'Daten laden', wide: true });
  let stands;
  try { stands = await listStands(); } catch (e) { body.replaceChildren(h('p.err-text', errText(e))); return; }
  if (!stands.length) { body.replaceChildren(h('p.muted', 'Es gibt noch keine gesicherten Stände. Tippe auf „Jetzt sichern“.')); return; }
  const pick = async (st) => {
    let cmp;
    try { cmp = await compare(st); } catch (e) { toast(errText(e), 'err'); return; }
    const pv = previewText(cmp.preview);
    let text = `Den Stand vom ${fmtT(st.time)} (${devText(st.device)}) laden? Deine jetzigen Daten werden vorher auf diesem Gerät gesichert.` + (pv ? '\n\nGegenüber jetzt:\n' + pv : '\n\nGegenüber jetzt: keine Unterschiede.');
    if (cmp.current >= 4 && cmp.incoming < cmp.current / 2) text = `Achtung: Dieser Stand hat deutlich weniger Daten (${cmp.incoming} statt ${cmp.current} Einträge). ` + text;
    if (!(await confirmDialog(text, { title: 'Stand laden?', ok: 'Laden', danger: cmp.incoming < cmp.current / 2 }))) return;
    try { await loadStand(st, { data: cmp.data }); toast('Stand geladen'); s.close(); onDone && onDone(); } catch (e) { toast(errText(e), 'err'); }
  };
  body.replaceChildren(h('p.muted', 'Wähle den Stand, der geladen werden soll. Neueste oben.'), h('div.group-body', stands.map((st, i) => standRow(st, () => pick(st), i === 0 ? h('span.row-value', 'neuester') : null))));
}

/** Stände verwalten: einzeln löschen oder alles älter als einen Monat. */
export async function openManage() {
  const body = h('div', h('p.muted', 'Lädt …'));
  const s = sheet(body, { title: 'Stände verwalten', wide: true });
  const draw = async () => {
    let stands;
    try { stands = await listStands(); } catch (e) { body.replaceChildren(h('p.err-text', errText(e))); return; }
    body.replaceChildren(
      h('p.muted', `${stands.length} Stände. Die 3 neuesten bleiben beim Aufräumen immer erhalten.`),
      h('button.btn', { onclick: async () => {
        if (!(await confirmDialog('Alle Stände löschen, die älter als ein Monat sind?', { title: 'Aufräumen', ok: 'Löschen', danger: true }))) return;
        try { const n = await pruneOlderThan(30); toast(n + ' Stände gelöscht'); } catch (e) { toast(errText(e), 'err'); }
        draw();
      } }, 'Älter als einen Monat löschen'),
      stands.length ? h('div.group-body', stands.map((st) => standRow(st, async () => {
        if (!(await confirmDialog(`Den Stand vom ${fmtT(st.time)} (${devText(st.device)}) löschen?`, { title: 'Stand löschen', ok: 'Löschen', danger: true }))) return;
        try { await deleteStands([st]); } catch (e) { toast(errText(e), 'err'); }
        draw();
      }, icon('trash', 'chev')))) : h('p.muted', 'Keine Stände.'));
  };
  draw();
  return s;
}

/** Zusätzlich spiegeln: jeder gesicherte Stand wird auch in eine zweite Cloud kopiert. */
export async function openMirror(onDone) {
  const conns = connections().filter((c) => c.type !== 'demo');
  if (!conns.length) { toast('Es ist keine Cloud angemeldet.', 'err'); return; }
  const cur = await getMirror();
  const sel = h('select.input', h('option', { value: '' }, 'Aus'), conns.map((c) => h('option', { value: c.id, selected: c.id === cur?.cloudId }, c.name)));
  const path = h('input.input', { type: 'text', value: cur?.folder || 'Orbit Stände', autocapitalize: 'off', autocorrect: 'off', spellcheck: false });
  const body = h('div.dialog-body',
    h('p.muted.small', 'Jeder Stand wird beim Sichern zusätzlich in diese Cloud und diesen Ordner kopiert. Am besten eine andere Cloud als die Haupt-Cloud (' + (mainConnection()?.name || 'keine') + ').'),
    h('label.ad-field', h('span.ad-label', 'Zusätzlich in'), sel),
    h('label.ad-field', h('span.ad-label', 'Ordner'), path));
  const s = sheet(body, { title: 'Zusätzlich spiegeln' });
  body.append(h('div.btn-row', h('button.btn', { type: 'button', onclick: () => s.close() }, 'Abbrechen'),
    h('button.btn.primary', { type: 'button', onclick: async () => { await setMirror(sel.value ? { cloudId: sel.value, folder: path.value } : null); s.close(); toast('Gespeichert'); onDone && onDone(); } }, 'Speichern')));
}

export { status };
