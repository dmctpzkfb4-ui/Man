/**
 * Dauerlauf: erkennt hunderte Male hintereinander und misst dabei den
 * Speicher. Ein Absturz der ganzen App nach kurzer Zeit ist fast immer
 * Speichermangel - das System beendet den Prozess, es gibt keinen
 * JavaScript-Fehler zu sehen. Genau das lässt sich hier nachstellen.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const WWW = join(here, '../www');
const T = { '.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css',
            '.json':'application/json','.wasm':'application/wasm','.onnx':'application/octet-stream','.jpg':'image/jpeg' };
const srv = createServer(async (q,r)=>{
  let inhalt = null, typ = 'application/octet-stream';
  try {
    let p=decodeURIComponent(q.url.split('?')[0]); if(p==='/')p='/index.html';
    const f=join(WWW,normalize(p).replace(/^(\.\.[/\\])+/,''));
    inhalt = await readFile(f);
    typ = T[extname(f)] || typ;
  } catch { /* nicht gefunden */ }
  // Kopfzeilen erst schreiben, wenn feststeht was kommt - sonst fliegt
  // ERR_HTTP_HEADERS_SENT, wenn das Lesen nach dem writeHead scheitert.
  if (inhalt) { r.writeHead(200, {'Content-Type': typ}); r.end(inhalt); }
  else { r.writeHead(404).end('nicht gefunden'); }
});
await new Promise(r=>srv.listen(8125,r));

const DURCHLAEUFE = Number(process.env.N || 300);

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox','--disable-dev-shm-usage','--js-flags=--expose-gc']
});

/* usedJSHeapSize misst NUR den Heap des Hauptthreads. Der WASM-Speicher,
 * die Bitmaps und der Worker liegen ausserhalb - also genau dort, wo ein
 * Leck saesse, das die App auf dem Geraet abstuerzen laesst. Deshalb wird
 * zusaetzlich der echte Speicherbedarf aller Browserprozesse gemessen. */
const { readFile: lies, readdir } = await import('node:fs/promises');
async function prozessSpeicherMB() {
  let summe = 0;
  for (const e of await readdir('/proc')) {
    if (!/^\d+$/.test(e)) continue;
    try {
      const cmd = await lies(`/proc/${e}/cmdline`, 'utf8');
      if (!/chrome|headless_shell/.test(cmd)) continue;
      const st = await lies(`/proc/${e}/status`, 'utf8');
      const m = st.match(/VmRSS:\s+(\d+) kB/);
      if (m) summe += Number(m[1]);
    } catch { /* Prozess verschwunden */ }
  }
  return Math.round(summe / 1024);
}
const seite = await browser.newPage();
const fehler = [];
seite.on('pageerror', e => fehler.push(e.message));
seite.on('crash', () => fehler.push('SEITE ABGESTUERZT'));

await seite.goto('http://127.0.0.1:8125/', { waitUntil:'networkidle', timeout:60000 });
await seite.waitForFunction(
  () => /Klassen/.test(document.getElementById('brandSub')?.textContent||''), { timeout:180000 });

const jpg = (await readFile('/tmp/claude-0/-home-user/b5051471-7984-5759-b116-41c1808ca86f/scratchpad/bus.jpg')).toString('base64');

const rssVerlauf = [];
await seite.exposeFunction('__messpunkt', async (i) => {
  rssVerlauf.push({ i, rss: await prozessSpeicherMB() });
});

console.log(`Dauerlauf: ${DURCHLAEUFE} Erkennungen\n`);
console.log('  Prozessspeicher vor dem Start: ' + (await prozessSpeicherMB()) + ' MB');
const werte = await seite.evaluate(async ({ b64, n }) => {
  const blob = await (await fetch('data:image/jpeg;base64,'+b64)).blob();
  // Eine Videoquelle nachbilden: jedes Bild ein frisches Bitmap, genau wie
  // die Kameraschleife es tut.
  const punkte = [];
  const speicher = () => (performance.memory ? performance.memory.usedJSHeapSize : 0);
  let treffer = 0;
  for (let i = 0; i < n; i++) {
    const bmp = await createImageBitmap(blob);
    const hits = await window.Detector.detect(bmp, { conf: 0.4, iou: 0.45, maxDet: 60 });
    treffer += hits.length;
    bmp.close();
    if (i % 25 === 0) {
      if (window.gc) window.gc();
      punkte.push({ i, heap: Math.round(speicher()/1048576*10)/10,
                    ms: window.Detector.stats.lastInferenceMs });
      // Dem messenden Prozess Gelegenheit geben, den Wert abzugreifen
      await new Promise(r => setTimeout(r, 0));
      if (window.__messpunkt) window.__messpunkt(i);
    }
  }
  return { punkte, treffer, verarbeitet: window.Detector.stats.framesProcessed };
}, { b64: jpg, n: DURCHLAEUFE });

console.log('\n  Lauf   Heap MB   Prozess MB   Inferenz');
werte.punkte.forEach((p, k) => {
  const r = rssVerlauf[k];
  console.log(`  ${String(p.i).padStart(4)}   ${String(p.heap).padStart(7)}   ` +
              `${String(r ? r.rss : '?').padStart(10)}   ${p.ms} ms`);
});

const ersteHaelfte = werte.punkte.slice(1, Math.ceil(werte.punkte.length/2));
const zweiteHaelfte = werte.punkte.slice(Math.ceil(werte.punkte.length/2));
const mw = a => a.reduce((x,p)=>x+p.heap,0)/Math.max(1,a.length);
const wachstum = mw(zweiteHaelfte) - mw(ersteHaelfte);

console.log(`\n  Treffer gesamt: ${werte.treffer} (${(werte.treffer/DURCHLAEUFE).toFixed(1)} je Bild)`);
console.log(`  Heap erste Hälfte: ${mw(ersteHaelfte).toFixed(1)} MB, zweite: ${mw(zweiteHaelfte).toFixed(1)} MB`);
console.log(`  Zuwachs: ${wachstum >= 0 ? '+' : ''}${wachstum.toFixed(1)} MB`);
console.log(`  Seitenfehler: ${fehler.length ? fehler.join(' | ') : 'keine'}`);

await browser.close(); srv.close();
const rssErste = rssVerlauf.slice(1, Math.ceil(rssVerlauf.length/2));
const rssZweite = rssVerlauf.slice(Math.ceil(rssVerlauf.length/2));
const rssMw = a => a.reduce((x,p)=>x+p.rss,0)/Math.max(1,a.length);
const rssWachstum = rssMw(rssZweite) - rssMw(rssErste);
console.log(`  Prozess erste Hälfte: ${rssMw(rssErste).toFixed(0)} MB, zweite: ${rssMw(rssZweite).toFixed(0)} MB`);
console.log(`  Prozess-Zuwachs: ${rssWachstum >= 0 ? '+' : ''}${rssWachstum.toFixed(0)} MB`);

const problem = wachstum > 12 || rssWachstum > 60 || fehler.length;
console.log(problem ? '\n  BEFUND: Speicher wächst oder es gab Fehler.' : '\n  BEFUND: stabil.');
process.exit(problem ? 1 : 0);
