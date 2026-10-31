// Globale Suche über alle Add-ons (ohne Tresor): durchsucht die Listen-Einträge und öffnet das passende Add-on.

import { h, icon, clear } from '../util.js';
import { ADDONS, openAddon } from './store.js';

const TITLE_KEYS = ['title', 'name', 'titel', 'ort', 'destination', 'place', 'station', 'note', 'text', 'date', 'datum'];
const strip = (s) => String(s).replace(/<[^>]*>/g, ' ');
const titleOf = (x) => { for (const k of TITLE_KEYS) if (x[k] != null && String(x[k]).trim()) return strip(x[k]).slice(0, 80); return 'Eintrag'; };

/** Alle Treffer für q (Groß-/Kleinschreibung egal), höchstens 50. */
export async function searchAll(q) {
  const needle = q.trim().toLowerCase();
  if (needle.length < 2) return [];
  const out = [];
  for (const m of ADDONS) {
    if (m.id === 'vault') continue;
    const data = (await openAddon(m.id)).internal.data;
    for (const v of Object.values(data)) {
      let a; try { a = JSON.parse(v); } catch { continue; }
      if (!Array.isArray(a)) continue;
      for (const x of a) {
        if (!x || typeof x !== 'object' || x.deleted) continue;
        const hay = Object.values(x).filter((y) => typeof y === 'string' || typeof y === 'number').map((y) => strip(y).toLowerCase()).join(' ');
        if (hay.includes(needle)) { out.push({ addon: m, title: titleOf(x) }); if (out.length >= 50) return out; }
      }
    }
  }
  return out;
}

export function searchBox() {
  const list = h('div.group-body.ad-search-res');
  list.hidden = true;
  let n = 0;
  const input = h('input.input.ad-search', { type: 'search', placeholder: 'In allen Add-ons suchen …', autocapitalize: 'off', autocorrect: 'off', spellcheck: false,
    oninput: async () => {
      const my = ++n, res = await searchAll(input.value);
      if (my !== n) return;
      clear(list);
      list.hidden = input.value.trim().length < 2;
      if (!res.length) { list.append(h('div.row', h('span.row-main', h('span.muted', 'Keine Treffer')))); return; }
      list.append(...res.map((r) => h('a.row', { href: '#/a/' + r.addon.id },
        h('span.row-main', h('span.row-title', r.title), h('small.row-sub', r.addon.title)), icon('chevron', 'chev'))));
    } });
  return h('div.ad-search-box', input, list);
}
