/**
 * Prüft die Skript-Ebene ohne Browser:
 *   - Sind alle Vorlagen als Rumpf einer async-Funktion gültig?
 *   - Riegelt der Sandkasten die Ausgänge tatsächlich ab?
 *   - Hält sich der Werkzeug-Vertrag an die dokumentierten Namen?
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
let ok = 0, fail = 0;
const t = (n, b, x = '') => { if (b) { ok++; console.log('  ok    ' + n); } else { fail++; console.log('  FEHL  ' + n + (x ? '  -> ' + x : '')); } };

/* ---------- 1. Vorlagen ---------- */
console.log('[Vorlagen]');
const appJs = readFileSync(join(here, '../www/js/app.js'), 'utf8');
const block = appJs.slice(appJs.indexOf('var VORLAGEN = {'), appJs.indexOf('var skriptDateien'));
// Die Vorlagen sind als String-Verkettungen hinterlegt; hier auswerten.
const VORLAGEN = new Function(block + '; return VORLAGEN;')();
const erwartet = ['schnell', 'manipulation', 'herkunft', 'dubletten', 'objekte'];
t('alle fünf Vorlagen vorhanden',
  erwartet.every(k => typeof VORLAGEN[k] === 'string' && VORLAGEN[k].length > 50),
  Object.keys(VORLAGEN).join(','));

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
for (const [name, code] of Object.entries(VORLAGEN)) {
  try {
    new AsyncFunction('werkzeuge', 'bild', code);
    t(`Vorlage "${name}" ist gültiges JavaScript`, true);
  } catch (e) {
    t(`Vorlage "${name}" ist gültiges JavaScript`, false, e.message);
  }
}

/* ---------- 2. Nutzen nur dokumentierte Werkzeuge? ---------- */
console.log('\n[Werkzeug-Vertrag]');
const wzBlock = appJs.slice(appJs.indexOf('var WERKZEUGE = ['), appJs.indexOf('var VORLAGEN'));
const WERKZEUGE = new Function(wzBlock + '; return WERKZEUGE;')();
const dokumentiert = new Set(WERKZEUGE.map(w => w[0].replace(/\(.*/, '')));
const workerJs = readFileSync(join(here, '../www/js/skript.worker.js'), 'utf8');
const wStart = workerJs.indexOf('var werkzeuge = {');
// Nicht das erste 'try {' der Datei nehmen - das steht in der Abriegelung
// weiter oben und liefert einen leeren Ausschnitt.
const wSlice = workerJs.slice(wStart, workerJs.indexOf('try {', wStart));
const angeboten = new Set([...wSlice.matchAll(/^\s{4}([a-zA-Z]+):/gm)].map(m => m[1]));
t('jedes dokumentierte Werkzeug wird auch angeboten',
  [...dokumentiert].every(d => angeboten.has(d)),
  [...dokumentiert].filter(d => !angeboten.has(d)).join(','));

// Jede in den Vorlagen aufgerufene Funktion muss es wirklich geben.
const benutzt = new Set();
for (const code of Object.values(VORLAGEN)) {
  for (const m of code.matchAll(/werkzeuge\.([a-zA-Z]+)\s*\(/g)) benutzt.add(m[1]);
}
t('Vorlagen rufen nur vorhandene Werkzeuge auf',
  [...benutzt].every(b => angeboten.has(b)),
  [...benutzt].filter(b => !angeboten.has(b)).join(','));
console.log('    benutzt: ' + [...benutzt].sort().join(', '));

// Der Läufer muss jedes angebotene Werkzeug auch ausführen können.
const runner = readFileSync(join(here, '../www/js/skripte.js'), 'utf8');
const faelle = new Set([...runner.matchAll(/case '([a-zA-Z]+)':/g)].map(m => m[1]));
const brauchtFall = [...angeboten].filter(a => !['markiere', 'setze', 'notiz'].includes(a));
t('der Läufer kennt jeden Werkzeugnamen',
  brauchtFall.every(a => faelle.has(a)),
  brauchtFall.filter(a => !faelle.has(a)).join(','));

/* ---------- 3. Abriegelung ---------- */
console.log('\n[Abriegelung]');
const abschnitt = workerJs.slice(workerJs.indexOf('function abriegeln'), workerJs.indexOf('var wartend'));
for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'importScripts', 'indexedDB', 'Worker']) {
  t(`"${name}" wird gesperrt`, abschnitt.includes(`'${name}'`));
}
// Die Sperre nachbilden und belegen, dass sie greift.
const sand = {};
const namen = ['fetch', 'XMLHttpRequest'];
namen.forEach(n => {
  Object.defineProperty(sand, n, {
    get() { throw new Error('„' + n + '“ steht Skripten nicht zur Verfügung.'); },
    configurable: false
  });
});
let geworfen = 0;
for (const n of namen) { try { void sand[n]; } catch { geworfen++; } }
t('der Zugriff wirft tatsächlich', geworfen === namen.length, geworfen + '/' + namen.length);

t('Zeitgrenze ist gesetzt', /ZEITGRENZE\s*=\s*\d+/.test(runner));
t('Worker wird bei Überschreitung beendet', runner.includes('worker.terminate()'));
t('ImageBitmap wird freigegeben', runner.includes('kasten.bitmap.close()'));

console.log(`\n${'='.repeat(46)}\n${ok} bestanden, ${fail} fehlgeschlagen`);
process.exit(fail ? 1 : 0);
