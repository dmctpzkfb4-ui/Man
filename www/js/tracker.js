/*!
 * tracker.js — Objektverfolgung über Einzelbilder hinweg
 * -------------------------------------------------------------
 * Ohne Verfolgung liefert eine Aufnahme nur die Summe aller Einzelbilder:
 * "1200 Erkennungen" sagt nichts darüber, ob das eine Person war, die
 * zwanzig Sekunden dastand, oder zwanzig, die vorbeigingen.
 *
 * Verfahren: Überdeckung zwischen aufeinanderfolgenden Bildern. Kein
 * zusätzliches Modell, keine Merkmalsextraktion - das wäre auf einem
 * Telefon zu teuer und ist für diesen Zweck nicht nötig.
 *
 * Bewusste Grenzen, damit niemand mehr hineinliest als drinsteckt:
 *   - Verdeckt sich ein Objekt länger, bekommt es danach eine neue Kennung.
 *   - Kreuzen sich zwei gleichartige Objekte eng, können die Kennungen
 *     tauschen.
 *   - Die Zählung "verschiedene Objekte" ist damit eine Untergrenze für
 *     Wiedererkennung und eine Obergrenze für tatsächlich verschiedene Dinge.
 */
(function (root) {
  'use strict';

  function iou(a, b) {
    var x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    var x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
    var iw = x2 - x1, ih = y2 - y1;
    if (iw <= 0 || ih <= 0) return 0;
    var schnitt = iw * ih;
    return schnitt / (a.w * a.h + b.w * b.h - schnitt);
  }

  /**
   * @param {{iouSchwelle?:number, bestaetigenNach?:number,
   *          verwerfenNach?:number, glaettung?:number}} [opts]
   */
  function Tracker(opts) {
    opts = opts || {};
    this.iouSchwelle = opts.iouSchwelle != null ? opts.iouSchwelle : 0.3;
    // Erst nach mehreren Bildern gilt eine Spur als echt - das unterdrückt
    // Einzelbild-Fehltreffer, die sonst als "neues Objekt" gezählt würden.
    this.bestaetigenNach = opts.bestaetigenNach != null ? opts.bestaetigenNach : 3;
    // Kurze Aussetzer überbrücken, statt die Spur sofort zu verlieren.
    this.verwerfenNach = opts.verwerfenNach != null ? opts.verwerfenNach : 8;
    this.glaettung = opts.glaettung != null ? opts.glaettung : 0.35;
    this.spuren = [];
    this.naechsteId = 1;
    this.bild = 0;
    this.gesamtBestaetigt = 0;
    this.jeKlasse = {};
  }

  /**
   * Ein Bild einspeisen.
   * @param {Array} treffer Erkennungen mit x,y,w,h,score,classId,label
   * @param {number} [zeitMs] Zeitstempel; fehlt er, wird Date.now() genommen
   * @returns {{aktiv:Array, neu:Array, verloren:Array}}
   */
  Tracker.prototype.schritt = function (treffer, zeitMs) {
    var t = (zeitMs == null) ? Date.now() : zeitMs;
    this.bild++;
    var self = this;
    var neu = [], verloren = [];

    // Paare nach Überdeckung bilden, stärkste zuerst. Gierig statt optimal:
    // bei den wenigen Objekten je Bild ist der Unterschied nicht messbar,
    // der Aufwand aber deutlich geringer.
    var paare = [];
    this.spuren.forEach(function (s, si) {
      treffer.forEach(function (d, di) {
        if (d.classId !== s.classId) return;   // Klassenwechsel gibt es nicht
        var u = iou(s.box, d);
        if (u >= self.iouSchwelle) paare.push({ si: si, di: di, u: u });
      });
    });
    paare.sort(function (a, b) { return b.u - a.u; });

    var spurBelegt = {}, trefferBelegt = {};
    paare.forEach(function (p) {
      if (spurBelegt[p.si] || trefferBelegt[p.di]) return;
      spurBelegt[p.si] = trefferBelegt[p.di] = true;
      var s = self.spuren[p.si], d = treffer[p.di];
      // Box glätten, damit der Rahmen nicht zittert.
      var g = self.glaettung;
      s.box = {
        x: s.box.x + (d.x - s.box.x) * (1 - g),
        y: s.box.y + (d.y - s.box.y) * (1 - g),
        w: s.box.w + (d.w - s.box.w) * (1 - g),
        h: s.box.h + (d.h - s.box.h) * (1 - g)
      };
      s.score = d.score;
      s.bestScore = Math.max(s.bestScore, d.score);
      s.gesehen++;
      s.fehlend = 0;
      s.zuletzt = t;
      if (!s.bestaetigt && s.gesehen >= self.bestaetigenNach) {
        s.bestaetigt = true;
        self.gesamtBestaetigt++;
        self.jeKlasse[s.label] = (self.jeKlasse[s.label] || 0) + 1;
        neu.push(s);
      }
    });

    // Unbelegte Treffer werden neue Spuren.
    treffer.forEach(function (d, di) {
      if (trefferBelegt[di]) return;
      self.spuren.push({
        id: self.naechsteId++, classId: d.classId, label: d.label,
        box: { x: d.x, y: d.y, w: d.w, h: d.h },
        score: d.score, bestScore: d.score,
        gesehen: 1, fehlend: 0, bestaetigt: false,
        zuerst: t, zuletzt: t
      });
    });

    // Unbelegte Spuren altern lassen.
    this.spuren = this.spuren.filter(function (s, si) {
      if (spurBelegt[si]) return true;
      s.fehlend++;
      if (s.fehlend <= self.verwerfenNach) return true;
      if (s.bestaetigt) verloren.push(s);
      return false;
    });

    return { aktiv: this.aktive(), neu: neu, verloren: verloren };
  };

  /** Nur bestätigte Spuren, die im aktuellen Bild zu sehen sind. */
  Tracker.prototype.aktive = function () {
    return this.spuren.filter(function (s) { return s.bestaetigt && s.fehlend === 0; });
  };

  /** Zusammenfassung für Protokoll und Bericht. */
  Tracker.prototype.bilanz = function () {
    var klassen = Object.keys(this.jeKlasse).map(function (k) {
      return { label: k, anzahl: this.jeKlasse[k] };
    }, this).sort(function (a, b) { return b.anzahl - a.anzahl; });
    return {
      bilder: this.bild,
      verschiedeneObjekte: this.gesamtBestaetigt,
      jeKlasse: klassen,
      aktuellImBild: this.aktive().length
    };
  };

  Tracker.prototype.zuruecksetzen = function () {
    this.spuren = []; this.naechsteId = 1; this.bild = 0;
    this.gesamtBestaetigt = 0; this.jeKlasse = {};
  };

  root.Tracker = Tracker;
  root.Tracker.iou = iou;
  if (typeof module !== 'undefined' && module.exports) module.exports = Tracker;
})(typeof window !== 'undefined' ? window
  : (typeof self !== 'undefined' ? self : globalThis));
