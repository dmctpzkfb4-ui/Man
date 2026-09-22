/*
 * detector.js - On-Device-Objekterkennung (YOLO26n / COCO-80) mit ONNX Runtime Web.
 *
 * Diese Datei hat zwei Haelften:
 *
 *   1. DetectorCore - reine, seiteneffektfreie Funktionen (Letterbox-Mathematik,
 *      Koordinaten-Rueckrechnung, NMS, Ausgabeform-Erkennung, Decoder).
 *      Laeuft im Hauptthread, im Web Worker (via importScripts) UND in Node
 *      (via require), damit die Mathematik ohne Browser testbar ist.
 *
 *   2. window.Detector - die Fassade fuer den Hauptthread. Sie besitzt den
 *      Web Worker, zeichnet das Letterbox-Bild und reicht die Pixel per
 *      Transferable an den Worker weiter. Sie wird NUR installiert, wenn
 *      tatsaechlich ein DOM vorhanden ist.
 *
 * Bezeichner sind englisch, Kommentare und Fehlertexte deutsch.
 */
(function (globalScope) {
  'use strict';

  /* ------------------------------------------------------------------ *
   * TEIL 1 - Reiner Kern (browser- und Node-testbar)
   * ------------------------------------------------------------------ */

  /** Fuellfarbe der Letterbox-Raender (Ultralytics-Konvention). */
  var PAD_COLOR = { r: 114, g: 114, b: 114 };

  /** Ab so vielen Kandidaten wird vor der NMS auf die besten gekuerzt. */
  var MAX_NMS_CANDIDATES = 3000;

  /**
   * Berechnet die Letterbox-Geometrie: Seitenverhaeltnis bleibt erhalten,
   * der Rest wird grau aufgefuellt.
   *
   * Bewusst OHNE Rundung auf ganze Pixel: drawImage() nimmt Gleitkommazahlen
   * entgegen, und nur so ist die Rueckrechnung exakt umkehrbar.
   *
   * @param {number} srcWidth  Breite des Quellbildes in Pixeln
   * @param {number} srcHeight Hoehe des Quellbildes in Pixeln
   * @param {number} inputSize Kantenlaenge des quadratischen Modelleingangs
   * @returns {{scale:number, drawWidth:number, drawHeight:number, padX:number,
   *            padY:number, inputSize:number, srcWidth:number, srcHeight:number}}
   */
  function computeLetterbox(srcWidth, srcHeight, inputSize) {
    if (!(srcWidth > 0) || !(srcHeight > 0)) {
      throw new Error('Letterbox: ungueltige Quellgroesse ' + srcWidth + 'x' + srcHeight + '.');
    }
    if (!(inputSize > 0)) {
      throw new Error('Letterbox: ungueltige Modellgroesse ' + inputSize + '.');
    }
    var scale = Math.min(inputSize / srcWidth, inputSize / srcHeight);
    var drawWidth = srcWidth * scale;
    var drawHeight = srcHeight * scale;
    return {
      scale: scale,
      drawWidth: drawWidth,
      drawHeight: drawHeight,
      padX: (inputSize - drawWidth) / 2,
      padY: (inputSize - drawHeight) / 2,
      inputSize: inputSize,
      srcWidth: srcWidth,
      srcHeight: srcHeight
    };
  }

  /**
   * Quellpixel -> Modellraum (Letterbox). Wird fuer Tests und zum Debuggen
   * gebraucht, die Gegenrichtung ist der eigentliche Produktivpfad.
   *
   * @param {{x:number,y:number,w:number,h:number}} box Box in Quellpixeln
   * @param {object} lb Ergebnis von computeLetterbox()
   * @returns {{x1:number,y1:number,x2:number,y2:number}} Box im Modellraum
   */
  function sourceBoxToLetterbox(box, lb) {
    return {
      x1: box.x * lb.scale + lb.padX,
      y1: box.y * lb.scale + lb.padY,
      x2: (box.x + box.w) * lb.scale + lb.padX,
      y2: (box.y + box.h) * lb.scale + lb.padY
    };
  }

  /**
   * Modellraum (Letterbox) -> Quellpixel. DAS ist die Stelle, an der die
   * meisten Implementierungen falsch liegen: erst das Padding abziehen,
   * DANN durch den Skalierungsfaktor teilen - nicht umgekehrt.
   *
   * Anschliessend wird auf die Bildgrenzen geklemmt, damit Boxen, die in den
   * grauen Rand ragen, nicht ausserhalb des Quellbildes landen.
   *
   * @returns {{x:number,y:number,w:number,h:number}} Box in Quellpixeln
   */
  function letterboxBoxToSource(x1, y1, x2, y2, lb) {
    var sx1 = (x1 - lb.padX) / lb.scale;
    var sy1 = (y1 - lb.padY) / lb.scale;
    var sx2 = (x2 - lb.padX) / lb.scale;
    var sy2 = (y2 - lb.padY) / lb.scale;

    // Falls das Modell die Ecken vertauscht liefert, wieder ordnen.
    if (sx2 < sx1) { var tx = sx1; sx1 = sx2; sx2 = tx; }
    if (sy2 < sy1) { var ty = sy1; sy1 = sy2; sy2 = ty; }

    sx1 = clamp(sx1, 0, lb.srcWidth);
    sy1 = clamp(sy1, 0, lb.srcHeight);
    sx2 = clamp(sx2, 0, lb.srcWidth);
    sy2 = clamp(sy2, 0, lb.srcHeight);

    return { x: sx1, y: sy1, w: sx2 - sx1, h: sy2 - sy1 };
  }

  function clamp(value, low, high) {
    return value < low ? low : (value > high ? high : value);
  }

  /** Schnittmenge ueber Vereinigung zweier Boxen im xyxy-Format. */
  function iou(a, b) {
    var ix1 = a.x1 > b.x1 ? a.x1 : b.x1;
    var iy1 = a.y1 > b.y1 ? a.y1 : b.y1;
    var ix2 = a.x2 < b.x2 ? a.x2 : b.x2;
    var iy2 = a.y2 < b.y2 ? a.y2 : b.y2;
    var iw = ix2 - ix1;
    var ih = iy2 - iy1;
    if (iw <= 0 || ih <= 0) return 0;
    var inter = iw * ih;
    var areaA = (a.x2 - a.x1) * (a.y2 - a.y1);
    var areaB = (b.x2 - b.x1) * (b.y2 - b.y1);
    var union = areaA + areaB - inter;
    return union > 0 ? inter / union : 0;
  }

  /**
   * Klassenweise Non-Maximum-Suppression, eigene Implementierung.
   *
   * Vorgehen: nach Score absteigend sortieren, dann gierig von oben nach
   * unten durchgehen und jede noch nicht unterdrueckte Box derselben Klasse
   * verwerfen, deren IoU ueber dem Schwellwert liegt.
   *
   * @param {Array<{x1:number,y1:number,x2:number,y2:number,score:number,classId:number}>} candidates
   * @param {number} iouThreshold
   * @param {number} maxDet
   * @returns {Array} die behaltenen Kandidaten (dieselben Objektreferenzen)
   */
  function nonMaxSuppression(candidates, iouThreshold, maxDet) {
    var limit = (maxDet > 0) ? maxDet : Number.MAX_SAFE_INTEGER;
    if (!candidates || candidates.length === 0) return [];

    // Absteigend nach Score sortieren.
    var order = new Array(candidates.length);
    for (var k = 0; k < candidates.length; k++) order[k] = k;
    order.sort(function (a, b) { return candidates[b].score - candidates[a].score; });

    // Harte Obergrenze, damit ein entgleister Frame die NMS nicht sprengt.
    if (order.length > MAX_NMS_CANDIDATES) order.length = MAX_NMS_CANDIDATES;

    var suppressed = new Uint8Array(candidates.length);
    var kept = [];

    for (var oi = 0; oi < order.length; oi++) {
      var i = order[oi];
      if (suppressed[i]) continue;
      var a = candidates[i];
      kept.push(a);
      if (kept.length >= limit) break;
      for (var oj = oi + 1; oj < order.length; oj++) {
        var j = order[oj];
        if (suppressed[j]) continue;
        var b = candidates[j];
        if (b.classId !== a.classId) continue; // klassenweise!
        if (iou(a, b) > iouThreshold) suppressed[j] = 1;
      }
    }
    return kept;
  }

  /**
   * Bestimmt zur Laufzeit, wie der Ausgabetensor aufgebaut ist. Der
   * YOLO26-Export steht noch nicht fest, deshalb wird nichts angenommen.
   *
   * Erkannt werden:
   *   [1, 4+C, N] - YOLOv8-Stil, kanalweise ("transponiert"), xywh zentriert
   *   [1, N, 4+C] - dieselben Daten, Achsen getauscht
   *   [1, N, 6]   - End-to-End mit eingebauter NMS: x1,y1,x2,y2,score,classId
   *   [1, N, 7]   - dto. mit fuehrender batch_id-Spalte
   *   [1, 6, N] / [1, 7, N] - End-to-End, kanalweise
   *
   * @param {number[]} dims Tensorform
   * @param {number} numClasses Anzahl der Klassen (= labels.length)
   * @returns {{kind:'yolo'|'e2e', transposed:boolean, numBoxes:number,
   *            channels:number, columnOffset:number, numClasses:number,
   *            dims:number[], description:string}}
   */
  function detectOutputLayout(dims, numClasses) {
    var shape = Array.prototype.slice.call(dims).map(Number);
    // Fuehrende Batch-Dimensionen der Groesse 1 abtrennen.
    while (shape.length > 2 && shape[0] === 1) shape = shape.slice(1);
    if (shape.length === 1) shape = [1, shape[0]];
    if (shape.length !== 2) {
      throw new Error('Unbekannte Ausgabeform [' + Array.prototype.slice.call(dims).join(', ') +
        ']: erwartet wurden zwei nutzbare Achsen.');
    }

    var a = shape[0];
    var b = shape[1];
    var expected = 4 + numClasses;
    var original = Array.prototype.slice.call(dims);

    function result(kind, transposed, numBoxes, channels, columnOffset, description) {
      return {
        kind: kind,
        transposed: transposed,
        numBoxes: numBoxes,
        channels: channels,
        columnOffset: columnOffset,
        numClasses: numClasses,
        dims: original,
        description: description
      };
    }

    // Fall A/B: klassischer YOLO-Rohtensor mit 4 Box- und C Klassenwerten.
    if (b === expected && a !== expected) {
      return result('yolo', false, a, b, 0,
        'Rohausgabe [1, N, ' + expected + '] (N=' + a + ', eigene NMS noetig)');
    }
    if (a === expected && b !== expected) {
      return result('yolo', true, b, a, 0,
        'Rohausgabe [1, ' + expected + ', N] (N=' + b + ', transponiert, eigene NMS noetig)');
    }
    if (a === expected && b === expected) {
      // Quadratisch und damit mehrdeutig - wir nehmen die haeufigere Variante.
      return result('yolo', false, a, b, 0,
        'Rohausgabe [1, ' + a + ', ' + b + '] - mehrdeutig, als [1, N, ' + expected + '] gelesen');
    }

    // Fall C: End-to-End-Ausgabe mit bereits erledigter NMS.
    if (b === 6 || b === 7) {
      return result('e2e', false, a, b, b === 7 ? 1 : 0,
        'End-to-End [1, N, ' + b + '] (N=' + a + ', NMS steckt im Modell)');
    }
    if (a === 6 || a === 7) {
      return result('e2e', true, b, a, a === 7 ? 1 : 0,
        'End-to-End [1, ' + a + ', N] (N=' + b + ', transponiert, NMS steckt im Modell)');
    }

    throw new Error('Ausgabeform [' + original.join(', ') + '] wird nicht unterstuetzt. ' +
      'Erwartet: [1, ' + expected + ', N], [1, N, ' + expected + '] oder [1, N, 6].');
  }

  /**
   * Liefert den Zugriffsschritt fuer (Kanal, Box) eines Layouts.
   * value(c, i) === data[c * channelStride + i * boxStride]
   */
  function layoutStrides(layout) {
    return layout.transposed
      ? { channelStride: layout.numBoxes, boxStride: 1 }
      : { channelStride: 1, boxStride: layout.channels };
  }

  /**
   * Manche Exporte liefern Boxkoordinaten normalisiert (0..1), andere in
   * Modellpixeln (0..inputSize). Einmal pro Sitzung wird das anhand des
   * groessten beobachteten Boxwertes bestimmt.
   *
   * @returns {number} Faktor, mit dem Boxwerte zu multiplizieren sind
   */
  function probeCoordinateScale(data, layout, inputSize) {
    var s = layoutStrides(layout);
    var off = layout.kind === 'e2e' ? layout.columnOffset : 0;
    var max = 0;
    var step = layout.numBoxes > 512 ? Math.floor(layout.numBoxes / 512) : 1;
    for (var i = 0; i < layout.numBoxes; i += step) {
      for (var c = off; c < off + 4; c++) {
        var v = Math.abs(data[c * s.channelStride + i * s.boxStride]);
        if (v > max) max = v;
      }
    }
    // Alles <= 1.5 kann keine Pixelangabe bei 640er Eingang sein.
    return (max > 0 && max <= 1.5) ? inputSize : 1;
  }

  /**
   * Dekodiert den Rohtensor zu Kandidaten IM MODELLRAUM (xyxy, Letterbox-Pixel).
   * Rechnet NICHT zurueck und filtert NICHT per NMS - das macht
   * finalizeDetections(). So bleibt beides einzeln testbar.
   *
   * @param {Float32Array|number[]} data
   * @param {object} layout Ergebnis von detectOutputLayout()
   * @param {{confThreshold:number, coordScale:number}} options
   * @returns {{candidates:Array, needsNms:boolean}}
   */
  function decodeOutput(data, layout, options) {
    var confThreshold = options && typeof options.confThreshold === 'number' ? options.confThreshold : 0.25;
    var coordScale = options && typeof options.coordScale === 'number' ? options.coordScale : 1;
    var s = layoutStrides(layout);
    var candidates = [];
    var i, c, idx;

    if (layout.kind === 'e2e') {
      // Bereits fertige Boxen: x1,y1,x2,y2,score,classId (ggf. mit batch_id davor).
      var off = layout.columnOffset;
      for (i = 0; i < layout.numBoxes; i++) {
        var base = i * s.boxStride;
        var score = data[(off + 4) * s.channelStride + base];
        if (!(score >= confThreshold)) continue;
        var classId = Math.round(data[(off + 5) * s.channelStride + base]);
        if (classId < 0) continue; // Fuellzeilen des Exports
        var ex1 = data[(off + 0) * s.channelStride + base] * coordScale;
        var ey1 = data[(off + 1) * s.channelStride + base] * coordScale;
        var ex2 = data[(off + 2) * s.channelStride + base] * coordScale;
        var ey2 = data[(off + 3) * s.channelStride + base] * coordScale;
        if (!(ex2 > ex1) || !(ey2 > ey1)) continue;
        candidates.push({ x1: ex1, y1: ey1, x2: ex2, y2: ey2, score: score, classId: classId });
      }
      return { candidates: candidates, needsNms: false };
    }

    // Rohausgabe: 4 Boxwerte (xywh, zentriert) + je Klasse ein Score.
    var numClasses = layout.numClasses;
    for (i = 0; i < layout.numBoxes; i++) {
      var b = i * s.boxStride;
      var bestScore = 0;
      var bestClass = -1;
      for (c = 0; c < numClasses; c++) {
        idx = (4 + c) * s.channelStride + b;
        var v = data[idx];
        if (v > bestScore) { bestScore = v; bestClass = c; }
      }
      if (bestClass < 0 || !(bestScore >= confThreshold)) continue;
      var cx = data[0 * s.channelStride + b] * coordScale;
      var cy = data[1 * s.channelStride + b] * coordScale;
      var w = data[2 * s.channelStride + b] * coordScale;
      var h = data[3 * s.channelStride + b] * coordScale;
      if (!(w > 0) || !(h > 0)) continue;
      candidates.push({
        x1: cx - w / 2, y1: cy - h / 2,
        x2: cx + w / 2, y2: cy + h / 2,
        score: bestScore, classId: bestClass
      });
    }
    return { candidates: candidates, needsNms: true };
  }

  /**
   * Letzter Schritt: ggf. NMS, dann Rueckrechnung in Quellpixel und Beschriftung.
   *
   * @param {Array} candidates Kandidaten im Modellraum (xyxy)
   * @param {{needsNms:boolean, iouThreshold:number, maxDet:number,
   *          letterbox:object, labels:string[]}} options
   * @returns {Array<{x:number,y:number,w:number,h:number,score:number,classId:number,label:string}>}
   */
  function finalizeDetections(candidates, options) {
    var maxDet = options.maxDet > 0 ? options.maxDet : 100;
    var labels = options.labels || [];
    var lb = options.letterbox;
    var kept;

    if (options.needsNms) {
      kept = nonMaxSuppression(candidates, options.iouThreshold, maxDet);
    } else {
      kept = candidates.slice().sort(function (a, b) { return b.score - a.score; });
      if (kept.length > maxDet) kept.length = maxDet;
    }

    var out = [];
    for (var i = 0; i < kept.length; i++) {
      var k = kept[i];
      var box = letterboxBoxToSource(k.x1, k.y1, k.x2, k.y2, lb);
      // Vom grauen Rand vollstaendig verschluckte Boxen fallen hier raus.
      if (!(box.w > 0) || !(box.h > 0)) continue;
      out.push({
        x: box.x,
        y: box.y,
        w: box.w,
        h: box.h,
        score: k.score,
        classId: k.classId,
        label: labels[k.classId] != null ? labels[k.classId] : ('Klasse ' + k.classId)
      });
    }
    return out;
  }

  /**
   * RGBA-Pixel (Uint8ClampedArray, wie von getImageData) -> NCHW-Float32 in [0,1].
   * Schreibt in ein bereits vorhandenes Zielarray, damit pro Frame nichts
   * Neues angelegt wird.
   *
   * @param {Uint8ClampedArray|Uint8Array} rgba
   * @param {Float32Array} target Laenge 3*size*size
   * @param {number} size Kantenlaenge
   */
  function rgbaToNchwFloat(rgba, target, size) {
    var area = size * size;
    if (target.length < area * 3) {
      throw new Error('Zielpuffer zu klein: ' + target.length + ' statt ' + (area * 3) + '.');
    }
    var gOff = area;
    var bOff = area * 2;
    for (var p = 0, i = 0; p < area; p++, i += 4) {
      target[p] = rgba[i] / 255;
      target[gOff + p] = rgba[i + 1] / 255;
      target[bOff + p] = rgba[i + 2] / 255;
    }
    return target;
  }

  var DetectorCore = {
    PAD_COLOR: PAD_COLOR,
    MAX_NMS_CANDIDATES: MAX_NMS_CANDIDATES,
    computeLetterbox: computeLetterbox,
    sourceBoxToLetterbox: sourceBoxToLetterbox,
    letterboxBoxToSource: letterboxBoxToSource,
    iou: iou,
    nonMaxSuppression: nonMaxSuppression,
    detectOutputLayout: detectOutputLayout,
    layoutStrides: layoutStrides,
    probeCoordinateScale: probeCoordinateScale,
    decodeOutput: decodeOutput,
    finalizeDetections: finalizeDetections,
    rgbaToNchwFloat: rgbaToNchwFloat,
    clamp: clamp
  };

  globalScope.DetectorCore = DetectorCore;
  // Node/CommonJS: nur der reine Kern, damit tools/test-detector.mjs ihn pruefen kann.
  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = DetectorCore;
  }

  /* ------------------------------------------------------------------ *
   * TEIL 2 - Hauptthread-Fassade (nur mit echtem DOM)
   * ------------------------------------------------------------------ */

  var hasDom = typeof window !== 'undefined' && typeof document !== 'undefined';
  if (!hasDom) return;

  // Eigene Skript-URL merken, um den Worker daneben zu finden.
  var SELF_URL = (document.currentScript && document.currentScript.src) || '';

  // Vorgabe bewusst lokal: die App soll ohne Internetverbindung arbeiten.
  // Ein CDN-Pfad kann per init({ ortUrl, wasmPaths }) uebergeben werden.
  var DEFAULT_ORT_BASE = 'vendor/';

  var state = null;

  /** Kleiner Promise-Router ueber die Worker-Nachrichten. */
  function createBridge(worker) {
    var pending = new Map();
    var nextId = 1;
    var handlers = { progress: null, notice: null, fatal: null };

    worker.onmessage = function (event) {
      var msg = event.data || {};
      if (msg.type === 'progress') {
        if (handlers.progress) handlers.progress(msg.payload);
        return;
      }
      if (msg.type === 'notice') {
        if (handlers.notice) handlers.notice(msg.payload);
        return;
      }
      var entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (msg.ok) entry.resolve(msg.payload);
      else entry.reject(new Error(msg.error || 'Unbekannter Fehler im Erkennungs-Worker.'));
    };

    worker.onerror = function (event) {
      var err = new Error('Erkennungs-Worker abgestuerzt: ' + (event && event.message ? event.message : 'unbekannt'));
      pending.forEach(function (entry) { entry.reject(err); });
      pending.clear();
      if (handlers.fatal) handlers.fatal(err);
    };

    return {
      handlers: handlers,
      send: function (type, payload, transfer) {
        var id = nextId++;
        return new Promise(function (resolve, reject) {
          pending.set(id, { resolve: resolve, reject: reject });
          try {
            worker.postMessage({ type: type, id: id, payload: payload }, transfer || []);
          } catch (err) {
            pending.delete(id);
            reject(new Error('Nachricht an den Worker fehlgeschlagen: ' + err.message));
          }
        });
      },
      rejectAll: function (err) {
        pending.forEach(function (entry) { entry.reject(err); });
        pending.clear();
      }
    };
  }

  /** Breite/Hoehe einer beliebigen Quelle ermitteln. */
  function measureSource(source) {
    if (!source) throw new Error('Keine Bildquelle uebergeben.');
    if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) {
      if (!source.videoWidth || !source.videoHeight) {
        throw new Error('Videoquelle liefert noch keine Bildgroesse (Metadaten fehlen).');
      }
      return { width: source.videoWidth, height: source.videoHeight };
    }
    if (typeof source.width === 'number' && typeof source.height === 'number' &&
        source.width > 0 && source.height > 0) {
      return { width: source.width, height: source.height };
    }
    throw new Error('Bildquelle wird nicht unterstuetzt oder hat keine Groesse.');
  }

  /** Zeichenbares Objekt aus der Quelle machen (ImageData braucht einen Umweg). */
  function toDrawable(source) {
    if (typeof ImageData !== 'undefined' && source instanceof ImageData) {
      var scratch = state.scratchCanvas;
      if (!scratch || scratch.width !== source.width || scratch.height !== source.height) {
        scratch = createCanvas(source.width, source.height);
        state.scratchCanvas = scratch;
        state.scratchCtx = scratch.getContext('2d', { willReadFrequently: true });
      }
      state.scratchCtx.putImageData(source, 0, 0);
      return scratch;
    }
    return source;
  }

  function createCanvas(width, height) {
    // OffscreenCanvas spart den Umweg ueber das DOM; sonst ein loses <canvas>.
    if (typeof OffscreenCanvas !== 'undefined') {
      try { return new OffscreenCanvas(width, height); } catch (err) { /* Rueckfall unten */ }
    }
    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  /**
   * Zeichnet die Quelle letterboxed in den wiederverwendeten Canvas.
   * Pro Frame wird NICHTS neu angelegt - das ist der Kern der Leckfreiheit.
   */
  function drawLetterbox(source, lb) {
    var ctx = state.frameCtx;
    var size = state.inputSize;
    ctx.fillStyle = 'rgb(' + PAD_COLOR.r + ',' + PAD_COLOR.g + ',' + PAD_COLOR.b + ')';
    ctx.fillRect(0, 0, size, size);
    ctx.imageSmoothingEnabled = true;
    try { ctx.imageSmoothingQuality = 'medium'; } catch (err) { /* nicht ueberall vorhanden */ }
    ctx.drawImage(
      toDrawable(source),
      0, 0, lb.srcWidth, lb.srcHeight,
      lb.padX, lb.padY, lb.drawWidth, lb.drawHeight
    );
  }

  /** Verkettet detect()-Aufrufe, damit immer nur ein Frame im Worker liegt. */
  function enqueue(task) {
    if (state.queued >= 2) {
      // Rueckstau: diesen Frame bewusst fallen lassen statt Speicher zu horten.
      state.framesDropped++;
      return Promise.resolve([]);
    }
    state.queued++;
    var run = state.chain.then(task, task);
    state.chain = run.then(noop, noop);
    return run.then(
      function (value) { state.queued--; return value; },
      function (err) { state.queued--; throw err; }
    );
  }

  function noop() {}

  var Detector = {
    /**
     * Laedt das Modell, startet den Worker und bestimmt die Ausgabeform.
     *
     * @param {{modelUrl:string, labels:string[], inputSize?:number,
     *          onProgress?:function, workerUrl?:string, ortUrl?:string,
     *          wasmPaths?:string, preferBackend?:string, closeSource?:boolean}} options
     * @returns {Promise<{backend:string, inputSize:number, outputShape:number[]}>}
     */
    init: function (options) {
      var opts = options || {};
      if (!opts.modelUrl) return Promise.reject(new Error('init(): modelUrl fehlt.'));
      if (!Array.isArray(opts.labels) || opts.labels.length === 0) {
        return Promise.reject(new Error('init(): labels fehlt oder ist leer.'));
      }

      if (state) Detector.dispose();

      var inputSize = opts.inputSize || 640;
      var labels = opts.labels.slice();
      var workerUrl;
      try {
        workerUrl = opts.workerUrl
          ? opts.workerUrl
          : (SELF_URL ? new URL('detector.worker.js', SELF_URL).href : 'js/detector.worker.js');
      } catch (err) {
        workerUrl = 'js/detector.worker.js';
      }

      var worker;
      try {
        worker = new Worker(workerUrl);
      } catch (err) {
        return Promise.reject(new Error('Erkennungs-Worker konnte nicht gestartet werden (' +
          workerUrl + '): ' + err.message));
      }

      var frameCanvas = createCanvas(inputSize, inputSize);
      var frameCtx = frameCanvas.getContext('2d', { willReadFrequently: true, alpha: false });
      if (!frameCtx) {
        worker.terminate();
        return Promise.reject(new Error('2D-Kontext fuer den Erkennungs-Canvas nicht verfuegbar.'));
      }

      state = {
        worker: worker,
        bridge: createBridge(worker),
        labels: labels,
        inputSize: inputSize,
        frameCanvas: frameCanvas,
        frameCtx: frameCtx,
        scratchCanvas: null,
        scratchCtx: null,
        onProgress: typeof opts.onProgress === 'function' ? opts.onProgress : null,
        closeSource: opts.closeSource === true,
        backend: 'unbekannt',
        outputShape: null,
        lastInferenceMs: 0,
        lastTotalMs: 0,
        framesProcessed: 0,
        framesDropped: 0,
        chain: Promise.resolve(),
        queued: 0,
        ready: false,
        // Bitmap-Pfad nur, wenn der Worker Pixel aus einem ImageBitmap lesen kann.
        useBitmapTransfer: false
      };

      state.bridge.handlers.progress = function (payload) {
        if (state && state.onProgress) {
          try { state.onProgress(payload); } catch (err) { /* UI-Fehler nicht durchreichen */ }
        }
      };
      state.bridge.handlers.notice = function (payload) {
        if (!state) return;
        if (payload && payload.backend) state.backend = payload.backend;
        if (state.onProgress) {
          try { state.onProgress(payload); } catch (err) { /* s.o. */ }
        }
      };
      state.bridge.handlers.fatal = function () {
        if (state) state.ready = false;
      };

      var ortBase = opts.wasmPaths || DEFAULT_ORT_BASE;
      var ortUrl = opts.ortUrl || (ortBase + 'ort.min.js');

      return state.bridge.send('init', {
        modelUrl: new URL(opts.modelUrl, window.location.href).href,
        inputSize: inputSize,
        numClasses: labels.length,
        // Der Worker beschriftet die Treffer selbst; ohne diese Liste
        // kaemen alle Erkennungen ohne Namen zurueck.
        labels: labels,
        ortUrl: ortUrl,
        wasmPaths: ortBase,
        preferBackend: opts.preferBackend || 'webgpu'
      }).then(function (payload) {
        if (!state) throw new Error('Detector wurde waehrend der Initialisierung verworfen.');
        state.backend = payload.backend;
        state.outputShape = payload.outputShape;
        state.firstInferenceMs = payload.firstInferenceMs;
        state.useBitmapTransfer = payload.offscreenCapable === true;
        state.ready = true;
        return {
          backend: payload.backend,
          inputSize: inputSize,
          outputShape: payload.outputShape
        };
      }).catch(function (err) {
        Detector.dispose();
        throw err;
      });
    },

    /**
     * Erkennt Objekte in einem Einzelbild.
     *
     * @param {ImageBitmap|HTMLVideoElement|HTMLCanvasElement|ImageData} source
     * @param {{conf?:number, iou?:number, maxDet?:number}} [options]
     * @returns {Promise<Array<{x:number,y:number,w:number,h:number,score:number,classId:number,label:string}>>}
     *          Koordinaten in PIXELN DES QUELLBILDES.
     */
    detect: function (source, options) {
      if (!state || !state.ready) {
        return Promise.reject(new Error('detect(): Detector ist nicht initialisiert. Erst init() aufrufen.'));
      }
      var opts = options || {};
      var conf = typeof opts.conf === 'number' ? opts.conf : 0.25;
      var iouThreshold = typeof opts.iou === 'number' ? opts.iou : 0.45;
      var maxDet = typeof opts.maxDet === 'number' ? opts.maxDet : 100;

      return enqueue(function () {
        if (!state || !state.ready) {
          throw new Error('detect(): Detector wurde zwischenzeitlich verworfen.');
        }
        var started = now();
        var size;
        try {
          size = measureSource(source);
        } catch (err) {
          maybeCloseSource(source);
          throw err;
        }

        var lb = computeLetterbox(size.width, size.height, state.inputSize);
        drawLetterbox(source, lb);
        maybeCloseSource(source);

        var request = {
          conf: conf,
          iou: iouThreshold,
          maxDet: maxDet,
          letterbox: lb
        };

        return handOverFrame(request).then(function (payload) {
          if (!state) return [];
          state.lastInferenceMs = payload.inferenceMs;
          state.lastTotalMs = now() - started;
          state.framesProcessed++;
          if (payload.backend) state.backend = payload.backend;
          return payload.detections;
        });
      });
    },

    /**
     * Fuehrt (falls noch nicht geschehen) die erste Inferenz aus und gibt
     * deren Dauer in Millisekunden zurueck.
     *
     * @returns {Promise<number>}
     */
    warmup: function () {
      if (!state || !state.ready) {
        return Promise.reject(new Error('warmup(): Detector ist nicht initialisiert.'));
      }
      return state.bridge.send('warmup', {}).then(function (payload) {
        if (state) {
          state.firstInferenceMs = payload.firstInferenceMs;
          if (payload.backend) state.backend = payload.backend;
        }
        return payload.firstInferenceMs;
      });
    },

    /** Worker beenden, Canvas und Warteschlange freigeben. */
    dispose: function () {
      if (!state) return;
      var dead = state;
      state = null;
      dead.ready = false;
      try { dead.bridge.rejectAll(new Error('Detector wurde beendet (dispose()).')); } catch (err) { /* egal */ }
      try {
        dead.worker.onmessage = null;
        dead.worker.onerror = null;
        dead.worker.terminate();
      } catch (err) { /* egal */ }
      // Canvas auf 0x0 schrumpfen: gibt den Bildspeicher sofort frei.
      try { dead.frameCanvas.width = 0; dead.frameCanvas.height = 0; } catch (err) { /* egal */ }
      if (dead.scratchCanvas) {
        try { dead.scratchCanvas.width = 0; dead.scratchCanvas.height = 0; } catch (err) { /* egal */ }
      }
    },

    get stats() {
      return {
        lastInferenceMs: state ? state.lastInferenceMs : 0,
        lastTotalMs: state ? state.lastTotalMs : 0,
        backend: state ? state.backend : 'aus',
        framesProcessed: state ? state.framesProcessed : 0,
        framesDropped: state ? state.framesDropped : 0
      };
    },

    /** Der reine Kern, auch im Browser zugaenglich (Tests, Debugging). */
    core: DetectorCore
  };

  /**
   * Uebergibt den gezeichneten Frame an den Worker - immer als Transferable,
   * also ohne die Pixel zu kopieren.
   *
   * Bevorzugt wird ein ImageBitmap (der Hauptthread liest dann gar keine
   * Pixel zurueck). Kann der Worker kein OffscreenCanvas, faellt es auf
   * getImageData zurueck und uebergibt den ArrayBuffer.
   */
  function handOverFrame(request) {
    var size = state.inputSize;

    if (state.useBitmapTransfer && typeof state.frameCanvas.transferToImageBitmap === 'function') {
      var bitmap = state.frameCanvas.transferToImageBitmap();
      request.bitmap = bitmap;
      return state.bridge.send('detect', request, [bitmap]);
    }

    if (state.useBitmapTransfer && typeof createImageBitmap === 'function') {
      return createImageBitmap(state.frameCanvas).then(function (bmp) {
        request.bitmap = bmp;
        return state.bridge.send('detect', request, [bmp]);
      });
    }

    var imageData = state.frameCtx.getImageData(0, 0, size, size);
    request.pixels = imageData.data.buffer;
    request.width = size;
    request.height = size;
    return state.bridge.send('detect', request, [imageData.data.buffer]);
  }

  /** Vom Aufrufer uebergebene ImageBitmaps nur schliessen, wenn gewuenscht. */
  function maybeCloseSource(source) {
    if (!state || !state.closeSource) return;
    if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap &&
        typeof source.close === 'function') {
      try { source.close(); } catch (err) { /* egal */ }
    }
  }

  function now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  window.Detector = Detector;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
