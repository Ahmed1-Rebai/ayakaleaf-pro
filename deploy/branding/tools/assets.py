import base64, io, json, os
from PIL import Image, ImageDraw, ImageFilter
OUT = "out"; os.makedirs(OUT, exist_ok=True)
def fit_h(im, h): return im.resize((round(im.width * h / im.height), h), Image.LANCZOS)
def square(im, size, pad=0.08, bg=(0, 0, 0, 0)):
    inner = round(size * (1 - 2 * pad)); s = min(inner / im.width, inner / im.height)
    r = im.resize((max(1, round(im.width * s)), max(1, round(im.height * s))), Image.LANCZOS)
    c = Image.new("RGBA", (size, size), bg); c.alpha_composite(r, ((size - r.width) // 2, (size - r.height) // 2)); return c
light, dark = Image.open("final-light.png").convert("RGBA"), Image.open("final-dark.png").convert("RGBA")
flat = Image.open("lab-logo.png").convert("RGBA")
# 3D marks: hero (2x of ~300px) and navbar (2x of ~36px)
fit_h(light, 640).save(f"{OUT}/mark-3d.png", optimize=True); fit_h(dark, 640).save(f"{OUT}/mark-3d-dark.png", optimize=True)
fit_h(light, 96).save(f"{OUT}/mark-3d-nav.png", optimize=True); fit_h(dark, 96).save(f"{OUT}/mark-3d-nav-dark.png", optimize=True)
# Favicons from the flat mark (crisper at tiny sizes)
for s in (16, 32, 48): square(flat, s, pad=0.04).save(f"{OUT}/favicon-{s}x{s}.png")
square(flat, 48, pad=0.04).save(f"{OUT}/favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
b64 = base64.b64encode(open(f"{OUT}/favicon-48x48.png", "rb").read()).decode()
fav128 = io.BytesIO(); square(flat, 128, pad=0.04).save(fav128, "PNG"); b128 = base64.b64encode(fav128.getvalue()).decode()
svg = lambda extra="": f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><image href="data:image/png;base64,{b128}" width="128" height="128"/>{extra}</svg>'
open(f"{OUT}/favicon.svg", "w").write(svg())
# App tiles: 3D mark on a deep-navy gradient with a soft brand glow
def tile(size):
    t = Image.new("RGBA", (size, size)); d = ImageDraw.Draw(t)
    for y in range(size):  # vertical gradient #0a2a52 -> #05070d
        k = y / (size - 1); d.line([(0, y), (size, y)], fill=(round(10 + (5 - 10) * k), round(42 + (7 - 42) * k), round(82 + (13 - 82) * k), 255))
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0)); ImageDraw.Draw(glow).ellipse([size * .18, size * .2, size * .82, size * .84], fill=(3, 125, 251, 120))
    t.alpha_composite(glow.filter(ImageFilter.GaussianBlur(size * .12)))
    t.alpha_composite(square(dark, size, pad=0.17)); return t
tile(180).convert("RGB").save(f"{OUT}/apple-touch-icon.png")
for s in (192, 512): tile(s).save(f"{OUT}/icon-{s}.png", optimize=True)
json.dump({"name": "LambdaTeX", "short_name": "LambdaTeX",
           "icons": [{"src": "/img/lambdatex/icon-192.png", "type": "image/png", "sizes": "192x192"},
                     {"src": "/img/lambdatex/icon-512.png", "type": "image/png", "sizes": "512x512"}],
           "theme_color": "#05070d", "background_color": "#fafbfc", "start_url": "/", "display": "standalone"},
          open(f"{OUT}/web.sitemanifest.json", "w"), indent=2)
for f in sorted(os.listdir(OUT)): print(f"{os.path.getsize(f'{OUT}/{f}'):>8}  {f}")
# Loading screen: a faded, desaturated mark that fills in with the coloured one
from PIL import ImageOps
m = Image.open(f"{OUT}/mark-3d.png").convert("RGBA")
g = ImageOps.grayscale(m.convert("RGB")).convert("RGBA"); g.putalpha(m.getchannel("A").point(lambda v: int(v * 0.22)))
g.save(f"{OUT}/mark-3d-empty.png", optimize=True)
