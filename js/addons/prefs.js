// Einstellungen für Fuel Tracker, Notizen, Tresor und den Startbildschirm. Gelten nur auf diesem Gerät.

import { kv } from '../db.js';

const DEFAULTS = {
  animations: true,
  fuelVehicle: 'tesla_model3',   // vorausgewähltes Fahrzeug
  fuelPrice: 28,                 // Cent pro kWh, vorbelegt (pro Eintrag änderbar)
  workKm: 130,                   // km pro Arbeitstag
  fuelCharts: true,
  notesColor: 'Indigo',
  vaultMinutes: 3,               // Tresor sperrt nach so vielen Minuten ohne Bedienung
  vaultFace: false,              // Tresor mit Face ID öffnen
};
let cur = { ...DEFAULTS };
let loaded = false;

export async function loadPrefs() {
  if (!loaded) { cur = { ...DEFAULTS, ...((await kv.get('addon:prefs')) || {}) }; loaded = true; }
  return cur;
}
export const pref = (k) => cur[k];

// Einstellungen, die mit dem PC (und anderen Handys) abgeglichen werden: Name hier → Name im Add-on (Schlüssel „_s.<name>“ im Abgleich).
// Nur am Gerät bleiben: animations, vaultFace (Face ID) und alles zur Leiste/Startseite.
export const SHARED = {
  fuel: { fuelCharts: 'show_charts', fuelPrice: 'fuel_price', workKm: 'work_km', fuelVehicle: 'fuel_vehicle' },
  notes: { notesColor: 'notes_color' },
  vault: { vaultMinutes: 'autolock_min' },
};
export async function setPrefs(patch) {
  cur = { ...cur, ...patch };
  await kv.set('addon:prefs', cur);
  const { openAddon } = await import('./store.js');
  for (const [id, map] of Object.entries(SHARED)) {
    for (const [k, name] of Object.entries(map)) {
      if (!(k in patch)) continue;
      const api = await openAddon(id);
      const json = JSON.stringify(patch[k]);
      if (api.raw('_s.' + name) !== json) await api.set('_s.' + name, json);
    }
  }
}
/** Nach einem Abgleich: Einstellungen aus den Daten des Add-ons übernehmen. */
export async function applyShared(id, data) {
  const map = SHARED[id];
  if (!map) return;
  const patch = {};
  for (const [k, name] of Object.entries(map)) {
    const raw = data['_s.' + name];
    if (raw == null) continue;
    try { const v = JSON.parse(raw); if (JSON.stringify(cur[k]) !== raw && typeof v === typeof DEFAULTS[k]) patch[k] = v; } catch { /* ignorieren */ }
  }
  if (Object.keys(patch).length) { cur = { ...cur, ...patch }; await kv.set('addon:prefs', cur); }
}
export const animated = () => cur.animations && !(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
