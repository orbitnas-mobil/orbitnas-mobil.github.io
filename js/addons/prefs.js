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
export async function setPrefs(patch) { cur = { ...cur, ...patch }; await kv.set('addon:prefs', cur); }
export const animated = () => cur.animations && !(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
