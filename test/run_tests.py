#!/usr/bin/env python3
"""Unit-test the REAL src/analysis.js in GJS (SpiderMonkey, no DOM needed —
the analysis module is pure). Test PNG built with PIL -> flat RGBA array.
Exits nonzero on failure."""
import json, os, subprocess, sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE)
from PIL import Image

OUTLINE = (26, 28, 44)
FILL    = (210, 60, 46)
FILL_DK = (142, 35, 24)
HILITE  = (242, 118, 90)
ACCENT  = (46, 210, 124)
DB_LT   = (58, 123, 213)
DB_DK   = (42, 90, 168)

W = H = 24
img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
px = img.load()
expected = {}
expected_bbox = {}

def put(x, y, col):
    px[x, y] = col + (255,)
    h = '#%02x%02x%02x' % col
    expected[h] = expected.get(h, 0) + 1
    b = expected_bbox.get(h)
    if b is None:
        expected_bbox[h] = [x, y, x, y]
    else:
        b[0] = min(b[0], x); b[1] = min(b[1], y)
        b[2] = max(b[2], x); b[3] = max(b[3], y)

for y in range(8, 16):
    for x in range(8, 16):
        if x == 8 or x == 15 or y == 8 or y == 15:
            put(x, y, OUTLINE)
        elif (x, y) in ((10, 10), (11, 10)):
            put(x, y, ACCENT)
        elif y - 9 < 3:
            put(x, y, FILL)
        elif y - 9 < 5:
            put(x, y, FILL_DK)
        else:
            put(x, y, HILITE)

for y in range(0, 6):
    for x in range(0, 6):
        if x == 0 or x == 5 or y == 0 or y == 5:
            put(x, y, OUTLINE)
        else:
            put(x, y, DB_LT if (x + y) % 2 == 0 else DB_DK)

flat = list(img.tobytes())

with open(os.path.join(BASE, 'src', 'analysis.js'), encoding='utf-8') as f:
    analysis_js = f.read()

harness = """
var DATA = __DATA__;
var W = __W__, H = __H__;
var EXPECTED = __EXPECTED__;
var EXPECTED_BBOX = __EXPECTED_BBOX__;
var failures = [];
function assert(c, m) { if (!c) failures.push(m); }
function keyHex(k) { var p = k.split(','); return '#' + p.slice(0,3).map(function(n){ return (+n).toString(16).padStart(2,'0'); }).join(''); }

// 1. exact census
var cen = SB_census(DATA, W, H);
var got = {};
cen.forEach(function(e){ got[e.hex] = e.count; });
var keys = Object.keys(EXPECTED);
assert(keys.length === Object.keys(got).length,
  'palette size: expected ' + keys.length + ' got ' + Object.keys(got).length + ' :: ' + JSON.stringify(got));
keys.forEach(function(k){ assert(got[k] === EXPECTED[k], 'count ' + k + ': expected ' + EXPECTED[k] + ' got ' + got[k]); });

// 2. role classification
var cl = SB_classify(DATA, W, H);
function roleOf(hex){ var f = cl.colors.filter(function(c){ return c.hex === hex; }); return f.length ? f[0].role : 'MISSING'; }
assert(roleOf('#1a1c2c') === 'outline',   'outline role, got ' + roleOf('#1a1c2c'));
assert(roleOf('#d23c2e') === 'fill',      'fill role, got ' + roleOf('#d23c2e'));
assert(roleOf('#f2765a') === 'highlight', 'highlight role, got ' + roleOf('#f2765a'));
assert(roleOf('#2ed27c') === 'accent',    'accent role, got ' + roleOf('#2ed27c'));
assert(cl.hasTransparency === true, 'hasTransparency should be true');

// 3. dithering
assert(cl.dither.found === true, 'dither not detected');
if (cl.dither.found) {
  var pair = [keyHex(cl.dither.colorA), keyHex(cl.dither.colorB)].sort().join(',');
  assert(pair === '#2a5aa8,#3a7bd5', 'dither pair wrong: ' + pair);
}

// 4. steps
var steps = SB_buildSteps(cl);
assert(steps.length >= 4, 'expected >=4 steps, got ' + steps.length);
assert(steps[0].title === 'Silhouette', 'first step not Silhouette');
assert(steps[steps.length-1].title === 'Details', 'last step not Details');
steps.forEach(function(s){ assert(s.tip && s.tip.length > 10, 'empty tip on ' + s.title); });
// step visibility must be monotonic from Base fills onward
// (Silhouette intentionally shows everything as one tone, then we narrow to fills)
for (var i = 2; i < steps.length; i++) {
  var prev = steps[i-1].visible, cur = steps[i].visible, ok = true;
  prev.forEach(function(k){ if (!cur.has(k)) ok = false; });
  assert(ok, 'step ' + steps[i].title + ' hides colors from previous step');
}

// 5. degenerate: solid 4x4, no transparency
var d2 = [];
for (var i = 0; i < 16; i++) d2.push(210, 60, 46, 255);
var cl2 = SB_classify(d2, 4, 4);
assert(cl2.hasTransparency === false, 'solid image should report no transparency');
assert(cl2.colors.length === 1 && cl2.colors[0].role === 'fill', 'solid image top color should be fill');

// 6. downscale policy
var ds = SB_downscaleSize(2000, 1000);
assert(ds.w === 1024 && ds.h === 512 && ds.scaled === true, 'downscale wrong: ' + JSON.stringify(ds));
assert(SB_downscaleSize(64, 64).scaled === false, 'small image should not scale');

// 7. gpl export
var gpl = SB_paletteToGpl([{r:26,g:28,b:44,hex:'#1a1c2c',count:5}], 'T');
assert(gpl.indexOf('GIMP Palette') === 0, 'gpl header missing');
assert(gpl.indexOf('26 28 44') > -1, 'gpl color line missing');

// 8. ramps group fills with members
var ramps = SB_ramps(cl);
assert(ramps.length >= 1, 'no ramps built');
assert(ramps.every(function(r){ return r.fill && Array.isArray(r.members); }), 'ramp shape wrong');

// 9. default N=6 output unchanged (exact titles + tips)
var stepsDef = SB_buildSteps(cl);
var steps6 = SB_buildSteps(cl, 6);
var expTitles = ['Silhouette','Base fills','Shading','Highlights','Outline','Details'];
assert(stepsDef.length === 6, 'default should be 6 steps, got ' + stepsDef.length);
assert(stepsDef.map(function(s){return s.title;}).join('|') === expTitles.join('|'),
  'default titles changed: ' + stepsDef.map(function(s){return s.title;}).join('|'));
assert(steps6.map(function(s){return s.title;}).join('|') === expTitles.join('|'), 'explicit N=6 titles changed');
assert(stepsDef.map(function(s){return s.tip;}).join('~') === steps6.map(function(s){return s.tip;}).join('~'),
  'default tips differ from explicit N=6');

// 10. N=2 -> silhouette + full sprite
var steps2 = SB_buildSteps(cl, 2);
assert(steps2.length === 2, 'N=2 should give 2 steps, got ' + steps2.length);
assert(steps2[0].title === 'Silhouette', 'N=2 first step wrong: ' + steps2[0].title);

// 11. N=12 clamps to capacity; final step pixel-identical
var cap = SB_stepCapacity(cl);
assert(cap === 8, 'capacity should be 8 for test sprite, got ' + cap);
var steps12 = SB_buildSteps(cl, 12);
assert(steps12.length === 8, 'N=12 should clamp to 8, got ' + steps12.length);
var fin = steps12[steps12.length - 1];
assert(!fin.tone, 'final step must not be toned');
assert(fin.visible.size === cl.colors.length, 'final step must show all colors');
cl.colors.forEach(function(c){ assert(fin.visible.has(c.key), 'final step missing ' + c.hex); });
// simulate the renderer: every opaque pixel must render its own color
var pxOk = true;
for (var pxi = 0; pxi < W * H; pxi++) {
  var po = pxi * 4;
  if (DATA[po + 3] === 0) continue;
  if (!fin.visible.has(SB_key(DATA[po], DATA[po + 1], DATA[po + 2], DATA[po + 3]))) { pxOk = false; break; }
}
assert(pxOk, 'final step does not cover every opaque pixel');

// 12. every N in 2..capacity: exact count, monotonic visibility, real tips
for (var nn = 2; nn <= cap; nn++) {
  var ss = SB_buildSteps(cl, nn);
  assert(ss.length === nn, 'N=' + nn + ' gave ' + ss.length);
  assert(ss[0].title === 'Silhouette', 'N=' + nn + ' first step wrong');
  ss.forEach(function(s){ assert(s.tip && s.tip.length > 10, 'N=' + nn + ' empty tip on ' + s.title); });
  for (var j = 2; j < ss.length; j++) {
    var okm = true;
    ss[j-1].visible.forEach(function(k){ if (!ss[j].visible.has(k)) okm = false; });
    assert(okm, 'N=' + nn + ' step ' + j + ' hides colors from previous step');
  }
  var fl = ss[ss.length - 1];
  assert(!fl.tone && fl.visible.size === cl.colors.length, 'N=' + nn + ' final step not pixel-identical');
}

// 13. degenerate no-transparency image keeps working at N=2 and default
var stepsD = SB_buildSteps(cl2);
assert(stepsD.length >= 2, 'degenerate default should give >=2 steps');
var stepsD2 = SB_buildSteps(cl2, 2);
assert(stepsD2.length === 2, 'degenerate N=2 should give 2 steps, got ' + stepsD2.length);
assert(stepsD2[0].title === 'Silhouette', 'degenerate N=2 first step');
assert(stepsD2[1].visible.size === cl2.colors.length, 'degenerate final step must cover all colors');

// 14. per-step pixel stats: counts + bounding boxes vs Python ground truth
function unionOf(hexes) {
  var b = null;
  hexes.forEach(function (h) {
    var e = EXPECTED_BBOX[h];
    if (!b) b = { x0: e[0], y0: e[1], x1: e[2], y1: e[3] };
    else { b.x0 = Math.min(b.x0, e[0]); b.y0 = Math.min(b.y0, e[1]); b.x1 = Math.max(b.x1, e[2]); b.y1 = Math.max(b.y1, e[3]); }
  });
  return b;
}
var allHexes = Object.keys(EXPECTED_BBOX);
var fullBox = unionOf(allHexes);
var totalExp = allHexes.reduce(function (s, h) { return s + EXPECTED[h]; }, 0);
stepsDef.forEach(function (s) {
  if (s.tone) {
    assert(s.addedCount === totalExp, 'silhouette addedCount: expected ' + totalExp + ' got ' + s.addedCount);
    assert(s.bbox && s.bbox.x0 === fullBox.x0 && s.bbox.y0 === fullBox.y0 &&
           s.bbox.x1 === fullBox.x1 && s.bbox.y1 === fullBox.y1,
           'silhouette bbox wrong: ' + JSON.stringify(s.bbox));
  } else if (s.added.length) {
    var hexes = s.added.map(function (c) { return c.hex; });
    var expCount = hexes.reduce(function (st, h) { return st + EXPECTED[h]; }, 0);
    assert(s.addedCount === expCount, 'step ' + s.title + ' addedCount: expected ' + expCount + ' got ' + s.addedCount);
    var eb = unionOf(hexes);
    assert(s.bbox && s.bbox.x0 === eb.x0 && s.bbox.y0 === eb.y0 &&
           s.bbox.x1 === eb.x1 && s.bbox.y1 === eb.y1,
           'step ' + s.title + ' bbox wrong: ' + JSON.stringify(s.bbox) + ' expected ' + JSON.stringify(eb));
    assert(s.addedKeys instanceof Set, 'step ' + s.title + ' missing addedKeys Set');
    assert(s.addedKeys.size === s.added.length, 'step ' + s.title + ' addedKeys size wrong');
  } else {
    assert(s.addedCount === 0 && s.bbox === null, 'empty step should have 0 count and null bbox');
  }
});

// 15. keyToStep: every color key maps to exactly one step; silhouette owns none
var k2s = stepsDef.keyToStep;
assert(k2s instanceof Map, 'steps.keyToStep missing');
var mappedKeys = [];
k2s.forEach(function (si, k) { mappedKeys.push(k); });
assert(mappedKeys.length === cl.colors.length,
  'keyToStep should cover all ' + cl.colors.length + ' colors, got ' + mappedKeys.length);
var silKeys = mappedKeys.filter(function (k) { return k2s.get(k) === 0; });
assert(silKeys.length === 0, 'silhouette step must own no color keys');
// every mapped step index is valid and non-silhouette
mappedKeys.forEach(function (k) {
  var si = k2s.get(k);
  assert(si > 0 && si < stepsDef.length, 'keyToStep maps to invalid step ' + si);
  assert(!stepsDef[si].tone, 'keyToStep maps a key to the silhouette step');
});

// 16. isolate simulation: a step's added pixels are exactly its addedKeys pixels
stepsDef.forEach(function (s, si) {
  if (s.tone || !s.added.length) return;
  var n = 0, bad = 0;
  for (var pxi = 0; pxi < W * H; pxi++) {
    var po = pxi * 4;
    if (DATA[po + 3] === 0) continue;
    var kk = SB_key(DATA[po], DATA[po + 1], DATA[po + 2], DATA[po + 3]);
    if (s.addedKeys.has(kk)) { n++; if (k2s.get(kk) !== si) bad++; }
  }
  assert(n === s.addedCount, 'isolate pixel count for ' + s.title + ': expected ' + s.addedCount + ' got ' + n);
  assert(bad === 0, 'isolate pixel/step mismatch in ' + s.title);
});

// 17. debug palette: 24 distinct colors; distinct per step for every N in 2..24
var pal = SB_debugPalette();
assert(pal.length >= 24, 'debug palette too short: ' + pal.length);
var palSet = {};
pal.forEach(function (h) { palSet[h] = true; });
assert(Object.keys(palSet).length === pal.length, 'debug palette has duplicates');
assert(pal.every(function (h) { return /^#[0-9a-f]{6}$/.test(h); }), 'debug palette has bad hex');
for (var nn2 = 2; nn2 <= 24; nn2++) {
  var ssn = SB_buildSteps(cl, nn2);
  var used = {};
  ssn.forEach(function (s, si) {
    if (s.tone || !s.added.length) return;
    var dc = pal[si % pal.length];
    assert(!used[dc], 'N=' + nn2 + ' debug color reused: ' + dc);
    used[dc] = true;
  });
}

// 18. template composite: every opaque pixel maps to exactly one color-adding step
var cov = 0, unmapped = 0, silMapped = 0;
for (var qxi = 0; qxi < W * H; qxi++) {
  var qo = qxi * 4;
  if (DATA[qo + 3] === 0) continue;
  cov++;
  var qk = SB_key(DATA[qo], DATA[qo + 1], DATA[qo + 2], DATA[qo + 3]);
  var qs = k2s.get(qk);
  if (qs === undefined) unmapped++;
  else if (stepsDef[qs].tone) silMapped++;
}
assert(cov === totalExp, 'opaque pixel coverage: expected ' + totalExp + ' got ' + cov);
assert(unmapped === 0, unmapped + ' opaque pixels unmapped in template composite');
assert(silMapped === 0, silMapped + ' pixels mapped to silhouette step');

// 19. source-space coordinates: every step bbox inside the source grid
//     (test sprite is 24x24, not downscaled, so analysis space == source space)
stepsDef.forEach(function (s) {
  if (!s.bbox) return;
  var bb = s.bbox;
  assert(bb.x0 >= 0 && bb.y0 >= 0 && bb.x1 < W && bb.y1 < H,
    'step ' + s.title + ' bbox outside source dims: ' + JSON.stringify(bb));
  assert(bb.x0 <= bb.x1 && bb.y0 <= bb.y1, 'step ' + s.title + ' bbox inverted');
});
// 19b. SB_toSourceBox: identity when analysis dims == source dims
var ib = SB_toSourceBox({ x0: 8, y0: 8, x1: 15, y1: 15 }, 24, 24, 24, 24);
assert(ib && ib.x0 === 8 && ib.y0 === 8 && ib.x1 === 15 && ib.y1 === 15,
  'toSourceBox identity failed: ' + JSON.stringify(ib));
// 19c. downscale mapping: source 2048x1024 -> analysis 1024x512 (k=0.5)
// analysis pixel x covers source [x/0.5, (x+1)/0.5): (10,20)-(30,40) -> (20,40)-(61,81)
var db = SB_toSourceBox({ x0: 10, y0: 20, x1: 30, y1: 40 }, 2048, 1024, 1024, 512);
assert(db && db.x0 === 20 && db.y0 === 40 && db.x1 === 61 && db.y1 === 81,
  'toSourceBox downscale failed: ' + JSON.stringify(db));
// 19d. clamping at the source edges: full analysis frame -> full source frame
var cb = SB_toSourceBox({ x0: 0, y0: 0, x1: 1023, y1: 511 }, 2048, 1024, 1024, 512);
assert(cb && cb.x0 === 0 && cb.y0 === 0 && cb.x1 === 2047 && cb.y1 === 1023,
  'toSourceBox clamp failed: ' + JSON.stringify(cb));
// 19e. null and degenerate inputs
assert(SB_toSourceBox(null, 24, 24, 24, 24) === null, 'toSourceBox(null) should be null');
assert(SB_toSourceBox({ x0: 0, y0: 0, x1: 1, y1: 1 }, 0, 24, 24, 24) === null,
  'toSourceBox with zero source width should be null');

print('TEST_RESULT:' + JSON.stringify({ pass: failures.length === 0, failures: failures }));
""".replace('__DATA__', json.dumps(flat)).replace('__W__', str(W)).replace('__H__', str(H)).replace('__EXPECTED__', json.dumps(expected)).replace('__EXPECTED_BBOX__', json.dumps(expected_bbox))

tjs = os.path.join(BASE, 'test', 'test_analysis.js')
with open(tjs, 'w', encoding='utf-8') as f:
    f.write(analysis_js + '\n' + harness)

print('expected palette:', json.dumps(expected))
p = subprocess.run(['gjs', tjs], capture_output=True, text=True, timeout=120)
out = (p.stdout or '') + (p.stderr or '')
i = out.find('TEST_RESULT:')
if i == -1:
    print('NO TEST RESULT!')
    print(out[-3000:])
    sys.exit(2)
res = json.loads(out[i + len('TEST_RESULT:'):].strip().split('\n')[0])
print('PASS' if res['pass'] else 'FAIL')
for f in res['failures']:
    print(' -', f)

# ---- static layout checks: internal scroll container (mvp-5) ----
import re
# The tool must scroll INTERNALLY (full-viewport #scroller) so it works
# inside fixed-height iframes on mobile (itch embed), where document
# scrolling fails. Assert the structure in src + the built file.
static_failures = []
def scheck(cond, msg):
    if not cond:
        static_failures.append(msg)

tpl = open(os.path.join(BASE, 'src', 'template.html'), encoding='utf-8').read()
css = open(os.path.join(BASE, 'src', 'style.css'), encoding='utf-8').read()
appjs = open(os.path.join(BASE, 'src', 'app.js'), encoding='utf-8').read()
built_path = os.path.join(BASE, 'dist', 'index.html')
built = ''
if os.path.exists(built_path):
    built = open(built_path, encoding='utf-8').read()

scheck('id="scroller"' in tpl, 'template missing #scroller container')
scheck('id="scroller"' in built, 'built index.html missing #scroller container')
i_scr = tpl.find('id="scroller"')
i_up = tpl.find('id="uploadView"')
i_res = tpl.find('id="resultView"')
scheck(-1 < i_scr < i_up < i_res, '#scroller must open before both views')
i_script = tpl.find('<script>')
body_before_scripts = tpl[:i_script].rstrip() if i_script > -1 else ''
scheck(re.search(r'</div>\s*</div>$', body_before_scripts) is not None,
       '#scroller/.wrap not closed after both views (expected two closing </div> before scripts)')
scheck('#scroller' in css and 'overflow-y: auto' in css,
       'style.css missing #scroller overflow-y: auto')
scheck('-webkit-overflow-scrolling: touch' in css,
       'style.css missing -webkit-overflow-scrolling: touch')
scheck('height: 100%' in css, 'style.css missing full-viewport height')
scheck('overflow-y: auto' in built, 'built index.html missing internal-scroll CSS')
scheck('window.scrollTo' not in appjs, 'app.js still calls window.scrollTo')
scheck('window.scrollTo' not in built, 'built index.html still calls window.scrollTo')
scheck('resetScroll();' in appjs, 'app.js missing resetScroll() calls')
scheck("version: 'mvp-5'" in appjs, 'app.js version marker is not mvp-5')
scheck('mvp-5' in built, 'built index.html missing mvp-5 marker')

print('STATIC_LAYOUT:' + ('PASS' if not static_failures else 'FAIL'))
for f in static_failures:
    print(' -', f)
sys.exit(0 if (res['pass'] and not static_failures) else 1)
