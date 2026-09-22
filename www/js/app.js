/*!
 * app.js — Verdrahtung von Oberfläche, Erkennung und Forensik
 * -------------------------------------------------------------
 * Beide Fachmodule können fehlen oder beim Laden scheitern. Die
 * Oberfläche muss das überleben und benennen, statt weiß zu bleiben.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var LIVE_MODEL = { url: 'models/model-320.onnx', size: 320 };
  var STILL_MODEL = { url: 'models/model.onnx', size: 640 };

  var S = {
    labels: [], meta: null,
    detectorReady: false, detectorMode: null,
    stream: null, facing: 'environment', running: false, busy: false,
    conf: 0.25, iou: 0.45,
    fpsWindow: [], lastHits: [],
    bild: null, bitmap: null, layers: {}, layer: 'original',
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

  function log(cat, text, detail) {
    var e = { t: Date.now(), cat: cat, text: text, detail: detail || null };
    S.log.unshift(e);
    if (S.log.length > 400) S.log.length = 400;
    renderLog();
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
    var m = modus === 'still' ? STILL_MODEL : LIVE_MODEL;
    var info = await window.Detector.init({
      modelUrl: m.url, labels: S.labels, inputSize: m.size,
      // Alles lokal: kein CDN, kein Netzverkehr waehrend der Analyse.
      ortUrl: 'vendor/ort.min.js',
      wasmPaths: 'vendor/',
      preferBackend: 'wasm',
      onProgress: function (p) { if (p && p.text) $('brandSub').textContent = p.text; }
    });
    S.detectorReady = true;
    S.detectorMode = modus;
    $('mBackend').textContent = info.backend;
    $('brandSub').textContent = info.backend.toUpperCase() + ' · ' + m.size + ' px · ' + S.labels.length + ' Klassen';
    log('modell', 'Modell geladen', m.url + ' · Backend ' + info.backend + ' · Ausgabe ' + JSON.stringify(info.outputShape));
    return info;
  }

  /* ============================================================== Kamera */

  async function startKamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('Diese Umgebung stellt keine Kamera bereit.');
      return;
    }
    stopKamera();
    try {
      S.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: S.facing, width: { ideal: 1280 }, height: { ideal: 720 } },
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
    $('liveVeil').hidden = true;
    $('liveHud').hidden = false;
    $('pauseBtn').disabled = false;
    $('flipBtn').disabled = false;
    $('grabBtn').disabled = false;
    S.running = true;
    log('kamera', 'Kamera gestartet', v.videoWidth + '×' + v.videoHeight + ' · ' +
      (S.facing === 'environment' ? 'Rückkamera' : 'Frontkamera'));
    schleife();
  }

  function stopKamera() {
    S.running = false;
    if (S.stream) { S.stream.getTracks().forEach(function (t) { t.stop(); }); S.stream = null; }
  }

  /**
   * Zeichnet die Rahmen. Das Video wird mit object-fit:cover angezeigt, es ist
   * also beschnitten - ohne diese Umrechnung säßen alle Rahmen versetzt.
   */
  function zeichne(hits) {
    var v = $('cam'), c = $('overlay');
    var bw = c.clientWidth, bh = c.clientHeight;
    if (!bw || !bh || !v.videoWidth) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (c.width !== Math.round(bw * dpr)) { c.width = Math.round(bw * dpr); c.height = Math.round(bh * dpr); }
    var g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, bw, bh);

    var s = Math.max(bw / v.videoWidth, bh / v.videoHeight);   // cover
    var offX = (bw - v.videoWidth * s) / 2;
    var offY = (bh - v.videoHeight * s) / 2;
    var spiegel = S.facing === 'user';

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

  function renderHits(hits) {
    var box = $('hitsList');
    $('mHits').textContent = hits.length;
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

  async function schleife() {
    if (!S.running) return;
    var v = $('cam');
    if (S.detectorReady && !S.busy && v.readyState >= 2) {
      S.busy = true;
      var t0 = performance.now();
      try {
        var hits = await window.Detector.detect(v, { conf: S.conf, iou: S.iou, maxDet: 60 });
        S.lastHits = hits;
        zeichne(hits);
        renderHits(hits);
        var st = window.Detector.stats;
        $('mMs').textContent = st.lastInferenceMs + ' ms';
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
    requestAnimationFrame(schleife);
  }

  /* ============================================================ Analyse */

  function zeichneLayer() {
    var c = $('analyseCanvas');
    var data = S.layers[S.layer];
    var g = c.getContext('2d');
    if (S.layer === 'original' && S.bitmap) {
      c.width = S.bitmap.width; c.height = S.bitmap.height;
      g.drawImage(S.bitmap, 0, 0);
    } else if (data) {
      c.width = data.width; c.height = data.height;
      g.putImageData(data, 0, 0);
    }
    if (S.lastHits.length && S.layer === 'original') {
      g.lineWidth = Math.max(2, c.width / 400);
      g.font = '600 ' + Math.max(12, c.width / 45) + 'px ui-monospace, monospace';
      g.textBaseline = 'top';
      S.lastHits.forEach(function (d) {
        var farbe = 'hsl(' + ((d.classId * 47) % 360) + ' 70% 62%)';
        g.strokeStyle = farbe; g.strokeRect(d.x, d.y, d.w, d.h);
        g.fillStyle = farbe;
        var txt = d.label + ' ' + Math.round(d.score * 100) + '%';
        var hh = Math.max(16, c.width / 38);
        g.fillRect(d.x, Math.max(0, d.y - hh), g.measureText(txt).width + 12, hh);
        g.fillStyle = '#06171E'; g.fillText(txt, d.x + 6, Math.max(0, d.y - hh) + 2);
      });
    }
    var scale = $('analyseScale');
    var hinweis = { original: '', ela: 'Helle Bereiche wurden anders komprimiert als ihre Umgebung.',
      noise: 'Dunkle, glatte Zonen deuten auf Weichzeichnung oder Retusche.',
      copymove: 'Rot markierte Blöcke gleichen weit entfernten Blöcken.' };
    $('segNote').textContent = hinweis[S.layer] || '';
    scale.hidden = true;
  }

  async function analysiere(datei) {
    if (!window.Forensics) { toast('forensics.js wurde nicht geladen.'); return; }
    S.bild = datei;
    S.lastHits = [];
    $('analyseVeil').hidden = true;
    $('analyseProgress').hidden = false;
    var bar = $('analyseProgressBar');
    bar.style.width = '5%';

    log('analyse', 'Analyse gestartet', (datei.name || 'Kamerabild') + ' · ' + datei.type);

    try { S.bitmap = await createImageBitmap(datei); }
    catch (e) { toast('Bild konnte nicht dekodiert werden.'); $('analyseProgress').hidden = true; return; }

    S.layers = { original: null };
    S.layer = 'original';
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

  function berichtText() {
    var z = ['FORENSIK VISION — VORGANGSPROTOKOLL',
             'Erstellt: ' + zeit(Date.now()), 'Einträge: ' + S.log.length, ''];
    S.log.slice().reverse().forEach(function (e) {
      z.push('[' + zeit(e.t) + '] ' + e.cat.toUpperCase() + ': ' + e.text);
      if (e.detail) z.push('    ' + e.detail);
    });
    return z.join('\n');
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

    $('startCamBtn').addEventListener('click', startKamera);
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
      var v = $('cam');
      if (!v.videoWidth) return;
      var c = document.createElement('canvas');
      c.width = v.videoWidth; c.height = v.videoHeight;
      c.getContext('2d').drawImage(v, 0, 0);
      c.toBlob(function (b) {
        if (!b) return;
        b.name = 'Kamerabild.jpg';
        go('analyse'); analysiere(b);
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
        S.lastHits = await window.Detector.detect(S.bitmap, { conf: S.conf, iou: S.iou, maxDet: 100 });
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
      var a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = 'forensik-protokoll-' + Date.now() + '.json';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    });
    $('clearLogBtn').addEventListener('click', function () { S.log = []; renderLog(); });

    window.addEventListener('resize', function () { if (S.lastHits.length && S.running) zeichne(S.lastHits); });
  }

  async function start() {
    verdrahte();
    go('live');
    renderLog();
    $('confVal').textContent = num(S.conf, 2);
    $('iouVal').textContent = num(S.iou, 2);

    if (!window.Forensics) {
      notice('crit', 'Forensik-Modul fehlt', 'js/forensics.js wurde nicht geladen. Die Analyse-Funktionen stehen nicht zur Verfügung.');
    }
    try {
      await ladeModellDaten();
      await initDetector('live');
    } catch (err) {
      S.detectorReady = false;
      $('brandSub').textContent = 'Erkennung nicht verfügbar';
      notice('crit', 'Objekterkennung nicht verfügbar', err.message +
        ' Die forensische Analyse einzelner Bilder funktioniert davon unabhängig weiter.');
      log('fehler', 'Erkennung konnte nicht starten', err.message);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
