/* Sprite Breakdown — app shell (DOM). Pure analysis lives in analysis.js. */
(function () {
  'use strict';

  var state = { cl: null, steps: [], stepIdx: 0, zoom: 1, w: 0, h: 0, px: null, scaledNote: false, stepN: 6, isolate: false, template: false };

  function $(id) { return document.getElementById(id); }

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
      window.scrollTo(0, 0);
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
      window.scrollTo(0, 0);
    });

    window.addEventListener('error', function (e) {
      document.title = 'ERROR: ' + (e.message || 'js error');
    });
  }

  // Synchronous hook for automated tests / screenshots.
  window.SpriteBreakdown = {
    loadPixels: loadPixels,
    version: 'mvp-4'
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
