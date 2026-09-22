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

/* ---------- 9. Quantisierungstabellen ---------- */
console.log('\n[JPEG-Quantisierungstabellen]');
// Bei Qualitaet 50 ist der Skalierungsfaktor genau 100 - die Tabelle muss
// also unveraendert der Basistabelle entsprechen.
const s50 = I.ijgScale(I.IJG_LUMA, 50);
t('Qualität 50 = Basistabelle', s50.every((v, i) => v === I.IJG_LUMA[i]));
// Bei Qualitaet 100 wird der Faktor 0, alle Werte fallen auf das Minimum 1.
t('Qualität 100 = alle Werte 1', I.ijgScale(I.IJG_LUMA, 100).every(v => v === 1));
t('Qualität 1 klemmt bei 255', I.ijgScale(I.IJG_LUMA, 1).every(v => v >= 1 && v <= 255));
t('höhere Qualität = kleinere Werte',
  I.ijgScale(I.IJG_LUMA, 90).reduce((a,b)=>a+b,0) < I.ijgScale(I.IJG_LUMA, 30).reduce((a,b)=>a+b,0));

// Zickzack: Position 0,1,8,16 der natuerlichen Reihenfolge
const zz = I.deZigzag(Array.from({length:64},(_,i)=>i));
t('Zickzack Position 0', zz[0] === 0);
t('Zickzack Position 1', zz[1] === 1);
t('Zickzack Position 8', zz[8] === 2, zz[8]);
t('Zickzack ist Permutation', new Set(zz).size === 64);

const m = I.matchIjgQuality(I.ijgScale(I.IJG_LUMA, 77), I.IJG_LUMA);
t('erkennt konstruierte Qualität 77 exakt', m.quality === 77 && m.deviation === 0,
  `q=${m.quality} abw=${m.deviation}`);

// Echte Datei: bus.jpg traegt exakte Standardtabellen
const sc = I._ ? null : I.scanJpeg(new Uint8Array(buf));
const qa = F.analyseQuantTables(sc.quantTables);
t('zwei Tabellen gelesen', qa.tables.length === 2, qa.tables.length);
t('als Standardbibliothek erkannt', qa.standard === true);
t('Qualität bestimmt', qa.quality === 50, qa.quality);
t('Befund erzeugt', qa.findings.length > 0);
t('leere Eingabe stürzt nicht ab', F.analyseQuantTables(null).tables.length === 0);
t('Müll stürzt nicht ab', F.analyseQuantTables([{id:0,values:[1,2]}]).tables.length === 0);

/* ---------- 10. Perzeptuelle Prüfsummen ---------- */
console.log('\n[Perzeptuelle Prüfsummen]');
// Gleichfoermiges Raster: DCT muss alle Energie im Gleichanteil buendeln.
const konst = new Float64Array(64).fill(128);
const dctKonst = I.dct2d(konst, 8);
t('DCT einer konstanten Fläche: nur Gleichanteil', Math.abs(dctKonst[0]) > 100 &&
  dctKonst.slice(1).every(v => Math.abs(v) < 1e-9), dctKonst[0].toFixed(1));

t('Bitfolge zu Hex', I.bitsToHex([1,0,1,0, 1,1,1,1]) === 'af', I.bitsToHex([1,0,1,0,1,1,1,1]));

// Verlauf: linke Haelfte dunkel, rechte hell -> dHash muss Struktur zeigen
const verlauf = new Float64Array(64);
for (let y=0;y<8;y++) for (let x=0;x<8;x++) verlauf[y*8+x] = x*30;
const a1 = I.averageHashFrom(verlauf, 8);
t('aHash eines Verlaufs ist nicht konstant', /[^0]/.test(a1) && /[^f]/.test(a1), a1);
t('aHash einer gleichförmigen Fläche = 0', I.averageHashFrom(konst, 8) === '0000000000000000',
  I.averageHashFrom(konst, 8));

t('Hamming: identisch = 0', F.hammingDistance('abcd','abcd') === 0);
t('Hamming: ein Bit', F.hammingDistance('0','1') === 1);
t('Hamming: vier Bit', F.hammingDistance('0','f') === 4);
t('Hamming: verschiedene Länge = -1', F.hammingDistance('ab','abc') === -1);
t('Hamming: kein String = -1', F.hammingDistance(null,'ab') === -1);

/* ---------- 11. Blockraster gegen erzeugte Wahrheit ---------- */
console.log('\n[Blockraster]');
// Eine reine Stufe bei x=19: der Ausschlag muss exakt dort liegen (19 mod 8 = 3),
// nicht daneben. Genau das ging mit einem Kernel zweiter Ableitung schief.
{
  const w = 64, h = 8, b = 19;
  const g = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = x < b ? 40 : 200;
  const r = I.gridOffset(g, w, h);
  t('reine Stufe: Ausschlag exakt an der Grenze', r.offsetX === b % 8, `${r.offsetX} statt ${b % 8}`);
}
{
  // Gleichförmige Fläche hat kein Raster -> Verlässlichkeit muss niedrig sein
  const g = new Float32Array(64 * 64).fill(128);
  const r = I.gridOffset(g, 64, 64);
  t('glatte Fläche: keine verlässliche Aussage', r.confidence < 1, r.confidence);
}

// Echte JPEG-Dateien mit bekanntem Beschnitt (tools/make-fixtures.py).
// Geprüft wird die Eigenschaft, auf die es ankommt:
// DAS WERKZEUG DARF NIE EINE FALSCHE ANTWORT MIT HOHER VERLÄSSLICHKEIT GEBEN.
// Eine verweigerte Aussage ist in Ordnung; eine erfundene nicht.
{
  const man = JSON.parse(readFileSync(join(here, 'fixtures/manifest.json'), 'utf8'));
  const SCHWELLE = I.GITTER_SCHWELLE;
  console.log(`    Schwelle für eine belastbare Aussage: ${SCHWELLE}`);
  let belastbar = 0;
  for (const m of man) {
    const raw = readFileSync(join(here, 'fixtures', m.name + '.gray'));
    const g = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) g[i] = raw[i];
    const r = I.gridOffset(g, m.w, m.h);
    const richtig = r.offsetX === m.erwartet.x && r.offsetY === m.erwartet.y;
    const ueber = r.confidence >= SCHWELLE;
    if (ueber) belastbar++;
    t(`${m.name}: keine falsche Aussage über der Schwelle`,
      !ueber || richtig,
      `(${r.offsetX},${r.offsetY}) statt (${m.erwartet.x},${m.erwartet.y}) bei ${r.confidence}`);
    console.log(`        ${m.w}×${m.h}  gemessen (${r.offsetX},${r.offsetY})  ` +
      `Verlässlichkeit ${r.confidence.toFixed(2)}  ` +
      `${ueber ? (richtig ? 'belastbar und richtig' : 'BELASTBAR ABER FALSCH') : 'verweigert'}`);
  }
  t('mindestens die großen Bilder liefern eine Aussage', belastbar >= 3, belastbar);
}

/* ---------- 12. Ghost-Auswertung ---------- */
console.log('\n[JPEG-Ghosts]');
const qs = [];
for (let q = 50; q <= 98; q += 2) qs.push(q);
const iQ75 = qs.indexOf(76);   // Stufe, an der der Einbruch sitzen soll

function baueWuerfel(kacheln, einbruchIndex, abweicher) {
  // Grunddifferenz faellt mit steigender Qualitaet; am Einbruch zusaetzlich tief.
  return qs.map((q, qi) => {
    const f = new Float64Array(kacheln);
    for (let i = 0; i < kacheln; i++) {
      const ziel = (abweicher && abweicher.has(i)) ? qs.length - 2 : einbruchIndex;
      f[i] = 100 - qi * 0.5 + (qi === ziel ? -40 : 0);
    }
    return f;
  });
}

{
  const a = I.ghostAnalyse(baueWuerfel(100, iQ75, null), qs, 100);
  t('findet den Einbruch', a.bestQuality === qs[iQ75], a.bestQuality);
  t('keine Ausreißer bei einheitlichem Bild', a.outliers === 0, a.outliers);
  t('keine Streuung', a.spread === 0, a.spread);
  t('Kurve hat einen Punkt je Stufe', a.curve.length === qs.length);
}
{
  const fremd = new Set([...Array(20).keys()]);   // 20 von 100 Kacheln abweichend
  const a = I.ghostAnalyse(baueWuerfel(100, iQ75, fremd), qs, 100);
  t('Gesamteinbruch bleibt bei der Mehrheit', a.bestQuality === qs[iQ75], a.bestQuality);
  t('erkennt die 20 fremden Kacheln', a.outliers === 20, a.outliers);
  t('Streuung steigt', a.spread > 0);
}
{
  const a = I.ghostAnalyse([new Float64Array(1)], [80], 1);
  t('einzelne Stufe stürzt nicht ab', a.bestQuality === 80 && a.outliers === 0);
}
t('Farbskala: niedrig ≠ hoch',
  I.qualityFarbe(50, 50, 98).join() !== I.qualityFarbe(98, 50, 98).join());
t('Farbskala klemmt außerhalb',
  I.qualityFarbe(200, 50, 98).every(v => v >= 0 && v <= 255));

console.log(`\n${'='.repeat(46)}\n${ok} bestanden, ${fail} fehlgeschlagen`);
process.exit(fail ? 1 : 0);
