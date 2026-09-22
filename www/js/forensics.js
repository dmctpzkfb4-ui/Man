/*!
 * forensics.js — Modul für digitale Bildforensik
 * -------------------------------------------------------------
 * Reines Vanilla-JavaScript, keine Abhängigkeiten, kein Build-Schritt.
 * Läuft direkt per <script src="js/forensics.js"> in Browser und
 * Android-/iOS-WebView. Es findet KEIN Netzwerkzugriff statt – jede
 * Analyse passiert ausschließlich auf dem Gerät.
 *
 * Öffentliche API siehe ganz unten (window.Forensics).
 *
 * Grundregel im ganzen Modul: keine Ausnahme verlässt das Modul.
 * Kaputte, fremde oder leere Dateien führen zu einer leeren, aber
 * gültigen Struktur plus einem erklärenden Hinweis ("Finding").
 */
(function (root) {
  'use strict';

  var VERSION = '1.0.0';

  /* =========================================================================
   * 0. Kleine Helfer
   * ========================================================================= */

  /** Gibt die Kontrolle kurz an die Oberfläche zurück (verhindert Einfrieren). */
  function yieldToUi() {
    return new Promise(function (r) { setTimeout(r, 0); });
  }

  /** Sicherer Aufruf eines optionalen Fortschritts-Callbacks (0..1). */
  function reportProgress(cb, phase, value) {
    if (typeof cb !== 'function') return;
    try { cb({ phase: phase, value: Math.max(0, Math.min(1, value)) }); } catch (e) { /* Callback darf uns nie umbringen */ }
  }

  /** Hinweis-Liste ergänzen, ohne Dubletten. */
  function addFinding(list, level, text) {
    if (!list || !text) return list;
    for (var i = 0; i < list.length; i++) {
      if (list[i].text === text) return list;
    }
    list.push({ level: level, text: text });
    return list;
  }

  /** Zahl in deutscher Schreibweise (Dezimalkomma) als Text. */
  function deNum(value, digits) {
    if (typeof value !== 'number' || !isFinite(value)) return '';
    var s = (typeof digits === 'number') ? value.toFixed(digits) : String(value);
    if (typeof digits === 'number' && s.indexOf('.') >= 0) {
      s = s.replace(/0+$/, '').replace(/\.$/, '');
    }
    return s.replace('.', ',');
  }

  /** Auf n Nachkommastellen runden (ohne Fließkomma-Rauschen). */
  function roundTo(value, decimals) {
    if (typeof value !== 'number' || !isFinite(value)) return value;
    var f = Math.pow(10, decimals || 0);
    return Math.round(value * f) / f;
  }

  /** Bytes als Latin-1/ASCII-Text lesen (EXIF-ASCII ist genau das). */
  function bytesToLatin1(bytes, start, length) {
    var s = '';
    var end = Math.min(bytes.length, start + length);
    for (var i = start; i < end; i++) {
      var c = bytes[i];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }

  /** Prüft, ob an Position `at` die ASCII-Signatur `sig` steht. */
  function hasSignature(bytes, at, sig) {
    if (at < 0 || at + sig.length > bytes.length) return false;
    for (var i = 0; i < sig.length; i++) {
      if (bytes[at + i] !== sig.charCodeAt(i)) return false;
    }
    return true;
  }

  /** Hex-Darstellung eines Uint8Array. */
  function toHex(bytes) {
    var hex = '';
    for (var i = 0; i < bytes.length; i++) {
      var h = bytes[i].toString(16);
      hex += (h.length === 1 ? '0' : '') + h;
    }
    return hex;
  }

  /**
   * Beliebige Eingabe (Blob, File, ArrayBuffer, TypedArray) zu Uint8Array.
   * Nutzt FileReader als Rückfallebene für ältere Android-WebViews ohne
   * Blob.prototype.arrayBuffer().
   */
  async function toBytes(input) {
    if (input == null) return null;
    try {
      if (input instanceof Uint8Array) return input;
      if (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer) return new Uint8Array(input);
      if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(input)) {
        return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      }
      if (typeof input.arrayBuffer === 'function') {
        return new Uint8Array(await input.arrayBuffer());
      }
      if (typeof FileReader !== 'undefined' && typeof Blob !== 'undefined' && input instanceof Blob) {
        return await new Promise(function (resolve) {
          var fr = new FileReader();
          fr.onload = function () {
            try { resolve(new Uint8Array(fr.result)); } catch (e) { resolve(null); }
          };
          fr.onerror = function () { resolve(null); };
          try { fr.readAsArrayBuffer(input); } catch (e) { resolve(null); }
        });
      }
    } catch (e) { /* unten: null */ }
    return null;
  }

  /** Blob aus Bytes bauen – falls die Umgebung Blob kennt. */
  function bytesToBlob(bytes, mime) {
    if (!bytes || typeof Blob === 'undefined') return null;
    try {
      // Kopie, damit der Blob nicht auf einen größeren Puffer zeigt.
      var copy = new Uint8Array(bytes.length);
      copy.set(bytes);
      return new Blob([copy], { type: mime || 'application/octet-stream' });
    } catch (e) { return null; }
  }

  /* =========================================================================
   * 1. Prüfsummen (SHA-256 / SHA-1)
   *    crypto.subtle wenn verfügbar, sonst reine JS-Implementierung.
   *    Die JS-Variante arbeitet blockweise und gibt zwischendurch die
   *    Kontrolle an die Oberfläche zurück.
   * ========================================================================= */

  var K256 = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);

  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
  function rotl(x, n) { return (x << n) | (x >>> (32 - n)); }

  /** Baut den letzten (gepolsterten) Block-Schwanz einer Nachricht. */
  function buildTail(bytes, fullBlocks, blockSize) {
    var rest = bytes.length - fullBlocks * blockSize;
    var tailLen = (rest + 9 <= blockSize) ? blockSize : blockSize * 2;
    var tail = new Uint8Array(tailLen);
    tail.set(bytes.subarray(fullBlocks * blockSize), 0);
    tail[rest] = 0x80;
    // Bitlänge als 64-Bit-Big-Endian (Dateien > 512 MB werden korrekt behandelt)
    var bitLen = bytes.length * 8;
    var hi = Math.floor(bitLen / 4294967296);
    var lo = bitLen >>> 0;
    var p = tailLen - 8;
    tail[p] = (hi >>> 24) & 0xff; tail[p + 1] = (hi >>> 16) & 0xff;
    tail[p + 2] = (hi >>> 8) & 0xff; tail[p + 3] = hi & 0xff;
    tail[p + 4] = (lo >>> 24) & 0xff; tail[p + 5] = (lo >>> 16) & 0xff;
    tail[p + 6] = (lo >>> 8) & 0xff; tail[p + 7] = lo & 0xff;
    return tail;
  }

  function sha256Block(h, b, off, w) {
    var i;
    for (i = 0; i < 16; i++) {
      var o = off + i * 4;
      w[i] = ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
    }
    for (i = 16; i < 64; i++) {
      var x = w[i - 15], y = w[i - 2];
      var s0 = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
      var s1 = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) >>> 0;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    var a = h[0], bb = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (i = 0; i < 64; i++) {
      var S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      var ch = ((e & f) ^ (~e & g)) >>> 0;
      var t1 = (hh + S1 + ch + K256[i] + w[i]) >>> 0;
      var S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      var maj = ((a & bb) ^ (a & c) ^ (bb & c)) >>> 0;
      var t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = bb; bb = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + bb) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }

  /** SHA-256 in reinem JavaScript, blockweise, mit Pausen für die Oberfläche. */
  async function sha256Js(bytes) {
    var h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                             0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    var w = new Uint32Array(64);
    var full = Math.floor(bytes.length / 64);
    for (var i = 0; i < full; i++) {
      sha256Block(h, bytes, i * 64, w);
      if ((i & 8191) === 8191) await yieldToUi();
    }
    var tail = buildTail(bytes, full, 64);
    for (var j = 0; j < tail.length / 64; j++) sha256Block(h, tail, j * 64, w);
    var out = new Uint8Array(32);
    for (var k = 0; k < 8; k++) {
      out[k * 4] = (h[k] >>> 24) & 0xff; out[k * 4 + 1] = (h[k] >>> 16) & 0xff;
      out[k * 4 + 2] = (h[k] >>> 8) & 0xff; out[k * 4 + 3] = h[k] & 0xff;
    }
    return toHex(out);
  }

  function sha1Block(h, b, off, w) {
    var i;
    for (i = 0; i < 16; i++) {
      var o = off + i * 4;
      w[i] = ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
    }
    for (i = 16; i < 80; i++) {
      w[i] = rotl((w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]) >>> 0, 1) >>> 0;
    }
    var a = h[0], bb = h[1], c = h[2], d = h[3], e = h[4];
    for (i = 0; i < 80; i++) {
      var f, k;
      if (i < 20) { f = ((bb & c) | (~bb & d)) >>> 0; k = 0x5a827999; }
      else if (i < 40) { f = (bb ^ c ^ d) >>> 0; k = 0x6ed9eba1; }
      else if (i < 60) { f = ((bb & c) | (bb & d) | (c & d)) >>> 0; k = 0x8f1bbcdc; }
      else { f = (bb ^ c ^ d) >>> 0; k = 0xca62c1d6; }
      var t = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
      e = d; d = c; c = rotl(bb, 30) >>> 0; bb = a; a = t;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + bb) >>> 0; h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0; h[4] = (h[4] + e) >>> 0;
  }

  /** SHA-1 in reinem JavaScript (nur für den Abgleich mit Alt-Datenbeständen). */
  async function sha1Js(bytes) {
    var h = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);
    var w = new Uint32Array(80);
    var full = Math.floor(bytes.length / 64);
    for (var i = 0; i < full; i++) {
      sha1Block(h, bytes, i * 64, w);
      if ((i & 8191) === 8191) await yieldToUi();
    }
    var tail = buildTail(bytes, full, 64);
    for (var j = 0; j < tail.length / 64; j++) sha1Block(h, tail, j * 64, w);
    var out = new Uint8Array(20);
    for (var k = 0; k < 5; k++) {
      out[k * 4] = (h[k] >>> 24) & 0xff; out[k * 4 + 1] = (h[k] >>> 16) & 0xff;
      out[k * 4 + 2] = (h[k] >>> 8) & 0xff; out[k * 4 + 3] = h[k] & 0xff;
    }
    return toHex(out);
  }

  /** Versucht crypto.subtle, fällt sonst auf die JS-Implementierung zurück. */
  async function digestHex(algo, bytes) {
    try {
      var c = (typeof crypto !== 'undefined') ? crypto : null;
      if (c && c.subtle && typeof c.subtle.digest === 'function') {
        var copy = new Uint8Array(bytes.length);
        copy.set(bytes);
        var buf = await c.subtle.digest(algo, copy.buffer);
        return toHex(new Uint8Array(buf));
      }
    } catch (e) { /* Rückfall unten */ }
    return (algo === 'SHA-1') ? await sha1Js(bytes) : await sha256Js(bytes);
  }

  /**
   * hash(fileOrBlob) -> { sha256, sha1, bytes }
   * Prüfsummen zur Identifikation/Unverändertheit einer Datei.
   */
  async function hash(fileOrBlob) {
    var result = { sha256: '', sha1: '', bytes: 0 };
    try {
      var b = await toBytes(fileOrBlob);
      if (!b) { result.error = 'Datei konnte nicht gelesen werden.'; return result; }
      result.bytes = b.length;
      result.sha256 = await digestHex('SHA-256', b);
      await yieldToUi();
      result.sha1 = await digestHex('SHA-1', b);
    } catch (e) {
      result.error = 'Prüfsumme konnte nicht berechnet werden.';
    }
    return result;
  }

  /* =========================================================================
   * 2. TIFF-/EXIF-Parser (selbst geschrieben, keine Bibliothek)
   *    Aufbau: TIFF-Header (Byte-Reihenfolge II/MM, Magic 42, Offset IFD0)
   *            -> IFD0 -> optional EXIF-SubIFD, GPS-IFD, Interop-IFD
   *            -> IFD1 (enthält üblicherweise das Vorschaubild)
   * ========================================================================= */

  // Größe eines TIFF-Datentyps in Bytes (Index = Typnummer)
  var TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

  // Tags in IFD0/IFD1 (TIFF-Basis)
  var TAGS_IFD0 = {
    // Zeiger auf das eingebettete Vorschaubild in IFD1 - ohne diese
    // beiden Tags laesst sich das Thumbnail nicht herausloesen.
    0x0201: 'jpegInterchangeFormat', 0x0202: 'jpegInterchangeFormatLength',
    0x0100: 'imageWidth', 0x0101: 'imageHeight', 0x0102: 'bitsPerSample', 0x0103: 'compression',
    0x0106: 'photometricInterpretation', 0x010E: 'imageDescription', 0x010F: 'make', 0x0110: 'model',
    0x0112: 'orientation', 0x011A: 'xResolution', 0x011B: 'yResolution', 0x0128: 'resolutionUnit',
    0x0131: 'software', 0x0132: 'dateTime', 0x013B: 'artist', 0x013E: 'whitePoint',
    0x0201: 'thumbOffset', 0x0202: 'thumbLength', 0x8298: 'copyright',
    0x8769: 'exifIfdPointer', 0x8825: 'gpsIfdPointer', 0xC4A5: 'printImageMatching'
  };

  // Tags im EXIF-SubIFD
  var TAGS_EXIF = {
    0x829A: 'exposureTime', 0x829D: 'fNumber', 0x8822: 'exposureProgram', 0x8827: 'iso',
    0x8830: 'sensitivityType', 0x8832: 'recommendedExposureIndex', 0x9000: 'exifVersion',
    0x9003: 'dateTimeOriginal', 0x9004: 'dateTimeDigitized', 0x9010: 'offsetTime',
    0x9011: 'offsetTimeOriginal', 0x9201: 'shutterSpeedValue', 0x9202: 'apertureValue',
    0x9203: 'brightnessValue', 0x9204: 'exposureBias', 0x9205: 'maxAperture', 0x9206: 'subjectDistance',
    0x9207: 'meteringMode', 0x9208: 'lightSource', 0x9209: 'flash', 0x920A: 'focalLength',
    0x927C: 'makerNote', 0x9286: 'userComment', 0x9290: 'subSecTime', 0x9291: 'subSecTimeOriginal',
    0xA001: 'colorSpace', 0xA002: 'pixelXDimension', 0xA003: 'pixelYDimension',
    0xA20E: 'focalPlaneXResolution', 0xA20F: 'focalPlaneYResolution', 0xA210: 'focalPlaneResolutionUnit',
    0xA402: 'exposureMode', 0xA403: 'whiteBalance', 0xA404: 'digitalZoomRatio',
    0xA405: 'focalLengthIn35mm', 0xA406: 'sceneCaptureType', 0xA408: 'contrast',
    0xA409: 'saturation', 0xA40A: 'sharpness', 0xA420: 'imageUniqueId', 0xA430: 'cameraOwnerName',
    0xA431: 'bodySerialNumber', 0xA432: 'lensSpecification', 0xA433: 'lensMake',
    0xA434: 'lensModel', 0xA435: 'lensSerialNumber', 0xA005: 'interopIfdPointer'
  };

  // Tags im GPS-IFD
  var TAGS_GPS = {
    0x0000: 'gpsVersionId', 0x0001: 'gpsLatitudeRef', 0x0002: 'gpsLatitude',
    0x0003: 'gpsLongitudeRef', 0x0004: 'gpsLongitude', 0x0005: 'gpsAltitudeRef',
    0x0006: 'gpsAltitude', 0x0007: 'gpsTimeStamp', 0x0008: 'gpsSatellites', 0x0009: 'gpsStatus',
    0x000A: 'gpsMeasureMode', 0x000B: 'gpsDop', 0x000C: 'gpsSpeedRef', 0x000D: 'gpsSpeed',
    0x000E: 'gpsTrackRef', 0x000F: 'gpsTrack', 0x0010: 'gpsImgDirectionRef', 0x0011: 'gpsImgDirection',
    0x001B: 'gpsProcessingMethod', 0x001D: 'gpsDateStamp'
  };

  /**
   * Liest den Wert eines IFD-Eintrags.
   * Rückgabe: { value: <Skalar|Array>, ratios: [[zähler,nenner], …]|null } oder null.
   */
  function readEntryValue(dv, bytes, little, type, count, valuePos) {
    var size = TYPE_SIZE[type];
    if (!size) return null;                       // unbekannter Typ -> überspringen
    if (count < 0 || count > 200000) return null; // unplausibel -> überspringen
    var total = size * count;
    var pos = valuePos;
    if (total > 4) {
      if (valuePos + 4 > bytes.length) return null;
      pos = dv.getUint32(valuePos, little);
    }
    if (pos < 0 || pos + total > bytes.length) return null;

    // ASCII bzw. undefinierte Bytes
    if (type === 2) return { value: bytesToLatin1(bytes, pos, count).replace(/[\u0000-\u001f]+$/, '').trim(), ratios: null };
    if (type === 7) {
      var rawSlice = bytes.subarray(pos, pos + total);
      return { value: rawSlice, ratios: null, undefinedBytes: true };
    }

    var values = [];
    var ratios = null;
    for (var i = 0; i < count; i++) {
      var o = pos + i * size;
      switch (type) {
        case 1: values.push(bytes[o]); break;                         // BYTE
        case 3: values.push(dv.getUint16(o, little)); break;          // SHORT
        case 4: values.push(dv.getUint32(o, little)); break;          // LONG
        case 6: values.push(dv.getInt8(o)); break;                    // SBYTE
        case 8: values.push(dv.getInt16(o, little)); break;           // SSHORT
        case 9: values.push(dv.getInt32(o, little)); break;           // SLONG
        case 11: values.push(dv.getFloat32(o, little)); break;        // FLOAT
        case 12: values.push(dv.getFloat64(o, little)); break;        // DOUBLE
        case 5:                                                       // RATIONAL
        case 10: {                                                    // SRATIONAL
          var num = (type === 5) ? dv.getUint32(o, little) : dv.getInt32(o, little);
          var den = (type === 5) ? dv.getUint32(o + 4, little) : dv.getInt32(o + 4, little);
          if (!ratios) ratios = [];
          ratios.push([num, den]);
          values.push(den === 0 ? 0 : num / den);
          break;
        }
        default: return null;
      }
    }
    return { value: (count === 1 ? values[0] : values), ratios: ratios };
  }

  /**
   * Läuft ein IFD durch und meldet jeden Eintrag an `collect`.
   * Gibt den Offset des nächsten IFD zurück (0 = keins).
   */
  function walkIfd(dv, bytes, little, offset, visited, collect) {
    if (!(offset > 0) || offset + 2 > bytes.length) return 0;
    if (visited[offset]) return 0;   // Schutz gegen Endlosschleifen bei kaputten Dateien
    visited[offset] = true;
    var count = dv.getUint16(offset, little);
    if (count > 1024) return 0;      // unplausibel viele Einträge -> abbrechen
    for (var i = 0; i < count; i++) {
      var e = offset + 2 + i * 12;
      if (e + 12 > bytes.length) break;
      var tag = dv.getUint16(e, little);
      var type = dv.getUint16(e + 2, little);
      var n = dv.getUint32(e + 4, little);
      var v = readEntryValue(dv, bytes, little, type, n, e + 8);
      if (v) collect(tag, type, n, v);
    }
    var nextPos = offset + 2 + count * 12;
    if (nextPos + 4 > bytes.length) return 0;
    return dv.getUint32(nextPos, little);
  }

  /**
   * Parst einen kompletten TIFF-Block (das, was nach "Exif\0\0" steht).
   * Rückgabe: { ok, little, raw:{}, gps:{}, ifd1:{}, tagCount }
   * raw/gps/ifd1 sind nach kanonischen englischen Schlüsseln abgelegt;
   * jeder Eintrag hat die Form { value, ratios }.
   */
  function parseTiffBlock(bytes) {
    var res = { ok: false, little: true, raw: {}, gps: {}, ifd1: {}, tagCount: 0, tiff: bytes };
    try {
      if (!bytes || bytes.length < 8) return res;
      var little;
      if (bytes[0] === 0x49 && bytes[1] === 0x49) little = true;
      else if (bytes[0] === 0x4D && bytes[1] === 0x4D) little = false;
      else return res;                       // keine gültige Byte-Reihenfolge
      var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (dv.getUint16(2, little) !== 42) return res;   // Magic stimmt nicht
      var ifd0 = dv.getUint32(4, little);
      res.little = little;

      var visited = {};
      var exifPtr = 0, gpsPtr = 0, interopPtr = 0;
      var self = res;

      function collectInto(target, table) {
        return function (tag, type, n, v) {
          self.tagCount++;
          var key = table[tag];
          if (!key) return;
          if (key === 'exifIfdPointer') { exifPtr = (typeof v.value === 'number') ? v.value : 0; return; }
          if (key === 'gpsIfdPointer') { gpsPtr = (typeof v.value === 'number') ? v.value : 0; return; }
          if (key === 'interopIfdPointer') { interopPtr = (typeof v.value === 'number') ? v.value : 0; return; }
          target[key] = v;
        };
      }

      var ifd1Offset = walkIfd(dv, bytes, little, ifd0, visited, collectInto(res.raw, TAGS_IFD0));
      if (exifPtr) walkIfd(dv, bytes, little, exifPtr, visited, collectInto(res.raw, TAGS_EXIF));
      if (gpsPtr) walkIfd(dv, bytes, little, gpsPtr, visited, collectInto(res.gps, TAGS_GPS));
      if (interopPtr) walkIfd(dv, bytes, little, interopPtr, visited, function () { /* nur zählen */ });
      if (ifd1Offset) walkIfd(dv, bytes, little, ifd1Offset, visited, collectInto(res.ifd1, TAGS_IFD0));

      res.ok = true;
    } catch (e) {
      res.ok = false;
      res.error = 'EXIF-Block ist beschädigt.';
    }
    return res;
  }

  /** Bequemer Zugriff: Wert eines kanonischen Schlüssels oder undefined. */
  function val(map, key) {
    var e = map ? map[key] : null;
    return e ? e.value : undefined;
  }
  function ratios(map, key) {
    var e = map ? map[key] : null;
    return e ? e.ratios : null;
  }

  /* -------------------------------------------------------------------------
   * GPS: Grad/Minute/Sekunde -> Dezimalgrad, Vorzeichen aus der Himmelsrichtung
   * ------------------------------------------------------------------------- */

  /**
   * dmsToDecimal([grad, minute, sekunde], 'N'|'S'|'E'|'W') -> Dezimalgrad
   * Süd und West ergeben negative Werte. Ungültige Eingabe -> null.
   */
  function dmsToDecimal(parts, ref) {
    // Fehlende Werte duerfen NIEMALS zu einer Koordinate werden: Number(null)
    // ist 0 und gilt als endlich, wodurch aus einer luecken- haften Datei ein
    // erfundener Standort entstuende. In einem forensischen Werkzeug ist das
    // der schwerste denkbare Fehler - lieber gar keine Angabe.
    if (parts === null || parts === undefined) return null;
    var a = Array.isArray(parts) ? parts : [parts];
    if (!a.length) return null;
    for (var gi = 0; gi < Math.min(a.length, 3); gi++) {
      if (a[gi] === null || a[gi] === undefined || a[gi] === '') return null;
    }
    var d = Number(a[0]), m = Number(a.length > 1 ? a[1] : 0), s = Number(a.length > 2 ? a[2] : 0);
    if (!isFinite(d) || !isFinite(m) || !isFinite(s)) return null;
    var dec = Math.abs(d) + Math.abs(m) / 60 + Math.abs(s) / 3600;
    if (!isFinite(dec)) return null;
    var r = String(ref == null ? '' : ref).trim().toUpperCase().charAt(0);
    if (r === 'S' || r === 'W') dec = -dec;
    // Negative Gradangaben (kommt bei manchen Geräten vor) ebenfalls beachten
    if (d < 0 && dec > 0) dec = -dec;
    return roundTo(dec, 7);
  }

  /** Baut aus dem GPS-IFD das {lat, lon, alt}-Objekt – oder null. */
  function buildGps(gpsMap) {
    if (!gpsMap) return null;
    var latRaw = val(gpsMap, 'gpsLatitude');
    var lonRaw = val(gpsMap, 'gpsLongitude');
    if (latRaw === undefined || lonRaw === undefined) return null;
    var lat = dmsToDecimal(latRaw, val(gpsMap, 'gpsLatitudeRef'));
    var lon = dmsToDecimal(lonRaw, val(gpsMap, 'gpsLongitudeRef'));
    if (lat === null || lon === null) return null;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;   // unplausibel
    if (lat === 0 && lon === 0) return null;                      // "Nullinsel" = meist Platzhalter
    var alt = null;
    var altRaw = val(gpsMap, 'gpsAltitude');
    if (typeof altRaw === 'number' && isFinite(altRaw)) {
      alt = altRaw;
      var altRef = val(gpsMap, 'gpsAltitudeRef');
      if (altRef instanceof Uint8Array) altRef = altRef.length ? altRef[0] : 0;
      if (Number(altRef) === 1) alt = -alt;     // 1 = unter dem Meeresspiegel
      alt = roundTo(alt, 2);
    }
    return { lat: lat, lon: lon, alt: alt };
  }

  /* =========================================================================
   * 3. Container: JPEG-Segmente, PNG-Chunks, WebP-Chunks
   * ========================================================================= */

  /** Erkennt das Dateiformat an der Signatur. */
  function detectFormat(bytes) {
    if (!bytes || bytes.length < 4) return 'unbekannt';
    if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'JPEG';
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'PNG';
    if (bytes.length >= 12 && hasSignature(bytes, 0, 'RIFF') && hasSignature(bytes, 8, 'WEBP')) return 'WebP';
    return 'unbekannt';
  }

  /**
   * Läuft alle JPEG-Segmente ab und sammelt, was forensisch interessant ist.
   * Bricht bei SOS (Beginn der Bilddaten) ab.
   */
  function scanJpeg(bytes) {
    var out = {
      exifTiff: null, xmp: '', comments: [], width: 0, height: 0,
      hasJfif: false, hasAdobeApp14: false, hasPhotoshopIrb: false, hasC2pa: false,
      progressive: false, markers: [], quantTableCount: 0, quantTables: [], iccChunks: 0, mpf: false
    };
    if (!bytes || bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return out;
    var p = 2;
    var guard = 0;
    while (p < bytes.length - 1 && guard++ < 10000) {
      if (bytes[p] !== 0xFF) { p++; continue; }              // Resynchronisieren
      var marker = bytes[p + 1];
      if (marker === 0xFF) { p++; continue; }                // Füllbytes
      if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD9)) { p += 2; continue; }
      if (p + 4 > bytes.length) break;
      var len = (bytes[p + 2] << 8) | bytes[p + 3];
      if (len < 2) break;
      var segStart = p + 4;
      var segEnd = Math.min(p + 2 + len, bytes.length);
      out.markers.push(marker);

      // Bildmaße aus dem Frame-Header (SOF0..SOF15, ohne DHT/JPG/DAC)
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
        if (segStart + 5 <= bytes.length) {
          out.height = (bytes[segStart + 1] << 8) | bytes[segStart + 2];
          out.width = (bytes[segStart + 3] << 8) | bytes[segStart + 4];
        }
        if (marker === 0xC2) out.progressive = true;
      } else if (marker === 0xDB) {
        out.quantTableCount++;
        // Die Tabellenwerte selbst sind forensisch das Wertvollste am JPEG:
        // aus ihnen laesst sich die Qualitaetsstufe und oft der Urheber
        // (Kamera gegen Bearbeitungsprogramm) ableiten.
        var qp = segStart;
        while (qp < segEnd) {
          var prec = bytes[qp] >> 4;          // 0 = 8 Bit, 1 = 16 Bit
          var id = bytes[qp] & 0x0F;
          qp++;
          var tbl = new Array(64);
          for (var qi = 0; qi < 64; qi++) {
            if (prec === 0) { tbl[qi] = bytes[qp]; qp += 1; }
            else { tbl[qi] = (bytes[qp] << 8) | bytes[qp + 1]; qp += 2; }
          }
          if (qp > segEnd + 1) break;         // beschaedigtes Segment
          out.quantTables.push({ id: id, precision: prec === 0 ? 8 : 16, values: tbl });
        }
      } else if (marker === 0xE0 && hasSignature(bytes, segStart, 'JFIF')) {
        out.hasJfif = true;
      } else if (marker === 0xE1) {
        if (hasSignature(bytes, segStart, 'Exif') && bytes[segStart + 4] === 0x00) {
          if (!out.exifTiff) out.exifTiff = bytes.subarray(segStart + 6, segEnd);
        } else if (hasSignature(bytes, segStart, 'http://ns.adobe.com/xap/1.0/')) {
          out.xmp += bytesToLatin1(bytes, segStart + 29, segEnd - segStart - 29);
        }
      } else if (marker === 0xE2) {
        if (hasSignature(bytes, segStart, 'ICC_PROFILE')) out.iccChunks++;
        if (hasSignature(bytes, segStart, 'MPF')) out.mpf = true;
      } else if (marker === 0xEB || marker === 0xEC) {
        // APP11/APP12 – hier liegt bei C2PA/"Content Credentials" der JUMBF-Kasten
        var probe = bytesToLatin1(bytes, segStart, Math.min(64, segEnd - segStart));
        if (/jumb|c2pa/i.test(probe)) out.hasC2pa = true;
      } else if (marker === 0xED && hasSignature(bytes, segStart, 'Photoshop 3.0')) {
        out.hasPhotoshopIrb = true;
      } else if (marker === 0xEE && hasSignature(bytes, segStart, 'Adobe')) {
        out.hasAdobeApp14 = true;
      } else if (marker === 0xFE) {
        var c = bytesToLatin1(bytes, segStart, segEnd - segStart).trim();
        if (c) out.comments.push(c);
      }

      if (marker === 0xDA) break;      // ab hier kommen die komprimierten Bilddaten
      p = p + 2 + len;
    }
    return out;
  }

  /** Entpackt zlib/deflate-Daten, sofern die Umgebung DecompressionStream kennt. */
  async function inflate(bytes) {
    if (typeof DecompressionStream === 'undefined' || typeof Response === 'undefined' || typeof Blob === 'undefined') return null;
    try {
      var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
      var buf = await new Response(stream).arrayBuffer();
      return new Uint8Array(buf);
    } catch (e) { return null; }
  }

  /**
   * PNG: Chunks durchlaufen. IHDR (Maße), tEXt/zTXt/iTXt (Textfelder),
   * eXIf (vollwertiger EXIF-Block), tIME (Änderungszeit).
   */
  async function scanPng(bytes) {
    var out = { width: 0, height: 0, bitDepth: 0, colorType: -1, text: {}, exifTiff: null, xmp: '', time: '', chunks: [], interlace: 0 };
    if (!bytes || bytes.length < 16) return out;
    var p = 8;
    var guard = 0;
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    while (p + 8 <= bytes.length && guard++ < 5000) {
      var len = dv.getUint32(p, false);
      var type = bytesToLatin1(bytes, p + 4, 4);
      var dataStart = p + 8;
      if (len > bytes.length || dataStart + len > bytes.length) break;   // abgeschnittene Datei
      out.chunks.push(type);
      if (type === 'IHDR' && len >= 13) {
        out.width = dv.getUint32(dataStart, false);
        out.height = dv.getUint32(dataStart + 4, false);
        out.bitDepth = bytes[dataStart + 8];
        out.colorType = bytes[dataStart + 9];
        out.interlace = bytes[dataStart + 12];
      } else if (type === 'tEXt') {
        var z = indexOfByte(bytes, 0, dataStart, dataStart + len);
        if (z > 0) {
          var kw = bytesToLatin1(bytes, dataStart, z - dataStart);
          out.text[kw] = bytesToLatin1(bytes, z + 1, dataStart + len - z - 1);
        }
      } else if (type === 'zTXt') {
        var z2 = indexOfByte(bytes, 0, dataStart, dataStart + len);
        if (z2 > 0) {
          var kw2 = bytesToLatin1(bytes, dataStart, z2 - dataStart);
          var comp = await inflate(bytes.subarray(z2 + 2, dataStart + len));
          if (comp) out.text[kw2] = bytesToLatin1(comp, 0, comp.length);
        }
      } else if (type === 'iTXt') {
        var parsed = parseITxt(bytes, dataStart, dataStart + len);
        if (parsed) {
          if (parsed.compressed) {
            var raw = await inflate(parsed.rawText);
            if (raw) out.text[parsed.keyword] = bytesToLatin1(raw, 0, raw.length);
          } else {
            out.text[parsed.keyword] = parsed.text;
          }
        }
      } else if (type === 'eXIf') {
        var start = dataStart;
        if (hasSignature(bytes, start, 'Exif') && bytes[start + 4] === 0) start += 6;
        out.exifTiff = bytes.subarray(start, dataStart + len);
      } else if (type === 'tIME' && len >= 7) {
        out.time = dv.getUint16(dataStart, false) + ':' + pad2(bytes[dataStart + 2]) + ':' + pad2(bytes[dataStart + 3]) +
                   ' ' + pad2(bytes[dataStart + 4]) + ':' + pad2(bytes[dataStart + 5]) + ':' + pad2(bytes[dataStart + 6]);
      }
      if (type === 'IEND') break;
      p = dataStart + len + 4;   // + CRC
    }
    if (out.text['XML:com.adobe.xmp']) out.xmp = out.text['XML:com.adobe.xmp'];
    return out;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function indexOfByte(bytes, needle, from, to) {
    var end = Math.min(to, bytes.length);
    for (var i = from; i < end; i++) if (bytes[i] === needle) return i;
    return -1;
  }

  /** iTXt-Chunk zerlegen: Keyword \0 Flag Methode Sprache \0 ÜbersetztesKeyword \0 Text */
  function parseITxt(bytes, start, end) {
    var z1 = indexOfByte(bytes, 0, start, end);
    if (z1 < 0 || z1 + 2 >= end) return null;
    var keyword = bytesToLatin1(bytes, start, z1 - start);
    var compressed = bytes[z1 + 1] === 1;
    var z2 = indexOfByte(bytes, 0, z1 + 3, end);      // Ende Sprach-Tag
    if (z2 < 0) return null;
    var z3 = indexOfByte(bytes, 0, z2 + 1, end);      // Ende übersetztes Keyword
    if (z3 < 0) return null;
    var textStart = z3 + 1;
    if (compressed) return { keyword: keyword, compressed: true, rawText: bytes.subarray(textStart, end) };
    return { keyword: keyword, compressed: false, text: utf8ToString(bytes.subarray(textStart, end)) };
  }

  /** UTF-8-Bytes zu String (TextDecoder wenn vorhanden, sonst Latin-1-Notlösung). */
  function utf8ToString(bytes) {
    try {
      if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
    } catch (e) { /* weiter unten */ }
    return bytesToLatin1(bytes, 0, bytes.length);
  }

  /** WebP: RIFF-Chunks durchlaufen (VP8X-Maße, EXIF-Chunk, XMP-Chunk). */
  function scanWebp(bytes) {
    var out = { width: 0, height: 0, exifTiff: null, xmp: '', chunks: [], hasAlpha: false, animated: false, lossless: false };
    if (!bytes || bytes.length < 16) return out;
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var p = 12;
    var guard = 0;
    while (p + 8 <= bytes.length && guard++ < 2000) {
      var fourcc = bytesToLatin1(bytes, p, 4);
      var size = dv.getUint32(p + 4, true);
      var dataStart = p + 8;
      if (size > bytes.length || dataStart + size > bytes.length) {
        size = bytes.length - dataStart;        // abgeschnitten: Rest nehmen
        if (size < 0) break;
      }
      out.chunks.push(fourcc);
      if (fourcc === 'VP8X' && size >= 10) {
        out.hasAlpha = !!(bytes[dataStart] & 0x10);
        out.animated = !!(bytes[dataStart] & 0x02);
        out.width = 1 + (bytes[dataStart + 4] | (bytes[dataStart + 5] << 8) | (bytes[dataStart + 6] << 16));
        out.height = 1 + (bytes[dataStart + 7] | (bytes[dataStart + 8] << 8) | (bytes[dataStart + 9] << 16));
      } else if (fourcc === 'VP8 ' && size >= 10 && !out.width) {
        // Lossy: Keyframe-Header, Maße als 14 Bit
        out.width = dv.getUint16(dataStart + 6, true) & 0x3FFF;
        out.height = dv.getUint16(dataStart + 8, true) & 0x3FFF;
      } else if (fourcc === 'VP8L' && size >= 5 && !out.width) {
        out.lossless = true;
        var b1 = bytes[dataStart + 1], b2 = bytes[dataStart + 2], b3 = bytes[dataStart + 3], b4 = bytes[dataStart + 4];
        out.width = 1 + (((b2 & 0x3F) << 8) | b1);
        out.height = 1 + (((b4 & 0x0F) << 10) | (b3 << 2) | ((b2 & 0xC0) >> 6));
      } else if (fourcc === 'EXIF') {
        var s = dataStart;
        if (hasSignature(bytes, s, 'Exif') && bytes[s + 4] === 0) s += 6;
        out.exifTiff = bytes.subarray(s, dataStart + size);
      } else if (fourcc === 'XMP ') {
        out.xmp = utf8ToString(bytes.subarray(dataStart, dataStart + size));
      }
      p = dataStart + size + (size & 1);   // Chunks sind auf gerade Länge aufgefüllt
    }
    return out;
  }

  /* =========================================================================
   * 4. Zeichenfläche: funktioniert im Fenster wie im Worker
   * ========================================================================= */

  function makeCanvas(w, h) {
    if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
    if (typeof document !== 'undefined') {
      var c = document.createElement('canvas');
      c.width = w; c.height = h;
      return c;
    }
    return null;
  }

  /** Zeichnet eine Bildquelle auf eine Leinwand und liefert die Pixel. */
  function drawToImageData(src, w, h) {
    var c = makeCanvas(w, h);
    if (!c) return null;
    var g = c.getContext('2d', { willReadFrequently: true });
    if (!g) return null;
    g.drawImage(src, 0, 0, w, h);
    try { return g.getImageData(0, 0, w, h); } catch (e) { return null; }
  }

  /** Kodiert eine Leinwand als JPEG-Blob. Rückgabe null statt Ausnahme. */
  async function canvasToJpegBlob(canvas, quality) {
    try {
      if (typeof canvas.convertToBlob === 'function') {
        return await canvas.convertToBlob({ type: 'image/jpeg', quality: quality });
      }
      return await new Promise(function (res) {
        canvas.toBlob(function (b) { res(b); }, 'image/jpeg', quality);
      });
    } catch (e) { return null; }
  }

  /**
   * Begrenzt die Arbeitsauflösung. Forensische Verfahren sind pro Pixel teuer;
   * oberhalb ~1600px bringt mehr Auflösung keine zusätzliche Aussage, kostet
   * aber quadratisch Zeit und kann schwache Geräte zum Stillstand bringen.
   */
  function workSize(w, h, max) {
    max = max || 1600;
    if (w <= max && h <= max) return { w: w, h: h, scaled: false };
    var f = Math.min(max / w, max / h);
    return { w: Math.max(1, Math.round(w * f)), h: Math.max(1, Math.round(h * f)), scaled: true };
  }

  /* =========================================================================
   * 5. Metadaten lesen + forensische Hinweise ableiten
   * ========================================================================= */

  var LESBAR = {
    make: 'Hersteller', model: 'Kameramodell', lensModel: 'Objektiv',
    software: 'Software', artist: 'Urheber', copyright: 'Copyright',
    imageDescription: 'Bildbeschreibung',
    dateTimeOriginal: 'Aufnahmezeitpunkt', dateTimeDigitized: 'Digitalisiert',
    dateTime: 'Zuletzt geändert', orientation: 'Ausrichtung',
    exposureTime: 'Belichtungszeit', fNumber: 'Blende',
    isoSpeedRatings: 'ISO', photographicSensitivity: 'ISO',
    focalLength: 'Brennweite', focalLengthIn35mmFilm: 'Brennweite (KB)',
    flash: 'Blitz', whiteBalance: 'Weißabgleich', meteringMode: 'Messmethode',
    exposureProgram: 'Belichtungsprogramm', exposureBiasValue: 'Belichtungskorrektur',
    pixelXDimension: 'Breite (EXIF)', pixelYDimension: 'Höhe (EXIF)',
    xResolution: 'Auflösung X', yResolution: 'Auflösung Y'
  };

  /** Formatiert einen Rohwert für die Anzeige, mit passender Einheit. */
  function formatTag(key, value, rat) {
    if (value === undefined || value === null) return null;
    if (value instanceof Uint8Array) return null;
    if (Array.isArray(value)) value = value.join(', ');

    if (key === 'exposureTime' && typeof value === 'number' && value > 0) {
      return value >= 1 ? deNum(value, 1) + ' s' : '1/' + Math.round(1 / value) + ' s';
    }
    if (key === 'fNumber' && typeof value === 'number') return 'f/' + deNum(value, 1);
    if (key === 'focalLength' || key === 'focalLengthIn35mmFilm') {
      if (typeof value === 'number') return deNum(value, 0) + ' mm';
    }
    if (key === 'exposureBiasValue' && typeof value === 'number') {
      return (value > 0 ? '+' : '') + deNum(value, 1) + ' EV';
    }
    if (key === 'orientation' && typeof value === 'number') {
      var O = { 1: 'normal', 3: '180° gedreht', 6: '90° im Uhrzeigersinn', 8: '90° gegen Uhrzeigersinn' };
      return O[value] || String(value);
    }
    if (typeof value === 'number') return deNum(value, 4);
    var s = String(value).replace(/\0+$/, '').trim();
    return s.length ? s : null;
  }

  /** EXIF-Zeitstempel "JJJJ:MM:TT hh:mm:ss" -> Date oder null. */
  function exifDate(s) {
    if (typeof s !== 'string') return null;
    var m = s.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    if (!m) return null;
    var d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    return isNaN(d.getTime()) ? null : d;
  }

  /** Bekannte Bearbeitungsprogramme im Software-Feld. */
  var EDITOR_MUSTER = [
    [/photoshop/i, 'Adobe Photoshop'], [/lightroom/i, 'Adobe Lightroom'],
    [/gimp/i, 'GIMP'], [/affinity/i, 'Affinity Photo'], [/paint\.net/i, 'Paint.NET'],
    [/snapseed/i, 'Snapseed'], [/picsart/i, 'PicsArt'], [/facetune/i, 'Facetune'],
    [/capture one/i, 'Capture One'], [/luminar/i, 'Luminar'], [/darktable/i, 'darktable'],
    [/canva/i, 'Canva'], [/imagemagick/i, 'ImageMagick'], [/ffmpeg/i, 'FFmpeg']
  ];

  async function readMetadata(fileOrBlob) {
    var out = {
      format: 'unbekannt', tags: {}, gps: null, thumbnail: null,
      findings: [], width: 0, height: 0, raw: {}
    };
    try {
      var bytes = await toBytes(fileOrBlob);
      if (!bytes || !bytes.length) {
        addFinding(out.findings, 'warn', 'Die Datei ist leer oder konnte nicht gelesen werden.');
        return out;
      }
      out.format = detectFormat(bytes);
      if (out.format === 'unbekannt') {
        addFinding(out.findings, 'warn',
          'Das Dateiformat wurde nicht erkannt. Die Signatur passt weder zu JPEG, PNG noch WebP.');
      }

      var container = null, tiff = null;
      if (out.format === 'JPEG') {
        container = scanJpeg(bytes);
      } else if (out.format === 'PNG') {
        container = await scanPng(bytes);
      } else if (out.format === 'WebP') {
        container = scanWebp(bytes);
      }

      if (container) {
        out.width = container.width || 0;
        out.height = container.height || 0;
        if (container.exifTiff) tiff = parseTiffBlock(container.exifTiff);
      }

      /* --- Tags in lesbare Form bringen --- */
      if (tiff && tiff.ok) {
        out.raw = tiff.raw;
        for (var key in LESBAR) {
          if (!Object.prototype.hasOwnProperty.call(LESBAR, key)) continue;
          var v = formatTag(key, val(tiff.raw, key), ratios(tiff.raw, key));
          if (v !== null && v !== '') out.tags[LESBAR[key]] = v;
        }
        out.gps = buildGps(tiff.gps);

        /* --- eingebettetes Vorschaubild aus IFD1 --- */
        try {
          var off = val(tiff.ifd1, 'jpegInterchangeFormat');
          var len = val(tiff.ifd1, 'jpegInterchangeFormatLength');
          if (typeof off === 'number' && typeof len === 'number' && len > 0 &&
              off + len <= tiff.tiff.length) {
            out.thumbnail = bytesToBlob(tiff.tiff.subarray(off, off + len), 'image/jpeg');
          }
        } catch (e) { /* Vorschaubild ist optional */ }
      } else if (tiff && tiff.error) {
        addFinding(out.findings, 'warn', tiff.error);
      }

      /* --- PNG-Textfelder als Tags übernehmen --- */
      if (out.format === 'PNG' && container && container.text) {
        for (var tk in container.text) {
          if (Object.prototype.hasOwnProperty.call(container.text, tk)) {
            var tv = String(container.text[tk]).trim();
            if (tv) out.tags['PNG: ' + tk] = tv.length > 300 ? tv.slice(0, 300) + '…' : tv;
          }
        }
      }

      if (out.width && out.height) out.tags['Abmessungen'] = out.width + ' × ' + out.height + ' px';

      /* =====================================================================
       * Befunde ableiten. Wichtig: das sind Hinweise, keine Beweise.
       * Jede Formulierung muss das offenlassen - ein Foto ohne EXIF ist
       * nicht gefälscht, es ist nur weiterverarbeitet worden.
       * ===================================================================== */
      var software = val(tiff && tiff.raw, 'software');
      if (typeof software === 'string' && software.trim()) {
        var erkannt = null;
        for (var i = 0; i < EDITOR_MUSTER.length; i++) {
          if (EDITOR_MUSTER[i][0].test(software)) { erkannt = EDITOR_MUSTER[i][1]; break; }
        }
        if (erkannt) {
          addFinding(out.findings, 'alarm',
            'Das Software-Feld nennt ' + erkannt + '. Die Datei wurde nach der Aufnahme durch ein ' +
            'Bearbeitungsprogramm geschrieben. Das sagt nichts darüber aus, ob der Inhalt verändert wurde.');
        } else {
          addFinding(out.findings, 'info', 'Software-Feld: „' + software.trim() + '“.');
        }
      }

      var hatKamera = val(tiff && tiff.raw, 'make') || val(tiff && tiff.raw, 'model');
      if (!tiff || !tiff.ok) {
        addFinding(out.findings, 'warn',
          'Keine EXIF-Daten vorhanden. Typisch für Bildschirmfotos, heruntergeladene Bilder und ' +
          'Dateien aus sozialen Netzwerken - diese entfernen Metadaten routinemäßig. Ein Hinweis, kein Verdacht.');
      } else if (!hatKamera) {
        addFinding(out.findings, 'warn',
          'EXIF vorhanden, aber ohne Hersteller- und Modellangabe. Bei einer Kameraaufnahme wären diese Felder ' +
          'normalerweise gefüllt.');
      }

      /* Zeitstempel gegeneinander prüfen */
      var dOrig = exifDate(val(tiff && tiff.raw, 'dateTimeOriginal'));
      var dMod = exifDate(val(tiff && tiff.raw, 'dateTime'));
      if (dOrig && dMod) {
        var diffMin = Math.round((dMod - dOrig) / 60000);
        if (diffMin > 1) {
          addFinding(out.findings, 'alarm',
            'Der Änderungszeitpunkt liegt ' + (diffMin >= 1440
              ? Math.round(diffMin / 1440) + ' Tage'
              : diffMin >= 60 ? Math.round(diffMin / 60) + ' Stunden' : diffMin + ' Minuten') +
            ' nach der Aufnahme. Die Datei wurde nach dem Fotografieren erneut geschrieben.');
        }
      }
      if (dOrig && dOrig.getTime() > Date.now() + 86400000) {
        addFinding(out.findings, 'alarm',
          'Der Aufnahmezeitpunkt liegt in der Zukunft. Entweder war die Kamerauhr falsch gestellt ' +
          'oder der Zeitstempel wurde nachträglich gesetzt.');
      }

      /* EXIF-Maße gegen tatsächliche Maße */
      var ex = val(tiff && tiff.raw, 'pixelXDimension');
      var ey = val(tiff && tiff.raw, 'pixelYDimension');
      if (typeof ex === 'number' && typeof ey === 'number' && out.width && out.height) {
        var gedreht = (ex === out.height && ey === out.width);
        if (!gedreht && (ex !== out.width || ey !== out.height)) {
          addFinding(out.findings, 'alarm',
            'Die in EXIF vermerkten Maße (' + ex + ' × ' + ey + ') weichen von den tatsächlichen ' +
            '(' + out.width + ' × ' + out.height + ') ab. Ein starker Hinweis auf nachträgliches ' +
            'Zuschneiden oder Skalieren.');
        }
      }

      if (tiff && tiff.ok && hatKamera && !out.thumbnail) {
        addFinding(out.findings, 'warn',
          'EXIF einer Kamera vorhanden, aber ohne eingebettetes Vorschaubild. Kameras legen dieses ' +
          'normalerweise an; Bearbeitungsprogramme verwerfen es häufig.');
      }
      if (out.gps) {
        addFinding(out.findings, 'info',
          'Standortdaten enthalten: ' + deNum(out.gps.lat, 5) + ', ' + deNum(out.gps.lon, 5) +
          (out.gps.alt !== null ? ' auf ' + deNum(out.gps.alt, 0) + ' m Höhe' : '') +
          '. Vor einer Weitergabe der Datei bedenken.');
      }

      /* JPEG-spezifische Container-Spuren */
      if (out.format === 'JPEG' && container) {
        if (container.hasPhotoshopIrb) {
          addFinding(out.findings, 'alarm',
            'Die Datei enthält einen Photoshop-Ressourcenblock. Sie wurde von Adobe-Software geschrieben.');
        }
        if (container.hasC2pa) {
          addFinding(out.findings, 'info',
            'Ein C2PA-Herkunftsnachweis ist eingebettet. Dieser dokumentiert die Entstehungskette und ' +
            'kann separat geprüft werden.');
        }
        if (container.progressive) {
          addFinding(out.findings, 'info',
            'Progressives JPEG. Im Web üblich, bei Kameras selten - deutet auf Weiterverarbeitung hin.');
        }
        /* Quantisierungstabellen: verraten Qualitaetsstufe und Urheber */
        var qt = analyseQuantTables(container.quantTables);
        if (qt.tables.length) {
          out.quant = qt;
          out.tags['JPEG-Qualitaet (geschaetzt)'] = qt.quality + ' von 100';
          out.tags['Quantisierungstabellen'] = qt.tables.length + ' (' + qt.urheber + ')';
          for (var qf = 0; qf < qt.findings.length; qf++) {
            addFinding(out.findings, qt.findings[qf].level, qt.findings[qf].text);
          }
          // Eine Kameraaufnahme mit Standardtabellen ist ein Widerspruch.
          if (qt.standard && hatKamera) {
            addFinding(out.findings, 'alarm',
              'Widerspruch: Die Metadaten nennen eine Kamera, die Quantisierungstabellen stammen ' +
              'aber aus der Standardbibliothek. Kameras schreiben eigene Tabellen - die Datei wurde ' +
              'nach der Aufnahme neu kodiert, die EXIF-Daten aber uebernommen.');
          }
        }
        if (container.comments && container.comments.length) {
          for (var ci = 0; ci < Math.min(container.comments.length, 3); ci++) {
            var cm = String(container.comments[ci]).trim();
            if (cm) out.tags['JPEG-Kommentar ' + (ci + 1)] = cm.slice(0, 200);
          }
        }
      }

      if (!out.findings.length) {
        addFinding(out.findings, 'info',
          'Keine Auffälligkeiten in den Metadaten. Das schließt eine Bearbeitung nicht aus - ' +
          'Metadaten lassen sich entfernen und fälschen.');
      }
    } catch (e) {
      addFinding(out.findings, 'warn', 'Die Metadaten konnten nicht vollständig gelesen werden.');
    }
    return out;
  }

  /* =========================================================================
   * 6. Error Level Analysis
   *    Ein unverändertes JPEG ist bereits überall gleich stark komprimiert.
   *    Wird es erneut gespeichert, verändern sich alle Bereiche gleichmäßig
   *    wenig. Nachträglich eingefügte Bereiche hatten eine andere
   *    Kompressionsvorgeschichte und verändern sich stärker - sie leuchten auf.
   * ========================================================================= */

  async function errorLevelAnalysis(source, opts) {
    opts = opts || {};
    var quality = typeof opts.quality === 'number' ? opts.quality : 0.90;
    var scale = typeof opts.scale === 'number' ? opts.scale : 18;
    var leer = { imageData: null, meanError: 0, maxError: 0, error: null };
    try {
      var w0 = source.width || source.videoWidth, h0 = source.height || source.videoHeight;
      if (!w0 || !h0) { leer.error = 'Bild hat keine gültigen Maße.'; return leer; }
      var s = workSize(w0, h0, 1400);

      var c = makeCanvas(s.w, s.h);
      if (!c) { leer.error = 'Keine Zeichenfläche verfügbar.'; return leer; }
      var g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(source, 0, 0, s.w, s.h);
      var orig = g.getImageData(0, 0, s.w, s.h);

      var blob = await canvasToJpegBlob(c, quality);
      if (!blob) { leer.error = 'Erneute JPEG-Kodierung nicht möglich.'; return leer; }
      await yieldToUi();

      var bmp = await createImageBitmap(blob);
      var again = drawToImageData(bmp, s.w, s.h);
      if (bmp.close) bmp.close();
      if (!again) { leer.error = 'Vergleichsbild konnte nicht gelesen werden.'; return leer; }

      var a = orig.data, b = again.data, n = a.length;
      var outData = new Uint8ClampedArray(n);
      var summe = 0, maxE = 0, px = 0;
      for (var i = 0; i < n; i += 4) {
        var dr = Math.abs(a[i] - b[i]), dg = Math.abs(a[i + 1] - b[i + 1]), db = Math.abs(a[i + 2] - b[i + 2]);
        var m = dr > dg ? (dr > db ? dr : db) : (dg > db ? dg : db);
        if (m > maxE) maxE = m;
        summe += m; px++;
        outData[i] = dr * scale > 255 ? 255 : dr * scale;
        outData[i + 1] = dg * scale > 255 ? 255 : dg * scale;
        outData[i + 2] = db * scale > 255 ? 255 : db * scale;
        outData[i + 3] = 255;
      }
      return {
        imageData: new ImageData(outData, s.w, s.h),
        meanError: px ? roundTo(summe / px, 3) : 0,
        maxError: maxE,
        scaled: s.scaled,
        error: null
      };
    } catch (e) {
      leer.error = 'Die Fehlerniveau-Analyse ist fehlgeschlagen.';
      return leer;
    }
  }

  /* =========================================================================
   * 7. Histogramm
   * ========================================================================= */

  function histogram(imageData) {
    var r = new Uint32Array(256), g = new Uint32Array(256),
        b = new Uint32Array(256), luma = new Uint32Array(256);
    var clippedLow = 0, clippedHigh = 0, total = 0;
    try {
      if (!imageData || !imageData.data) return { r: r, g: g, b: b, luma: luma, clippedLow: 0, clippedHigh: 0, total: 0 };
      var d = imageData.data;
      for (var i = 0; i < d.length; i += 4) {
        var R = d[i], G = d[i + 1], B = d[i + 2];
        r[R]++; g[G]++; b[B]++;
        // Rec. 601 - entspricht der Helligkeitsempfindung besser als der Mittelwert
        luma[(0.299 * R + 0.587 * G + 0.114 * B) | 0]++;
        if (R === 0 && G === 0 && B === 0) clippedLow++;
        else if (R === 255 && G === 255 && B === 255) clippedHigh++;
        total++;
      }
    } catch (e) { /* leeres Histogramm zurückgeben */ }
    return {
      r: r, g: g, b: b, luma: luma,
      clippedLow: clippedLow, clippedHigh: clippedHigh, total: total,
      clippedLowPct: total ? roundTo(clippedLow / total * 100, 2) : 0,
      clippedHighPct: total ? roundTo(clippedHigh / total * 100, 2) : 0
    };
  }

  /* =========================================================================
   * 8. Rauschrest
   *    Jeder Sensor hinterlässt ein charakteristisches Rauschen. Retuschierte,
   *    weichgezeichnete oder eingefügte Flächen haben ein abweichendes -
   *    oder gar kein - Rauschen und erscheinen als ruhige Zonen.
   * ========================================================================= */

  async function noiseResidual(source, opts) {
    opts = opts || {};
    var scale = typeof opts.scale === 'number' ? opts.scale : 10;
    var leer = { imageData: null, uniformity: 0, error: null };
    try {
      var w0 = source.width || source.videoWidth, h0 = source.height || source.videoHeight;
      if (!w0 || !h0) { leer.error = 'Bild hat keine gültigen Maße.'; return leer; }
      var s = workSize(w0, h0, 1200);
      var src = drawToImageData(source, s.w, s.h);
      if (!src) { leer.error = 'Bild konnte nicht gelesen werden.'; return leer; }

      var d = src.data, W = s.w, H = s.h;
      var grau = new Float32Array(W * H);
      for (var i = 0, p = 0; i < d.length; i += 4, p++) {
        grau[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      }

      // Hochpass = Original minus 3x3-Mittelwert. Was bleibt, ist Rauschen und Kante.
      var out = new Uint8ClampedArray(W * H * 4);
      var summe = 0, summeQ = 0, cnt = 0;
      for (var y = 1; y < H - 1; y++) {
        for (var x = 1; x < W - 1; x++) {
          var o = y * W + x;
          var m = (grau[o - W - 1] + grau[o - W] + grau[o - W + 1] +
                   grau[o - 1] + grau[o] + grau[o + 1] +
                   grau[o + W - 1] + grau[o + W] + grau[o + W + 1]) / 9;
          var rest = Math.abs(grau[o] - m) * scale;
          summe += rest; summeQ += rest * rest; cnt++;
          var v = rest > 255 ? 255 : rest;
          var q = o * 4;
          out[q] = v; out[q + 1] = v; out[q + 2] = v; out[q + 3] = 255;
        }
        if ((y & 63) === 0) await yieldToUi();
      }
      // Rand undurchsichtig setzen, sonst bleibt er transparent
      for (var e = 0; e < W * H; e++) if (out[e * 4 + 3] === 0) out[e * 4 + 3] = 255;

      var mittel = cnt ? summe / cnt : 0;
      var varianz = cnt ? Math.max(0, summeQ / cnt - mittel * mittel) : 0;
      // Gleichmäßigkeit: 1 = überall gleiches Rauschen, 0 = stark unterschiedlich
      var uniformity = mittel > 0 ? roundTo(1 / (1 + Math.sqrt(varianz) / mittel), 3) : 0;

      return { imageData: new ImageData(out, W, H), uniformity: uniformity, meanResidual: roundTo(mittel, 2), scaled: s.scaled, error: null };
    } catch (e) {
      leer.error = 'Die Rauschanalyse ist fehlgeschlagen.';
      return leer;
    }
  }

  /* =========================================================================
   * 9. Copy-Move-Hinweis
   *    Sucht Blöcke, die einander auffällig gleichen. Beim Stempeln oder
   *    Klonen entstehen identische Regionen, die im Original nicht vorkommen.
   *    Bewusst als "Hinweis" benannt: gleichförmige Flächen wie Himmel oder
   *    weiße Wände erzeugen zwangsläufig Treffer, ohne dass etwas manipuliert
   *    wurde. Solche Blöcke werden darum über die Varianz aussortiert.
   * ========================================================================= */

  async function copyMoveHint(source, opts) {
    opts = opts || {};
    var bs = Math.max(8, Math.min(32, opts.blockSize || 16));
    var leer = { imageData: null, suspectBlocks: 0, error: null };
    try {
      var w0 = source.width || source.videoWidth, h0 = source.height || source.videoHeight;
      if (!w0 || !h0) { leer.error = 'Bild hat keine gültigen Maße.'; return leer; }
      var s = workSize(w0, h0, 900);
      var src = drawToImageData(source, s.w, s.h);
      if (!src) { leer.error = 'Bild konnte nicht gelesen werden.'; return leer; }

      var d = src.data, W = s.w, H = s.h;
      var cols = Math.floor(W / bs), rows = Math.floor(H / bs);
      if (cols < 2 || rows < 2) { leer.error = 'Bild ist für diese Blockgröße zu klein.'; return leer; }

      var tabelle = Object.create(null);
      var blocks = [];
      for (var by = 0; by < rows; by++) {
        for (var bx = 0; bx < cols; bx++) {
          var sum = 0, sumQ = 0, sig = new Array(16), si = 0;
          // 4x4-Raster von Mittelwerten als Signatur - unempfindlich gegen leichtes Rauschen
          var step = bs / 4;
          for (var qy = 0; qy < 4; qy++) {
            for (var qx = 0; qx < 4; qx++) {
              var acc = 0, n2 = 0;
              for (var yy = 0; yy < step; yy++) {
                for (var xx = 0; xx < step; xx++) {
                  var px = ((by * bs + qy * step + yy) | 0) * W + ((bx * bs + qx * step + xx) | 0);
                  var o4 = px * 4;
                  var gv = 0.299 * d[o4] + 0.587 * d[o4 + 1] + 0.114 * d[o4 + 2];
                  acc += gv; n2++;
                  sum += gv; sumQ += gv * gv;
                }
              }
              sig[si++] = Math.round((acc / Math.max(1, n2)) / 4);   // grob quantisiert
            }
          }
          var anz = bs * bs;
          var mw = sum / anz;
          var varz = Math.max(0, sumQ / anz - mw * mw);
          // Strukturarme Blöcke (Himmel, Wand) taugen nicht als Beleg
          if (varz < 40) { blocks.push(null); continue; }
          var key = sig.join(',');
          (tabelle[key] || (tabelle[key] = [])).push(blocks.length);
          blocks.push({ bx: bx, by: by, key: key });
        }
        if ((by & 15) === 0) await yieldToUi();
      }

      var verdaechtig = Object.create(null), anzahl = 0;
      for (var k in tabelle) {
        var liste = tabelle[k];
        if (liste.length < 2) continue;
        for (var li = 0; li < liste.length; li++) {
          // Nachbarblöcke ähneln sich naturgemäß - nur räumlich getrennte zählen
          var bA = blocks[liste[li]];
          var fern = false;
          for (var lj = 0; lj < liste.length; lj++) {
            if (li === lj) continue;
            var bB = blocks[liste[lj]];
            if (Math.abs(bA.bx - bB.bx) + Math.abs(bA.by - bB.by) > 3) { fern = true; break; }
          }
          if (fern && !verdaechtig[liste[li]]) { verdaechtig[liste[li]] = true; anzahl++; }
        }
      }

      // Ergebnisbild: Original abgedunkelt, verdächtige Blöcke eingefärbt
      var out = new Uint8ClampedArray(W * H * 4);
      for (var i2 = 0; i2 < d.length; i2 += 4) {
        out[i2] = d[i2] * 0.35; out[i2 + 1] = d[i2 + 1] * 0.35;
        out[i2 + 2] = d[i2 + 2] * 0.35; out[i2 + 3] = 255;
      }
      for (var idx in verdaechtig) {
        var bb = blocks[idx]; if (!bb) continue;
        for (var ty = 0; ty < bs; ty++) {
          for (var tx = 0; tx < bs; tx++) {
            var q2 = ((bb.by * bs + ty) * W + (bb.bx * bs + tx)) * 4;
            out[q2] = 255; out[q2 + 1] = Math.min(255, out[q2 + 1] + 60); out[q2 + 2] = out[q2 + 2];
          }
        }
      }

      return {
        imageData: new ImageData(out, W, H),
        suspectBlocks: anzahl,
        blockSize: bs,
        scaled: s.scaled,
        error: null
      };
    } catch (e) {
      leer.error = 'Die Copy-Move-Prüfung ist fehlgeschlagen.';
      return leer;
    }
  }

  /* =========================================================================
   * 9b. JPEG-Quantisierungstabellen
   *
   * Beim Speichern eines JPEGs werden die DCT-Koeffizienten durch eine
   * 8x8-Tabelle geteilt. Diese Tabelle steht in der Datei und verraet
   * zweierlei: die Qualitaetsstufe, und - weit interessanter - WER die Datei
   * geschrieben hat. Die freie Referenzbibliothek (IJG/libjpeg) leitet ihre
   * Tabellen nach einer festen Formel aus zwei Basistabellen ab. Trifft eine
   * Datei diese Formel exakt, stammt sie mit hoher Wahrscheinlichkeit aus
   * gaengiger Software. Kamerahersteller verwenden eigene, abweichende
   * Tabellen - ein Original aus der Kamera passt also gerade NICHT.
   * ========================================================================= */

  // Reihenfolge, in der die 64 Werte im DQT-Segment stehen (Zickzack).
  var ZIGZAG = [
     0, 1, 8,16, 9, 2, 3,10, 17,24,32,25,18,11, 4, 5,
    12,19,26,33,40,48,41,34, 27,20,13, 6, 7,14,21,28,
    35,42,49,56,57,50,43,36, 29,22,15,23,30,37,44,51,
    58,59,52,45,38,31,39,46, 53,60,61,54,47,55,62,63
  ];

  var IJG_LUMA = [
    16,11,10,16,24,40,51,61, 12,12,14,19,26,58,60,55,
    14,13,16,24,40,57,69,56, 14,17,22,29,51,87,80,62,
    18,22,37,56,68,109,103,77, 24,35,55,64,81,104,113,92,
    49,64,78,87,103,121,120,101, 72,92,95,98,112,100,103,99
  ];
  var IJG_CHROMA = [
    17,18,24,47,99,99,99,99, 18,21,26,66,99,99,99,99,
    24,26,56,99,99,99,99,99, 47,66,99,99,99,99,99,99,
    99,99,99,99,99,99,99,99, 99,99,99,99,99,99,99,99,
    99,99,99,99,99,99,99,99, 99,99,99,99,99,99,99,99
  ];

  /** Zickzack-Reihenfolge -> natuerliche Zeilenreihenfolge. */
  function deZigzag(values) {
    var out = new Array(64);
    for (var i = 0; i < 64; i++) out[ZIGZAG[i]] = values[i];
    return out;
  }

  /** Die IJG-Skalierungsformel: aus Basistabelle und Qualitaet 1..100. */
  function ijgScale(base, quality) {
    var q = Math.max(1, Math.min(100, quality));
    var s = q < 50 ? Math.floor(5000 / q) : 200 - 2 * q;
    var out = new Array(64);
    for (var i = 0; i < 64; i++) {
      var v = Math.floor((base[i] * s + 50) / 100);
      out[i] = v < 1 ? 1 : (v > 255 ? 255 : v);
    }
    return out;
  }

  /**
   * Sucht die Qualitaetsstufe, deren IJG-Tabelle der gemessenen am naechsten
   * kommt. Abweichung 0 bedeutet: exakt die Standardtabelle.
   */
  function matchIjgQuality(natural, base) {
    var bestQ = 0, bestDiff = Infinity;
    for (var q = 1; q <= 100; q++) {
      var t = ijgScale(base, q), d = 0;
      for (var i = 0; i < 64; i++) d += Math.abs(t[i] - natural[i]);
      if (d < bestDiff) { bestDiff = d; bestQ = q; }
      if (d === 0) break;
    }
    return { quality: bestQ, deviation: bestDiff };
  }

  /**
   * Wertet alle Tabellen einer Datei aus.
   * @returns {{tables:Array, quality:number|null, standard:boolean,
   *            urheber:string, findings:Array}}
   */
  function analyseQuantTables(quantTables) {
    var erg = { tables: [], quality: null, standard: false, urheber: 'unbestimmt', findings: [] };
    if (!quantTables || !quantTables.length) return erg;

    for (var i = 0; i < quantTables.length; i++) {
      var t = quantTables[i];
      if (!t.values || t.values.length !== 64) continue;
      var nat = deZigzag(t.values);
      var basis = t.id === 0 ? IJG_LUMA : IJG_CHROMA;
      var m = matchIjgQuality(nat, basis);
      // Summe der Tabellenwerte: grobes, aber robustes Mass fuer die Staerke
      // der Kompression. Kleine Summe = wenig Verlust.
      var summe = 0;
      for (var k = 0; k < 64; k++) summe += nat[k];
      erg.tables.push({
        id: t.id, precision: t.precision,
        art: t.id === 0 ? 'Helligkeit' : 'Farbe',
        quality: m.quality, deviation: m.deviation,
        sum: summe, natural: nat
      });
    }
    if (!erg.tables.length) return erg;

    var luma = null;
    for (var j = 0; j < erg.tables.length; j++) if (erg.tables[j].id === 0) { luma = erg.tables[j]; break; }
    if (!luma) luma = erg.tables[0];
    erg.quality = luma.quality;
    erg.standard = erg.tables.every(function (x) { return x.deviation === 0; });

    if (erg.standard) {
      erg.urheber = 'Standardbibliothek';
      addFinding(erg.findings, 'warn',
        'Die Quantisierungstabellen entsprechen exakt dem Standard der freien JPEG-Bibliothek ' +
        '(Qualitaetsstufe ' + erg.quality + '). Kameras verwenden eigene Tabellen - die Datei wurde ' +
        'also mit hoher Wahrscheinlichkeit von einem Programm neu geschrieben, nicht direkt aufgenommen.');
    } else if (luma.deviation < 64) {
      erg.urheber = 'standardnah';
      addFinding(erg.findings, 'info',
        'Die Tabellen liegen nahe am Standard (geschaetzte Qualitaet etwa ' + erg.quality +
        '), weichen aber leicht ab. Das ist typisch fuer angepasste Kodierer.');
    } else {
      erg.urheber = 'geraetespezifisch';
      addFinding(erg.findings, 'info',
        'Die Quantisierungstabellen weichen deutlich vom Standard ab (geschaetzte Qualitaet etwa ' +
        erg.quality + '). Das spricht fuer einen geraetespezifischen Kodierer, wie ihn Kameras ' +
        'und Mobiltelefone verwenden.');
    }

    if (erg.quality !== null && erg.quality >= 96) {
      addFinding(erg.findings, 'info',
        'Sehr hohe Qualitaetsstufe (' + erg.quality + '). Bei Aufnahmen unueblich, bei bewusst ' +
        'verlustarm exportierten Dateien dagegen normal.');
    }
    if (erg.tables.length > 2) {
      addFinding(erg.findings, 'warn',
        erg.tables.length + ' Quantisierungstabellen statt der ueblichen zwei. Das kommt bei ' +
        'mehrfach verschachtelten oder zusammengesetzten Dateien vor.');
    }
    return erg;
  }

  /* =========================================================================
   * 9c. Perzeptuelle Prüfsummen
   *
   * SHA-256 aendert sich beim kleinsten Bit. Perzeptuelle Hashes bleiben
   * dagegen stabil, wenn ein Bild skaliert, leicht nachbearbeitet oder neu
   * komprimiert wird - damit laesst sich erkennen, dass zwei Dateien
   * DASSELBE BILD zeigen, obwohl ihre Prüfsummen verschieden sind.
   * ========================================================================= */

  function grauRaster(source, n) {
    var img = drawToImageData(source, n, n);
    if (!img) return null;
    var d = img.data, g = new Float64Array(n * n);
    for (var i = 0, p = 0; i < d.length; i += 4, p++) {
      g[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    }
    return g;
  }

  function bitsToHex(bits) {
    var hex = '';
    for (var i = 0; i < bits.length; i += 4) {
      hex += ((bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3]).toString(16);
    }
    return hex;
  }

  /** Mittelwert-Hash: Pixel heller als der Durchschnitt -> 1. */
  function averageHashFrom(g, n) {
    var mittel = 0;
    for (var i = 0; i < g.length; i++) mittel += g[i];
    mittel /= g.length;
    var bits = new Array(g.length);
    for (var j = 0; j < g.length; j++) bits[j] = g[j] > mittel ? 1 : 0;
    return bitsToHex(bits);
  }

  /** Differenz-Hash: jedes Pixel gegen seinen rechten Nachbarn. */
  function differenceHashFrom(g, w, h) {
    var bits = [];
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w - 1; x++) bits.push(g[y * w + x] < g[y * w + x + 1] ? 1 : 0);
    }
    return bitsToHex(bits);
  }

  /** Diskrete Kosinustransformation, Typ II, quadratisch. */
  function dct2d(g, n) {
    var out = new Float64Array(n * n);
    var cos = new Float64Array(n * n);
    for (var u = 0; u < n; u++) {
      for (var x = 0; x < n; x++) cos[u * n + x] = Math.cos((2 * x + 1) * u * Math.PI / (2 * n));
    }
    for (var v = 0; v < n; v++) {
      for (var u2 = 0; u2 < n; u2++) {
        var summe = 0;
        for (var y = 0; y < n; y++) {
          for (var x2 = 0; x2 < n; x2++) summe += g[y * n + x2] * cos[u2 * n + x2] * cos[v * n + y];
        }
        var cu = u2 === 0 ? Math.SQRT1_2 : 1, cv = v === 0 ? Math.SQRT1_2 : 1;
        out[v * n + u2] = 0.25 * cu * cv * summe;
      }
    }
    return out;
  }

  /** Wahrnehmungs-Hash: niedrige Frequenzen der DCT gegen deren Median. */
  function perceptualHashFrom(g, n, k) {
    var d = dct2d(g, n);
    var werte = [];
    for (var y = 0; y < k; y++) for (var x = 0; x < k; x++) werte.push(d[y * n + x]);
    var ohneDc = werte.slice(1).sort(function (a, b) { return a - b; });
    var median = ohneDc.length % 2
      ? ohneDc[(ohneDc.length - 1) / 2]
      : (ohneDc[ohneDc.length / 2 - 1] + ohneDc[ohneDc.length / 2]) / 2;
    var bits = werte.map(function (v) { return v > median ? 1 : 0; });
    return bitsToHex(bits);
  }

  /** Hamming-Abstand zweier Hex-Hashes gleicher Laenge. */
  function hammingDistance(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return -1;
    var d = 0;
    for (var i = 0; i < a.length; i++) {
      var x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
      while (x) { d += x & 1; x >>= 1; }
    }
    return d;
  }

  /**
   * Berechnet alle drei perzeptuellen Hashes eines Bildes.
   * @returns {{aHash:string, dHash:string, pHash:string, error:string|null}}
   */
  async function perceptualHashes(source) {
    var leer = { aHash: '', dHash: '', pHash: '', error: null };
    try {
      var g8 = grauRaster(source, 8);
      if (!g8) { leer.error = 'Bild konnte nicht gerastert werden.'; return leer; }
      var g9 = drawToImageData(source, 9, 8);
      var gd = null;
      if (g9) {
        gd = new Float64Array(9 * 8);
        for (var i = 0, p = 0; i < g9.data.length; i += 4, p++) {
          gd[p] = 0.299 * g9.data[i] + 0.587 * g9.data[i + 1] + 0.114 * g9.data[i + 2];
        }
      }
      await yieldToUi();
      var g32 = grauRaster(source, 32);
      return {
        aHash: averageHashFrom(g8, 8),
        dHash: gd ? differenceHashFrom(gd, 9, 8) : '',
        pHash: g32 ? perceptualHashFrom(g32, 32, 8) : '',
        error: null
      };
    } catch (e) {
      leer.error = 'Perzeptuelle Prüfsummen konnten nicht berechnet werden.';
      return leer;
    }
  }

  /* =========================================================================
   * 10. Gesamtbericht
   * ========================================================================= */

  async function report(fileOrBlob, opts) {
    opts = opts || {};
    var erg = {
      erzeugtAm: new Date().toISOString(),
      version: VERSION,
      dateiname: (fileOrBlob && fileOrBlob.name) || null,
      mimeType: (fileOrBlob && fileOrBlob.type) || null,
      hash: null, metadaten: null,
      ela: null, histogramm: null, rauschen: null, copyMove: null,
      fehler: []
    };
    try {
      reportProgress(opts.onProgress, 'hash', 0.05);
      erg.hash = await hash(fileOrBlob);

      reportProgress(opts.onProgress, 'metadaten', 0.2);
      erg.metadaten = await readMetadata(fileOrBlob);

      var bmp = null;
      try { bmp = await createImageBitmap(fileOrBlob); }
      catch (e) { erg.fehler.push('Das Bild konnte nicht dekodiert werden - Pixelanalysen entfallen.'); }

      if (bmp) {
        erg.breite = bmp.width; erg.hoehe = bmp.height;

        reportProgress(opts.onProgress, 'ela', 0.4);
        erg.ela = await errorLevelAnalysis(bmp, opts.ela);
        if (erg.ela && erg.ela.error) erg.fehler.push(erg.ela.error);

        reportProgress(opts.onProgress, 'histogramm', 0.6);
        var pix = drawToImageData(bmp, Math.min(bmp.width, 1200),
                                  Math.round(Math.min(bmp.width, 1200) / bmp.width * bmp.height));
        erg.histogramm = pix ? histogram(pix) : null;

        reportProgress(opts.onProgress, 'rauschen', 0.75);
        erg.rauschen = await noiseResidual(bmp);
        if (erg.rauschen && erg.rauschen.error) erg.fehler.push(erg.rauschen.error);

        reportProgress(opts.onProgress, 'phash', 0.85);
        erg.perzeptuell = await perceptualHashes(bmp);
        if (erg.perzeptuell && erg.perzeptuell.error) erg.fehler.push(erg.perzeptuell.error);

        reportProgress(opts.onProgress, 'copymove', 0.9);
        erg.copyMove = await copyMoveHint(bmp, opts.copyMove);
        if (erg.copyMove && erg.copyMove.error) erg.fehler.push(erg.copyMove.error);

        /* Querbezüge, die erst aus mehreren Verfahren entstehen */
        var f = erg.metadaten.findings;
        if (erg.ela && !erg.ela.error && erg.ela.meanError > 12) {
          addFinding(f, 'alarm',
            'Das Fehlerniveau ist mit einem Mittel von ' + deNum(erg.ela.meanError, 1) +
            ' ungewöhnlich hoch. In der ELA-Ansicht prüfen, ob einzelne Bereiche deutlich heller ' +
            'sind als ihre Umgebung.');
        }
        if (erg.rauschen && !erg.rauschen.error && erg.rauschen.uniformity < 0.35) {
          addFinding(f, 'warn',
            'Das Rauschen ist über das Bild ungleich verteilt. Das kommt bei starker lokaler ' +
            'Bearbeitung vor, entsteht aber auch durch Weichzeichner, Rauschfilter und hohe ISO-Werte.');
        }
        if (erg.copyMove && !erg.copyMove.error && erg.copyMove.suspectBlocks > 6) {
          addFinding(f, 'warn',
            erg.copyMove.suspectBlocks + ' Bildblöcke gleichen weit entfernten Blöcken. ' +
            'Das kann auf Stempeln oder Klonen hindeuten - sich wiederholende Muster wie Fliesen ' +
            'oder Zäune erzeugen denselben Effekt.');
        }
        if (bmp.close) bmp.close();
      }
    } catch (e) {
      erg.fehler.push('Der Bericht konnte nicht vollständig erstellt werden.');
    }
    reportProgress(opts.onProgress, 'fertig', 1);
    return erg;
  }

  /* =========================================================================
   * Öffentliche Schnittstelle
   * ========================================================================= */

  root.Forensics = {
    version: VERSION,
    hash: hash,
    readMetadata: readMetadata,
    errorLevelAnalysis: errorLevelAnalysis,
    histogram: histogram,
    noiseResidual: noiseResidual,
    copyMoveHint: copyMoveHint,
    report: report,
    analyseQuantTables: analyseQuantTables,
    perceptualHashes: perceptualHashes,
    hammingDistance: hammingDistance,
    // für Tests in Node
    _intern: {
      deZigzag: deZigzag, ijgScale: ijgScale, matchIjgQuality: matchIjgQuality,
      dct2d: dct2d, bitsToHex: bitsToHex, averageHashFrom: averageHashFrom,
      differenceHashFrom: differenceHashFrom, perceptualHashFrom: perceptualHashFrom,
      IJG_LUMA: IJG_LUMA, IJG_CHROMA: IJG_CHROMA, ZIGZAG: ZIGZAG,
      detectFormat: detectFormat, parseTiffBlock: parseTiffBlock,
      dmsToDecimal: dmsToDecimal, exifDate: exifDate, formatTag: formatTag,
      scanJpeg: scanJpeg, scanWebp: scanWebp, sha256Js: sha256Js, sha1Js: sha1Js
    }
  };

})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
