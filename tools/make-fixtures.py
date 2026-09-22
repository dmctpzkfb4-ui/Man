#!/usr/bin/env python3
"""
Erzeugt die Testdaten für die Blockraster-Analyse.

Gespeichert wird reines Grau (ein Byte je Bildpunkt), weil gridOffset()
genau das erwartet - das spart gegenüber RGBA drei Viertel der Größe.

Zwei Größen mit Absicht:
  gross  - genug Fläche, damit das Gitter messbar ist -> Versatz muss stimmen
  klein  - zu wenig Fläche -> die Verlässlichkeit muss unter die Schwelle
           fallen und die App darf KEINE Aussage treffen
"""
import json, os, random
from PIL import Image, ImageDraw

ZIEL = os.path.join(os.path.dirname(__file__), "fixtures")
CROP_X, CROP_Y = 3, 5          # bewusst beide ungleich, damit x/y nicht verwechselt werden


def motiv(n, blobs, seed):
    random.seed(seed)
    im = Image.new("RGB", (n, n))
    d = ImageDraw.Draw(im)
    for _ in range(blobs):
        x, y = random.randrange(n), random.randrange(n)
        r = random.randrange(max(4, n // 60), max(8, n // 13))
        d.ellipse([x - r, y - r, x + r, y + r],
                  fill=(random.randrange(256), random.randrange(256), random.randrange(256)))
    px = im.load()
    for y in range(n):
        for x in range(n):
            r, g, b = px[x, y]
            k = random.randrange(-18, 19)
            px[x, y] = (max(0, min(255, r + k)), max(0, min(255, g + k)), max(0, min(255, b + k)))
    return im


def schreibe(name, img, manifest, erwartet, messbar):
    g = img.convert("L")
    open(os.path.join(ZIEL, name + ".gray"), "wb").write(g.tobytes())
    manifest.append({"name": name, "w": g.width, "h": g.height,
                     "erwartet": {"x": erwartet[0], "y": erwartet[1]},
                     "messbar": messbar})


def main():
    os.makedirs(ZIEL, exist_ok=True)
    for f in os.listdir(ZIEL):
        os.remove(os.path.join(ZIEL, f))
    man = []

    for kennung, n, blobs, messbar in (("gross", 512, 400, True), ("klein", 256, 180, False)):
        quelle = os.path.join(ZIEL, "_tmp.jpg")
        motiv(n, blobs, 42).save(quelle, quality=75)
        m = n - 32

        # unbeschnitten, einmal gespeichert
        schreibe(kennung + "_einmal", Image.open(quelle), man, (0, 0), messbar)

        # beschnitten und hoch neu gespeichert: das ALTE Gitter muss dominieren,
        # deshalb Qualitaet 95 - bei niedriger Qualitaet ueberdeckt das neue Gitter.
        Image.open(quelle).crop((CROP_X, CROP_Y, CROP_X + m, CROP_Y + m)).save(
            os.path.join(ZIEL, "_tmp2.jpg"), quality=95)
        schreibe(kennung + "_beschnitten", Image.open(os.path.join(ZIEL, "_tmp2.jpg")),
                 man, ((8 - CROP_X) % 8, (8 - CROP_Y) % 8), messbar)

        # Gegenprobe: gleicher Ablauf, aber ohne Beschnitt
        Image.open(quelle).crop((0, 0, m, m)).save(os.path.join(ZIEL, "_tmp3.jpg"), quality=95)
        schreibe(kennung + "_ohne_beschnitt", Image.open(os.path.join(ZIEL, "_tmp3.jpg")),
                 man, (0, 0), messbar)

        for t in ("_tmp.jpg", "_tmp2.jpg", "_tmp3.jpg"):
            os.remove(os.path.join(ZIEL, t))

    json.dump(man, open(os.path.join(ZIEL, "manifest.json"), "w"), indent=1)
    gesamt = sum(os.path.getsize(os.path.join(ZIEL, f)) for f in os.listdir(ZIEL))
    print(f"{len(man)} Testbilder, {gesamt // 1024} KB")
    for m2 in man:
        print(f"  {m2['name']:26s} {m2['w']}x{m2['h']}  erwartet "
              f"({m2['erwartet']['x']},{m2['erwartet']['y']})  messbar={m2['messbar']}")


if __name__ == "__main__":
    main()
