#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright"]
# ///
"""Regenerate the README media in docs/media/ from a fictional, fully isolated demo.

    scripts/demo-media.py

Everything runs in a throwaway world: its own DSH_HOME, hc core, mock LLM (scripted English
replies, see DEMOS in mock-llm.py), a fictional project in /tmp/dsh-demo/acme-api, a second
Herdr App instance on that core, and headless Chromium for DSH Web. Your own DSH, hc core and
Herdr App are not touched.

macOS only (Herdr App screenshots). Needs ffmpeg, cwebp and img2webp (libwebp). The demo Herdr window must stay
visible while it records (about a minute): macOS stops drawing covered windows, so don't switch
windows until the script says it's done. It checks every screenshot is fresh.
"""

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
DEMO = Path("/tmp/dsh-demo")
ISO = DEMO / "iso"
PROJECT = DEMO / "acme-api"
APP_HOME = DEMO / "herdr-app"
OUT = ROOT / "docs" / "media"
HERDR = "/Applications/Herdr.app/Contents/MacOS/Herdr"
RELEASES = Path("/var/tmp/acme-releases")
SIZE = (1280, 820)  # logical window and viewport size; screenshots are 2x

FIX = "The date parsing test is failing. Find out why and fix it."
REVIEW = "Review the uncommitted changes in billing/ and list anything risky."
RELEASE = "Copy the 1.4.0 build to the shared release folder /var/tmp/acme-releases."


def env():
    """The isolated world's environment (scripts/dev.sh env), plus the demo Herdr App home."""
    e = dict(os.environ, DSH_BRIDGE_ISO=str(ISO), MOCK_LLM_PORT="18766", HERDR_APP_HOME=str(APP_HOME))
    lines = subprocess.run([ROOT / "scripts/dev.sh", "env"], env=e, capture_output=True, text=True, check=True).stdout
    for line in lines.splitlines():
        if line.startswith("export ") and "=" in line:
            key, value = line[7:].split("=", 1)
            e[key] = value.strip('"').replace("$PATH", os.environ["PATH"])
        elif line.startswith("unset "):
            for key in line.split()[1:]:
                e.pop(key, None)
    return e


E = env()


def run(*args, check=True, **kw):
    return subprocess.run([str(a) for a in args], env=E, capture_output=True, text=True, check=check, **kw).stdout


def hc_json(*args):
    return json.loads(run("hc", *args, "--json"))


def app(*args):
    return run(HERDR, *args)


def do(command, payload=None):
    return json.loads(app("do", command, json.dumps(payload or {})))


def say(message):
    print(f"demo-media: {message}", flush=True)


# --- the world ---------------------------------------------------------------------------------

def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def make_project():
    shutil.rmtree(PROJECT, ignore_errors=True)
    for f in ("acme/__init__.py", "tests/__init__.py", "billing/__init__.py"):
        write(PROJECT / f, "")
    write(PROJECT / "acme/dates.py", '''from datetime import datetime, timezone


def parse_date(value: str) -> datetime:
    """Parse an ISO 8601 timestamp as UTC."""
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
''')
    write(PROJECT / "tests/test_dates.py", '''import unittest
from datetime import timezone

from acme.dates import parse_date


class ParseDateTest(unittest.TestCase):
    def test_date_and_time(self):
        self.assertEqual(parse_date("2026-03-01T09:30:00").hour, 9)

    def test_is_utc(self):
        self.assertEqual(parse_date("2026-03-01T09:30:00").tzinfo, timezone.utc)

    def test_midnight(self):
        self.assertEqual(parse_date("2026-03-01T00:00:00").hour, 0)

    def test_leap_day(self):
        self.assertEqual(parse_date("2028-02-29T12:00:00").day, 29)

    def test_rejects_garbage(self):
        with self.assertRaises(ValueError):
            parse_date("yesterday")

    def test_utc_suffix(self):
        self.assertEqual(parse_date("2026-03-01T09:30:00Z").minute, 30)
''')
    write(PROJECT / "billing/invoice.py", '''from decimal import ROUND_HALF_UP, Decimal


def total(lines):
    """Sum invoice lines, rounding each line to cents."""
    return sum((Decimal(l.price) * l.qty).quantize(Decimal("0.01"), ROUND_HALF_UP) for l in lines)
''')
    write(PROJECT / "dist/acme_api-1.4.0-py3-none-any.whl", "placeholder wheel\n")
    git = ["git", "-C", PROJECT, "-c", "user.name=Acme", "-c", "user.email=dev@acme.example"]
    run(*git, "init", "-q")
    run(*git, "add", "-A")
    run(*git, "commit", "-qm", "Initial import")
    write(PROJECT / "billing/invoice.py", '''from decimal import ROUND_HALF_UP, Decimal

CENT = Decimal("0.01")


def total(lines):
    """Sum invoice lines, then round the invoice total to cents."""
    raw = sum(Decimal(l.price) * l.qty for l in lines)
    return raw.quantize(CENT, ROUND_HALF_UP)


def tax(lines, rate):
    """Tax on the rounded total."""
    return (total(lines) * Decimal(rate)).quantize(CENT, ROUND_HALF_UP)
''')


def start_world():
    stop_world()
    shutil.rmtree(ISO, ignore_errors=True)
    shutil.rmtree(RELEASES, ignore_errors=True)
    make_project()
    say("starting the isolated DSH, hc core and mock LLM")
    run(ROOT / "scripts/dev.sh", "up")


def stop_world():
    if (APP_HOME / "herdr-app.sock").exists():
        run(HERDR, "do", "app.quit", check=False)
    run(ROOT / "scripts/dev.sh", "down", check=False)
    shutil.rmtree(RELEASES, ignore_errors=True)


# --- Herdr App ---------------------------------------------------------------------------------

def start_herdr_app():
    """A second Herdr App on the demo core. `open -n` brings it to the front; pre-seeded settings
    skip the first-run welcome and what's-new, and fix the window size."""
    shutil.rmtree(APP_HOME, ignore_errors=True)
    APP_HOME.mkdir(parents=True)
    version = run(HERDR, "--version").split()[-1]
    write(APP_HOME / "shared.json", json.dumps({"frame.welcomed": "skipped"}))
    write(APP_HOME / "update-notes.json", json.dumps({"last_run": version, "presented": []}))
    write(APP_HOME / "settings.json", json.dumps({"sounds": {"enabled": False}}))
    write(APP_HOME / "window.json", json.dumps({"state": "windowed", "bounds": [80.0, 60.0, *map(float, SIZE)]}))
    keys = ["HERDR_APP_HOME", "HC_SESSION", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "PATH"]
    run("open", "-n", "-a", "/Applications/Herdr.app", *[f"--env={k}={E[k]}" for k in keys], "--env=HERDR_APP_NO_SOUND=1")
    for _ in range(60):
        if run(HERDR, "status", check=False).strip().startswith("{"):
            return
        time.sleep(0.5)
    sys.exit("demo-media: the demo Herdr App did not start")


LAST_SHOT = {}


def shot(path, changed=True):
    """Save the demo Herdr window. When the view just changed, insist on a new frame: macOS
    stops drawing covered windows, and `herdr-app shot` would hand back a stale one."""
    for attempt in range(60):
        time.sleep(0.6)
        run(HERDR, "shot", path)
        digest = hashlib.sha256(Path(path).read_bytes()).hexdigest()
        if not changed or digest != LAST_SHOT.get("digest"):
            LAST_SHOT["digest"] = digest
            return path
        if attempt == 5:
            say("the demo Herdr window is not redrawing: bring it to the front and leave it visible")
    sys.exit("demo-media: the demo Herdr window never redrew; keep it in front and rerun")


def focus(terminal):
    do("agent.focus", {"terminal": terminal})


# --- DSH Web (headless) ------------------------------------------------------------------------

COMPOSER = "[role=textbox]"


def web_url():
    log = (ISO / "web.log").read_text()
    return next(w for w in log.split() if w.startswith("http://127.0.0.1:") and "token=" in w)


def open_web(browser):
    page = browser.new_page(viewport={"width": SIZE[0], "height": SIZE[1]}, device_scale_factor=2)
    page.goto(web_url())
    page.wait_for_selector(COMPOSER, timeout=30000)
    if page.get_by_role("button", name="Continue").count():
        page.get_by_role("button", name="Continue").click()
    return page


def web_prompt(page, text):
    page.get_by_role("button", name="New Session").first.click()
    page.wait_for_timeout(800)
    page.locator(COMPOSER).first.click()
    page.keyboard.type(text)
    page.locator('button[aria-label="Send message"]').click()


# --- the scenes --------------------------------------------------------------------------------

def dsh_terminals():
    return {t["address"]: t for t in hc_json("ls")["terminals"] if t.get("agent") == "dsh"}


def wait_state(terminal, state, timeout=60):
    for _ in range(timeout * 2):
        if (hc_json("get", terminal).get("status") or {}).get("state") == state:
            return
        time.sleep(0.5)
    sys.exit(f"demo-media: {terminal} never reached {state}")


def main():
    for tool in ("ffmpeg", "cwebp", "img2webp"):
        if not shutil.which(tool):
            sys.exit(f"demo-media: needs {tool}")
    if not Path(HERDR).exists():
        sys.exit("demo-media: needs Herdr App in /Applications")
    frames = Path(tempfile.mkdtemp(prefix="dsh-demo-frames-"))
    try:
        start_world()
        hc = lambda *a: run("hc", *a)
        say("running the fictional sessions")
        hc("run", "--bg", "--name", "fix-date-parsing", "--cwd", PROJECT, "dsh", FIX)
        hc("wait", "fix-date-parsing", "--timeout", "120")
        hc("run", "--bg", "--name", "review-billing", "--cwd", PROJECT, "dsh", REVIEW)
        wait_state("review-billing", "working")

        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = open_web(browser)
            before = set(dsh_terminals())
            web_prompt(page, RELEASE)
            page.get_by_role("button", name="Allow once").wait_for(timeout=60000)
            release = next(iter(set(dsh_terminals()) - before))
            wait_state(release, "blocked")

            say("opening the demo Herdr App: keep its window in front until the script finishes")
            start_herdr_app()
            space = do("space.new", {"name": "acme-api", "folder": str(PROJECT)})
            for t in ("fix-date-parsing", "review-billing", release):
                hc("label", t, f"herdr.space={space['space']}")
            time.sleep(2)
            do("tab.close", {"id": space["tab"], "confirmed": True})
            fix = hc_json("get", "fix-date-parsing")["address"]

            say("recording")
            focus(fix)
            shot(frames / "hero.png")
            page.screenshot(path=frames / "web-blocked.png")
            focus(release)
            shot(frames / "herdr-blocked.png")

            # The approval, answered in Herdr: the DSH dialog is withdrawn.
            hc("send", "--force", release, "y")
            for i in range(14):
                started = time.monotonic()
                page.screenshot(path=frames / f"web-{i:02d}.png")
                shot(frames / f"herdr-{i:02d}.png", changed=False)
                time.sleep(max(0, 0.5 - (time.monotonic() - started)))
            browser.close()

        say("encoding")
        OUT.mkdir(parents=True, exist_ok=True)
        encode(frames)
        say(f"done: {', '.join(sorted(p.name for p in OUT.iterdir()))}; you can switch windows again")
    finally:
        stop_world()
        shutil.rmtree(frames, ignore_errors=True)


def ff(*args):
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *map(str, args)], check=True)


def webp(src, dst, width):
    tmp = dst.with_suffix(".tmp.png")
    ff("-i", src, "-vf", f"scale={width}:-2:flags=lanczos", tmp)
    subprocess.run(["cwebp", "-quiet", "-q", "88", tmp, "-o", dst], check=True)
    tmp.unlink()


def encode(frames):
    webp(frames / "hero.png", OUT / "herdr-app.webp", 1600)
    side = frames / "approval.png"
    ff("-i", frames / "web-blocked.png", "-i", frames / "herdr-blocked.png", "-filter_complex", "hstack", side)
    webp(side, OUT / "approval.webp", 2000)
    # The animated version: blocked first, then each pair of frames after the answer.
    pairs = frames / "pairs"
    pairs.mkdir()
    sequence = [("web-blocked", "herdr-blocked")] * 3 + [(f"web-{i:02d}", f"herdr-{i:02d}") for i in range(14)]
    for n, (w, h) in enumerate(sequence):
        ff("-i", frames / f"{w}.png", "-i", frames / f"{h}.png", "-filter_complex", "hstack,scale=1600:-2:flags=lanczos", pairs / f"{n:03d}.png")
    names = sorted(pairs.glob("*.png"))
    subprocess.run(["img2webp", "-loop", "0", "-lossy", "-q", "80", "-d", "500", *names[:-1], "-d", "2500", names[-1],
                    "-o", OUT / "approval.anim.webp"], check=True, capture_output=True)


if __name__ == "__main__":
    main()
