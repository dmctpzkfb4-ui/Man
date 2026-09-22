/*!
 * skripte.js — Ausführung benutzerdefinierter Analyse-Skripte
 * -------------------------------------------------------------
 * Gegenstück zu skript.worker.js. Hier laufen die Werkzeuge, die ein Skript
 * anfordert; das Skript selbst läuft abgeriegelt im Worker.
 *
 * Je Datei ein eigener Worker: dadurch lässt sich eine Zeitgrenze hart
 * durchsetzen (Beenden), und ein Skript kann keinen Zustand von einer Datei
 * zur nächsten schmuggeln.
 */
(function (root) {
  'use strict';

  var ZEITGRENZE = 45000;   // je Datei

  /**
   * Führt die Werkzeugaufrufe einer Datei aus und merkt sich die Ergebnisse -
   * ein Skript, das zweimal nach den Metadaten fragt, soll nicht zweimal rechnen.
   */
  function WerkzeugKasten(datei, bitmap) {
    this.datei = datei;
    this.bitmap = bitmap;
    this.zwischen = {};
  }

  WerkzeugKasten.prototype.einmal = function (schluessel, machen) {
    var self = this;
    if (!(schluessel in this.zwischen)) this.zwischen[schluessel] = Promise.resolve().then(machen);
    return this.zwischen[schluessel];
  };

  /** Schneidet grosse Strukturen zurecht - ein Skript braucht keine Pixelfelder. */
  function schlank(o, felder) {
    var r = {};
    felder.forEach(function (f) { if (o && o[f] !== undefined) r[f] = o[f]; });
    return r;
  }

  WerkzeugKasten.prototype.aufrufen = function (name, args) {
    var self = this, F = root.Forensics, D = root.Detector;
    args = args || {};
    if (!F) return Promise.reject(new Error('Das Forensik-Modul ist nicht geladen.'));

    switch (name) {
      case 'hash':
        return this.einmal('hash', function () { return F.hash(self.datei); });

      case 'metadaten':
        return this.einmal('meta', function () {
          return F.readMetadata(self.datei).then(function (m) {
            return { format: m.format, tags: m.tags, gps: m.gps,
                     breite: m.width, hoehe: m.height,
                     befunde: m.findings, hatVorschaubild: !!m.thumbnail };
          });
        });

      case 'ela':
        return this.einmal('ela', function () {
          return F.errorLevelAnalysis(self.bitmap, args).then(function (r) {
            return schlank(r, ['meanError', 'maxError', 'scaled', 'error']);
          });
        });

      case 'rauschen':
        return this.einmal('rauschen', function () {
          return F.noiseResidual(self.bitmap).then(function (r) {
            return schlank(r, ['uniformity', 'meanResidual', 'error']);
          });
        });

      case 'copyMove':
        return this.einmal('cm', function () {
          return F.copyMoveHint(self.bitmap, args).then(function (r) {
            return schlank(r, ['suspectBlocks', 'blockSize', 'error']);
          });
        });

      case 'blockraster':
        return this.einmal('bag', function () {
          return F.blockingArtifactGrid(self.bitmap).then(function (r) {
            return schlank(r, ['offsetX', 'offsetY', 'confidence', 'verlaesslich',
                               'schwelle', 'mismatchTiles', 'totalTiles', 'error']);
          });
        });

      case 'ghosts':
        return this.einmal('ghosts', function () {
          return F.jpegGhosts(self.bitmap).then(function (r) {
            return schlank(r, ['bestQuality', 'outliers', 'totalTiles', 'spread', 'error']);
          });
        });

      case 'phash':
        return this.einmal('phash', function () {
          return F.perceptualHashes(self.bitmap).then(function (r) {
            return schlank(r, ['aHash', 'dHash', 'pHash', 'error']);
          });
        });

      case 'histogramm':
        return this.einmal('hist', function () {
          return Promise.resolve().then(function () {
            var c = document.createElement('canvas');
            var b = Math.min(self.bitmap.width, 1000);
            c.width = b; c.height = Math.round(b / self.bitmap.width * self.bitmap.height);
            c.getContext('2d', { willReadFrequently: true }).drawImage(self.bitmap, 0, 0, c.width, c.height);
            var h = F.histogram(c.getContext('2d').getImageData(0, 0, c.width, c.height));
            return schlank(h, ['clippedLow', 'clippedHigh', 'clippedLowPct', 'clippedHighPct', 'total']);
          });
        });

      case 'quantTabellen':
        return this.einmal('quant', function () {
          return F.readMetadata(self.datei).then(function (m) {
            if (!m.quant) return { tables: [], quality: null, standard: false, urheber: 'unbestimmt' };
            return { quality: m.quant.quality, standard: m.quant.standard,
                     urheber: m.quant.urheber, anzahl: m.quant.tables.length };
          });
        });

      case 'erkenne':
        if (!D || !D.stats || D.stats.backend === 'aus') {
          return Promise.reject(new Error('Die Objekterkennung ist nicht bereit.'));
        }
        return this.einmal('erkenne' + (args.conf || ''), function () {
          return D.detect(self.bitmap, { conf: args.conf || 0.25, iou: args.iou || 0.45, maxDet: 100 })
            .then(function (hits) {
              return hits.map(function (d) {
                return { label: d.label, score: Math.round(d.score * 1000) / 1000,
                         x: Math.round(d.x), y: Math.round(d.y),
                         w: Math.round(d.w), h: Math.round(d.h) };
              });
            });
        });

      case 'abstand':
        return Promise.resolve(F.hammingDistance(args.a, args.b));

      default:
        return Promise.reject(new Error('Unbekanntes Werkzeug: ' + name));
    }
  };

  /** Führt ein Skript über eine einzelne Datei aus. */
  function laufeEine(code, datei, optionen) {
    return new Promise(function (aufloesen) {
      var kasten = null, worker = null, uhr = null, erledigt = false;

      function beenden(ergebnis) {
        if (erledigt) return;
        erledigt = true;
        clearTimeout(uhr);
        try { if (worker) worker.terminate(); } catch (e) {}
        if (kasten && kasten.bitmap && kasten.bitmap.close) kasten.bitmap.close();
        aufloesen(ergebnis);
      }

      createImageBitmap(datei).then(function (bmp) {
        kasten = new WerkzeugKasten(datei, bmp);
        worker = new Worker('js/skript.worker.js');

        worker.onerror = function (e) {
          beenden({ datei: datei.name, ok: false,
                    fehler: 'Skriptfehler: ' + (e && e.message ? e.message : 'unbekannt'),
                    befunde: [], felder: {}, notizen: [] });
        };

        worker.onmessage = function (ev) {
          var m = ev.data || {};
          if (m.type === 'werkzeug') {
            kasten.aufrufen(m.name, m.args).then(function (wert) {
              worker.postMessage({ type: 'werkzeugErgebnis', id: m.id, ok: true, wert: wert });
            }, function (err) {
              worker.postMessage({ type: 'werkzeugErgebnis', id: m.id, ok: false,
                                   fehler: err && err.message ? err.message : String(err) });
            });
            return;
          }
          if (m.type === 'fertig') {
            var e2 = m.ergebnis || {};
            e2.datei = datei.name || 'unbenannt';
            e2.ok = !!m.ok;
            if (!m.ok) e2.fehler = m.fehler;
            beenden(e2);
          }
        };

        // Harte Zeitgrenze: eine Endlosschleife im Skript darf die App nicht
        // lahmlegen. Der Worker wird dann schlicht beendet.
        uhr = setTimeout(function () {
          beenden({ datei: datei.name, ok: false,
                    fehler: 'Zeitgrenze von ' + Math.round((optionen.zeitgrenze || ZEITGRENZE) / 1000) +
                            ' s überschritten - das Skript wurde beendet.',
                    befunde: [], felder: {}, notizen: [] });
        }, optionen.zeitgrenze || ZEITGRENZE);

        worker.postMessage({
          type: 'lauf', code: code,
          bild: { name: datei.name || 'unbenannt', groesse: datei.size,
                  typ: datei.type, breite: bmp.width, hoehe: bmp.height }
        });
      }, function () {
        beenden({ datei: datei.name, ok: false, fehler: 'Bild konnte nicht dekodiert werden.',
                  befunde: [], felder: {}, notizen: [] });
      });
    });
  }

  root.Skripte = {
    /**
     * Führt ein Skript nacheinander über mehrere Dateien aus.
     * Nacheinander und nicht gleichzeitig: mehrere Analysen parallel bringen
     * ein Mobilgerät zum Stocken, und die Reihenfolge bleibt nachvollziehbar.
     */
    laufe: function (code, dateien, optionen) {
      optionen = optionen || {};
      var ergebnisse = [];
      var kette = Promise.resolve();
      dateien.forEach(function (d, i) {
        kette = kette.then(function () {
          if (optionen.onFortschritt) optionen.onFortschritt(i, dateien.length, d.name);
          return laufeEine(code, d, optionen).then(function (r) {
            ergebnisse.push(r);
            if (optionen.onErgebnis) optionen.onErgebnis(r, i, dateien.length);
          });
        });
      });
      return kette.then(function () { return ergebnisse; });
    },
    ZEITGRENZE: ZEITGRENZE
  };
})(typeof window !== 'undefined' ? window : self);
