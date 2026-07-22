#!/usr/bin/env python3
"""Generate game art for /play via the Gemini image API (gemini-2.5-flash-image / Nano Banana).

API key comes from the macOS keychain item 'gemini-api-key' (no secrets in source).
Outputs to site/play/assets/. Tile sprite is generated as one image (style consistency)
and sliced into five equal squares: tile0.png .. tile4.png.

Usage:
  python3 scripts/gen_assets.py            # generate missing assets
  python3 scripts/gen_assets.py --force    # regenerate everything
  python3 scripts/gen_assets.py --only tiles,plate
"""
import base64, json, os, subprocess, sys, time, urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "site", "play", "assets")
MODEL = "gemini-2.5-flash-image"

STYLE = (
    "Hand-painted Portuguese azulejo ceramic, glazed faience with subtle glossy highlights and "
    "slight kiln imperfections, rich traditional ornament, museum quality, softly lit, "
    "NO text, NO letters, NO watermark, NO people. "
)

ASSETS = {
    "tiles": STYLE + (
        "A single wide image of EXACTLY FIVE square glazed ceramic board-game tiles arranged in one "
        "horizontal row, edge to edge with no gaps, each tile occupying exactly one fifth of the image "
        "width, image height equals tile height. Five distinct colourways in this exact order, all "
        "clearly different at thumbnail size: 1) deep cobalt blue tile with a white eight-point star "
        "ornament; 2) warm golden-yellow tile with an ochre floral rosette; 3) deep terracotta-red "
        "tile with a cream diamond ornament; 4) near-black charcoal tile with a thin silver geometric "
        "pattern; 5) pale turquoise tile with a teal wave ornament. Flat frontal view, square 5:1 row."
    ),
    "plate": STYLE + (
        "Top-down view of one round pale cream ceramic display plate for holding board-game tiles, "
        "a factory display from a tile-laying game: shallow rim with a delicate cobalt-blue azulejo "
        "border ornament, empty centre, on a pure white background, perfectly circular, centered, "
        "fills 90 percent of the square frame."
    ),
    "avatar": STYLE + (
        "A single square glazed ceramic azulejo tile depicting a friendly geometric robot face made "
        "of traditional Portuguese tile ornament shapes in cobalt blue and white with small turquoise "
        "accents, charming and minimal, flat frontal view, fills the whole square frame."
    ),
    "table": STYLE + (
        "Seamless background texture of warm light oak wood table surface, subtle grain, soft even "
        "light, very low contrast so UI elements remain readable on top, square."
    ),
}


def get_key():
    return subprocess.check_output(
        ["security", "find-generic-password", "-s", "gemini-api-key", "-w"]
    ).decode().strip()


def generate(api, prompt, dest, tries=3):
    body = json.dumps({
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"responseModalities": ["IMAGE"]},
    }).encode()
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={api}"
    for t in range(tries):
        try:
            req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
            d = json.loads(urllib.request.urlopen(req, timeout=150).read())
            for p in d.get("candidates", [{}])[0].get("content", {}).get("parts", []):
                inl = p.get("inlineData") or p.get("inline_data")
                if inl:
                    open(dest, "wb").write(base64.b64decode(inl["data"]))
                    return True
            print("    no image part in response")
        except urllib.error.HTTPError as e:
            print(f"    HTTP {e.code} (try {t+1}):", e.read().decode()[:160])
        except Exception as e:
            print(f"    err (try {t+1}):", str(e)[:160])
        time.sleep(4)
    return False


def slice_tiles():
    from PIL import Image, ImageChops
    src = os.path.join(OUT, "tiles.png")
    img = Image.open(src).convert("RGB")
    # авто-обрезка белых полей: bbox пикселей, отличающихся от белого
    bg = Image.new("RGB", img.size, (255, 255, 255))
    diff = ImageChops.difference(img, bg).convert("L")
    bbox = diff.point(lambda p: 255 if p > 16 else 0).getbbox()
    if bbox:
        img = img.crop(bbox)
    w, h = img.size
    fifth = w / 5
    inset = min(fifth, h) * 0.035  # маленький отступ от неровных краёв
    for i in range(5):
        box = (int(i * fifth + inset), int(inset), int((i + 1) * fifth - inset), int(h - inset))
        tile = img.crop(box).resize((256, 256), Image.LANCZOS)
        tile.save(os.path.join(OUT, f"tile{i}.png"))
    print(f"sliced tiles (content bbox {bbox}) -> tile0..4.png")


def main():
    os.makedirs(OUT, exist_ok=True)
    only = None
    if "--only" in sys.argv:
        only = set(sys.argv[sys.argv.index("--only") + 1].split(","))
    force = "--force" in sys.argv
    api = get_key()
    for name, prompt in ASSETS.items():
        if only and name not in only:
            continue
        dest = os.path.join(OUT, name + ".png")
        if os.path.exists(dest) and not force:
            print("skip", name)
            continue
        print("gen", name)
        if generate(api, prompt, dest):
            print("    ok", os.path.getsize(dest) // 1024, "KB")
        else:
            print("    FAIL", name)
        time.sleep(1)
    if (not only or "tiles" in only) and os.path.exists(os.path.join(OUT, "tiles.png")):
        slice_tiles()


if __name__ == "__main__":
    main()
