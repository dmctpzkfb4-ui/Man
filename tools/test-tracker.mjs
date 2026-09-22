/** Prüft die Objektverfolgung an konstruierten Abläufen mit bekannter Wahrheit. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
new Function(readFileSync(join(here, '../www/js/tracker.js'), 'utf8'))();
const Tracker = globalThis.Tracker;

let ok = 0, fail = 0;
const t = (n, b, x='') => { if (b) { ok++; console.log('  ok    '+n); } else { fail++; console.log('  FEHL  '+n+(x?'  -> '+x:'')); } };
const box = (x,y,w,h,cls=0,score=0.9) => ({ x, y, w, h, classId: cls, label: cls===0?'person':'car', score });

console.log('[Überdeckung]');
t('gleiche Box = 1', Math.abs(Tracker.iou(box(0,0,10,10), box(0,0,10,10)) - 1) < 1e-9);
t('getrennt = 0', Tracker.iou(box(0,0,10,10), box(50,50,10,10)) === 0);
t('halb überlappend', Math.abs(Tracker.iou(box(0,0,10,10), box(5,0,10,10)) - 50/150) < 1e-6);

console.log('\n[Eine Person läuft durchs Bild]');
{
  const tr = new Tracker();
  let id = null;
  for (let i = 0; i < 20; i++) {
    const r = tr.schritt([box(10 + i*5, 20, 40, 80)], i*100);
    if (r.aktiv.length) id = r.aktiv[0].id;
  }
  const b = tr.bilanz();
  t('genau ein Objekt gezählt', b.verschiedeneObjekte === 1, b.verschiedeneObjekte);
  t('Kennung bleibt gleich', id === 1, id);
  t('als "person" geführt', b.jeKlasse[0]?.label === 'person', JSON.stringify(b.jeKlasse));
}

console.log('\n[Zwanzig Bilder ohne Objekt]');
{
  const tr = new Tracker();
  for (let i = 0; i < 20; i++) tr.schritt([], i*100);
  t('nichts gezählt', tr.bilanz().verschiedeneObjekte === 0);
}

console.log('\n[Einzelbild-Fehltreffer]');
{
  const tr = new Tracker();
  tr.schritt([box(10,10,30,30)], 0);          // nur ein einziges Bild
  for (let i = 1; i < 15; i++) tr.schritt([], i*100);
  t('Aufblitzer wird nicht gezählt', tr.bilanz().verschiedeneObjekte === 0,
    tr.bilanz().verschiedeneObjekte);
}

console.log('\n[Kurzer Aussetzer wird überbrückt]');
{
  const tr = new Tracker();
  for (let i = 0; i < 6; i++) tr.schritt([box(10,10,40,80)], i*100);      // etabliert
  for (let i = 0; i < 4; i++) tr.schritt([], (6+i)*100);                  // vier Bilder weg
  for (let i = 0; i < 6; i++) tr.schritt([box(12,10,40,80)], (10+i)*100); // wieder da
  t('bleibt EIN Objekt', tr.bilanz().verschiedeneObjekte === 1, tr.bilanz().verschiedeneObjekte);
}

console.log('\n[Langer Aussetzer ergibt neue Kennung]');
{
  const tr = new Tracker();
  for (let i = 0; i < 6; i++) tr.schritt([box(10,10,40,80)], i*100);
  for (let i = 0; i < 15; i++) tr.schritt([], (6+i)*100);                 // zu lange weg
  for (let i = 0; i < 6; i++) tr.schritt([box(10,10,40,80)], (21+i)*100);
  t('zählt zwei - wie dokumentiert', tr.bilanz().verschiedeneObjekte === 2,
    tr.bilanz().verschiedeneObjekte);
}

console.log('\n[Zwei Personen gleichzeitig]');
{
  const tr = new Tracker();
  for (let i = 0; i < 8; i++) {
    tr.schritt([box(10+i*2, 20, 40, 80), box(300-i*2, 20, 40, 80)], i*100);
  }
  const b = tr.bilanz();
  t('zwei Objekte', b.verschiedeneObjekte === 2, b.verschiedeneObjekte);
  t('beide aktiv', b.aktuellImBild === 2, b.aktuellImBild);
  t('verschiedene Kennungen', new Set(tr.aktive().map(s=>s.id)).size === 2);
}

console.log('\n[Verschiedene Klassen werden nicht verwechselt]');
{
  const tr = new Tracker();
  // Auto und Person exakt übereinander - darf NICHT zusammengelegt werden
  for (let i = 0; i < 8; i++) tr.schritt([box(50,50,60,60,0), box(50,50,60,60,1)], i*100);
  const b = tr.bilanz();
  t('beide getrennt geführt', b.verschiedeneObjekte === 2, b.verschiedeneObjekte);
  t('je Klasse eines', b.jeKlasse.length === 2, JSON.stringify(b.jeKlasse));
}

console.log('\n[Verweildauer]');
{
  const tr = new Tracker();
  for (let i = 0; i < 12; i++) tr.schritt([box(10,10,40,80)], i*250);
  const s = tr.aktive()[0];
  t('Dauer aus Zeitstempeln', s.zuletzt - s.zuerst === 11*250, s.zuletzt - s.zuerst);
  t('Bildzahl stimmt', s.gesehen === 12, s.gesehen);
}

console.log('\n[Zurücksetzen]');
{
  const tr = new Tracker();
  for (let i = 0; i < 8; i++) tr.schritt([box(10,10,40,80)], i*100);
  tr.zuruecksetzen();
  t('alles leer', tr.bilanz().verschiedeneObjekte === 0 && tr.bilanz().bilder === 0);
}

console.log(`\n${'='.repeat(46)}\n${ok} bestanden, ${fail} fehlgeschlagen`);
process.exit(fail ? 1 : 0);
