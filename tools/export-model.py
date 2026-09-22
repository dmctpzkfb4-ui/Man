#!/usr/bin/env python3
"""
Exportiert ein Ultralytics-.pt-Modell nach ONNX fuer onnxruntime-web.

Bewusst konservativ: statische Eingabeform, moderates Opset. ONNX Runtime Web
ist beim Opset hinter der Desktop-Variante zurueck, und dynamische Achsen
kosten im WASM-Backend spuerbar Leistung. Lieber ein Modell das ueberall
laeuft als eines das nur auf dem Entwicklungsrechner schnell ist.
"""
import argparse, json, sys
from pathlib import Path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("weights")
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--opset", type=int, default=17)
    ap.add_argument("--out", default="www/models")
    ap.add_argument("--nms", action="store_true",
                    help="NMS in den Graphen backen, falls das Modell es unterstuetzt")
    args = ap.parse_args()

    from ultralytics import YOLO
    import onnx

    model = YOLO(args.weights)
    names = model.names
    print(f"Modell geladen: {len(names)} Klassen, Task={model.task}")

    kwargs = dict(format="onnx", imgsz=args.imgsz, opset=args.opset,
                  simplify=True, dynamic=False)
    if args.nms:
        kwargs["nms"] = True

    try:
        produced = Path(model.export(**kwargs))
    except TypeError as e:
        # Aeltere/neuere Ultralytics kennen einzelne Schalter nicht.
        print(f"Export mit vollen Optionen abgelehnt ({e}); versuche ohne nms/simplify")
        kwargs.pop("nms", None); kwargs.pop("simplify", None)
        produced = Path(model.export(**kwargs))

    out_dir = Path(args.out); out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / "model.onnx"
    target.write_bytes(produced.read_bytes())

    # Tatsaechliche Ein-/Ausgabeform auslesen statt sie anzunehmen.
    m = onnx.load(str(target))
    onnx.checker.check_model(m)

    def shape_of(vi):
        return [d.dim_value if d.HasField("dim_value") else (d.dim_param or "?")
                for d in vi.type.tensor_type.shape.dim]

    meta = {
        "quelle": Path(args.weights).name,
        "imgsz": args.imgsz,
        "opset": args.opset,
        "nmsEingebaut": bool(args.nms),
        "eingaben":  [{"name": i.name, "form": shape_of(i)} for i in m.graph.input],
        "ausgaben":  [{"name": o.name, "form": shape_of(o)} for o in m.graph.output],
        "klassen":   {int(k): v for k, v in names.items()},
        "bytes":     target.stat().st_size,
    }
    (out_dir / "model.meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    print(json.dumps({k: v for k, v in meta.items() if k != "klassen"},
                     ensure_ascii=False, indent=2))
    print(f"\nGeschrieben: {target} ({target.stat().st_size/1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
