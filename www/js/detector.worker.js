/*!
 * detector.worker.js — Inferenz-Worker
 * -------------------------------------------------------------
 * Laeuft in einem Web Worker, damit die Kamera-Vorschau nie ruckelt.
 * Nutzt den reinen Kern aus detector.js (dort als self.DetectorCore
 * exportiert, sobald kein DOM vorhanden ist) und ergaenzt ihn um
 * ONNX Runtime Web.
 *
 * Protokoll (vom Hauptthread definiert):
 *   herein  { type:'init'|'warmup'|'detect', id, payload }
 *   hinaus  { type:'result', id, ok:true,  payload }
 *           { type:'result', id, ok:false, error }
 *           { type:'progress'|'notice', payload }
 */
'use strict';

importScripts('detector.js');
var Core = self.DetectorCore;

var ort = null;
var session = null;
var inputName = '';
var outputName = '';
var inputSize = 640;
var numClasses = 80;
var layout = null;
var coordScale = 1;
var backend = 'unbekannt';

/* Wiederverwendete Puffer: pro Frame soll nichts Neues entstehen. */
var inputTensorData = null;
var offCanvas = null;
var offCtx = null;

function post(type, payload) { self.postMessage({ type: type, payload: payload }); }
function progress(phase, value, text) { post('progress', { phase: phase, value: value, text: text }); }
function notice(level, text) { post('notice', { level: level, text: text }); }

/* ---------------------------------------------------------------- Kamera-
 * unabhaengige Zeichenflaeche im Worker. Fehlt OffscreenCanvas, faellt der
 * Hauptthread automatisch auf die Uebergabe roher Pixel zurueck.
 * ---------------------------------------------------------------------- */
function ensureCanvas(size) {
  if (offCanvas && offCanvas.width === size) return true;
  if (typeof OffscreenCanvas !== 'function') return false;
  try {
    offCanvas = new OffscreenCanvas(size, size);
    offCtx = offCanvas.getContext('2d', { willReadFrequently: true });
    return !!offCtx;
  } catch (err) { return false; }
}

function offscreenCapable() {
  return typeof OffscreenCanvas === 'function' && ensureCanvas(inputSize);
}

/* ------------------------------------------------------------------ init */

async function createSession(modelUrl, prefer) {
  // Reihenfolge der Versuche. WebGPU nur, wenn der Adapter wirklich kommt -
  // das blosse Vorhandensein von navigator.gpu sagt nichts.
  var order = [];
  // Das mitgelieferte Bundle ist der reine WASM-Build. Fragt man es nach
  // WebGPU, versucht es die jsep-Laufzeit nachzuladen, die es hier nicht
  // gibt - und meldet dann "no available backend found". Deshalb wird
  // WebGPU nur erwogen, wenn die Laufzeit es ueberhaupt mitbringt.
  var kannWebgpu = typeof self.ort !== 'undefined' && !!(self.ort.webgpu ||
    (self.ort.env && self.ort.env.webgpu && self.ort.env.webgpu.adapter !== undefined));
  if (prefer === 'webgpu' && kannWebgpu && typeof navigator !== 'undefined' && navigator.gpu) {
    var adapter = null;
    try { adapter = await navigator.gpu.requestAdapter(); } catch (err) { adapter = null; }
    if (adapter) order.push('webgpu');
    else notice('info', 'WebGPU ist angekuendigt, liefert aber keinen Adapter - es wird WASM verwendet.');
  }
  order.push('wasm');

  var letzterFehler = null;
  for (var i = 0; i < order.length; i++) {
    var ep = order[i];
    try {
      progress('session', 0.4, 'Starte Modell auf ' + ep.toUpperCase() + ' …');
      var s = await ort.InferenceSession.create(modelUrl, {
        executionProviders: [ep],
        graphOptimizationLevel: 'all',
        // Der Speicher-Arena von ONNX Runtime behaelt freigegebene Bloecke,
        // um spaetere Laeufe zu beschleunigen. Bei Dauerbetrieb waechst er
        // dadurch auf ein Vielfaches und gibt nie etwas zurueck - auf einem
        // Telefon beendet das System die App irgendwann. Ohne Arena wird je
        // Lauf frisch belegt und wieder freigegeben: etwas langsamer, aber
        // der Bedarf bleibt flach.
        enableCpuMemArena: false,
        executionMode: 'sequential'
      });
      backend = ep;
      return s;
    } catch (err) {
      letzterFehler = err;
      if (i < order.length - 1) {
        notice('warn', ep.toUpperCase() + ' ist fehlgeschlagen, es wird auf ' +
          order[i + 1].toUpperCase() + ' zurueckgefallen.');
      }
    }
  }
  throw new Error('Kein Ausfuehrungs-Backend verfuegbar: ' +
    (letzterFehler && letzterFehler.message ? letzterFehler.message : 'unbekannt'));
}

async function handleInit(p) {
  inputSize = p.inputSize || 640;
  numClasses = p.numClasses || 80;

  progress('laden', 0.1, 'Lade Laufzeitumgebung …');
  importScripts(p.ortUrl);
  ort = self.ort;
  if (!ort) throw new Error('ONNX Runtime konnte nicht geladen werden.');

  // Einzel-Thread: WebViews auf Android und iOS sind nicht cross-origin-isoliert,
  // ohne SharedArrayBuffer wuerde Multi-Threading hart scheitern.
  try {
    ort.env.wasm.wasmPaths = p.wasmPaths;
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.simd = true;
    ort.env.logLevel = 'error';
  } catch (err) { /* aeltere Fassungen kennen nicht jede Option */ }

  progress('modell', 0.25, 'Lade Modell …');
  session = await createSession(p.modelUrl, p.preferBackend);
  inputName = session.inputNames[0];
  outputName = session.outputNames[0];

  inputTensorData = new Float32Array(3 * inputSize * inputSize);

  // Erster Lauf mit Nullen: liefert die tatsaechliche Ausgabeform und
  // waermt gleichzeitig die Kernel auf.
  progress('pruefen', 0.8, 'Bestimme Ausgabeform …');
  var t0 = performance.now();
  var probe = await session.run(mkFeeds(inputTensorData));
  var firstInferenceMs = performance.now() - t0;

  var out = probe[outputName];
  layout = Core.detectOutputLayout(out.dims, numClasses);
  coordScale = Core.probeCoordinateScale(out.data, layout, inputSize);

  notice('info', 'Ausgabeform ' + JSON.stringify(out.dims) + ' erkannt als ' +
    (layout.kind === 'e2e' ? 'End-to-End mit eingebauter NMS' : 'YOLO-Raster, NMS clientseitig') + '.');

  progress('fertig', 1, 'Bereit.');
  return {
    backend: backend,
    outputShape: Array.prototype.slice.call(out.dims),
    firstInferenceMs: Math.round(firstInferenceMs),
    offscreenCapable: offscreenCapable()
  };
}

function mkFeeds(data) {
  var feeds = {};
  feeds[inputName] = new ort.Tensor('float32', data, [1, 3, inputSize, inputSize]);
  return feeds;
}

/* ---------------------------------------------------------------- detect */

function pixelsFromPayload(p) {
  if (p.bitmap) {
    if (!ensureCanvas(inputSize)) throw new Error('Worker kann kein OffscreenCanvas anlegen.');
    offCtx.drawImage(p.bitmap, 0, 0);
    if (p.bitmap.close) p.bitmap.close();
    return offCtx.getImageData(0, 0, inputSize, inputSize).data;
  }
  if (p.pixels) return new Uint8ClampedArray(p.pixels);
  throw new Error('Nachricht enthaelt weder bitmap noch pixels.');
}

async function handleDetect(p) {
  if (!session) throw new Error('Modell ist nicht geladen.');

  var rgba = pixelsFromPayload(p);
  Core.rgbaToNchwFloat(rgba, inputTensorData, inputSize);

  var t0 = performance.now();
  var out;
  try {
    out = await session.run(mkFeeds(inputTensorData));
  } catch (err) {
    // Ein WebGPU-Kontextverlust darf die App nicht toeten - einmal auf WASM
    // wechseln und den Frame verwerfen.
    if (backend === 'webgpu') {
      notice('warn', 'WebGPU ist waehrend des Betriebs ausgefallen. Es wird auf WASM gewechselt.');
      session = await ort.InferenceSession.create(self.__modelUrl, { executionProviders: ['wasm'] });
      backend = 'wasm';
      inputName = session.inputNames[0];
      outputName = session.outputNames[0];
      out = await session.run(mkFeeds(inputTensorData));
    } else {
      throw err;
    }
  }
  var inferenceMs = performance.now() - t0;

  var tensor = out[outputName];
  if (!layout) layout = Core.detectOutputLayout(tensor.dims, numClasses);

  var decoded = Core.decodeOutput(tensor.data, layout, {
    confThreshold: p.conf,
    coordScale: coordScale
  });

  var detections = Core.finalizeDetections(decoded.candidates, {
    needsNms: decoded.needsNms,
    iouThreshold: p.iou,
    maxDet: p.maxDet,
    letterbox: p.letterbox,
    labels: self.__labels || []
  });

  return { detections: detections, inferenceMs: Math.round(inferenceMs), backend: backend };
}

/* --------------------------------------------------------------- warmup */

async function handleWarmup() {
  if (!session) throw new Error('Modell ist nicht geladen.');
  var t0 = performance.now();
  await session.run(mkFeeds(inputTensorData));
  return { ms: Math.round(performance.now() - t0) };
}

/* ------------------------------------------------------------- Verteiler */

self.onmessage = async function (event) {
  var msg = event.data || {};
  var id = msg.id;
  try {
    var payload;
    if (msg.type === 'init') {
      self.__modelUrl = msg.payload.modelUrl;
      self.__labels = msg.payload.labels || null;
      payload = await handleInit(msg.payload);
    } else if (msg.type === 'detect') {
      payload = await handleDetect(msg.payload);
    } else if (msg.type === 'warmup') {
      payload = await handleWarmup();
    } else {
      throw new Error('Unbekannter Nachrichtentyp: ' + msg.type);
    }
    self.postMessage({ type: 'result', id: id, ok: true, payload: payload });
  } catch (err) {
    self.postMessage({
      type: 'result', id: id, ok: false,
      error: (err && err.message) ? err.message : String(err)
    });
  }
};
