// Oberfläche fürs Kassenbuch: Abgleichen, Früheren Stand holen, Hinweis bei vielen Löschungen, Protokoll.

import { h, icon, toast, confirmDialog, sheet, clear } from '../util.js';
import { errText } from '../fileops.js';
import { syncNow, historyPoints, previewFor, restore, status, confirmBulk, restoreBulk, addonTitle } from './ledger.js';
import { ADDONS } from './store.js';
import { getLog } from './stands.js';

export { status };
const fmtT = (t) => new Date(t).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });

/** Abgleichen mit Meldung. Bei vielen Löschungen auf einmal wird nachgefragt. */
export async function abgleichen() {
  try {
    const r = await syncNow();
    if (status.bulk.length) { await askBulk(); return true; }
    toast(r.merged ? 'Abgeglichen – neue Daten von anderen Geräten übernommen' : r.changed ? 'Abgeglichen' : 'Alles aktuell');
    return true;
  } catch (e) { toast(errText(e), 'err'); return false; }
}

const bulkText = (list) => list.map((b) => `${addonTitle(b.a)}: ${b.dels} von ${b.total} Einträgen`).join('\n');

export async function askBulk() {
  const list = status.bulk.slice();
  if (!list.length) return;
  const del = await confirmDialog('Auf diesem Gerät fehlen auf einmal viele Einträge:\n' + bulkText(list) + '\n\nHast du sie bewusst gelöscht? Wenn nicht, hole ich sie aus dem Kassenbuch zurück.', { title: 'Viele Löschungen', ok: 'Ja, löschen', cancel: 'Nein, zurückholen', danger: true });
  try { await (del ? confirmBulk(list) : restoreBulk(list)); toast(del ? 'Löschungen eingetragen' : 'Zurückgeholt'); } catch (e) { toast(errText(e), 'err'); }
}

const previewText = (counts) => {
  const lines = Object.entries(counts).map(([pc, c]) => `${addonTitle(pc)}: ${c.neu} neu, ${c.geaendert} geändert, ${c.weg} entfallen`);
  return lines.length ? 'Gegenüber jetzt:\n' + lines.join('\n') : 'Gegenüber jetzt: keine Unterschiede.';
};

/** Früheren Stand holen: Liste aus Kassenbuch (Tage) und alten Ständen, mit Vorschau. Nichts geht verloren: es entstehen neue Buchungen. */
export async function openRestore(onDone) {
  const body = h('div', h('p.muted', 'Lädt …'));
  const s = sheet(body, { title: 'Früheren Stand holen', wide: true });
  let pts;
  try { pts = await historyPoints(); } catch (e) { body.replaceChildren(h('p.err-text', errText(e))); return; }
  if (!pts.length) { body.replaceChildren(h('p.muted', 'Es gibt noch kein Kassenbuch. Tippe auf „Abgleichen“.')); return; }
  const pick = async (pt) => {
    let pv;
    try { pv = await previewFor(pt); } catch (e) { toast(errText(e), 'err'); return; }
    if (!(await confirmDialog(`${pt.label}\nDeine jetzigen Daten werden vorher auf diesem Gerät gesichert, und der Stand wird als neue Änderung eingetragen. Nichts wird überschrieben.\n\n` + previewText(pv.counts), { title: 'Stand holen?', ok: 'Holen' }))) return;
    try { await restore(pt, pv.target); toast('Stand geholt'); s.close(); onDone && onDone(); } catch (e) { toast(errText(e), 'err'); }
  };
  body.replaceChildren(h('p.muted', 'Wähle den Zeitpunkt. Neueste oben.'), h('div.group-body', pts.map((pt) => h('button.row', { onclick: () => pick(pt) },
    h('span.row-main', h('span.row-title', pt.label), h('small.row-sub', pt.kind === 'stand' ? 'Altbestand aus der alten Sicherung' : 'Aus dem Kassenbuch')), icon('chevron', 'chev')))));
}

export async function openLog() {
  const l = await getLog();
  sheet(h('div', l.length ? h('div.group-body', l.map((e) => h('div.row', h('span.row-main', h('span.row-title', e.what), h('small.row-sub', fmtT(e.t) + (e.detail ? ' · ' + e.detail : '')))))) : h('p.muted', 'Noch keine Einträge.')), { title: 'Protokoll', wide: true });
}
