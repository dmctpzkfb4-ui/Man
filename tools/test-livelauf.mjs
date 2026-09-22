/**
 * Fährt die ECHTE Live-Schleife der App mit einer synthetischen Kamera.
 *
 * Der Dauerlauf-Test rief nur detect() auf. Die wirkliche Schleife macht je
 * Bild deutlich mehr: Overlay zeichnen, Trefferliste neu aufbauen, Laufband,
 * Verlaufskurve, Protokoll. Ein Absturz der ganzen App nach Minuten kommt
 * eher von dort als von der Inferenz - deshalb wird hier die Schleife selbst
 * gefahren, nicht ein Ersatz dafür.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const WWW = join(here, '../www');
const T = { '.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css',
            '.json':'application/json','.wasm':'application/wasm','.onnx':'application/octet-stream','.jpg':'image/jpeg' };
const srv = createServer(async (q,r)=>{
  let inhalt=null, typ='application/octet-stream';
  try { let p=decodeURIComponent(q.url.split('?')[0]); if(p==='/')p='/index.html';
        const f=join(WWW,normalize(p).replace(/^(\.\.[/\\])+/,''));
        inhalt=await readFile(f); typ=T[extname(f)]||typ; } catch {}
  if (inhalt) { r.writeHead(200,{'Content-Type':typ}); r.end(inhalt); }
  else { r.writeHead(404).end(); }
});
await new Promise(r=>srv.listen(8126,r));

const SEKUNDEN = Number(process.env.S || 90);

async function prozessSpeicherMB() {
  let summe = 0;
  for (const e of await readdir('/proc')) {
    if (!/^\d+$/.test(e)) continue;
    try {
      const cmd = await readFile(`/proc/${e}/cmdline`, 'utf8');
      if (!/chrome|headless_shell/.test(cmd)) continue;
      const st = await readFile(`/proc/${e}/status`, 'utf8');
      const m = st.match(/VmRSS:\s+(\d+) kB/);
      if (m) summe += Number(m[1]);
    } catch {}
  }
  return Math.round(summe / 1024);
}

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox','--disable-dev-shm-usage','--js-flags=--expose-gc',
         '--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']
});
const ctx = await browser.newContext({ permissions: ['camera'] });
const seite = await ctx.newPage();
const fehler = [];
seite.on('pageerror', e => fehler.push('pageerror: ' + e.message));
seite.on('crash', () => fehler.push('SEITE ABGESTUERZT'));
seite.on('console', m => { if (m.type() === 'error' && !/favicon/i.test(m.text()) && !/404/.test(m.text())) fehler.push('console: ' + m.text()); });

await seite.goto('http://127.0.0.1:8126/', { waitUntil:'networkidle', timeout:60000 });
await seite.waitForFunction(
  () => /Klassen/.test(document.getElementById('brandSub')?.textContent||''), { timeout:180000 });

console.log(`Live-Schleife mit synthetischer Kamera, ${SEKUNDEN} s\n`);
const start = await prozessSpeicherMB();
console.log('  Prozessspeicher vor dem Start: ' + start + ' MB\n');

await seite.click('#startCamBtn');
await seite.waitForFunction(() => !document.getElementById('liveHud').hidden, { timeout: 30000 });

console.log('  Zeit   Prozess MB   Bilder   FPS    Inferenz   DOM-Knoten   Protokoll');
const messwerte = [];
const t0 = Date.now();
while ((Date.now() - t0) / 1000 < SEKUNDEN) {
  await new Promise(r => setTimeout(r, 10000));
  const rss = await prozessSpeicherMB();
  const z = await seite.evaluate(() => ({
    bilder: window.Detector.stats.framesProcessed,
    fps: document.getElementById('mFps').textContent,
    ms: window.Detector.stats.lastInferenceMs,
    knoten: document.getElementsByTagName('*').length,
    protokoll: document.getElementById('logList').children.length
  }));
  const s = Math.round((Date.now() - t0) / 1000);
  messwerte.push({ s, rss, ...z });
  console.log(`  ${String(s).padStart(4)}s  ${String(rss).padStart(10)}   ` +
    `${String(z.bilder).padStart(6)}   ${String(z.fps).padStart(5)}  ${String(z.ms).padStart(6)} ms   ` +
    `${String(z.knoten).padStart(10)}   ${String(z.protokoll).padStart(9)}`);
}

await seite.evaluate(() => document.getElementById('stopSrcBtn').click());

const h = messwerte.slice(0, Math.ceil(messwerte.length/2));
const z2 = messwerte.slice(Math.ceil(messwerte.length/2));
const mw = (a,k) => a.reduce((x,p)=>x+p[k],0)/Math.max(1,a.length);
const rssWachstum = mw(z2,'rss') - mw(h,'rss');
const knotenWachstum = mw(z2,'knoten') - mw(h,'knoten');

console.log(`\n  Bilder gesamt: ${messwerte[messwerte.length-1]?.bilder ?? 0}`);
console.log(`  Prozess-Zuwachs: ${rssWachstum >= 0 ? '+' : ''}${rssWachstum.toFixed(0)} MB`);
console.log(`  DOM-Zuwachs: ${knotenWachstum >= 0 ? '+' : ''}${knotenWachstum.toFixed(0)} Knoten`);
console.log(`  Fehler: ${fehler.length ? fehler.slice(0,5).join(' | ') : 'keine'}`);

await browser.close(); srv.close();
const problem = rssWachstum > 80 || knotenWachstum > 400 || fehler.length;
console.log(problem ? '\n  BEFUND: wächst oder fehlerhaft.' : '\n  BEFUND: stabil.');
process.exit(problem ? 1 : 0);
