/**
 * Prüft die App im echten Browser (Chromium, kopflos).
 *
 * Bis hierher konnte nur die reine Rechnerei ohne Browser geprüft werden -
 * dadurch sind zwei Fehler bis aufs Gerät durchgerutscht: ein falsch
 * aufgelöster Worker-Pfad und ein Laufzeit-Bündel, das nicht zu den
 * mitgelieferten .wasm-Dateien passte. Beides hätte dieser Test gefunden.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const WWW = join(here, '../www');
const PORT = 8123;

const TYPEN = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream', '.jpg': 'image/jpeg', '.png': 'image/png'
};

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const datei = join(WWW, normalize(p).replace(/^(\.\.[/\\])+/, ''));
    const inhalt = await readFile(datei);
    res.writeHead(200, { 'Content-Type': TYPEN[extname(datei)] || 'application/octet-stream' });
    res.end(inhalt);
  } catch {
    res.writeHead(404).end('nicht gefunden');
  }
});
await new Promise(r => server.listen(PORT, r));

let ok = 0, fail = 0;
const t = (n, b, x = '') => { if (b) { ok++; console.log('  ok    ' + n); } else { fail++; console.log('  FEHL  ' + n + (x ? '  -> ' + x : '')); } };

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage']
});
const seite = await browser.newPage();

const konsole = [], netzFehler = [];
seite.on('console', m => konsole.push(m.type() + ': ' + m.text()));
seite.on('pageerror', e => konsole.push('pageerror: ' + e.message));
seite.on('requestfailed', r => netzFehler.push(r.url() + ' — ' + (r.failure()?.errorText || '')));
seite.on('response', r => { if (r.status() >= 400) netzFehler.push(r.status() + ' ' + r.url()); });

/* ---------- Bündel und Laufzeitdateien müssen zusammenpassen ----------
 * Genau das ging zweimal schief: ein Bündel wurde mit den Laufzeitdateien
 * eines anderen ausgeliefert. Das Bündel baut den Dateinamen als festen
 * String - er lässt sich also vor dem Start prüfen. */
console.log('[Auslieferung]');
{
  const vendor = join(WWW, 'vendor');
  const dateien = (await import('node:fs/promises')).readdir
    ? await (await import('node:fs/promises')).readdir(vendor) : [];
  const bundleName = dateien.find(f => /^ort\..*\.min\.js$/.test(f) || f === 'ort.min.js');
  t('genau ein ORT-Bündel liegt bei',
    dateien.filter(f => /^ort\.[a-z.]*min\.js$/.test(f)).length === 1, dateien.join(','));

  const bundle = await readFile(join(vendor, bundleName), 'utf8');
  // Der Dateiname steht als Zeichenkette im Bündel.
  const verlangt = [...bundle.matchAll(/"(ort-wasm[a-z0-9.-]*\.mjs)"/g)].map(m => m[1]);
  const einzig = [...new Set(verlangt)];
  t('das Bündel verlangt genau eine Laufzeitdatei', einzig.length === 1, einzig.join(','));
  t(`verlangte Datei "${einzig[0]}" liegt bei`, dateien.includes(einzig[0]),
    'vorhanden: ' + dateien.join(', '));
  const wasm = einzig[0]?.replace(/\.mjs$/, '.wasm');
  t(`zugehörige "${wasm}" liegt bei`, dateien.includes(wasm), dateien.join(', '));

  const html = await readFile(join(WWW, 'index.html'), 'utf8');
  t('die Seite bindet genau dieses Bündel ein',
    html.includes(`src="vendor/${bundleName}"`), bundleName);
  const appJs = await readFile(join(WWW, 'js/app.js'), 'utf8');
  t('der Worker bekommt dasselbe Bündel',
    appJs.includes(`ortUrl: 'vendor/${bundleName}'`), bundleName);
  console.log(`    Bündel ${bundleName} -> ${einzig[0]} + ${wasm}`);
}

console.log('[Seite laden]');
await seite.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle', timeout: 60000 });
t('Seite lädt ohne fehlgeschlagene Anfragen', netzFehler.length === 0, netzFehler.join(' | '));

const module = await seite.evaluate(() => ({
  forensics: typeof window.Forensics, detector: typeof window.Detector,
  skripte: typeof window.Skripte, ort: typeof window.ort
}));
t('Forensics geladen', module.forensics === 'object');
t('Detector geladen', module.detector === 'object');
t('Skripte geladen', module.skripte === 'object');
t('ONNX Runtime geladen', module.ort === 'object', JSON.stringify(module));

console.log('\n[Erkennung starten]');
// Auf den Untertitel im Kopf warten - er meldet Backend und Klassenzahl,
// oder die App zeigt eine Fehlermeldung.
await seite.waitForFunction(
  () => { const s = document.getElementById('brandSub')?.textContent || ''; 
          return /Klassen|nicht verfügbar/i.test(s); },
  { timeout: 180000 }
).catch(() => {});

const kopf = await seite.textContent('#brandSub');
const fehlerkarte = await seite.$('.notice[data-level="crit"]');
const fehlertext = fehlerkarte ? (await fehlerkarte.textContent()).replace(/\s+/g, ' ').trim() : null;

t('kein Startfehler gemeldet', !fehlertext, fehlertext);
t('Backend im Kopf gemeldet', /Klassen/.test(kopf || ''), kopf);

if (/Klassen/.test(kopf || '')) {
  console.log('\n[Inferenz auf echtem Bild]');
  const jpg = await readFile('/tmp/claude-0/-home-user/b5051471-7984-5759-b116-41c1808ca86f/scratchpad/bus.jpg');
  const b64 = jpg.toString('base64');
  const treffer = await seite.evaluate(async (b64) => {
    const blob = await (await fetch('data:image/jpeg;base64,' + b64)).blob();
    const bmp = await createImageBitmap(blob);
    const hits = await window.Detector.detect(bmp, { conf: 0.4, iou: 0.45, maxDet: 50 });
    return { hits: hits.map(h => ({ label: h.label, score: +h.score.toFixed(3),
               x: Math.round(h.x), y: Math.round(h.y), w: Math.round(h.w), h: Math.round(h.h) })),
             stats: window.Detector.stats, breite: bmp.width, hoehe: bmp.height };
  }, b64);

  console.log(`    Backend ${treffer.stats.backend}, ${treffer.stats.lastInferenceMs} ms, Bild ${treffer.breite}×${treffer.hoehe}`);
  treffer.hits.forEach(h => console.log(`      ${h.label.padEnd(10)} ${h.score}  [${h.x},${h.y},${h.w},${h.h}]`));

  t('Objekte erkannt', treffer.hits.length > 0, treffer.hits.length + ' Treffer');
  t('Bus erkannt', treffer.hits.some(h => h.label === 'bus'));
  t('mindestens drei Personen', treffer.hits.filter(h => h.label === 'person').length >= 3,
    treffer.hits.filter(h => h.label === 'person').length + ' Personen');
  t('alle Boxen innerhalb des Bildes',
    treffer.hits.every(h => h.x >= 0 && h.y >= 0 && h.x + h.w <= treffer.breite + 1 && h.y + h.h <= treffer.hoehe + 1),
    JSON.stringify(treffer.hits.filter(h => h.x < 0 || h.y < 0)));
  t('Inferenzzeit gemessen', treffer.stats.lastInferenceMs > 0);
}

console.log('\n[Forensik im Browser]');
const jpg2 = await readFile('/tmp/claude-0/-home-user/b5051471-7984-5759-b116-41c1808ca86f/scratchpad/bus.jpg');
const fo = await seite.evaluate(async (b64) => {
  const blob = await (await fetch('data:image/jpeg;base64,' + b64)).blob();
  const bmp = await createImageBitmap(blob);
  const [h, m, ela, bag, ph] = await Promise.all([
    window.Forensics.hash(blob), window.Forensics.readMetadata(blob),
    window.Forensics.errorLevelAnalysis(bmp), window.Forensics.blockingArtifactGrid(bmp),
    window.Forensics.perceptualHashes(bmp)
  ]);
  return { sha: h.sha256, quant: m.quant ? { q: m.quant.quality, std: m.quant.standard } : null,
           elaFehler: ela.error, elaMittel: ela.meanError,
           bagFehler: bag.error, bagVerl: bag.verlaesslich, bagOff: [bag.offsetX, bag.offsetY],
           phash: ph.pHash, phFehler: ph.error };
}, jpg2.toString('base64'));

t('SHA-256 berechnet', /^[0-9a-f]{64}$/.test(fo.sha), fo.sha);
t('Quantisierungstabellen gelesen', fo.quant && fo.quant.q === 50 && fo.quant.std === true, JSON.stringify(fo.quant));
t('ELA liefert ein Ergebnis', !fo.elaFehler && fo.elaMittel > 0, fo.elaFehler || fo.elaMittel);
t('Blockraster liefert ein Ergebnis', !fo.bagFehler, fo.bagFehler);
t('pHash berechnet', /^[0-9a-f]{16}$/.test(fo.phash || ''), fo.phash || fo.phFehler);
console.log(`    Blockraster ${fo.bagVerl ? 'verlässlich ' + JSON.stringify(fo.bagOff) : 'nicht verlässlich'} · pHash ${fo.phash}`);

console.log('\n[Skript-Sandkasten]');
const sk = await seite.evaluate(async (b64) => {
  const blob = await (await fetch('data:image/jpeg;base64,' + b64)).blob();
  const datei = new File([blob], 'probe.jpg', { type: 'image/jpeg' });
  const gut = await window.Skripte.laufe(
    'const h = await werkzeuge.hash();\nwerkzeuge.setze("sha", h.sha256.slice(0,12));\nwerkzeuge.markiere("info","gelaufen");',
    [datei], {});
  const boese = await window.Skripte.laufe(
    'try { await fetch("https://example.com"); werkzeuge.setze("netz","DURCHGEKOMMEN"); }\n' +
    'catch (e) { werkzeuge.setze("netz", "blockiert"); }',
    [datei], {});
  return { gut: gut[0], boese: boese[0] };
}, jpg2.toString('base64'));

t('Rezept läuft und liefert Felder', sk.gut.ok && sk.gut.felder.sha, JSON.stringify(sk.gut).slice(0, 200));
t('Rezept kann Befunde setzen', (sk.gut.befunde || []).length === 1);
t('fetch ist im Sandkasten gesperrt', sk.boese.felder.netz === 'blockiert', JSON.stringify(sk.boese.felder));

// 404 auf das Browsersymbol ist kein App-Fehler - es gibt schlicht keins.
console.log('\n[Darstellung und Ablesung]');
const dv = await seite.evaluate(async (b64) => {
  const blob = await (await fetch('data:image/jpeg;base64,' + b64)).blob();
  const datei = new File([blob], 'probe.jpg', { type: 'image/jpeg' });
  const dt = new DataTransfer(); dt.items.add(datei);
  const inp = document.getElementById('fileInput');
  inp.files = dt.files;
  inp.dispatchEvent(new Event('change'));
  // Auf das Ende der Analyse warten
  await new Promise(r => {
    const t0 = Date.now();
    const i = setInterval(() => {
      if (!document.getElementById('hashPanel').hidden || Date.now() - t0 > 90000) { clearInterval(i); r(); }
    }, 250);
  });
  const c = document.getElementById('analyseCanvas');
  const g = c.getContext('2d', { willReadFrequently: true });
  const probe = () => Array.from(g.getImageData(Math.floor(c.width/2), Math.floor(c.height/2), 1, 1).data);

  const seg = document.querySelector('#viewSeg button[data-layer="ela"]');
  const elaFrei = seg && !seg.disabled;

  const chips = [...document.querySelectorAll('#filterChips .chip')].map(b => b.textContent);
  const orig = probe();
  // Graustufen: R, G und B müssen danach gleich sein.
  [...document.querySelectorAll('#filterChips .chip')].find(b => b.textContent === 'Graustufen').click();
  const grau = probe();
  [...document.querySelectorAll('#filterChips .chip')].find(b => b.textContent === 'nur Rot').click();
  const rot = probe();
  [...document.querySelectorAll('#filterChips .chip')].find(b => b.textContent === 'Invertiert').click();
  const inv = probe();
  [...document.querySelectorAll('#filterChips .chip')].find(b => b.textContent === 'Original').click();
  const zurueck = probe();

  return { canvasBreite: c.width, elaFrei, chips, orig, grau, rot, inv, zurueck,
           panelSichtbar: !document.getElementById('ansichtPanel').hidden,
           hatBericht: !!window.__bericht };
}, jpg2.toString('base64'));

t('Analyse-Ansichtsfeld erscheint', dv.panelSichtbar);
t('alle sieben Darstellungen angeboten', dv.chips.length === 7, dv.chips.join(','));
t('ELA-Ebene freigeschaltet', dv.elaFrei);
t('Graustufen: R = G = B', dv.grau[0] === dv.grau[1] && dv.grau[1] === dv.grau[2],
  dv.grau.slice(0,3).join(','));
t('nur Rot: Grün und Blau auf null', dv.rot[1] === 0 && dv.rot[2] === 0, dv.rot.slice(0,3).join(','));
t('Invertiert kehrt um', Math.abs((255 - dv.orig[0]) - dv.inv[0]) <= 1,
  `orig ${dv.orig[0]} -> inv ${dv.inv[0]}`);
t('Original stellt wieder her', dv.zurueck.slice(0,3).join() === dv.orig.slice(0,3).join(),
  dv.zurueck.slice(0,3).join(','));

console.log('\n[Wischvergleich und Bildpunkt]');
const wp = await seite.evaluate(async () => {
  document.querySelector('#viewSeg button[data-layer="ela"]').click();
  await new Promise(r => setTimeout(r, 300));
  const wischSichtbar = !document.getElementById('wischBox').hidden;
  const c = document.getElementById('analyseCanvas');
  const g = c.getContext('2d', { willReadFrequently: true });
  const links = () => Array.from(g.getImageData(4, Math.floor(c.height/2), 1, 1).data);

  const regler = document.getElementById('wischRange');
  regler.value = 100; regler.dispatchEvent(new Event('input'));
  const ganzEla = links();
  regler.value = 0; regler.dispatchEvent(new Event('input'));
  const ganzOriginal = links();

  // Bildpunkt ablesen: Tippen in die Mitte der Leinwand nachbilden
  const r = c.getBoundingClientRect();
  const stage = document.getElementById('analyseStage');
  const mitte = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  stage.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: mitte.x, clientY: mitte.y, bubbles: true }));
  stage.dispatchEvent(new PointerEvent('pointerup',   { pointerId: 1, clientX: mitte.x, clientY: mitte.y, bubbles: true }));
  const werte = document.getElementById('pixelWerte').textContent;
  const pixelSichtbar = !document.getElementById('pixelBox').hidden;

  regler.value = 100; regler.dispatchEvent(new Event('input'));
  return { wischSichtbar, ganzEla, ganzOriginal, werte, pixelSichtbar };
});

t('Wischregler erscheint bei einer Ebene', wp.wischSichtbar);
t('Wischregler verändert die linke Bildhälfte',
  wp.ganzEla.slice(0,3).join() !== wp.ganzOriginal.slice(0,3).join(),
  `ELA ${wp.ganzEla.slice(0,3)} vs Original ${wp.ganzOriginal.slice(0,3)}`);
t('Bildpunkt wird abgelesen', wp.pixelSichtbar && /RGB \d+, \d+, \d+/.test(wp.werte), wp.werte);
t('Bildpunkt nennt HSL und Position', /HSL .*Punkt \d+, \d+/.test(wp.werte), wp.werte);
console.log('    ' + wp.werte.replace(/\s+/g, ' ').trim());

const echteNetzFehler = netzFehler.filter(u => !/favicon\.ico/i.test(u));
t('keine fehlgeschlagenen Anfragen insgesamt', echteNetzFehler.length === 0,
  echteNetzFehler.slice(0, 5).join(' | '));
const echteFehler = konsole.filter(z => /^(error|pageerror)/.test(z) &&
  !/favicon/i.test(z) && !(/404/.test(z) && echteNetzFehler.length === 0));
t('keine Konsolenfehler', echteFehler.length === 0, echteFehler.slice(0, 3).join(' | '));
if (netzFehler.length) console.log('    Netz: ' + netzFehler.join(' | '));

await browser.close();
server.close();
console.log(`\n${'='.repeat(46)}\n${ok} bestanden, ${fail} fehlgeschlagen`);
process.exit(fail ? 1 : 0);
