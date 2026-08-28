import { LifeGrid } from "./life.js";
import { AudioEngine, SOUND_MODES, VOICE_FAMILIES, mulberry32 } from "./audio.js";
import { encodeBoards, decodeFragment } from "./share.js";
import { PRESETS, stampPreset } from "./patterns.js";

const DEFAULTS = {
  audio: { files: null, baseUrl: "", manifestUrl: "sounds/manifest.json" },
  grid: { cols: 36, rows: 22 },
  bpm: 96,
  assignmentSeed: 42,
  maxVoices: "auto",
  sequences: [],
  geographic: false,
  soundMode: "famcg",
  leads: [false, false],
  gridCount: 1,
  gridRhythms: [1, 1.5, 0.75],
  voiceFamily: "classic",
  effects: { reverb: false, delay: false, chorus: false, saturation: false },
};

const userConfig = window.CONWAY_MUSIC_CONFIG || {};
const config = {
  ...DEFAULTS,
  ...userConfig,
  audio: { ...DEFAULTS.audio, ...(userConfig.audio || {}) },
  grid: { ...DEFAULTS.grid, ...(userConfig.grid || {}) },
  effects: { ...DEFAULTS.effects, ...(userConfig.effects || {}) },
};

// ---------------------------------------------------------------------------
// State

const COLS = config.grid.cols;
const ROWS = config.grid.rows;
const PER_GRID = COLS * ROWS;
const MAX_GRIDS = 3;
// Beats per step for each grid: quarter, dotted quarter, dotted eighth.
const STEP_BEATS = [0, 1, 2].map((g) => config.gridRhythms[g] ?? 1);
const RHYTHM_GLYPHS = ["♩", "♩.", "♪."];

const lifes = Array.from({ length: MAX_GRIDS }, () => new LifeGrid(COLS, ROWS));
let gridCount = Math.max(1, Math.min(MAX_GRIDS, config.gridCount || 1));

// Each cell gets a stable value in [0, 1) from a seeded PRNG, used for its
// hue and (in file mode) its mapping onto the loaded audio files. Cells are
// addressed globally: gridIndex * PER_GRID + local index.
const soundValues = new Float32Array(PER_GRID * MAX_GRIDS);
{
  const rng = mulberry32(config.assignmentSeed);
  for (let i = 0; i < soundValues.length; i++) soundValues[i] = rng();
}

const audio = new AudioEngine(config, soundValues);

function globalId(g, localIndex) {
  return g * PER_GRID + localIndex;
}

let bpm = config.bpm;
let playing = false;
let schedulerTimer = null;

// Master beat lattice (quarter notes): drives the chord progression, the
// lead overlays, and the auto-pause check. Each grid then steps on its own
// lattice of STEP_BEATS[g]-beat steps against the same clock.
let masterBeat = 0;
let nextMasterTime = 0;
const stepIndex = [0, 0, 0];
const nextStepTime = [0, 0, 0];
const firstStepPending = [true, true, true];

const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD = 0.12; // seconds of audio scheduled in advance

// Snapshots queued by the scheduler, applied to the display at their audio
// time so visuals stay locked to what's heard. One view per grid.
let frameQueue = []; // { g, time, cells, generation, births, deaths }
const view = lifes.map((life) => ({ cells: life.cells, generation: 0, lastStepTime: 0 }));

// Per-cell timestamps (audio clock) for birth flashes and death ghosts.
const bornAt = new Float64Array(PER_GRID * MAX_GRIDS).fill(-Infinity);
const diedAt = new Float64Array(PER_GRID * MAX_GRIDS).fill(-Infinity);

// ---------------------------------------------------------------------------
// DOM

const canvas = document.getElementById("grid");
const ctx2d = canvas.getContext("2d");
const playButton = document.getElementById("play");
const stepButton = document.getElementById("step");
const randomButton = document.getElementById("random");
const clearButton = document.getElementById("clear");
const shareButton = document.getElementById("share");
const presetSelect = document.getElementById("presets");
const modeSelect = document.getElementById("mode");
const familySelect = document.getElementById("family");
const leadButtons = [document.getElementById("lead1"), document.getElementById("lead2")];
const gridButtons = [1, 2, 3].map((n) => document.getElementById(`grids${n}`));
const collapseButton = document.getElementById("collapse");
const controlsBar = document.getElementById("controls");
const fxPanel = document.getElementById("fxpanel");
const fxCollapse = document.getElementById("fx-collapse");
const fxBoxes = Object.fromEntries(
  ["reverb", "delay", "chorus", "saturation"].map((name) => [
    name,
    document.getElementById(`fx-${name}`),
  ])
);
const bpmSlider = document.getElementById("bpm");
const bpmValue = document.getElementById("bpm-value");
const generationLabel = document.getElementById("generation");
const soundbankLabel = document.getElementById("soundbank");
const intro = document.getElementById("intro");

bpmSlider.value = String(bpm);
bpmValue.textContent = String(bpm);

// ---------------------------------------------------------------------------
// Audio bootstrap (browsers require a user gesture before audio can start)

let audioReady = null;
function ensureAudio() {
  if (!audioReady) {
    audioReady = audio.init(bpm).then(() => {
      updateBankLabel();
      // Visual timestamps recorded before init used performance.now();
      // from here on everything runs on the audio clock, so reset them.
      bornAt.fill(-Infinity);
      diedAt.fill(-Infinity);
    });
  }
  return audioReady;
}

// ---------------------------------------------------------------------------
// Transport / scheduler

function beatDuration() {
  return 60 / bpm;
}

function visibleLifes() {
  return lifes.slice(0, gridCount);
}

function totalPopulation() {
  return visibleLifes().reduce((sum, life) => sum + life.population, 0);
}

async function togglePlay() {
  if (playing) {
    pause();
  } else {
    await play();
  }
}

async function play() {
  await ensureAudio();
  // Synth figures are rendered to fit their grid's step, so retune the bank
  // if the tempo changed since it was built.
  audio.rebuildSynthBank(bpm);
  audio.setFxTempo(bpm);
  // Render the starting cells' buffers up front so the first beat is clean.
  audio.prewarm(visibleLifes().map((life) => life.cells));
  playing = true;
  masterBeat = 0;
  const start = audio.now + 0.08;
  nextMasterTime = start;
  for (let g = 0; g < MAX_GRIDS; g++) {
    stepIndex[g] = 0;
    nextStepTime[g] = start;
    firstStepPending[g] = true;
  }
  frameQueue = [];
  playButton.innerHTML = "&#10074;&#10074; Pause";
  schedulerTimer = setInterval(scheduleAhead, LOOKAHEAD_MS);
}

function pause() {
  playing = false;
  clearInterval(schedulerTimer);
  schedulerTimer = null;
  // A swap still waiting for its beat shouldn't be lost on pause.
  if (pendingSwaps) {
    for (const mutate of pendingSwaps) mutate();
    pendingSwaps = null;
  }
  frameQueue = [];
  if (audio.ctx) audio.stopAllVoices();
  for (let g = 0; g < MAX_GRIDS; g++) {
    view[g].cells = lifes[g].cells;
    view[g].generation = lifes[g].generation;
  }
  playButton.innerHTML = "&#9654; Play";
  updateGenerationLabel();
  syncHash();
}

/** Schedule master beats and every visible grid's steps, in time order. */
function scheduleAhead() {
  const horizon = audio.now + SCHEDULE_AHEAD;
  let sawLate = false;
  while (playing) {
    // Earliest pending event wins; master beats break ties so the chord
    // and overlay state are current before any step at the same instant.
    let which = -1; // -1 = master beat
    let best = nextMasterTime;
    for (let g = 0; g < gridCount; g++) {
      if (nextStepTime[g] < best - 1e-9) {
        best = nextStepTime[g];
        which = g;
      }
    }
    if (best >= horizon) break;
    if (best < audio.now - 0.03) sawLate = true; // missed a deadline
    if (which === -1) {
      masterTick(nextMasterTime);
      nextMasterTime += beatDuration();
    } else {
      scheduleStep(which, nextStepTime[which], stepIndex[which]);
      stepIndex[which]++;
      nextStepTime[which] += STEP_BEATS[which] * beatDuration();
    }
  }
  if (sawLate) governor.lateBatches++;
}

function masterTick(time) {
  if (pendingSwaps) applyPendingSwaps(time);
  audio.overlayBeat(time, bpm, totalPopulation(), masterBeat);
  masterBeat++;
  if (masterBeat % GOVERNOR_BEATS === 0) governorCheck();
  if (totalPopulation() === 0 && !pendingSwaps) pause();
}

// ---------------------------------------------------------------------------
// Voice governor: with maxVoices "auto", the polyphony cap follows measured
// performance. A render benchmark at init sets the starting point; from
// there the cap is reviewed every eight master beats — musical time, not a
// wall-clock poll. A scheduler pass that dispatched anything late counts as
// ONE late batch (hiccups make whole queues late at once, and counting each
// event punished a single stumble many times over); cutting requires
// repeated evidence within the window, and recovery needs only one clean,
// pressured window.

const GOVERNOR_BEATS = 8;
const governor = { lateBatches: 0, longFrames: 0, lastFrameTs: 0 };

function governorCheck() {
  if (!audio.autoVoices) return;
  const pressure = audio.takeCapPressure();
  const stressed = governor.lateBatches >= 2 || governor.longFrames >= 4;
  if (stressed) {
    audio.setVoiceCap(audio.maxVoices * 0.9);
    updateBankLabel();
  } else if (pressure > 0) {
    audio.setVoiceCap(audio.maxVoices + 8);
    updateBankLabel();
  }
  governor.lateBatches = 0;
  governor.longFrames = 0;
}

// Shown as "sounding / cap": how many voices are actually playing right
// now against the governor's polyphony budget.
let lastVoiceLabel = "";
function updateBankLabel() {
  const label = `${audio.bankLabel} · ${audio.voices.size}/${audio.maxVoices} voices`;
  if (label === lastVoiceLabel) return;
  lastVoiceLabel = label;
  soundbankLabel.textContent = label;
}

function scheduleStep(g, time, index) {
  const life = lifes[g];
  let births;
  let deaths = [];

  if (firstStepPending[g]) {
    // Step 0: every cell of the starting pattern comes in.
    firstStepPending[g] = false;
    births = [];
    for (let i = 0; i < life.cells.length; i++) if (life.cells[i]) births.push(i);
  } else {
    ({ births, deaths } = life.step());
  }

  // The chord bar in effect when this step begins governs its notes.
  const bar = audio.barAtBeat(index * STEP_BEATS[g]);
  for (const i of deaths) audio.stopVoice(globalId(g, i), time);
  audio.chordBarTick(g, time, bar);
  for (const i of births) {
    audio.startVoice(globalId(g, i), time, bar, g === 0 ? index : 0);
  }
  // Cells muted by the polyphony cap rejoin here, at their own step
  // boundary and thus in phase, whenever capacity has freed up.
  audio.auditionSilent(g, life.cells, time, bar, g === 0 ? index : 0);

  frameQueue.push({
    g,
    time,
    generation: life.generation,
    cells: life.cells.slice(),
    births,
    deaths,
  });
}

// ---------------------------------------------------------------------------
// Editing

function toggleCell(g, col, row, forceAlive = null) {
  const life = lifes[g];
  const i = life.index(col, row);
  const id = globalId(g, i);
  const wasAlive = life.cells[i] === 1;
  const alive = forceAlive === null ? !wasAlive : forceAlive;
  if (alive === wasAlive) return;
  life.cells[i] = alive ? 1 : 0;

  if (playing && audio.ctx) {
    // Live editing: the cell joins or leaves the music immediately.
    if (alive) audio.startVoice(id, audio.now, audio.barAtBeat(masterBeat), masterBeat);
    else audio.stopVoice(id, audio.now);
    if (view[g].cells !== life.cells) view[g].cells[i] = alive ? 1 : 0;
    // Snapshots already queued for upcoming steps predate this edit.
    for (const frame of frameQueue) if (frame.g === g) frame.cells[i] = alive ? 1 : 0;
  } else {
    // While paused, preview the cell's sound as it is painted on.
    if (alive) ensureAudio().then(() => audio.preview(id));
    syncHash();
  }
  if (alive) bornAt[id] = audio.ctx ? audio.now : performance.now() / 1000;
}

function clearBoard() {
  if (playing) pause();
  for (const life of lifes) life.clear();
  for (let g = 0; g < MAX_GRIDS; g++) {
    view[g].cells = lifes[g].cells;
    view[g].generation = 0;
  }
  updateGenerationLabel();
  syncHash();
}

function randomizeBoard() {
  // Each visible grid draws its own density, biased toward the sparse end,
  // so Random ranges from a handful of seeds to a crowded board.
  replaceBoards(() => {
    for (const life of visibleLifes()) {
      life.randomize(0.03 + 0.3 * Math.pow(Math.random(), 1.6));
    }
  });
}

/**
 * Swap in new boards (Random, riff presets). While playing, the music
 * carries on — but the swap is quantized: it takes effect on the next
 * master beat, both audibly and visually, so formation changes land on
 * the beat instead of wherever the click happened to fall. The beat
 * lattice, tempo, and chord-progression phase never stop.
 */
let pendingSwaps = null; // mutators waiting for the next master beat

function replaceBoards(mutate) {
  if (!playing) {
    mutate();
    for (let g = 0; g < MAX_GRIDS; g++) {
      view[g].cells = lifes[g].cells;
      view[g].generation = lifes[g].generation;
    }
    updateGenerationLabel();
    syncHash();
    return;
  }
  (pendingSwaps ??= []).push(mutate);
}

/** Apply queued board swaps at master-beat time `time` (called ahead of it). */
function applyPendingSwaps(time) {
  const swaps = pendingSwaps;
  pendingSwaps = null;
  const befores = lifes.map((life) => life.cells.slice());
  for (const mutate of swaps) mutate();
  const bar = audio.barAtBeat(masterBeat);
  for (let g = 0; g < gridCount; g++) {
    const life = lifes[g];
    const births = [];
    const deaths = [];
    for (let i = 0; i < life.cells.length; i++) {
      if (befores[g][i] === life.cells[i]) continue;
      const id = globalId(g, i);
      if (life.cells[i]) {
        audio.startVoice(id, time, bar, masterBeat);
        births.push(i);
      } else {
        audio.stopVoice(id, time);
        deaths.push(i);
      }
    }
    // The display flips on the beat too, via the ordinary snapshot queue.
    frameQueue.push({
      g,
      time,
      generation: life.generation,
      cells: life.cells.slice(),
      births,
      deaths,
    });
    // Give the new formation its full first step on every grid before it
    // starts evolving (its next step re-announces instead of stepping).
    firstStepPending[g] = true;
  }
}

function stepOnce() {
  if (playing) return;
  for (const life of visibleLifes()) life.step();
  for (let g = 0; g < MAX_GRIDS; g++) {
    view[g].cells = lifes[g].cells;
    view[g].generation = lifes[g].generation;
  }
  updateGenerationLabel();
  syncHash();
}

function updateGenerationLabel() {
  generationLabel.textContent = `gen ${view[0].generation}`;
}

function setGridCount(n) {
  if (n === gridCount) return;
  const prev = gridCount;
  gridCount = n;
  gridButtons.forEach((button, i) => button.classList.toggle("active", i + 1 === n));

  if (playing) {
    // The music carries on. A joining grid starts at the next point on its
    // own step lattice (in phase with the master clock, so its cells come
    // in chord-correct via the first-step announcement); a leaving grid's
    // voices stop now.
    const beatSec = beatDuration();
    for (let g = prev; g < n; g++) {
      const k = Math.ceil((masterBeat - 1e-9) / STEP_BEATS[g]);
      stepIndex[g] = k;
      nextStepTime[g] = nextMasterTime + (k * STEP_BEATS[g] - masterBeat) * beatSec;
      firstStepPending[g] = true;
    }
    for (let g = n; g < prev; g++) {
      if (audio.ctx) audio.stopGridVoices(g, audio.now);
    }
    frameQueue = frameQueue.filter((frame) => frame.g < n);
    for (let g = n; g < MAX_GRIDS; g++) {
      view[g].cells = lifes[g].cells;
      view[g].generation = lifes[g].generation;
    }
  }

  resize();
  syncHash();
}

// ---------------------------------------------------------------------------
// Shareable URLs: keep the location hash in sync with the (paused) boards so
// the address bar is always a link to the current composition.

function syncHash() {
  if (playing) return;
  if (totalPopulation() === 0) {
    history.replaceState(null, "", location.pathname + location.search);
  } else {
    history.replaceState(null, "", `#${currentFragment()}`);
  }
}

function currentFragment() {
  return encodeBoards(visibleLifes().map((life) => life.cells), COLS, ROWS, bpm);
}

async function sharePattern() {
  syncHash();
  const url =
    totalPopulation() === 0
      ? location.origin + location.pathname + location.search
      : `${location.origin}${location.pathname}${location.search}#${currentFragment()}`;
  let label = "Link in address bar";
  try {
    await navigator.clipboard.writeText(url);
    label = "Copied!";
  } catch {
    // Clipboard access denied; the hash is already in the address bar.
  }
  shareButton.textContent = label;
  setTimeout(() => (shareButton.textContent = "Share"), 1400);
}

/** Restore boards shared via the URL hash, centering if the grid size differs. */
function loadSharedPattern() {
  const shared = decodeFragment(location.hash);
  if (!shared) return;
  if (shared.bpm && shared.bpm >= 40 && shared.bpm <= 240) {
    bpm = shared.bpm;
    bpmSlider.value = String(bpm);
    bpmValue.textContent = String(bpm);
  }
  gridCount = Math.max(1, Math.min(MAX_GRIDS, shared.boards.length));
  const dc = Math.floor((COLS - shared.cols) / 2);
  const dr = Math.floor((ROWS - shared.rows) / 2);
  shared.boards.forEach((cells, g) => {
    if (g >= MAX_GRIDS) return;
    const life = lifes[g];
    for (let row = 0; row < shared.rows; row++) {
      const targetRow = row + dr;
      if (targetRow < 0 || targetRow >= ROWS) continue;
      for (let col = 0; col < shared.cols; col++) {
        const targetCol = col + dc;
        if (targetCol < 0 || targetCol >= COLS) continue;
        life.cells[life.index(targetCol, targetRow)] = cells[row * shared.cols + col];
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Layout / rendering: visible grids share the screen, side by side on wide
// viewports and stacked on tall ones, each scaled to fit its region.

let layouts = []; // per visible grid: { x0, y0, cellSize, rx, ry, rw, rh }
let hoverGrid = -1;
let hoverCell = -1;

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);

  const W = window.innerWidth;
  const H = window.innerHeight;
  const horizontal = W >= H;
  const gap = gridCount > 1 ? 10 : 0;
  layouts = [];
  for (let g = 0; g < gridCount; g++) {
    const rx = horizontal ? (W / gridCount) * g + gap / 2 : gap / 2;
    const ry = horizontal ? gap / 2 : (H / gridCount) * g + gap / 2;
    const rw = (horizontal ? W / gridCount : W) - gap;
    const rh = (horizontal ? H : H / gridCount) - gap;
    const cellSize = Math.min(rw / COLS, rh / ROWS);
    layouts.push({
      rx,
      ry,
      rw,
      rh,
      cellSize,
      x0: rx + (rw - cellSize * COLS) / 2,
      y0: ry + (rh - cellSize * ROWS) / 2,
    });
  }
}

function cellAt(clientX, clientY) {
  for (let g = 0; g < gridCount; g++) {
    const l = layouts[g];
    const col = Math.floor((clientX - l.x0) / l.cellSize);
    const row = Math.floor((clientY - l.y0) / l.cellSize);
    if (col >= 0 && col < COLS && row >= 0 && row < ROWS) return { g, col, row };
  }
  return null;
}

function hueOf(id) {
  return Math.floor(soundValues[id] * 360);
}

function render() {
  const now = audio.ctx ? audio.now : performance.now() / 1000;

  // Long main-thread frames feed the voice governor's stress signal.
  const frameTs = performance.now();
  if (playing && governor.lastFrameTs > 0 && frameTs - governor.lastFrameTs > 90) {
    governor.longFrames++;
  }
  governor.lastFrameTs = frameTs;
  if (audio.ctx) updateBankLabel();

  // Apply any step snapshots whose audio time has arrived.
  while (frameQueue.length > 0 && frameQueue[0].time <= now) {
    const frame = frameQueue.shift();
    const v = view[frame.g];
    v.cells = frame.cells;
    v.generation = frame.generation;
    v.lastStepTime = frame.time;
    for (const i of frame.births) bornAt[globalId(frame.g, i)] = frame.time;
    for (const i of frame.deaths) diedAt[globalId(frame.g, i)] = frame.time;
    if (frame.g === 0) updateGenerationLabel();
  }

  ctx2d.clearRect(0, 0, window.innerWidth, window.innerHeight);

  for (let g = 0; g < gridCount; g++) {
    const l = layouts[g];
    if (!l) continue;
    const v = view[g];
    const stepSec = STEP_BEATS[g] * beatDuration();

    // Step pulse: each grid glows on its own rhythm, so the polyrhythm is
    // visible as well as audible.
    let pulse = 0;
    if (playing) {
      const phase = Math.max(0, (now - v.lastStepTime) / stepSec);
      pulse = Math.max(0, 1 - phase) ** 2;
    }

    if (gridCount > 1) {
      // A faint frame and the grid's note value, so the layers read apart.
      ctx2d.strokeStyle = "rgba(255, 255, 255, 0.1)";
      ctx2d.lineWidth = 1;
      roundRect(ctx2d, l.rx + 0.5, l.ry + 0.5, l.rw - 1, l.rh - 1, 10);
      ctx2d.stroke();
      ctx2d.fillStyle = `rgba(223, 230, 243, ${0.35 + 0.4 * pulse})`;
      ctx2d.font = "14px system-ui, sans-serif";
      ctx2d.fillText(RHYTHM_GLYPHS[g], l.rx + 10, l.ry + 20);
    }

    const pad = Math.max(0.5, l.cellSize * 0.08);
    const size = l.cellSize - pad * 2;
    const radius = Math.min(6, size * 0.25);

    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const i = row * COLS + col;
        const id = globalId(g, i);
        const x = l.x0 + col * l.cellSize + pad;
        const y = l.y0 + row * l.cellSize + pad;
        const alive = v.cells[i] === 1;
        const hue = hueOf(id);
        // Percussion cells render desaturated (silver) so drums read at a glance.
        const perc = audio.kindForCell(id) === "perc";
        const sat = perc ? 10 : 85;

        if (alive) {
          if (playing && !audio.isAudible(id)) {
            // Alive but silenced by the polyphony cap: draw it diminished.
            ctx2d.fillStyle = `hsl(${hue} ${Math.round(sat * 0.2)}% 34% / 0.7)`;
            roundRect(ctx2d, x, y, size, size, radius);
            ctx2d.fill();
          } else {
            const flash = Math.min(1, Math.max(0, 1 - (now - bornAt[id]) / 0.35));
            const light = 55 + 20 * pulse + 20 * flash;
            ctx2d.fillStyle = `hsl(${hue} ${sat}% ${Math.min(light, 88)}%)`;
            roundRect(ctx2d, x, y, size, size, radius);
            ctx2d.fill();
          }
        } else {
          // Death ghost: fade out over a step instead of vanishing.
          const ghost = Math.max(0, 1 - (now - diedAt[id]) / (stepSec * 0.9));
          if (ghost > 0) {
            ctx2d.fillStyle = `hsl(${hue} ${perc ? 8 : 70}% 45% / ${0.35 * ghost})`;
            roundRect(ctx2d, x, y, size, size, radius);
            ctx2d.fill();
          }
          // Dead cells hint at their sound with a faint tinted dot.
          ctx2d.fillStyle = `hsl(${hue} ${perc ? 8 : 60}% 55% / 0.18)`;
          const dot = Math.max(1, size * 0.12);
          ctx2d.beginPath();
          ctx2d.arc(x + size / 2, y + size / 2, dot, 0, Math.PI * 2);
          ctx2d.fill();
        }

        if (g === hoverGrid && i === hoverCell) {
          ctx2d.strokeStyle = `hsl(${hue} 90% 70% / 0.9)`;
          ctx2d.lineWidth = 1.5;
          roundRect(ctx2d, x, y, size, size, radius);
          ctx2d.stroke();
        }
      }
    }
  }

  requestAnimationFrame(render);
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

// ---------------------------------------------------------------------------
// Input

let painting = false;
let paintValue = true;
let paintGrid = 0;

canvas.addEventListener("pointerdown", (e) => {
  dismissIntro();
  ensureAudio();
  const cell = cellAt(e.clientX, e.clientY);
  if (!cell) return;
  painting = true;
  paintGrid = cell.g;
  paintValue = lifes[cell.g].get(cell.col, cell.row) !== 1;
  toggleCell(cell.g, cell.col, cell.row, paintValue);
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener("pointermove", (e) => {
  const cell = cellAt(e.clientX, e.clientY);
  hoverGrid = cell ? cell.g : -1;
  hoverCell = cell ? lifes[cell.g].index(cell.col, cell.row) : -1;
  // A paint stroke stays on the grid it started on.
  if (painting && cell && cell.g === paintGrid) {
    toggleCell(cell.g, cell.col, cell.row, paintValue);
  }
});

canvas.addEventListener("pointerup", () => (painting = false));
canvas.addEventListener("pointerleave", () => {
  hoverGrid = -1;
  hoverCell = -1;
  painting = false;
});

playButton.addEventListener("click", () => {
  dismissIntro();
  togglePlay();
});
stepButton.addEventListener("click", stepOnce);
randomButton.addEventListener("click", randomizeBoard);
clearButton.addEventListener("click", clearBoard);

bpmSlider.addEventListener("input", () => {
  bpm = Number(bpmSlider.value);
  bpmValue.textContent = String(bpm);
  if (audio.ctx) audio.setFxTempo(bpm);
  syncHash();
});

shareButton.addEventListener("click", sharePattern);

for (let i = 0; i < PRESETS.length; i++) {
  const option = document.createElement("option");
  option.value = String(i);
  option.textContent = PRESETS[i].name;
  presetSelect.appendChild(option);
}

for (const [id, mode] of Object.entries(SOUND_MODES)) {
  if (mode.hidden) continue;
  const option = document.createElement("option");
  option.value = id;
  option.textContent = mode.label;
  modeSelect.appendChild(option);
}
{
  const visible = Object.keys(SOUND_MODES).filter((id) => !SOUND_MODES[id].hidden);
  const valid = visible.includes(config.soundMode) ? config.soundMode : visible[0];
  modeSelect.value = valid;
  config.soundMode = valid;
}

for (const [id, family] of Object.entries(VOICE_FAMILIES)) {
  const option = document.createElement("option");
  option.value = id;
  option.textContent = family.label;
  familySelect.appendChild(option);
}
familySelect.value = config.voiceFamily in VOICE_FAMILIES ? config.voiceFamily : "classic";
config.voiceFamily = familySelect.value;

familySelect.addEventListener("change", () => {
  // A new instrument palette, like a new mode: stop and restart deliberately.
  if (playing) pause();
  config.voiceFamily = familySelect.value;
  audio.resetRecipes();
  familySelect.blur();
});

leadButtons.forEach((button, i) => {
  button.classList.toggle("active", audio.leadsEnabled[i]);
  button.addEventListener("click", () => toggleLead(i));
});

gridButtons.forEach((button, i) => {
  button.classList.toggle("active", i + 1 === gridCount);
  button.addEventListener("click", () => setGridCount(i + 1));
});

function toggleLead(i) {
  const on = !audio.leadsEnabled[i];
  audio.setLeadEnabled(i, on);
  leadButtons[i].classList.toggle("active", on);
}

collapseButton.addEventListener("click", () => {
  const collapsed = controlsBar.classList.toggle("collapsed");
  collapseButton.innerHTML = collapsed ? "&#9652;" : "&#9662;";
  collapseButton.title = collapsed ? "Show controls" : "Hide controls";
});

for (const [name, box] of Object.entries(fxBoxes)) {
  box.checked = !!config.effects[name];
  box.addEventListener("change", () => {
    config.effects[name] = box.checked;
    // The checkbox click is a user gesture, so audio can start here too.
    ensureAudio().then(() => audio.setFxEnabled(name, box.checked));
  });
}

fxCollapse.addEventListener("click", () => {
  const collapsed = fxPanel.classList.toggle("collapsed");
  fxCollapse.innerHTML = collapsed ? "FX &#9652;" : "FX &#9662;";
  fxCollapse.title = collapsed ? "Show effects" : "Hide effects";
});

modeSelect.addEventListener("change", () => {
  // A new mode is a new tonal world: stop the music and let the user
  // restart it deliberately.
  if (playing) pause();
  config.soundMode = modeSelect.value;
  audio.resetRecipes();
  modeSelect.blur();
});

presetSelect.addEventListener("change", () => {
  const preset = PRESETS[Number(presetSelect.value)];
  if (!preset) return;
  dismissIntro();
  // Riffs stamp every visible grid: the same formation stepping at three
  // rates phases against itself.
  replaceBoards(() => {
    for (const life of visibleLifes()) {
      life.clear();
      stampPreset(life, preset);
    }
  });
  // Reset to the placeholder so the same riff can be re-picked later.
  presetSelect.value = "";
  presetSelect.blur();
});

document.getElementById("intro-dismiss").addEventListener("click", () => {
  dismissIntro();
  ensureAudio();
});

function dismissIntro() {
  intro.classList.add("hidden");
}

window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.code === "Space") {
    e.preventDefault();
    dismissIntro();
    togglePlay();
  } else if (e.key === "s" || e.key === "S") {
    stepOnce();
  } else if (e.key === "r" || e.key === "R") {
    randomizeBoard();
  } else if (e.key === "c" || e.key === "C") {
    clearBoard();
  } else if (e.key === "l") {
    toggleLead(0);
  } else if (e.key === "L") {
    toggleLead(1);
  } else if (e.key === "1" || e.key === "2" || e.key === "3") {
    setGridCount(Number(e.key));
  }
});

window.addEventListener("resize", resize);

// ---------------------------------------------------------------------------

loadSharedPattern();
gridButtons.forEach((button, i) => button.classList.toggle("active", i + 1 === gridCount));
resize();
updateGenerationLabel();
requestAnimationFrame(render);
