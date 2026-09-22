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
    bericht: null, filter: null, ghosts: null,
    zoom: 1, panX: 0, panY: 0,
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

  /** Wendet den Klassenfilter an. null bedeutet: alles durchlassen. */
  function filtere(hits) {
    if (!S.filter || !S.filter.size) return hits;
    return hits.filter(function (d) { return S.filter.has(d.classId); });
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
        var roh = await window.Detector.detect(v, { conf: S.conf, iou: S.iou, maxDet: 60 });
        var hits = filtere(roh);
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
      copymove: 'Rot markierte Blöcke gleichen weit entfernten Blöcken.',
      blockraster: 'Rot markierte Kacheln haben ein anders ausgerichtetes 8×8-Raster als das Gesamtbild.',
      ghosts: 'Farbe je Kachel nach der Qualitätsstufe, bei der ihre Differenz einbricht. Ein abweichend gefärbter, zusammenhängender Bereich ist verdächtig.' };
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
    S.ghosts = null;
    $('ghostPanel').hidden = true;
    document.querySelectorAll('#viewSeg button[data-layer="ghosts"]').forEach(function (b) { b.disabled = true; });
    S.layer = 'original';
    zoomZurueck();
    $('zoomBar').hidden = false;
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

    stage.addEventListener('pointerdown', function (e) {
      if (!S.bitmap) return;
      stage.setPointerCapture(e.pointerId);
      zeiger.set(e.pointerId, lokal(e));
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
      zeiger.delete(e.pointerId);
      if (zeiger.size < 2) startAbstand = 0;
      if (!zeiger.size) stage.classList.remove('is-panning');
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
    var a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = 'analysebericht-' + name + '-' + Date.now() + '.html';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
    log('bericht', 'Analysebericht gesichert', a.download);
    toast('Bericht gesichert. Im Browser öffnen und bei Bedarf als PDF drucken.');
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
      var a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = 'forensik-protokoll-' + Date.now() + '.json';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    });
    $('clearLogBtn').addEventListener('click', function () { S.log = []; renderLog(); });

    verdrahteZoom();

    $('compareBtn').addEventListener('click', function () { $('compareInput').click(); });
    $('compareInput').addEventListener('change', function () {
      if (this.files && this.files[0]) vergleicheMit(this.files[0]);
      this.value = '';
    });
    $('reportBtn').addEventListener('click', sichereBericht);
    $('ghostBtn').addEventListener('click', starteGhosts);

    $('classSearch').addEventListener('input', function () { baueKlassenChips(this.value); });
    $('clearFilterBtn').addEventListener('click', function () {
      S.filter = null;
      $('classSearch').value = '';
      baueKlassenChips('');
      aktualisiereFilterHinweis();
    });

    window.addEventListener('resize', function () {
      if (S.lastHits.length && S.running) zeichne(S.lastHits);
      wendeZoomAn();
    });
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
      baueKlassenChips('');
      aktualisiereFilterHinweis();
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
