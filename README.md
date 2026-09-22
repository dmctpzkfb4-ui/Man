# Forensik Vision

Forensische Bildanalyse mit Objekterkennung. Eine Web-Codebasis, die als
Website, als Android-APK und als iOS-App läuft.

Die App arbeitet **vollständig offline**. Modell, Laufzeitumgebung und alle
Analyseverfahren liegen auf dem Gerät; es geht kein Byte ins Netz. Das ist
bei forensischer Arbeit keine Bequemlichkeit, sondern Voraussetzung.

## Funktionen

**Live** — Objekterkennung über die Kamera mit YOLO26n (80 COCO-Klassen),
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

**Protokoll** — jeder Vorgang mit Zeitstempel, als Text oder JSON exportierbar.

Befunde sind Hinweise, keine Beweise. Die Texte in der App sagen das auch so:
Metadaten lassen sich entfernen und fälschen, gleichmäßige Flächen erzeugen
Fehlalarme im Copy-Move-Verfahren, und ein Foto ohne EXIF ist normalerweise
nur durch ein soziales Netzwerk gelaufen.

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
node tools/test-forensics.mjs    # 40 Prüfungen
node tools/test-detector.mjs     # 16 Prüfungen
```

Die Referenzwerte für Letterbox und Rückrechnung stammen aus einer
Python-Implementierung, die gegen das echte ONNX-Modell gelaufen ist.

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

**Laufzeitumgebung liegt lokal.** `www/vendor/` enthält ONNX Runtime und das
WASM-Modul. Der WebGPU-Pfad bräuchte 28 MB statt 14 MB und ist auf
Android-WebViews unzuverlässig; der WASM-Pfad läuft überall.

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
