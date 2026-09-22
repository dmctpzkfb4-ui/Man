/*!
 * app.js — Verdrahtung von Oberfläche, Erkennung und Forensik
 * -------------------------------------------------------------
 * Beide Fachmodule können fehlen oder beim Laden scheitern. Die
 * Oberfläche muss das überleben und benennen, statt weiß zu bleiben.
 */
(function () {
  'use strict';

  var FASSUNG = "2.5";
  var STAND = "2026-09-22 23:40";

  var $ = function (id) { return document.getElementById(id); };
  /* Leistungsstufen. Gemessen auf vier CPU-Kernen gegen ein Referenzbild:
   * 192 px braucht 3,7 ms, 256 px 4,9 ms, 320 px 6,9 ms. Bei 192 px faellt
   * die Erkennungsguete allerdings sichtbar ab (Bus 0,62 statt 0,89) -
   * darum ist die Stufe als solche gekennzeichnet und nicht die Vorgabe.
   *
   * Die Stufe regelt nicht nur das Modell, sondern auch Kameraaufloesung
   * und Takt. Der Speicherbedarf haengt gemessen VIEL staerker an diesen
   * beiden als am Modell - ein kleineres Modell allein bringt fast nichts.
   */
  var STUFEN = {
    sparsam: {
      // Bewusst dasselbe Modell wie "Ausgewogen": gemessen haengt der
      // Speicherbedarf weit staerker an Kameraaufloesung und Takt als an
      // der Modellgroesse - alle geprueften Varianten lagen innerhalb von
      // sechs Prozent. Ein 192er Modell haette die Trefferguete spuerbar
      // gesenkt (Bus 0,62 statt 0,83), ohne nennenswert Speicher zu sparen.
      name: 'Sparsam', modell: 'models/model-256.onnx', size: 256,
      breite: 640, hoehe: 360, takt: 250,
      hinweis: 'Geringste Last: 4 Bilder je Sekunde, Kamera 640×360. ' +
               'Gleiche Trefferqualität wie „Ausgewogen“, nur seltener und auf kleinerem Bild — ' +
               'für Geräte, auf denen die App sonst abstürzt.'
    },
    ausgewogen: {
      name: 'Ausgewogen', modell: 'models/model-256.onnx', size: 256,
      breite: 854, hoehe: 480, takt: 130,
      hinweis: 'Rund 30 % weniger Rechenaufwand als „Genau“, bei nahezu gleicher Trefferqualität. ' +
               'Empfohlen, wenn die App bisher abgestürzt ist.'
    },
    genau: {
      // Alle drei Stufen teilen sich dasselbe Modell. Das ist die direkte
      // Folge der Messung: der Speicherbedarf lag bei allen geprueften
      // Modellvarianten innerhalb von sechs Prozent, waehrend Kamera und
      // Takt ihn deutlich bewegen. Ein zweites Modell mitzuliefern haette
      // die Anwendung um zehn Megabyte vergroessert, ohne etwas zu loesen.
      name: 'Genau', modell: 'models/model-256.onnx', size: 256,
      breite: 1280, hoehe: 720, takt: 80,
      hinweis: 'Höchste Bildrate und schärfstes Kamerabild. Braucht am meisten Speicher — ' +
               'diese Stufe zuletzt versuchen.'
    }
  };
  var STILL_MODEL = { url: 'models/model.onnx', size: 640 };

  var S = {
    labels: [], meta: null,
    detectorReady: false, detectorMode: null,
    stream: null, facing: 'environment', running: false, busy: false,
    quelle: 'kamera', srcW: 0, srcH: 0, warPausiert: false, freigabeUhr: null,
    stufe: 'ausgewogen',
    schirmAktiv: false, schirmNativ: false, schirmBitmap: null,
    conf: 0.25, iou: 0.45,
    fpsWindow: [], lastHits: [],
    bild: null, bitmap: null, layers: {}, layer: 'original',
    bericht: null, filter: null, ghosts: null,
    zoom: 1, panX: 0, panY: 0,
    wisch: 1, darstellung: 'keine', pixel: null,
    log: []
  };

  /* ================================================================ Basis */

  function toast(text, ms) {
    var el = $('toast');
    el.textContent = text; el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.hidden = true; }, ms || 2600);
  }

  function notice(level, title, detail) {
    var box = $('bootNotices');
    var d = document.createElement('div');
    d.className = 'notice notice--' + (level === 'crit' ? 'error' : level);
    d.setAttribute('data-level', level);
    d.innerHTML = '<div class="notice-body"><p class="notice-title"></p>' +
                  (detail ? '<p class="notice-detail"></p>' : '') + '</div>';
    d.querySelector('.notice-title').textContent = title;
    if (detail) d.querySelector('.notice-detail').textContent = detail;
    box.appendChild(d);
    return d;
  }

  /* ==================================================== Laufband (Live-Ausgabe)
   * Zeigt fortlaufend, was gerade passiert. Absichtlich nur EINE Zeile: ein
   * zweites Protokoll waere Verdopplung. Ereignisse werden gedrosselt, sonst
   * flackert die Zeile bei 15 Bildern je Sekunde unleserlich.
   * ====================================================================== */

  var tickerLetzte = 0, tickerText = '';

  function ticker(text, level, sofort) {
    var jetzt = performance.now();
    if (!sofort && text === tickerText) return;
    if (!sofort && jetzt - tickerLetzte < 400) return;
    tickerLetzte = jetzt;
    tickerText = text;
    var el = $('tickerText');
    el.textContent = text;
    el.classList.remove('wechsel');
    void el.offsetWidth;            // Neustart der Einblendung erzwingen
    el.classList.add('wechsel');
    $('tickerZeit').textContent = new Date().toLocaleTimeString('de-DE');
    var box = $('ticker');
    if (level) box.setAttribute('data-level', level); else box.removeAttribute('data-level');
  }

  function tickerLebt(an) { $('ticker').classList.toggle('is-live', !!an); }

  /** Kleine Verlaufskurve der Inferenzzeit - zeigt Einbrüche sofort. */
  var msVerlauf = [];
  function zeichneSpark(ms) {
    msVerlauf.push(ms);
    if (msVerlauf.length > 40) msVerlauf.shift();
    var c = $('msSpark');
    if (!c) return;
    var g = c.getContext('2d');
    var w = c.width, h = c.height;
    g.clearRect(0, 0, w, h);
    if (msVerlauf.length < 2) return;
    var max = Math.max.apply(null, msVerlauf) * 1.15 || 1;
    g.beginPath();
    msVerlauf.forEach(function (v, i) {
      var x = (i / (msVerlauf.length - 1)) * w;
      var y = h - (v / max) * (h - 3) - 1.5;
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
    });
    var letzte = msVerlauf[msVerlauf.length - 1];
    g.strokeStyle = letzte < 120 ? '#5CA97A' : letzte < 300 ? '#CC9C3D' : '#D05F52';
    g.lineWidth = 2;
    g.lineJoin = 'round';
    g.stroke();
  }

  function log(cat, text, detail) {
    var e = { t: Date.now(), cat: cat, text: text, detail: detail || null };
    S.log.unshift(e);
    if (S.log.length > 400) S.log.length = 400;
    renderLog();
    var stufe = cat === 'fehler' ? 'crit' : (cat === 'befund' ? 'warn' : null);
    ticker(text, stufe, true);
  }

  function zeit(ts) {
    var d = new Date(ts);
    return d.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'medium' });
  }

  function num(v, k) {
    return typeof v === 'number' && isFinite(v)
      ? v.toLocaleString('de-DE', { minimumFractionDigits: k, maximumFractionDigits: k })
      : '–';
  }

  function renderLog() {
    var list = $('logList');
    $('logCount').textContent = S.log.length + (S.log.length === 1 ? ' Eintrag' : ' Einträge');
    if (!S.log.length) { list.innerHTML = '<p class="empty">Noch keine Vorgänge aufgezeichnet.</p>'; return; }
    list.textContent = '';
    S.log.forEach(function (e) {
      var row = document.createElement('div');
      row.className = 'log-entry';
      row.innerHTML = '<span class="log-time"></span><span class="log-cat"></span>' +
                      '<span class="log-text"><span class="log-main"></span>' +
                      (e.detail ? '<span class="log-detail"></span>' : '') + '</span>';
      row.querySelector('.log-time').textContent = zeit(e.t);
      row.querySelector('.log-cat').textContent = e.cat;
      row.querySelector('.log-main').textContent = e.text;
      if (e.detail) row.querySelector('.log-detail').textContent = e.detail;
      list.appendChild(row);
    });
  }

  /* =============================================================== Reiter */

  function go(name) {
    var views = document.querySelectorAll('.view');
    for (var i = 0; i < views.length; i++) {
      views[i].classList.toggle('is-active', views[i].dataset.view === name);
    }
    var tabs = document.querySelectorAll('.tabbtn');
    for (var j = 0; j < tabs.length; j++) {
      var on = tabs[j].dataset.go === name;
      tabs[j].classList.toggle('is-active', on);
      if (on) tabs[j].setAttribute('aria-current', 'true');
      else tabs[j].removeAttribute('aria-current');
    }
    window.scrollTo(0, 0);
  }

  /* ========================================================== Erkennung */

  async function ladeModellDaten() {
    var r = await fetch('models/model.meta.json', { cache: 'force-cache' });
    if (!r.ok) throw new Error('model.meta.json nicht erreichbar (HTTP ' + r.status + ')');
    var m = await r.json();
    S.meta = m;
    var k = m.klassen || {};
    var max = -1;
    for (var key in k) if (+key > max) max = +key;
    S.labels = [];
    for (var i = 0; i <= max; i++) S.labels[i] = k[i] || ('Klasse ' + i);
    return m;
  }

  async function initDetector(modus) {
    if (!window.Detector) throw new Error('detector.js wurde nicht geladen.');
    if (!window.ort) throw new Error('ONNX Runtime wurde nicht geladen (CDN nicht erreichbar?).');
    var st = STUFEN[S.stufe] || STUFEN.ausgewogen;
    var m = modus === 'still' ? STILL_MODEL : { url: st.modell, size: st.size };
    var info = await window.Detector.init({
      modelUrl: m.url, labels: S.labels, inputSize: m.size,
      // Alles lokal: kein CDN, kein Netzverkehr waehrend der Analyse.
      ortUrl: 'vendor/ort.wasm.min.js',
      wasmPaths: 'vendor/',
      preferBackend: 'wasm',
      onProgress: function (p) { if (p && p.text) $('brandSub').textContent = p.text; }
    });
    S.detectorReady = true;
    S.detectorMode = modus;
    $('mBackend').textContent = info.backend;
    $('brandSub').textContent = 'v' + FASSUNG + ' · ' + info.backend.toUpperCase() +
      ' · ' + m.size + ' px · ' + S.labels.length + ' Klassen';
    log('modell', 'Modell geladen', m.url + ' · Backend ' + info.backend + ' · Ausgabe ' + JSON.stringify(info.outputShape));
    return info;
  }

  /* ============================================================== Kamera */

  async function startKamera() {
    var stufe = STUFEN[S.stufe] || STUFEN.ausgewogen;
    S.quelle = 'kamera';
    S.schirmNativ = false;
    $('liveStage').classList.remove('quelle-bildschirm');
    markiereQuelle();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('Diese Umgebung stellt keine Kamera bereit.');
      return;
    }
    stopKamera();
    try {
      // Die Erkennung skaliert ohnehin auf 320 px herunter. Ein 1280x720-Bild
      // je Frame zu puffern kostet auf dem Telefon ein Vielfaches an Speicher,
      // ohne einen einzigen Treffer mehr zu bringen.
      S.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: S.facing,
                 width: { ideal: stufe.breite }, height: { ideal: stufe.hoehe },
                 frameRate: { ideal: Math.round(1000 / stufe.takt) + 4, max: 30 } },
        audio: false
      });
    } catch (err) {
      var t = err && err.name === 'NotAllowedError'
        ? 'Kamerazugriff wurde abgelehnt. In den Systemeinstellungen für diese App freigeben.'
        : 'Kamera nicht verfügbar: ' + (err && err.message ? err.message : 'unbekannt');
      toast(t, 5000);
      log('kamera', 'Kamerastart fehlgeschlagen', t);
      return;
    }
    var v = $('cam');
    v.srcObject = S.stream;
    await v.play().catch(function () {});
    S.srcW = v.videoWidth; S.srcH = v.videoHeight;
    if (S.detectorMode === 'still') {
      try { await initDetector('live'); }
      catch (e) { log('fehler', 'Umschalten auf das schnelle Modell fehlgeschlagen', e.message); }
    }
    $('liveVeil').hidden = true;
    $('liveHud').hidden = false;
    $('pauseBtn').disabled = false;
    $('flipBtn').disabled = false;
    $('grabBtn').disabled = false;
    $('stopSrcBtn').disabled = false;
    S.running = true;
    starteVerfolgung();
    tickerLebt(true);
    log('kamera', 'Kamera gestartet', v.videoWidth + '×' + v.videoHeight + ' · ' +
      (S.facing === 'environment' ? 'Rückkamera' : 'Frontkamera'));
    schleife();
  }

  function stopKamera() {
    S.running = false;
    if (S.stream) { S.stream.getTracks().forEach(function (t) { t.stop(); }); S.stream = null; }
    // Spuren stoppen allein reicht nicht: solange srcObject gesetzt bleibt,
    // haelt das Videoelement seine Dekoder-Puffer fest.
    var v = $('cam');
    try { v.pause(); v.srcObject = null; v.removeAttribute('src'); v.load(); } catch (e) {}
  }

  /**
   * Zeichnet die Rahmen. Das Video wird mit object-fit:cover angezeigt, es ist
   * also beschnitten - ohne diese Umrechnung säßen alle Rahmen versetzt.
   */
  function zeichne(hits) {
    var c = $('overlay');
    var bw = c.clientWidth, bh = c.clientHeight;
    // Quellmasse kommen aus dem Zustand, nicht mehr fest vom Videoelement -
    // die Bildschirmquelle liefert gar kein Video.
    var sw = S.srcW, sh = S.srcH;
    if (!bw || !bh || !sw || !sh) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (c.width !== Math.round(bw * dpr)) { c.width = Math.round(bw * dpr); c.height = Math.round(bh * dpr); }
    var g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, bw, bh);

    // Kamera wird formatfuellend beschnitten (cover), der Bildschirm dagegen
    // vollstaendig eingepasst (contain) - sonst fehlen die Bildschirmraender.
    var s = S.quelle === 'bildschirm'
      ? Math.min(bw / sw, bh / sh)
      : Math.max(bw / sw, bh / sh);
    var offX = (bw - sw * s) / 2;
    var offY = (bh - sh * s) / 2;
    var spiegel = S.quelle === 'kamera' && S.facing === 'user';

    g.lineWidth = 2;
    g.font = '600 12px ui-monospace, monospace';
    g.textBaseline = 'top';
    hits.forEach(function (d) {
      var x = d.x * s + offX, y = d.y * s + offY, w = d.w * s, h = d.h * s;
      if (spiegel) x = bw - x - w;
      var farbe = 'hsl(' + ((d.classId * 47) % 360) + ' 70% 62%)';
      g.strokeStyle = farbe;
      g.strokeRect(x, y, w, h);
      var txt = d.label + '  ' + Math.round(d.score * 100) + '%';
      var tw = g.measureText(txt).width + 10;
      g.fillStyle = farbe;
      g.fillRect(x, Math.max(0, y - 17), tw, 17);
      g.fillStyle = '#06171E';
      g.fillText(txt, x + 5, Math.max(0, y - 17) + 3);
    });
  }

  /** Wendet den Klassenfilter an. null bedeutet: alles durchlassen. */
  function filtere(hits) {
    if (!S.filter || !S.filter.size) return hits;
    return hits.filter(function (d) { return S.filter.has(d.classId); });
  }

  var letzteListe = '';

  function renderHits(hits) {
    var box = $('hitsList');
    $('mHits').textContent = hits.length;
    // Der DOM-Neuaufbau ist der teuerste Teil je Bild. Er lohnt nur, wenn
    // sich an der Liste wirklich etwas geaendert hat.
    var kennung = hits.map(function (d) {
      return d.classId + ':' + Math.round(d.score * 20);
    }).sort().join(',');
    if (kennung === letzteListe) return;
    letzteListe = kennung;
    $('hitsNote').textContent = hits.length ? hits.length + ' im Bild' : '–';
    if (!hits.length) { box.innerHTML = '<p class="empty">Noch nichts erkannt.</p>'; return; }
    var zusammen = {};
    hits.forEach(function (d) {
      if (!zusammen[d.label] || zusammen[d.label].score < d.score) {
        zusammen[d.label] = { score: d.score, n: 0, classId: d.classId };
      }
      zusammen[d.label].n++;
    });
    var liste = Object.keys(zusammen).map(function (k) {
      return { label: k, score: zusammen[k].score, n: zusammen[k].n, classId: zusammen[k].classId };
    }).sort(function (a, b) { return b.score - a.score; });

    box.textContent = '';
    liste.forEach(function (e) {
      var row = document.createElement('div');
      row.className = 'hit';
      row.innerHTML = '<span class="hit-swatch"></span><span class="hit-name"></span>' +
        '<span class="hit-count"></span><span class="hit-bar"><i></i></span><span class="hit-score"></span>';
      row.querySelector('.hit-swatch').style.background = 'hsl(' + ((e.classId * 47) % 360) + ' 70% 62%)';
      row.querySelector('.hit-name').textContent = e.label;
      row.querySelector('.hit-count').textContent = e.n > 1 ? '×' + e.n : '';
      row.querySelector('.hit-bar i').style.width = Math.round(e.score * 100) + '%';
      row.querySelector('.hit-score').textContent = Math.round(e.score * 100) + '%';
      box.appendChild(row);
    });
  }

  /* Meldet die aktuelle Lage im Laufband und schreibt NEU aufgetauchte
   * Klassen ins Protokoll. Jedes Einzelbild zu protokollieren waere bei
   * 15 Bildern je Sekunde unbrauchbar - interessant ist die Veraenderung. */
  var zuletztGesehen = new Set();
  var gesehenSeit = {};

  function meldeLage(hits) {
    if (!hits.length) {
      ticker(S.quelle === 'bildschirm' ? 'Bildschirm — nichts erkannt' : 'Kamera — nichts erkannt');
      zuletztGesehen.forEach(function (n) { delete gesehenSeit[n]; });
      zuletztGesehen = new Set();
      return;
    }
    var zaehl = {};
    hits.forEach(function (d) { zaehl[d.label] = (zaehl[d.label] || 0) + 1; });
    var namen = Object.keys(zaehl).sort(function (a, b) { return zaehl[b] - zaehl[a]; });

    ticker(namen.slice(0, 4).map(function (n) {
      return zaehl[n] > 1 ? n + ' ×' + zaehl[n] : n;
    }).join(' · ') + (namen.length > 4 ? ' · +' + (namen.length - 4) : ''), 'ok');

    var jetzt = new Set(namen);
    var neue = namen.filter(function (n) { return !zuletztGesehen.has(n); });
    // Erst protokollieren, wenn eine Klasse ein paar Bilder lang stabil da ist -
    // sonst fuellt jeder Fehltreffer das Protokoll.
    neue.forEach(function (n) {
      gesehenSeit[n] = (gesehenSeit[n] || 0) + 1;
      if (gesehenSeit[n] === 3) {
        var best = hits.filter(function (d) { return d.label === n; })
          .reduce(function (a, b) { return b.score > a.score ? b : a; });
        log('erkennung', n + ' erkannt',
          Math.round(best.score * 100) + ' % · ' + zaehl[n] + '× im Bild · ' +
          (S.quelle === 'bildschirm' ? 'Bildschirm' : 'Kamera'));
      }
    });
    Object.keys(gesehenSeit).forEach(function (n) { if (!jetzt.has(n)) delete gesehenSeit[n]; });
    zuletztGesehen = jetzt;
  }

  // Mindestabstand zwischen zwei Erkennungen. Ohne Bremse laeuft die Schleife
  // so schnell wie das Geraet hergibt - das hebt den Dauerbedarf an Speicher
  // und Waerme, ohne dass ein Mensch den Unterschied sieht.
  var letzterLauf = 0;
  function taktMs() { return (STUFEN[S.stufe] || STUFEN.ausgewogen).takt; }

  /**
   * Naechsten Durchlauf planen.
   *
   * requestAnimationFrame feuert nicht mehr, sobald die Seite unsichtbar ist -
   * eine laufende Aufnahme waere damit sofort eingefroren. Im Hintergrund
   * uebernimmt deshalb setTimeout. Android drosselt das zwar, aber ein
   * Vordergrunddienst haelt die Drosselung in Grenzen, und ein paar Bilder
   * je Sekunde genuegen fuer eine Aufnahme.
   */
  function plane(fn) {
    if (document.hidden) setTimeout(fn, Math.max(taktMs(), 100));
    else requestAnimationFrame(fn);
  }

  async function schleife() {
    if (!S.running) return;
    var jetzt = performance.now();
    if (jetzt - letzterLauf < taktMs()) { plane(schleife); return; }
    letzterLauf = jetzt;
    if (S.detectorReady && !S.busy) {
      S.busy = true;
      var t0 = performance.now();
      try {
        var quelle = await holeBild();
        if (!quelle) { S.busy = false; plane(schleife); return; }
        if (S.quelle === 'bildschirm' && S.schirmNativ) zeigeSchirmbild(quelle);
        var roh = await window.Detector.detect(quelle, { conf: S.conf, iou: S.iou, maxDet: 60 });
        var hits = filtere(roh);
        S.lastHits = hits;

        // Verfolgung: macht aus Einzelbild-Treffern durchgehende Objekte.
        var verfolgt = { aktiv: [], neu: [], verloren: [] };
        if (tracker) {
          verfolgt = tracker.schritt(hits, Date.now());
          verfolgt.neu.forEach(function (sp) {
            ereignis('erschienen', sp.label + ' erschienen (#' + sp.id + ')',
              Math.round(sp.bestScore * 100) + ' %');
          });
          verfolgt.verloren.forEach(function (sp) {
            ereignis('verschwunden', sp.label + ' verschwunden (#' + sp.id + ')',
              ((sp.zuletzt - sp.zuerst) / 1000).toFixed(1) + ' s im Bild');
          });
          renderSpuren(verfolgt.aktiv);
        }
        aufnahmeSchritt(quelle, verfolgt.aktiv);

        zeichne(hits);
        renderHits(hits);
        var st = window.Detector.stats;
        $('mMs').textContent = st.lastInferenceMs + ' ms';
        zeichneSpark(st.lastInferenceMs);
        meldeLage(hits);
        S.fpsWindow.push(performance.now() - t0);
        if (S.fpsWindow.length > 12) S.fpsWindow.shift();
        var mittel = S.fpsWindow.reduce(function (a, b) { return a + b; }, 0) / S.fpsWindow.length;
        $('mFps').textContent = mittel > 0 ? (1000 / mittel).toFixed(1) : '–';
      } catch (err) {
        S.running = false;
        toast('Erkennung abgebrochen: ' + err.message, 6000);
        log('fehler', 'Erkennung abgebrochen', err.message);
      }
      S.busy = false;
    }
    plane(schleife);
  }

  /* ================================================== Bildschirm als Quelle
   *
   * Zwei Wege, weil es keinen gemeinsamen gibt:
   *   - Im Browser liefert getDisplayMedia einen Strom wie eine Kamera.
   *   - Android WebView kennt getDisplayMedia NICHT. Dort holt das native
   *     Plugin (MediaProjection) Einzelbilder als JPEG.
   *
   * Beide Wege enden in derselben Schleife; der Unterschied steckt allein
   * in holeBild().
   * ====================================================================== */

  function schirmPlugin() {
    var P = window.Capacitor && window.Capacitor.Plugins;
    return P && P.ScreenCapture ? P.ScreenCapture : null;
  }

  async function starteBildschirm() {
    stoppeQuelle();
    S.quelle = 'bildschirm';
    markiereQuelle();

    var p = schirmPlugin();
    if (p) {
      /* --- Android: natives Plugin --- */
      try {
        var r = await p.start({ maxWidth: 720, quality: 72 });
        S.srcW = r.width; S.srcH = r.height;
        S.schirmNativ = true;
        S.schirmAktiv = true;
        $('liveStage').classList.add('quelle-bildschirm');
        // Wird die Aufnahme über die Systemleiste beendet, muss die App das merken.
        p.removeAllListeners && p.removeAllListeners();
        p.addListener('screenCaptureStopped', function () {
          toast('Die Bildschirmaufnahme wurde beendet.');
          stoppeQuelle();
        });
        log('quelle', 'Bildschirmaufnahme gestartet', r.width + '×' + r.height + ' · nativ (MediaProjection)');
      } catch (err) {
        S.quelle = 'kamera'; markiereQuelle();
        var t = String(err && err.message || err);
        toast(/abgelehnt|denied|cancel/i.test(t)
          ? 'Die Bildschirmaufnahme wurde abgelehnt.'
          : 'Bildschirmaufnahme nicht möglich: ' + t, 5000);
        log('fehler', 'Bildschirmaufnahme fehlgeschlagen', t);
        return;
      }
    } else if (navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) {
      /* --- Browser --- */
      try {
        S.stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      } catch (err) {
        S.quelle = 'kamera'; markiereQuelle();
        toast('Bildschirmfreigabe abgelehnt oder nicht möglich.', 4000);
        return;
      }
      var v = $('cam');
      v.srcObject = S.stream;
      await v.play().catch(function () {});
      S.srcW = v.videoWidth; S.srcH = v.videoHeight;
      S.schirmNativ = false;
      S.schirmAktiv = true;
      // Beendet die Person die Freigabe im Browser, endet auch die Schleife.
      S.stream.getVideoTracks().forEach(function (t2) {
        t2.addEventListener('ended', function () { toast('Bildschirmfreigabe beendet.'); stoppeQuelle(); });
      });
      log('quelle', 'Bildschirmfreigabe gestartet', S.srcW + '×' + S.srcH + ' · getDisplayMedia');
    } else {
      S.quelle = 'kamera'; markiereQuelle();
      toast('Diese Umgebung bietet keine Bildschirmaufnahme an.', 5000);
      return;
    }

    $('liveVeil').hidden = true;
    $('liveHud').hidden = false;
    $('pauseBtn').disabled = false;
    $('grabBtn').disabled = false;
    $('stopSrcBtn').disabled = false;
    $('flipBtn').disabled = true;
    S.running = true;
    starteVerfolgung();
    tickerLebt(true);
    ticker('Bildschirmaufnahme läuft', null, true);
    schleife();
  }

  /** Holt ein Einzelbild vom nativen Plugin und macht ein ImageBitmap daraus. */
  async function nativesBild() {
    var p = schirmPlugin();
    if (!p) return null;
    var r = await p.grabFrame({ quality: 72 });
    if (!r || !r.frame) return null;                 // noch kein neues Bild
    var antwort = await fetch('data:image/jpeg;base64,' + r.frame);
    var blob = await antwort.blob();
    var bmp = await createImageBitmap(blob);
    // Vorheriges Bild freigeben, sonst wächst der Speicher mit jedem Frame.
    if (S.schirmBitmap && S.schirmBitmap.close) S.schirmBitmap.close();
    S.schirmBitmap = bmp;
    S.srcW = bmp.width; S.srcH = bmp.height;
    return bmp;
  }

  /** Liefert die aktuelle Bildquelle für Erkennung und Anzeige. */
  async function holeBild() {
    if (S.quelle === 'bildschirm' && S.schirmNativ) return await nativesBild();
    var v = $('cam');
    if (v.readyState < 2 || !v.videoWidth) return null;
    S.srcW = v.videoWidth; S.srcH = v.videoHeight;
    return v;
  }

  /** Zeigt ein nativ geholtes Bild an - das Videoelement bleibt hier leer. */
  function zeigeSchirmbild(bmp) {
    var c = $('screenView');
    if (c.width !== bmp.width) { c.width = bmp.width; c.height = bmp.height; }
    c.getContext('2d').drawImage(bmp, 0, 0);
  }

  function markiereQuelle() {
    document.querySelectorAll('#sourceSeg button').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.src === S.quelle);
    });
    var kamera = S.quelle === 'kamera';
    $('veilText').textContent = kamera
      ? 'Die Kamera ist noch nicht gestartet.'
      : 'Die Bildschirmaufnahme ist noch nicht gestartet.';
    $('startCamBtn').textContent = kamera ? 'Kamera starten' : 'Bildschirm aufnehmen';
    $('veilNote').textContent = kamera
      ? ''
      : 'Android fragt vorher um Zustimmung. Während der Aufnahme bleibt eine Benachrichtigung sichtbar.';
  }

  function stoppeQuelle() {
    if (rec.laeuft) beendeAufnahme();
    S.running = false;
    $('recBtn').disabled = true;
    tickerLebt(false);
    ticker('Quelle beendet', null, true);
    msVerlauf = [];
    zuletztGesehen = new Set();
    gesehenSeit = {};
    S.schirmAktiv = false;
    if (S.stream) { S.stream.getTracks().forEach(function (t) { t.stop(); }); S.stream = null; }
    var p = schirmPlugin();
    if (p && S.schirmNativ) { try { p.stop(); } catch (e) {} }
    if (S.schirmBitmap && S.schirmBitmap.close) { S.schirmBitmap.close(); S.schirmBitmap = null; }
    S.schirmNativ = false;
    var vv = $('cam');
    try { vv.pause(); vv.srcObject = null; vv.removeAttribute('src'); vv.load(); } catch (e) {}
    // Overlay-Leinwand auf null schrumpfen: gibt ihren Bildspeicher sofort frei.
    var ov = $('overlay'), sv = $('screenView');
    try { ov.width = 0; ov.height = 0; sv.width = 0; sv.height = 0; } catch (e) {}
    letzteListe = '';
    $('liveStage').classList.remove('quelle-bildschirm');
    $('liveVeil').hidden = false;
    $('liveHud').hidden = true;
    ['pauseBtn', 'flipBtn', 'grabBtn', 'stopSrcBtn'].forEach(function (id) { $(id).disabled = true; });
    var o = $('overlay').getContext('2d');
    o.clearRect(0, 0, $('overlay').width, $('overlay').height);
  }

  /* ============================================================ Analyse */

  /* ================================================ Darstellung der Analyse
   * Reihenfolge beim Zeichnen:
   *   1. Original
   *   2. gewählte Ebene, auf die rechte Seite des Wischreglers beschnitten
   *   3. Darstellungsfilter über das Ganze
   *   4. Erkennungsrahmen
   * ====================================================================== */

  var FILTER = [
    ['keine',    'Original'],
    ['grau',     'Graustufen'],
    ['r',        'nur Rot'],
    ['g',        'nur Grün'],
    ['b',        'nur Blau'],
    ['kontrast', 'Kontrast gespreizt'],
    ['invers',   'Invertiert']
  ];

  /**
   * Wendet einen Darstellungsfilter auf die Leinwand an.
   * Kontrastspreizung normiert auf das tatsächlich belegte Werteintervall -
   * dadurch werden Unterschiede sichtbar, die im Original zu flach liegen.
   */
  function wendeFilterAn(g, w, h) {
    if (S.darstellung === 'keine') return;
    var img;
    try { img = g.getImageData(0, 0, w, h); } catch (e) { return; }
    var d = img.data, i;

    if (S.darstellung === 'kontrast') {
      var min = 255, max = 0;
      for (i = 0; i < d.length; i += 4) {
        var l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        if (l < min) min = l;
        if (l > max) max = l;
      }
      var spanne = Math.max(1, max - min);
      for (i = 0; i < d.length; i += 4) {
        d[i]     = (d[i] - min) / spanne * 255;
        d[i + 1] = (d[i + 1] - min) / spanne * 255;
        d[i + 2] = (d[i + 2] - min) / spanne * 255;
      }
    } else {
      for (i = 0; i < d.length; i += 4) {
        var r = d[i], gr = d[i + 1], b = d[i + 2];
        switch (S.darstellung) {
          case 'grau':   var y = 0.299 * r + 0.587 * gr + 0.114 * b;
                         d[i] = d[i + 1] = d[i + 2] = y; break;
          case 'r':      d[i + 1] = d[i + 2] = 0; break;
          case 'g':      d[i] = d[i + 2] = 0; break;
          case 'b':      d[i] = d[i + 1] = 0; break;
          case 'invers': d[i] = 255 - r; d[i + 1] = 255 - gr; d[i + 2] = 255 - b; break;
        }
      }
    }
    g.putImageData(img, 0, 0);
  }

  function zeichneLayer() {
    var c = $('analyseCanvas');
    if (!S.bitmap) return;
    var W = S.bitmap.width, H = S.bitmap.height;
    var data = S.layers[S.layer];

    // Ebenen können kleiner sein als das Original (Arbeitsauflösung).
    if (data && S.layer !== 'original') { W = data.width; H = data.height; }
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    var g = c.getContext('2d', { willReadFrequently: true });
    g.clearRect(0, 0, W, H);

    // 1. Original als Grundlage
    g.drawImage(S.bitmap, 0, 0, W, H);

    // 2. Ebene, auf die rechte Seite beschnitten
    if (data && S.layer !== 'original') {
      var grenze = Math.round(W * S.wisch);
      if (grenze > 0) {
        var tmp = document.createElement('canvas');
        tmp.width = data.width; tmp.height = data.height;
        tmp.getContext('2d').putImageData(data, 0, 0);
        g.save();
        g.beginPath();
        g.rect(W - grenze, 0, grenze, H);
        g.clip();
        g.drawImage(tmp, 0, 0, W, H);
        g.restore();
        if (S.wisch < 1) {
          g.strokeStyle = 'rgba(111,194,222,.9)';
          g.lineWidth = Math.max(1, W / 600);
          g.beginPath(); g.moveTo(W - grenze, 0); g.lineTo(W - grenze, H); g.stroke();
        }
      }
    }

    // 3. Darstellungsfilter
    wendeFilterAn(g, W, H);

    // 4. Erkennungsrahmen - nur wenn die Ebene das Originalbild zeigt
    if (S.lastHits.length && S.layer === 'original') {
      var f = W / S.bitmap.width;
      g.lineWidth = Math.max(2, W / 400);
      g.font = '600 ' + Math.max(12, W / 45) + 'px ui-monospace, monospace';
      g.textBaseline = 'top';
      S.lastHits.forEach(function (d2) {
        var farbe = 'hsl(' + ((d2.classId * 47) % 360) + ' 70% 62%)';
        g.strokeStyle = farbe;
        g.strokeRect(d2.x * f, d2.y * f, d2.w * f, d2.h * f);
        g.fillStyle = farbe;
        var txt = d2.label + ' ' + Math.round(d2.score * 100) + '%';
        var hh = Math.max(16, W / 38);
        g.fillRect(d2.x * f, Math.max(0, d2.y * f - hh), g.measureText(txt).width + 12, hh);
        g.fillStyle = '#06171E';
        g.fillText(txt, d2.x * f + 6, Math.max(0, d2.y * f - hh) + 2);
      });
    }

    var hinweis = {
      original: '',
      ela: 'Helle Bereiche wurden anders komprimiert als ihre Umgebung.',
      noise: 'Dunkle, glatte Zonen deuten auf Weichzeichnung oder Retusche.',
      copymove: 'Rot markierte Blöcke gleichen weit entfernten Blöcken.',
      blockraster: 'Rot markierte Kacheln haben ein anders ausgerichtetes 8×8-Raster als das Gesamtbild.',
      ghosts: 'Farbe je Kachel nach der Qualitätsstufe, bei der ihre Differenz einbricht.'
    };
    $('segNote').textContent = hinweis[S.layer] || '';
    $('wischBox').hidden = (S.layer === 'original');
    $('analyseScale').hidden = true;
  }

  /* ------------------------------------------------ Bildpunkt ablesen */

  function rgbZuHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
  }

  function leseBildpunkt(clientX, clientY) {
    var c = $('analyseCanvas');
    if (!S.bitmap || !c.width) return;
    var r = c.getBoundingClientRect();
    if (!r.width || !r.height) return;
    // Das Rechteck enthält Zoom und Verschiebung bereits - deshalb genügt
    // der Dreisatz und es braucht keine eigene Umrechnung der Transformation.
    var x = Math.floor((clientX - r.left) / r.width * c.width);
    var y = Math.floor((clientY - r.top) / r.height * c.height);
    if (x < 0 || y < 0 || x >= c.width || y >= c.height) return;

    var p;
    try { p = c.getContext('2d', { willReadFrequently: true }).getImageData(x, y, 1, 1).data; }
    catch (e) { return; }

    var hex = '#' + [p[0], p[1], p[2]].map(function (v) {
      return v.toString(16).padStart(2, '0');
    }).join('').toUpperCase();
    var hsl = rgbZuHsl(p[0], p[1], p[2]);
    // Auf das Originalbild zurückrechnen, falls die Ebene kleiner ist.
    var ox = Math.round(x / c.width * S.bitmap.width);
    var oy = Math.round(y / c.height * S.bitmap.height);

    S.pixel = { x: ox, y: oy, r: p[0], g: p[1], b: p[2], hex: hex, hsl: hsl };
    $('pixelBox').hidden = false;
    $('pixelSwatch').style.background = hex;
    $('pixelWerte').innerHTML =
      '<b>' + hex + '</b>  ·  RGB ' + p[0] + ', ' + p[1] + ', ' + p[2] + '<br>' +
      'HSL ' + hsl[0] + '°, ' + hsl[1] + ' %, ' + hsl[2] + ' %  ·  Punkt ' + ox + ', ' + oy;
  }

  function sichereAnsicht() {
    var c = $('analyseCanvas');
    if (!c.width) return;
    c.toBlob(function (b) {
      if (!b) { toast('Ansicht konnte nicht gesichert werden.'); return; }
      var name = (S.bericht && S.bericht.dateiname || 'bild').replace(/\.[^.]+$/, '');
      sichereDatei(b, 'ansicht-' + name + '-' + S.layer +
        (S.darstellung !== 'keine' ? '-' + S.darstellung : '') + '.png', 'Ansicht');
    }, 'image/png');
  }

  function baueFilterChips() {
    var box = $('filterChips');
    box.textContent = '';
    FILTER.forEach(function (f) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (S.darstellung === f[0] ? ' is-on' : '');
      b.textContent = f[1];
      b.addEventListener('click', function () {
        S.darstellung = f[0];
        baueFilterChips();
        zeichneLayer();
      });
      box.appendChild(b);
    });
  }

  async function analysiere(datei) {
    if (!window.Forensics) { toast('forensics.js wurde nicht geladen.'); return; }
    S.bild = datei;
    S.lastHits = [];
    // Den Reiter selbst setzen, statt sich auf den Aufrufer zu verlassen:
    // sonst hat die Leinwand keine Ausmaße und alles, was von ihrer Größe
    // abhängt - Bildpunkt ablesen, Zoom - greift ins Leere.
    go('analyse');
    $('analyseVeil').hidden = true;
    $('analyseProgress').hidden = false;
    var bar = $('analyseProgressBar');
    bar.style.width = '5%';

    log('analyse', 'Analyse gestartet', (datei.name || 'Kamerabild') + ' · ' + datei.type);

    try { S.bitmap = await createImageBitmap(datei); }
    catch (e) { toast('Bild konnte nicht dekodiert werden.'); $('analyseProgress').hidden = true; return; }

    S.layers = { original: null };
    S.ghosts = null;
    $('ghostPanel').hidden = true;
    document.querySelectorAll('#viewSeg button[data-layer="ghosts"]').forEach(function (b) { b.disabled = true; });
    S.layer = 'original';
    zoomZurueck();
    $('zoomBar').hidden = false;
    $('ansichtPanel').hidden = false;
    $('annotBtn').disabled = false;
    $('pixelBox').hidden = true;
    S.pixel = null;
    S.wisch = 1; $('wischRange').value = 100; $('wischVal').textContent = '100 %';
    S.darstellung = 'keine'; baueFilterChips();
    zeichneLayer();
    document.querySelectorAll('#viewSeg button').forEach(function (b) { b.disabled = false; });
    $('reanalyseBtn').disabled = false;
    $('detectStillBtn').disabled = false;

    var bericht = await window.Forensics.report(datei, {
      onProgress: function (phase, v) { bar.style.width = Math.round((v || 0) * 100) + '%'; }
    });

    /* --- Prüfsummen --- */
    $('hashPanel').hidden = false;
    $('fileLine').textContent = datei.name || 'Kamerabild';
    $('fileSize').textContent = (bericht.hash.bytes / 1024).toFixed(1).replace('.', ',') + ' KB';
    $('hashes').textContent = '';
    [['SHA-256', bericht.hash.sha256], ['SHA-1', bericht.hash.sha1]].forEach(function (p) {
      var d = document.createElement('div');
      d.className = 'hash';
      d.innerHTML = '<div class="hash-head"><span class="hash-algo"></span>' +
        '<button class="btn btn--ghost btn--sm" type="button">kopieren</button></div>' +
        '<code class="hash-value"></code>';
      d.querySelector('.hash-algo').textContent = p[0];
      d.querySelector('.hash-value').textContent = p[1];
      d.querySelector('button').addEventListener('click', function () {
        kopiere(p[1]); toast(p[0] + ' kopiert.');
      });
      $('hashes').appendChild(d);
    });
    log('integritaet', 'Prüfsumme berechnet', 'SHA-256 ' + bericht.hash.sha256);

    /* --- Ebenen --- */
    if (bericht.ela && bericht.ela.imageData) S.layers.ela = bericht.ela.imageData;
    if (bericht.rauschen && bericht.rauschen.imageData) S.layers.noise = bericht.rauschen.imageData;
    if (bericht.copyMove && bericht.copyMove.imageData) S.layers.copymove = bericht.copyMove.imageData;
    if (bericht.blockraster && bericht.blockraster.imageData) S.layers.blockraster = bericht.blockraster.imageData;
    // Die Ghost-Ebene entsteht erst auf Anforderung - sie kostet rund
    // 25 Neukodierungen und soll die normale Analyse nicht ausbremsen.
    $('ghostBtn').disabled = false;

    /* --- Befunde --- */
    var f = bericht.metadaten.findings || [];
    $('findingsPanel').hidden = false;
    $('findingsNote').textContent = f.length + (f.length === 1 ? ' Befund' : ' Befunde');
    $('findingsList').textContent = '';
    f.forEach(function (x) {
      var lvl = x.level === 'alarm' ? 'crit' : x.level;
      var d = document.createElement('div');
      d.className = 'finding';
      d.setAttribute('data-level', lvl);
      d.innerHTML = '<span class="finding-mark"></span><span class="finding-text"></span>';
      d.querySelector('.finding-text').textContent = x.text;
      $('findingsList').appendChild(d);
      log('befund', x.text.slice(0, 80) + (x.text.length > 80 ? '…' : ''), 'Stufe: ' + x.level);
    });

    /* --- Metadaten --- */
    var tags = bericht.metadaten.tags || {};
    var keys = Object.keys(tags);
    $('metaPanel').hidden = false;
    $('metaNote').textContent = keys.length ? keys.length + ' Felder' : 'keine';
    $('metaTable').textContent = '';
    if (bericht.metadaten.gps) {
      keys.unshift('__gps');
      tags.__gps = num(bericht.metadaten.gps.lat, 5) + ', ' + num(bericht.metadaten.gps.lon, 5);
    }
    keys.forEach(function (k) {
      var row = document.createElement('div');
      row.className = 'clip-row';
      row.innerHTML = '<span class="clip-label"></span><span class="clip-value"></span>';
      row.querySelector('.clip-label').textContent = k === '__gps' ? 'Standort' : k;
      row.querySelector('.clip-value').textContent = tags[k];
      $('metaTable').appendChild(row);
    });
    if (!keys.length) $('metaTable').innerHTML = '<p class="empty">Keine Metadaten gefunden.</p>';

    /* --- Wahrnehmungs-Prüfsummen --- */
    S.bericht = bericht;
    zeigePHashes(bericht.perzeptuell);
    $('reportBtn').disabled = false;
    $('compareResult').textContent = '';
    if (bericht.perzeptuell && bericht.perzeptuell.pHash) {
      log('integritaet', 'Wahrnehmungs-Prüfsumme berechnet', 'pHash ' + bericht.perzeptuell.pHash);
    }

    /* --- Histogramm --- */
    if (bericht.histogramm) { $('histPanel').hidden = false; zeichneHistogramm(bericht.histogramm); }

    bar.style.width = '100%';
    setTimeout(function () { $('analyseProgress').hidden = true; }, 350);
    log('analyse', 'Analyse abgeschlossen',
      'ELA-Mittel ' + num(bericht.ela && bericht.ela.meanError, 2) +
      ' · Rausch-Gleichmäßigkeit ' + num(bericht.rauschen && bericht.rauschen.uniformity, 2) +
      ' · verdächtige Blöcke ' + ((bericht.copyMove && bericht.copyMove.suspectBlocks) || 0));
  }

  function zeichneHistogramm(h) {
    var c = $('histCanvas');
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = c.clientWidth || 300;
    c.width = w * dpr; c.height = 150 * dpr;
    var g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, 150);
    var max = 0;
    for (var i = 0; i < 256; i++) max = Math.max(max, h.r[i], h.g[i], h.b[i]);
    if (!max) return;
    [['r', 'rgba(208,95,82,.72)'], ['g', 'rgba(92,169,122,.72)'], ['b', 'rgba(70,168,201,.72)']]
      .forEach(function (p) {
        g.beginPath(); g.moveTo(0, 150);
        for (var x = 0; x < 256; x++) g.lineTo(x / 255 * w, 150 - (h[p[0]][x] / max) * 142);
        g.lineTo(w, 150); g.closePath(); g.fillStyle = p[1]; g.fill();
      });
    $('histLegend').textContent =
      'Tiefen beschnitten: ' + num(h.clippedLowPct, 2) + ' %  ·  Lichter beschnitten: ' + num(h.clippedHighPct, 2) + ' %';
  }

  function kopiere(text) {
    if (navigator.clipboard) { navigator.clipboard.writeText(text).catch(function () { fallbackKopie(text); }); }
    else fallbackKopie(text);
  }
  function fallbackKopie(t) {
    var a = document.createElement('textarea');
    a.value = t; document.body.appendChild(a); a.select();
    try { document.execCommand('copy'); } catch (e) {}
    a.remove();
  }

  /* ====================================================== Dateien sichern
   *
   * Ein <a download> loest in einer Android-WebView KEINEN Dateidialog aus -
   * der Klick verpufft, ohne Fehlermeldung. Genau daran sind hier saemtliche
   * Ausgaben still gescheitert: Video, Zeitleiste, Bericht, Protokoll,
   * Ansicht. Auf Android wird deshalb ueber das Dateisystem-Plugin in die
   * Dokumente geschrieben und der Pfad genannt; im Browser bleibt der
   * gewohnte Weg.
   * ====================================================================== */

  function dateiPlugin() {
    var P = window.Capacitor && window.Capacitor.Plugins;
    return (P && P.Filesystem) ? P.Filesystem : null;
  }

  /** Blob -> base64 ohne den Kopf "data:...;base64,". */
  function alsBase64(blob) {
    return new Promise(function (aufloesen, ablehnen) {
      var r = new FileReader();
      // readAsDataURL verarbeitet auch grosse Blobs am Stueck - eine eigene
      // Schleife ueber Bloecke wuerde bei Videos den Stapel sprengen.
      r.onload = function () {
        var s2 = String(r.result);
        var k = s2.indexOf(',');
        aufloesen(k >= 0 ? s2.slice(k + 1) : s2);
      };
      r.onerror = function () { ablehnen(new Error('Datei konnte nicht gelesen werden.')); };
      r.readAsDataURL(blob);
    });
  }

  /**
   * Sichert einen Blob unter dem gewünschten Namen.
   * @returns {Promise<{ok:boolean, pfad:string|null, fehler:string|null}>}
   */
  async function sichereDatei(blob, name, zweck) {
    var fs = dateiPlugin();
    if (!fs) {
      // Browser: der gewohnte Weg funktioniert hier.
      try {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 8000);
        return { ok: true, pfad: name, fehler: null };
      } catch (e) {
        return { ok: false, pfad: null, fehler: e.message };
      }
    }

    toast('Sichere ' + (zweck || 'Datei') + ' …', 20000);
    try {
      var daten = await alsBase64(blob);
      var ordner = 'ForensikVision';
      var erg = await fs.writeFile({
        path: ordner + '/' + name,
        data: daten,
        directory: 'DOCUMENTS',
        recursive: true
      });
      var pfad = (erg && erg.uri) ? decodeURIComponent(String(erg.uri).replace(/^file:\/\//, ''))
                                  : 'Dokumente/' + ordner + '/' + name;
      toast('Gesichert: Dokumente/' + ordner + '/' + name, 6000);
      log('export', (zweck || 'Datei') + ' gesichert', pfad);
      return { ok: true, pfad: pfad, fehler: null };
    } catch (e) {
      var m = (e && e.message) ? e.message : String(e);
      toast('Sichern fehlgeschlagen: ' + m, 7000);
      log('fehler', 'Sichern fehlgeschlagen', m);
      return { ok: false, pfad: null, fehler: m };
    }
  }

  // Fuer den Browsertest erreichbar machen.
  window.__sichereDatei = sichereDatei;

  function berichtText() {
    var z = ['FORENSIK VISION — VORGANGSPROTOKOLL',
             'Erstellt: ' + zeit(Date.now()), 'Einträge: ' + S.log.length, ''];
    S.log.slice().reverse().forEach(function (e) {
      z.push('[' + zeit(e.t) + '] ' + e.cat.toUpperCase() + ': ' + e.text);
      if (e.detail) z.push('    ' + e.detail);
    });
    return z.join('\n');
  }

  /* ========================================= Zoom und Verschieben (Analyse)
   * Forensische Betrachtung ohne Lupe ist sinnlos: ELA-Spuren und
   * Rauschunterschiede zeigen sich erst in der Vergrößerung.
   * ====================================================================== */

  var ZOOM_MIN = 1, ZOOM_MAX = 16;

  function wendeZoomAn() {
    var c = $('analyseCanvas'), stage = $('analyseStage');
    if (!c) return;
    // Verschiebung so begrenzen, dass das Bild nie ganz aus dem Rahmen wandert.
    var bw = stage.clientWidth, bh = stage.clientHeight;
    var maxX = Math.max(0, bw * (S.zoom - 1));
    var maxY = Math.max(0, bh * (S.zoom - 1));
    S.panX = Math.min(0, Math.max(-maxX, S.panX));
    S.panY = Math.min(0, Math.max(-maxY, S.panY));
    c.style.transform = 'translate(' + S.panX + 'px,' + S.panY + 'px) scale(' + S.zoom + ')';
    $('zoomLevel').textContent = Math.round(S.zoom * 100) + ' %';
    stage.classList.toggle('is-zoomed', S.zoom > 1);
  }

  /** Zoomt um einen Punkt herum, damit der Punkt unter dem Finger bleibt. */
  function zoomeUm(faktor, px, py) {
    var alt = S.zoom;
    S.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, S.zoom * faktor));
    if (S.zoom === alt) return;
    var v = S.zoom / alt;
    S.panX = px - (px - S.panX) * v;
    S.panY = py - (py - S.panY) * v;
    if (S.zoom === 1) { S.panX = 0; S.panY = 0; }
    wendeZoomAn();
  }

  function zoomZurueck() { S.zoom = 1; S.panX = 0; S.panY = 0; wendeZoomAn(); }

  function verdrahteZoom() {
    var stage = $('analyseStage');
    var zeiger = new Map();
    var startAbstand = 0, startZoom = 1, letzterX = 0, letzterY = 0;

    function lokal(e) {
      var r = stage.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    var tippStart = null, gezogen = false;

    stage.addEventListener('pointerdown', function (e) {
      if (!S.bitmap) return;
      // Zustand ZUERST setzen: setPointerCapture wirft bei ungültiger
      // Zeiger-ID, und danach liefe der Rest dieses Griffs nicht mehr -
      // dann ginge weder Verschieben noch das Ablesen eines Bildpunkts.
      tippStart = { x: e.clientX, y: e.clientY };
      gezogen = false;
      zeiger.set(e.pointerId, lokal(e));
      try { stage.setPointerCapture(e.pointerId); } catch (err) { /* nicht kritisch */ }
      if (zeiger.size === 2) {
        var p = Array.from(zeiger.values());
        startAbstand = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
        startZoom = S.zoom;
      } else {
        var l = lokal(e); letzterX = l.x; letzterY = l.y;
        stage.classList.add('is-panning');
      }
    });

    stage.addEventListener('pointermove', function (e) {
      if (!zeiger.has(e.pointerId)) return;
      // Ein paar Pixel Wackeln beim Antippen sind normal und dürfen nicht
      // als Verschieben gelten - sonst wäre das Ablesen unbenutzbar.
      if (tippStart && (Math.abs(e.clientX - tippStart.x) > 6 ||
                        Math.abs(e.clientY - tippStart.y) > 6)) gezogen = true;
      zeiger.set(e.pointerId, lokal(e));
      if (zeiger.size === 2 && startAbstand > 0) {
        var p = Array.from(zeiger.values());
        var abstand = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
        var mitteX = (p[0].x + p[1].x) / 2, mitteY = (p[0].y + p[1].y) / 2;
        var ziel = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, startZoom * (abstand / startAbstand)));
        zoomeUm(ziel / S.zoom, mitteX, mitteY);
      } else if (zeiger.size === 1 && S.zoom > 1) {
        var l = lokal(e);
        S.panX += l.x - letzterX; S.panY += l.y - letzterY;
        letzterX = l.x; letzterY = l.y;
        wendeZoomAn();
      }
    });

    function ende(e) {
      var warEinzeln = zeiger.size === 1;
      zeiger.delete(e.pointerId);
      if (zeiger.size < 2) startAbstand = 0;
      if (!zeiger.size) stage.classList.remove('is-panning');
      if (warEinzeln && !gezogen && tippStart) leseBildpunkt(e.clientX, e.clientY);
      tippStart = null;
    }
    stage.addEventListener('pointerup', ende);
    stage.addEventListener('pointercancel', ende);

    stage.addEventListener('wheel', function (e) {
      if (!S.bitmap) return;
      e.preventDefault();
      var l = lokal(e);
      zoomeUm(e.deltaY < 0 ? 1.18 : 1 / 1.18, l.x, l.y);
    }, { passive: false });

    stage.addEventListener('dblclick', function (e) {
      if (!S.bitmap) return;
      if (S.zoom > 1) zoomZurueck();
      else { var l = lokal(e); zoomeUm(4, l.x, l.y); }
    });

    $('zoomIn').addEventListener('click', function () {
      var r = stage.getBoundingClientRect(); zoomeUm(1.5, r.width / 2, r.height / 2);
    });
    $('zoomOut').addEventListener('click', function () {
      var r = stage.getBoundingClientRect(); zoomeUm(1 / 1.5, r.width / 2, r.height / 2);
    });
    $('zoomReset').addEventListener('click', zoomZurueck);
  }

  /* ================================================== Klassenfilter (Live) */

  function baueKlassenChips(suche) {
    var box = $('classChips');
    box.textContent = '';
    var q = (suche || '').trim().toLowerCase();
    var treffer = 0;
    S.labels.forEach(function (name, id) {
      if (q && name.toLowerCase().indexOf(q) === -1) return;
      if (treffer++ > 90) return;
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (S.filter && S.filter.has(id) ? ' is-on' : '');
      b.textContent = name;
      b.addEventListener('click', function () {
        if (!S.filter) S.filter = new Set();
        if (S.filter.has(id)) S.filter.delete(id); else S.filter.add(id);
        if (!S.filter.size) S.filter = null;
        baueKlassenChips($('classSearch').value);
        aktualisiereFilterHinweis();
      });
      box.appendChild(b);
    });
    if (!treffer) box.innerHTML = '<p class="empty">Keine Klasse passt zur Suche.</p>';
  }

  function aktualisiereFilterHinweis() {
    $('filterNote').textContent = S.filter && S.filter.size
      ? S.filter.size + (S.filter.size === 1 ? ' Klasse' : ' Klassen')
      : 'alle';
  }

  /* ================================================ Bildvergleich (pHash) */

  function zeigePHashes(p) {
    if (!p || p.error) { $('phashPanel').hidden = true; return; }
    $('phashPanel').hidden = false;
    $('phashTable').textContent = '';
    [['Mittelwert (aHash)', p.aHash], ['Differenz (dHash)', p.dHash], ['Wahrnehmung (pHash)', p.pHash]]
      .forEach(function (e) {
        if (!e[1]) return;
        var r = document.createElement('div');
        r.className = 'clip-row';
        r.innerHTML = '<span class="clip-label"></span><span class="clip-value"></span>';
        r.querySelector('.clip-label').textContent = e[0];
        r.querySelector('.clip-value').textContent = e[1];
        $('phashTable').appendChild(r);
      });
    $('compareBtn').disabled = false;
  }

  async function vergleicheMit(datei) {
    if (!S.bericht || !S.bericht.perzeptuell) return;
    var box = $('compareResult');
    box.innerHTML = '<p class="empty">vergleiche …</p>';
    var bmp;
    try { bmp = await createImageBitmap(datei); }
    catch (e) { box.innerHTML = '<p class="empty">Bild konnte nicht gelesen werden.</p>'; return; }

    var b = await window.Forensics.perceptualHashes(bmp);
    var h = await window.Forensics.hash(datei);
    var a = S.bericht.perzeptuell;
    if (bmp.close) bmp.close();

    // pHash hat 64 Bit. Der Abstand sagt, wie stark sich die Bildinhalte
    // unterscheiden - nicht, wie stark sich die Dateien unterscheiden.
    var dP = window.Forensics.hammingDistance(a.pHash, b.pHash);
    var dD = window.Forensics.hammingDistance(a.dHash, b.dHash);
    var dA = window.Forensics.hammingDistance(a.aHash, b.aHash);
    var gleicheDatei = h.sha256 === S.bericht.hash.sha256;

    box.textContent = '';
    [['Dateiname', datei.name || 'unbenannt'],
     ['SHA-256 identisch', gleicheDatei ? 'ja' : 'nein'],
     ['pHash-Abstand', dP + ' von 64 Bit'],
     ['dHash-Abstand', dD + ' von 64 Bit'],
     ['aHash-Abstand', dA + ' von 64 Bit']].forEach(function (e) {
      var r = document.createElement('div');
      r.className = 'cmp-row';
      r.innerHTML = '<span class="clip-label"></span><span class="clip-value"></span>';
      r.querySelector('.clip-label').textContent = e[0];
      r.querySelector('.clip-value').textContent = e[1];
      box.appendChild(r);
    });

    var urteil = document.createElement('div');
    urteil.className = 'cmp-verdict';
    if (gleicheDatei) {
      urteil.setAttribute('data-level', 'ok');
      urteil.textContent = 'Bit-identische Datei. Die Prüfsummen stimmen überein.';
    } else if (dP >= 0 && dP <= 6) {
      urteil.setAttribute('data-level', 'warn');
      urteil.textContent = 'Sehr ähnliches Bild bei unterschiedlicher Datei. Typisch für dasselbe ' +
        'Motiv nach Skalierung, erneuter Kompression oder leichter Bearbeitung. Das ist ein starker ' +
        'Hinweis auf gemeinsame Herkunft, kein Beweis.';
    } else if (dP >= 0 && dP <= 14) {
      urteil.setAttribute('data-level', 'warn');
      urteil.textContent = 'Teilweise ähnlich. Möglich bei stärkerer Bearbeitung oder Ausschnitt ' +
        'desselben Motivs, aber auch bei zufällig ähnlichem Bildaufbau.';
    } else {
      urteil.setAttribute('data-level', 'crit');
      urteil.textContent = 'Deutlich verschiedene Bildinhalte.';
    }
    box.appendChild(urteil);

    log('vergleich', 'Bildvergleich durchgeführt',
      (datei.name || 'unbenannt') + ' · pHash-Abstand ' + dP + '/64 · SHA-256 ' +
      (gleicheDatei ? 'identisch' : 'verschieden'));
  }

  /* ========================================================= Berichtsexport
   * Erzeugt eine eigenständige HTML-Datei: alle Befunde, Prüfsummen,
   * Metadaten und die Analysebilder eingebettet. Sie lässt sich archivieren,
   * weitergeben und im Browser zu PDF drucken - ohne diese App.
   * ====================================================================== */

  function datenUrlVon(imageData, maxBreite) {
    if (!imageData) return null;
    var c = document.createElement('canvas');
    var f = Math.min(1, (maxBreite || 900) / imageData.width);
    c.width = Math.round(imageData.width * f);
    c.height = Math.round(imageData.height * f);
    var tmp = document.createElement('canvas');
    tmp.width = imageData.width; tmp.height = imageData.height;
    tmp.getContext('2d').putImageData(imageData, 0, 0);
    c.getContext('2d').drawImage(tmp, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.82);
  }

  function esc(t) {
    return String(t == null ? '' : t)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function baueBericht() {
    var b = S.bericht;
    if (!b) return '';
    var m = b.metadaten || {};
    var bilder = [];
    if (S.bitmap) {
      var c = document.createElement('canvas');
      var f = Math.min(1, 900 / S.bitmap.width);
      c.width = Math.round(S.bitmap.width * f); c.height = Math.round(S.bitmap.height * f);
      c.getContext('2d').drawImage(S.bitmap, 0, 0, c.width, c.height);
      bilder.push(['Original', c.toDataURL('image/jpeg', 0.82)]);
    }
    if (S.layers.ela) bilder.push(['Fehlerniveau (ELA)', datenUrlVon(S.layers.ela)]);
    if (S.layers.noise) bilder.push(['Rauschrest', datenUrlVon(S.layers.noise)]);
    if (S.layers.copymove) bilder.push(['Copy-Move-Hinweis', datenUrlVon(S.layers.copymove)]);
    if (S.layers.blockraster) bilder.push(['Blockraster', datenUrlVon(S.layers.blockraster)]);
    if (S.layers.ghosts) bilder.push(['JPEG-Ghosts', datenUrlVon(S.layers.ghosts)]);

    var zeilen = Object.keys(m.tags || {}).map(function (k) {
      return '<tr><th>' + esc(k) + '</th><td>' + esc(m.tags[k]) + '</td></tr>';
    }).join('');

    var befunde = (m.findings || []).map(function (f2) {
      var stufe = f2.level === 'alarm' ? 'crit' : f2.level;
      return '<li class="f f-' + stufe + '">' + esc(f2.text) + '</li>';
    }).join('');

    var ph = b.perzeptuell || {};

    return '<!DOCTYPE html><html lang="de"><head><meta charset="utf-8">' +
      '<title>Analysebericht — ' + esc(b.dateiname || 'Bild') + '</title><style>' +
      'body{font:14px/1.6 system-ui,sans-serif;max-width:920px;margin:0 auto;padding:32px 20px;color:#111}' +
      'h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:30px 0 8px;padding-bottom:5px;border-bottom:1px solid #ddd}' +
      '.sub{color:#666;font-size:12px;margin:0 0 6px}table{border-collapse:collapse;width:100%;font-size:13px}' +
      'th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #eee;vertical-align:top}' +
      'th{width:38%;color:#555;font-weight:600}code{font:12px ui-monospace,monospace;word-break:break-all}' +
      'ul{padding-left:0;list-style:none}.f{padding:9px 12px;margin:6px 0;border-left:3px solid #999;background:#f7f7f7;border-radius:0 4px 4px 0}' +
      '.f-crit{border-color:#c0392b;background:#fdf0ee}.f-warn{border-color:#c8951f;background:#fdf8ec}.f-info{border-color:#3a7ca5;background:#eef4f8}' +
      'figure{margin:16px 0}figure img{width:100%;border:1px solid #ddd;border-radius:4px}' +
      'figcaption{font-size:12px;color:#666;margin-top:5px}' +
      '.note{font-size:12px;color:#666;border:1px solid #e0e0e0;padding:12px;border-radius:4px;margin-top:26px}' +
      '@media print{body{padding:0}h2{break-after:avoid}figure{break-inside:avoid}}' +
      '</style></head><body>' +
      '<h1>Forensischer Analysebericht</h1>' +
      '<p class="sub">Datei: <strong>' + esc(b.dateiname || 'Kamerabild') + '</strong> · ' +
        'Erstellt: ' + esc(zeit(Date.now())) + ' · Forensik Vision ' + esc(b.version || '') + '</p>' +

      '<h2>Integrität</h2><table>' +
      '<tr><th>SHA-256</th><td><code>' + esc(b.hash.sha256) + '</code></td></tr>' +
      '<tr><th>SHA-1</th><td><code>' + esc(b.hash.sha1) + '</code></td></tr>' +
      '<tr><th>Größe</th><td>' + esc(b.hash.bytes.toLocaleString('de-DE')) + ' Byte</td></tr>' +
      (b.breite ? '<tr><th>Abmessungen</th><td>' + b.breite + ' × ' + b.hoehe + ' px</td></tr>' : '') +
      '</table>' +

      (ph.pHash ? '<h2>Wahrnehmungs-Prüfsummen</h2><table>' +
        '<tr><th>aHash</th><td><code>' + esc(ph.aHash) + '</code></td></tr>' +
        '<tr><th>dHash</th><td><code>' + esc(ph.dHash) + '</code></td></tr>' +
        '<tr><th>pHash</th><td><code>' + esc(ph.pHash) + '</code></td></tr></table>' : '') +

      '<h2>Befunde</h2><ul>' + (befunde || '<li class="f f-info">Keine Befunde.</li>') + '</ul>' +

      '<h2>Messwerte</h2><table>' +
      '<tr><th>ELA — mittlere Abweichung</th><td>' + num(b.ela && b.ela.meanError, 2) + '</td></tr>' +
      '<tr><th>ELA — größte Abweichung</th><td>' + num(b.ela && b.ela.maxError, 0) + '</td></tr>' +
      '<tr><th>Rauschen — Gleichmäßigkeit</th><td>' + num(b.rauschen && b.rauschen.uniformity, 3) + '</td></tr>' +
      '<tr><th>Copy-Move — verdächtige Blöcke</th><td>' + ((b.copyMove && b.copyMove.suspectBlocks) || 0) + '</td></tr>' +
      (b.blockraster && !b.blockraster.error
        ? '<tr><th>Blockraster — Versatz</th><td>' +
            (b.blockraster.verlaesslich
              ? '(' + b.blockraster.offsetX + ', ' + b.blockraster.offsetY + ')'
              : 'nicht verlässlich messbar') +
            ' <span style="color:#777">(Kennwert ' + num(b.blockraster.confidence, 2) +
            ', nötig ' + b.blockraster.schwelle + ')</span></td></tr>' +
          '<tr><th>Blockraster — abweichende Kacheln</th><td>' + b.blockraster.mismatchTiles +
            ' von ' + b.blockraster.totalTiles + '</td></tr>'
        : '') +
      (b.ghosts && !b.ghosts.error
        ? '<tr><th>Ghosts — Einbruch bei Stufe</th><td>' + b.ghosts.bestQuality + '</td></tr>' +
          '<tr><th>Ghosts — abweichende Kacheln</th><td>' + b.ghosts.outliers + ' von ' +
            b.ghosts.totalTiles + ' (Streuung ' + num(b.ghosts.spread, 2) + ')</td></tr>'
        : '') +
      (b.histogramm ? '<tr><th>Tiefen beschnitten</th><td>' + num(b.histogramm.clippedLowPct, 2) + ' %</td></tr>' +
        '<tr><th>Lichter beschnitten</th><td>' + num(b.histogramm.clippedHighPct, 2) + ' %</td></tr>' : '') +
      '</table>' +

      (zeilen ? '<h2>Metadaten</h2><table>' + zeilen + '</table>' : '<h2>Metadaten</h2><p>Keine gefunden.</p>') +

      '<h2>Ansichten</h2>' + bilder.map(function (p) {
        return p[1] ? '<figure><img src="' + p[1] + '" alt=""><figcaption>' + esc(p[0]) + '</figcaption></figure>' : '';
      }).join('') +

      '<p class="note"><strong>Zur Einordnung.</strong> Die hier aufgeführten Befunde sind Hinweise, ' +
      'keine Beweise. Metadaten lassen sich entfernen und fälschen. Gleichförmige Flächen und ' +
      'wiederkehrende Muster erzeugen im Copy-Move-Verfahren zwangsläufig Treffer. Ein hohes ' +
      'Fehlerniveau entsteht auch durch mehrfaches Speichern ohne jede inhaltliche Änderung. ' +
      'Die Prüfsummen belegen ausschließlich, dass die untersuchte Datei unverändert vorlag.</p>' +
      '</body></html>';
  }

  function sichereBericht() {
    var html = baueBericht();
    if (!html) { toast('Erst ein Bild analysieren.'); return; }
    var name = (S.bericht.dateiname || 'bild').replace(/\.[^.]+$/, '');
    var b = new Blob([html], { type: 'text/html;charset=utf-8' });
    sichereDatei(b, 'analysebericht-' + name + '-' + Date.now() + '.html', 'Bericht');
  }

  /* ====================================================== Ghost-Analyse */

  async function starteGhosts() {
    if (!S.bitmap || !window.Forensics) return;
    var btn = $('ghostBtn');
    btn.disabled = true;
    $('ghostProgress').hidden = false;
    var bar = $('ghostProgressBar');
    bar.style.width = '2%';
    log('analyse', 'Ghost-Analyse gestartet', 'Qualitätsstufen 50 bis 98');

    var g = await window.Forensics.jpegGhosts(S.bitmap, {
      onProgress: function (v) { bar.style.width = Math.round(v * 100) + '%'; }
    });

    $('ghostProgress').hidden = true;
    btn.disabled = false;

    if (g.error) { toast(g.error, 5000); log('fehler', 'Ghost-Analyse fehlgeschlagen', g.error); return; }

    S.layers.ghosts = g.imageData;
    S.ghosts = g;
    if (S.bericht) S.bericht.ghosts = g;

    document.querySelectorAll('#viewSeg button[data-layer="ghosts"]').forEach(function (b) { b.disabled = false; });
    $('ghostPanel').hidden = false;
    $('ghostNote').textContent = 'Einbruch bei Stufe ' + g.bestQuality;
    zeichneGhostKurve(g);

    // Neue Befunde in die Liste aufnehmen
    (g.findings || []).forEach(function (f) {
      var lvl = f.level === 'alarm' ? 'crit' : f.level;
      var d = document.createElement('div');
      d.className = 'finding';
      d.setAttribute('data-level', lvl);
      d.innerHTML = '<span class="finding-mark"></span><span class="finding-text"></span>';
      d.querySelector('.finding-text').textContent = f.text;
      $('findingsList').appendChild(d);
      if (S.bericht && S.bericht.metadaten) S.bericht.metadaten.findings.push(f);
      log('befund', f.text.slice(0, 80) + (f.text.length > 80 ? '…' : ''), 'Stufe: ' + f.level);
    });
    $('findingsNote').textContent = $('findingsList').children.length + ' Befunde';

    S.layer = 'ghosts';
    document.querySelectorAll('#viewSeg button').forEach(function (x) {
      x.classList.toggle('is-active', x.dataset.layer === 'ghosts');
    });
    zeichneLayer();
    log('analyse', 'Ghost-Analyse abgeschlossen',
      'Einbruch bei Stufe ' + g.bestQuality + ' · ' + g.outliers + ' von ' + g.totalTiles +
      ' Kacheln abweichend · Streuung ' + g.spread);
  }

  function zeichneGhostKurve(g) {
    var c = $('ghostCanvas');
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = c.clientWidth || 300, h = 140;
    c.width = w * dpr; c.height = h * dpr;
    var ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!g.curve || g.curve.length < 2) return;

    var werte = g.curve.map(function (p) { return p.mean; });
    var min = Math.min.apply(null, werte), max = Math.max.apply(null, werte);
    var spanne = Math.max(1e-6, max - min);
    var padL = 8, padR = 8, padT = 12, padB = 20;
    var bw = w - padL - padR, bh = h - padT - padB;

    ctx.strokeStyle = 'rgba(255,255,255,.07)';
    for (var yy = 0; yy <= 3; yy++) {
      var y = padT + (bh / 3) * yy;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + bw, y); ctx.stroke();
    }

    ctx.beginPath();
    g.curve.forEach(function (p, i) {
      var x = padL + (i / (g.curve.length - 1)) * bw;
      var y = padT + bh - ((p.mean - min) / spanne) * bh;
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    });
    ctx.strokeStyle = '#46A8C9';
    ctx.lineWidth = 2; ctx.lineJoin = 'round';
    ctx.stroke();

    // Den Einbruch markieren - das ist die Aussage der ganzen Kurve.
    var bi = 0;
    for (var i2 = 1; i2 < g.curve.length; i2++) if (g.curve[i2].mean < g.curve[bi].mean) bi = i2;
    var mx = padL + (bi / (g.curve.length - 1)) * bw;
    var my = padT + bh - ((g.curve[bi].mean - min) / spanne) * bh;
    ctx.strokeStyle = 'rgba(204,156,61,.55)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(mx, padT); ctx.lineTo(mx, padT + bh); ctx.stroke();
    ctx.fillStyle = '#CC9C3D';
    ctx.beginPath(); ctx.arc(mx, my, 3.5, 0, Math.PI * 2); ctx.fill();

    ctx.fillStyle = '#6C818B';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textBaseline = 'top';
    ctx.fillText(String(g.curve[0].quality), padL, padT + bh + 5);
    var letzte = String(g.curve[g.curve.length - 1].quality);
    ctx.fillText(letzte, padL + bw - ctx.measureText(letzte).width, padT + bh + 5);
    ctx.fillStyle = '#CC9C3D';
    var lab = String(g.curve[bi].quality);
    ctx.fillText(lab, Math.min(padL + bw - 14, Math.max(padL, mx - 6)), padT + bh + 5);
  }

  /* ============================================================== Skripte */

  var WERKZEUGE = [
    ['hash()',          'SHA-256, SHA-1, Bytegröße'],
    ['metadaten()',     'EXIF, GPS, Tags, Befunde'],
    ['quantTabellen()', 'JPEG-Qualität und Urheber'],
    ['ela()',           'Fehlerniveau: meanError, maxError'],
    ['rauschen()',      'Rauschrest: uniformity'],
    ['copyMove()',      'verdächtige Blöcke'],
    ['blockraster()',   'Gitterversatz, Verlässlichkeit'],
    ['ghosts()',        'Einbruchs-Qualität (langsam)'],
    ['phash()',         'aHash, dHash, pHash'],
    ['histogramm()',    'beschnittene Tiefen und Lichter'],
    ['erkenne({conf})', 'Objekterkennung'],
    ['abstand(a, b)',   'Hamming-Abstand zweier Hashes'],
    ['markiere(stufe, text)', 'Befund festhalten'],
    ['setze(feld, wert)',     'Wert in die Ergebnistabelle'],
    ['notiz(text)',           'freie Zeile']
  ];

  var VORLAGEN = {
    schnell:
'// Schnellprüfung: Identität und offensichtliche Auffälligkeiten.\n' +
'const h = await werkzeuge.hash();\n' +
'const m = await werkzeuge.metadaten();\n' +
'\n' +
'werkzeuge.setze("SHA-256", h.sha256);\n' +
'werkzeuge.setze("Größe", (h.bytes / 1024).toFixed(1) + " KB");\n' +
'werkzeuge.setze("Format", m.format);\n' +
'werkzeuge.setze("Maße", m.breite + "×" + m.hoehe);\n' +
'\n' +
'// Die Befunde des Moduls übernehmen, aber nur die ernsten.\n' +
'for (const b of m.befunde) {\n' +
'  if (b.level !== "info") werkzeuge.markiere(b.level, b.text);\n' +
'}\n' +
'if (m.gps) werkzeuge.markiere("warn", "Standortdaten enthalten: " + m.gps.lat + ", " + m.gps.lon);\n',

    manipulation:
'// Bewertet mehrere Verfahren gemeinsam und bildet eine Gesamtzahl.\n' +
'// Wichtig: keines dieser Verfahren beweist etwas allein.\n' +
'let punkte = 0;\n' +
'const gruende = [];\n' +
'\n' +
'const ela = await werkzeuge.ela();\n' +
'if (!ela.error && ela.meanError > 12) { punkte += 2; gruende.push("hohes Fehlerniveau (" + ela.meanError + ")"); }\n' +
'werkzeuge.setze("ELA-Mittel", ela.meanError);\n' +
'\n' +
'const r = await werkzeuge.rauschen();\n' +
'if (!r.error && r.uniformity < 0.35) { punkte += 2; gruende.push("ungleiches Rauschen (" + r.uniformity + ")"); }\n' +
'werkzeuge.setze("Rausch-Gleichmäßigkeit", r.uniformity);\n' +
'\n' +
'const cm = await werkzeuge.copyMove();\n' +
'if (!cm.error && cm.suspectBlocks > 6) { punkte += 2; gruende.push(cm.suspectBlocks + " gleichende Blöcke"); }\n' +
'werkzeuge.setze("Copy-Move-Blöcke", cm.suspectBlocks);\n' +
'\n' +
'const bag = await werkzeuge.blockraster();\n' +
'werkzeuge.setze("Blockraster", bag.verlaesslich ? "(" + bag.offsetX + "," + bag.offsetY + ")" : "nicht messbar");\n' +
'if (bag.verlaesslich && (bag.offsetX || bag.offsetY)) {\n' +
'  punkte += 3; gruende.push("Gitter versetzt - Hinweis auf Beschnitt");\n' +
'}\n' +
'if (bag.mismatchTiles > 2) { punkte += 3; gruende.push(bag.mismatchTiles + " Kacheln mit fremdem Gitter"); }\n' +
'\n' +
'werkzeuge.setze("Punkte", punkte + " von 12");\n' +
'if (punkte >= 6)      werkzeuge.markiere("alarm", "Mehrere Verfahren schlagen an: " + gruende.join("; "));\n' +
'else if (punkte >= 3) werkzeuge.markiere("warn",  "Einzelne Auffälligkeiten: " + gruende.join("; "));\n' +
'else                  werkzeuge.markiere("info",  "Keines der Verfahren schlägt deutlich an.");\n',

    herkunft:
'// Kam die Datei aus einer Kamera oder aus einem Programm?\n' +
'const m = await werkzeuge.metadaten();\n' +
'const q = await werkzeuge.quantTabellen();\n' +
'\n' +
'werkzeuge.setze("Hersteller", m.tags["Hersteller"] || "—");\n' +
'werkzeuge.setze("Modell", m.tags["Kameramodell"] || "—");\n' +
'werkzeuge.setze("Software", m.tags["Software"] || "—");\n' +
'werkzeuge.setze("JPEG-Qualität", q.quality ?? "—");\n' +
'werkzeuge.setze("Tabellen", q.urheber);\n' +
'\n' +
'const hatKamera = !!(m.tags["Hersteller"] || m.tags["Kameramodell"]);\n' +
'if (q.standard && hatKamera) {\n' +
'  werkzeuge.markiere("alarm",\n' +
'    "Widerspruch: EXIF nennt eine Kamera, die Quantisierungstabellen sind aber die der " +\n' +
'    "Standardbibliothek. Die Datei wurde nach der Aufnahme neu kodiert.");\n' +
'} else if (q.standard) {\n' +
'  werkzeuge.markiere("warn", "Standardtabellen: von einem Programm geschrieben, nicht direkt aufgenommen.");\n' +
'} else if (q.quality) {\n' +
'  werkzeuge.markiere("info", "Gerätespezifische Tabellen - spricht für einen Kamera-Kodierer.");\n' +
'}\n' +
'if (!m.hatVorschaubild && hatKamera) {\n' +
'  werkzeuge.markiere("warn", "Kamera-EXIF ohne eingebettetes Vorschaubild.");\n' +
'}\n',

    dubletten:
'// Zeigt an, welche Bilder DENSELBEN Inhalt haben, auch wenn ihre\n' +
'// Prüfsummen verschieden sind. Die Ausgabe je Bild vergleichst du danach.\n' +
'const h = await werkzeuge.hash();\n' +
'const p = await werkzeuge.phash();\n' +
'\n' +
'werkzeuge.setze("SHA-256", h.sha256.slice(0, 16) + "…");\n' +
'werkzeuge.setze("pHash", p.pHash);\n' +
'werkzeuge.setze("dHash", p.dHash);\n' +
'\n' +
'// Gib den pHash zurück - er steht dann in der Zusammenfassung.\n' +
'return { pHash: p.pHash, sha256: h.sha256 };\n',

    objekte:
'// Zählt erkannte Objekte je Bild. Setzt voraus, dass die Erkennung läuft.\n' +
'const hits = await werkzeuge.erkenne({ conf: 0.35 });\n' +
'const zaehl = {};\n' +
'for (const d of hits) zaehl[d.label] = (zaehl[d.label] || 0) + 1;\n' +
'\n' +
'werkzeuge.setze("Objekte gesamt", hits.length);\n' +
'for (const [name, n] of Object.entries(zaehl).sort((a, b) => b[1] - a[1])) {\n' +
'  werkzeuge.setze(name, n);\n' +
'}\n' +
'if (zaehl["person"]) werkzeuge.markiere("warn", zaehl["person"] + " Person(en) im Bild - vor Weitergabe bedenken.");\n' +
'if (!hits.length) werkzeuge.markiere("info", "Nichts über der Schwelle erkannt.");\n'
  };

  var skriptDateien = [], skriptErgebnisse = [];

  function baueWerkzeugListe() {
    var box = $('werkzeugListe');
    box.textContent = '';
    WERKZEUGE.forEach(function (w) {
      var d = document.createElement('div');
      d.className = 'wz-zeile';
      d.innerHTML = '<span class="wz-name"></span><span class="wz-was"></span>';
      d.querySelector('.wz-name').textContent = w[0];
      d.querySelector('.wz-was').textContent = w[1];
      box.appendChild(d);
    });
  }

  function zeigeSkriptErgebnis(r) {
    var box = $('skriptErgebnisse');
    var d = document.createElement('div');
    d.className = 'erg';
    var kopf = document.createElement('div');
    kopf.className = 'erg-kopf';
    kopf.innerHTML = '<span class="erg-datei"></span><span class="erg-status"></span>';
    kopf.querySelector('.erg-datei').textContent = r.datei || 'unbenannt';
    var st = kopf.querySelector('.erg-status');
    st.textContent = r.ok ? 'ok' : 'Fehler';
    st.setAttribute('data-ok', String(!!r.ok));
    d.appendChild(kopf);

    if (!r.ok && r.fehler) {
      var f = document.createElement('div');
      f.className = 'finding';
      f.setAttribute('data-level', 'crit');
      f.innerHTML = '<span class="finding-mark"></span><span class="finding-text"></span>';
      f.querySelector('.finding-text').textContent = r.fehler;
      d.appendChild(f);
    }
    Object.keys(r.felder || {}).forEach(function (k) {
      var z = document.createElement('div');
      z.className = 'erg-feld';
      z.innerHTML = '<span class="k"></span><span class="v"></span>';
      z.querySelector('.k').textContent = k;
      z.querySelector('.v').textContent = r.felder[k];
      d.appendChild(z);
    });
    (r.befunde || []).forEach(function (b) {
      var f2 = document.createElement('div');
      f2.className = 'finding';
      f2.setAttribute('data-level', b.level === 'alarm' ? 'crit' : b.level);
      f2.innerHTML = '<span class="finding-mark"></span><span class="finding-text"></span>';
      f2.querySelector('.finding-text').textContent = b.text;
      d.appendChild(f2);
    });
    (r.notizen || []).forEach(function (n) {
      var z2 = document.createElement('div');
      z2.className = 'erg-notiz';
      z2.textContent = n;
      d.appendChild(z2);
    });
    box.appendChild(d);
  }

  async function fuehreSkriptAus() {
    var code = $('skriptCode').value.trim();
    if (!code) { toast('Kein Rezept eingetragen.'); return; }
    if (!skriptDateien.length) { toast('Erst Bilder wählen.'); return; }
    if (!window.Skripte) { toast('Das Skript-Modul ist nicht geladen.'); return; }

    $('skriptLaufBtn').disabled = true;
    $('skriptExportBtn').disabled = true;
    $('skriptErgebnisPanel').hidden = false;
    $('skriptErgebnisse').textContent = '';
    $('skriptProgress').hidden = false;
    skriptErgebnisse = [];

    log('skript', 'Rezept gestartet', skriptDateien.length + ' Bilder');

    var t0 = performance.now();
    skriptErgebnisse = await window.Skripte.laufe(code, skriptDateien, {
      onFortschritt: function (i, n, name) {
        $('skriptProgressBar').style.width = Math.round(i / n * 100) + '%';
        $('skriptNote').textContent = (i + 1) + ' von ' + n;
        ticker('Rezept: ' + name + ' (' + (i + 1) + '/' + n + ')', null, true);
      },
      onErgebnis: function (r) { zeigeSkriptErgebnis(r); }
    });

    var dauer = Math.round((performance.now() - t0) / 100) / 10;
    var fehler = skriptErgebnisse.filter(function (r) { return !r.ok; }).length;
    var befunde = skriptErgebnisse.reduce(function (a, r) { return a + (r.befunde || []).length; }, 0);

    $('skriptProgressBar').style.width = '100%';
    setTimeout(function () { $('skriptProgress').hidden = true; }, 300);
    $('skriptNote').textContent = skriptErgebnisse.length + ' Bilder · ' + dauer + ' s';
    $('skriptErgebnisNote').textContent = befunde + ' Befunde' + (fehler ? ' · ' + fehler + ' Fehler' : '');
    $('skriptLaufBtn').disabled = false;
    $('skriptExportBtn').disabled = false;
    log('skript', 'Rezept abgeschlossen',
      skriptErgebnisse.length + ' Bilder · ' + befunde + ' Befunde · ' + fehler + ' Fehler · ' + dauer + ' s');
  }

  function sichereSkriptErgebnis() {
    if (!skriptErgebnisse.length) return;
    var b = new Blob([JSON.stringify({
      erzeugtAm: new Date().toISOString(),
      rezept: $('skriptCode').value,
      ergebnisse: skriptErgebnisse
    }, null, 2)], { type: 'application/json' });
    sichereDatei(b, 'rezept-ergebnis-' + Date.now() + '.json', 'Rezept-Ergebnis');
  }

  function verdrahteSkripte() {
    baueWerkzeugListe();
    $('skriptVorlage').addEventListener('change', function () {
      if (VORLAGEN[this.value]) {
        $('skriptCode').value = VORLAGEN[this.value];
        $('skriptLaufBtn').disabled = !skriptDateien.length;
      }
    });
    $('skriptCode').addEventListener('input', function () {
      $('skriptLaufBtn').disabled = !(this.value.trim() && skriptDateien.length);
    });
    $('skriptDateienBtn').addEventListener('click', function () { $('skriptDateien').click(); });
    $('skriptDateien').addEventListener('change', function () {
      skriptDateien = Array.prototype.slice.call(this.files || []);
      $('skriptDateiNote').textContent = skriptDateien.length
        ? skriptDateien.length + (skriptDateien.length === 1 ? ' Bild gewählt' : ' Bilder gewählt')
        : 'Noch keine Bilder gewählt.';
      $('skriptLaufBtn').disabled = !(skriptDateien.length && $('skriptCode').value.trim());
    });
    $('skriptLaufBtn').addEventListener('click', fuehreSkriptAus);
    $('skriptExportBtn').addEventListener('click', sichereSkriptErgebnis);
    $('skriptCode').value = VORLAGEN.schnell;
    $('skriptVorlage').value = 'schnell';
  }

  /* ====================================================== Leistungsstufen */

  function baueStufenChips() {
    var box = $('stufenChips');
    box.textContent = '';
    ['sparsam', 'ausgewogen', 'genau'].forEach(function (k) {
      var st = STUFEN[k];
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (S.stufe === k ? ' is-on' : '');
      b.textContent = st.name + ' · ' + st.size + ' px';
      b.addEventListener('click', function () { setzeStufe(k); });
      box.appendChild(b);
    });
    var st2 = STUFEN[S.stufe] || STUFEN.ausgewogen;
    $('stufeHinweis').textContent = st2.hinweis;
    $('stufeNote').textContent = Math.round(1000 / st2.takt) + ' B/s · ' + st2.breite + '×' + st2.hoehe;
  }

  async function setzeStufe(k) {
    if (!STUFEN[k] || S.stufe === k) return;
    S.stufe = k;
    try { localStorage.setItem('stufe', k); } catch (e) {}
    baueStufenChips();
    log('stufe', 'Leistungsstufe: ' + STUFEN[k].name,
      STUFEN[k].size + ' px · ' + Math.round(1000 / STUFEN[k].takt) + ' Bilder/s · Kamera ' +
      STUFEN[k].breite + '×' + STUFEN[k].hoehe);

    var liefQuelle = S.running || S.stream;
    stoppeQuelle();
    if (S.detectorReady) {
      try { window.Detector.dispose(); } catch (e) {}
      S.detectorReady = false; S.detectorMode = null;
    }
    try { await initDetector('live'); }
    catch (e) { log('fehler', 'Modell der neuen Stufe lud nicht', e.message); return; }
    // Lief gerade etwas, mit der neuen Stufe fortsetzen.
    if (liefQuelle) {
      if (S.quelle === 'bildschirm') starteBildschirm(); else startKamera();
    }
  }

  /* ================================================== Aufnahme und Spuren
   *
   * Aufgenommen wird eine eigene Leinwand, auf die je Bild Quelle UND
   * Rahmen gezeichnet werden. Das Videoelement direkt aufzunehmen waere
   * billiger, wuerde aber genau das weglassen, worum es geht: was die
   * Erkennung gesehen hat. Die Leinwand entsteht nur waehrend der Aufnahme.
   * ====================================================================== */

  var tracker = null;
  var rec = {
    recorder: null, teile: [], laeuft: false, wartet: false,
    start: 0, dauer: 0, uhr: null, canvas: null, ctx: null,
    strom: null, ereignisse: [], blob: null, ausloeser: false,
    letzteAktivitaet: 0
  };

  function mimeWaehlen() {
    var kandidaten = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    for (var i = 0; i < kandidaten.length; i++) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(kandidaten[i])) return kandidaten[i];
    }
    return '';
  }

  function zeitText(ms) {
    var s2 = Math.floor(ms / 1000);
    return Math.floor(s2 / 60) + ':' + String(s2 % 60).padStart(2, '0');
  }

  /** Zeichnet Quelle und Rahmen in die Aufnahme-Leinwand. */
  function zeichneAufnahmebild(quelle, spuren) {
    if (!rec.ctx) return;
    var c = rec.canvas, g = rec.ctx;
    g.drawImage(quelle, 0, 0, c.width, c.height);

    var f = c.width / Math.max(1, S.srcW);
    g.lineWidth = Math.max(2, c.width / 320);
    g.font = '600 ' + Math.max(11, c.width / 42) + 'px ui-monospace, monospace';
    g.textBaseline = 'top';
    spuren.forEach(function (sp) {
      var farbe = 'hsl(' + ((sp.classId * 47) % 360) + ' 70% 62%)';
      var x = sp.box.x * f, y = sp.box.y * f, w = sp.box.w * f, h = sp.box.h * f;
      g.strokeStyle = farbe;
      g.strokeRect(x, y, w, h);
      var txt = '#' + sp.id + ' ' + sp.label + ' ' + Math.round(sp.score * 100) + '%';
      var hh = Math.max(15, c.width / 36);
      g.fillStyle = farbe;
      g.fillRect(x, Math.max(0, y - hh), g.measureText(txt).width + 10, hh);
      g.fillStyle = '#06171E';
      g.fillText(txt, x + 5, Math.max(0, y - hh) + 2);
    });

    // Zeitstempel einbrennen - ohne ihn ist eine Aufnahme als Beleg wertlos.
    var stempel = new Date().toLocaleString('de-DE');
    g.font = '600 ' + Math.max(10, c.width / 50) + 'px ui-monospace, monospace';
    var bw = g.measureText(stempel).width + 12;
    g.fillStyle = 'rgba(7,12,15,.72)';
    g.fillRect(c.width - bw - 6, c.height - 26, bw, 20);
    g.fillStyle = '#DEE7EA';
    g.fillText(stempel, c.width - bw - 1, c.height - 22);
  }

  function ereignis(art, text, details) {
    rec.ereignisse.push({
      ms: rec.laeuft ? Math.round(performance.now() - rec.start) : null,
      zeit: new Date().toISOString(), art: art, text: text, details: details || null
    });
  }

  async function starteAufnahme() {
    if (rec.laeuft) { beendeAufnahme(); return; }
    if (!S.running || !S.srcW) { toast('Erst eine Quelle starten.'); return; }
    if (!window.MediaRecorder) { toast('Diese Umgebung kann nicht aufnehmen.', 4000); return; }

    var mime = mimeWaehlen();
    if (!mime) { toast('Kein unterstütztes Videoformat gefunden.', 4000); return; }

    // Aufnahmegröße an die Quelle koppeln, aber begrenzen: die Datei waechst
    // mit der Flaeche, und ein Telefon soll das noch schreiben koennen.
    var maxB = 960;
    var f = Math.min(1, maxB / S.srcW);
    rec.canvas = document.createElement('canvas');
    rec.canvas.width = Math.round(S.srcW * f / 2) * 2;
    rec.canvas.height = Math.round(S.srcH * f / 2) * 2;
    rec.ctx = rec.canvas.getContext('2d');

    rec.strom = rec.canvas.captureStream(0);   // 0 = nur auf Anforderung
    try {
      rec.recorder = new MediaRecorder(rec.strom, {
        mimeType: mime, videoBitsPerSecond: 2500000
      });
    } catch (e) { toast('Aufnahme nicht möglich: ' + e.message, 5000); return; }

    rec.teile = []; rec.ereignisse = []; rec.blob = null;
    rec.recorder.ondataavailable = function (e) { if (e.data && e.data.size) rec.teile.push(e.data); };
    rec.recorder.onstop = function () {
      rec.blob = new Blob(rec.teile, { type: mime });
      // Fuer den Browsertest zugaenglich - sonst laesst sich nicht pruefen,
      // ob wirklich ein abspielbares Video entstanden ist.
      window.__recBlob = rec.blob;
      window.__recEreignisse = rec.ereignisse;
      $('recSaveBtn').disabled = false;
      $('recJsonBtn').disabled = false;
      $('recInfo').textContent = (rec.blob.size / 1048576).toFixed(1).replace('.', ',') + ' MB · ' +
        rec.ereignisse.length + ' Ereignisse';
      log('aufnahme', 'Aufnahme beendet',
        zeitText(rec.dauer) + ' · ' + (rec.blob.size / 1048576).toFixed(1) + ' MB · ' +
        rec.ereignisse.length + ' Ereignisse · ' +
        (tracker ? tracker.bilanz().verschiedeneObjekte : 0) + ' verschiedene Objekte');
    };
    rec.recorder.onerror = function (e) {
      toast('Aufnahmefehler: ' + (e.error && e.error.name || 'unbekannt'), 5000);
      beendeAufnahme();
    };

    // Vordergrunddienst VOR dem Start: sonst kann Android den Vorgang
    // beenden, sobald die App aus dem Blick geraet.
    var sp = schirmPlugin();
    if (sp && sp.startRecordingService) {
      try { await sp.startRecordingService({ typ: S.quelle === 'bildschirm' ? 'bildschirm' : 'kamera' }); }
      catch (e) { log('warnung', 'Aufnahmedienst nicht gestartet', e.message || String(e)); }
    }

    rec.recorder.start(1000);
    rec.laeuft = true;
    rec.start = performance.now();
    rec.dauer = 0;
    rec.ausloeser = $('recAusloeserBox').classList.contains('on');
    ereignis('start', 'Aufnahme gestartet',
      rec.canvas.width + '×' + rec.canvas.height + ' · ' + mime);

    $('recPanel').hidden = false;
    $('recBtn').textContent = 'Stopp';
    $('recBtn').classList.remove('btn--danger');
    $('recBtn').classList.add('btn--primary');
    $('recPunkt').className = 'rec-punkt laeuft';
    $('recSaveBtn').disabled = true;
    $('recJsonBtn').disabled = true;
    rec.uhr = setInterval(function () {
      rec.dauer = performance.now() - rec.start;
      $('recZeit').textContent = zeitText(rec.dauer);
      $('recNote').textContent = rec.wartet ? 'wartet auf Erkennung' : 'läuft';
    }, 250);
    log('aufnahme', 'Aufnahme gestartet',
      rec.canvas.width + '×' + rec.canvas.height + (rec.ausloeser ? ' · nur bei Erkennung' : ''));
  }

  function beendeAufnahme() {
    if (!rec.laeuft) return;
    rec.laeuft = false;
    rec.wartet = false;
    clearInterval(rec.uhr);
    try { if (rec.recorder && rec.recorder.state !== 'inactive') rec.recorder.stop(); } catch (e) {}
    try { if (rec.strom) rec.strom.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    var sp2 = schirmPlugin();
    if (sp2 && sp2.stopRecordingService) { try { sp2.stopRecordingService(); } catch (e) {} }
    ereignis('stopp', 'Aufnahme beendet', zeitText(rec.dauer));
    $('recBtn').textContent = 'Aufnahme';
    $('recBtn').classList.add('btn--danger');
    $('recBtn').classList.remove('btn--primary');
    $('recPunkt').className = 'rec-punkt';
    $('recNote').textContent = 'beendet';
    // Leinwand freigeben - sie haelt sonst ihren Bildspeicher.
    setTimeout(function () {
      if (rec.canvas) { rec.canvas.width = 0; rec.canvas.height = 0; }
      rec.canvas = null; rec.ctx = null; rec.strom = null;
    }, 500);
  }

  /** Je Bild aus der Schleife aufgerufen. */
  function aufnahmeSchritt(quelle, spuren) {
    if (!rec.laeuft || !rec.ctx) return;
    // Auslöser-Betrieb: nur schreiben, solange etwas zu sehen ist. Nach dem
    // letzten Fund noch zwei Sekunden weiterlaufen, sonst wirkt der Schnitt
    // abgehackt und der Abgang fehlt.
    if (rec.ausloeser) {
      if (spuren.length) rec.letzteAktivitaet = performance.now();
      var still = performance.now() - rec.letzteAktivitaet > 2000;
      if (still) {
        if (!rec.wartet) { rec.wartet = true; $('recPunkt').className = 'rec-punkt wartet'; }
        return;                      // kein Bild anfordern = keine Aufnahme
      }
      if (rec.wartet) { rec.wartet = false; $('recPunkt').className = 'rec-punkt laeuft'; }
    }
    zeichneAufnahmebild(quelle, spuren);
    var spur = rec.strom && rec.strom.getVideoTracks()[0];
    if (spur && spur.requestFrame) spur.requestFrame();
  }

  async function sichereVideo() {
    if (!rec.blob) { toast('Noch keine Aufnahme vorhanden.'); return; }
    var name = 'aufnahme-' + new Date().toISOString().replace(/[:.]/g, '-') + '.webm';
    $('recSaveBtn').disabled = true;
    await sichereDatei(rec.blob, name, 'Video');
    $('recSaveBtn').disabled = false;
  }

  function sichereZeitleiste() {
    var b = tracker ? tracker.bilanz() : null;
    var daten = {
      erzeugtAm: new Date().toISOString(),
      fassung: FASSUNG,
      dauerMs: Math.round(rec.dauer),
      quelle: S.quelle,
      stufe: S.stufe,
      aufloesung: rec.canvas ? (rec.canvas.width + '×' + rec.canvas.height) : null,
      bilanz: b,
      ereignisse: rec.ereignisse
    };
    var bl = new Blob([JSON.stringify(daten, null, 2)], { type: 'application/json' });
    sichereDatei(bl, 'zeitleiste-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json',
                 'Zeitleiste');
  }

  function renderSpuren(spuren) {
    var box = $('spurenListe');
    if (!tracker) return;
    var b = tracker.bilanz();
    $('spurenPanel').hidden = false;
    $('spurenNote').textContent = b.verschiedeneObjekte +
      (b.verschiedeneObjekte === 1 ? ' Objekt' : ' Objekte') + ' · ' + b.aktuellImBild + ' im Bild';

    var kennung = spuren.map(function (s2) { return s2.id; }).join(',');
    if (kennung === box.dataset.k) return;
    box.dataset.k = kennung;
    box.textContent = '';
    if (!spuren.length) {
      box.innerHTML = '<p class="empty">Nichts im Bild.</p>';
      return;
    }
    spuren.slice().sort(function (a, b2) { return a.id - b2.id; }).forEach(function (sp) {
      var d = document.createElement('div');
      d.className = 'spur';
      d.innerHTML = '<span class="spur-id"></span><span class="spur-name"></span>' +
        '<span class="spur-score"></span><span class="spur-dauer"></span>';
      d.querySelector('.spur-id').textContent = '#' + sp.id;
      d.querySelector('.spur-name').textContent = sp.label;
      d.querySelector('.spur-score').textContent = Math.round(sp.bestScore * 100) + '%';
      d.querySelector('.spur-dauer').textContent = ((sp.zuletzt - sp.zuerst) / 1000).toFixed(1).replace('.', ',') + ' s';
      box.appendChild(d);
    });
  }

  function starteVerfolgung() {
    if (!window.Tracker) return;
    tracker = new window.Tracker();
    $('recBtn').disabled = false;
    $('spurenPanel').hidden = false;
    $('spurenListe').dataset.k = '';
    renderSpuren([]);
  }

  function verdrahteAufnahme() {
    $('recBtn').addEventListener('click', starteAufnahme);
    $('recSaveBtn').addEventListener('click', sichereVideo);
    $('recJsonBtn').addEventListener('click', sichereZeitleiste);
    $('recAusloeserBox').addEventListener('click', function () {
      this.classList.toggle('on');
      rec.ausloeser = this.classList.contains('on');
      if (rec.laeuft) {
        rec.letzteAktivitaet = performance.now();
        if (!rec.ausloeser) { rec.wartet = false; $('recPunkt').className = 'rec-punkt laeuft'; }
      }
    });
  }

  /* ============================================================== Start */

  function verdrahte() {
    document.querySelectorAll('.tabbtn').forEach(function (b) {
      b.addEventListener('click', function () { go(b.dataset.go); });
    });
    $('themeBtn').addEventListener('click', function () {
      var hell = document.documentElement.getAttribute('data-theme') === 'light';
      document.documentElement.setAttribute('data-theme', hell ? 'dark' : 'light');
      try { localStorage.setItem('thema', hell ? 'dark' : 'light'); } catch (e) {}
    });
    try {
      var gespeichert = localStorage.getItem('thema');
      if (gespeichert) document.documentElement.setAttribute('data-theme', gespeichert);
    } catch (e) {}

    $('startCamBtn').addEventListener('click', function () {
      if (S.quelle === 'bildschirm') starteBildschirm(); else startKamera();
    });
    $('stopSrcBtn').addEventListener('click', function () {
      stoppeQuelle();
      log('quelle', 'Quelle beendet', S.quelle === 'bildschirm' ? 'Bildschirm' : 'Kamera');
    });
    document.querySelectorAll('#sourceSeg button').forEach(function (b) {
      b.addEventListener('click', function () {
        if (S.quelle === b.dataset.src) return;
        stoppeQuelle();
        S.quelle = b.dataset.src;
        markiereQuelle();
      });
    });
    $('pauseBtn').addEventListener('click', function () {
      S.running = !S.running;
      this.textContent = S.running ? 'Pause' : 'Weiter';
      if (S.running) schleife();
    });
    $('flipBtn').addEventListener('click', function () {
      S.facing = S.facing === 'environment' ? 'user' : 'environment';
      startKamera();
    });
    $('grabBtn').addEventListener('click', function () {
      var quelle = (S.quelle === 'bildschirm' && S.schirmNativ) ? S.schirmBitmap : $('cam');
      if (!quelle || !S.srcW || !S.srcH) return;
      var c = document.createElement('canvas');
      c.width = S.srcW; c.height = S.srcH;
      c.getContext('2d').drawImage(quelle, 0, 0);
      c.toBlob(function (b) {
        if (!b) return;
        b.name = S.quelle === 'bildschirm' ? 'Bildschirmaufnahme.jpg' : 'Kamerabild.jpg';
        analysiere(b);
      }, 'image/jpeg', 0.95);
    });

    $('confRange').addEventListener('input', function () {
      S.conf = this.value / 100; $('confVal').textContent = num(S.conf, 2);
    });
    $('iouRange').addEventListener('input', function () {
      S.iou = this.value / 100; $('iouVal').textContent = num(S.iou, 2);
    });

    $('pickBtn').addEventListener('click', function () { $('fileInput').click(); });
    $('otherFileBtn').addEventListener('click', function () { $('fileInput').click(); });
    $('fileInput').addEventListener('change', function () {
      if (this.files && this.files[0]) analysiere(this.files[0]);
    });
    $('reanalyseBtn').addEventListener('click', function () { if (S.bild) analysiere(S.bild); });
    $('detectStillBtn').addEventListener('click', async function () {
      if (!S.bitmap) return;
      this.disabled = true;
      try {
        if (S.detectorMode !== 'still') await initDetector('still');
        S.lastHits = filtere(await window.Detector.detect(S.bitmap, { conf: S.conf, iou: S.iou, maxDet: 100 }));
        S.layer = 'original'; zeichneLayer();
        log('erkennung', S.lastHits.length + ' Objekte im Standbild erkannt',
          S.lastHits.map(function (d) { return d.label + ' ' + Math.round(d.score * 100) + '%'; }).join(', '));
        toast(S.lastHits.length + ' Objekte erkannt.');
      } catch (err) { toast('Erkennung fehlgeschlagen: ' + err.message, 5000); }
      this.disabled = false;
    });

    document.querySelectorAll('#viewSeg button').forEach(function (b) {
      b.addEventListener('click', function () {
        S.layer = b.dataset.layer;
        document.querySelectorAll('#viewSeg button').forEach(function (x) {
          x.classList.toggle('is-active', x === b);
        });
        zeichneLayer();
      });
    });

    $('copyLogBtn').addEventListener('click', function () { kopiere(berichtText()); toast('Bericht kopiert.'); });
    $('jsonLogBtn').addEventListener('click', function () {
      var b = new Blob([JSON.stringify({ erzeugtAm: new Date().toISOString(), eintraege: S.log }, null, 2)],
                       { type: 'application/json' });
      sichereDatei(b, 'forensik-protokoll-' + Date.now() + '.json', 'Protokoll');
    });
    $('clearLogBtn').addEventListener('click', function () { S.log = []; renderLog(); });

    verdrahteZoom();
    verdrahteSkripte();
    verdrahteAufnahme();
    try {
      var gesp = localStorage.getItem('stufe');
      if (gesp && STUFEN[gesp]) S.stufe = gesp;
    } catch (e) {}
    baueStufenChips();

    $('compareBtn').addEventListener('click', function () { $('compareInput').click(); });
    $('compareInput').addEventListener('change', function () {
      if (this.files && this.files[0]) vergleicheMit(this.files[0]);
      this.value = '';
    });
    $('reportBtn').addEventListener('click', sichereBericht);
    $('annotBtn').addEventListener('click', sichereAnsicht);
    baueFilterChips();
    $('wischRange').addEventListener('input', function () {
      S.wisch = this.value / 100;
      $('wischVal').textContent = this.value + ' %';
      zeichneLayer();
    });
    $('ghostBtn').addEventListener('click', starteGhosts);

    $('classSearch').addEventListener('input', function () { baueKlassenChips(this.value); });
    $('clearFilterBtn').addEventListener('click', function () {
      S.filter = null;
      $('classSearch').value = '';
      baueKlassenChips('');
      aktualisiereFilterHinweis();
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden && rec.laeuft) {
        // Aufnahme laeuft: weiterarbeiten. Der Vordergrunddienst haelt den
        // Vorgang am Leben, der Planer wechselt auf setTimeout.
        log('aufnahme', 'Aufnahme läuft im Hintergrund weiter',
          'Die Benachrichtigung zeigt es an');
        return;
      }
      if (document.hidden && S.running) {
        S.running = false;
        S.warPausiert = true;
        tickerLebt(false);
        clearTimeout(S.freigabeUhr);
        // Bleibt die App laenger im Hintergrund, Modell und Worker freigeben.
        // Das ist der groesste einzelne Posten, und genau in dieser Lage
        // beendet Android Anwendungen wegen Speichermangel.
        S.freigabeUhr = setTimeout(function () {
          if (!document.hidden || !S.detectorReady || rec.laeuft) return;
          try { window.Detector.dispose(); } catch (e) {}
          S.detectorReady = false;
          S.detectorMode = null;
          log('speicher', 'Modell im Hintergrund freigegeben',
            'Wird beim nächsten Start neu geladen - das spart dem System rund 200 MB');
        }, 20000);
        log('quelle', 'Im Hintergrund angehalten', 'Kamera und Erkennung ruhen');
      } else if (!document.hidden) {
        clearTimeout(S.freigabeUhr);
        if (!S.detectorReady) {
          initDetector('live').catch(function (e) {
            log('fehler', 'Modell konnte nicht neu geladen werden', e.message);
          });
        }
        if (S.warPausiert && S.stream) {
          S.warPausiert = false;
          S.running = true;
          tickerLebt(true);
          schleife();
        }
      }
    });

    window.addEventListener('resize', function () {
      if (S.lastHits.length && S.running) zeichne(S.lastHits);
      wendeZoomAn();
    });
  }

  async function start() {
    verdrahte();
    go('live');
    log('start', 'Forensik Vision ' + FASSUNG + ' gestartet', 'Stand ' + STAND);
    renderLog();
    markiereQuelle();
    $('confVal').textContent = num(S.conf, 2);
    $('iouVal').textContent = num(S.iou, 2);

    if (!window.Forensics) {
      notice('crit', 'Forensik-Modul fehlt', 'js/forensics.js wurde nicht geladen. Die Analyse-Funktionen stehen nicht zur Verfügung.');
    }
    try {
      await ladeModellDaten();
      baueKlassenChips('');
      aktualisiereFilterHinweis();
      await initDetector('live');
    } catch (err) {
      S.detectorReady = false;
      $('brandSub').textContent = 'v' + FASSUNG + ' · Erkennung nicht verfügbar';
      notice('crit', 'Objekterkennung nicht verfügbar',
        'Fassung ' + FASSUNG + ' (' + STAND + '). ' + err.message +
        ' Die forensische Analyse einzelner Bilder funktioniert davon unabhängig weiter.');
      log('fehler', 'Erkennung konnte nicht starten', err.message);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
