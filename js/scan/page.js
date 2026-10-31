// Reiter „Scan“: Dokument fotografieren, Ränder erkennen, entzerren, als PDF mit durchsuchbarem Text in einen Cloud-Ordner legen.
// Die Liste der Scans (Name, Ort, Text) liegt im Add-on „Scans“ und gleicht sich wie die anderen Add-ons mit Orbit am PC ab.

import { h, icon, clear, toast, actionSheet, confirmDialog, sheet } from '../util.js';
import { kv } from '../db.js';
import { connById, connByKey, source } from '../sources/registry.js';
import { joinPath, baseName } from '../sources/base.js';
import { pageHead, openItem } from '../files.js';
import { pickFolder } from '../picker.js';
import { connName, errText } from '../fileops.js';
import { openAddon, onAddon } from '../addons/store.js';
import { formSheet, newId, deDate } from '../addons/ui.js';
import { loadPhoto, findDocument, startQuad, warp, enhance, rotate } from './vision.js';
import { cropEditor } from './crop.js';
import { buildPdf } from './pdf.js';
import { recognize, stopOcr } from './ocr.js';

const KEY = 'scan:settings';
export const DEFAULT_RULES = [
  { word: 'Rechnung', folder: 'Rechnungen' },
  { word: 'Kontoauszug', folder: 'Kontoauszüge' },
  { word: 'Versicherung', folder: 'Versicherung' },
  { word: 'Vertrag', folder: 'Verträge' },
  { word: 'Steuer', folder: 'Steuer' },
  { word: 'Rezept', folder: 'Gesundheit' },
  { word: 'Arzt', folder: 'Gesundheit' },
  { word: 'Garantie', folder: 'Garantie' },
];
const QUALITY = { standard: { side: 2000, jpeg: 0.72, label: 'Standard' }, hoch: { side: 2800, jpeg: 0.82, label: 'Hoch' }, klein: { side: 1500, jpeg: 0.6, label: 'Klein' } };
const MODES = { dokument: 'Dokument (grau, klar)', farbe: 'Farbe', sw: 'Schwarz-Weiß' };

export async function loadScanSettings() {
  return { folder: null, mode: 'dokument', quality: 'standard', ocr: true, sort: true, rules: DEFAULT_RULES, prefix: 'Scan', cropAsk: true, ...(await kv.get(KEY)) };
}
const saveScanSettings = (s) => kv.set(KEY, s);

/** Erste Regel mit den meisten Treffern im Text gewinnt (Groß/Kleinschreibung egal). */
export function categorize(text, rules) {
  const t = (text || '').toLowerCase();
  let best = null, bestN = 0;
  for (const r of rules || []) {
    const w = (r.word || '').trim().toLowerCase();
    if (!w || !r.folder?.trim()) continue;
    let n = 0, i = -1;
    while ((i = t.indexOf(w, i + 1)) >= 0) n++;
    if (n > bestN) { best = r.folder.trim(); bestN = n; }
  }
  return best;
}

const pending = [];       // { photo, quad (oder null), useQuad, mode, rot, out }
let search = '';

async function render(p) {
  p.out = enhance(rotate(p.useQuad && p.quad ? warp(p.photo, p.quad, 2800) : p.photo, p.rot), p.mode);
}

export async function renderScan(view) {
  const st = await loadScanSettings();
  const api = await openAddon('scans');
  const page = h('div.page.ios.scan');
  clear(view).append(page);
  const input = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true, onchange: async () => {
    const files = [...input.files]; input.value = '';
    for (const f of files) await addPhoto(f);
  } });
  const pick = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, onchange: async () => {
    const files = [...pick.files]; pick.value = '';
    for (const f of files) await addPhoto(f);
  } });
  page.append(...pageHead({ title: 'Scan', right: [h('button.nav-btn', { 'aria-label': 'Scan-Einstellungen', onclick: () => settingsSheet(st, redraw) }, icon('gear'))] }), input, pick);
  const body = h('div.scan-body');
  page.append(body);
  let busy = false;

  async function addPhoto(file) {
    if (busy) return;
    busy = true; redraw();
    try {
      const photo = await loadPhoto(file, 2800);
      let quad = findDocument(photo), useQuad = !!quad;
      if (st.cropAsk || !quad) {
        // Ecken prüfen bzw. selbst setzen (erkannte Ränder sind schon vorgewählt)
        const r = await cropEditor(photo, startQuad(photo).quad);
        if (!r) { busy = false; redraw(); return; }
        if (r.quad) { quad = r.quad; useQuad = true; } else useQuad = false;
      }
      const p = { photo, quad, useQuad, mode: st.mode, rot: 0, out: null };
      await new Promise((r) => setTimeout(r, 0));
      await render(p);
      pending.push(p);
    } catch (e) { toast(errText(e), 'err'); }
    busy = false; redraw();
  }

  function tile(p, i) {
    const c = document.createElement('canvas');
    const k = 220 / Math.max(p.out.width, p.out.height);
    c.width = Math.round(p.out.width * k); c.height = Math.round(p.out.height * k);
    c.getContext('2d').drawImage(p.out, 0, 0, c.width, c.height);
    return h('button.scan-tile', { onclick: () => pageMenu(p, i) }, c, h('span.scan-n', String(i + 1)));
  }
  function pageMenu(p, i) {
    const redo = async () => { busy = true; redraw(); try { await render(p); } catch (e) { toast(errText(e), 'err'); } busy = false; redraw(); };
    actionSheet(`Seite ${i + 1}`, [
      { label: 'Zuschneiden …', icon: 'camera', onclick: async () => {
        const r = await cropEditor(p.photo, p.quad || startQuad(p.photo).quad);
        if (!r) return;
        if (r.quad) { p.quad = r.quad; p.useQuad = true; } else p.useQuad = false;
        redo();
      } },
      { label: 'Nach rechts drehen', icon: 'sync', onclick: () => { p.rot = (p.rot + 1) % 4; redo(); } },
      { label: 'Nach links drehen', icon: 'sync', onclick: () => { p.rot = (p.rot + 3) % 4; redo(); } },
      { label: p.useQuad ? 'Ganzes Foto verwenden' : 'Ränder automatisch erkennen', icon: 'camera', onclick: () => {
        if (!p.useQuad && !p.quad) { toast('Es konnten keine Ränder erkannt werden.'); return; }
        p.useQuad = !p.useQuad; redo();
      } },
      ...Object.entries(MODES).filter(([m]) => m !== p.mode).map(([m, label]) => ({ label: 'Darstellung: ' + label, icon: 'image', onclick: () => { p.mode = m; redo(); } })),
      '-',
      i > 0 ? { label: 'Nach vorn schieben', icon: 'up', onclick: () => { pending.splice(i, 1); pending.splice(i - 1, 0, p); redraw(); } } : null,
      { label: 'Seite löschen', icon: 'trash', danger: true, onclick: () => { pending.splice(i, 1); redraw(); } },
    ]);
  }

  async function chooseFolder() {
    if (st.folder && connById(st.folder.conn)) return st.folder;
    const f = await pickFolder('Wohin sollen Scans gespeichert werden?', { ok: 'Hier speichern' });
    if (!f) return null;
    if (await confirmDialog(`Soll „${f.path === '/' ? connName(f.conn) : baseName(f.path)}“ der feste Ordner für Scans sein? Das lässt sich in den Scan-Einstellungen ändern.`, { title: 'Ordner merken?', ok: 'Merken', cancel: 'Nur diesmal' })) {
      st.folder = f; await saveScanSettings(st);
    }
    return f;
  }

  async function save() {
    if (!pending.length || busy) return;
    const folder = await chooseFolder();
    if (!folder) return;
    busy = true;
    const prog = h('div.scan-prog', h('div.spinner'), h('span', 'Vorbereiten …'));
    const dlg = sheet(h('div.dialog-body', h('p', 'Das PDF wird erstellt.'), prog), { title: 'Scan speichern' });
    const say = (t) => { prog.lastChild.textContent = t; };
    try {
      const q = QUALITY[st.quality] || QUALITY.standard;
      const pages = [];
      let all = '';
      for (let i = 0; i < pending.length; i++) {
        const src = pending[i].out;
        const k = Math.min(1, q.side / Math.max(src.width, src.height));
        const c = document.createElement('canvas');
        c.width = Math.round(src.width * k); c.height = Math.round(src.height * k);
        c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
        let words = [];
        if (st.ocr) {
          say(`Seite ${i + 1} von ${pending.length}: Text erkennen …`);
          try {
            const r = await recognize(c, (m) => { if (m.status && m.progress != null) say(`Seite ${i + 1} von ${pending.length}: ${m.status === 'recognizing text' ? 'Text erkennen' : 'Vorbereiten'} ${Math.round(m.progress * 100)} %`); });
            words = r.words; all += (all ? '\n\n' : '') + r.text;
          } catch (e) { toast('Texterkennung nicht möglich: ' + errText(e), 'err'); }
        }
        const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', q.jpeg));
        pages.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), w: c.width, h: c.height, words });
      }
      const d = new Date(), p2 = (x) => String(x).padStart(2, '0');
      const base = `${(st.prefix || 'Scan').trim() || 'Scan'} ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}-${p2(d.getMinutes())}`;
      const category = st.sort && all ? categorize(all, st.rules) : null;
      say('Hochladen …');
      const pdf = buildPdf(pages, { title: base, dpi: Math.round(Math.max(...pages.map((x) => Math.max(x.w, x.h))) / 11.69) });
      const src = await source(folder.conn);
      let dir = folder.path;
      if (category) { dir = joinPath(folder.path, category); try { await src.mkdir(folder.path, category); } catch { /* gibt es schon */ } }
      let name = base + '.pdf';
      await src.upload(pdf, dir, name, { onProgress: (n) => say(`Hochladen ${Math.round((n / pdf.size) * 100)} %`) });
      const c = connById(folder.conn);
      const rec = { id: newId(), name, cloud: c?.key || c?.name || '', path: joinPath(dir, name), date: d.toISOString(), pages: pages.length, size: pdf.size, category: category || '', text: all.slice(0, 30000) };
      await api.set('scans', [...api.get('scans', []), rec]);
      pending.length = 0;
      dlg.close();
      toast(`Gespeichert: ${category ? category + '/' : ''}${name}`);
    } catch (e) {
      dlg.close();
      toast('Speichern fehlgeschlagen: ' + errText(e), 'err');
    }
    stopOcr();
    busy = false; redraw();
  }

  function redraw() {
    clear(body);
    if (busy && !pending.length) body.append(h('div.loading', h('div.spinner'), 'Bild wird bearbeitet …'));
    body.append(h('div.scan-actions',
      h('button.btn.primary.big', { onclick: () => input.click(), disabled: busy }, icon('camera'), pending.length ? ' Nächste Seite fotografieren' : ' Dokument scannen'),
      h('button.btn.block', { onclick: () => pick.click(), disabled: busy }, icon('image'), ' Foto aus der Mediathek')));
    if (pending.length) {
      body.append(h('div.scan-tiles', pending.map(tile), busy ? h('div.scan-tile.busy', h('div.spinner')) : null),
        h('p.muted.small', 'Tippe auf eine Seite, um sie zu drehen, die Darstellung zu ändern oder sie zu löschen.'),
        h('div.btn-row',
          h('button.btn', { onclick: async () => { if (await confirmDialog('Alle Seiten verwerfen?', { danger: true, ok: 'Verwerfen' })) { pending.length = 0; redraw(); } } }, 'Verwerfen'),
          h('button.btn.primary', { onclick: save, disabled: busy }, `Als PDF speichern (${pending.length})`)));
    }
    const dest = st.folder && connById(st.folder.conn) ? `${connName(st.folder.conn)} › ${st.folder.path === '/' ? '' : st.folder.path}` : 'noch nicht festgelegt – wird beim Speichern gefragt';
    body.append(h('p.muted.small.scan-dest', 'Speicherort: ' + dest));
    const scans = api.get('scans', []).slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
    if (scans.length) {
      const q = search.trim().toLowerCase();
      const shown = scans.filter((s) => !q || `${s.name} ${s.category} ${s.text}`.toLowerCase().includes(q));
      body.append(h('h2.group-title', `Meine Scans (${scans.length})`),
        h('input.input.ad-search', { type: 'search', placeholder: 'In Namen und Texten suchen', value: search, oninput: (e) => { search = e.target.value; clearTimeout(body._t); body._t = setTimeout(() => { const pos = e.target.selectionStart; redraw(); const el = body.querySelector('input[type=search]'); el?.focus(); el?.setSelectionRange(pos, pos); }, 250); } }),
        h('div.group-body', shown.slice(0, 100).map((s) => h('button.row', { onclick: () => scanMenu(s) },
          h('span.srcicon', { style: { background: '#FFD24A' } }, icon('file')),
          h('span.row-main', h('span.row-title', s.name), h('small.row-sub', `${deDate(s.date)}${s.category ? ' · ' + s.category : ''} · ${s.pages} Seite${s.pages === 1 ? '' : 'n'}`, snippet(s.text, q))),
          icon('chevron', 'chev'))),
          shown.length ? null : h('p.muted.pad', 'Nichts gefunden.')));
    }
  }
  function snippet(text, q) {
    if (!q || !text) return null;
    const i = text.toLowerCase().indexOf(q);
    if (i < 0) return null;
    return h('span.snip', ' · …' + text.slice(Math.max(0, i - 25), i + 45).replace(/\s+/g, ' ') + '…');
  }
  function scanMenu(s) {
    actionSheet(s.name, [
      { label: 'Öffnen', icon: 'file', onclick: () => {
        const c = connByKey(s.cloud) || connById(s.cloud);
        if (!c) { toast('Diese Cloud ist auf diesem Gerät nicht angemeldet.', 'err'); return; }
        openItem({ conn: c.id, path: s.path, name: s.name, isFolder: false, size: s.size || 0 });
      } },
      { label: 'Nur aus der Liste entfernen', icon: 'trash', danger: true, onclick: async () => {
        if (await confirmDialog('Der Eintrag verschwindet aus der Liste (auch am PC). Die PDF-Datei in der Cloud bleibt erhalten.', { danger: true, ok: 'Entfernen' })) await api.set('scans', api.get('scans', []).filter((x) => x.id !== s.id));
      } },
    ]);
  }
  const off = onAddon((id, kind) => { if (id !== 'scans' || kind !== 'data') return; if (document.body.contains(page)) redraw(); else off(); });
  redraw();
}

function settingsSheet(st, done) {
  const where = st.folder && connById(st.folder.conn) ? `${connName(st.folder.conn)} › ${st.folder.path}` : 'nicht festgelegt';
  const extra = h('div.ad-extra',
    h('p.muted.small', 'Speicherort: ' + where),
    h('button.btn.block', { type: 'button', onclick: async () => {
      const f = await pickFolder('Ordner für Scans', { start: st.folder, ok: 'Diesen Ordner verwenden' });
      if (f) { st.folder = f; await saveScanSettings(st); toast('Ordner gespeichert.'); done(); }
    } }, icon('folder'), ' Speicherort wählen …'),
    st.folder ? h('button.btn.block', { type: 'button', onclick: async () => { st.folder = null; await saveScanSettings(st); toast('Ordner entfernt – beim nächsten Scan wird gefragt.'); done(); } }, 'Ordner vergessen (beim Speichern fragen)') : null,
    h('button.btn.block', { type: 'button', onclick: () => rulesSheet(st) }, icon('list'), ' Sortier-Regeln für Unterordner …'));
  formSheet({
    title: 'Scan-Einstellungen',
    fields: [
      { key: 'mode', label: 'Darstellung', type: 'select', options: Object.entries(MODES).map(([value, label]) => ({ value, label })), value: st.mode },
      { key: 'quality', label: 'Bildqualität (Dateigröße)', type: 'select', options: Object.entries(QUALITY).map(([value, q]) => ({ value, label: q.label })), value: st.quality },
      { key: 'cropAsk', label: 'Nach dem Foto die Ecken prüfen (Zuschneiden)', type: 'check', value: st.cropAsk },
      { key: 'ocr', label: 'Text erkennen (PDF durchsuchbar)', type: 'check', value: st.ocr },
      { key: 'sort', label: 'Nach Regeln in Unterordner sortieren', type: 'check', value: st.sort },
      { key: 'prefix', label: 'Dateiname beginnt mit', type: 'text', value: st.prefix },
    ],
    extra,
    onSubmit: async (v) => { Object.assign(st, { mode: v.mode, quality: v.quality, cropAsk: v.cropAsk, ocr: v.ocr, sort: v.sort, prefix: v.prefix.trim() || 'Scan' }); await saveScanSettings(st); done(); },
  });
}

function rulesSheet(st) {
  const rows = (st.rules || []).map((r) => ({ ...r }));
  const list = h('div.ad-rules');
  const paint = () => {
    clear(list);
    rows.forEach((r, i) => list.append(h('div.ad-rule',
      h('input.input', { value: r.word, placeholder: 'Wort im Text', oninput: (e) => { r.word = e.target.value; } }),
      h('span', '→'),
      h('input.input', { value: r.folder, placeholder: 'Unterordner', oninput: (e) => { r.folder = e.target.value; } }),
      h('button.btn', { type: 'button', 'aria-label': 'Entfernen', onclick: () => { rows.splice(i, 1); paint(); } }, icon('trash')))));
    list.append(h('button.btn.block', { type: 'button', onclick: () => { rows.push({ word: '', folder: '' }); paint(); } }, icon('plus'), ' Regel hinzufügen'));
  };
  paint();
  const body = h('div.dialog-body', h('p.muted.small', 'Kommt das Wort im erkannten Text vor, landet der Scan im Unterordner des Scan-Ordners. Gewinnt das Wort mit den meisten Treffern. Läuft komplett auf dem Gerät.'), list,
    h('div.btn-row', h('button.btn', { onclick: () => s.close() }, 'Abbrechen'), h('button.btn.primary', { onclick: async () => { st.rules = rows.filter((r) => r.word.trim() && r.folder.trim()); await saveScanSettings(st); s.close(); toast('Regeln gespeichert.'); } }, 'Speichern')));
  const s = sheet(body, { title: 'Sortier-Regeln' });
}
