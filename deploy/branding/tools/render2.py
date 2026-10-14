import base64, io, json, sys
from playwright.sync_api import sync_playwright
from PIL import Image
jobs = json.load(open(sys.argv[1]))
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
    pg = b.new_page(); pg.goto("http://127.0.0.1:8765/render.html"); pg.wait_for_function("window.ready === true", timeout=120000)
    for j in jobs:
        name = j.pop("name")
        im = Image.open(io.BytesIO(base64.b64decode(pg.evaluate("(o) => window.renderMark(o)", j).split(",", 1)[1]))).convert("RGBA")
        bbox = im.getchannel("A").point(lambda a: 255 if a > 8 else 0).getbbox(); im.crop(bbox).save(name); print(name, im.crop(bbox).size)
    b.close()
