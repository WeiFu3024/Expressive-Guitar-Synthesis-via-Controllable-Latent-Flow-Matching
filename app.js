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
  {
    id: "main_pipeline",
    label: "2 stage",
    description:
      "Ours. Score \u2192 predicted per-string performance curves (pe_note_shape_fixed13) " +
      "\u2192 PEOV-embed latent flow-matching synth \u2192 learned six-string mix reverb.",
  },
  {
    id: "velocity_joint_peak",
    label: "1 stage",
    description:
      "Flat MIDI pitch + peak pseudo-velocity, no predicted performance curves \u2192 " +
      "architecture-matched single-stage joint synth. Fair single-stage-vs-two-stage baseline.",
  },
  {
    id: "ddsp_guitar",
    label: "ddsp-guitar",
    description:
      "Public erl-j/ddsp-guitar-unified checkpoint, score MIDI with their own pitch " +
      "correction and note-duration extension.",
  },
  {
    id: "ground_truth",
    label: "ground-truth",
    description:
      "Original GuitarSet room-microphone recording, cut to the same window \u2014 the " +
      "listening reference, not a model output.",
  },
];

// Which curve each system's target-curve panel actually shows. Only main_pipeline has a
// real per-frame stage-2 prediction (pe_note_shape_fixed13's own output, "target_predicted"
// in the exported JSON); ground_truth's panel is the real recording's own CREPE/RMS
// curve ("target_gt"); the other two systems don't produce or expose a comparable
// per-frame curve at all, so their panel says so instead of silently reusing ground
// truth as if it were a prediction.
const MODEL_CURVE_INFO = {
  main_pipeline: {
    source: "target_predicted",
    title: "Predicted performance curves (pe_note_shape_fixed13's own stage-2 output)",
  },
  ground_truth: {
    source: "target_gt",
    title: "Ground-truth performance curves (CREPE pitch / log-RMS envelope)",
  },
  velocity_joint_peak: {
    source: null,
    title: "Predicted performance curves",
    note:
      "Not available \u2014 this baseline bypasses the stage-2 predictor entirely (flat " +
      "MIDI pitch + peak pseudo-velocity feeds the synth directly, no per-frame curve " +
      "is produced).",
  },
  ddsp_guitar: {
    source: null,
    title: "Predicted performance curves",
    note:
      "Not available \u2014 public erl-j/ddsp-guitar-unified checkpoint; its internal " +
      "pitch-correction curve isn't exposed by this pipeline.",
  },
};

// tab10 colors matplotlib names in scripts/pipeline/plot_ctrl_preview.py's COLORS map to,
// so channel colors here match that script's PNGs exactly.
const TAB_COLORS = {
  "tab:blue": "#4c78ff",
  "tab:orange": "#ff9f40",
  "tab:green": "#48c774",
  "tab:purple": "#b57bff",
  "tab:red": "#ff5c5c",
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
  "#ff5c5c", // string 1 - low E
  "#ff9f40", // string 2 - A
  "#f6d551", // string 3 - D
  "#48c774", // string 4 - G
  "#4c9bff", // string 5 - B
  "#b57bff", // string 6 - high e
];
const STRING_NAMES = ["Low E", "A", "D", "G", "B", "High E"];

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
// visualization (MIDI roll + both curve groups) via one rAF loop.
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
let currentCurves = null; // parsed string<N>.json

const el = (id) => document.getElementById(id);

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

  const stringSelect = el("stringSelect");
  stringSelect.innerHTML = "";
  for (const s of rec.available_strings) {
    const opt = document.createElement("option");
    opt.value = s;
    opt.textContent = `String ${s} (${STRING_NAMES[s - 1]})`;
    stringSelect.appendChild(opt);
  }
  currentString = rec.available_strings.includes(currentString)
    ? currentString
    : rec.available_strings[0];
  stringSelect.value = currentString;

  await loadModel(currentModel);
  await loadCurves(currentString);
}

async function loadModel(modelId) {
  if (currentAudioEl === el("modelAudio")) currentAudioEl.pause();
  currentModel = modelId;
  for (const btn of document.querySelectorAll(".model-select-btn")) {
    btn.classList.toggle("active", btn.dataset.model === modelId);
  }
  const meta = MODELS.find((m) => m.id === modelId);
  el("modelDescription").textContent = meta.description;

  const audio = el("modelAudio");
  audio.src = `data/${currentSample}/audio/${modelId}.mp3`;
  audio.load();

  renderTargetCurves();
}

function renderTargetCurves() {
  const info = MODEL_CURVE_INFO[currentModel];
  el("targetCurvesTitle").textContent = info.title;
  const group = el("targetCurves");
  const note = el("targetCurvesNote");

  if (!info.source || !currentCurves) {
    for (let i = curveCanvases.length - 1; i >= 0; i--) {
      if (curveCanvases[i].container === group) curveCanvases.splice(i, 1);
    }
    group.innerHTML = "";
    group.hidden = true;
    note.hidden = false;
    note.textContent = info.note || "Not available for this recording/string.";
    return;
  }
  group.hidden = false;
  note.hidden = true;
  buildCurveGroup(group, TARGET_CHANNELS, currentCurves[info.source]);
}

async function loadCurves(stringNum) {
  currentString = stringNum;
  currentCurves = await fetchJSON(`data/${currentSample}/ctrl/string${stringNum}.json`);
  buildCurveGroup(el("inputCurves"), INPUT_CHANNELS, currentCurves.inputs);
  renderTargetCurves();
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
  const cssHeight = 260;
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

  const padL = 34;
  const padR = 8;
  const padT = 8;
  const padB = 20;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const xOf = (t) => padL + (t / duration) * plotW;
  const yOf = (p) => padT + (1 - (p - minPitch) / (maxPitch - minPitch)) * plotH;

  // horizontal guide line + "Cn" label at every octave (C2, C3, ... C6)
  ctx.font = "10px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let p = minPitch; p <= maxPitch; p += 12) {
    const y = Math.round(yOf(p)) + 0.5;
    ctx.strokeStyle = p === minPitch || p === maxPitch
      ? "rgba(255,255,255,0.18)"
      : "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(width - padR, y);
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.fillText(`C${p / 12 - 1}`, padL - 6, y);
  }

  // vertical guide line + time label every niceTimeStep(duration) seconds
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const step = niceTimeStep(duration);
  for (let t = 0; t <= duration + 1e-6; t += step) {
    const x = Math.round(xOf(t)) + 0.5;
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, height - padB);
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.fillText(`${Math.round(t)}s`, x, height - padB + 4);
  }

  // fixed, sane note thickness (independent of pitch-range span, which was the source of
  // the "incredibly thick" notes -- it used to scale with plotH / (maxPitch-minPitch))
  const noteH = 7;
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
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, y0);
  ctx.lineTo(x, y1);
  ctx.stroke();
}

// ---------------------------------------------------------------------------
// Control-curve mini panels
// ---------------------------------------------------------------------------

const curveCanvases = []; // {canvas, channel} for playhead redraw

function buildCurveGroup(container, channels, dataByChannel) {
  container.innerHTML = "";
  // remove any stale entries for this container before repopulating
  for (let i = curveCanvases.length - 1; i >= 0; i--) {
    if (curveCanvases[i].container === container) curveCanvases.splice(i, 1);
  }
  for (const name of channels) {
    const chan = dataByChannel[name];
    if (!chan) continue;
    const row = document.createElement("div");
    row.className = "curve-row";
    const label = document.createElement("div");
    label.className = "curve-label";
    label.textContent = chan.label;
    const canvas = document.createElement("canvas");
    row.appendChild(label);
    row.appendChild(canvas);
    container.appendChild(row);
    curveCanvases.push({ canvas, chan, name, container });
    drawCurvePanel(canvas, chan, name);
  }
}

function drawCurvePanel(canvas, chan, name, playheadT) {
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
  const duration =
    (currentCurves && currentCurves.duration_s) ||
    (t.length ? t[t.length - 1] : 1);
  const padT = 6;
  const padB = 6;
  const plotH = height - padT - padB;
  const xOf = (tt) => (tt / duration) * width;

  if (name === "voiced") {
    // binary block, matches plot_ctrl_preview.py's _plot_block: a filled gray span
    // wherever the mask is truthy, nothing drawn otherwise.
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    let runStart = null;
    for (let i = 0; i < v.length; i++) {
      const on = v[i] != null && v[i] > 0.5;
      if (on && runStart == null) runStart = t[i];
      if ((!on || i === v.length - 1) && runStart != null) {
        const end = on ? t[i] : t[i];
        ctx.fillRect(xOf(runStart), padT, Math.max(xOf(end) - xOf(runStart), 1), plotH);
        runStart = null;
      }
    }
  } else {
    let minV = Infinity;
    let maxV = -Infinity;
    for (const val of v) {
      if (val == null) continue;
      minV = Math.min(minV, val);
      maxV = Math.max(maxV, val);
    }
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

    ctx.strokeStyle = TAB_COLORS[chan.color] || "#4c78ff";
    ctx.lineWidth = 1.6;
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

  drawPlayhead(ctx, xOf, height, playheadT, duration);
}

function redrawAllCurves(playheadT) {
  for (const { canvas, chan, name } of curveCanvases) {
    drawCurvePanel(canvas, chan, name, playheadT);
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function buildModelSelectorRow() {
  const container = el("modelSelectorRow");
  container.innerHTML = "";
  for (const m of MODELS) {
    const btn = document.createElement("button");
    btn.className = "model-select-btn";
    btn.dataset.model = m.id;
    btn.textContent = m.label;
    btn.addEventListener("click", () => loadModel(m.id));
    container.appendChild(btn);
  }
}

async function main() {
  buildModelSelectorRow();
  await loadManifest();

  registerExclusive(el("queryAudio"));
  registerExclusive(el("modelAudio"));

  el("stringSelect").addEventListener("change", (e) => {
    loadCurves(parseInt(e.target.value, 10));
  });

  onPlayhead((t) => {
    drawMidiRoll(t);
    redrawAllCurves(t);
  });

  window.addEventListener("resize", () => {
    drawMidiRoll(currentAudioEl && !currentAudioEl.paused ? currentAudioEl.currentTime : 0);
    redrawAllCurves(currentAudioEl && !currentAudioEl.paused ? currentAudioEl.currentTime : 0);
  });

  const firstSample = Object.keys(manifest.recordings)[0];
  el("sampleSelect").value = firstSample;
  await loadSample(firstSample);
}

main();
