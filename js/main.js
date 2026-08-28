import { LifeGrid } from "./life.js";
import { AudioEngine } from "./audio.js";
import { encodeBoard, decodeFragment } from "./share.js";
import { PRESETS, stampPreset } from "./patterns.js";

const DEFAULTS = {
  audio: { files: null, baseUrl: "", manifestUrl: "sounds/manifest.json" },
  grid: { cols: 36, rows: 22 },
  bpm: 120,
  assignmentSeed: 42,
  maxVoices: 64,
};

const userConfig = window.CONWAY_MUSIC_CONFIG || {};
const config = {
  ...DEFAULTS,
  ...userConfig,
  audio: { ...DEFAULTS.audio, ...(userConfig.audio || {}) },
  grid: { ...DEFAULTS.grid, ...(userConfig.grid || {}) },
};

// ---------------------------------------------------------------------------
// State

const grid = new LifeGrid(config.grid.cols, config.grid.rows);
const audio = new AudioEngine(config);

// Each cell gets a stable value in [0, 1) from a seeded PRNG. The same value
// picks both the cell's sound (scaled to the bank size once loaded) and its
// hue, so color always corresponds to sound.
const soundValues = new Float32Array(grid.cells.length);
{
  const rng = mulberry32(config.assignmentSeed);
  for (let i = 0; i < soundValues.length; i++) soundValues[i] = rng();
}

function soundIndexOf(cellIndex) {
  const bankSize = audio.buffers.length || 1;
  return Math.floor(soundValues[cellIndex] * bankSize) % bankSize;
}

let bpm = config.bpm;
let playing = false;
let firstBeatPending = false;
let nextBeatTime = 0;
let schedulerTimer = null;

const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD = 0.12; // seconds of audio scheduled in advance

// Snapshots queued by the scheduler, applied to the display at beat time so
// visuals stay locked to the audio clock.
let beatQueue = [];
let viewCells = grid.cells;
let viewGeneration = 0;
let lastBeatVisualTime = 0;

// Per-cell timestamps (audio clock) for birth flashes and death ghosts.
const bornAt = new Float64Array(grid.cells.length).fill(-Infinity);
const diedAt = new Float64Array(grid.cells.length).fill(-Infinity);

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
    audioReady = audio.init().then(() => {
      soundbankLabel.textContent = audio.bankLabel;
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

async function togglePlay() {
  if (playing) {
    pause();
  } else {
    await play();
  }
}

async function play() {
  await ensureAudio();
  playing = true;
  firstBeatPending = true;
  nextBeatTime = audio.now + 0.08;
  beatQueue = [];
  playButton.innerHTML = "&#10074;&#10074; Pause";
  schedulerTimer = setInterval(scheduleBeats, LOOKAHEAD_MS);
}

function pause() {
  playing = false;
  clearInterval(schedulerTimer);
  schedulerTimer = null;
  beatQueue = [];
  if (audio.ctx) audio.stopAllVoices();
  viewCells = grid.cells;
  viewGeneration = grid.generation;
  playButton.innerHTML = "&#9654; Play";
  updateGenerationLabel();
  syncHash();
}

function scheduleBeats() {
  while (nextBeatTime < audio.now + SCHEDULE_AHEAD) {
    scheduleBeat(nextBeatTime);
    if (!playing) return; // an empty board auto-pauses mid-loop
    nextBeatTime += beatDuration();
  }
}

function scheduleBeat(time) {
  let births;
  let deaths = [];

  if (firstBeatPending) {
    // Generation 0: every cell of the user's starting pattern comes in.
    firstBeatPending = false;
    births = [];
    for (let i = 0; i < grid.cells.length; i++) if (grid.cells[i]) births.push(i);
  } else {
    ({ births, deaths } = grid.step());
  }

  for (const i of deaths) audio.stopVoice(i, time);
  for (const i of births) audio.startVoice(i, soundIndexOf(i), time);

  beatQueue.push({
    time,
    generation: grid.generation,
    cells: grid.cells.slice(),
    births,
    deaths,
  });

  if (grid.population === 0 && births.length === 0) pause();
}

// ---------------------------------------------------------------------------
// Editing

function toggleCell(col, row, forceAlive = null) {
  const i = grid.index(col, row);
  const wasAlive = grid.cells[i] === 1;
  const alive = forceAlive === null ? !wasAlive : forceAlive;
  if (alive === wasAlive) return;
  grid.cells[i] = alive ? 1 : 0;

  if (playing && audio.ctx) {
    // Live editing: the cell joins or leaves the music immediately.
    if (alive) audio.startVoice(i, soundIndexOf(i), audio.now);
    else audio.stopVoice(i, audio.now);
    if (viewCells !== grid.cells) viewCells[i] = alive ? 1 : 0;
    // Snapshots already queued for upcoming beats predate this edit.
    for (const frame of beatQueue) frame.cells[i] = alive ? 1 : 0;
  } else {
    // While paused, preview the cell's sound as it is painted on.
    if (alive) ensureAudio().then(() => audio.preview(soundIndexOf(i)));
    syncHash();
  }
  if (alive) bornAt[i] = audio.ctx ? audio.now : performance.now() / 1000;
}

function clearBoard() {
  if (playing) pause();
  grid.clear();
  viewCells = grid.cells;
  viewGeneration = 0;
  updateGenerationLabel();
  syncHash();
}

function randomizeBoard() {
  if (playing) pause();
  grid.randomize(0.22);
  viewCells = grid.cells;
  viewGeneration = 0;
  updateGenerationLabel();
  syncHash();
}

function stepOnce() {
  if (playing) return;
  grid.step();
  viewCells = grid.cells;
  viewGeneration = grid.generation;
  updateGenerationLabel();
  syncHash();
}

function updateGenerationLabel() {
  generationLabel.textContent = `gen ${viewGeneration}`;
}

// ---------------------------------------------------------------------------
// Shareable URLs: keep the location hash in sync with the (paused) board so
// the address bar is always a link to the current pattern.

function syncHash() {
  if (playing) return;
  if (grid.population === 0) {
    history.replaceState(null, "", location.pathname + location.search);
  } else {
    history.replaceState(null, "", `#${encodeBoard(grid, bpm)}`);
  }
}

async function sharePattern() {
  syncHash();
  const url =
    grid.population === 0
      ? location.origin + location.pathname + location.search
      : `${location.origin}${location.pathname}${location.search}#${encodeBoard(grid, bpm)}`;
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

/** Restore a pattern shared via the URL hash, centering it if the grid size differs. */
function loadSharedPattern() {
  const shared = decodeFragment(location.hash);
  if (!shared) return;
  if (shared.bpm && shared.bpm >= 40 && shared.bpm <= 240) {
    bpm = shared.bpm;
    bpmSlider.value = String(bpm);
    bpmValue.textContent = String(bpm);
  }
  const dc = Math.floor((grid.cols - shared.cols) / 2);
  const dr = Math.floor((grid.rows - shared.rows) / 2);
  for (let row = 0; row < shared.rows; row++) {
    const targetRow = row + dr;
    if (targetRow < 0 || targetRow >= grid.rows) continue;
    for (let col = 0; col < shared.cols; col++) {
      const targetCol = col + dc;
      if (targetCol < 0 || targetCol >= grid.cols) continue;
      grid.cells[grid.index(targetCol, targetRow)] = shared.cells[row * shared.cols + col];
    }
  }
}

// ---------------------------------------------------------------------------
// Layout / rendering

let cellSize = 0;
let offsetX = 0;
let offsetY = 0;
let hoverCell = -1;

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);

  cellSize = Math.min(window.innerWidth / grid.cols, window.innerHeight / grid.rows);
  offsetX = (window.innerWidth - cellSize * grid.cols) / 2;
  offsetY = (window.innerHeight - cellSize * grid.rows) / 2;
}

function cellAt(clientX, clientY) {
  const col = Math.floor((clientX - offsetX) / cellSize);
  const row = Math.floor((clientY - offsetY) / cellSize);
  if (col < 0 || col >= grid.cols || row < 0 || row >= grid.rows) return null;
  return { col, row };
}

function hueOf(cellIndex) {
  return Math.floor(soundValues[cellIndex] * 360);
}

function render() {
  const now = audio.ctx ? audio.now : performance.now() / 1000;

  // Apply any beat snapshots whose audio time has arrived.
  while (beatQueue.length > 0 && beatQueue[0].time <= now) {
    const frame = beatQueue.shift();
    viewCells = frame.cells;
    viewGeneration = frame.generation;
    lastBeatVisualTime = frame.time;
    for (const i of frame.births) bornAt[i] = frame.time;
    for (const i of frame.deaths) diedAt[i] = frame.time;
    updateGenerationLabel();
  }

  const w = window.innerWidth;
  const h = window.innerHeight;
  ctx2d.clearRect(0, 0, w, h);

  // Beat pulse: everything glows a touch brighter right on the beat.
  let pulse = 0;
  if (playing) {
    const phase = Math.max(0, (now - lastBeatVisualTime) / beatDuration());
    pulse = Math.max(0, 1 - phase) ** 2;
  }

  const pad = Math.max(1, cellSize * 0.08);
  const size = cellSize - pad * 2;
  const radius = Math.min(6, size * 0.25);

  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      const i = row * grid.cols + col;
      const x = offsetX + col * cellSize + pad;
      const y = offsetY + row * cellSize + pad;
      const alive = viewCells[i] === 1;
      const hue = hueOf(i);

      if (alive) {
        const flash = Math.min(1, Math.max(0, 1 - (now - bornAt[i]) / 0.35));
        const light = 55 + 20 * pulse + 20 * flash;
        ctx2d.fillStyle = `hsl(${hue} 85% ${Math.min(light, 88)}%)`;
        roundRect(ctx2d, x, y, size, size, radius);
        ctx2d.fill();
      } else {
        // Death ghost: fade out over a beat instead of vanishing.
        const ghost = Math.max(0, 1 - (now - diedAt[i]) / (beatDuration() * 0.9));
        if (ghost > 0) {
          ctx2d.fillStyle = `hsl(${hue} 70% 45% / ${0.35 * ghost})`;
          roundRect(ctx2d, x, y, size, size, radius);
          ctx2d.fill();
        }
        // Dead cells hint at their sound with a faint tinted dot.
        ctx2d.fillStyle = `hsl(${hue} 60% 55% / 0.18)`;
        const dot = Math.max(1.5, size * 0.12);
        ctx2d.beginPath();
        ctx2d.arc(x + size / 2, y + size / 2, dot, 0, Math.PI * 2);
        ctx2d.fill();
      }

      if (i === hoverCell) {
        ctx2d.strokeStyle = `hsl(${hue} 90% 70% / 0.9)`;
        ctx2d.lineWidth = 1.5;
        roundRect(ctx2d, x, y, size, size, radius);
        ctx2d.stroke();
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

canvas.addEventListener("pointerdown", (e) => {
  dismissIntro();
  ensureAudio();
  const cell = cellAt(e.clientX, e.clientY);
  if (!cell) return;
  painting = true;
  paintValue = grid.get(cell.col, cell.row) !== 1;
  toggleCell(cell.col, cell.row, paintValue);
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener("pointermove", (e) => {
  const cell = cellAt(e.clientX, e.clientY);
  hoverCell = cell ? grid.index(cell.col, cell.row) : -1;
  if (painting && cell) toggleCell(cell.col, cell.row, paintValue);
});

canvas.addEventListener("pointerup", () => (painting = false));
canvas.addEventListener("pointerleave", () => {
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
  syncHash();
});

shareButton.addEventListener("click", sharePattern);

for (let i = 0; i < PRESETS.length; i++) {
  const option = document.createElement("option");
  option.value = String(i);
  option.textContent = PRESETS[i].name;
  presetSelect.appendChild(option);
}

presetSelect.addEventListener("change", () => {
  const preset = PRESETS[Number(presetSelect.value)];
  if (!preset) return;
  dismissIntro();
  if (playing) pause();
  grid.clear();
  stampPreset(grid, preset);
  viewCells = grid.cells;
  viewGeneration = 0;
  updateGenerationLabel();
  syncHash();
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
  }
});

window.addEventListener("resize", resize);

// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

loadSharedPattern();
resize();
updateGenerationLabel();
requestAnimationFrame(render);
