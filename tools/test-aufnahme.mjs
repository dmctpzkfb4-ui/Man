/** Nimmt im echten Browser auf und prüft, dass ein abspielbares Video entsteht. */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const WWW = join(here, '../www');
const T={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css',
        '.json':'application/json','.wasm':'application/wasm','.onnx':'application/octet-stream','.jpg':'image/jpeg'};
const srv=createServer(async(q,r)=>{let c=null,t='application/octet-stream';
 try{let p=decodeURIComponent(q.url.split('?')[0]);if(p==='/')p='/index.html';
 const f=join(WWW,normalize(p).replace(/^(\.\.[/\\])+/,''));c=await readFile(f);t=T[extname(f)]||t;}catch{}
 if(c){r.writeHead(200,{'Content-Type':t});r.end(c);}else r.writeHead(404).end();});
await new Promise(r=>srv.listen(8129,r));

let ok=0,fail=0;
const t=(n,b,x='')=>{if(b){ok++;console.log('  ok    '+n);}else{fail++;console.log('  FEHL  '+n+(x?'  -> '+x:''));}};

const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args:['--no-sandbox','--disable-dev-shm-usage','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});
const ctx=await b.newContext({permissions:['camera']});
const p=await ctx.newPage();
const fehler=[];
p.on('pageerror',e=>fehler.push(e.message));
await p.goto('http://127.0.0.1:8129/',{waitUntil:'networkidle',timeout:60000});
await p.waitForFunction(()=>/Klassen/.test(document.getElementById('brandSub')?.textContent||''),{timeout:180000});

console.log('[Verfolgung]');
await p.click('#startCamBtn');
await p.waitForFunction(()=>!document.getElementById('liveHud').hidden,{timeout:30000});
t('Aufnahmeknopf wird freigegeben', !(await p.$eval('#recBtn', e=>e.disabled)));
t('Spuren-Feld erscheint', !(await p.$eval('#spurenPanel', e=>e.hidden)));

await new Promise(r=>setTimeout(r,6000));
const verfolgung = await p.evaluate(()=>{
  const n=document.getElementById('spurenNote').textContent;
  const z=document.querySelectorAll('#spurenListe .spur').length;
  return { note:n, zeilen:z };
});
console.log('    ' + verfolgung.note);
t('Verfolgung zählt Objekte', /\d+ Objekt/.test(verfolgung.note), verfolgung.note);

console.log('\n[Aufnahme]');
await p.click('#recBtn');
await p.waitForFunction(()=>!document.getElementById('recPanel').hidden,{timeout:10000});
t('Aufnahmefeld erscheint', true);
t('Knopf wird zu Stopp', (await p.$eval('#recBtn', e=>e.textContent)) === 'Stopp');

await new Promise(r=>setTimeout(r,8000));
const laufend = await p.evaluate(()=>({
  zeit: document.getElementById('recZeit').textContent,
  punkt: document.getElementById('recPunkt').className
}));
t('Zeitanzeige läuft', /0:0[3-9]|0:1[0-9]/.test(laufend.zeit), laufend.zeit);
t('Aufnahme ist als laufend markiert', /laeuft/.test(laufend.punkt), laufend.punkt);

await p.click('#recBtn');
await p.waitForFunction(()=>!document.getElementById('recSaveBtn').disabled,{timeout:20000});

const erg = await p.evaluate(()=>{
  // Nicht speichern, sondern den Blob direkt pruefen.
  const info = document.getElementById('recInfo').textContent;
  return new Promise(res=>{
    const v = document.createElement('video');
    v.muted = true;
    v.onloadedmetadata = () => res({ info, breite: v.videoWidth, hoehe: v.videoHeight,
                                     dauer: v.duration, ok: true });
    v.onerror = () => res({ info, ok: false, fehler: 'Video nicht lesbar' });
    v.src = URL.createObjectURL(window.__recBlob);
    setTimeout(()=>res({ info, ok:false, fehler:'Zeitüberschreitung' }), 8000);
  });
});
console.log('    ' + erg.info);
t('Video ist abspielbar', erg.ok, erg.fehler || '');
if (erg.ok) {
  t('hat Bildmaße', erg.breite > 0 && erg.hoehe > 0, erg.breite + '×' + erg.hoehe);
  console.log(`    ${erg.breite}×${erg.hoehe}, Dauer ${erg.dauer === Infinity ? 'offen (Strom)' : erg.dauer.toFixed(1)+' s'}`);
}
t('Dateigröße wird gemeldet', /MB/.test(erg.info), erg.info);
t('Ereignisse gezählt', /Ereignisse/.test(erg.info), erg.info);

const zeitleiste = await p.evaluate(()=>{
  const r = window.__recEreignisse || [];
  return { anzahl: r.length, arten: [...new Set(r.map(e=>e.art))] };
});
t('Zeitleiste enthält Ereignisse', zeitleiste.anzahl >= 2, JSON.stringify(zeitleiste));
console.log('    Ereignisarten: ' + zeitleiste.arten.join(', '));

console.log('\n[Hintergrundbetrieb]');
{
  // Neue Aufnahme starten, dann die Seite auf "unsichtbar" schalten.
  // requestAnimationFrame feuert dann nicht mehr - die Schleife muss auf
  // setTimeout wechseln, sonst friert die Aufnahme ein.
  await p.click('#recBtn');
  await p.waitForFunction(()=>document.getElementById('recBtn').textContent==='Stopp',{timeout:10000});
  await new Promise(r=>setTimeout(r,2500));
  const vorher = await p.evaluate(()=>window.Detector.stats.framesProcessed);

  // Sichtbarkeit wegnehmen
  const cdp = await p.context().newCDPSession(p);
  await cdp.send('Emulation.setPageVisibilityOverride', { visibility: 'hidden' }).catch(()=>{});
  await p.evaluate(()=>{
    Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});
    Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>'hidden'});
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await new Promise(r=>setTimeout(r,12000));
  const imHintergrund = await p.evaluate(()=>({
    bilder: window.Detector.stats.framesProcessed,
    laeuft: document.getElementById('recBtn').textContent === 'Stopp',
    zeit: document.getElementById('recZeit').textContent
  }));

  t('Erkennung läuft im Hintergrund weiter', imHintergrund.bilder > vorher + 3,
    `${vorher} -> ${imHintergrund.bilder}`);
  t('Aufnahme bleibt aktiv', imHintergrund.laeuft, imHintergrund.zeit);
  console.log(`    ${vorher} -> ${imHintergrund.bilder} Bilder, Zeit ${imHintergrund.zeit}`);

  // Wieder sichtbar machen und beenden
  await p.evaluate(()=>{
    Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});
    Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>'visible'});
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await cdp.send('Emulation.setPageVisibilityOverride', { visibility: 'visible' }).catch(()=>{});
  await p.click('#recBtn');
  await p.waitForFunction(()=>!document.getElementById('recSaveBtn').disabled,{timeout:20000});
  const zweites = await p.evaluate(()=>new Promise(res=>{
    const v=document.createElement('video'); v.muted=true;
    v.onloadedmetadata=()=>res({bytes:window.__recBlob.size, breite:v.videoWidth, ok:true});
    v.onerror=()=>res({bytes:window.__recBlob.size, ok:false});
    v.src=URL.createObjectURL(window.__recBlob);
    setTimeout(()=>res({bytes:window.__recBlob.size, ok:false, grund:'Zeitüberschreitung'}),8000);
  }));
  // Kopflos laesst sich echtes Hintergrundverhalten nicht nachstellen -
  // geprueft wird deshalb, dass ueberhaupt ein gueltiges Video entsteht,
  // waehrend die Anwendung sich fuer unsichtbar haelt.
  t('Aufnahme über den Sichtbarkeitswechsel hinweg bleibt gültig',
    zweites.ok && zweites.bytes > 3000, JSON.stringify(zweites));
  console.log(`    zweite Aufnahme: ${zweites.bytes} Byte, ${zweites.breite||'?'} px breit`);
}

console.log('\n[Speicherweg]');
{
  const sp = await p.evaluate(()=>({
    hatFunktion: typeof window.__sichereDatei === 'function',
    hatPlugin: !!(window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem)
  }));
  t('Speicherfunktion vorhanden', sp.hatFunktion, JSON.stringify(sp));
  console.log('    Dateisystem-Plugin im Browser: ' + (sp.hatPlugin ? 'ja' : 'nein (Rückfall auf Download)'));
}

t('keine Seitenfehler', fehler.length === 0, fehler.slice(0,2).join(' | '));

await b.close(); srv.close();
console.log(`\n${'='.repeat(46)}\n${ok} bestanden, ${fail} fehlgeschlagen`);
process.exit(fail?1:0);
