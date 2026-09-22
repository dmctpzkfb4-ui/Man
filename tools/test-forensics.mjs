/**
 * Prüft die reinen Funktionen von forensics.js ohne Browser.
 * Bildpunkt-Verfahren (ELA, Rauschen, Copy-Move) brauchen createImageBitmap
 * und sind hier NICHT prüfbar - das ist im Bericht ausdrücklich vermerkt.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
new Function(readFileSync(join(here, '../www/js/forensics.js'), 'utf8'))();
const F = globalThis.Forensics;

let ok = 0, fail = 0;
const t = (name, bed, extra = '') => {
  if (bed) { ok++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FEHL  ${name}${extra ? '  -> ' + extra : ''}`); }
};

console.log('Modul geladen, Version', F.version);

/* ---------- 1. Formaterkennung ---------- */
console.log('\n[Formaterkennung]');
const I = F._intern;
t('JPEG', I.detectFormat(new Uint8Array([0xFF,0xD8,0xFF,0xE0])) === 'JPEG');
t('PNG',  I.detectFormat(new Uint8Array([0x89,0x50,0x4E,0x47])) === 'PNG');
t('WebP', I.detectFormat(new Uint8Array([...Buffer.from('RIFF'),0,0,0,0,...Buffer.from('WEBP')])) === 'WebP');
t('Müll -> unbekannt', I.detectFormat(new Uint8Array([1,2,3,4])) === 'unbekannt');
t('leer stürzt nicht ab', I.detectFormat(new Uint8Array(0)) === 'unbekannt');

/* ---------- 2. GPS-Umrechnung ---------- */
console.log('\n[GPS Grad/Minute/Sekunde -> Dezimal]');
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
t('52°31\'12" N = 52,52',      near(I.dmsToDecimal([52,31,12],'N'), 52.52),  I.dmsToDecimal([52,31,12],'N'));
t('Süd ergibt negativ',        near(I.dmsToDecimal([52,31,12],'S'), -52.52), I.dmsToDecimal([52,31,12],'S'));
t('West ergibt negativ',       near(I.dmsToDecimal([13,24,36],'W'), -13.41), I.dmsToDecimal([13,24,36],'W'));
t('null -> null (kein erfundener Nullpunkt)', I.dmsToDecimal(null,'N') === null, I.dmsToDecimal(null,'N'));
t('undefined -> null', I.dmsToDecimal(undefined,'N') === null);
t('leeres Feld -> null', I.dmsToDecimal([52,null,12],'N') === null, I.dmsToDecimal([52,null,12],'N'));
t('leeres Array -> null', I.dmsToDecimal([],'N') === null);
t('Text -> null', I.dmsToDecimal(['abc'],'N') === null);
t('nur Grad bleibt gültig', near(I.dmsToDecimal([52],'N'), 52));

/* ---------- 3. EXIF-Zeitstempel ---------- */
console.log('\n[EXIF-Zeitstempel]');
const d = I.exifDate('2026:03:14 15:09:26');
t('wird geparst', d instanceof Date && !isNaN(d));
t('Monat korrekt (0-basiert)', d && d.getMonth() === 2, d && d.getMonth());
t('Tag korrekt', d && d.getDate() === 14);
t('Unsinn -> null', I.exifDate('kein datum') === null);

/* ---------- 4. Tag-Formatierung ---------- */
console.log('\n[Anzeigeformatierung]');
t('Belichtung als Bruch', I.formatTag('exposureTime', 0.004) === '1/250 s', I.formatTag('exposureTime',0.004));
t('lange Belichtung',     I.formatTag('exposureTime', 2) === '2 s', I.formatTag('exposureTime',2));
t('Blende mit f/',        I.formatTag('fNumber', 2.8) === 'f/2,8', I.formatTag('fNumber',2.8));
t('Brennweite in mm',     I.formatTag('focalLength', 50) === '50 mm', I.formatTag('focalLength',50));
t('Ausrichtung lesbar',   I.formatTag('orientation', 6) === '90° im Uhrzeigersinn');

/* ---------- 5. Hash gegen bekannte Werte ---------- */
console.log('\n[Prüfsummen]');
const leer = new Blob([new Uint8Array(0)]);
const h1 = await F.hash(leer);
t('SHA-256 der leeren Datei',
  h1.sha256 === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', h1.sha256);
t('SHA-1 der leeren Datei',
  h1.sha1 === 'da39a3ee5e6b4b0d3255bfef95601890afd80709', h1.sha1);
const abc = await F.hash(new Blob([Buffer.from('abc')]));
t('SHA-256 von "abc"',
  abc.sha256 === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', abc.sha256);
t('Bytezahl stimmt', abc.bytes === 3);

/* eigene JS-Implementierung muss dasselbe liefern wie WebCrypto */
const js256 = await I.sha256Js(new Uint8Array(Buffer.from('abc')));
t('JS-Rückfall stimmt mit WebCrypto überein',
  String(js256).toLowerCase() === abc.sha256, String(js256));

/* ---------- 6. Echte Datei ---------- */
console.log('\n[Echte JPEG-Datei]');
const buf = readFileSync('/tmp/claude-0/-home-user/b5051471-7984-5759-b116-41c1808ca86f/scratchpad/bus.jpg');
const meta = await F.readMetadata(new Blob([buf], { type: 'image/jpeg' }));
t('als JPEG erkannt', meta.format === 'JPEG', meta.format);
t('Maße gelesen', meta.width === 810 && meta.height === 1080, `${meta.width}x${meta.height}`);
t('Befunde erzeugt', meta.findings.length > 0);
t('keine Ausnahme nach außen', Array.isArray(meta.findings));
console.log('    Befunde:');
for (const f of meta.findings) console.log(`      [${f.level}] ${f.text.slice(0,95)}…`);

/* ---------- 7. Robustheit gegen kaputte Eingaben ---------- */
console.log('\n[Robustheit]');
for (const [name, blob] of [
  ['leere Datei', new Blob([])],
  ['zufällige Bytes', new Blob([Buffer.from([0xFF,0xD8,0xFF,0xE1,0x00,0x10,1,2,3,4,5])])],
  ['abgeschnittenes JPEG', new Blob([buf.subarray(0, 40)])],
]) {
  try {
    const m = await F.readMetadata(blob);
    t(`${name} -> gültige Struktur`, m && Array.isArray(m.findings));
  } catch (e) { t(`${name} -> keine Ausnahme`, false, e.message); }
}

/* ---------- 8. Histogramm ---------- */
console.log('\n[Histogramm]');
const px = new Uint8ClampedArray(4 * 4);   // 4 Pixel
px.set([0,0,0,255, 255,255,255,255, 128,128,128,255, 255,255,255,255]);
const hist = F.histogram({ data: px, width: 2, height: 2 });
t('Schwarz gezählt', hist.luma[0] === 1, hist.luma[0]);
t('Weiß gezählt', hist.luma[255] === 2, hist.luma[255]);
t('Tiefenbeschnitt erkannt', hist.clippedLow === 1);
t('Höhenbeschnitt erkannt', hist.clippedHigh === 2);
t('Gesamtzahl', hist.total === 4);

console.log(`\n${'='.repeat(46)}\n${ok} bestanden, ${fail} fehlgeschlagen`);
process.exit(fail ? 1 : 0);
