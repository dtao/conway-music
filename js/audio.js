// Audio engine. Two modes:
//
// - File mode: the developer configured audio files (explicit list or JSON
//   manifest); cells map onto the loaded buffers.
//
// - Parametric synth mode (the zero-setup fallback): every cell gets its own
//   synthesis recipe, deterministically derived from the assignment seed, so
//   no two cells sound alike. A recipe picks a category (melodic figure,
//   composed sequence from config.sequences, or percussion), a voice, pitch
//   material on the A natural minor scale, a rhythm, and continuous timbre
//   parameters (string damping, FM ratio, pulse width, envelope speeds, a few
//   cents of detune, and a unique noise seed). Buffers are rendered lazily on
//   a cell's first birth and kept in a capped cache; a tempo change clears
//   the cache so every figure re-renders to fit the new beat.
//
// With config.geographic enabled, position shapes the recipe: row picks the
// register and voice family (low sustained voices at the bottom, bright ones
// at the top), percussion gathers in the bottom rows, and the scale degree
// follows the column so horizontal motion reads as melodic motion.

const ATTACK = 0.008;
const RELEASE = 0.05;
const VOICE_GAIN = 0.28;
const MAX_CACHED_BUFFERS = 256;

export class AudioEngine {
  constructor(config, cellValues) {
    this.config = config;
    this.cellValues = cellValues; // per-cell [0,1) values (hue + file mapping)
    this.cellCount = config.grid.cols * config.grid.rows;
    this.ctx = null;
    this.master = null;
    this.bankLabel = "";
    this.voices = new Map(); // cell index -> { source, gain, startedAt }
    this.maxVoices = config.maxVoices || 64;
    this.fileBuffers = null; // non-null => file mode
    this.recipes = new Map(); // cell index -> recipe (synth mode)
    this.bufferCache = new Map(); // cell index -> rendered AudioBuffer
    this._synthBpm = null; // non-null => parametric synth mode
    const leads = Array.isArray(config.leads) ? config.leads : [true, false];
    this.leadsEnabled = [!!leads[0], !!leads[1]];
    this._leads = [null, null];
    this._leadState = { notes: [], pops: [] };
  }

  /** Must be called from a user gesture (browsers gate audio on one). */
  async init(bpm = 120) {
    if (this.ctx) {
      if (this.ctx.state === "suspended") await this.ctx.resume();
      return;
    }
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();

    // A compressor keeps a crowded board from clipping.
    const compressor = this.ctx.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 20;
    compressor.ratio.value = 8;
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(compressor);
    compressor.connect(this.ctx.destination);

    await this._loadBank(bpm);
  }

  get now() {
    return this.ctx.currentTime;
  }

  get usesSynthBank() {
    return this._synthBpm !== null;
  }

  /**
   * Synth buffers are rendered to fit whole beats, so a tempo change
   * invalidates them. Call while no looping voices are active (i.e. before
   * starting playback); recipes are untouched, so every cell keeps its
   * sound identity.
   */
  rebuildSynthBank(bpm) {
    if (!this.usesSynthBank || this._synthBpm === bpm) return;
    this.bufferCache.clear();
    this._synthBpm = bpm;
  }

  /**
   * Forget all recipes and rendered buffers so the next playback derives
   * them fresh (used when the sound mode changes). Call while paused.
   */
  resetRecipes() {
    this.recipes.clear();
    this.bufferCache.clear();
  }

  setLeadEnabled(index, on) {
    this.leadsEnabled[index] = on;
    if (!on) this._killLead(index);
  }

  _killLead(index) {
    if (!this._leads[index]) return;
    this._leads[index].stop(this.ctx ? this.now : 0);
    this._leads[index] = null;
  }

  /**
   * Per-beat conductor for the lead overlays. Computes the shared rolling
   * consensus of what the board is sounding, classifies the population
   * trend (the deterministic, grid-state-driven harmony selector: stable
   * boards sing the consensus note, growing ones the third above,
   * shrinking ones the sixth), and drives each enabled voice. When both
   * are on, lead 2 always takes the next interval in the cycle, so the
   * voices harmonize rather than double each other. Synth mode only
   * (file buffers carry no pitch data).
   */
  overlayBeat(time, bpm, population) {
    if (!this.ctx || !this.usesSynthBank) return;
    if (!this.leadsEnabled[0] && !this.leadsEnabled[1]) {
      this._killLead(0);
      this._killLead(1);
      return;
    }

    const beat = 60 / bpm;
    const cutoff = time - LEAD_WINDOW_BEATS * beat;
    const state = this._leadState;

    const semitones = [];
    for (const cellIndex of this.voices.keys()) {
      const recipe = this.recipeFor(cellIndex);
      for (const s of recipeSemitones(recipe)) semitones.push(s);
    }
    state.notes.push({ time, semitones });
    state.notes = state.notes.filter((h) => h.time > cutoff);
    state.pops.push({ time, population });
    state.pops = state.pops.filter((h) => h.time > cutoff);

    // Recency-weighted rolling average of everything in the window.
    const tau = LEAD_TAU_BEATS * beat;
    let sum = 0;
    let weight = 0;
    for (const h of state.notes) {
      const w = Math.exp(-(time - h.time) / tau);
      for (const s of h.semitones) {
        sum += w * s;
        weight += w;
      }
    }
    const consensus = weight > 0 ? sum / weight : null;

    // Population trend picks the harmony interval (with hysteresis bands
    // so it doesn't flap beat to beat).
    const popAvg = state.pops.reduce((s, h) => s + h.population, 0) / state.pops.length;
    let trend = 0; // stable -> sing the consensus note
    if (population > popAvg * 1.05) trend = 1; // growing -> the third
    else if (population < popAvg * 0.95) trend = 2; // shrinking -> the sixth

    const activity = Math.min(1, semitones.length / 10);
    const mode = SOUND_MODES[this.config.soundMode] || SOUND_MODES.minor;

    for (let i = 0; i < 2; i++) {
      if (!this.leadsEnabled[i]) {
        this._killLead(i);
        continue;
      }
      const profile = LEAD_PROFILES[i];
      if (!this._leads[i]) this._leads[i] = new LeadOverlay(this.ctx, this.master, profile);

      let hz = null;
      if (consensus !== null) {
        // Lead 2 complements lead 1 by taking the next interval in the
        // cycle whenever both voices are singing.
        const intervalIndex =
          i === 1 && this.leadsEnabled[0] ? (trend + 1) % LEAD_INTERVALS.length : trend;
        let folded = consensus;
        while (folded < profile.register[0]) folded += 12;
        while (folded > profile.register[1]) folded -= 12;
        const semi = nearestModeSemitone(
          folded + LEAD_INTERVALS[intervalIndex], mode, profile.octaves);
        hz = ROOT_HZ * Math.pow(2, semi / 12);
      }
      this._leads[i].update(time, hz, activity, beat);
    }
  }

  async _loadBank(bpm) {
    const audio = this.config.audio || {};

    let urls = null;
    if (Array.isArray(audio.files) && audio.files.length > 0) {
      const base = audio.baseUrl || "";
      urls = audio.files.map((f) => new URL(f, new URL(base || ".", location.href)).href);
      this.bankLabel = "configured files";
    } else if (audio.manifestUrl) {
      urls = await this._fetchManifest(audio.manifestUrl);
      this.bankLabel = "manifest";
    }

    if (urls && urls.length > 0) {
      const buffers = await Promise.all(urls.map((u) => this._fetchBuffer(u)));
      const loaded = buffers.filter(Boolean);
      if (loaded.length > 0) {
        this.fileBuffers = loaded;
        this.bankLabel += ` (${loaded.length} sounds)`;
        return;
      }
      console.warn("Conway Music: no configured audio could be loaded; using synth.");
    }

    this._synthBpm = bpm;
    this.bankLabel = `parametric synth (${this.cellCount} unique cells)`;
  }

  async _fetchManifest(url) {
    try {
      const res = await fetch(url, { cache: "no-cache" });
      if (!res.ok) return null;
      const json = await res.json();
      const files = Array.isArray(json) ? json : json && json.files;
      if (!Array.isArray(files)) return null;
      const manifestBase = new URL(url, location.href);
      return files.map((f) => new URL(f, manifestBase).href);
    } catch {
      return null;
    }
  }

  async _fetchBuffer(url) {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = await res.arrayBuffer();
      return await this.ctx.decodeAudioData(data);
    } catch {
      console.warn(`Conway Music: could not load/decode ${url}`);
      return null;
    }
  }

  recipeFor(cellIndex) {
    let recipe = this.recipes.get(cellIndex);
    if (!recipe) {
      recipe = makeRecipe(cellIndex, this.config);
      this.recipes.set(cellIndex, recipe);
    }
    return recipe;
  }

  /**
   * The cell's sound category ("perc", "melodic", "seq", or "file"), for
   * rendering hints. Null until the bank mode is known (pre-init).
   */
  kindForCell(cellIndex) {
    if (this.fileBuffers) return "file";
    if (!this.usesSynthBank) return null;
    return this.recipeFor(cellIndex).type;
  }

  bufferForCell(cellIndex) {
    if (this.fileBuffers) {
      const i = Math.floor(this.cellValues[cellIndex] * this.fileBuffers.length);
      return this.fileBuffers[i % this.fileBuffers.length];
    }
    let buffer = this.bufferCache.get(cellIndex);
    if (!buffer) {
      buffer = renderRecipe(this.ctx, this.recipeFor(cellIndex), this._synthBpm);
      this._cacheBuffer(cellIndex, buffer);
    }
    return buffer;
  }

  _cacheBuffer(cellIndex, buffer) {
    if (this.bufferCache.size >= MAX_CACHED_BUFFERS) {
      // Evict the oldest cached buffer that isn't currently sounding.
      for (const key of this.bufferCache.keys()) {
        if (!this.voices.has(key)) {
          this.bufferCache.delete(key);
          break;
        }
      }
    }
    this.bufferCache.set(cellIndex, buffer);
  }

  /**
   * The cell's stereo position: its column, mapped across the field, so the
   * sound sits where the cell sits and travelers move through the mix.
   */
  _panForCell(cellIndex) {
    const cols = this.config.grid.cols;
    if (cols < 2) return 0;
    return ((cellIndex % cols) / (cols - 1) * 2 - 1) * 0.8;
  }

  _gainForCell(cellIndex) {
    const trim = this.usesSynthBank ? this.recipeFor(cellIndex).gainTrim : 1;
    return VOICE_GAIN * trim;
  }

  /** gain -> (panner) -> master; returns the node to feed and a cleanup. */
  _buildVoiceChain(cellIndex, gain) {
    if (typeof this.ctx.createStereoPanner !== "function") {
      gain.connect(this.master);
      return () => gain.disconnect();
    }
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = this._panForCell(cellIndex);
    gain.connect(panner);
    panner.connect(this.master);
    return () => {
      gain.disconnect();
      panner.disconnect();
    };
  }

  /** Start a cell's looping voice at audio-clock time `when`. */
  startVoice(cellIndex, when) {
    if (this.voices.has(cellIndex)) return;
    if (this.voices.size >= this.maxVoices) this._stealOldestVoice(when);

    const buffer = this.bufferForCell(cellIndex);
    if (!buffer) return;

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(this._gainForCell(cellIndex), when + ATTACK);

    source.connect(gain);
    const cleanup = this._buildVoiceChain(cellIndex, gain);
    source.start(when);

    this.voices.set(cellIndex, { source, gain, cleanup, startedAt: when });
  }

  /** Stop a cell's voice at audio-clock time `when` (short fade, no click). */
  stopVoice(cellIndex, when) {
    const voice = this.voices.get(cellIndex);
    if (!voice) return;
    this.voices.delete(cellIndex);
    this._fadeOut(voice, when);
  }

  stopAllVoices(when = this.now) {
    for (const voice of this.voices.values()) this._fadeOut(voice, when);
    this.voices.clear();
    this._killLead(0);
    this._killLead(1);
  }

  _fadeOut(voice, when) {
    const t = Math.max(when, this.now);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, t);
    voice.gain.gain.linearRampToValueAtTime(0, t + RELEASE);
    voice.source.stop(t + RELEASE + 0.01);
    voice.source.onended = voice.cleanup;
  }

  _stealOldestVoice(when) {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [key, voice] of this.voices) {
      if (voice.startedAt < oldestTime) {
        oldestTime = voice.startedAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) this.stopVoice(oldestKey, when);
  }

  /** One-shot (non-looping) playback, used to preview a cell's sound. */
  preview(cellIndex) {
    const buffer = this.bufferForCell(cellIndex);
    if (!buffer) return;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    const gain = this.ctx.createGain();
    gain.gain.value = this._gainForCell(cellIndex);
    source.connect(gain);
    const cleanup = this._buildVoiceChain(cellIndex, gain);
    source.start();
    source.onended = cleanup;
  }
}

// ---------------------------------------------------------------------------
// Lead overlay: a monophonic sustained voice above the grid. Each beat it
// samples the notes the board is currently playing, keeps a rolling
// recency-weighted average, folds that average into a soloist's register,
// snaps it to the current mode's note pool, and glides there. Its volume
// (and its brightness — the filter opens as it gets louder) tracks board
// activity through slow ramps, so it swells and fades like a bowed or blown
// instrument rather than switching on and off.

const LEAD_WINDOW_BEATS = 8; // rolling window the average listens to
const LEAD_TAU_BEATS = 3; // recency half-life-ish decay inside the window

// Harmony intervals in semitones above the consensus note (snapped to the
// mode afterwards, which resolves each to the scale-correct interval):
// match, a third up, a sixth up. Which one a voice sings is chosen
// deterministically by the board's population trend — see overlayBeat.
const LEAD_INTERVALS = [0, 3.5, 8.5];

// Voice personalities. Lead 1 is a clarinet-ish soloist (odd harmonics);
// lead 2 is a warmer cello-ish voice an octave below, slower to swell,
// panned to the other side.
const LEAD_PROFILES = [
  {
    harmonics: [0, 1, 0, 0.4, 0, 0.25, 0, 0.12, 0, 0.06],
    vibratoRate: 5.3,
    vibratoDepth: 8,
    octaves: [2, 3],
    register: [24, 45], // ~A4 to ~E6
    level: 0.22,
    filterBase: 500,
    filterSpan: 2800,
    swell: 0.7,
    pan: 0.18,
  },
  {
    harmonics: [0, 1, 0.55, 0.3, 0.18, 0.12, 0.07],
    vibratoRate: 4.5,
    vibratoDepth: 6,
    octaves: [1, 2],
    register: [12, 33], // ~A3 to ~E5
    level: 0.2,
    filterBase: 350,
    filterSpan: 1600,
    swell: 1.0,
    pan: -0.18,
  },
];

class LeadOverlay {
  constructor(ctx, master, profile) {
    this.ctx = ctx;
    this.profile = profile;
    this.freq = null;

    const real = new Float32Array(profile.harmonics.length);
    const imag = new Float32Array(profile.harmonics);
    this.osc = ctx.createOscillator();
    this.osc.setPeriodicWave(ctx.createPeriodicWave(real, imag));
    this.osc.frequency.value = 440;

    this.filter = ctx.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.value = profile.filterBase;
    this.filter.Q.value = 1.1;

    this.gain = ctx.createGain();
    this.gain.gain.value = 0;

    // Gentle vibrato on the oscillator's detune (in cents).
    this.vibrato = ctx.createOscillator();
    this.vibrato.frequency.value = profile.vibratoRate;
    this.vibratoGain = ctx.createGain();
    this.vibratoGain.gain.value = profile.vibratoDepth;
    this.vibrato.connect(this.vibratoGain);
    this.vibratoGain.connect(this.osc.detune);

    this.osc.connect(this.filter);
    this.filter.connect(this.gain);
    let tail = this.gain;
    if (typeof ctx.createStereoPanner === "function") {
      this.panner = ctx.createStereoPanner();
      this.panner.pan.value = profile.pan;
      this.gain.connect(this.panner);
      tail = this.panner;
    }
    tail.connect(master);
    this.osc.start();
    this.vibrato.start();
  }

  /** Swell toward the activity level and glide to the target pitch. */
  update(time, hz, activity, beat) {
    const p = this.profile;
    this.gain.gain.setTargetAtTime(p.level * Math.sqrt(activity), time, p.swell);
    this.filter.frequency.setTargetAtTime(
      p.filterBase + p.filterSpan * Math.sqrt(activity), time, p.swell);

    if (hz === null) return; // silent board: hold the pitch, fade out

    if (this.freq === null) {
      this.osc.frequency.setValueAtTime(hz, time);
      this.freq = hz;
    } else if (Math.abs(hz - this.freq) > 0.5) {
      // Portamento to the new note.
      this.osc.frequency.cancelScheduledValues(time);
      this.osc.frequency.setValueAtTime(this.freq, time);
      this.osc.frequency.exponentialRampToValueAtTime(hz, time + Math.min(0.35, beat * 0.8));
      this.freq = hz;
    }
  }

  stop(when) {
    this.gain.gain.cancelScheduledValues(when);
    this.gain.gain.setTargetAtTime(0, when, 0.12);
    this.osc.stop(when + 1);
    this.vibrato.stop(when + 1);
  }
}

/** Snap a raw semitone value to the nearest note the mode allows in the given octaves. */
function nearestModeSemitone(target, mode, octaves) {
  let best = octaves[0] * 12;
  let bestDistance = Infinity;
  for (let octave = octaves[0]; octave <= octaves[1]; octave++) {
    for (const note of mode.notes) {
      if (note.octaves && (octave < note.octaves[0] || octave > note.octaves[1])) continue;
      const semi = octave * 12 + SCALE[note.degree];
      const distance = Math.abs(semi - target);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = semi;
      }
    }
  }
  return best;
}

/** Absolute scale degree -> semitones above the root. */
function semitoneOf(n) {
  const octave = Math.floor(n / DEGREES);
  const degree = ((n % DEGREES) + DEGREES) % DEGREES;
  return octave * 12 + SCALE[degree];
}

/** The semitones a recipe sounds (memoized on the recipe; percussion: none). */
function recipeSemitones(recipe) {
  if (recipe._semitones) return recipe._semitones;
  let semis = [];
  if (recipe.type === "melodic") {
    semis = recipe.degrees.map(semitoneOf);
  } else if (recipe.type === "seq") {
    semis = parseSequence(recipe.seq).notes.map((n) =>
      semitoneOf(n.degree + recipe.octaveShift * DEGREES));
  }
  recipe._semitones = semis;
  return semis;
}

// ---------------------------------------------------------------------------
// Recipes: a cell's deterministic synthesis parameters. Pure data — no
// AudioContext involved — so they're cheap, testable, and stable across
// tempo changes.

const SCALE = [0, 2, 3, 5, 7, 8, 10]; // A natural minor: A B C D E F G
const ROOT_HZ = 110; // A2
const DEGREES = SCALE.length;

// Sound modes: each mode is a weighted pool of scale degrees (0=A 1=B 2=C
// 3=D 4=E 5=F 6=G) that melodic material draws from, plus the composed
// sequences it uses ("config" = the config.js sequences). `octaves`
// restricts a note to a register. Add a mode here and it appears in the UI.
export const SOUND_MODES = {
  minor: {
    label: "A minor field",
    notes: [0, 1, 2, 3, 4, 5, 6].map((degree) => ({ degree, weight: 1 })),
    sequences: "config",
  },
  cmajor: {
    label: "C major triads",
    notes: [
      { degree: 2, weight: 6 }, // C
      { degree: 4, weight: 6 }, // E
      { degree: 6, weight: 6 }, // G
      { degree: 3, weight: 1 }, // D, sparse
      { degree: 0, weight: 1 }, // A, sparse
      { degree: 1, weight: 2, octaves: [2, 3] }, // B, high registers only
      // F sits out of this mode entirely.
    ],
    sequences: [
      { voice: "pluck", seq: "3-5-7---" }, // C E G rise
      { voice: "pluck", seq: "7-5-3---" }, // G E C fall
      { voice: "pluck", seq: "3-5-7-'3-" }, // run up to high C
      { voice: "muted", seq: "3--7--5-" }, // C G E tresillo
      { voice: "bell", seq: "3--57--5" },
      { voice: "bell", seq: "'2-'3-----" }, // high B resolving to C
      { voice: "chip", seq: "3.5.7.5." },
      { voice: "pad", seq: "3---5---7-------" },
      { voice: "pluck", seq: "3-4-5---" }, // passing D
      { voice: "pluck", seq: "5-3-1---" }, // E C A
    ],
  },
};

/**
 * Weighted note pick from a mode's pool for a given octave (0-3). When
 * `col` is given (geographic mode), the column indexes the pool's degrees
 * in scale order instead, so left-to-right stays melodic.
 */
function pickNote(rng, mode, octave, col = null) {
  const pool = mode.notes.filter(
    (n) => !n.octaves || (octave >= n.octaves[0] && octave <= n.octaves[1])
  );
  const usable = pool.length > 0 ? pool : mode.notes;
  if (col !== null) {
    const sorted = [...usable].sort((a, b) => a.degree - b.degree);
    return octave * DEGREES + sorted[col % sorted.length].degree;
  }
  const total = usable.reduce((sum, n) => sum + n.weight, 0);
  let r = rng() * total;
  for (const n of usable) {
    r -= n.weight;
    if (r <= 0) return octave * DEGREES + n.degree;
  }
  return octave * DEGREES + usable[usable.length - 1].degree;
}

const MELODIC_RHYTHMS = ["1000", "1010", "1001", "1100", "0110"];
const PERC_RHYTHMS = ["1000", "1010", "1001", "1100", "0110", "0010", "1111"];
const PERC_INSTRUMENTS = [
  ["kick", 1.0], ["snare", 0.8], ["hat", 0.45],
  ["shaker", 0.35], ["block", 0.6], ["tom", 0.85],
];
const VOICE_PEAKS = { pluck: 0.9, muted: 0.7, bell: 0.75, pad: 0.6, chip: 0.55 };
const VOICE_POOL = ["pluck", "pluck", "muted", "bell", "bell", "pad", "chip"];

// Geographic row bands, bottom to top: [voice choices, octave]
const GEO_BANDS = [
  [["pad", "muted"], 0],
  [["pluck", "muted"], 1],
  [["pluck", "bell"], 2],
  [["bell", "chip"], 3],
];

export function makeRecipe(cellIndex, config) {
  const rng = mulberry32((config.assignmentSeed * 0x9e3779b9) ^ (cellIndex * 0x85ebca6b));
  const mode = SOUND_MODES[config.soundMode] || SOUND_MODES.minor;
  const geo = !!config.geographic;
  const cols = config.grid.cols;
  const rows = config.grid.rows;
  const row = Math.floor(cellIndex / cols);
  const col = cellIndex % cols;
  const height = rows > 1 ? 1 - row / (rows - 1) : 0.5; // 0 bottom, 1 top
  const band = GEO_BANDS[Math.min(3, Math.floor(height * 4))];
  const sequences = mode.sequences === "config" ? config.sequences || [] : mode.sequences;

  const noiseSeed = Math.floor(rng() * 0x7fffffff);
  const detune = Math.pow(2, ((rng() * 2 - 1) * 10) / 1200); // ±10 cents
  const gainTrim = 0.85 + rng() * 0.3; // ±~1.4 dB of per-cell level variation

  // Category: percussion gathers in the bottom rows when geographic.
  const percProb = geo ? (row >= rows - 2 ? 0.5 : 0.02) : 0.1;
  const seqProb = sequences.length > 0 ? 0.15 : 0;
  const roll = rng();

  if (roll < percProb) {
    const [instrument, peak] = PERC_INSTRUMENTS[Math.floor(rng() * PERC_INSTRUMENTS.length)];
    return {
      type: "perc",
      instrument,
      rhythm: PERC_RHYTHMS[Math.floor(rng() * PERC_RHYTHMS.length)],
      pitch: 0.8 + rng() * 0.5,
      decay: 0.8 + rng() * 0.5,
      peak,
      noiseSeed,
      gainTrim,
    };
  }

  if (roll < percProb + seqProb) {
    const entry = sequences[Math.floor(rng() * sequences.length)];
    const octaveShift = geo
      ? Math.max(-1, Math.min(1, band[1] - 1))
      : [-1, 0, 0, 1][Math.floor(rng() * 4)];
    const voice = entry.voice in VOICE_PEAKS ? entry.voice : "pluck";
    return {
      type: "seq",
      voice,
      seq: entry.seq,
      octaveShift,
      detune,
      timbre: makeTimbre(voice, rng),
      peak: VOICE_PEAKS[voice],
      noiseSeed,
      gainTrim,
    };
  }

  // Melodic figure: a single note or a two-note duet, both notes drawn
  // from the mode's weighted pool (a repeated draw makes a repeated-note
  // figure, which is fine music).
  const voice = geo
    ? band[0][Math.floor(rng() * band[0].length)]
    : VOICE_POOL[Math.floor(rng() * VOICE_POOL.length)];
  const octave = geo ? band[1] : Math.floor(rng() * 4);
  const base = pickNote(rng, mode, octave, geo ? col : null);
  const isDuet = rng() < 0.5;
  const rhythm = isDuet
    ? MELODIC_RHYTHMS[1 + Math.floor(rng() * (MELODIC_RHYTHMS.length - 1))]
    : "1000";
  return {
    type: "melodic",
    voice,
    degrees: isDuet ? [base, pickNote(rng, mode, octave)] : [base],
    rhythm,
    detune,
    timbre: makeTimbre(voice, rng),
    peak: VOICE_PEAKS[voice],
    noiseSeed,
    gainTrim,
  };
}

/** Continuous per-cell timbre parameters for a melodic voice. */
function makeTimbre(voice, rng) {
  switch (voice) {
    case "pluck":
      return { damping: 0.994 + rng() * 0.004, smooth: 1 };
    case "muted":
      return { damping: 0.988 + rng() * 0.006, smooth: 2 + Math.floor(rng() * 3) };
    case "bell":
      return { ratio: 2.5 + rng() * 2, index: 2 + rng() * 4, decayFrac: 0.25 + rng() * 0.2 };
    case "pad":
      return {
        harmonics: [1, 0.2 + rng() * 0.5, 0.05 + rng() * 0.3, 0.02 + rng() * 0.15],
        attackFrac: 0.1 + rng() * 0.2,
        releaseFrac: 0.15 + rng() * 0.2,
      };
    case "chip":
      return { width: 0.15 + rng() * 0.35, decayFrac: 0.3 + rng() * 0.3 };
    default:
      return {};
  }
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Rendering: recipe -> AudioBuffer at a given tempo.

/** Frequency of the nth scale degree above (or below) the root. */
function degreeHz(n) {
  const octave = Math.floor(n / DEGREES);
  const degree = ((n % DEGREES) + DEGREES) % DEGREES;
  return ROOT_HZ * Math.pow(2, octave + SCALE[degree] / 12);
}

const MELODIC_VOICES = { pluck, muted: pluck, bell, pad, chip };
const PERC_VOICES = { kick, snare, hat, shaker, block, tom };

function renderRecipe(ctx, recipe, bpm) {
  const beat = 60 / bpm;
  const sampleRate = ctx.sampleRate;
  const rng = mulberry32(recipe.noiseSeed);

  let beats = 1;
  let notes;
  if (recipe.type === "seq") {
    const parsed = parseSequence(recipe.seq);
    beats = parsed.beats;
    notes = parsed.notes.map((n) => ({ ...n, degree: n.degree + recipe.octaveShift * DEGREES }));
  } else if (recipe.type === "melodic") {
    notes = parseRhythm(recipe.rhythm).map((n, i) => ({
      ...n,
      degree: recipe.degrees[Math.min(i, recipe.degrees.length - 1)],
    }));
  } else {
    notes = parseRhythm(recipe.rhythm);
  }

  const length = Math.max(1, Math.round(sampleRate * beat * beats));
  const buffer = ctx.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);

  if (recipe.type === "perc") {
    const render = PERC_VOICES[recipe.instrument];
    for (const note of notes) render(data, sampleRate, note.onset * beat, recipe, rng);
  } else {
    const render = MELODIC_VOICES[recipe.voice] || pluck;
    for (const note of notes) {
      render(
        data, sampleRate, note.onset * beat,
        degreeHz(note.degree) * recipe.detune, note.dur * beat,
        recipe.timbre, rng
      );
    }
  }

  normalize(data, recipe.peak);
  edgeFade(data, sampleRate);
  return buffer;
}

// ---- notation parsers -----------------------------------------------------

/**
 * Parse "1010"-style rhythm notation into note onsets/durations as
 * fractions of a beat: each "1" starts a note that sustains until the next
 * "1" or the end of the beat; leading "0"s are rest.
 */
function parseRhythm(pattern) {
  const notes = [];
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== "1") continue;
    const onset = i / pattern.length;
    if (notes.length > 0) notes[notes.length - 1].dur = onset - notes[notes.length - 1].onset;
    notes.push({ onset, dur: 1 - onset });
  }
  return notes;
}

/**
 * Parse melodic sequence notation: one character per sixteenth, where
 * "1"-"7" starts a note on that scale degree, "-" sustains it, and "."
 * rests. "'" / "," (which take no grid time) raise / lower the next note
 * by an octave. Four sixteenths per beat, any length: "3-2-1---" is a
 * two-beat C-B-A figure. Returns { notes: [{onset, dur, degree}], beats }
 * with onset/dur measured in beats and degree as an absolute scale index.
 */
function parseSequence(seq) {
  const notes = [];
  let slots = 0;
  let octaveShift = 0;
  const close = () => {
    const open = notes[notes.length - 1];
    if (open && open.dur === null) open.dur = slots / 4 - open.onset;
  };
  for (const ch of seq) {
    if (ch === "'") octaveShift++;
    else if (ch === ",") octaveShift--;
    else if (ch >= "1" && ch <= "7") {
      close();
      // Degree 1 sits one octave above the bank root, a melody register.
      notes.push({
        onset: slots / 4,
        dur: null,
        degree: (1 + octaveShift) * DEGREES + (ch.charCodeAt(0) - 49),
      });
      octaveShift = 0;
      slots++;
    } else if (ch === "-") slots++;
    else if (ch === ".") {
      close();
      slots++;
    }
    // Anything else (whitespace, etc.) is ignored.
  }
  close();
  return { notes, beats: Math.max(1, Math.ceil(slots / 4)) };
}

// ---- melodic voices -------------------------------------------------------
// Each renderer mixes a note into `data` starting at `startSeconds`.

/** Karplus–Strong: white noise through a decaying averaging delay line. */
function pluck(data, sr, startSeconds, freq, dur, timbre, rng) {
  const damping = timbre.damping ?? 0.996;
  const smooth = timbre.smooth ?? 1;
  const start = Math.floor(startSeconds * sr);
  const length = Math.min(Math.floor(dur * sr), data.length - start);
  const period = Math.max(2, Math.round(sr / freq));
  const delay = new Float32Array(period);
  for (let i = 0; i < period; i++) delay[i] = rng() * 2 - 1;
  // Pre-smoothing dulls the attack for muted variants.
  for (let s = 0; s < smooth - 1; s++) {
    for (let i = 0; i < period; i++) {
      delay[i] = 0.5 * (delay[i] + delay[(i + 1) % period]);
    }
  }
  let idx = 0;
  for (let i = 0; i < length; i++) {
    const current = delay[idx];
    delay[idx] = damping * 0.5 * (current + delay[(idx + 1) % period]);
    data[start + i] += current * boundaryCut(i / sr, length / sr);
    idx = (idx + 1) % period;
  }
}

/** Two-operator FM bell with a decaying modulation index. */
function bell(data, sr, startSeconds, freq, dur, timbre) {
  const ratio = timbre.ratio ?? 3.01;
  const index0 = timbre.index ?? 3.5;
  const tau = dur * (timbre.decayFrac ?? 0.33);
  const start = Math.floor(startSeconds * sr);
  const length = Math.min(Math.floor(dur * sr), data.length - start);
  for (let i = 0; i < length; i++) {
    const t = i / sr;
    const index = index0 * Math.exp(-t / (dur / 5));
    const mod = index * Math.sin(2 * Math.PI * freq * ratio * t);
    data[start + i] += Math.sin(2 * Math.PI * freq * t + mod) * Math.exp(-t / tau);
  }
}

/** Soft additive pad: a few harmonics under a slow attack/release envelope. */
function pad(data, sr, startSeconds, freq, dur, timbre) {
  const harmonics = timbre.harmonics ?? [1, 0.4, 0.2, 0.1];
  const attack = dur * (timbre.attackFrac ?? 0.2);
  const release = dur * (timbre.releaseFrac ?? 0.25);
  const start = Math.floor(startSeconds * sr);
  const length = Math.min(Math.floor(dur * sr), data.length - start);
  for (let i = 0; i < length; i++) {
    const t = i / sr;
    let env = 1;
    if (t < attack) env = t / attack;
    else if (t > dur - release) env = (dur - t) / release;
    const w = 2 * Math.PI * freq * t;
    let sample = 0;
    for (let h = 0; h < harmonics.length; h++) sample += harmonics[h] * Math.sin((h + 1) * w);
    data[start + i] += sample * env;
  }
}

/** Chiptune pulse wave with a fast decay. */
function chip(data, sr, startSeconds, freq, dur, timbre) {
  const width = timbre.width ?? 0.25;
  const tau = dur * (timbre.decayFrac ?? 0.4);
  const start = Math.floor(startSeconds * sr);
  const length = Math.min(Math.floor(dur * sr), data.length - start);
  for (let i = 0; i < length; i++) {
    const t = i / sr;
    const phase = (freq * t) % 1;
    data[start + i] += (phase < width ? 1 : -1) * Math.exp(-t / tau);
  }
}

/** Hard cut at the note boundary so overlapping renders don't smear. */
function boundaryCut(t, dur) {
  return Math.max(0, Math.min(1, (dur - t) / 0.02));
}

// ---- percussion -----------------------------------------------------------
// Renderers share a signature: (data, sr, startSeconds, recipe, rng); the
// recipe's pitch/decay scale each instrument's character per cell.

function kick(data, sr, startSeconds, p) {
  const start = Math.floor(startSeconds * sr);
  const length = Math.min(Math.floor(0.15 * p.decay * sr), data.length - start);
  let phase = 0;
  for (let i = 0; i < length; i++) {
    const t = i / sr;
    phase += (2 * Math.PI * (45 + 110 * Math.exp(-t / 0.03)) * p.pitch) / sr;
    data[start + i] += Math.sin(phase) * Math.exp(-t / (0.09 * p.decay));
  }
}

function snare(data, sr, startSeconds, p, rng) {
  const start = Math.floor(startSeconds * sr);
  const length = Math.min(Math.floor(0.18 * p.decay * sr), data.length - start);
  for (let i = 0; i < length; i++) {
    const t = i / sr;
    const noise = (rng() * 2 - 1) * Math.exp(-t / (0.05 * p.decay)) * 0.8;
    const body = Math.sin(2 * Math.PI * 185 * p.pitch * t) * Math.exp(-t / 0.06) * 0.5;
    data[start + i] += noise + body;
  }
}

function hat(data, sr, startSeconds, p, rng) {
  const start = Math.floor(startSeconds * sr);
  const length = Math.min(Math.floor(0.06 * p.decay * sr), data.length - start);
  let prev = 0;
  for (let i = 0; i < length; i++) {
    const t = i / sr;
    const noise = rng() * 2 - 1;
    data[start + i] += (noise - prev) * Math.exp(-t / (0.02 * p.decay)); // crude highpass
    prev = noise;
  }
}

function shaker(data, sr, startSeconds, p, rng) {
  const start = Math.floor(startSeconds * sr);
  const length = Math.min(Math.floor(0.05 * p.decay * sr), data.length - start);
  let filtered = 0;
  for (let i = 0; i < length; i++) {
    const t = i / sr;
    filtered = 0.6 * filtered + 0.4 * (rng() * 2 - 1);
    data[start + i] += filtered * Math.exp(-t / (0.025 * p.decay));
  }
}

function block(data, sr, startSeconds, p) {
  const start = Math.floor(startSeconds * sr);
  const length = Math.min(Math.floor(0.07 * sr), data.length - start);
  for (let i = 0; i < length; i++) {
    const t = i / sr;
    data[start + i] +=
      (Math.sin(2 * Math.PI * 950 * p.pitch * t) + 0.5 * Math.sin(2 * Math.PI * 1450 * p.pitch * t)) *
      Math.exp(-t / (0.02 * p.decay));
  }
}

function tom(data, sr, startSeconds, p) {
  const start = Math.floor(startSeconds * sr);
  const length = Math.min(Math.floor(0.2 * p.decay * sr), data.length - start);
  let phase = 0;
  for (let i = 0; i < length; i++) {
    const t = i / sr;
    phase += (2 * Math.PI * (100 + 60 * Math.exp(-t / 0.04)) * p.pitch) / sr;
    data[start + i] += Math.sin(phase) * Math.exp(-t / (0.11 * p.decay));
  }
}

// ---- shared shaping -------------------------------------------------------

function normalize(data, peak) {
  let max = 0;
  for (let i = 0; i < data.length; i++) max = Math.max(max, Math.abs(data[i]));
  if (max === 0) return;
  const scale = peak / max;
  for (let i = 0; i < data.length; i++) data[i] *= scale;
}

/** Fade the buffer edges so it loops without clicking. */
function edgeFade(data, sr) {
  const fade = Math.min(Math.floor(sr * 0.008), Math.floor(data.length / 4));
  for (let i = 0; i < fade; i++) {
    const k = i / fade;
    data[i] *= k;
    data[data.length - 1 - i] *= k;
  }
}
