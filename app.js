"use strict";

// ---------------------------------------------------------------------------
// Static metadata
// ---------------------------------------------------------------------------

const STYLE_NAMES = {
  BN: "Bossa Nova",
  Funk: "Funk",
  Jazz: "Jazz",
  Rock: "Rock",
  SS: "Singer-Songwriter",
};

const MODELS = [
  { id: "main_pipeline", label: "2 stage" },
  { id: "velocity_joint_peak", label: "1 stage" },
  { id: "ddsp_guitar", label: "ddsp-guitar" },
  { id: "ground_truth", label: "ground-truth" },
];

// tab10 colors matplotlib names in scripts/pipeline/plot_ctrl_preview.py's COLORS map to,
// so channel colors here match that script's PNGs exactly.
const TAB_COLORS = {
  "tab:blue": "#2f6fed",
  "tab:orange": "#e0820a",
  "tab:green": "#1f9d55",
  "tab:purple": "#8b5cf6",
  "tab:red": "#e0393e",
};

const INPUT_CHANNELS = [
  "midi_pitch",
  "pseudo_velocity",
  "segment_phase",
  "segment_onset",
  "voiced",
];
const TARGET_CHANNELS = ["pitch", "envelope"];

// distinct per-string colors for the MIDI piano-roll (low E -> high e), independent of
// the control-curve channel palette above.
const STRING_COLORS = [
  "#e0393e", // string 1 - low E
  "#e0820a", // string 2 - A
  "#c9a227", // string 3 - D
  "#1f9d55", // string 4 - G
  "#2f6fed", // string 5 - B
  "#8b5cf6", // string 6 - high e
];
const STRING_NAMES = ["Low E", "A", "D", "G", "B", "High E"];

// Output-comparison plot: one fixed color per system, independent of the string/channel
// palettes above, and the draw order (ground truth drawn first/underneath, so the three
// synthesized systems' lines aren't hidden behind it).
const COMPARE_ORDER = ["ground_truth", "main_pipeline", "velocity_joint_peak", "ddsp_guitar"];
const ARM_COMPARE_COLORS = {
  ground_truth: "#6b7280",
  main_pipeline: "#2f6fed",
  velocity_joint_peak: "#e0820a",
  ddsp_guitar: "#8b5cf6",
};

// Per-legend-item click toggles a system's line on/off in both comparison canvases, so
// two curves can be isolated for a direct A/B read. All visible by default.
const compareVisible = {};
for (const arm of COMPARE_ORDER) compareVisible[arm] = true;

// ---------------------------------------------------------------------------
// Exclusive audio playback: never two clips at once.
// ---------------------------------------------------------------------------

let currentAudioEl = null;
function registerExclusive(el) {
  el.addEventListener("play", () => {
    if (currentAudioEl && currentAudioEl !== el) currentAudioEl.pause();
    currentAudioEl = el;
  });
}

// ---------------------------------------------------------------------------
// Shared playhead: whichever registered <audio> is currently playing drives every
// visualization (MIDI roll + every curve/comparison panel) via one rAF loop.
// ---------------------------------------------------------------------------

const playheadListeners = [];
function onPlayhead(fn) {
  playheadListeners.push(fn);
}
function tickPlayhead() {
  if (currentAudioEl && !currentAudioEl.paused) {
    const t = currentAudioEl.currentTime;
    for (const fn of playheadListeners) fn(t);
  }
  requestAnimationFrame(tickPlayhead);
}
requestAnimationFrame(tickPlayhead);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let manifest = null;
let currentSample = null;
let currentModel = MODELS[0].id;
let currentString = 1;
let currentNotes = null; // {"1": [...], ...}
let currentCurves = null; // parsed string<N>.json: {inputs, target_gt, synth_input, comparison}
let lastPlayheadT = null; // last active playback time, kept while paused so a legend
                           // toggle mid-pause redraws at the same position instead of blank

const el = (id) => document.getElementById(id);

// Selecting a model/string can hide/show or resize sections above whatever the user is
// currently looking at (e.g. "Predictor input" only exists for the 2-stage system), and
// the browser has no way to know what content the user cares about staying put -- it
// just leaves window.scrollY numerically unchanged, which visually "jumps" to different
// content once the layout above it grows/shrinks. This finds whichever stable landmark
// element's top edge is closest to the viewport's top edge before the mutation, then
// nudges scroll after the mutation so that same element lands at the same screen
// position again -- ephemeral rebuilt content (individual curve rows/canvases) is
// deliberately excluded from the candidate set since those get torn down and rebuilt,
// and <summary> elements are excluded too since two of the three <details> sections can
// themselves be hidden by the very mutation being measured -- a hidden element's
// getBoundingClientRect() reports all zeros, which would compute a bogus delta.
const SCROLL_ANCHOR_SELECTOR = "h1, .panel, .audio-block, h3, .curve-section-header";
function _captureScrollAnchor() {
  let anchor = null;
  let anchorTop = null;
  for (const candidate of document.querySelectorAll(SCROLL_ANCHOR_SELECTOR)) {
    const top = candidate.getBoundingClientRect().top;
    if (anchorTop === null || Math.abs(top) < Math.abs(anchorTop)) {
      anchor = candidate;
      anchorTop = top;
    }
  }
  return { anchor, before: anchor ? anchor.getBoundingClientRect().top : null };
}

function _restoreScrollAnchor({ anchor, before }) {
  if (anchor && before != null && document.contains(anchor)) {
    const delta = anchor.getBoundingClientRect().top - before;
    if (delta !== 0) window.scrollBy(0, delta);
  }
}

function preserveScrollPosition(mutate) {
  const state = _captureScrollAnchor();
  mutate();
  _restoreScrollAnchor(state);
}

// Same idea, but spans an async sequence (e.g. loadSample's awaited fetch + nested
// loadModel/loadCurves calls) as ONE before/after measurement instead of several small
// ones -- sequential separate captures can each pick a slightly different anchor as
// intermediate mutations shift what's closest to the viewport top, compounding into a
// residual drift none of them individually catches.
async function preserveScrollPositionAsync(mutate) {
  const state = _captureScrollAnchor();
  await mutate();
  _restoreScrollAnchor(state);
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function fetchJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`failed to fetch ${path}: ${res.status}`);
  return res.json();
}

async function loadManifest() {
  manifest = await fetchJSON("data/manifest.json");
  const select = el("sampleSelect");
  select.innerHTML = "";
  for (const id of Object.keys(manifest.recordings)) {
    const rec = manifest.recordings[id];
    const opt = document.createElement("option");
    opt.value = id;
    const styleName = STYLE_NAMES[rec.style] || rec.style;
    const practice = rec.tier === "practice" ? " \u00b7 practice" : "";
    opt.textContent = `${id} \u2014 ${styleName}, ${rec.take}${practice}`;
    select.appendChild(opt);
  }
  select.addEventListener("change", () => loadSample(select.value));
}

async function loadSample(id) {
  // Switching samples must not leave a previous clip audible.
  if (currentAudioEl) currentAudioEl.pause();
  currentSample = id;
  const rec = manifest.recordings[id];

  await preserveScrollPositionAsync(async () => {
    const styleName = STYLE_NAMES[rec.style] || rec.style;
    el("sampleMeta").textContent =
      `${styleName} \u00b7 player ${rec.player} \u00b7 ${rec.take} \u00b7 ${rec.duration_s.toFixed(2)}s` +
      (rec.tier === "practice" ? " \u00b7 practice recording (unscored)" : "");

    const query = el("queryAudio");
    query.src = `data/${id}/audio/query.mp3`;
    query.load();

    currentNotes = await fetchJSON(`data/${id}/notes.json`);
    drawMidiRoll();
    buildStringLegend(rec.available_strings);
    buildStringSelectorRow(rec.available_strings);

    currentString = mostActiveString(rec.available_strings, currentNotes);

    await loadModel(currentModel);
    await loadCurves(currentString);
  });
}

async function loadModel(modelId) {
  if (currentAudioEl === el("modelAudio")) currentAudioEl.pause();
  if (currentAudioEl === el("stringAudio")) currentAudioEl.pause();
  currentModel = modelId;
  for (const btn of document.querySelectorAll(".model-select-group .pill-btn")) {
    btn.classList.toggle("active", btn.dataset.model === modelId);
  }

  const audio = el("modelAudio");
  audio.src = `data/${currentSample}/audio/${modelId}.mp3`;
  audio.load();
  updateStringAudio();

  applyDefaultCompareVisibility(modelId);
  renderModelDependentCurves();
}

function updateStringAudio() {
  const audio = el("stringAudio");
  audio.src = `data/${currentSample}/audio/strings/${currentModel}/string${currentString}.mp3`;
  audio.load();
}

async function loadCurves(stringNum) {
  if (currentAudioEl === el("stringAudio")) currentAudioEl.pause();
  currentString = stringNum;
  for (const btn of document.querySelectorAll("#stringSelectorRow .pill-btn")) {
    btn.classList.toggle("active", parseInt(btn.dataset.string, 10) === stringNum);
  }
  updateStringAudio();
  currentCurves = await fetchJSON(`data/${currentSample}/ctrl/string${stringNum}.json`);
  renderModelDependentCurves();
}

// "Single String Study" defaults to whichever string actually carries the performance
// for this clip (most notes played), rather than always string 1 -- most GuitarSet
// takes concentrate the melody/comping on one or two strings, and the rest are mostly
// silent open/drone notes not worth landing on by default.
function mostActiveString(availableStrings, notes) {
  let best = availableStrings[0];
  let bestCount = -1;
  for (const s of availableStrings) {
    const count = (notes[String(s)] || []).length;
    if (count > bestCount) {
      best = s;
      bestCount = count;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// MIDI piano-roll visualizer
// ---------------------------------------------------------------------------

function buildStringLegend(strings) {
  const container = el("stringLegend");
  container.innerHTML = "";
  for (const s of strings) {
    const span = document.createElement("span");
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = STRING_COLORS[s - 1];
    span.appendChild(swatch);
    span.appendChild(document.createTextNode(`String ${s} (${STRING_NAMES[s - 1]})`));
    container.appendChild(span);
  }
}

// Fixed pitch range covering every note across all 5 demo recordings (MIDI 40-73),
// snapped out to whole-octave C boundaries so the C-note gridlines/labels land cleanly
// and the range never rescales per sample/string.
const MIDI_PITCH_MIN = 36; // C2
const MIDI_PITCH_MAX = 84; // C6

function niceTimeStep(duration) {
  // one tick per second up to 12s, else coarsen so labels don't collide
  if (duration <= 12) return 1;
  if (duration <= 30) return 2;
  return 5;
}

function drawMidiRoll(playheadT) {
  const canvas = el("midiCanvas");
  const cssWidth = Math.max(canvas.clientWidth, 300);
  const cssHeight = 300;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const width = cssWidth;
  const height = cssHeight;
  ctx.clearRect(0, 0, width, height);

  if (!currentNotes) return;
  const duration = manifest.recordings[currentSample].duration_s;
  const minPitch = MIDI_PITCH_MIN;
  const maxPitch = MIDI_PITCH_MAX;

  const padL = 38;
  const padR = 8;
  const padT = 8;
  const padB = 20;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const xOf = (t) => padL + (t / duration) * plotW;
  const yOf = (p) => padT + (1 - (p - minPitch) / (maxPitch - minPitch)) * plotH;

  // horizontal guide line + "Cn" label at every octave (C2, C3, ... C6)
  ctx.font = "12px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let p = minPitch; p <= maxPitch; p += 12) {
    const y = Math.round(yOf(p)) + 0.5;
    ctx.strokeStyle = p === minPitch || p === maxPitch
      ? "rgba(0,0,0,0.22)"
      : "rgba(0,0,0,0.09)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(width - padR, y);
    ctx.stroke();
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillText(`C${p / 12 - 1}`, padL - 6, y);
  }

  // vertical guide line + time label every niceTimeStep(duration) seconds
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const step = niceTimeStep(duration);
  for (let t = 0; t <= duration + 1e-6; t += step) {
    const x = Math.round(xOf(t)) + 0.5;
    ctx.strokeStyle = "rgba(0,0,0,0.07)";
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, height - padB);
    ctx.stroke();
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillText(`${Math.round(t)}s`, x, height - padB + 4);
  }

  // fixed, sane note thickness (independent of pitch-range span, which was the source of
  // the "incredibly thick" notes -- it used to scale with plotH / (maxPitch-minPitch))
  const noteH = 9;
  for (const sKey of Object.keys(currentNotes)) {
    const sIdx = parseInt(sKey, 10) - 1;
    ctx.fillStyle = STRING_COLORS[sIdx];
    for (const n of currentNotes[sKey]) {
      const x0 = xOf(n.start_s);
      const x1 = xOf(n.start_s + Math.max(n.dur_s, 0.02));
      const y = yOf(n.pitch) - noteH / 2;
      ctx.globalAlpha = 0.92;
      const r = 2;
      const w = Math.max(x1 - x0, 2);
      roundRect(ctx, x0, y, w, noteH, r);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;

  drawPlayhead(ctx, xOf, height, playheadT, duration, padT, height - padB);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawPlayhead(ctx, xOf, height, t, duration, yTop, yBottom) {
  if (t == null) return;
  const clamped = Math.max(0, Math.min(duration, t));
  const x = Math.round(xOf(clamped)) + 0.5;
  const y0 = yTop == null ? 0 : yTop;
  const y1 = yBottom == null ? height : yBottom;
  ctx.strokeStyle = "#1b1f27";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, y0);
  ctx.lineTo(x, y1);
  ctx.stroke();
}

// ---------------------------------------------------------------------------
// Playhead-canvas registry: every canvas that needs to redraw on each rAF tick
// registers a draw(playheadT) closure here, keyed by its own canvas element (dedup) and
// by a "container" used to bulk-evict stale entries when a container's canvases are
// thrown away and rebuilt from scratch (buildCurveGroup, buildSynthInputCurves, ...).
// ---------------------------------------------------------------------------

const playheadCanvases = [];

function registerPlayheadCanvas(canvas, container, drawFn) {
  for (let i = playheadCanvases.length - 1; i >= 0; i--) {
    if (playheadCanvases[i].canvas === canvas) playheadCanvases.splice(i, 1);
  }
  playheadCanvases.push({ canvas, container, draw: drawFn });
}

function clearContainerCanvases(container) {
  for (let i = playheadCanvases.length - 1; i >= 0; i--) {
    if (playheadCanvases[i].container === container) playheadCanvases.splice(i, 1);
  }
}

function redrawAllCurves(playheadT) {
  for (const entry of playheadCanvases) entry.draw(playheadT);
}

// ---------------------------------------------------------------------------
// Control-curve mini panels
// ---------------------------------------------------------------------------

function _addCurveRow(container, labelText) {
  const row = document.createElement("div");
  row.className = "curve-row";
  const label = document.createElement("div");
  label.className = "curve-label";
  label.textContent = labelText;
  const canvas = document.createElement("canvas");
  row.appendChild(label);
  row.appendChild(canvas);
  container.appendChild(row);
  return canvas;
}

function buildCurveGroup(container, channels, dataByChannel) {
  container.innerHTML = "";
  clearContainerCanvases(container);
  for (const name of channels) {
    const chan = dataByChannel[name];
    if (!chan) continue;
    const canvas = _addCurveRow(container, chan.label);
    const draw = (t) => drawCurvePanel(canvas, chan, name, t);
    registerPlayheadCanvas(canvas, container, draw);
    draw(null);
  }
}

function _drawSeries(ctx, t, v, xOf, yOf) {
  ctx.beginPath();
  let drawing = false;
  for (let i = 0; i < t.length; i++) {
    if (v[i] == null) {
      drawing = false;
      continue;
    }
    const x = xOf(t[i]);
    const y = yOf(v[i]);
    if (!drawing) {
      ctx.moveTo(x, y);
      drawing = true;
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.stroke();
}

function _formatAxisValue(v) {
  const abs = Math.abs(v);
  if (abs >= 100) return Math.round(v).toString();
  if (abs >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

// Shared left margin reserved for y-axis tick labels, so every row in a curve-group
// (line curves, the voiced block, the onset/voiced strip) lines up on the same x origin
// even though only the numeric line curves actually draw tick labels into it.
const Y_AXIS_PAD_L = 44;

function _drawYAxisTicks(ctx, minV, maxV, yOf, padL, padR, width) {
  ctx.font = "10px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const val of [maxV, (minV + maxV) / 2, minV]) {
    const y = Math.round(yOf(val)) + 0.5;
    ctx.strokeStyle = "rgba(0,0,0,0.08)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(width - padR, y);
    ctx.stroke();
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillText(_formatAxisValue(val), padL - 6, y);
  }
}

function drawCurvePanel(canvas, chan, name, playheadT, overlayChan) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(rect.width, 200);
  const height = Math.max(rect.height, 40);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const t = chan.t;
  const v = chan.v;
  const duration = (currentCurves && currentCurves.duration_s) || (t.length ? t[t.length - 1] : 1);
  const padT = 6;
  const padB = 6;
  const padL = Y_AXIS_PAD_L;
  const padR = 6;
  const plotH = height - padT - padB;
  const plotW = width - padL - padR;
  const xOf = (tt) => padL + (tt / duration) * plotW;

  if (name === "voiced") {
    // binary block, matches plot_ctrl_preview.py's _plot_block: a filled gray span
    // wherever the mask is truthy, nothing drawn otherwise.
    ctx.fillStyle = "rgba(0,0,0,0.12)";
    let runStart = null;
    for (let i = 0; i < v.length; i++) {
      const on = v[i] != null && v[i] > 0.5;
      if (on && runStart == null) runStart = t[i];
      if ((!on || i === v.length - 1) && runStart != null) {
        const end = t[i];
        ctx.fillRect(xOf(runStart), padT, Math.max(xOf(end) - xOf(runStart), 1), plotH);
        runStart = null;
      }
    }
  } else {
    let minV = Infinity;
    let maxV = -Infinity;
    const scan = (arr) => {
      for (const val of arr) {
        if (val == null) continue;
        minV = Math.min(minV, val);
        maxV = Math.max(maxV, val);
      }
    };
    scan(v);
    if (overlayChan) scan(overlayChan.v);
    if (!isFinite(minV)) {
      drawPlayhead(ctx, xOf, height, playheadT, duration);
      return;
    }
    if (minV === maxV) {
      minV -= 1;
      maxV += 1;
    }
    const margin = (maxV - minV) * 0.1;
    minV -= margin;
    maxV += margin;
    const yOf = (val) => padT + (1 - (val - minV) / (maxV - minV)) * plotH;

    _drawYAxisTicks(ctx, minV, maxV, yOf, padL, padR, width);

    if (overlayChan) {
      ctx.save();
      ctx.globalAlpha = 0.4;
      ctx.strokeStyle = "#5d6673";
      ctx.lineWidth = 1.3;
      ctx.setLineDash([3, 3]);
      _drawSeries(ctx, overlayChan.t, overlayChan.v, xOf, yOf);
      ctx.restore();
    }

    ctx.strokeStyle = TAB_COLORS[chan.color] || "#2f6fed";
    ctx.lineWidth = 1.6;
    _drawSeries(ctx, t, v, xOf, yOf);
  }

  drawPlayhead(ctx, xOf, height, playheadT, duration);
}

function drawOnsetVoicedPanel(canvas, voicedChan, onsetTimes, playheadT) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(rect.width, 200);
  const height = Math.max(rect.height, 40);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const duration = (currentCurves && currentCurves.duration_s) || 1;
  const padL = Y_AXIS_PAD_L;
  const padR = 6;
  const plotW = width - padL - padR;
  const xOf = (tt) => padL + (tt / duration) * plotW;

  // gray voiced blocks
  const t = voicedChan.t;
  const v = voicedChan.v;
  ctx.fillStyle = "rgba(0,0,0,0.12)";
  let runStart = null;
  for (let i = 0; i < v.length; i++) {
    const on = v[i] != null && v[i] > 0.5;
    if (on && runStart == null) runStart = t[i];
    if ((!on || i === v.length - 1) && runStart != null) {
      ctx.fillRect(xOf(runStart), 4, Math.max(xOf(t[i]) - xOf(runStart), 1), height - 8);
      runStart = null;
    }
  }

  // black onset ticks, drawn on top of the voiced blocks
  ctx.strokeStyle = "#1b1f27";
  ctx.lineWidth = 2;
  for (const ot of onsetTimes) {
    const x = Math.round(xOf(ot)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 2);
    ctx.lineTo(x, height - 2);
    ctx.stroke();
  }

  drawPlayhead(ctx, xOf, height, playheadT, duration);
}

function buildSynthInputCurves(container, model) {
  container.innerHTML = "";
  clearContainerCanvases(container);
  const synth = currentCurves.synth_input[model];
  const overlay = model === "main_pipeline" ? currentCurves.target_gt : null;

  for (const name of TARGET_CHANNELS) {
    const chan = synth[name];
    const canvas = _addCurveRow(container, chan.label);
    const overlayChan = overlay ? overlay[name] : null;
    const draw = (t) => drawCurvePanel(canvas, chan, name, t, overlayChan);
    registerPlayheadCanvas(canvas, container, draw);
    draw(null);
  }

  if (model === "main_pipeline") {
    const canvas = _addCurveRow(container, "onset (tick) / voiced (block) \u2014 fed to synth");
    const draw = (t) => drawOnsetVoicedPanel(canvas, synth.voiced, synth.onset_t, t);
    registerPlayheadCanvas(canvas, container, draw);
    draw(null);
  }
}

function renderModelDependentCurves() {
  if (!currentCurves) return;

  preserveScrollPosition(() => {
    // Predictor input: only the 2-stage system's predictor is conditioned on this.
    const predSection = el("predictorInputSection");
    const inputGroup = el("inputCurves");
    if (currentModel === "main_pipeline") {
      predSection.hidden = false;
      buildCurveGroup(inputGroup, INPUT_CHANNELS, currentCurves.inputs);
    } else {
      predSection.hidden = true;
      inputGroup.innerHTML = "";
      clearContainerCanvases(inputGroup);
    }

    // Synthesizer input: differs per system, ddsp-guitar shows nothing at all.
    const synthSection = el("synthInputSection");
    const title = el("synthInputTitle");
    const note = el("synthInputNote");
    const group = el("synthInputCurves");
    group.innerHTML = "";
    clearContainerCanvases(group);

    if (currentModel === "ddsp_guitar") {
      synthSection.hidden = true;
    } else {
      synthSection.hidden = false;
      if (currentModel === "main_pipeline") {
        title.textContent = "Synthesizer input";
        note.hidden = false;
        note.textContent = "Faint dashed line: ground-truth, not fed to the synth";
        buildSynthInputCurves(group, "main_pipeline");
      } else if (currentModel === "velocity_joint_peak") {
        title.textContent = "Synthesizer input";
        note.hidden = true;
        buildSynthInputCurves(group, "velocity_joint_peak");
      } else if (currentModel === "ground_truth") {
        title.textContent = "Ground truth curve";
        note.hidden = true;
        buildCurveGroup(group, TARGET_CHANNELS, currentCurves.target_gt);
      }
    }

    renderComparisonPlot();
  });
}

// ---------------------------------------------------------------------------
// Output comparison: pitch/envelope re-extracted from each system's own rendered audio.
// ---------------------------------------------------------------------------

function drawComparisonPanel(canvas, seriesMap, playheadT, voicedMask) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(rect.width, 200);
  const height = Math.max(rect.height, 100);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const duration = (currentCurves && currentCurves.duration_s) || 1;
  const padL = Y_AXIS_PAD_L;
  const padR = 6;
  const padT = 8;
  const padB = 8;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const xOf = (tt) => padL + (tt / duration) * plotW;

  // faint gray background wherever the real recording actually has a note sounding
  // (ground-truth voiced mask), drawn first so every line stays fully legible on top.
  if (voicedMask) {
    ctx.fillStyle = "rgba(0,0,0,0.07)";
    let runStart = null;
    const vt = voicedMask.t;
    const vv = voicedMask.v;
    for (let i = 0; i < vv.length; i++) {
      const on = vv[i] != null && vv[i] > 0.5;
      if (on && runStart == null) runStart = vt[i];
      if ((!on || i === vv.length - 1) && runStart != null) {
        ctx.fillRect(xOf(runStart), padT, Math.max(xOf(vt[i]) - xOf(runStart), 1), plotH);
        runStart = null;
      }
    }
  }

  let minV = Infinity;
  let maxV = -Infinity;
  for (const arm of COMPARE_ORDER) {
    if (!compareVisible[arm]) continue;
    const s = seriesMap[arm];
    if (!s) continue;
    for (const val of s.v) {
      if (val == null) continue;
      minV = Math.min(minV, val);
      maxV = Math.max(maxV, val);
    }
  }
  if (!isFinite(minV)) {
    drawPlayhead(ctx, xOf, height, playheadT, duration, padT, height - padB);
    return;
  }
  if (minV === maxV) {
    minV -= 1;
    maxV += 1;
  }
  const margin = (maxV - minV) * 0.1;
  minV -= margin;
  maxV += margin;
  const yOf = (val) => padT + (1 - (val - minV) / (maxV - minV)) * plotH;

  _drawYAxisTicks(ctx, minV, maxV, yOf, padL, padR, width);

  for (const arm of COMPARE_ORDER) {
    if (!compareVisible[arm]) continue;
    const s = seriesMap[arm];
    if (!s) continue;
    ctx.strokeStyle = ARM_COMPARE_COLORS[arm];
    ctx.lineWidth = arm === "ground_truth" ? 1.3 : 1.6;
    ctx.globalAlpha = arm === "ground_truth" ? 0.7 : 0.95;
    _drawSeries(ctx, s.t, s.v, xOf, yOf);
  }
  ctx.globalAlpha = 1;

  drawPlayhead(ctx, xOf, height, playheadT, duration, padT, height - padB);
}

function buildCompareLegend() {
  const container = el("compareLegend");
  container.innerHTML = "";
  for (const arm of COMPARE_ORDER) {
    const meta = MODELS.find((m) => m.id === arm);
    const item = document.createElement("button");
    item.type = "button";
    item.className = "legend-item";
    item.dataset.arm = arm;
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = ARM_COMPARE_COLORS[arm];
    item.appendChild(swatch);
    item.appendChild(document.createTextNode(meta.label));
    item.title = "Click to show/hide this system's line";
    item.addEventListener("click", () => {
      compareVisible[arm] = !compareVisible[arm];
      item.classList.toggle("off", !compareVisible[arm]);
      redrawComparisonCanvases();
    });
    container.appendChild(item);
  }
}

function redrawComparisonCanvases() {
  const pitchCanvas = el("comparePitchCanvas");
  const envCanvas = el("compareEnvelopeCanvas");
  for (const entry of playheadCanvases) {
    if (entry.canvas === pitchCanvas || entry.canvas === envCanvas) entry.draw(lastPlayheadT);
  }
}

// Default comparison-plot visibility: ground truth plus whichever model tab is active,
// so switching models re-centers the comparison on "reference vs. this system" without
// the other two systems cluttering the initial view. Selecting ground-truth itself has
// no distinct "other system" to pair it with, so that case opens all four instead.
// Clicking a legend item still overrides this per the usual toggle behavior.
function defaultCompareVisible(modelId) {
  const vis = {};
  if (modelId === "ground_truth") {
    for (const arm of COMPARE_ORDER) vis[arm] = true;
    return vis;
  }
  for (const arm of COMPARE_ORDER) vis[arm] = false;
  vis.ground_truth = true;
  vis[modelId] = true;
  return vis;
}

function applyDefaultCompareVisibility(modelId) {
  const defaults = defaultCompareVisible(modelId);
  for (const arm of COMPARE_ORDER) compareVisible[arm] = defaults[arm];
  updateLegendButtonStates();
}

function updateLegendButtonStates() {
  for (const btn of document.querySelectorAll("#compareLegend .legend-item")) {
    btn.classList.toggle("off", !compareVisible[btn.dataset.arm]);
  }
}

function renderComparisonPlot() {
  const comp = currentCurves.comparison;
  const voicedMask = currentCurves.voiced_gt;
  const pitchCanvas = el("comparePitchCanvas");
  const envCanvas = el("compareEnvelopeCanvas");

  const pitchSeries = {};
  const envSeries = {};
  for (const arm of COMPARE_ORDER) {
    pitchSeries[arm] = comp[arm].pitch;
    envSeries[arm] = comp[arm].envelope;
  }

  const drawPitch = (t) => drawComparisonPanel(pitchCanvas, pitchSeries, t, voicedMask);
  const drawEnv = (t) => drawComparisonPanel(envCanvas, envSeries, t, voicedMask);
  registerPlayheadCanvas(pitchCanvas, pitchCanvas, drawPitch);
  registerPlayheadCanvas(envCanvas, envCanvas, drawEnv);
  drawPitch(null);
  drawEnv(null);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function buildModelSelectorRow() {
  for (const container of document.querySelectorAll(".model-select-group")) {
    container.innerHTML = "";
    for (const m of MODELS) {
      const btn = document.createElement("button");
      btn.className = "pill-btn";
      btn.dataset.model = m.id;
      btn.textContent = m.label;
      btn.addEventListener("click", () => loadModel(m.id));
      container.appendChild(btn);
    }
  }
}

function buildStringSelectorRow(strings) {
  const container = el("stringSelectorRow");
  container.innerHTML = "";
  for (const s of strings) {
    const btn = document.createElement("button");
    btn.className = "pill-btn";
    btn.dataset.string = s;
    btn.title = `String ${s} (${STRING_NAMES[s - 1]})`;
    btn.textContent = String(s);
    btn.addEventListener("click", () => loadCurves(s));
    container.appendChild(btn);
  }
}

async function main() {
  buildModelSelectorRow();
  buildCompareLegend();
  await loadManifest();

  registerExclusive(el("queryAudio"));
  registerExclusive(el("modelAudio"));
  registerExclusive(el("stringAudio"));

  // Collapsed <details> render their children at zero size, so canvases built while
  // folded need a fresh redraw once actually visible -- otherwise they stay stuck at
  // the fallback ~200px width from before the section was ever opened.
  for (const id of ["predictorInputSection", "synthInputSection", "comparisonSection"]) {
    const details = el(id);
    details.addEventListener("toggle", () => {
      if (details.open) renderModelDependentCurves();
    });
  }

  // Entering "Single String Study" folds "Full Mix Study" out of the way so the reader
  // can focus on the string-level comparison -- not locked, they can still reopen it.
  // Also redraws: a nested predictor/synth/comparison section left open from a previous
  // visit rendered its canvases at fallback size while THIS outer section was collapsed
  // (collapsed <details> content has zero layout size regardless of a descendant's own
  // open state), so its own "opened" redraw never fired for the current dimensions.
  el("singleStringSection").addEventListener("toggle", () => {
    if (!el("singleStringSection").open) return;
    preserveScrollPosition(() => {
      if (el("fullMixSection").open) el("fullMixSection").open = false;
      renderModelDependentCurves();
    });
  });

  onPlayhead((t) => {
    lastPlayheadT = t;
    drawMidiRoll(t);
    redrawAllCurves(t);
  });

  window.addEventListener("resize", () => {
    const t = currentAudioEl && !currentAudioEl.paused ? currentAudioEl.currentTime : 0;
    drawMidiRoll(t);
    redrawAllCurves(t);
  });

  const firstSample = Object.keys(manifest.recordings)[0];
  el("sampleSelect").value = firstSample;
  await loadSample(firstSample);
}

main();
