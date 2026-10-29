// Reisen: Reisen mit Ablaufplan, Flügen, Unterkünften, Aktivitäten und weiteren Kosten. Daten wie am PC: trips, items.

import { h, icon, toast, actionSheet, confirmDialog } from '../util.js';
import { head, formSheet, stat, card, collapse, donut, fmt, eur, num, parseNum, deDate, shortDate, validDate, newId, PALETTE } from './ui.js';

const SECTIONS = {
  plan: { title: 'Ablaufplan', a: 'Was', b: 'Wo', c: 'Zeit / Tag', amt: null, cat: null },
  flight: { title: 'Flüge', a: 'Airline / Flugnummer', b: 'Strecke (z. B. FRA - BKK)', c: 'Abflug (Datum Uhrzeit)', amt: 'Preis (€)', cat: ['Hinflug', 'Rückflug', 'Zwischenstopp'] },
  hotel: { title: 'Unterkünfte', a: 'Name', b: 'Stadt', c: 'Check-in bis Check-out', amt: 'Preis (€)', cat: null },
  activity: { title: 'Aktivitäten', a: 'Name', b: 'Stadt / Ort', c: 'Link (optional)', amt: 'Preis (€)', cat: null },
  cost: { title: 'Weitere Kosten', a: 'Wofür', b: 'Notiz', c: 'Datum (JJJJ-MM-TT)', amt: 'Betrag (€)', cat: ['Essen', 'Transport', 'Shopping', 'Sonstiges'] },
};
const state = { trip: null, tab: 'ov' };

export async function render(el, api, nav) {
  const trips = api.get('trips', []);
  const items = api.get('items', []);
  const saveTrips = (l) => api.set('trips', l);
  const saveItems = (l) => api.set('items', l);
  const sum = (tid, kind) => items.filter((i) => i.trip_id === tid && i.kind === kind).reduce((s, i) => s + num(i.amount), 0);
  const total = (tid) => ['hotel', 'flight', 'activity', 'cost'].reduce((s, k) => s + sum(tid, k), 0);
  const trip = trips.find((t) => t.id === state.trip);
  if (state.trip && !trip) state.trip = null;

  const page = h('div.ad-page');
  el.append(page);
  if (!trip) return list();
  return detail();

  // ------------------------------------------------------------ Liste
  function list() {
    page.append(...head('Reisen', { back: { label: 'Orbit', onclick: nav.hub } }));
    page.append(h('div.ad-actions', h('button.btn.primary.big', { onclick: () => tripForm() }, icon('plus'), ' Neue Reise')));
    const sorted = [...trips].sort((a, b) => String(b.start_date || '').localeCompare(String(a.start_date || '')));
    if (!sorted.length) page.append(h('div.empty.small', h('p', 'Noch keine Reisen.')));
    page.append(h('div.ad-grid', sorted.map((t) => h('button.ad-card.ad-trip', { onclick: () => { state.trip = t.id; state.tab = 'ov'; nav.redraw(); } },
      t.cover ? h('img.cover', { src: t.cover, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', onerror: (e) => e.target.remove() }) : null,
      h('div.ad-trip-b', h('b', t.name), h('small.muted', [t.destination, [t.start_date, t.end_date].filter(Boolean).map(deDate).join(' – ')].filter(Boolean).join(' · ')),
        h('span.ad-trip-c', eur(total(t.id)), t.budget ? h('small.muted', ` von ${eur(num(t.budget), 0)}`) : null))))));
  }

  // ------------------------------------------------------------ Detail
  function detail() {
    page.append(...head(trip.name, {
      back: { label: 'Reisen', onclick: () => { state.trip = null; nav.redraw(); } },
      right: [h('button.nav-btn', { 'aria-label': 'Reise bearbeiten', onclick: () => tripMenu() }, icon('more'))],
      sub: [trip.destination, [trip.start_date, trip.end_date].filter(Boolean).map(deDate).join(' – ')].filter(Boolean).join(' · '),
    }));
    page.append(h('div.seg.ad-seg', [['ov', 'Übersicht'], ['co', 'Kosten']].map(([k, l]) => h('button' + (state.tab === k ? '.on' : ''), { onclick: () => { state.tab = k; nav.redraw(); } }, l))));
    if (state.tab === 'co') return costs();
    const t = total(trip.id), budget = num(trip.budget);
    page.append(h('div.ad-stats3',
      stat('Gesamtkosten', eur(t), budget ? `von ${eur(budget, 0)} Budget` : ''),
      stat('Unterkünfte', eur(sum(trip.id, 'hotel'))), stat('Flüge', eur(sum(trip.id, 'flight')))));
    if (budget) page.append(h('div.ad-budget', h('i', { style: { width: Math.min(100, t / budget * 100) + '%', background: t > budget ? 'var(--danger)' : 'var(--accent)' } })));
    for (const [kind, def] of Object.entries(SECTIONS)) {
      const its = items.filter((i) => i.trip_id === trip.id && i.kind === kind);
      const d = collapse(`${def.title} · ${its.length}`, kind === 'plan',
        h('button.btn.small', { onclick: () => itemForm(kind) }, icon('plus'), ' Hinzufügen'),
        h('div.ad-list', its.map((i) => h('button.ad-item', { onclick: () => itemMenu(i) },
          h('span.ad-i-main', h('b', { class: i.done ? 'ad-done' : '' }, i.a || i.c || '(ohne Text)'), [i.b, i.cat, kind === 'activity' ? '' : i.c].filter(Boolean).length ? h('small.muted', [i.b, i.cat, kind === 'activity' ? '' : i.c].filter(Boolean).join(' · ')) : null),
          i.amount != null ? h('span.ad-i-side', h('b', eur(i.amount))) : (i.done ? icon('check', 'done') : null)))));
      page.append(d);
    }
  }

  function costs() {
    const parts = [['Unterkünfte', 'hotel'], ['Flüge', 'flight'], ['Aktivitäten', 'activity'], ['Weitere Kosten', 'cost']].map(([label, k], i) => ({ label, value: sum(trip.id, k), color: PALETTE[i] }));
    page.append(card('Kosten nach Bereich', h('div.ad-donutrow', donut(parts, eur(total(trip.id), 0)),
      h('div.ad-legend.col', parts.map((p) => h('span', { style: { '--c': p.color } }, h('i.dot'), `${p.label}: ${eur(p.value)}`))))));
    const cats = {};
    for (const i of items.filter((x) => x.trip_id === trip.id && x.kind === 'cost')) cats[i.cat || 'Sonstiges'] = (cats[i.cat || 'Sonstiges'] || 0) + num(i.amount);
    if (Object.keys(cats).length) page.append(card('Weitere Kosten nach Kategorie', h('div.ad-list', Object.entries(cats).map(([k, v]) => h('div.ad-item.static', h('span.ad-i-main', h('b', k)), h('span.ad-i-side', h('b', eur(v))))))));
  }

  // ------------------------------------------------------------ Formulare
  function tripForm(t = null) {
    formSheet({
      title: t ? 'Reise bearbeiten' : 'Neue Reise',
      fields: [
        { key: 'name', label: 'Name', type: 'text', value: t?.name || '' },
        { key: 'destination', label: 'Ziel', type: 'text', value: t?.destination || '' },
        { key: 'start', label: 'Von', type: 'date', value: shortDate(t?.start_date) },
        { key: 'end', label: 'Bis', type: 'date', value: shortDate(t?.end_date) },
        { key: 'budget', label: 'Budget (€, optional)', type: 'number', value: t?.budget != null ? String(t.budget).replace('.', ',') : '' },
        { key: 'cover', label: 'Titelbild (Link, optional)', type: 'text', value: t?.cover || '' },
      ],
      onSubmit: async (v) => {
        const name = v.name.trim();
        if (!name) return 'Bitte einen Namen eingeben.';
        if ((v.start && !validDate(v.start)) || (v.end && !validDate(v.end))) return 'Bitte gültige Daten wählen.';
        const rec = { id: t?.id || newId(), name, destination: v.destination.trim(), start_date: v.start, end_date: v.end, budget: parseNum(v.budget), cover: v.cover.trim() };
        await saveTrips(t ? trips.map((x) => (x.id === t.id ? { ...x, ...rec } : x)) : [...trips, rec]);
        if (!t) { state.trip = rec.id; state.tab = 'ov'; }
      },
    });
  }
  function tripMenu() {
    actionSheet(trip.name, [
      { label: 'Reise bearbeiten', icon: 'edit', onclick: () => tripForm(trip) },
      { label: 'Reise löschen', hint: 'Mit allen Einträgen', icon: 'trash', danger: true, onclick: async () => {
        if (!(await confirmDialog(`„${trip.name}“ mit allen Einträgen löschen?`, { danger: true, ok: 'Löschen' }))) return;
        await saveItems(items.filter((i) => i.trip_id !== trip.id)); await saveTrips(trips.filter((x) => x.id !== trip.id)); state.trip = null;
      } },
    ]);
  }
  function itemForm(kind, i = null) {
    const def = SECTIONS[kind];
    formSheet({
      title: `${def.title}: ${i ? 'bearbeiten' : 'hinzufügen'}`,
      fields: [
        { key: 'a', label: def.a, type: 'text', value: i?.a || '' },
        { key: 'b', label: def.b, type: 'text', value: i?.b || '' },
        { key: 'c', label: def.c, type: 'text', value: i?.c || '' },
        def.cat ? { key: 'cat', label: 'Art', type: 'select', options: def.cat, value: i?.cat || def.cat[0] } : null,
        def.amt ? { key: 'amt', label: def.amt, type: 'number', value: i?.amount != null ? String(i.amount).replace('.', ',') : '' } : null,
      ].filter(Boolean),
      onSubmit: async (v) => {
        const a = v.a.trim();
        if (!a) return 'Bitte mindestens das erste Feld ausfüllen.';
        const rec = { id: i?.id || newId(), trip_id: trip.id, kind, a, b: v.b.trim(), c: v.c.trim(), cat: def.cat ? v.cat : '', amount: def.amt ? parseNum(v.amt) : null, done: !!i?.done };
        await saveItems(i ? items.map((x) => (x.id === i.id ? { ...x, ...rec } : x)) : [...items, rec]);
      },
    });
  }
  function itemMenu(i) {
    const link = i.kind === 'activity' && /^https?:\/\//.test(i.c || '') ? i.c : null;
    actionSheet(i.a, [
      { label: 'Bearbeiten', icon: 'edit', onclick: () => itemForm(i.kind, i) },
      { label: i.done ? 'Als offen markieren' : 'Erledigt / besucht', icon: 'check', onclick: () => saveItems(items.map((x) => (x.id === i.id ? { ...x, done: !x.done } : x))) },
      link ? { label: 'Link öffnen', icon: 'link', onclick: () => window.open(link, '_blank', 'noopener') } : null,
      { label: 'Löschen', icon: 'trash', danger: true, onclick: () => saveItems(items.filter((x) => x.id !== i.id)) },
    ]);
  }
}
