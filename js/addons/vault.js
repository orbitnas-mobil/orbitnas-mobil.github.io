// Tresor: Passwörter, mit dem Master-Passwort verschlüsselt (AES-256-CBC + HMAC-SHA256, Schlüssel per PBKDF2-SHA256).
// Format wie am PC (Add-on de.dennis.orbit-vault): Schlüssel "vault" = {v, salt, iter, iv, ct, mac}. Das Master-Passwort wird nie gespeichert.

import { h, icon, toast, actionSheet, confirmDialog, sheet } from '../util.js';
import { head, formSheet, newId } from './ui.js';
import { syncAddon } from './store.js';

const CATS = ['Allgemein', 'Finanzen', 'Streaming', 'Arbeit', 'Online', 'Bank', 'E-Mail', 'Sonstiges'];
const ITER = 200000;
const IDLE_MS = 3 * 60000;           // wie am PC: nach 3 Minuten ohne Bedienung sperren
const AWAY_MS = 60000;               // App im Hintergrund: nach 1 Minute sperren

const b64 = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(String(s)), (c) => c.charCodeAt(0));
const enc = (s) => new TextEncoder().encode(s);

// ---------------------------------------------------------------- Verschlüsselung (auch für Tests)

export async function deriveKeys(password, salt, iter) {
  const base = await crypto.subtle.importKey('raw', enc(password), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, 512));
  return {
    enc: await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-CBC', false, ['encrypt', 'decrypt']),
    mac: await crypto.subtle.importKey('raw', bits.slice(32), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']),
  };
}
const joinBytes = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };

/** Einträge entschlüsseln; null bei falschem Passwort bzw. beschädigten Daten. */
export async function decryptVault(keys, hdr) {
  try {
    const iv = unb64(hdr.iv), ct = unb64(hdr.ct);
    if (!(await crypto.subtle.verify('HMAC', keys.mac, unb64(hdr.mac), joinBytes(iv, ct)))) return null;
    const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, keys.enc, ct);
    const list = JSON.parse(new TextDecoder().decode(plain));
    return Array.isArray(list) ? list : [];
  } catch { return null; }
}
export async function encryptVault(keys, hdr, entries) {
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, keys.enc, enc(JSON.stringify(entries))));
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', keys.mac, joinBytes(iv, ct)));
  return { ...hdr, iv: b64(iv), ct: b64(ct), mac: b64(mac) };
}

// ---------------------------------------------------------------- Sitzung (nur im Arbeitsspeicher)

const S = { keys: null, salt: null, entries: [], last: 0, q: '', timer: null, away: 0 };
function lockNow() { S.keys = null; S.salt = null; S.entries = []; S.q = ''; clearInterval(S.timer); S.timer = null; }
const touch = () => { S.last = Date.now(); };
document.addEventListener('visibilitychange', () => {
  if (!S.keys) return;
  if (document.visibilityState === 'hidden') S.away = Date.now();
  else if (S.away && Date.now() - S.away > AWAY_MS) { lockNow(); window.dispatchEvent(new Event('orbit-vault-lock')); }
});

export const vaultUnlocked = () => !!S.keys;
export function lockVault() { lockNow(); }

export async function render(el, api, nav) {
  const hdr = api.get('vault', null);
  const page = h('div.ad-page');
  el.append(page);
  const lockBtn = S.keys ? [h('button.nav-btn', { 'aria-label': 'Sperren', onclick: () => { lockNow(); nav.redraw(); } }, icon('lock'))] : [];
  page.append(...head('Tresor', { back: { label: 'Orbit', onclick: () => { nav.hub(); } }, right: lockBtn }));

  if (api.status().readOnly) page.append(h('p.err-text', 'Diese Daten stammen aus einer neueren Version von Orbit. Bitte erst die App aktualisieren.'));

  if (!hdr || !hdr.salt) return createView();
  if (!S.keys) return lockedView();

  // Entsperrt: Stand aus dem Speicher neu entschlüsseln (z. B. nach einem Abgleich)
  if (hdr.salt !== S.salt) { lockNow(); return lockedView(); }
  const fresh = hdr.ct ? await decryptVault({ enc: S.keys.enc, mac: S.keys.mac }, hdr) : [];
  if (fresh == null) { lockNow(); return lockedView(); }
  S.entries = fresh;
  touch();
  if (!S.timer) S.timer = setInterval(() => { if (S.keys && Date.now() - S.last > IDLE_MS) { lockNow(); window.dispatchEvent(new Event('orbit-vault-lock')); } }, 15000);
  page.addEventListener('pointerdown', touch); page.addEventListener('keydown', touch);
  return listView();

  // ------------------------------------------------------------ Anlegen
  function createView() {
    const p1 = h('input.input', { type: 'password', placeholder: 'Master-Passwort', autocomplete: 'new-password' });
    const p2 = h('input.input', { type: 'password', placeholder: 'Master-Passwort wiederholen', autocomplete: 'new-password' });
    const msg = h('p.err-text', { hidden: true });
    page.append(h('form.ad-lock', {
      onsubmit: async (e) => {
        e.preventDefault();
        if (p1.value.length < 6) { msg.textContent = 'Das Master-Passwort braucht mindestens 6 Zeichen.'; msg.hidden = false; return; }
        if (p1.value !== p2.value) { msg.textContent = 'Die beiden Passwörter sind nicht gleich.'; msg.hidden = false; return; }
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const keys = await deriveKeys(p1.value, salt, ITER);
        const header = await encryptVault(keys, { v: 1, salt: b64(salt), iter: ITER }, []);
        await api.set('vault', header);
        S.keys = keys; S.salt = header.salt; S.entries = []; touch();
        nav.redraw();
      },
    }, icon('lock', 'big'), h('h2', 'Tresor einrichten'),
    h('p.muted', 'Wähle ein Master-Passwort. Es wird nirgends gespeichert. Wenn du es vergisst, sind die Daten verloren.'),
    p1, p2, msg, h('button.btn.primary.big.block', { type: 'submit' }, 'Tresor anlegen')));
  }

  // ------------------------------------------------------------ Gesperrt
  function lockedView() {
    const pw = h('input.input', { type: 'password', placeholder: 'Master-Passwort', autocomplete: 'current-password', enterkeyhint: 'go' });
    const msg = h('p.err-text', { hidden: true });
    page.append(h('form.ad-lock', {
      onsubmit: async (e) => {
        e.preventDefault();
        if (!pw.value) return;
        msg.hidden = true;
        const btn = e.target.querySelector('button[type=submit]'); btn.disabled = true;
        try {
          const keys = await deriveKeys(pw.value, unb64(hdr.salt), Number(hdr.iter) || ITER);
          const list = hdr.ct ? await decryptVault(keys, hdr) : [];
          if (list == null) { msg.textContent = 'Falsches Master-Passwort.'; msg.hidden = false; pw.select(); return; }
          S.keys = keys; S.salt = hdr.salt; S.entries = list; touch();
          nav.redraw();
        } finally { btn.disabled = false; }
      },
    }, icon('lock', 'big'), h('h2', 'Tresor gesperrt'), pw, msg, h('button.btn.primary.big.block', { type: 'submit' }, 'Entsperren')));
    setTimeout(() => pw.focus(), 300);
  }

  // ------------------------------------------------------------ Liste
  function listView() {
    const q = S.q.trim().toLowerCase();
    const list = S.entries.filter((e) => !q || `${e.title} ${e.username} ${e.url}`.toLowerCase().includes(q))
      .sort((a, b) => String(a.category).localeCompare(String(b.category)) || String(a.title).localeCompare(String(b.title)));
    page.append(h('div.ad-actions', h('button.btn.primary.big', { onclick: () => entryForm() }, icon('plus'), ' Neuer Eintrag'),
      h('input.input.ad-search', { type: 'search', placeholder: 'Suchen', value: S.q, oninput: (e) => { S.q = e.target.value; clearTimeout(page._t); page._t = setTimeout(() => nav.redraw(), 200); } }),
      h('button.btn', { onclick: changeMaster }, 'Master-Passwort ändern')));
    if (!list.length) page.append(h('div.empty.small', h('p', S.entries.length ? 'Nichts gefunden.' : 'Noch keine Einträge.')));
    const cats = [...new Set(list.map((e) => e.category || 'Allgemein'))];
    for (const c of cats) {
      page.append(h('h3.ad-cat', c), h('div.ad-list', list.filter((e) => (e.category || 'Allgemein') === c).map((e) => h('button.ad-item', { onclick: () => detail(e) },
        h('span.ad-i-main', h('b', e.title), e.username ? h('small.muted', e.username) : null), icon('chevron', 'chev')))));
    }
  }

  async function mutate(fn) {
    try { await syncAddon('vault'); } catch { /* offline: mit lokalem Stand weiter */ }
    const cur = api.get('vault', null);
    if (!cur || cur.salt !== S.salt) { lockNow(); toast('Der Tresor wurde auf einem anderen Gerät neu angelegt. Bitte erneut entsperren.', 'err'); nav.redraw(); return; }
    const list = (cur.ct ? await decryptVault(S.keys, cur) : []) || S.entries;
    const next = fn([...list]);
    S.entries = next;
    await api.set('vault', await encryptVault(S.keys, cur, next));
    syncAddon('vault').catch(() => {});
  }

  function detail(e) {
    let shown = false;
    const pwEl = h('span.ad-pw', '••••••••••');
    const body = h('div.ad-detail',
      e.username ? field('Benutzername', h('span', e.username), () => copy(e.username, 'Benutzername')) : null,
      e.password ? field('Passwort', pwEl, () => copy(e.password, 'Passwort'), h('button.icon-btn', { 'aria-label': 'Anzeigen', onclick: (ev) => { shown = !shown; pwEl.textContent = shown ? e.password : '••••••••••'; ev.currentTarget.replaceChildren(icon(shown ? 'eyeOff' : 'eye')); } }, icon('eye'))) : null,
      e.url ? field('Adresse', h('span.ellipsis', e.url), () => copy(e.url, 'Adresse'), /^https?:\/\//i.test(e.url) ? h('button.icon-btn', { 'aria-label': 'Öffnen', onclick: () => window.open(e.url, '_blank', 'noopener') }, icon('link')) : null) : null,
      e.notes ? h('div.ad-fieldrow', h('small.muted', 'Notizen'), h('p.ad-notes-txt', e.notes)) : null,
      h('div.btn-row', h('button.btn.danger', { onclick: async () => { s.close(); if (await confirmDialog(`„${e.title}“ löschen?`, { danger: true, ok: 'Löschen' })) { await mutate((l) => l.filter((x) => x.id !== e.id)); toast('Eintrag gelöscht.'); } } }, 'Löschen'),
        h('button.btn.primary', { onclick: () => { s.close(); entryForm(e); } }, 'Bearbeiten')));
    const s = sheet(body, { title: e.title, onClose: () => { shown = false; } });
  }
  function field(label, valueEl, onCopy, extra = null) {
    return h('div.ad-fieldrow', h('small.muted', label), h('div.ad-fv', valueEl, h('span.spacer'), extra, h('button.icon-btn', { 'aria-label': 'Kopieren', onclick: onCopy }, icon('copy'))));
  }
  async function copy(text, what) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${what} kopiert (wird in 30 s aus der Zwischenablage entfernt).`);
      setTimeout(() => { navigator.clipboard.readText?.().then((t) => { if (t === text) navigator.clipboard.writeText(''); }).catch(() => {}); }, 30000);
    } catch { toast('Kopieren geht hier nicht.', 'err'); }
  }

  function genPassword() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!$%&?+-=';
    const b = crypto.getRandomValues(new Uint8Array(18));
    return [...b].map((x) => chars[x % chars.length]).join('');
  }
  function entryForm(e = null) {
    const cats = [...new Set([...CATS, ...S.entries.map((x) => x.category).filter(Boolean)])];
    const gen = h('button.btn.small', { type: 'button' }, 'Passwort erzeugen');
    const s = formSheet({
      title: e ? 'Eintrag bearbeiten' : 'Neuer Eintrag',
      fields: [
        { key: 'title', label: 'Titel', type: 'text', value: e?.title || '' },
        { key: 'category', label: 'Kategorie', type: 'select', options: cats, value: e?.category || 'Allgemein' },
        { key: 'username', label: 'Benutzername', type: 'text', value: e?.username || '' },
        { key: 'password', label: 'Passwort', type: 'text', value: e?.password || '' },
        { key: 'url', label: 'Adresse', type: 'text', value: e?.url || '' },
        { key: 'notes', label: 'Notizen', type: 'textarea', value: e?.notes || '', rows: 3 },
      ],
      extra: gen,
      onSubmit: async (v) => {
        const title = v.title.trim();
        if (!title) return 'Bitte einen Titel eingeben.';
        const rec = { id: e?.id || newId(), title, username: v.username.trim(), password: v.password, url: v.url.trim(), notes: v.notes, category: v.category };
        await mutate((l) => (e ? l.map((x) => (x.id === e.id ? rec : x)) : [...l, rec]));
        toast('Gespeichert.');
      },
    });
    gen.addEventListener('click', () => { const inp = s.el.querySelectorAll('input.input')[2]; if (inp) inp.value = genPassword(); });
  }

  async function changeMaster() {
    formSheet({
      title: 'Master-Passwort ändern',
      fields: [
        { key: 'old', label: 'Altes Passwort', type: 'password' },
        { key: 'n1', label: 'Neues Passwort', type: 'password' },
        { key: 'n2', label: 'Neues Passwort wiederholen', type: 'password' },
      ],
      onSubmit: async (v) => {
        const cur = api.get('vault', null);
        const chk = await deriveKeys(v.old, unb64(cur.salt), Number(cur.iter) || ITER);
        if ((cur.ct ? await decryptVault(chk, cur) : []) == null) return 'Das alte Passwort stimmt nicht.';
        if (v.n1.length < 6) return 'Das neue Passwort braucht mindestens 6 Zeichen.';
        if (v.n1 !== v.n2) return 'Die beiden neuen Passwörter sind nicht gleich.';
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const keys = await deriveKeys(v.n1, salt, ITER);
        const header = await encryptVault(keys, { ...cur, salt: b64(salt), iter: ITER }, S.entries);
        S.keys = keys; S.salt = header.salt;
        await api.set('vault', header);
        syncAddon('vault').catch(() => {});
        toast('Master-Passwort geändert. Am PC das neue Passwort verwenden.');
      },
    });
  }
}
