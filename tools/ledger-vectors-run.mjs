import fs from 'fs';
import { diff, fold, materialize, countDiff } from '../js/addons/ledger-core.js';
const V = JSON.parse(fs.readFileSync('' + new URL('./ledger-vectors.json', import.meta.url).pathname + '', 'utf8'));
let bad = 0;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const rep = (n, ok, got) => { console.log((ok ? 'OK   ' : 'FAIL ') + n); if (!ok) { bad++; console.log(JSON.stringify(got)); } };
for (const v of V.diff) { const r = diff(v.base, v.cur, v.ctx); rep('diff: ' + v.name, eq(r, v.expect), r); }
for (const v of V.merge) { const r = materialize(fold(v.entries, v.until ?? Infinity), v.local); rep('merge: ' + v.name, eq(r, v.expect), r); }
for (const v of V.count) { const r = countDiff(v.cur, v.target); rep('count: ' + v.name, eq(r, v.expect), r); }
process.exit(bad ? 1 : 0);
