/*!
 * skript.worker.js — Sandkasten für benutzerdefinierte Analyse-Skripte
 * -------------------------------------------------------------
 * Ein Skript ist fremder Code. In einem Werkzeug, dessen ganzer Wert auf
 * Vertrauenswürdigkeit beruht, darf so etwas NICHT im Hauptthread mit vollen
 * Rechten laufen. Deshalb:
 *
 *   - Ausführung in einem eigenen Worker. Der hat von Haus aus kein DOM,
 *     kein localStorage und keinen Zugriff auf die Oberfläche.
 *   - Alles, womit ein Skript nach außen funken könnte, wird beim Start
 *     entfernt: fetch, XMLHttpRequest, WebSocket, EventSource, importScripts,
 *     indexedDB, caches.
 *   - Das Skript bekommt KEINE Bilddaten in die Hand. Es ruft benannte
 *     Werkzeuge auf, die der Hauptthread ausführt, und erhält nur deren
 *     Ergebnisse als einfache Werte zurück.
 *   - Eine Zeitgrenze je Bild. Wer sie überschreitet, wird beendet.
 *
 * Damit kann ein Skript Analysen anstoßen und bewerten - aber nichts lesen,
 * was ihm nicht gegeben wurde, und nichts irgendwohin senden.
 */
'use strict';

/* ---------------------------------------------------- Ausgänge verschließen */
(function abriegeln() {
  var weg = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts',
             'indexedDB', 'caches', 'Notification', 'BroadcastChannel',
             'SharedWorker', 'Worker', 'navigator'];
  weg.forEach(function (name) {
    try {
      Object.defineProperty(self, name, {
        get: function () {
          throw new Error('„' + name + '“ steht Skripten nicht zur Verfügung. ' +
            'Skripte dürfen analysieren, aber nichts nachladen und nichts senden.');
        },
        configurable: false
      });
    } catch (e) { try { delete self[name]; } catch (e2) {} }
  });
})();

var wartend = new Map();
var naechsteId = 1;

/** Ruft ein Werkzeug im Hauptthread auf und wartet auf das Ergebnis. */
function werkzeugAufrufen(name, args) {
  var id = naechsteId++;
  return new Promise(function (aufloesen, ablehnen) {
    wartend.set(id, { aufloesen: aufloesen, ablehnen: ablehnen });
    self.postMessage({ type: 'werkzeug', id: id, name: name, args: args || {} });
  });
}

self.onmessage = async function (ev) {
  var m = ev.data || {};

  if (m.type === 'werkzeugErgebnis') {
    var w = wartend.get(m.id);
    if (!w) return;
    wartend.delete(m.id);
    if (m.ok) w.aufloesen(m.wert); else w.ablehnen(new Error(m.fehler || 'Werkzeug fehlgeschlagen'));
    return;
  }

  if (m.type !== 'lauf') return;

  var befunde = [], felder = {}, zeilen = [];

  /* Das ist die gesamte Oberfläche, die ein Skript sieht. */
  var werkzeuge = {
    // --- Analysen anstoßen ---
    hash:        function ()  { return werkzeugAufrufen('hash'); },
    metadaten:   function ()  { return werkzeugAufrufen('metadaten'); },
    ela:         function (o) { return werkzeugAufrufen('ela', o); },
    rauschen:    function ()  { return werkzeugAufrufen('rauschen'); },
    copyMove:    function (o) { return werkzeugAufrufen('copyMove', o); },
    blockraster: function ()  { return werkzeugAufrufen('blockraster'); },
    ghosts:      function ()  { return werkzeugAufrufen('ghosts'); },
    phash:       function ()  { return werkzeugAufrufen('phash'); },
    histogramm:  function ()  { return werkzeugAufrufen('histogramm'); },
    quantTabellen: function () { return werkzeugAufrufen('quantTabellen'); },
    erkenne:     function (o) { return werkzeugAufrufen('erkenne', o); },

    // --- Ergebnisse festhalten ---
    markiere: function (stufe, text) {
      var erlaubt = { info: 1, warn: 1, alarm: 1 };
      befunde.push({ level: erlaubt[stufe] ? stufe : 'info', text: String(text).slice(0, 600) });
    },
    setze: function (schluessel, wert) {
      felder[String(schluessel).slice(0, 80)] =
        (wert && typeof wert === 'object') ? JSON.stringify(wert).slice(0, 400) : String(wert).slice(0, 400);
    },
    notiz: function (text) { zeilen.push(String(text).slice(0, 400)); },
    // Hamming-Abstand ist reine Rechnerei und braucht keinen Umweg.
    abstand: function (a, b) { return werkzeugAufrufen('abstand', { a: a, b: b }); }
  };

  try {
    // new Function statt eval: der Rumpf sieht nur seine eigenen Parameter,
    // nicht die lokalen Variablen dieser Funktion.
    var fabrik = new Function('werkzeuge', 'bild',
      '"use strict";\nreturn (async function(){\n' + m.code + '\n})();');
    var rueckgabe = await fabrik(werkzeuge, m.bild);

    self.postMessage({
      type: 'fertig', ok: true,
      ergebnis: {
        datei: m.bild && m.bild.name,
        befunde: befunde,
        felder: felder,
        notizen: zeilen,
        rueckgabe: (rueckgabe === undefined) ? null
          : (typeof rueckgabe === 'object' ? JSON.parse(JSON.stringify(rueckgabe)) : rueckgabe)
      }
    });
  } catch (e) {
    self.postMessage({
      type: 'fertig', ok: false,
      fehler: (e && e.message) ? e.message : String(e),
      ergebnis: { datei: m.bild && m.bild.name, befunde: befunde, felder: felder, notizen: zeilen }
    });
  }
};
