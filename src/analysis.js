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
