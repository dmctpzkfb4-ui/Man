/**
 * Prüft die reine Mathematik von detector.js ohne Browser.
 * Referenzwerte stammen aus der verifizierten Python-Implementierung,
 * die gegen das echte ONNX-Modell gelaufen ist.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
new Function(readFileSync(join(here, '../www/js/detector.js'), 'utf8'))();
const C = globalThis.DetectorCore;

let ok = 0, fail = 0;
const t = (n, b, x = '') => { if (b) { ok++; console.log('  ok    ' + n); } else { fail++; console.log('  FEHL  ' + n + (x ? '  -> ' + x : '')); } };
const near = (a, b, e = 0.01) => Math.abs(a - b) < e;

console.log('[Letterbox gegen Python-Referenz: 810x1080 -> 640]');
const lb = C.computeLetterbox(810, 1080, 640);
t('Skalierung 0,5926', near(lb.scale, 0.5926, 1e-4), lb.scale);
t('Polsterung X = 80', near(lb.padX, 80, 0.5), lb.padX);
t('Polsterung Y = 0',  near(lb.padY, 0, 0.5), lb.padY);

console.log('\n[Rückrechnung: Modellraum -> Quellpixel]');
// bus-Box aus der Python-Referenz: [10.0, 229.9, 802.4, 747.4] im Quellbild
const quelle = { x: 10.0, y: 229.9, w: 792.4, h: 517.5 };
const imModell = C.sourceBoxToLetterbox(quelle, lb);
const zurueck = C.letterboxBoxToSource(imModell.x1, imModell.y1, imModell.x2, imModell.y2, lb);
t('Hin und zurück ergibt dieselbe Box',
  near(zurueck.x, quelle.x, 0.5) && near(zurueck.y, quelle.y, 0.5) &&
  near(zurueck.w, quelle.w, 0.5) && near(zurueck.h, quelle.h, 0.5),
  JSON.stringify(zurueck));

// Am Rand angeschnittene Box: die Python-Referenz lieferte hier x1 = -1,0.
// Erwartet wird, dass auf 0 geklemmt wird statt ausserhalb zu zeichnen.
const randModell = C.sourceBoxToLetterbox({ x: -12, y: 551.9, w: 75, h: 321.2 }, lb);
const geklemmt = C.letterboxBoxToSource(randModell.x1, randModell.y1, randModell.x2, randModell.y2, lb);
t('negative Koordinate wird auf 0 geklemmt', geklemmt.x >= 0, JSON.stringify(geklemmt));
t('Box bleibt innerhalb der Bildbreite', geklemmt.x + geklemmt.w <= 810.5, geklemmt.x + geklemmt.w);

console.log('\n[IoU]');
t('identische Boxen = 1', near(C.iou({x1:0,y1:0,x2:10,y2:10},{x1:0,y1:0,x2:10,y2:10}), 1));
t('getrennte Boxen = 0', near(C.iou({x1:0,y1:0,x2:10,y2:10},{x1:20,y1:20,x2:30,y2:30}), 0));
t('halbe Überlappung', near(C.iou({x1:0,y1:0,x2:10,y2:10},{x1:5,y1:0,x2:15,y2:10}), 50/150, 1e-3));

console.log('\n[NMS]');
const kand = [
  { x1:0,y1:0,x2:10,y2:10, score:0.9, classId:0 },
  { x1:1,y1:1,x2:11,y2:11, score:0.8, classId:0 },   // überlappt stark -> raus
  { x1:50,y1:50,x2:60,y2:60, score:0.7, classId:0 }, // getrennt -> bleibt
  { x1:0,y1:0,x2:10,y2:10, score:0.6, classId:1 },   // andere Klasse -> bleibt
];
const behalten = C.nonMaxSuppression(kand, 0.45, 100);
t('unterdrückt Dubletten, behält Rest', behalten.length === 3, behalten.length);
t('stärkster Treffer zuerst', behalten[0].score === 0.9);

console.log('\n[Ausgabeform-Erkennung]');
t('[1,84,8400] = YOLO transponiert', C.detectOutputLayout([1,84,8400], 80).kind === 'yolo');
t('[1,8400,84] = YOLO nicht transponiert', C.detectOutputLayout([1,8400,84], 80).kind === 'yolo');
t('[1,300,6] = End-to-End', C.detectOutputLayout([1,300,6], 80).kind === 'e2e');
t('320er Variante [1,84,2100]', C.detectOutputLayout([1,84,2100], 80).numBoxes === 2100);

console.log('\n[Pixelumwandlung]');
const rgba = new Uint8ClampedArray(2*2*4).fill(255);
const ziel = new Float32Array(3*2*2);
C.rgbaToNchwFloat(rgba, ziel, 2);
t('Weiß wird zu 1,0', ziel.every(v => near(v, 1)));

console.log(`\n${'='.repeat(46)}\n${ok} bestanden, ${fail} fehlgeschlagen`);
process.exit(fail ? 1 : 0);
