// Gemeinsame Bausteine der Add-on-Seiten: Zahlen und Datum (deutsch), Formular-Blatt, Kopfzeile, einfache Diagramme.

import { h, icon, sheet, clear } from '../util.js';

export const PALETTE = ['#00D4FF', '#A855F7', '#FF3DCB', '#3DFFA2', '#FFD24A'];

const pad = (n) => String(n).padStart(2, '0');
export const fmt = (v, d = 2) => Number(v || 0).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
export const eur = (v, d = 2) => fmt(v, d) + ' €';
export const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
/** "35", "9,8", "1.234,5", "9.8" → Zahl, sonst null. */
export function parseNum(s) {
  let t = String(s ?? '').trim().replace(/\s|€/g, '');
  if (!t) return null;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
export const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
export const shortDate = (s) => String(s || '').slice(0, 10);
export const deDate = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? `${m[3]}.${m[2]}.${m[1]}` : String(s || ''); };
export const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
export function newId() { const b = crypto.getRandomValues(new Uint8Array(6)); return [...b].map((x) => x.toString(16).padStart(2, '0')).join(''); }

/** Kopfzeile wie die der anderen Seiten (Zurück, Titel, Knöpfe rechts). */
export function head(title, { back = null, right = [], sub = null } = {}) {
  return [
    h('header.navbar',
      h('div.nav-left', back ? h('button.nav-back', { onclick: back.onclick }, icon('back'), h('span', back.label)) : null),
      h('span.nav-title', title),
      h('div.nav-right', right)),
    h('h1.large-title', title),
    sub ? h('p.muted.ad-sub', sub) : null,
  ];
}

/**
 * Formular als Blatt. fields: [{ key, label, type: 'text'|'number'|'date'|'select'|'textarea'|'check'|'password', value, options, placeholder, hint, show(values) }]
 * onSubmit(values) darf einen Fehlertext zurückgeben (bleibt offen) oder nichts (schließt).
 */
export function formSheet({ title, fields, ok = 'Speichern', onSubmit, extra = null, danger = null }) {
  const inputs = {};
  const body = h('form.dialog-body.ad-form', { autocomplete: 'off' });
  const msg = h('p.formmsg.err-text', { hidden: true });
  const values = () => Object.fromEntries(fields.map((f) => [f.key, f.type === 'check' ? inputs[f.key].checked : inputs[f.key].value]));
  const rows = [];
  for (const f of fields) {
    let el;
    if (f.type === 'select') {
      el = h('select.input', (f.options || []).map((o) => h('option', { value: o.value ?? o, selected: String(o.value ?? o) === String(f.value) }, o.label ?? o)));
    } else if (f.type === 'textarea') {
      el = h('textarea.input', { rows: f.rows || 5, placeholder: f.placeholder || '' }); el.value = f.value ?? '';
    } else if (f.type === 'check') {
      el = h('input.ios-switch', { type: 'checkbox', checked: !!f.value });
    } else {
      el = h('input.input', {
        type: f.type === 'date' ? 'date' : f.type === 'password' ? 'password' : 'text', value: f.value ?? '', placeholder: f.placeholder || '',
        inputmode: f.type === 'number' ? 'decimal' : null, autocapitalize: f.type === 'text' ? 'sentences' : 'off', autocorrect: 'off', spellcheck: false, enterkeyhint: 'done',
        autocomplete: f.type === 'password' ? 'off' : null,
      });
    }
    inputs[f.key] = el;
    const row = f.type === 'check'
      ? h('label.ad-field.check', h('span', f.label), el)
      : h('label.ad-field', h('span.ad-label', f.label), el, f.hint ? h('small.muted', f.hint) : null);
    rows.push({ f, row });
    body.append(row);
    if (f.onchange) el.addEventListener('change', () => { f.onchange(values(), inputs, rows); refresh(); });
  }
  const refresh = () => { for (const { f, row } of rows) if (f.show) row.hidden = !f.show(values()); };
  refresh();
  if (extra) body.append(extra);
  body.append(msg);
  const s = sheet(body, { title });
  body.append(h('div.btn-row',
    danger ? h('button.btn.danger', { type: 'button', onclick: () => { s.close(); danger.onclick(); } }, danger.label) : null,
    h('button.btn', { type: 'button', onclick: () => s.close() }, 'Abbrechen'),
    h('button.btn.primary', { type: 'submit' }, ok)));
  body.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = await onSubmit(values());
    if (err) { msg.textContent = err; msg.hidden = false; } else s.close();
  });
  return s;
}

/** Kleine Kennzahl-Karte. */
export function stat(label, value, sub = '', color = null) {
  return h('div.ad-stat', color ? { style: { '--c': color } } : null, h('small', label), h('b', value), sub ? h('small.muted', sub) : null);
}

/** Karte mit Titel (wie eine iOS-Gruppe, aber freier Inhalt). */
export function card(title, ...children) {
  return h('section.ad-card', title ? h('h3', title) : null, ...children);
}

const openState = new Map();
/** Aufklappbarer Bereich (merkt sich Auf/Zu über das Neuzeichnen hinweg, Schlüssel = Titel vor dem „·“). */
export function collapse(title, open, ...children) {
  const key = String(title).split(' · ')[0];
  const d = h('details.ad-card.ad-collapse', { open: openState.has(key) ? openState.get(key) : !!open }, h('summary', title, icon('chevronDown', 'chev')), h('div.ad-body', ...children));
  d.addEventListener('toggle', () => openState.set(key, d.open));
  return d;
}

const NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const k of kids) if (k) el.append(k);
  return el;
}
const txt = (x, y, s, attrs = {}) => { const t = svg('text', { x, y, ...attrs }); t.textContent = s; return t; };

/** Balken je Monat, gestapelt nach Reihe. series: [{ name, values, color }]. */
export function barChart(labels, series, { unit = '€', height = 190 } = {}) {
  const colW = 38, padL = 38, padB = 22, padT = 8;
  const W = Math.max(300, padL + labels.length * colW + 8), H = height;
  const totals = labels.map((_, i) => series.reduce((s, r) => s + num(r.values[i]), 0));
  const max = Math.max(1, ...totals);
  const step = niceStep(max / 4);
  const top = Math.ceil(max / step) * step;
  const y = (v) => padT + (H - padT - padB) * (1 - v / top);
  const g = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'ad-chart', role: 'img' });
  for (let v = 0; v <= top + 1e-9; v += step) {
    g.append(svg('line', { x1: padL, x2: W - 4, y1: y(v), y2: y(v), class: 'grid' }));
    g.append(txt(padL - 5, y(v) + 4, fmt(v, 0), { class: 'ax', 'text-anchor': 'end' }));
  }
  labels.forEach((l, i) => {
    let acc = 0;
    const x = padL + i * colW + 6, w = colW - 12;
    series.forEach((r) => {
      const v = num(r.values[i]);
      if (v <= 0) return;
      g.append(svg('rect', { x, y: y(acc + v), width: w, height: Math.max(1, y(acc) - y(acc + v)), rx: 3, fill: r.color }));
      acc += v;
    });
    g.append(txt(x + w / 2, H - 6, l.slice(5) + '/' + l.slice(2, 4), { class: 'ax', 'text-anchor': 'middle' }));
  });
  const wrap = h('div.ad-chartwrap', g);
  requestAnimationFrame(() => { wrap.scrollLeft = wrap.scrollWidth; });
  return wrap;
}
function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

/** Ring-Diagramm. items: [{ label, value, color }]. */
export function donut(items, centerText = '') {
  const total = items.reduce((s, i) => s + num(i.value), 0);
  const R = 52, r = 34, c = 60;
  const g = svg('svg', { viewBox: '0 0 120 120', width: 120, height: 120, class: 'ad-donut', role: 'img' });
  if (total <= 0) g.append(svg('circle', { cx: c, cy: c, r: (R + r) / 2, fill: 'none', stroke: 'var(--border)', 'stroke-width': R - r }));
  let a0 = -Math.PI / 2;
  for (const it of items) {
    const v = num(it.value);
    if (v <= 0) continue;
    const a1 = a0 + (v / total) * Math.PI * 2 - (items.filter((x) => num(x.value) > 0).length > 1 ? 0.02 : 0);
    const big = a1 - a0 > Math.PI ? 1 : 0;
    const p = (rad, a) => `${c + rad * Math.cos(a)} ${c + rad * Math.sin(a)}`;
    if (v === total) g.append(svg('circle', { cx: c, cy: c, r: (R + r) / 2, fill: 'none', stroke: it.color, 'stroke-width': R - r }));
    else g.append(svg('path', { d: `M ${p(R, a0)} A ${R} ${R} 0 ${big} 1 ${p(R, a1)} L ${p(r, a1)} A ${r} ${r} 0 ${big} 0 ${p(r, a0)} Z`, fill: it.color }));
    a0 += (v / total) * Math.PI * 2;
  }
  if (centerText) g.append(txt(c, c + 4, centerText, { class: 'ctr', 'text-anchor': 'middle' }));
  return g;
}

/** Geteilter Balken (zwei oder mehr Teile). parts: [{ value, color }]. */
export function splitBar(parts) {
  const total = parts.reduce((s, p) => s + Math.max(0, num(p.value)), 0) || 1;
  return h('div.ad-split', parts.map((p) => h('i', { style: { width: (Math.max(0, num(p.value)) / total * 100) + '%', background: p.color } })));
}

export const replace = (el, ...kids) => { clear(el).append(...kids); return el; };
