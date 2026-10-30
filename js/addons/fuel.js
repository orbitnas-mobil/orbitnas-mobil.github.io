// Fuel Tracker: Tanken und Laden mit mehreren Fahrzeugen, Zusatzkosten, Vergleich, Monatsdiagramm, Rechner.
// Daten wie am PC (Add-on de.dennis.orbit-fuel): vehicles, entries, costs.

import { h, icon, toast, actionSheet, confirmDialog } from '../util.js';
import { pref } from './prefs.js';
import { head, formSheet, stat, card, collapse, barChart, donut, splitBar, fmt, eur, num, parseNum, today, deDate, validDate, newId, PALETTE } from './ui.js';

const DEFAULTS = [
  { id: 'bmw_diesel', name: 'BMW Diesel', kind: 'diesel', consumption: 5.3, archived: false },
  { id: 'tesla_model3', name: 'Tesla Model 3', kind: 'strom', consumption: 15, archived: false },
];

/** Standardfahrzeuge (BMW, Tesla) fest in den Speicher schreiben, damit ein „Schnitt“ sie mitnimmt. */
export async function materialize(api) {
  const { vehicles } = load(api);
  if (vehicles.length) await api.set('vehicles', vehicles);
}

const state = { period: 'Alle', moreEntries: false, moreCosts: false, calc: { cents: '35', ev: '15', diesel: '2,20', dcons: '5,5' } };

function load(api) {
  // Datensätze ohne Namen (Geisterfahrzeuge aus leeren Einträgen) gehören nirgends hin: ausblenden, damit BMW und Tesla wieder vorgeschlagen werden
  const vehicles = api.get('vehicles', []).filter((v) => v && typeof v === 'object' && String(v.name || '').trim());
  const entries = api.get('entries', []);
  const costs = api.get('costs', []);
  // Standard-Fahrzeuge wie am PC: wenn die Liste leer ist oder Einträge sich auf sie beziehen
  // (nur im Speicher, nicht in die Cloud schreiben: sonst überschreibt ein leerer Handy-Stand die Fahrzeuge vom PC)
  const empty = vehicles.length === 0;
  for (const d of DEFAULTS) {
    if (vehicles.some((v) => v.id === d.id)) continue;
    const used = entries.some((e) => e.vehicle === d.id) || costs.some((c) => c.vehicle === d.id);
    if (empty || used) vehicles.push({ ...d });
  }
  return { vehicles, entries, costs };
}

// Fahrzeugfarben wie am PC: gewählte Farbe, sonst die erste noch freie (keine doppelt vergeben)
const VPAL = ['#00D4FF', '#A855F7', '#FF3DCB', '#3DFFA2', '#FFD24A', '#FF8A3D', '#FF5C7A', '#94A3B8'];
const VNAMES = { Automatisch: '', Blau: '#00D4FF', Lila: '#A855F7', Pink: '#FF3DCB', 'Grün': '#3DFFA2', Gelb: '#FFD24A', Orange: '#FF8A3D', Rot: '#FF5C7A', Grau: '#94A3B8' };
const colorName = (hex) => Object.keys(VNAMES).find((k) => VNAMES[k].toUpperCase() === String(hex || '').toUpperCase()) || 'Automatisch';
function colorMap(list) {
  const used = new Set(list.filter((v) => v.color).map((v) => String(v.color).toUpperCase())), out = new Map();
  list.forEach((v, i) => {
    if (v.color) { out.set(v.id, v.color); return; }
    const c = VPAL.find((x) => !used.has(x)) || VPAL[i % VPAL.length];
    used.add(c); out.set(v.id, c);
  });
  return out;
}
const unitOf = (v) => (v.kind === 'strom' ? 'kWh' : 'l');
const inPeriod = (list) => (state.period === 'Alle' ? list : list.filter((x) => String(x.date || '').startsWith(state.period)));

function stats(v, ents, cts) {
  const own = ents.filter((e) => e.vehicle === v.id), extra = cts.filter((c) => c.vehicle === v.id);
  const cons = num(v.consumption);
  const amount = own.reduce((s, e) => s + num(e.amount), 0), fuel = own.reduce((s, e) => s + num(e.cost), 0), ex = extra.reduce((s, c) => s + num(c.amount), 0);
  const avg = amount > 0 ? fuel / amount : 0;
  const per100 = cons * avg;
  const km = cons > 0 ? (amount / cons) * 100 : 0;
  const total = fuel + ex;
  return { cons, amount, fuel, extra: ex, total, avg, per100, workday: per100 * (pref('workKm') / 100), km, perKm: km > 0 ? total / km : 0, count: own.length };
}

export async function render(el, api, nav) {
  const { vehicles, entries, costs } = load(api);
  const save = (key, val) => api.set(key, val);
  const act = vehicles.filter((v) => !v.archived);
  const ents = inPeriod(entries), cts = inPeriod(costs);
  const years = [...new Set([...entries, ...costs].map((x) => String(x.date || '').slice(0, 4)).filter((y) => /^\d{4}$/.test(y)))].sort().reverse();
  const st = new Map(act.map((v) => [v.id, stats(v, ents, cts)]));
  const cmap = colorMap(act), vcol = colorMap(vehicles);
  const colorOf = (v) => cmap.get(v.id) || PALETTE[0];
  const vName = (id) => vehicles.find((v) => v.id === id)?.name || id;

  const page = h('div.ad-page');
  page.append(...head('Fuel Tracker', {
    back: { label: 'Orbit', onclick: nav.hub },
    sub: act.map((v) => `${v.name} ${fmt(v.consumption, 1)} ${unitOf(v)}/100 km`).join(' · '),
  }));

  page.append(h('div.ad-actions',
    h('button.btn.primary.big', { onclick: () => entryForm() }, icon('plus'), ' Tanken / Laden'),
    h('button.btn', { onclick: () => costForm() }, 'Zusatzkosten'),
    h('select.input.ad-period', { 'aria-label': 'Zeitraum', onchange: (e) => { state.period = e.target.value; nav.redraw(); } },
      ['Alle', ...years].map((y) => h('option', { value: y, selected: y === state.period }, y === 'Alle' ? 'Alle Zeiträume' : y)))));

  if (!act.length) page.append(h('div.empty.small', h('p', 'Noch kein Fahrzeug. Lege unten unter „Fahrzeuge“ eines an.')));

  // Kennzahlen je Fahrzeug
  if (act.length) {
    page.append(h('div.ad-grid', act.map((v) => {
      const s = st.get(v.id), c = colorOf(v);
      return h('section.ad-card.ad-veh', { style: { '--c': c } },
        h('div.ad-vh', h('i.dot'), h('b', v.name), h('small.muted', `${s.count} ${v.kind === 'strom' ? 'Ladungen' : 'Tankungen'}`)),
        h('div.ad-stats3',
          stat('Kosten / 100 km', eur(s.per100)),
          stat('Kosten / Arbeitstag', eur(s.workday), `${pref('workKm')} km`),
          stat(v.kind === 'strom' ? 'Ø Preis / kWh' : 'Ø Preis / l', eur(s.avg, 3))),
        h('div.ad-line', h('span', 'Pro Kilometer'), h('b', fmt(s.perKm, 3) + ' €/km')),
        h('div.ad-line', h('span', 'Gesamt'), h('b', `${eur(s.total)} · ${fmt(s.km, 0)} km`)));
    })));
  }

  // Vergleich
  if (act.length >= 2) {
    const [a, b] = act;
    const defs = [
      ['Kosten / 100 km', (s) => s.per100, (x) => eur(x)],
      [`Kosten / Arbeitstag (${pref('workKm')} km)`, (s) => s.workday, (x) => eur(x)],
      ['Ø Preis je l / kWh', (s) => s.avg, (x) => eur(x, 3)],
      ['Kraftstoff gesamt', (s) => s.fuel, (x) => eur(x)],
      ['Zusatzkosten gesamt', (s) => s.extra, (x) => eur(x)],
      ['Gesamtkosten', (s) => s.total, (x) => eur(x)],
    ];
    const rows = defs.map(([label, f, fmtv]) => {
      const x0 = f(st.get(a.id)), x1 = f(st.get(b.id));
      return h('div.ad-cmp', h('div.ad-cmp-h', h('b.l', { class: x0 < x1 ? 'good' : '' }, fmtv(x0)), h('span', label), h('b.r', { class: x1 < x0 ? 'good' : '' }, fmtv(x1))),
        splitBar([{ value: x0, color: colorOf(a) }, { value: x1, color: colorOf(b) }]));
    });
    const cand = act.filter((v) => st.get(v.id).per100 > 0).sort((p, q) => st.get(p.id).per100 - st.get(q.id).per100);
    const better = cand.length >= 2 ? (() => {
      const d = st.get(cand[cand.length - 1].id).per100 - st.get(cand[0].id).per100;
      return h('div.ad-better', h('b', `${cand[0].name} ist günstiger`), h('span', `${eur(d)} pro 100 km · ${eur(d * pref('workKm') / 100)} pro Arbeitstag`));
    })() : null;
    page.append(card('KFZ-Vergleich', h('div.ad-legend', act.slice(0, 2).map((v) => h('span', { style: { '--c': colorOf(v) } }, h('i.dot'), v.name))), ...rows, better));
  }

  // Diagramme
  if (act.length && pref('fuelCharts')) {
    const months = [...new Set([...ents, ...cts].map((x) => String(x.date || '').slice(0, 7)).filter((m) => m.length === 7))].sort().slice(-24);
    if (months.length) {
      const series = act.map((v) => ({
        name: v.name, color: colorOf(v),
        values: months.map((m) => Math.round((ents.filter((e) => e.vehicle === v.id && String(e.date).startsWith(m)).reduce((s, e) => s + num(e.cost), 0)
          + cts.filter((c) => c.vehicle === v.id && String(c.date).startsWith(m)).reduce((s, c) => s + num(c.amount), 0)) * 100) / 100),
      }));
      page.append(card('Kosten pro Monat', barChart(months, series), h('div.ad-legend', series.map((r) => h('span', { style: { '--c': r.color } }, h('i.dot'), r.name)))));
    }
    const parts = act.map((v) => ({ label: v.name, value: st.get(v.id).total, color: colorOf(v) }));
    page.append(card('Gesamtkosten je Fahrzeug', h('div.ad-donutrow', donut(parts, eur(parts.reduce((s, p) => s + p.value, 0), 0)),
      h('div.ad-legend.col', parts.map((p) => h('span', { style: { '--c': p.color } }, h('i.dot'), `${p.label}: ${eur(p.value)}`))))));
  }

  // Einträge
  const sortedE = [...ents].sort((x, y) => String(y.date).localeCompare(String(x.date)) || String(y.id).localeCompare(String(x.id)));
  const shownE = state.moreEntries ? sortedE : sortedE.slice(0, 15);
  page.append(card(`Tankungen / Ladevorgänge · ${sortedE.length}`,
    h('div.ad-list', shownE.map((e) => {
      const v = vehicles.find((x) => x.id === e.vehicle);
      return h('button.ad-item', { onclick: () => entryMenu(e) },
        h('span.ad-i-main', h('b', `${deDate(e.date)} · ${vName(e.vehicle)}`), e.notes ? h('small.muted', e.notes) : null),
        h('span.ad-i-side', h('b', eur(e.cost)), h('small.muted', `${fmt(e.amount, 2)} ${v ? unitOf(v) : ''}`)));
    })),
    sortedE.length > 15 ? h('button.btn.small.block', { onclick: () => { state.moreEntries = !state.moreEntries; nav.redraw(); } }, state.moreEntries ? 'Weniger zeigen' : `Alle ${sortedE.length} zeigen`) : null,
    !sortedE.length ? h('p.muted', 'Noch keine Einträge.') : null));

  // Zusatzkosten
  const sortedC = [...cts].sort((x, y) => String(y.date).localeCompare(String(x.date)));
  page.append(collapse(`Zusatzkosten · ${sortedC.length}`, false,
    h('button.btn.small', { onclick: () => costForm() }, icon('plus'), ' Zusatzkosten eintragen'),
    h('div.ad-list', (state.moreCosts ? sortedC : sortedC.slice(0, 15)).map((c) => h('button.ad-item', { onclick: () => costMenu(c) },
      h('span.ad-i-main', h('b', `${deDate(c.date)} · ${vName(c.vehicle)}`), c.description ? h('small.muted', c.description) : null), h('span.ad-i-side', h('b', eur(c.amount)))))),
    sortedC.length > 15 ? h('button.btn.small.block', { onclick: () => { state.moreCosts = !state.moreCosts; nav.redraw(); } }, state.moreCosts ? 'Weniger zeigen' : `Alle ${sortedC.length} zeigen`) : null));

  // Rechner
  page.append(collapse('Kostenrechner Elektro gegen Diesel', false, calcBlock(nav)));

  // Fahrzeuge
  page.append(collapse('Fahrzeuge', false,
    h('div.ad-list', vehicles.map((v) => h('button.ad-item', { onclick: () => vehMenu(v) },
      h('span.ad-i-main', h('b', h('i', { style: { display: 'inline-block', width: '10px', height: '10px', borderRadius: '50%', marginRight: '8px', background: vcol.get(v.id) || '#888' } }), v.name), h('small.muted', `${v.kind === 'strom' ? 'Strom (kWh)' : 'Kraftstoff (Liter)'} · ${fmt(v.consumption, 1)} /100 km${v.archived ? ' · archiviert' : ''}`)), icon('chevron', 'chev')))),
    h('button.btn.small', { onclick: () => vehForm() }, icon('plus'), ' Fahrzeug hinzufügen')));

  el.append(page);

  // ------------------------------------------------------------ Formulare
  function entryForm(e = null) {
    const names = act.map((v) => v.name);
    if (e && !names.includes(vName(e.vehicle))) names.push(vName(e.vehicle));
    const defV = e ? vName(e.vehicle) : (act.find((v) => v.id === pref('fuelVehicle')) || act.find((v) => v.kind === 'strom') || act[0] || {}).name;
    if (!names.length) { toast('Bitte zuerst ein Fahrzeug anlegen.'); return; }
    const kindOf = (name) => vehicles.find((v) => v.name === name)?.kind;
    const priceCent = e && kindOf(vName(e.vehicle)) === 'strom' && num(e.amount) > 0 ? fmt(num(e.cost) / num(e.amount) * 100, 1) : '';
    formSheet({
      title: e ? 'Eintrag bearbeiten' : 'Tanken / Laden',
      fields: [
        { key: 'vehicle', label: 'Fahrzeug', type: 'select', options: names, value: defV },
        { key: 'date', label: 'Datum', type: 'date', value: e ? e.date : today() },
        { key: 'amount', label: 'Menge (kWh)', type: 'number', value: e ? String(e.amount).replace('.', ',') : '', show: (v) => kindOf(v.vehicle) === 'strom' },
        { key: 'amountL', label: 'Menge (Liter)', type: 'number', value: e ? String(e.amount).replace('.', ',') : '', show: (v) => kindOf(v.vehicle) !== 'strom' },
        { key: 'price', label: 'Preis (Cent pro kWh)', type: 'number', value: priceCent || (e ? '' : String(pref('fuelPrice')).replace('.', ',')), show: (v) => kindOf(v.vehicle) === 'strom' },
        { key: 'lprice', label: 'Preis (€ pro Liter)', type: 'number', value: e && kindOf(vName(e.vehicle)) !== 'strom' && num(e.amount) > 0 ? fmt(num(e.cost) / num(e.amount), 3) : '', hint: 'Preis pro Liter oder Kosten gesamt eingeben', show: (v) => kindOf(v.vehicle) !== 'strom' },
        { key: 'cost', label: 'Kosten gesamt (€)', type: 'number', value: e && kindOf(vName(e.vehicle)) !== 'strom' ? String(e.cost).replace('.', ',') : '', show: (v) => kindOf(v.vehicle) !== 'strom' },
        { key: 'notes', label: 'Notiz', type: 'text', value: e?.notes || '' },
      ],
      onSubmit: async (v) => {
        const veh = vehicles.find((x) => x.name === v.vehicle);
        if (!veh) return 'Bitte ein Fahrzeug wählen.';
        const amount = parseNum(veh.kind === 'strom' ? v.amount : v.amountL);
        if (amount == null || amount <= 0) return 'Bitte eine Menge eingeben.';
        if (!validDate(v.date)) return 'Bitte ein Datum wählen.';
        let cost;
        if (veh.kind === 'strom') { const p = parseNum(v.price); if (p == null) return 'Bitte den Preis in Cent pro kWh eingeben.'; cost = Math.round(p * amount) / 100; }
        else {
          cost = parseNum(v.cost);
          const lp = parseNum(v.lprice);
          if (cost == null && lp != null) cost = Math.round(lp * amount * 100) / 100;
          if (cost == null) return 'Bitte Literpreis oder Kosten eingeben.';
        }
        const rec = { id: e?.id || newId(), vehicle: veh.id, date: v.date, amount, cost, notes: v.notes.trim() };
        await save('entries', e ? entries.map((x) => (x.id === e.id ? { ...x, ...rec } : x)) : [...entries, rec]);
        toast(`Eintrag gespeichert (${eur(cost)}).`);
      },
    });
  }
  function entryMenu(e) {
    actionSheet(`${deDate(e.date)} · ${vName(e.vehicle)}`, [
      { label: 'Bearbeiten', icon: 'edit', onclick: () => entryForm(e) },
      { label: 'Löschen', icon: 'trash', danger: true, onclick: async () => { if (await confirmDialog('Diesen Eintrag löschen?', { danger: true, ok: 'Löschen' })) { await save('entries', entries.filter((x) => x.id !== e.id)); toast('Eintrag gelöscht.'); } } },
    ]);
  }
  function costForm(c = null) {
    const names = act.map((v) => v.name);
    if (c && !names.includes(vName(c.vehicle))) names.push(vName(c.vehicle));
    if (!names.length) { toast('Bitte zuerst ein Fahrzeug anlegen.'); return; }
    formSheet({
      title: c ? 'Zusatzkosten bearbeiten' : 'Zusatzkosten (Werkstatt, Reifen …)',
      fields: [
        { key: 'vehicle', label: 'Fahrzeug', type: 'select', options: names, value: c ? vName(c.vehicle) : names[0] },
        { key: 'date', label: 'Datum', type: 'date', value: c ? c.date : today() },
        { key: 'amount', label: 'Betrag (€)', type: 'number', value: c ? String(c.amount).replace('.', ',') : '' },
        { key: 'desc', label: 'Beschreibung', type: 'text', value: c?.description || '' },
      ],
      onSubmit: async (v) => {
        const veh = vehicles.find((x) => x.name === v.vehicle); const amount = parseNum(v.amount);
        if (!veh || amount == null || amount <= 0) return 'Bitte Fahrzeug und Betrag angeben.';
        if (!validDate(v.date)) return 'Bitte ein Datum wählen.';
        const rec = { id: c?.id || newId(), vehicle: veh.id, date: v.date, amount, description: v.desc.trim() };
        await save('costs', c ? costs.map((x) => (x.id === c.id ? { ...x, ...rec } : x)) : [...costs, rec]);
        toast('Zusatzkosten gespeichert.');
      },
    });
  }
  function costMenu(c) {
    actionSheet(`${deDate(c.date)} · ${vName(c.vehicle)}`, [
      { label: 'Bearbeiten', icon: 'edit', onclick: () => costForm(c) },
      { label: 'Löschen', icon: 'trash', danger: true, onclick: async () => { if (await confirmDialog('Diese Zusatzkosten löschen?', { danger: true, ok: 'Löschen' })) { await save('costs', costs.filter((x) => x.id !== c.id)); } } },
    ]);
  }
  function vehForm(v = null) {
    formSheet({
      title: v ? 'Fahrzeug bearbeiten' : 'Fahrzeug hinzufügen',
      fields: [
        { key: 'name', label: 'Name', type: 'text', value: v?.name || '' },
        { key: 'kind', label: 'Art', type: 'select', options: [{ value: 'strom', label: 'Strom (kWh)' }, { value: 'diesel', label: 'Kraftstoff (Liter)' }], value: v?.kind || 'strom' },
        { key: 'cons', label: 'Verbrauch pro 100 km', type: 'number', value: v ? String(v.consumption).replace('.', ',') : '' },
        { key: 'color', label: 'Farbe', type: 'select', options: Object.keys(VNAMES), value: v ? colorName(v.color) : 'Automatisch' },
      ],
      onSubmit: async (f) => {
        const name = f.name.trim(); const cons = parseNum(f.cons);
        if (!name || cons == null || cons <= 0) return 'Bitte Name und Verbrauch angeben.';
        if (vehicles.some((x) => x.name.toLowerCase() === name.toLowerCase() && x.id !== v?.id)) return 'Diesen Namen gibt es schon.';
        if (v) {
          if (!(await confirmDialog(`Änderungen an „${v.name}“ speichern – sind Sie sicher?`, { title: 'Bitte bestätigen', ok: 'Ja' }))) return 'Abgebrochen.';
          if (!(await confirmDialog('Wirklich sicher?', { title: 'Zweite Bestätigung', ok: 'Ja, speichern' }))) return 'Abgebrochen.';
        }
        const color = VNAMES[f.color] || (v ? '' : (VPAL.find((c) => !vehicles.some((x) => String(x.color).toUpperCase() === c)) || ''));
        const rec = { id: v?.id || newId(), name, kind: f.kind, consumption: cons, archived: v ? !!v.archived : false, color };
        await save('vehicles', v ? vehicles.map((x) => (x.id === v.id ? { ...x, ...rec } : x)) : [...vehicles, rec]);
      },
    });
  }
  function vehMenu(v) {
    actionSheet(v.name, [
      { label: 'Bearbeiten', icon: 'edit', onclick: () => vehForm(v) },
      { label: v.archived ? 'Wieder aktivieren' : 'Archivieren', hint: v.archived ? '' : 'Blendet es aus, Daten bleiben', icon: 'folder', onclick: () => save('vehicles', vehicles.map((x) => (x.id === v.id ? { ...x, archived: !x.archived } : x))) },
      { label: 'Endgültig löschen', hint: 'Mit allen Einträgen und Zusatzkosten', icon: 'trash', danger: true, onclick: async () => {
        if (!(await confirmDialog(`„${v.name}“ mit allen Einträgen und Zusatzkosten endgültig löschen – sind Sie sicher?`, { danger: true, title: 'Bitte bestätigen', ok: 'Ja' }))) return;
        if (!(await confirmDialog('Wirklich sicher? Das lässt sich nicht rückgängig machen.', { danger: true, title: 'Zweite Bestätigung', ok: 'Ja, endgültig löschen' }))) return;
        await save('entries', entries.filter((x) => x.vehicle !== v.id)); await save('costs', costs.filter((x) => x.vehicle !== v.id)); await save('vehicles', vehicles.filter((x) => x.id !== v.id));
      } },
    ]);
  }
}

function calcBlock(nav) {
  const c = state.calc;
  const box = h('div.ad-calc');
  const inp = (key, label) => h('label.ad-field', h('span.ad-label', label), h('input.input', { value: c[key], inputmode: 'decimal', oninput: (e) => { c[key] = e.target.value; paint(); } }));
  const out = h('div.ad-calc-out');
  const paint = () => {
    const cents = parseNum(c.cents), evc = parseNum(c.ev), dp = parseNum(c.diesel), dc = parseNum(c.dcons);
    out.replaceChildren();
    if (cents == null || evc == null) return;
    const ev100 = (cents / 100) * evc;
    out.append(h('p', `Elektro: ${eur(ev100)} / 100 km · ${eur(ev100 * pref('workKm') / 100)} / Arbeitstag · ${eur(ev100 / 100, 3)} / km`));
    if (dp != null && dc != null) {
      const d100 = dp * dc, sv = d100 - ev100;
      out.append(h('p', `Diesel: ${eur(d100)} / 100 km · ${eur(d100 * pref('workKm') / 100)} / Arbeitstag · ${eur(d100 / 100, 3)} / km`),
        h('p', { class: sv >= 0 ? 'ok-text' : 'err-text' }, `${sv >= 0 ? 'Ersparnis Elektro' : 'Mehrkosten Elektro'}: ${eur(Math.abs(sv))} pro 100 km, ${eur(Math.abs(sv) * pref('workKm') / 100)} pro Arbeitstag`));
    }
  };
  box.append(inp('cents', 'Strompreis (Cent/kWh)'), inp('ev', 'EV-Verbrauch (kWh/100 km)'), inp('diesel', 'Diesel (€/l)'), inp('dcons', 'Diesel-Verbrauch (l/100 km)'), out);
  paint();
  return box;
}
