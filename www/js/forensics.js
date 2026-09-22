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
    var a = Array.isArray(parts) ? parts : [parts];
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
