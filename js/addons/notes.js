// Notizen: Titel, Inhalt, Farbe, Fälligkeit, anheften, erledigen, gelöscht (wiederherstellbar). Daten wie am PC: notes.

import { h, icon, toast, actionSheet, confirmDialog } from '../util.js';
import { pref } from './prefs.js';
import { head, formSheet, deDate, shortDate, validDate, newId, today } from './ui.js';

const COLORS = { Indigo: '#6366F1', Lila: '#A855F7', 'Grün': '#10B981', Gelb: '#F59E0B', Rosa: '#F43F5E', Blau: '#0EA5E9' };
const state = { tab: 'Offen', q: '' };

export async function render(el, api, nav) {
  const notes = api.get('notes', []);
  const save = (list) => api.set('notes', list);
  const upd = (id, patch) => save(notes.map((n) => (n.id === id ? { ...n, ...patch } : n)));
  const count = { Offen: notes.filter((n) => !n.deleted && !n.done).length, Erledigt: notes.filter((n) => !n.deleted && n.done).length, 'Gelöscht': notes.filter((n) => n.deleted).length };
  const q = state.q.trim().toLowerCase();
  const list = notes.filter((n) => (state.tab === 'Gelöscht' ? n.deleted : !n.deleted && (state.tab === 'Erledigt') === !!n.done))
    .filter((n) => !q || `${n.title} ${n.content}`.toLowerCase().includes(q))
    .sort((a, b) => (state.tab === 'Offen' ? (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) : 0) || String(a.due_date || '9999').localeCompare(String(b.due_date || '9999')) || String(b.id).localeCompare(String(a.id)));

  const page = h('div.ad-page');
  page.append(...head('Notizen', { back: { label: 'Orbit', onclick: nav.hub } }));
  page.append(h('div.ad-actions', h('button.btn.primary.big', { onclick: () => form() }, icon('plus'), ' Neue Notiz'),
    h('input.input.ad-search', { type: 'search', placeholder: 'Suchen', value: state.q, oninput: (e) => { state.q = e.target.value; clearTimeout(page._t); page._t = setTimeout(() => nav.redraw(), 200); } })));
  page.append(h('div.seg.ad-seg', Object.keys(count).map((k) => h('button' + (state.tab === k ? '.on' : ''), { onclick: () => { state.tab = k; nav.redraw(); } }, `${k} (${count[k]})`))));
  if (!list.length) page.append(h('div.empty.small', h('p', 'Keine Notizen.')));
  page.append(h('div.ad-notes', list.map((n) => {
    const c = COLORS[n.color] || COLORS.Indigo;
    const overdue = n.due_date && !n.done && n.due_date < today();
    return h('button.ad-note', { style: { '--c': c }, onclick: () => menu(n) },
      h('div.ad-note-h', n.pinned ? icon('star', 'pin') : null, h('b', n.title || '(ohne Titel)'), n.done ? icon('check', 'done') : null),
      n.content ? h('p', n.content) : null,
      n.due_date ? h('small', { class: overdue ? 'err-text' : 'muted' }, `Fällig ${deDate(n.due_date)}`) : null);
  })));
  el.append(page);

  function form(n = null) {
    formSheet({
      title: n ? 'Notiz bearbeiten' : 'Neue Notiz',
      fields: [
        { key: 'title', label: 'Titel', type: 'text', value: n?.title || '' },
        { key: 'content', label: 'Inhalt', type: 'textarea', value: n?.content || '', rows: 6 },
        { key: 'due', label: 'Fälligkeitsdatum (optional)', type: 'date', value: shortDate(n?.due_date) },
        { key: 'color', label: 'Farbe', type: 'select', options: Object.keys(COLORS), value: n?.color || pref('notesColor') },
        { key: 'pinned', label: 'Oben anheften', type: 'check', value: !!n?.pinned },
      ],
      ok: n ? 'Speichern' : 'Erstellen',
      onSubmit: async (v) => {
        const title = v.title.trim();
        if (!title) return 'Bitte einen Titel eingeben.';
        if (v.due && !validDate(v.due)) return 'Bitte ein gültiges Datum wählen.';
        const rec = { id: n?.id || newId(), title, content: v.content, color: v.color, pinned: v.pinned, due_date: v.due || '', done: !!n?.done, deleted: false };
        await save(n ? notes.map((x) => (x.id === n.id ? { ...x, ...rec } : x)) : [...notes, rec]);
        toast('Notiz gespeichert.');
      },
    });
  }
  function menu(n) {
    if (n.deleted) {
      actionSheet(n.title || 'Notiz', [
        { label: 'Wiederherstellen', icon: 'sync', onclick: () => upd(n.id, { deleted: false }) },
        { label: 'Endgültig löschen', icon: 'trash', danger: true, onclick: async () => { if (await confirmDialog('Diese Notiz endgültig löschen?', { danger: true, ok: 'Löschen' })) save(notes.filter((x) => x.id !== n.id)); } },
      ]);
      return;
    }
    actionSheet(n.title || 'Notiz', [
      { label: 'Bearbeiten', icon: 'edit', onclick: () => form(n) },
      { label: n.done ? 'Wieder offen' : 'Erledigt', icon: 'check', onclick: () => upd(n.id, { done: !n.done }) },
      { label: n.pinned ? 'Nicht mehr anheften' : 'Oben anheften', icon: 'star', onclick: () => upd(n.id, { pinned: !n.pinned }) },
      { label: 'Löschen', icon: 'trash', danger: true, onclick: () => { upd(n.id, { deleted: true }); toast('Notiz gelöscht (im Reiter Gelöscht wiederherstellbar).'); } },
    ]);
  }
}
