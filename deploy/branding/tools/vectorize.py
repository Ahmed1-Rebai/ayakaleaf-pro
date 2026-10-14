import re, subprocess
import numpy as np
from PIL import Image
SRC, S = "lab-logo.png", 2
im = Image.open(SRC).convert("RGBA"); W, H = im.size
big = np.asarray(im.resize((W * S, H * S), Image.LANCZOS)).astype(int)
rgb, a = big[..., :3], big[..., 3]
layers = {"#004a82": np.array([0x00, 0x4a, 0x82]), "#037dfb": np.array([0x03, 0x7d, 0xfb])}
d = {k: ((rgb - v) ** 2).sum(-1) for k, v in layers.items()}
paths = {}
for k in layers:
    other = [o for o in layers if o != k][0]
    mask = (a > 127) & (d[k] <= d[other])
    Image.fromarray(np.where(mask, 0, 255).astype(np.uint8)).convert("1").save(f"layer.pbm")
    svg = subprocess.run(["potrace", "layer.pbm", "-s", "--flat", "-t", "20", "-a", "1.15", "-O", "0.9", "-o", "-"], capture_output=True, text=True, check=True).stdout
    g = re.search(r'<g transform="([^"]+)"[^>]*>\s*<path d="([^"]+)"', svg, re.S)
    paths[k] = (g.group(1), re.sub(r"\s+", " ", g.group(2)))
VB = f"0 0 {W * S} {H * S}"
def body(fill=None):
    return "".join(f'<g transform="{t}" fill="{fill or k}"><path d="{p}"/></g>' for k, (t, p) in paths.items())
open("out/lambda-logo.svg", "w").write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{VB}">{body()}</svg>')
# square icon: centre the mark in a padded square viewBox
side = max(W, H) * S * 1.08; ox, oy = (side - W * S) / 2, (side - H * S) / 2
sq = lambda inner, extra="": (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {side:.0f} {side:.0f}">'
                              f'<g transform="translate({ox:.0f},{oy:.0f})">{inner}</g>{extra}</svg>')
open("out/favicon.svg", "w").write(sq(body()))
open("out/mask-favicon.svg", "w").write(sq(body("#000")))
# compile-status favicons: the mark plus a status badge, bottom-right
r = side * 0.2; cx, cy = side - r * 1.02, side - r * 1.02
ring = f'<circle cx="{cx:.0f}" cy="{cy:.0f}" r="{r * 1.16:.0f}" fill="#fff"/>'
badge = {
  "compiled":  f'<circle cx="{cx:.0f}" cy="{cy:.0f}" r="{r:.0f}" fill="#059669"/><path d="M{cx - r*.45:.0f} {cy:.0f} l{r*.32:.0f} {r*.32:.0f} l{r*.6:.0f} -{r*.62:.0f}" fill="none" stroke="#fff" stroke-width="{r*.24:.0f}" stroke-linecap="round" stroke-linejoin="round"/>',
  "compiling": f'<circle cx="{cx:.0f}" cy="{cy:.0f}" r="{r:.0f}" fill="#2563eb"/>' + "".join(f'<circle cx="{cx + dx * r * .42:.0f}" cy="{cy:.0f}" r="{r*.13:.0f}" fill="#fff"/>' for dx in (-1, 0, 1)),
  "error":     f'<circle cx="{cx:.0f}" cy="{cy:.0f}" r="{r:.0f}" fill="#dc2626"/><path d="M{cx:.0f} {cy - r*.5:.0f} v{r*.56:.0f}" stroke="#fff" stroke-width="{r*.24:.0f}" stroke-linecap="round"/><circle cx="{cx:.0f}" cy="{cy + r*.42:.0f}" r="{r*.14:.0f}" fill="#fff"/>',
}
for name, b in badge.items():
    open(f"out/favicon-{name}.svg", "w").write(sq(body(), ring + b))
import os
for f in sorted(os.listdir("out")):
    if f.endswith(".svg"): print(f"{os.path.getsize('out/' + f):>7}  {f}")
