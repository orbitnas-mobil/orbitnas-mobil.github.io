// App-Sperre: Programm-PIN (gemeinsam mit dem PC über die Einstellungsdatei) und Face ID / Touch ID über die Passkey-Funktion von iOS.
// Face ID und die 24 Stunden gelten nur auf diesem Gerät.

import { kv } from './db.js';
import { verifyHash, makeHash, bytesToB64url, b64urlToBytes } from './crypto.js';
import { h, icon, toast, sheet } from './util.js';
import { securityQuestion, askSecurity } from './secq.js';
import { appPin, setSingle } from './store.js';

export const lock = { faceId: null, stay24h: true, unlockedUntil: 0 };
const DAY = 24 * 3600 * 1000;

/** Nach dem Entsperren 24 Stunden auf diesem Gerät keine Programm-PIN (gilt nicht für Ordner-PINs). */
export const within24h = () => lock.stay24h && Date.now() < (lock.unlockedUntil || 0);
/** Schloss-Knopf: sofort sperren, auch innerhalb der 24 Stunden. */
export async function lockImmediately() { lock.unlockedUntil = 0; await saveLock(); }
export async function loadLock() { Object.assign(lock, (await kv.get('lock')) || {}); }
export const saveLock = () => kv.set('lock', { ...lock });

/** Die Programm-PIN (am PC und auf dem Handy dieselbe). length 0 = Passwort. */
export function activePin() {
  const p = appPin();
  return p ? { hash: p.hash, isPin: Number(p.length) > 0, length: Number(p.length) || 4 } : null;
}
export const lockEnabled = () => !!activePin() || !!lock.faceId;

// ---------------------------------------------------------------- Face ID (WebAuthn, nur auf diesem Gerät geprüft)

export const faceIdAvailable = async () => {
  try { return !!(window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()); }
  catch { return false; }
};

export async function enrollFaceId() {
  const cred = await navigator.credentials.create({
    publicKey: {
      rp: { name: 'Orbit NAS' },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'Orbit NAS', displayName: 'Orbit NAS' },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
      timeout: 60000,
    },
  });
  lock.faceId = { id: bytesToB64url(new Uint8Array(cred.rawId)), created: new Date().toISOString() };
  await saveLock();
}

export async function checkFaceId() {
  if (!lock.faceId) return false;
  const a = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ type: 'public-key', id: b64urlToBytes(lock.faceId.id) }],
      userVerification: 'required',
      timeout: 60000,
    },
  });
  // Byte 32 der Authenticator-Daten: Bit 0x04 = Nutzer wurde biometrisch/per Code bestätigt
  const flags = new Uint8Array(a.response.authenticatorData)[32];
  return (flags & 0x04) === 0x04;
}

export async function disableFaceId() { lock.faceId = null; await saveLock(); }

// ---------------------------------------------------------------- PIN-Feld

/**
 * Baut ein PIN-Feld mit Ziffernblock (oder ein Passwortfeld). onDone(eingabe) muss true/false liefern.
 */
function pinPad({ length = 4, isPin = true, onDone, extra }) {
  const wrap = h('div.pinpad');
  const dots = h('div.pin-dots');
  const msg = h('div.pin-msg', '');
  let value = '';
  let busy = false;
  const render = () => {
    dots.replaceChildren(...Array.from({ length }, (_, i) => h('span' + (i < value.length ? '.on' : ''))));
  };
  const submit = async (v) => {
    busy = true;
    msg.textContent = 'Prüfe …';
    const ok = await onDone(v);
    busy = false;
    if (ok === 'again') { value = ''; msg.textContent = ''; render(); return; }
    if (!ok) {
      msg.textContent = isPin ? 'Falsche PIN' : 'Falsches Passwort';
      wrap.classList.add('shake');
      setTimeout(() => wrap.classList.remove('shake'), 400);
      value = '';
      if (pw) pw.value = '';
      render();
    } else msg.textContent = '';
  };
  let pw = null;
  if (isPin) {
    render();
    const keys = h('div.keys');
    const press = (d) => {
      if (busy) return;
      if (d === 'del') value = value.slice(0, -1);
      else if (value.length < length) value += d;
      render();
      if (value.length === length) submit(value);
    };
    for (const d of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) keys.append(h('button.key', { onclick: () => press(d) }, d));
    keys.append(extra || h('span'), h('button.key', { onclick: () => press('0') }, '0'),
      h('button.key.del', { onclick: () => press('del'), 'aria-label': 'Löschen' }, '⌫'));
    wrap.append(dots, msg, keys);
    wrap.onKey = (e) => { if (/^\d$/.test(e.key)) press(e.key); else if (e.key === 'Backspace') press('del'); };
  } else {
    pw = h('input.input', { type: 'password', placeholder: 'Passwort', autocomplete: 'current-password' });
    wrap.append(h('form', { onsubmit: (e) => { e.preventDefault(); submit(pw.value); } }, pw,
      h('button.btn.primary.block', { type: 'submit' }, 'Entsperren')), msg, extra || null);
    setTimeout(() => pw.focus(), 300);
  }
  return wrap;
}

// ---------------------------------------------------------------- Sperrbildschirm

let locked = false;
export const isLocked = () => locked;

export function showLockScreen({ force = false } = {}) {
  if (locked || !lockEnabled()) return Promise.resolve();
  if (!force && within24h()) return Promise.resolve();
  locked = true;
  return new Promise((resolve) => {
    const pin = activePin();
    const screen = h('div.lockscreen');
    const unlock = () => {
      locked = false;
      lock.unlockedUntil = Date.now() + DAY;
      saveLock().catch(() => {});
      document.removeEventListener('keydown', onKey);
      screen.classList.add('hide');
      setTimeout(() => screen.remove(), 250);
      resolve();
    };
    const tryFace = async () => {
      try { if (await checkFaceId()) unlock(); }
      catch (e) { if (e.name !== 'NotAllowedError') toast('Face ID: ' + e.message); }
    };
    const faceBtn = lock.faceId ? h('button.key.face', { onclick: tryFace, 'aria-label': 'Face ID' }, icon('face')) : null;
    screen.append(h('img.lock-logo', { src: 'icons/icon-192.png', alt: '' }), h('h1', 'Orbit NAS'));
    if (pin) {
      screen.append(h('p.muted', pin.isPin ? 'PIN eingeben' : 'Passwort eingeben'));
      const pad = pinPad({ length: pin.length, isPin: pin.isPin, onDone: async (v) => { const ok = await verifyHash(v, pin.hash); if (ok) unlock(); return ok; }, extra: faceBtn });
      screen.append(pad);
      var onKey = (e) => pad.onKey && pad.onKey(e);
    } else {
      screen.append(h('p.muted', 'Mit Face ID entsperren'), h('button.btn.primary', { onclick: tryFace }, icon('face'), ' Entsperren'));
      var onKey = () => {};
    }
    if (pin) screen.append(h('button.link.forgot', { onclick: async () => {
      if (!securityQuestion()) {
        toast('Ohne Sicherheitsfrage geht das nicht. Am PC unter Einstellungen → Sicherheit eine neue PIN festlegen.', 'err');
        return;
      }
      if (!(await askSecurity('PIN vergessen'))) return;
      const r = await choosePin('Neue Programm-PIN', 'Gilt auch am PC.');
      if (r) { await setSingle('appPin', { hash: r.hash, length: r.length }); toast('Neue PIN gespeichert'); }
      unlock();
    } }, 'PIN vergessen?'));
    document.addEventListener('keydown', onKey);
    document.body.append(screen);
    if (lock.faceId) setTimeout(tryFace, 400);
  });
}

/** Fragt eine Ordner-PIN ab. Liefert true, wenn richtig. */
export function askPin(title, hash, length = 4) {
  return new Promise((resolve) => {
    let ok = false;
    const body = h('div.dialog-body.center');
    const s = sheet(body, { title, onClose: () => resolve(ok) });
    const pad = pinPad({
      length, onDone: async (v) => { ok = await verifyHash(v, hash); if (ok) setTimeout(() => s.close(), 150); return ok; },
      extra: lock.faceId ? h('button.key.face', {
        onclick: async () => { try { if (await checkFaceId()) { ok = true; s.close(); } } catch { /* abgebrochen */ } }, 'aria-label': 'Face ID',
      }, icon('face')) : null,
    });
    body.append(pad);
    if (securityQuestion()) body.append(h('button.link.forgot', { onclick: async () => { if (await askSecurity('Ordner-PIN vergessen')) { ok = true; s.close(); } } }, 'PIN vergessen?'));
    const onKey = (e) => pad.onKey && pad.onKey(e);
    document.addEventListener('keydown', onKey);
    const origClose = s.close;
    s.close = () => { document.removeEventListener('keydown', onKey); origClose(); };
  });
}

/**
 * Neue PIN wählen (4 bis 6 Ziffern, zweimal eingeben). Liefert { hash, length } oder null.
 * Der Hash hat dasselbe Format wie am PC (PBKDF2-SHA256, 600 000 Runden).
 */
export function choosePin(title, hint = '') {
  return new Promise((resolve) => {
    let result = null;
    let length = 4;
    let first = null;
    const body = h('div.dialog-body.center');
    const info = h('p');
    const lens = h('div.seg');
    const padBox = h('div');
    const s = sheet(body, { title, onClose: () => { document.removeEventListener('keydown', onKey); resolve(result); } });
    let pad = null;
    const onKey = (e) => pad && pad.onKey && pad.onKey(e);
    document.addEventListener('keydown', onKey);
    const build = () => {
      first = null;
      info.textContent = `Neue PIN (${length} Ziffern) eingeben`;
      lens.replaceChildren(...[4, 5, 6].map((n) => h('button' + (n === length ? '.on' : ''), { onclick: () => { length = n; build(); } }, n + ' Ziffern')));
      pad = pinPad({
        length,
        onDone: async (v) => {
          if (!first) { first = v; info.textContent = 'PIN wiederholen'; return 'again'; }
          if (v !== first) { first = null; info.textContent = 'Die PINs waren verschieden. Neue PIN eingeben'; return false; }
          info.textContent = 'Wird gespeichert …';
          result = { hash: await makeHash(v), length };
          s.close();
          return true;
        },
      });
      padBox.replaceChildren(pad);
    };
    body.append(hint ? h('p.muted.small', hint) : null, lens, info, padBox);
    build();
  });
}

/** Programm-PIN festlegen oder ändern (gilt am PC und auf allen Geräten). */
export async function setOwnPin() {
  const cur = activePin();
  if (cur && !(await askPin('Alte PIN eingeben', cur.hash, cur.length))) return false;
  if (cur && !(await askSecurity('PIN ändern'))) return false;
  const r = await choosePin(activePin() ? 'Neue Programm-PIN' : 'Programm-PIN festlegen', 'Die PIN gilt auch am PC.');
  if (!r) return false;
  await setSingle('appPin', { hash: r.hash, length: r.length });
  lock.unlockedUntil = Date.now() + DAY;   // wer die PIN gerade festlegt, ist schon „entsperrt“
  await saveLock();
  return true;
}

export async function removePin() {
  await setSingle('appPin', null);
  lock.faceId = null;
  await saveLock();
}
