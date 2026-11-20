# API Check interface QA against a local `wrangler dev` with DEV_TOOLS=1 and a fresh database.
# Walks the real flows with the test provider, captures every screen at several widths in both themes,
# and fails on console errors, failed requests, horizontal overflow, duplicate ids and serious axe findings.
# Usage: python3 qa/check.py [base_url]
import json, sys, time, os
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8790'
SHOTS = os.path.join(os.path.dirname(__file__), '..', 'shots')
AXE = open(os.path.join(os.path.dirname(__file__), '..', 'node_modules', 'axe-core', 'axe.min.js')).read()
problems = []

def note(msg):
    problems.append(msg); print('PROBLEM:', msg)

def checks(page, name):
    over = page.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
    if over > 1: note(f'{name}: page scrolls sideways by {over}px')
    dup = page.evaluate("() => { const s = {}; for (const e of document.querySelectorAll('[id]')) s[e.id] = (s[e.id] || 0) + 1; return Object.keys(s).filter(k => s[k] > 1); }")
    if dup: note(f'{name}: duplicate ids {dup}')
    page.add_script_tag(content=AXE)
    res = page.evaluate("async () => (await axe.run(document, {resultTypes: ['violations']})).violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => v.id + ': ' + v.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | '))")
    for r in res: note(f'{name}: axe {r}')

def shot(page, name, full=True):
    page.screenshot(path=os.path.join(SHOTS, name + '.png'), full_page=full)

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}, color_scheme='light', bypass_csp=True)
    page = ctx.new_page()
    errors = []
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('response', lambda r: errors.append(f'{r.status} {r.url}') if r.status >= 500 else None)

    page.goto(BASE); page.wait_for_selector('#loginForm')
    shot(page, '01-first-run'); checks(page, 'first run')
    page.fill('#suCode', 'local-setup-token-0123456789abcdef'); page.fill('#lgEmail', 'andrey@example.com'); page.fill('#lgPass', 'correct horse 1'); page.fill('#lgPass2', 'correct horse 1')
    page.click('button[type=submit]'); page.wait_for_selector('.first')
    shot(page, '02-empty'); checks(page, 'empty workspace')

    # add a key: wrong one first, then the test key
    page.click('[data-act=keyAdd]'); page.wait_for_selector('dialog[open]')
    page.check('input[name=kpv][value=fake]'); page.wait_for_timeout(200)
    page.fill('#kKey', 'wrong-key-0123456789'); page.click('dialog button[type=submit]'); page.wait_for_selector('dialog .err:not([hidden])')
    shot(page, '03-key-refused', False)
    page.fill('#kKey', 'test-key-0123456789'); page.fill('#kLabel', 'Test cloud'); page.click('dialog button[type=submit]')
    page.wait_for_selector('dialog', state='hidden'); page.wait_for_timeout(500)
    checks(page, 'after key')

    # a watch that only tells
    page.goto(BASE + '/#new'); page.wait_for_selector('.opt'); page.wait_for_timeout(400)
    shot(page, '04-new-watch'); checks(page, 'editor')
    page.check('.opt input[value=fake_8x_h100]'); page.check('.opt input[value=fake_4x_h100]'); page.wait_for_timeout(200)
    page.click('[data-act=edDown][data-i="0"]'); page.wait_for_timeout(100)
    page.click('[data-act=edEvery][data-v="2"]')
    shot(page, '05-new-watch-filled')
    page.click('[data-act=edSave]'); page.wait_for_selector('.live')
    page.wait_for_timeout(9000)
    shot(page, '06-watch'); checks(page, 'watch page')

    # a watch that starts a machine
    page.goto(BASE + '/#new'); page.wait_for_selector('.opt'); page.wait_for_timeout(300)
    page.check('.opt input[value=fake_1x_a100]'); page.check('input[name=edMode][value=launch]'); page.wait_for_timeout(200)
    page.click('[data-act=edSave]'); page.wait_for_selector('#edErr:not([hidden])')
    shot(page, '07-launch-missing-key', False)
    page.select_option('#lf_ssh_key', 'laptop'); page.fill('#edName', 'One A100 now')
    page.click('[data-act=edSave]'); page.wait_for_selector('.live'); page.wait_for_timeout(8000); page.reload(); page.wait_for_selector('.live')
    shot(page, '08-launch-done'); checks(page, 'launched watch')

    for route, name in [('watches', '09-watches'), ('market', '10-market'), ('machines', '11-machines'), ('activity', '12-activity'), ('keys', '13-keys'), ('users', '14-users'), ('settings', '15-settings')]:
        page.goto(BASE + '/#' + route); page.wait_for_timeout(1800)
        shot(page, name); checks(page, route)

    # widths and dark theme for the main screens
    for w in [360, 390, 768, 1280, 1920]:
        page.set_viewport_size({'width': w, 'height': 860})
        for route in ['watches', 'new', 'market', 'machines']:
            page.goto(BASE + '/#' + route); page.wait_for_timeout(1500)
            shot(page, f'w{w}-{route}'); checks(page, f'{route} at {w}')
        wid = page.evaluate("async () => (await (await fetch('/api/watches')).json()).items[0].id")
        page.goto(BASE + '/#watch/' + wid); page.wait_for_timeout(1500); shot(page, f'w{w}-watch'); checks(page, f'watch at {w}')
    page.emulate_media(color_scheme='dark'); page.set_viewport_size({'width': 1440, 'height': 900})
    for route in ['watches', 'new', 'market', 'machines', 'settings']:
        page.goto(BASE + '/#' + route); page.wait_for_timeout(1500); shot(page, 'dark-' + route); checks(page, 'dark ' + route)

    # keyboard: tab through the watch list reaches the first watch link
    page.goto(BASE + '/#watches'); page.wait_for_timeout(1200)
    for i in range(14): page.keyboard.press('Tab')
    focused = page.evaluate("() => document.activeElement && (document.activeElement.textContent || '').trim().slice(0, 40)")
    print('focus after 14 tabs:', focused)

    page.goto(BASE + '/#settings'); page.wait_for_timeout(800); page.click('[data-act=logout]'); page.wait_for_selector('#loginForm')
    shot(page, '16-sign-in'); checks(page, 'sign in')
    ctx2 = b.new_context(viewport={'width': 390, 'height': 844}); p2 = ctx2.new_page(); p2.goto(BASE); p2.wait_for_selector('#loginForm'); p2.screenshot(path=os.path.join(SHOTS, '17-sign-in-phone.png'), full_page=True)

    real = [e for e in errors if 'favicon' not in e and not ('Failed to load resource' in e and ('401' in e or '400' in e))]  # sign-in probe and the deliberate refusals
    for e in real: note('console: ' + e[:300])
    b.close()

print('\n' + ('CLEAN' if not problems else f'{len(problems)} problems'))
sys.exit(1 if problems else 0)
