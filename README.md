# Forensik Vision

Forensische Bildanalyse mit Objekterkennung. Eine Web-Codebasis, die als
Website, als Android-APK und als iOS-App läuft.

Die App arbeitet **vollständig offline**. Modell, Laufzeitumgebung und alle
Analyseverfahren liegen auf dem Gerät; es geht kein Byte ins Netz. Das ist
bei forensischer Arbeit keine Bequemlichkeit, sondern Voraussetzung.

## Funktionen

**Live** — Objekterkennung über **Kamera oder Bildschirm** mit YOLO26n (80 COCO-Klassen),
Rahmen als Überlagerung, FPS/Inferenzzeit/Backend sichtbar, Schwellenwerte
für Konfidenz und Überlappung einstellbar, Einzelbild festhalten.

**Analyse** — für ein Standbild:
| Verfahren | Zeigt |
|---|---|
| SHA-256 / SHA-1 | Integritätsnachweis der untersuchten Datei |
| Metadaten | EXIF, GPS, PNG-Textfelder, eingebettetes Vorschaubild |
| Befunde | abgeleitete Hinweise, nach Schwere gestuft |
| ELA | Bereiche mit abweichender Kompressionsgeschichte |
| Rauschrest | retuschierte oder weichgezeichnete Zonen |
| Copy-Move | Blöcke, die weit entfernten Blöcken gleichen |
| Histogramm | Tonwertverteilung, beschnittene Tiefen und Lichter |
| Quantisierungstabellen | Qualitätsstufe und ob Kamera oder Software die Datei schrieb |
| Wahrnehmungs-Prüfsummen | aHash, dHash, pHash — bleiben bei Skalierung stabil |
| Blockraster | Versatz des 8×8-Gitters: verrät Beschnitt und eingesetzte Bereiche |
| JPEG-Ghosts | bei welcher Qualitätsstufe jede Bildkachel zuletzt gespeichert wurde |

Dazu Zoom bis 16-fach mit Ziehen und Aufziehen, ein Klassenfilter für die
Live-Erkennung, ein Bildvergleich über den pHash-Abstand und ein
Analysebericht als eigenständige HTML-Datei zum Archivieren oder Drucken.

### Quantisierungstabellen

Beim Speichern eines JPEGs werden die DCT-Koeffizienten durch eine
8×8-Tabelle geteilt, die in der Datei steht. Die freie Referenzbibliothek
leitet ihre Tabellen nach einer festen Formel aus zwei Basistabellen ab.
Trifft eine Datei diese Formel exakt, stammt sie aus gängiger Software.
Kamerahersteller verwenden eigene Tabellen — ein unberührtes Original passt
also gerade *nicht*.

Nennen die Metadaten eine Kamera, während die Tabellen aus der
Standardbibliothek stammen, ist das ein Widerspruch: Die Datei wurde neu
kodiert, die EXIF-Daten aber übernommen. Die App meldet das ausdrücklich.

**Skripte** — eigene Rezepte über einen Stapel Bilder laufen lassen. Fünf
Vorlagen liegen bei: Schnellprüfung, Manipulationsverdacht bewerten, Herkunft
bestimmen, Dubletten über pHash finden, Objekte zählen.

**Protokoll** — jeder Vorgang mit Zeitstempel, als Text oder JSON exportierbar.

Befunde sind Hinweise, keine Beweise. Die Texte in der App sagen das auch so:
Metadaten lassen sich entfernen und fälschen, gleichmäßige Flächen erzeugen
Fehlalarme im Copy-Move-Verfahren, und ein Foto ohne EXIF ist normalerweise
nur durch ein soziales Netzwerk gelaufen.

### Blockraster

JPEG komprimiert in 8×8-Blöcken. An den Blockgrenzen entstehen feine Kanten,
die im Bild ein regelmäßiges Gitter bilden. Bei einer unberührten Datei sitzt
es exakt auf Versatz (0,0). Wird ein Bild beschnitten und neu gespeichert,
wandert das alte Gitter mit. Und ein eingesetzter Bereich bringt sein *eigenes*
Gitter mit — dann hat ein Ausschnitt einen anderen Versatz als der Rest.

Das Verfahren antwortet nur oberhalb eines Kennwerts von 1,3. Diese Schwelle
ist an Testbildern mit bekanntem Beschnitt kalibriert: alle richtigen
Ergebnisse lagen bei mindestens 1,60, alle falschen bei höchstens 1,06. Sechs
Bilder sind eine kleine Stichprobe, darum die Regel — **unterhalb der Schwelle
wird gar keine Aussage getroffen**, statt eine zu erfinden.

### JPEG-Ghosts

Nach Farid (2009). Das Bild wird mit jeder Qualitätsstufe von 50 bis 98 neu
kodiert und mit sich selbst verglichen. Wurde ein Bereich früher schon einmal
mit Stufe *q* gespeichert, bricht die Differenz genau bei *q* ein — er
„verschwindet" kurz. Hat ein Ausschnitt seinen Einbruch bei einer anderen
Stufe als der Rest, hatte er eine andere Kompressionsvorgeschichte.

Braucht rund 25 Neukodierungen und läuft deshalb auf Anforderung, nicht
automatisch. Es kommt ohne JPEG-Dekoder aus: nur Kodieren und Subtrahieren.

### Bildschirm als Bildquelle

Zwei Wege, weil es keinen gemeinsamen gibt:

Im Browser liefert `getDisplayMedia` einen Strom wie eine Kamera. **Android
WebView kennt `getDisplayMedia` nicht** — dort holt ein eigenes Capacitor-Plugin
über `MediaProjection` Einzelbilder als JPEG. Beide Wege enden in derselben
Erkennungsschleife; der Unterschied steckt allein in `holeBild()`.

Ab Android 14 verweigert das System `MediaProjection`, wenn nicht *vorher* ein
Vordergrunddienst mit dem Typ `mediaProjection` läuft, und
`registerCallback()` muss vor dem `VirtualDisplay` stehen. Beides ist im
Plugin in genau dieser Reihenfolge umgesetzt.

Die Aufnahme braucht die Zustimmung im Systemdialog, und solange sie läuft,
bleibt eine Benachrichtigung sichtbar. Das ist so gewollt und wird nicht
umgangen. Die Bilder verlassen das Gerät nicht — sie gehen direkt in die
Erkennung und werden danach verworfen.

Aufgenommen wird auf 720 px Breite begrenzt: die Erkennung arbeitet ohnehin
auf 320 bzw. 640 Pixeln, eine volle Bildschirmauflösung je Bild zu übertragen
wäre reine Verschwendung.

### Wie Skripte abgeriegelt sind

Ein Rezept ist fremder Code. In einem Werkzeug, dessen ganzer Wert auf
Vertrauenswürdigkeit beruht, darf so etwas nicht im Hauptthread mit vollen
Rechten laufen. Deshalb:

- Ausführung in einem eigenen Worker — kein DOM, kein `localStorage`, kein
  Zugriff auf die Oberfläche.
- Alles, womit ein Skript nach außen funken könnte, wird beim Start entfernt:
  `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `importScripts`,
  `indexedDB`, `caches`, `Worker`.
- Das Skript bekommt **keine Bilddaten in die Hand**. Es ruft benannte
  Werkzeuge auf, die der Hauptthread ausführt, und erhält nur deren Ergebnisse
  als einfache Werte zurück.
- Ein eigener Worker je Datei. Dadurch lässt sich die Zeitgrenze von 45 s hart
  durchsetzen (Beenden), und ein Skript kann keinen Zustand von einer Datei zur
  nächsten schmuggeln.
- Verarbeitung nacheinander, nicht gleichzeitig: parallele Analysen bringen ein
  Mobilgerät zum Stocken, und die Reihenfolge bleibt nachvollziehbar.

Ein Rezept kann damit Analysen anstoßen und bewerten — aber nichts lesen, was
ihm nicht gegeben wurde, und nichts irgendwohin senden.

## Bauen

```bash
tools/setup-android-sdk.sh
npm install
npx cap sync android
cd android && ./gradlew assembleDebug
```

Für den Web-Betrieb genügt es, `www/` statisch auszuliefern.
Für iOS: `npx cap sync ios`, dann `ios/App/App.xcworkspace` in Xcode öffnen.

## Tests

```bash
node tools/test-forensics.mjs    # 83 Prüfungen, reine Rechnerei
node tools/test-detector.mjs     # 16 Prüfungen, Letterbox und NMS
node tools/test-skripte.mjs      # 19 Prüfungen, Sandkasten und Vertrag
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
  node tools/test-browser.mjs    # 33 Prüfungen im echten Chromium
```

Die Referenzwerte für Letterbox und Rückrechnung stammen aus einer
Python-Implementierung, die gegen das echte ONNX-Modell gelaufen ist.

**Der Browsertest ist der wichtigste.** Er lädt die Seite in Chromium, wartet
auf die Erkennung, lässt sie über ein echtes Bild laufen und prüft die
Treffer. Zwei Fehler sind ohne ihn bis aufs Gerät durchgerutscht: ein
Worker-Pfad, der relativ zur falschen Datei aufgelöst wurde, und ein
Laufzeit-Bündel, das nicht zu den mitgelieferten `.wasm`-Dateien passte.
Beide hätte er in Sekunden gefunden.

## Modell

`tools/export-model.py` exportiert ein Ultralytics-`.pt` nach ONNX. Zwei
Varianten liegen bei, weil eine Größe nicht beiden Zwecken dient:

| Datei | Eingang | Ausgabe | Zweck |
|---|---|---|---|
| `model-320.onnx` | 320×320 | `[1,84,2100]` | Live-Kamera |
| `model.onnx` | 640×640 | `[1,84,8400]` | Standbild |

Gemessen auf vier CPU-Kernen: 8,9 ms gegen 34,0 ms je Bild. Erst die kleine
Variante macht eine Live-Vorschau überhaupt möglich.

Die Ausgabe ist transponiert (`[1, 84, N]`): vier Boxwerte plus 80
Klassenscores, **ohne** eigene Objectness-Spalte. NMS steckt nicht im Graphen
und läuft clientseitig.

## Entscheidungen, die nicht zurückgedreht werden sollten

**Laufzeitumgebung liegt lokal — und das Bündel muss zu den Dateien passen.**
`www/vendor/` enthält ONNX Runtime und das WASM-Modul. Entscheidend ist die
richtige Kombination, denn die Bündel erwarten unterschiedliche Laufzeitdateien:

| Bündel | erwartet | Größe |
|---|---|---|
| `ort.min.js` | `…jsep.mjs` + `.jsep.wasm` | 27,6 MB |
| **`ort.wasm.min.js`** | `…mjs` + `.wasm` | **13,6 MB** |
| `ort.webgpu.min.js` | `…asyncify.*` | 26 MB |

Gebündelt ist `ort.wasm.min.js` mit den passenden Dateien. `ort.min.js` ist
trotz des Namens *nicht* der WASM-Build, sondern der Standard-Build mit jsep —
diese Verwechslung legte die Erkennung still lahm, weil die erwartete
`.jsep.mjs` schlicht fehlte.

**Ein Thread.** WebViews auf Android und iOS sind nicht cross-origin-isoliert.
Ohne `SharedArrayBuffer` scheitert Multi-Threading hart, deshalb
`numThreads = 1`.

**Inferenz im Worker.** Sonst ruckelt die Kameravorschau bei jedem Bild.
Frames gehen als Transferable hinüber, ohne Pixel zu kopieren.

**Fensterränder nativ.** `targetSdk 36` erzwingt Edge-to-Edge, und Android
WebView befüllt `env(safe-area-inset-*)` nur aus Display-Notches, nicht aus
den Systemleisten. `MainActivity` legt die Insets selbst als Padding an.

**Koordinaten werden geklemmt.** Am Bildrand angeschnittene Objekte liefern
negative Werte; ungeklemmt zeichnet die Oberfläche außerhalb der Leinwand.
