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


var DATA = [26, 28, 44, 255, 26, 28, 44, 255, 26, 28, 44, 255, 26, 28, 44, 255, 26, 28, 44, 255, 26, 28, 44, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 26, 28, 44, 255, 58, 123, 213, 255, 42, 90, 168, 255, 58, 123, 213, 255, 42, 90, 168, 255, 26, 28, 44, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 26, 28, 44, 255, 42, 90, 168, 255, 58, 123, 213, 255, 42, 90, 168, 255, 58, 123, 213, 255, 26, 28, 44, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 26, 28, 44, 255, 58, 123, 213, 255, 42, 90, 168, 255, 58, 123, 213, 255, 42, 90, 168, 255, 26, 28, 44, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 26, 28, 44, 255, 42, 90, 168, 255, 58, 123, 213, 255, 42, 90, 168, 255, 58, 123, 213, 255, 26, 28, 44, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 26, 28, 44, 255, 26, 28, 44, 255, 26, 28, 44, 255, 26, 28, 44, 255, 26, 28, 44, 255, 26, 28, 44, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 26, 28, 44, 255, 26, 28, 44, 255, 26, 28, 44, 255, 26, 28, 44, 255, 26, 28, 44, 255, 26, 28, 44, 255, 26, 28, 44, 255, 26, 28, 44, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 26, 28, 44, 255, 210, 60, 46, 255, 210, 60, 46, 255, 210, 60, 46, 255, 210, 60, 46, 255, 210, 60, 46, 255, 210, 60, 46, 255, 26, 28, 44, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 26, 28, 44, 255, 210, 60, 46, 255, 46, 210, 124, 255, 46, 210, 124, 255, 210, 60, 46, 255, 210, 60, 46, 255, 210, 60, 46, 255, 26, 28, 44, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 26, 28, 44, 255, 210, 60, 46, 255, 210, 60, 46, 255, 210, 60, 46, 255, 210, 60, 46, 255, 210, 60, 46, 255, 210, 60, 46, 255, 26, 28, 44, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 26, 28, 44, 255, 142, 35, 24, 255, 142, 35, 24, 255, 142, 35, 24, 255, 142, 35, 24, 255, 142, 35, 24, 255, 142, 35, 24, 255, 26, 28, 44, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 26, 28, 44, 255, 142, 35, 24, 255, 142, 35, 24, 255, 142, 35, 24, 255, 142, 35, 24, 255, 142, 35, 24, 255, 142, 35, 24, 255, 26, 28, 44, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 26, 28, 44, 255, 242, 118, 90, 255, 242, 118, 90, 255, 242, 118, 90, 255, 242, 118, 90, 255, 242, 118, 90, 255, 242, 118, 90, 255, 26, 28, 44, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 26, 28, 44, 255, 26, 28, 44, 255, 26, 28, 44, 255, 26, 28, 44, 255, 26, 28, 44, 255, 26, 28, 44, 255, 26, 28, 44, 255, 26, 28, 44, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
var W = 24, H = 24;
var EXPECTED = {"#1a1c2c": 48, "#d23c2e": 16, "#2ed27c": 2, "#8e2318": 12, "#f2765a": 6, "#3a7bd5": 8, "#2a5aa8": 8};
var EXPECTED_BBOX = {"#1a1c2c": [0, 0, 15, 15], "#d23c2e": [9, 9, 14, 11], "#2ed27c": [10, 10, 11, 10], "#8e2318": [9, 12, 14, 13], "#f2765a": [9, 14, 14, 14], "#3a7bd5": [1, 1, 4, 4], "#2a5aa8": [1, 1, 4, 4]};
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
