// Fitness: Kalorien und Gewicht. Daten wie am PC: weights {id,date,weight,notes}, logs {id,date,type food|activity,label,calories}.
// Am Handy wird erfasst, der PC zeigt nur an.

import { h, icon, actionSheet, confirmDialog, toast } from '../util.js';
import { head, formSheet, stat, card, collapse, fmt, num, parseNum, today, deDate, shortDate, validDate, newId } from './ui.js';
import { pref, setPrefs } from './prefs.js';

const QUICK = { 'Frühstück': 400, 'Mittagessen': 600, 'Abendessen': 500, 'Snack': 200 };
const state = { day: null };
const addDays = (s, n) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const dayLabel = (d) => d === today() ? 'Heute' : d === addDays(today(), -1) ? 'Gestern' : deDate(d);

function ageFrom(bd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(bd || '');
  if (!m) return null;
  const t = new Date(); let a = t.getFullYear() - +m[1];
  if (t.getMonth() + 1 < +m[2] || (t.getMonth() + 1 === +m[2] && t.getDate() < +m[3])) a--;
  return a;
}

export async function render(el, api, nav) {
  const weights = api.get('weights', []);
  const logs = api.get('logs', []);
  const saveW = (l) => api.set('weights', l);
  const saveL = (l) => api.set('logs', l);
  const day = state.day || today();
  const page = h('div.ad-page');
  el.append(page);

  const sortedW = weights.filter((w) => w.weight != null && String(w.weight) !== '').sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const totals = (d) => {
    let eaten = 0, burned = 0;
    for (const l of logs) if (l.date === d) { if (l.type === 'food') eaten += Math.abs(num(l.calories)); else burned += Math.abs(num(l.calories)); }
    return { eaten, burned };
  };
  const base = () => {
    const b = num(pref('fitBmr'));
    if (b > 0) return b;
    const age = ageFrom(pref('fitBirth')), hgt = num(pref('fitHeight'));
    if (sortedW.length && age != null && hgt > 0) {
      const v = 10 * num(sortedW[sortedW.length - 1].weight) + 6.25 * hgt - 5 * age;
      return Math.round(String(pref('fitGender')).startsWith('w') ? v - 161 : v + 5);
    }
    return num(pref('fitGoal')) || 2000;
  };
  const dt = totals(day), b = base(), budget = b + dt.burned, rem = budget - dt.eaten;

  page.append(...head('Fitness', {
    back: { label: 'Orbit', onclick: nav.hub },
    right: [h('button.nav-btn', { 'aria-label': 'Profil', onclick: () => profile() }, icon('more'))],
  }));
  page.append(h('div.seg.ad-seg',
    h('button', { onclick: () => { state.day = addDays(day, -1); nav.redraw(); } }, '‹'),
    h('button.on', dayLabel(day)),
    h('button', { onclick: () => { state.day = addDays(day, 1); nav.redraw(); } }, '›')));

  page.append(h('div.ad-stats3',
    stat('Gesamtumsatz', (rem >= 0 ? '+' : '-') + fmt(Math.abs(rem), 0), 'kcal', rem >= 0 ? 'var(--ok, #3DFFA2)' : 'var(--danger)'),
    stat('Gegessen', fmt(dt.eaten, 0), `von ${fmt(budget, 0)} kcal`), stat('Aktivität', fmt(dt.burned, 0), `Grundumsatz ${fmt(b, 0)}`)));
  page.append(h('div.ad-budget', h('i', { style: { width: Math.min(100, budget ? dt.eaten / budget * 100 : 0) + '%', background: rem < 0 ? 'var(--danger)' : 'var(--accent)' } })));
  page.append(h('p.muted.ad-sub', rem >= 0 ? `Du nimmst heute ab (${fmt(rem, 0)} kcal Überschuss)` : `Du nimmst heute zu (${fmt(Math.abs(rem), 0)} kcal über dem Budget)`));

  page.append(h('div.ad-actions',
    h('button.btn.primary', { onclick: () => foodForm() }, icon('plus'), ' Essen'),
    h('button.btn', { onclick: () => actForm() }, icon('plus'), ' Aktivität'),
    h('button.btn', { onclick: () => weightForm() }, icon('plus'), ' Gewicht')));
  page.append(h('div.ad-actions', Object.entries(QUICK).map(([k, v]) => h('button.btn.small', { onclick: () => saveL([...logs, { id: newId(), date: day, type: 'food', label: k, calories: v }]) }, `+ ${k} (${v})`))));

  const todays = logs.filter((l) => l.date === day).sort((a, c) => String(a.label).localeCompare(String(c.label)));
  page.append(card(`${dayLabel(day)} eingetragen · ${todays.length}`, h('div.ad-list', todays.length ? todays.map((l) => h('button.ad-item', { onclick: () => logMenu(l) },
    h('span.ad-i-main', h('b', l.label || (l.type === 'food' ? 'Essen' : 'Aktivität')), h('small.muted', l.type === 'food' ? 'Essen' : 'Aktivität')),
    h('span.ad-i-side', h('b', fmt(l.calories, 0) + ' kcal')))) : h('div.empty.small', h('p', 'Noch nichts eingetragen.')))));

  const cur = sortedW.length ? num(sortedW[sortedW.length - 1].weight) : null;
  const diff = sortedW.length > 1 ? Math.round((cur - num(sortedW[sortedW.length - 2].weight)) * 10) / 10 : null;
  const target = num(pref('fitTarget'));
  page.append(collapse(`Gewicht · ${sortedW.length}`, true,
    cur != null ? h('p', h('b', fmt(cur, 1) + ' kg'), diff != null ? h('span.muted', `  ${diff > 0 ? '+' : ''}${fmt(diff, 1)} kg`) : null, target > 0 ? h('span.muted', `  Ziel ${fmt(target, 1)} kg`) : null) : null,
    h('div.ad-list', [...sortedW].reverse().slice(0, 100).map((w) => h('button.ad-item', { onclick: () => weightMenu(w) },
      h('span.ad-i-main', h('b', deDate(w.date)), w.notes ? h('small.muted', w.notes) : null), h('span.ad-i-side', h('b', fmt(w.weight, 1) + ' kg')))))));

  // ------------------------------------------------------------ Formulare
  function foodForm(l = null) {
    formSheet({ title: l ? 'Essen bearbeiten' : 'Essen eintragen', fields: [
      { key: 'label', label: 'Bezeichnung', type: 'text', value: l?.label || '' },
      { key: 'cal', label: 'Kalorien (kcal)', type: 'number', value: l ? String(l.calories) : '' },
    ], onSubmit: async (v) => {
      const c = parseNum(v.cal);
      if (!v.label.trim() || !(c > 0)) return 'Bitte Bezeichnung und Kalorien eingeben.';
      const rec = { id: l?.id || newId(), date: l?.date || day, type: 'food', label: v.label.trim(), calories: c };
      await saveL(l ? logs.map((x) => (x.id === l.id ? { ...x, ...rec } : x)) : [...logs, rec]);
    } });
  }
  function actForm(l = null) {
    formSheet({ title: l ? 'Aktivität bearbeiten' : 'Aktivität eintragen', fields: [
      { key: 'label', label: 'Bezeichnung (optional)', type: 'text', value: l?.label && l.label !== 'Aktivität' ? l.label : '' },
      { key: 'cal', label: 'Verbrannte kcal', type: 'number', value: l ? String(l.calories) : '' },
    ], onSubmit: async (v) => {
      const c = parseNum(v.cal);
      if (!(c > 0)) return 'Bitte verbrannte Kalorien eingeben.';
      const rec = { id: l?.id || newId(), date: l?.date || day, type: 'activity', label: v.label.trim() || 'Aktivität', calories: c };
      await saveL(l ? logs.map((x) => (x.id === l.id ? { ...x, ...rec } : x)) : [...logs, rec]);
    } });
  }
  function weightForm(w = null) {
    formSheet({ title: w ? 'Gewicht bearbeiten' : 'Gewicht eintragen', fields: [
      { key: 'weight', label: 'Gewicht (kg)', type: 'number', value: w ? String(w.weight).replace('.', ',') : '' },
      { key: 'date', label: 'Datum', type: 'date', value: w ? shortDate(w.date) : today() },
      { key: 'notes', label: 'Notiz (optional)', type: 'text', value: w?.notes || '' },
    ], onSubmit: async (v) => {
      const x = parseNum(v.weight);
      if (!(x > 0)) return 'Bitte Gewicht eingeben.';
      if (!validDate(v.date)) return 'Bitte ein gültiges Datum wählen.';
      const rec = { id: w?.id || newId(), date: v.date, weight: x, notes: v.notes.trim() };
      await saveW(w ? weights.map((y) => (y.id === w.id ? { ...y, ...rec } : y)) : [...weights, rec]);
    } });
  }
  function logMenu(l) {
    actionSheet(l.label || 'Eintrag', [
      { label: 'Bearbeiten', icon: 'edit', onclick: () => (l.type === 'food' ? foodForm(l) : actForm(l)) },
      { label: 'Löschen', icon: 'trash', danger: true, onclick: () => saveL(logs.filter((x) => x.id !== l.id)) },
    ]);
  }
  function weightMenu(w) {
    actionSheet(`${fmt(w.weight, 1)} kg · ${deDate(w.date)}`, [
      { label: 'Bearbeiten', icon: 'edit', onclick: () => weightForm(w) },
      { label: 'Löschen', icon: 'trash', danger: true, onclick: async () => {
        if (await confirmDialog('Diese Messung löschen?', { danger: true, ok: 'Löschen' })) await saveW(weights.filter((x) => x.id !== w.id));
      } },
    ]);
  }
  function profile() {
    formSheet({ title: 'Profil und Ziele', fields: [
      { key: 'height', label: 'Körpergröße (cm)', type: 'number', value: pref('fitHeight') ? String(pref('fitHeight')) : '' },
      { key: 'target', label: 'Zielgewicht (kg, leer = keins)', type: 'number', value: pref('fitTarget') ? String(pref('fitTarget')).replace('.', ',') : '' },
      { key: 'birth', label: 'Geburtsdatum', type: 'date', value: pref('fitBirth') || '' },
      { key: 'gender', label: 'Geschlecht', type: 'select', options: ['männlich', 'weiblich'], value: pref('fitGender') },
      { key: 'goal', label: 'Tägliches Kalorienziel (kcal)', type: 'number', value: String(pref('fitGoal')) },
      { key: 'bmr', label: 'Grundumsatz (kcal, leer = automatisch)', type: 'number', value: pref('fitBmr') ? String(pref('fitBmr')) : '' },
    ], onSubmit: async (v) => {
      if (v.birth && !validDate(v.birth)) return 'Bitte ein gültiges Geburtsdatum wählen.';
      await setPrefs({ fitHeight: parseNum(v.height) || 0, fitTarget: parseNum(v.target) || 0, fitBirth: v.birth || '', fitGender: v.gender, fitGoal: parseNum(v.goal) || 2000, fitBmr: parseNum(v.bmr) || 0 });
      nav.redraw();
    } });
  }
}
