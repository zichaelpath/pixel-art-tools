/* UI smoke test: fake DOM + fake canvas, exercises isolate/template/measure/legend. */
var failures = [];
function assert(c, m) { if (!c) failures.push(m); }

var lastImg = null;
function makeCtx() {
  return {
    imageSmoothingEnabled: false,
    createImageData: function (w, h) { return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }; },
    putImageData: function (img) { lastImg = img; },
    drawImage: function () {},
    getImageData: function () { return { data: new Uint8ClampedArray(4) }; }
  };
}
var canvasEls = [];
function makeEl(id) {
  var el = {
    _id: id, _handlers: {}, children: [],
    innerHTML: '', textContent: '', disabled: false, checked: false,
    style: {}, clientWidth: 320, width: 16, height: 16, value: '',
    classList: { add: function () {}, remove: function () {} },
    setAttribute: function () {},
    appendChild: function (c) { el.children.push(c); return c; },
    addEventListener: function (ev, fn) { el._handlers[ev] = fn; },
    getContext: function () { return makeCtx(); },
    click: function () {}, select: function () {}, scrollTo: function () {}
  };
  return el;
}
var els = {};
function $(id) {
  if (!els[id]) els[id] = makeEl(id);
  return els[id];
}
var document = {
  getElementById: $, readyState: 'complete',
  createElement: function (tag) {
    var el = makeEl(tag);
    if (tag === 'canvas') canvasEls.push(el);
    return el;
  },
  addEventListener: function () {}, body: makeEl('body'), title: ''
};
var window = { addEventListener: function () {}, scrollTo: function () {} };
var navigator = {};
function setTimeout(fn) { return 0; }
function clearTimeout() {}

/* ---- load the real app (analysis.js + app.js inlined by build order) ---- */
/* ============================================================
 * Sprite Breakdown — pure analysis module (no DOM, no canvas).
 * All functions operate on a flat RGBA pixel array:
 *   data   : array-like of numbers, length = width*height*4
 *   width  : image width in pixels
 *   height : image height in pixels
 * Works with Uint8ClampedArray (from canvas) or plain Arrays.
 * ============================================================ */

function SB_hex(r, g, b) {
  const h = (n) => n.toString(16).padStart(2, '0');
  return '#' + h(r) + h(g) + h(b);
}

function SB_key(r, g, b, a) { return r + ',' + g + ',' + b + ',' + a; }

function SB_rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  let h = 0, s = 0;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h: h, s: s, l: l };
}

function SB_relLum(r, g, b) {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function SB_hueDist(h1, h2) {
  const d = Math.abs(h1 - h2) % 360;
  return d > 180 ? 360 - d : d;
}

function SB_hueName(h, s, l) {
  if (s < 0.15) {
    if (l < 0.12) return 'near-black';
    if (l > 0.85) return 'near-white';
    return 'gray';
  }
  if (h < 15 || h >= 345) return 'red';
  if (h < 45) return 'orange';
  if (h < 75) return 'yellow';
  if (h < 165) return 'green';
  if (h < 195) return 'cyan';
  if (h < 255) return 'blue';
  return 'purple';
}

function SB_describe(c) {
  const tone = c.lum < 0.06 ? 'near-black' : c.lum < 0.22 ? 'dark' : c.lum > 0.75 ? 'light' : 'mid-tone';
  const hue = SB_hueName(c.h, c.s, c.l);
  if (hue === 'near-black' || hue === 'near-white' || hue === 'gray') return hue;
  return tone + ' ' + hue;
}

/* Exact RGBA census of opaque pixels (alpha === 0 skipped).
 * Returns array of {r,g,b,a,key,hex,count} sorted by count desc. */
function SB_census(data, width, height) {
  const map = new Map();
  const n = width * height;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const a = data[o + 3];
    if (a === 0) continue;
    const r = data[o], g = data[o + 1], b = data[o + 2];
    const k = SB_key(r, g, b, a);
    const x = i % width, y = (i / width) | 0;
    let e = map.get(k);
    if (!e) {
      e = { r: r, g: g, b: b, a: a, key: k, hex: SB_hex(r, g, b), count: 0,
            x0: x, y0: y, x1: x, y1: y };
      map.set(k, e);
    }
    e.count++;
    if (x < e.x0) e.x0 = x; if (x > e.x1) e.x1 = x;
    if (y < e.y0) e.y0 = y; if (y > e.y1) e.y1 = y;
  }
  const out = Array.from(map.values());
  out.sort((x, y) => y.count - x.count);
  return out;
}

/* For each color key, fraction of its pixels touching transparency
 * (8-neighborhood) or the image edge. */
function SB_boundaryFractions(data, width, height, keys) {
  const idx = new Map();
  keys.forEach((k, i) => idx.set(k, i));
  const touch = new Array(keys.length).fill(0);
  const total = new Array(keys.length).fill(0);
  const keyAt = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return null;
    const o = (y * width + x) * 4;
    if (data[o + 3] === 0) return null;
    return SB_key(data[o], data[o + 1], data[o + 2], data[o + 3]);
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (data[o + 3] === 0) continue;
      const ci = idx.get(SB_key(data[o], data[o + 1], data[o + 2], data[o + 3]));
      total[ci]++;
      let b = false;
      for (let dy = -1; dy <= 1 && !b; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (keyAt(x + dx, y + dy) === null) { b = true; break; }
        }
      }
      if (b) touch[ci]++;
    }
  }
  const out = new Map();
  keys.forEach((k, i) => out.set(k, total[i] ? touch[i] / total[i] : 0));
  return out;
}

/* Detect 2x2 checkerboard dithering between two colors. */
function SB_detectDither(data, width, height) {
  const keyAt = (x, y) => {
    const o = (y * width + x) * 4;
    if (data[o + 3] === 0) return null;
    return SB_key(data[o], data[o + 1], data[o + 2], data[o + 3]);
  };
  const pairs = new Map();
  let blocks = 0;
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const a = keyAt(x, y), b = keyAt(x + 1, y), c = keyAt(x, y + 1), d = keyAt(x + 1, y + 1);
      if (a === null || b === null || c === null || d === null) continue;
      if (a === d && b === c && a !== b) {
        const p = a < b ? a + '|' + b : b + '|' + a;
        pairs.set(p, (pairs.get(p) || 0) + 1);
        blocks++;
      }
    }
  }
  if (blocks < 4) return { found: false, blocks: 0 };
  let top = null, tc = 0;
  pairs.forEach((cnt, p) => { if (cnt > tc) { tc = cnt; top = p; } });
  const parts = top.split('|');
  return { found: true, colorA: parts[0], colorB: parts[1], blocks: blocks };
}

/* Classify every color into a role. Heuristics, applied in order:
 *  - outline : >=50% of pixels touch transparency/edge
 *  - fill    : up to 3 highest-count interior (<35% boundary) colors
 *  - shade/highlight/tone : within 40deg hue of a fill and darker/lighter/similar
 *  - accent  : everything else (small detail colors) */
function SB_classify(data, width, height) {
  const census = SB_census(data, width, height);
  const keys = census.map((c) => c.key);
  const bf = SB_boundaryFractions(data, width, height, keys);
  const cols = census.map((c) => {
    const hsl = SB_rgbToHsl(c.r, c.g, c.b);
    return {
      r: c.r, g: c.g, b: c.b, a: c.a, key: c.key, hex: c.hex, count: c.count,
      x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1,
      h: hsl.h, s: hsl.s, l: hsl.l, lum: SB_relLum(c.r, c.g, c.b),
      boundary: bf.get(c.key), role: 'unassigned', rampOf: null
    };
  });

  const remaining = [];
  for (const c of cols) {
    if (c.boundary >= 0.5) c.role = 'outline';
    else remaining.push(c);
  }

  const interior = remaining.filter((c) => c.boundary < 0.35).sort((a, b) => b.count - a.count);
  let fills = interior.slice(0, 3);
  if (fills.length === 0 && cols.length > 0) {
    // Degenerate case (e.g. no transparency at all): the dominant color is the fill.
    cols[0].role = 'fill';
    fills = [cols[0]];
  }
  const fillSet = new Set(fills.map((f) => f.key));
  fills.forEach((c) => { c.role = 'fill'; });

  for (const c of remaining) {
    if (fillSet.has(c.key)) continue;
    let best = null, bd = 1e9;
    for (const f of fills) {
      const d = SB_hueDist(c.h, f.h);
      if (d < bd) { bd = d; best = f; }
    }
    if (best && bd <= 40 && c.s > 0.12 && best.s > 0.12) {
      c.rampOf = best.key;
      if (c.lum < best.lum - 0.04) c.role = 'shade';
      else if (c.lum > best.lum + 0.04) c.role = 'highlight';
      else c.role = 'tone';
    } else {
      c.role = 'accent';
    }
  }

  const dither = SB_detectDither(data, width, height);
  const hasTransparency = (() => {
    const n = width * height;
    for (let i = 0; i < n; i++) if (data[i * 4 + 3] === 0) return true;
    return false;
  })();
  return {
    colors: cols,
    width: width, height: height,
    totalOpaque: cols.reduce((s, c) => s + c.count, 0),
    dither: dither,
    hasTransparency: hasTransparency
  };
}

/* Group fills with their shade/highlight/tone ramp members. */
function SB_ramps(classified) {
  return classified.colors
    .filter((c) => c.role === 'fill')
    .map((f) => ({
      fill: f,
      members: classified.colors
        .filter((c) => c.rampOf === f.key)
        .sort((a, b) => b.lum - a.lum)
    }));
}

/* ---- Guide phases: ordered, fine-grained color atoms ----
 * A phase is one pedagogical layer (fills, shading, ...). Each phase holds
 * an ordered list of atoms; an atom is one drawable chunk of colors.
 * The silhouette atom is special: it renders every opaque pixel as one tone. */
function SB_guidePhases(cl) {
  const byRole = (r) => cl.colors.filter((c) => c.role === r);
  const outlines = byRole('outline');
  const fills = byRole('fill');
  const shades = byRole('shade').concat(byRole('tone'));
  const highs = byRole('highlight');
  const accents = byRole('accent');

  const hexList = (arr) => arr.map((c) => c.hex).join(', ');
  const pct = (arr) => cl.totalOpaque ? Math.round(100 * arr.reduce((s, c) => s + c.count, 0) / cl.totalOpaque) : 0;

  let outlineTip;
  if (outlines.length) {
    const o = outlines[0];
    outlineTip = 'Outline: ' + o.hex + ' — a ' + SB_describe(o) +
      (o.hex.toLowerCase() === '#000000' ? ', pure black.' : ', not pure black.') +
      ' Trace the silhouette with it before filling anything in.';
  } else if (!cl.hasTransparency) {
    outlineTip = 'No transparency in this image, so no outline could be detected. ' +
      'Upload a sprite with a transparent background for outline detection.';
  } else {
    outlineTip = 'No outline detected — shapes end at the fills. That is a softer, outline-less style; keep edges clean instead.';
  }

  const ditherTip = cl.dither.found
    ? ' Checkerboard dithering spotted between two tones (' + cl.dither.blocks + ' blocks) — a classic way to blend without adding colors.'
    : '';

  const atom = (c) => ({ colors: [c] });
  return [
    {
      title: 'Silhouette', silhouette: true,
      atoms: [{ colors: [], silhouette: true }],
      tip: () => 'Block in the whole shape first: ' + cl.totalOpaque + ' opaque pixels at ' +
        cl.width + 'x' + cl.height + '. If it reads well as a blob, the sprite will work.' +
        (cl.colors.length <= 16 ? ' Tight ' + cl.colors.length + '-color palette — beginner-friendly.' : ' ' + cl.colors.length + ' colors total.')
    },
    {
      title: 'Base fills',
      atoms: fills.map(atom),
      tip: () => fills.length
        ? 'Lay in the ' + fills.length + ' main fill' + (fills.length > 1 ? 's' : '') + ': ' + hexList(fills) +
          '. They cover ' + pct(fills) + '% of the sprite — get these flat shapes right before shading.'
        : 'No clear fill colors found — start with the single biggest color region.'
    },
    {
      title: 'Shading',
      atoms: shades.map(atom),
      tip: () => shades.length
        ? shades.length + ' shade color' + (shades.length > 1 ? 's' : '') + ' darken the fills: ' + hexList(shades) +
          '. Pick one light direction and keep every shadow on the same side.' + ditherTip
        : 'No separate shade colors detected — this sprite is flat-shaded. Add one darker tone per fill on a consistent side.' + ditherTip
    },
    {
      title: 'Highlights',
      atoms: highs.map(atom),
      tip: () => highs.length
        ? highs.length + ' highlight' + (highs.length > 1 ? 's' : '') + ': ' + hexList(highs) +
          '. Less is more — highlights sit opposite the shadows, on edges facing the light.'
        : 'No highlight colors detected. One lighter tone per fill, used sparingly, adds a lot of pop.'
    },
    {
      title: 'Outline',
      atoms: outlines.length ? [{ colors: outlines }] : [],
      tip: () => outlineTip
    },
    {
      title: 'Details',
      atoms: accents.map(atom),
      tip: () => accents.length
        ? 'Finish with ' + accents.length + ' accent' + (accents.length > 1 ? 's' : '') + ' for the small stuff: ' + hexList(accents) + '.'
        : 'No tiny accent colors — all the detail lives in the shapes themselves.'
    }
  ];
}

/* Kept phases: first and last always, middle phases only when they have atoms. */
function SB_keptPhases(cl) {
  const phases = SB_guidePhases(cl);
  return phases.filter((p, i) => i === 0 || i === phases.length - 1 || p.atoms.length > 0);
}

/* Maximum sensible step count: one step per drawable atom. */
function SB_stepCapacity(cl) {
  return SB_keptPhases(cl).reduce((s, p) => s + p.atoms.length, 0);
}

/* Split `items` into `k` contiguous buckets, as evenly as possible. */
function SB_evenBuckets(items, k) {
  if (k <= 0) return [];
  if (k >= items.length) return items.map((x) => [x]);
  const out = [];
  const base = Math.floor(items.length / k);
  let rem = items.length % k;
  let i = 0;
  for (let g = 0; g < k; g++) {
    const size = base + (rem > 0 ? 1 : 0);
    if (rem > 0) rem--;
    out.push(items.slice(i, i + size));
    i += size;
  }
  return out;
}

/* Tip for a step that covers part of one phase (the phase was split). */
function SB_partTip(cl, colors) {
  const pct1 = (c) => cl.totalOpaque ? Math.round(100 * c.count / cl.totalOpaque) : 0;
  return 'Add ' + colors.map((c) => c.hex + ' (' + c.role + ', ' + pct1(c) + '% of the sprite)').join(' and ') + '.';
}

/* Tip for a step that merges several whole phases. */
function SB_mergedTip(cl, phases) {
  const colors = [];
  phases.forEach((p) => p.atoms.forEach((a) => a.colors.forEach((c) => colors.push(c))));
  if (!colors.length) return 'Nothing new to draw in this step.';
  const shown = colors.slice(0, 10).map((c) => c.hex).join(', ');
  const pct = cl.totalOpaque
    ? Math.round(100 * colors.reduce((s, c) => s + c.count, 0) / cl.totalOpaque) : 0;
  return 'In one go: ' + colors.length + ' color' + (colors.length === 1 ? '' : 's') +
    ' (' + shown + (colors.length > 10 ? ', …' : '') + '), covering ' + pct + '% of the sprite.';
}

/* Build the step-by-step guide.
 * Each step: { title, visible:Set(keys), added:[colors], tip, tone? }
 * - `stepCount` defaults to 6 and is clamped to 2..24.
 * - Asking for more steps than there are drawable atoms clamps down to the
 *   number of atoms (see SB_stepCapacity).
 * - Steps that would add nothing are dropped (first and last always kept).
 * - The final step always renders the complete sprite pixel-for-pixel. */
function SB_buildSteps(cl, stepCount) {
  let n = Math.round(stepCount == null ? 6 : stepCount);
  if (!(n >= 2)) n = 6;
  n = Math.max(2, Math.min(24, n));

  const kept = SB_keptPhases(cl);
  const P = kept.length;
  const capacity = kept.reduce((s, p) => s + p.atoms.length, 0);
  let target = Math.min(n, capacity);
  if (target < 1) target = 1;

  // desc: one entry per step -> { segs:[{phase, atoms}], title, tip, silhouette }
  const desc = [];
  const pushStep = (segs, title, tip, silhouette) =>
    desc.push({ segs: segs, title: title, tip: tip, silhouette: !!silhouette });

  if (target >= P) {
    // Split mode: one step per phase; extra steps subdivide atom-rich phases.
    const alloc = kept.map(() => 1);
    let extra = target - P;
    while (extra > 0) {
      let best = -1, bestRatio = 0;
      kept.forEach((p, i) => {
        if (alloc[i] < p.atoms.length) {
          const ratio = p.atoms.length / alloc[i];
          if (ratio > bestRatio) { bestRatio = ratio; best = i; }
        }
      });
      if (best < 0) break;
      alloc[best]++;
      extra--;
    }
    kept.forEach((p, i) => {
      if (!p.atoms.length) {
        pushStep([{ phase: p, atoms: [] }], p.title, p.tip(), p.silhouette);
        return;
      }
      SB_evenBuckets(p.atoms, alloc[i]).forEach((bucket, j) => {
        const colors = [];
        bucket.forEach((a) => a.colors.forEach((c) => colors.push(c)));
        const title = alloc[i] > 1 ? p.title + ' (' + (j + 1) + ' of ' + alloc[i] + ')' : p.title;
        const tip = alloc[i] > 1 ? SB_partTip(cl, colors) : p.tip();
        pushStep([{ phase: p, atoms: bucket }], title, tip, p.silhouette);
      });
    });
  } else {
    // Merge mode: group kept phases into `target` contiguous groups.
    // Step 1 is always the silhouette alone (when there is more than one step).
    let groups;
    if (target >= 2) {
      groups = [[kept[0]]];
      const rest = [];
      for (let i = 1; i < P; i++) rest.push(i);
      SB_evenBuckets(rest, target - 1).forEach((b) => groups.push(b.map((j) => kept[j])));
    } else {
      groups = [kept.slice()];
    }
    groups.forEach((phases) => {
      const segs = phases.map((p) => ({ phase: p, atoms: p.atoms }));
      const hasLast = phases[phases.length - 1] === kept[kept.length - 1];
      const title = phases.length === 1
        ? phases[0].title
        : (hasLast ? 'Full sprite' : phases.map((p) => p.title).join(' + '));
      const tip = phases.length === 1 ? phases[0].tip() : SB_mergedTip(cl, phases);
      pushStep(segs, title, tip, phases.length === 1 && phases[0].silhouette);
    });
  }

  // Drop steps that add nothing new; always keep first and last.
  const useful = desc.filter((d, i) =>
    i === 0 || i === desc.length - 1 ||
    d.segs.some((s) => s.atoms.some((a) => a.colors.length > 0)));

  const allKeys = new Set(cl.colors.map((c) => c.key));
  const steps = useful.map((d) => {
    const colors = [];
    d.segs.forEach((s) => s.atoms.forEach((a) => a.colors.forEach((c) => colors.push(c))));
    return {
      title: d.title,
      tip: d.tip,
      tone: d.silhouette ? '#262a44' : null,
      added: d.silhouette ? [] : colors,
      _colors: colors,
      _sil: d.silhouette
    };
  });
  // Visibility is cumulative: nothing drawn is ever hidden again.
  // (The silhouette step intentionally shows everything as one tone first.)
  const cum = new Set();
  steps.forEach((s) => {
    if (s._sil) { s.visible = new Set(allKeys); }
    else { s._colors.forEach((c) => cum.add(c.key)); s.visible = new Set(cum); }
    delete s._colors;
    delete s._sil;
  });
  // Per-step pixel stats + color->step map (powers isolate + template views).
  // Every color key lands in exactly one step's `added` set (silhouette adds none).
  const keyToStep = new Map();
  const ub = { x0: Infinity, y0: Infinity, x1: -1, y1: -1 };
  cl.colors.forEach((c) => {
    if (c.x0 < ub.x0) ub.x0 = c.x0; if (c.x1 > ub.x1) ub.x1 = c.x1;
    if (c.y0 < ub.y0) ub.y0 = c.y0; if (c.y1 > ub.y1) ub.y1 = c.y1;
  });
  const unionBox = ub.x1 >= 0 ? { x0: ub.x0, y0: ub.y0, x1: ub.x1, y1: ub.y1 } : null;
  steps.forEach((s, si) => {
    s.addedKeys = new Set(s.added.map((c) => c.key));
    s.added.forEach((c) => keyToStep.set(c.key, si));
    if (s.tone) {
      s.addedCount = cl.totalOpaque;
      s.bbox = unionBox;
    } else if (s.added.length) {
      s.addedCount = s.added.reduce((n, c) => n + c.count, 0);
      const b = { x0: Infinity, y0: Infinity, x1: -1, y1: -1 };
      s.added.forEach((c) => {
        if (c.x0 < b.x0) b.x0 = c.x0; if (c.x1 > b.x1) b.x1 = c.x1;
        if (c.y0 < b.y0) b.y0 = c.y0; if (c.y1 > b.y1) b.y1 = c.y1;
      });
      s.bbox = { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 };
    } else {
      s.addedCount = 0;
      s.bbox = null;
    }
  });
  steps.keyToStep = keyToStep;
  steps.forEach((s, i) => { s.num = i + 1; s.total = steps.length; });
  return steps;
}

/* GIMP (.gpl) palette — opens in Aseprite / LibreSprite. */
function SB_paletteToGpl(colors, name) {
  let s = 'GIMP Palette\nName: ' + (name || 'Sprite Breakdown') + '\nColumns: 8\n#\n';
  const sorted = colors.slice().sort((a, b) => b.count - a.count);
  for (const c of sorted) s += c.r + ' ' + c.g + ' ' + c.b + '\t' + c.hex + '\n';
  return s;
}

/* Downscale policy: longest side capped at 1024 for analysis. */
function SB_needsDownscale(w, h) { return Math.max(w, h) > 1024; }
function SB_downscaleSize(w, h) {
  const m = Math.max(w, h);
  if (m <= 1024) return { w: w, h: h, scaled: false };
  const k = 1024 / m;
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)), scaled: true };
}

/* Map an analysis-space bbox back to source-sprite pixel coordinates.
   Analysis may run on a downscaled image (see SB_downscaleSize); the user
   requires every displayed number in ORIGINAL sprite pixels, so bboxes are
   mapped back and clamped to [0, srcW-1] x [0, srcH-1]. */
function SB_toSourceBox(b, srcW, srcH, anaW, anaH) {
  if (!b) return null;
  if (!(srcW > 0) || !(srcH > 0) || !(anaW > 0) || !(anaH > 0)) return null;
  var kx = anaW / srcW, ky = anaH / srcH;
  var x0 = Math.max(0, Math.floor(b.x0 / kx));
  var y0 = Math.max(0, Math.floor(b.y0 / ky));
  var x1 = Math.min(srcW - 1, Math.ceil((b.x1 + 1) / kx) - 1);
  var y1 = Math.min(srcH - 1, Math.ceil((b.y1 + 1) / ky) - 1);
  if (x1 < x0 || y1 < y0) return null;
  return { x0: x0, y0: y0, x1: x1, y1: y1 };
}

/* HSL -> hex (0<=h<360, 0<=s,l<=1). */
function SB_hslToHex(h, s, l) {
  h = (((h % 360) + 360) % 360) / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return SB_hex(Math.round(f(h + 1 / 3) * 255), Math.round(f(h) * 255), Math.round(f(h - 1 / 3) * 255));
}

/* Fixed high-contrast debug palette for template mode.
 * Golden-angle hues at full saturation: consecutive entries are maximally
 * separated, so any step count 2..24 gets mutually distinct colors.
 * Never derived from the sprite's own colors. */
function SB_debugPalette() {
  const out = [];
  for (let i = 0; i < 24; i++) out.push(SB_hslToHex((i * 137.508) % 360, 1, 0.55));
  return out;
}

/* Sprite Breakdown — app shell (DOM). Pure analysis lives in analysis.js. */
(function () {
  'use strict';

  var state = { cl: null, steps: [], stepIdx: 0, zoom: 1, w: 0, h: 0, px: null, scaledNote: false, stepN: 6, isolate: false, template: false };

  function $(id) { return document.getElementById(id); }

  function resetScroll() {
    var s = $('scroller');
    if (s) s.scrollTop = 0;
  }

  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(t._h);
    t._h = setTimeout(function () { t.classList.add('hidden'); }, 1600);
  }

  function copyText(text, label) {
    function done() { toast((label || 'Copied') + ': ' + text); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallback(); });
    } else { fallback(); }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); }
      catch (e) { toast('Copy failed — long-press the text'); }
      document.body.removeChild(ta);
    }
  }

  function hexRgb(hex) {
    return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  }

  function fmt(n) { return Number(n).toLocaleString('en-US'); }

  function download(name, text, mime) {
    var blob = new Blob([text], { type: mime || 'text/plain' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  /* ---- core pipeline: flat RGBA array -> full UI ---- */
  function loadPixels(data, w, h, scaledNote, srcW, srcH) {
    state.px = data; state.w = w; state.h = h;
    state.srcW = srcW || w; state.srcH = srcH || h;
    state.scaledNote = !!scaledNote;
    state.cl = SB_classify(data, w, h);
    state.stepN = 6;
    state.steps = SB_buildSteps(state.cl, state.stepN);
    state.stepIdx = 0;
    state.zoom = 1;
    state.isolate = false;
    state.template = false;
    $('isolateTgl').checked = false;
    $('templateTgl').checked = false;
    $('tplLegend').classList.add('hidden');
    $('uploadView').classList.add('hidden');
    $('resultView').classList.remove('hidden');
    renderPalette();
    renderStepCount();
    renderStep();
    if (state.scaledNote) {
      $('scaleWarn').classList.remove('hidden');
    } else {
      $('scaleWarn').classList.add('hidden');
    }
    if (!state.cl.hasTransparency) $('noAlphaWarn').classList.remove('hidden');
    else $('noAlphaWarn').classList.add('hidden');
    document.title = 'READY';
  }

  function fitScale() {
    var wrapW = $('stage').clientWidth || 320;
    var s = Math.floor(Math.min(wrapW / state.w, 360 / state.h));
    if (s < 1) s = 1;
    if (s > 16) s = 16;
    return s;
  }

  function renderStep() {
    var st = state.steps[state.stepIdx];
    var scale = fitScale() * state.zoom;
    var c = $('stepCanvas');
    c.width = state.w * scale;
    c.height = state.h * scale;
    var ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false;

    // offscreen 1x buffer
    var off = document.createElement('canvas');
    off.width = state.w; off.height = state.h;
    var octx = off.getContext('2d');
    var img = octx.createImageData(state.w, state.h);
    var d = state.px, out = img.data;
    var vis = st.visible;
    var tone = st.tone || null;
    var iso = state.isolate, tpl = state.template;
    var k2s = state.steps.keyToStep || new Map();
    var addedKeys = st.addedKeys || new Set();
    var tr = 0, tg = 0, tb = 0;
    if (tone) { tr = parseInt(tone.slice(1, 3), 16); tg = parseInt(tone.slice(3, 5), 16); tb = parseInt(tone.slice(5, 7), 16); }
    var dbgRgb = null;
    if (tpl) dbgRgb = SB_debugPalette().map(hexRgb);
    var n = state.w * state.h;
    for (var i = 0; i < n; i++) {
      var o = i * 4;
      if (d[o + 3] === 0) continue;
      var k = SB_key(d[o], d[o + 1], d[o + 2], d[o + 3]);
      var r, g, b;
      if (tone) {
        // Silhouette step: the shape as one tone, in every mode.
        r = tr; g = tg; b = tb;
      } else if (tpl) {
        var si = k2s.get(k);
        if (si === undefined) continue;
        if (iso && si !== state.stepIdx) continue;
        if (!iso && !vis.has(k)) continue;
        var dc = dbgRgb[si % dbgRgb.length];
        r = dc[0]; g = dc[1]; b = dc[2];
      } else if (iso) {
        if (!addedKeys.has(k)) continue;
        r = d[o]; g = d[o + 1]; b = d[o + 2];
      } else {
        if (!vis.has(k)) continue;
        r = d[o]; g = d[o + 1]; b = d[o + 2];
      }
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
    }
    octx.putImageData(img, 0, 0);
    ctx.drawImage(off, 0, 0, c.width, c.height);

    $('stepTitle').textContent = 'Step ' + st.num + ' of ' + st.total + ': ' + st.title;
    $('stepTip').textContent = st.tip;
    $('zoomLabel').textContent = scale + 'x';

    // swatches added at this step
    var sw = $('stepSwatches');
    sw.innerHTML = '';
    st.added.forEach(function (col) {
      sw.appendChild(swatchCell(col, col.role));
    });
    if (!st.added.length) {
      var p = document.createElement('p');
      p.className = 'hint';
      p.textContent = state.cl.colors.length + ' colors total in this sprite.';
      sw.appendChild(p);
    }

    // dots
    var dots = $('dots');
    dots.innerHTML = '';
    state.steps.forEach(function (s, i) {
      var b = document.createElement('button');
      b.className = 'dot';
      b.setAttribute('aria-label', 'Go to step ' + s.num + ': ' + s.title);
      b.setAttribute('aria-current', i === state.stepIdx ? 'true' : 'false');
      b.addEventListener('click', function () { goStep(i); });
      dots.appendChild(b);
    });

    $('prevBtn').disabled = state.stepIdx === 0;
    $('nextBtn').disabled = state.stepIdx === state.steps.length - 1;

    renderMeasure(st);
    renderLegend();
  }

  /* Bounding box as source-sprite pixel coordinates: "(x1, y1) to (x2, y2)".
     st.bbox is in analysis pixels; SB_toSourceBox maps it back to the
     original sprite grid (analysis may run downscaled). */
  function bboxText(st) {
    if (!st.bbox) return null;
    var b = SB_toSourceBox(st.bbox, state.srcW, state.srcH, state.w, state.h);
    if (!b) return null;
    return '(' + b.x0 + ', ' + b.y0 + ') to (' + b.x1 + ', ' + b.y1 + ')';
  }

  /* Per-step pixel measurements: what this step adds, with real numbers. */
  function renderMeasure(st) {
    var m = $('stepMeasure');
    m.innerHTML = '';
    function addRow(swatchHex, label, meta, total) {
      var row = document.createElement('div');
      row.className = 'mrow' + (total ? ' mtotal' : '');
      if (swatchHex) {
        var sw = document.createElement('span');
        sw.className = 'msw';
        sw.style.background = swatchHex;
        row.appendChild(sw);
      }
      var lab = document.createElement('span');
      lab.className = 'mhex';
      lab.textContent = label;
      row.appendChild(lab);
      var mm = document.createElement('span');
      mm.className = 'mmeta';
      mm.textContent = meta;
      row.appendChild(mm);
      m.appendChild(row);
    }
    if (st.tone) {
      var bt = bboxText(st);
      addRow(null, 'Shape', bt ? bt + ' — ' + fmt(st.addedCount) + ' opaque px' : fmt(st.addedCount) + ' opaque px', true);
    } else if (st.added.length) {
      st.added.forEach(function (col) {
        addRow(col.hex, col.hex + ' · ' + col.role, fmt(col.count) + ' px');
      });
      var b = bboxText(st);
      addRow(null, 'Step area', (b ? b + ' — ' : '') + fmt(st.addedCount) + ' px', true);
    } else {
      addRow(null, 'No new colors', 'full sprite shown', true);
    }
  }

  /* Template-mode legend: debug color -> step number + what it adds. */
  function renderLegend() {
    var lg = $('tplLegend');
    lg.innerHTML = '';
    if (!state.template) { lg.classList.add('hidden'); return; }
    lg.classList.remove('hidden');
    var dbg = SB_debugPalette();
    state.steps.forEach(function (s, i) {
      var row = document.createElement('div');
      row.className = 'lgrow';
      if (s.tone || !s.added.length) {
        var dash = document.createElement('span');
        dash.className = 'lgno';
        dash.textContent = '—';
        row.appendChild(dash);
        var t0 = document.createElement('span');
        t0.textContent = 'Step ' + s.num + ' · ' + s.title + ' — ';
        var em = document.createElement('span');
        em.className = 'mmeta';
        em.textContent = s.tone ? 'shape only, no debug color' : 'no new colors';
        t0.appendChild(em);
        row.appendChild(t0);
      } else {
        var sw = document.createElement('span');
        sw.className = 'msw';
        sw.style.background = dbg[i % dbg.length];
        row.appendChild(sw);
        var t1 = document.createElement('span');
        t1.textContent = 'Step ' + s.num + ' · ' + s.title + ' — ';
        var em2 = document.createElement('span');
        em2.className = 'mmeta';
        em2.textContent = 'adds ' + fmt(s.addedCount) + ' px';
        t1.appendChild(em2);
        row.appendChild(t1);
      }
      if (i === state.stepIdx) row.style.outline = '2px solid var(--accent)';
      lg.appendChild(row);
    });
  }

  function swatchCell(col, role) {
    var cell = document.createElement('div');
    cell.className = 'swcell';
    var b = document.createElement('button');
    b.className = 'sw';
    b.style.background = col.hex;
    b.title = col.hex + ' (' + role + ', ' + col.count + ' px)';
    b.setAttribute('aria-label', 'Copy ' + col.hex);
    b.addEventListener('click', function () { copyText(col.hex, 'Copied'); });
    var lab = document.createElement('div');
    lab.className = 'swhex';
    lab.textContent = col.hex;
    cell.appendChild(b);
    cell.appendChild(lab);
    return cell;
  }

  function renderPalette() {
    var pal = $('allPalette');
    pal.innerHTML = '';
    state.cl.colors.forEach(function (col) {
      pal.appendChild(swatchCell(col, col.role));
    });
    $('palCount').textContent = state.cl.colors.length + ' colors · ' +
      state.cl.totalOpaque + ' opaque pixels · ' + state.srcW + '×' + state.srcH;
  }

  function goStep(i) {
    if (i < 0 || i >= state.steps.length) return;
    state.stepIdx = i;
    renderStep();
  }

  function zoomBy(d) {
    var z = state.zoom + d;
    if (z < 1) z = 1;
    if (z > 4) z = 4;
    state.zoom = z;
    renderStep();
  }

  /* ---- configurable guide step count (2..24, default 6) ---- */
  function renderStepCount() {
    if (!state.cl) return;
    var cap = SB_stepCapacity(state.cl);
    $('stepCountVal').textContent = state.steps.length;
    $('stepDown').disabled = state.stepN <= 2;
    $('stepUp').disabled = state.stepN >= Math.min(24, cap);
  }

  function changeStep(d) {
    if (!state.cl) return;
    var cap = SB_stepCapacity(state.cl);
    var n = state.stepN + d;
    if (n < 2) n = 2;
    if (n > 24) n = 24;
    var clamped = false;
    if (n > cap) { n = cap; clamped = true; }
    if (n === state.stepN && state.steps.length === n) return;
    state.stepN = n;
    state.steps = SB_buildSteps(state.cl, n);
    state.stepIdx = 0;
    renderStepCount();
    renderStep();
    var note = $('stepCountNote');
    if (clamped) {
      note.textContent = 'This sprite breaks down into at most ' + cap + ' meaningful steps.';
      note.classList.remove('hidden');
    } else {
      note.classList.add('hidden');
    }
  }

  /* ---- file intake ---- */
  function handleFile(file) {
    if (!file || !file.type.match(/^image\//)) { toast('Please choose an image file'); return; }
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      var size = SB_downscaleSize(img.naturalWidth, img.naturalHeight);
      var c = document.createElement('canvas');
      c.width = size.w; c.height = size.h;
      var ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(img, 0, 0, size.w, size.h);
      var data = ctx.getImageData(0, 0, size.w, size.h).data;
      loadPixels(data, size.w, size.h, size.scaled, img.naturalWidth, img.naturalHeight);
      resetScroll();
    };
    img.onerror = function () { toast('Could not read that image'); };
    img.src = url;
  }

  function init() {
    var dz = $('dropzone'), fi = $('fileInput');
    dz.addEventListener('click', function () { fi.click(); });
    dz.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fi.click(); }
    });
    fi.addEventListener('change', function () { handleFile(fi.files[0]); fi.value = ''; });
    ['dragenter', 'dragover'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('dragover'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('dragover'); });
    });
    dz.addEventListener('drop', function (e) {
      if (e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
    });

    $('prevBtn').addEventListener('click', function () { goStep(state.stepIdx - 1); });
    $('nextBtn').addEventListener('click', function () { goStep(state.stepIdx + 1); });
    $('zoomIn').addEventListener('click', function () { zoomBy(1); });
    $('zoomOut').addEventListener('click', function () { zoomBy(-1); });
    $('stepDown').addEventListener('click', function () { changeStep(-1); });
    $('stepUp').addEventListener('click', function () { changeStep(1); });
    $('isolateTgl').addEventListener('change', function (e) { state.isolate = e.target.checked; renderStep(); });
    $('templateTgl').addEventListener('change', function (e) { state.template = e.target.checked; renderStep(); });

    // swipe navigation
    var sx = null;
    var stage = $('stage');
    stage.addEventListener('touchstart', function (e) { sx = e.changedTouches[0].clientX; }, { passive: true });
    stage.addEventListener('touchend', function (e) {
      if (sx === null) return;
      var dx = e.changedTouches[0].clientX - sx;
      sx = null;
      if (Math.abs(dx) > 40) goStep(state.stepIdx + (dx < 0 ? 1 : -1));
    }, { passive: true });

    $('gplBtn').addEventListener('click', function () {
      download('palette.gpl', SB_paletteToGpl(state.cl.colors, 'Sprite Breakdown'), 'text/plain');
      toast('palette.gpl saved');
    });
    $('hexBtn').addEventListener('click', function () {
      copyText(state.cl.colors.map(function (c) { return c.hex; }).join(', '), 'Palette copied');
    });
    $('newBtn').addEventListener('click', function () {
      document.title = 'Sprite Breakdown';
      $('resultView').classList.add('hidden');
      $('uploadView').classList.remove('hidden');
      resetScroll();
    });

    window.addEventListener('error', function (e) {
      document.title = 'ERROR: ' + (e.message || 'js error');
    });
  }

  // Synchronous hook for automated tests / screenshots.
  window.SpriteBreakdown = {
    loadPixels: loadPixels,
    version: 'mvp-5'
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

/* ---- UI smoke driver: drives the real app through the fake DOM ---- */
var TW = 12, TH = 12;
var tdata = [];
for (var ty = 0; ty < TH; ty++) {
  for (var tx = 0; tx < TW; tx++) {
    var r, g, b;
    if (tx === 0 || ty === 0 || tx === TW - 1 || ty === TH - 1) { r = 26; g = 28; b = 44; }
    else if (tx === 5 && ty === 5) { r = 46; g = 210; b = 124; }
    else if (ty < 6) { r = 210; g = 60; b = 46; }
    else { r = 142; g = 35; b = 24; }
    tdata.push(r, g, b, 255);
  }
}
var total = TW * TH;

function opaqueCount() {
  if (!lastImg) return -1;
  var d = lastImg.data, n = 0;
  for (var i = 3; i < d.length; i += 4) if (d[i] !== 0) n++;
  return n;
}
function distinctHex() {
  var d = lastImg.data, set = {};
  for (var i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    var h = '#' + [d[i], d[i + 1], d[i + 2]].map(function (n) {
      return n.toString(16).padStart(2, '0');
    }).join('');
    set[h] = true;
  }
  return Object.keys(set);
}
function collectText(el) {
  var t = el.textContent || '';
  (el.children || []).forEach(function (c) { t += ' ' + collectText(c); });
  return t;
}

window.SpriteBreakdown.loadPixels(tdata, TW, TH, false);
var tcl = SB_classify(tdata, TW, TH);
var steps = SB_buildSteps(tcl, 6);
assert(steps.length >= 2, 'smoke: expected steps, got ' + steps.length);

// initial render (silhouette) shows every opaque pixel
assert(opaqueCount() === total, 'smoke initial render: expected ' + total + ' got ' + opaqueCount());

// step forward: a color-adding step shows a strict subset
els.nextBtn._handlers.click();
assert(opaqueCount() > 0 && opaqueCount() < total,
  'smoke step 2 should show a subset, got ' + opaqueCount());

// isolate toggle -> exactly the current step's added pixels
els.isolateTgl.checked = true;
els.isolateTgl._handlers.change({ target: els.isolateTgl });
assert(opaqueCount() === steps[1].addedCount,
  'smoke isolate count: expected ' + steps[1].addedCount + ' got ' + opaqueCount());
els.isolateTgl.checked = false;
els.isolateTgl._handlers.change({ target: els.isolateTgl });

// go to the final step
for (var k = 0; k < steps.length; k++) els.nextBtn._handlers.click();

// template colors on the final step -> full coverage, debug colors only
els.templateTgl.checked = true;
els.templateTgl._handlers.change({ target: els.templateTgl });
var pal = SB_debugPalette();
var palSet = {}; pal.forEach(function (h) { palSet[h] = true; });
var dh = distinctHex();
assert(opaqueCount() === total, 'template final step should cover all ' + total + ' px, got ' + opaqueCount());
assert(dh.every(function (h) { return palSet[h]; }),
  'template render uses non-debug colors: ' + dh.filter(function (h) { return !palSet[h]; }).join(','));
assert(els.tplLegend.children.length === steps.length,
  'legend rows: expected ' + steps.length + ' got ' + els.tplLegend.children.length);

// template + isolate on a color-adding step -> only its pixels, in its debug color
// (the last step may legitimately add no new colors, so use step 1 = Base fills)
for (var q = 0; q < steps.length - 2; q++) els.prevBtn._handlers.click();
els.isolateTgl.checked = true;
els.isolateTgl._handlers.change({ target: els.isolateTgl });
var sOne = steps[1];
assert(sOne.added.length > 0, 'smoke: step 1 should add colors');
var dh2 = distinctHex();
assert(opaqueCount() === sOne.addedCount,
  'template+isolate count: expected ' + sOne.addedCount + ' got ' + opaqueCount());
assert(dh2.length === 1 && palSet[dh2[0]],
  'template+isolate should use exactly one debug color, got ' + dh2.join(','));

// measure panel: coordinate format "(x, y) to (x, y)", never WxH
var mtxt = collectText(els.stepMeasure);
assert(mtxt.indexOf('px') > -1, 'measure panel has no pixel counts: ' + mtxt.slice(0, 120));
assert(/\(\d+, \d+\) to \(\d+, \d+\)/.test(mtxt),
  'measure panel missing coordinate format: ' + mtxt.slice(0, 160));
assert(mtxt.indexOf('\u00d7') === -1,
  'measure panel still uses WxH multiplication: ' + mtxt.slice(0, 160));

// source-space mapping end-to-end: 12x12 analysis pixels standing in for a 48x48 source
window.SpriteBreakdown.loadPixels(tdata, TW, TH, false, 48, 48);
var mtxt2 = collectText(els.stepMeasure);
var allM = mtxt2.match(/\(\d+, \d+\) to \(\d+, \d+\)/g) || [];
var m2 = allM.length ? allM[allM.length - 1].match(/\((\d+), (\d+)\) to \((\d+), (\d+)\)/) : null;
assert(m2, 'no coordinate bbox after src-dim load: ' + mtxt2.slice(-160));
if (m2) {
  assert(+m2[1] === 0 && +m2[2] === 0 && +m2[3] === 47 && +m2[4] === 47,
    'full-frame bbox should map to (0, 0) to (47, 47), got ' + m2[0]);
}
assert(els.palCount.textContent.indexOf('48\u00d748') > -1,
  'palette header should show source dims 48\u00d748, got: ' + els.palCount.textContent);

print('UI_SMOKE:' + JSON.stringify({ pass: failures.length === 0, failures: failures }));
