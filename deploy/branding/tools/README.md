# LambdaTeX asset build

Regenerates the logo set in `../lambdatex/` from the LAMBDA website's assets. The inputs
are not committed. Copy them into this folder first:

- `3dlambda.glb`, from `lambda-website/apps/web/public/models/` (the 3D mark)
- `lab-logo.png`, from `lambda-website/apps/web/public/` (the flat mark)

Build them in a container with Playwright, Pillow, NumPy and potrace
(`mcr.microsoft.com/playwright/python:v1.55.0-noble` plus `pip install playwright==1.55.0
pillow numpy` and `apt-get install potrace`):

```bash
mkdir -p out
python3 -m http.server 8765 --bind 127.0.0.1 &   # render.html loads the .glb over HTTP
python3 render2.py jobs-final.json                # 3D renders, website lighting (three r185)
python3 assets.py                                 # PNG marks, favicons, app tiles, manifest
python3 vectorize.py                              # two-colour SVG logo, SVG favicons, status icons
cp out/* ../lambdatex/
```

`render.html` reuses the website's light/dark scene presets
(`apps/web/src/components/lambda-hero/lambda-scene.ts`). `jobs-final.json` holds the
still-image tuning: lower exposure and ambient, and less star glow so the sparkles stay navy.

## Welcome page screenshots

`welcome_screenshots.py` makes `welcome-editor.webp` and `welcome-assistant.webp` from a real
session: it uploads a demo project (textbook notes on linear regression), asks the AI assistant
for a small edit and a compile, captures the editor and the assistant panel at 2x, converts them
to WebP in the browser, and deletes the project and its conversation. Run it in the Playwright
image like the browser tests, with `-e OUT=/out` and a mounted output folder, and review the
images before copying them into `../lambdatex/` (then bump `?v=` in `deploy/patches/home/index.pug`).
