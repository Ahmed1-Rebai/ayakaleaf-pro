"""Browser test for the welcome page at / (deploy/patches/home/). Runs in the
Playwright image; see README.md here. Read-only: creates nothing."""
import os, time
from playwright.sync_api import sync_playwright

B = os.environ.get("OL_URL", "http://127.0.0.1:8001")
EMAIL, PW = os.environ["OL_EMAIL"], os.environ["OL_PW"]
OUT = os.environ.get("LT_TEST_DIR", "/tmp/lambdatex-tests"); os.makedirs(OUT, exist_ok=True)
results = {}


def check(name, ok, detail=""):
    results[name] = bool(ok); print(f"{'PASS' if ok else 'FAIL'} {name} {detail}", flush=True)


# The navbar must be visible above the page (not covered by the hero), and the
# screenshots must load.
NAV_JS = """() => { const n = document.querySelector('nav.navbar'); if (!n) return false;
  const r = n.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return !!hit && n.contains(hit) }"""
IMAGES_JS = """() => [...document.querySelectorAll('.lt-welcome img')].filter(i => !(i.complete && i.naturalWidth > 0)).map(i => i.src)"""

with sync_playwright() as p:
    b = p.chromium.launch()
    for name, viewport in [("desktop", {"width": 1440, "height": 900}), ("tablet", {"width": 820, "height": 1180}), ("phone", {"width": 390, "height": 844})]:
        pg = b.new_page(viewport=viewport)
        errors = []
        pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: errors.append(str(e)))
        r = pg.goto(B + "/"); pg.wait_for_load_state("networkidle"); time.sleep(1)
        check(f"{name}: / shows the welcome page (no redirect)", r.status == 200 and pg.url.rstrip("/") == B and pg.locator(".lt-hero h1").count() == 1, pg.url)
        check(f"{name}: no horizontal scroll", pg.evaluate("() => document.documentElement.scrollWidth <= window.innerWidth"),
              str(pg.evaluate("() => [document.documentElement.scrollWidth, window.innerWidth]")))
        check(f"{name}: navbar visible", pg.evaluate(NAV_JS))
        for img in pg.locator(".lt-welcome img").all(): img.scroll_into_view_if_needed()
        time.sleep(1)
        broken = pg.evaluate(IMAGES_JS)
        check(f"{name}: screenshots load", not broken, str(broken))
        check(f"{name}: no console errors", not errors, str(errors[:3]))
        pg.screenshot(path=os.path.join(OUT, f"welcome-{name}.png"), full_page=True)
        pg.close()

    pg = b.new_page(viewport={"width": 1440, "height": 900})
    pg.goto(B + "/"); pg.locator(".lt-hero .lt-actions a", has_text="Log in").click(); pg.wait_for_url("**/login")
    check("Log in button opens /login", pg.url.endswith("/login"))
    pg.goto(B + "/"); pg.locator(".lt-hero .lt-actions a", has_text="Request an account").click(); pg.wait_for_url("**/register")
    check("Request an account opens /register", pg.url.endswith("/register"))
    pg.goto(B + "/login"); pg.locator("a.navbar-brand").click(); pg.wait_for_load_state()
    check("logo on the login page leads to the welcome page", pg.locator(".lt-hero h1").count() == 1)
    pg.goto(B + "/project"); check("/project still requires login", "/login" in pg.url, pg.url)

    pg.goto(B + "/login"); pg.fill('input[name="email"]', EMAIL); pg.fill('input[name="password"]', PW)
    pg.click('button[type="submit"]'); pg.wait_for_url("**/project")
    pg.goto(B + "/"); pg.wait_for_load_state()
    check("logged-in users go from / to their projects", pg.url.endswith("/project"), pg.url)
    b.close()

print("SUMMARY", results, "| all passed:", all(results.values()))
