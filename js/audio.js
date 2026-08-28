// Audio engine: loads the developer-configured sound bank (explicit file
// list or JSON manifest), falling back to a synthesized bank of plucks,
// bells, pads, chip tones, two-note figures, and percussion, and manages
// one looping voice per living cell.

const ATTACK = 0.008;
const RELEASE = 0.05;
const VOICE_GAIN = 0.28;

export class AudioEngine {
  constructor(config) {
    this.config = config;
    this.ctx = null;
    this.master = null;
    this.buffers = [];
    this.kinds = []; // parallel to buffers: "pluck", "bell", "perc", "file", ...
    this.bankLabel = "";
    this.voices = new Map(); // cell index -> { source, gain, startedAt }
    this.maxVoices = config.maxVoices || 64;
    this._synthBpm = null; // non-null when the built-in synth bank is active
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
   * The synth bank's rhythmic figures are rendered to fit exactly one beat,
   * so it must be rebuilt when the tempo changes. Call while no looping
   * voices are active (i.e. before starting playback). No-ops for file banks
   * and unchanged tempos; the bank's size and ordering are stable across
   * rebuilds, so cell-to-sound assignments are preserved.
   */
  rebuildSynthBank(bpm) {
    if (!this.usesSynthBank || this._synthBpm === bpm) return;
    const bank = buildSynthBank(this.ctx, bpm);
    this.buffers = bank.buffers;
    this.kinds = bank.kinds;
    this._synthBpm = bpm;
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
      this.buffers = buffers.filter(Boolean);
      if (this.buffers.length > 0) {
        this.kinds = this.buffers.map(() => "file");
        this.bankLabel += ` (${this.buffers.length} sounds)`;
        return;
      }
      console.warn("Conway Music: no configured audio could be loaded; using synth bank.");
    }

    const bank = buildSynthBank(this.ctx, bpm);
    this.buffers = bank.buffers;
    this.kinds = bank.kinds;
    this._synthBpm = bpm;
    this.bankLabel = `built-in synth (${this.buffers.length} sounds)`;
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

  bufferForSound(soundIndex) {
    return this.buffers[soundIndex % this.buffers.length];
  }

  /** Start a cell's looping voice at audio-clock time `when`. */
  startVoice(cellIndex, soundIndex, when) {
    if (this.voices.has(cellIndex)) return;
    if (this.voices.size >= this.maxVoices) this._stealOldestVoice(when);

    const buffer = this.bufferForSound(soundIndex);
    if (!buffer) return;

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(VOICE_GAIN, when + ATTACK);

    source.connect(gain);
    gain.connect(this.master);
    source.start(when);

    this.voices.set(cellIndex, { source, gain, startedAt: when });
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
  }

  _fadeOut(voice, when) {
    const t = Math.max(when, this.now);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, t);
    voice.gain.gain.linearRampToValueAtTime(0, t + RELEASE);
    voice.source.stop(t + RELEASE + 0.01);
    voice.source.onended = () => voice.gain.disconnect();
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
  preview(soundIndex) {
    const buffer = this.bufferForSound(soundIndex);
    if (!buffer) return;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    const gain = this.ctx.createGain();
    gain.gain.value = VOICE_GAIN;
    source.connect(gain);
    gain.connect(this.master);
    source.start();
    source.onended = () => gain.disconnect();
  }
}

// ---------------------------------------------------------------------------
// Built-in synth bank
//
// Every buffer is rendered to last exactly one beat, so figures with internal
// rhythm (two-note runs, offbeat percussion) stay locked to the grid when a
// cell loops. All melodic material stays on the A minor pentatonic scale so
// any combination of live cells remains consonant.
//
// Composition (142 sounds):
//   20 plucked strings (Karplus–Strong), 4 octaves
//   10 muted plucks, 10 FM bells, 10 soft pads, 10 chip squares
//   60 two-note pluck figures: eighth+eighth or dotted-eighth+sixteenth,
//      rising/falling by 1–3 pentatonic steps (~3rds, 4ths, 5ths)
//   10 two-note bell figures
//   12 percussion patterns: kick, snare, hats, shaker, woodblock, toms,
//      some placed on the offbeat or subdividing the beat

const SCALE = [0, 3, 5, 7, 10]; // A minor pentatonic, semitones from the root
const ROOT_HZ = 110; // A2

/** Frequency of the nth pentatonic degree above (or below) the root. */
function degreeHz(n) {
  const octave = Math.floor(n / 5);
  const degree = ((n % 5) + 5) % 5;
  return ROOT_HZ * Math.pow(2, octave + SCALE[degree] / 12);
}

function buildSynthBank(ctx, bpm) {
  const beat = 60 / bpm;
  const sampleRate = ctx.sampleRate;
  const buffers = [];
  const kinds = [];

  const add = (kind, peak, write) => {
    const length = Math.max(1, Math.round(sampleRate * beat));
    const buffer = ctx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);
    write(data, sampleRate);
    normalize(data, peak);
    edgeFade(data, sampleRate);
    buffers.push(buffer);
    kinds.push(kind);
  };

  // Single notes: (kind, renderer, octaves, peak)
  const voices = [
    ["pluck", pluck, [0, 1, 2, 3], 0.9],
    ["muted", mutedPluck, [1, 2], 0.7],
    ["bell", bell, [2, 3], 0.75],
    ["pad", pad, [0, 1], 0.6],
    ["chip", chip, [1, 2], 0.55],
  ];
  for (const [kind, render, octaves, peak] of voices) {
    for (const octave of octaves) {
      for (let degree = 0; degree < 5; degree++) {
        add(kind, peak, (data, sr) =>
          render(data, sr, 0, degreeHz(octave * 5 + degree), beat));
      }
    }
  }

  // Two-note figures. Onset fractions of the beat: two eighths, or a dotted
  // eighth followed by a sixteenth.
  const RHYTHMS = { eighths: [0, 0.5], dotted: [0, 0.75] };
  const duet = (render, kind, peak, base, steps, rhythm) =>
    add(kind, peak, (data, sr) => {
      const onsets = RHYTHMS[rhythm];
      const notes = [base, base + steps];
      for (let n = 0; n < 2; n++) {
        const start = onsets[n] * beat;
        const dur = (n === 0 ? onsets[1] : 1 - onsets[1]) * beat;
        render(data, sr, start, degreeHz(notes[n]), dur);
      }
    });

  const DUET_PATTERNS = [
    [1, "eighths"], [2, "dotted"], [3, "eighths"],
    [-1, "dotted"], [-2, "eighths"], [-3, "dotted"],
  ];
  for (const octave of [1, 2]) {
    for (let degree = 0; degree < 5; degree++) {
      for (const [steps, rhythm] of DUET_PATTERNS) {
        duet(pluck, "duet", 0.9, octave * 5 + degree, steps, rhythm);
      }
    }
  }
  for (let degree = 0; degree < 5; degree++) {
    duet(bell, "bellduet", 0.75, 10 + degree, 2, "eighths");
    duet(bell, "bellduet", 0.75, 10 + degree, -2, "dotted");
  }

  // Percussion patterns: [renderer, peak, hit offsets as fractions of a beat]
  const PERC_PATTERNS = [
    [kick, 1.0, [0]],
    [kick, 1.0, [0, 0.5]],
    [snare, 0.8, [0]],
    [snare, 0.8, [0.5]],
    [hat, 0.45, [0]],
    [hat, 0.45, [0, 0.5]],
    [hat, 0.45, [0, 0.75]],
    [shaker, 0.35, [0, 0.25, 0.5, 0.75]],
    [block, 0.6, [0]],
    [block, 0.6, [0.5]],
    [tom, 0.85, [0]],
    [tomHigh, 0.8, [0, 0.75]],
  ];
  for (const [render, peak, hits] of PERC_PATTERNS) {
    add("perc", peak, (data, sr) => {
      for (const hit of hits) render(data, sr, hit * beat, 0, beat * 0.5);
    });
  }

  return { buffers, kinds };
}

// ---- melodic voices -------------------------------------------------------
// Each renderer mixes a note into `data` starting at `startSeconds`.

function pluck(data, sr, startSeconds, freq, dur) {
  karplusStrong(data, sr, startSeconds, freq, dur, 0.996, 1);
}

function mutedPluck(data, sr, startSeconds, freq, dur) {
  karplusStrong(data, sr, startSeconds, freq, dur, 0.99, 3);
}

/** Karplus–Strong: white noise through a decaying averaging delay line. */
function karplusStrong(data, sr, startSeconds, freq, dur, damping, smooth) {
  const start = Math.floor(startSeconds * sr);
  const length = Math.min(Math.floor(dur * sr), data.length - start);
  const period = Math.max(2, Math.round(sr / freq));
  const delay = new Float32Array(period);
  for (let i = 0; i < period; i++) delay[i] = Math.random() * 2 - 1;
  // Pre-smoothing dulls the attack for the muted variant.
  for (let s = 0; s < smooth - 1; s++) {
    for (let i = 0; i < period; i++) {
      delay[i] = 0.5 * (delay[i] + delay[(i + 1) % period]);
    }
  }
  let idx = 0;
  for (let i = 0; i < length; i++) {
    const current = delay[idx];
    delay[idx] = damping * 0.5 * (current + delay[(idx + 1) % period]);
    data[start + i] += current * envelope(i / sr, length / sr);
    idx = (idx + 1) % period;
  }
}

/** Simple two-operator FM bell: modulator at ~3x the carrier, decaying index. */
function bell(data, sr, startSeconds, freq, dur) {
  const start = Math.floor(startSeconds * sr);
  const length = Math.min(Math.floor(dur * sr), data.length - start);
  const tau = dur / 3;
  for (let i = 0; i < length; i++) {
    const t = i / sr;
    const index = 3.5 * Math.exp(-t / (dur / 5));
    const mod = index * Math.sin(2 * Math.PI * freq * 3.01 * t);
    data[start + i] += Math.sin(2 * Math.PI * freq * t + mod) * Math.exp(-t / tau);
  }
}

/** Soft additive pad: a few harmonics under a slow attack/release envelope. */
function pad(data, sr, startSeconds, freq, dur) {
  const start = Math.floor(startSeconds * sr);
  const length = Math.min(Math.floor(dur * sr), data.length - start);
  const attack = dur * 0.2;
  const release = dur * 0.25;
  for (let i = 0; i < length; i++) {
    const t = i / sr;
    let env = 1;
    if (t < attack) env = t / attack;
    else if (t > dur - release) env = (dur - t) / release;
    const w = 2 * Math.PI * freq * t;
    data[start + i] +=
      (Math.sin(w) + 0.4 * Math.sin(2 * w) + 0.2 * Math.sin(3 * w) + 0.1 * Math.sin(4 * w)) * env;
  }
}

/** Chiptune square with a fast decay. */
function chip(data, sr, startSeconds, freq, dur) {
  const start = Math.floor(startSeconds * sr);
  const length = Math.min(Math.floor(dur * sr), data.length - start);
  for (let i = 0; i < length; i++) {
    const t = i / sr;
    const phase = (freq * t) % 1;
    data[start + i] += (phase < 0.25 ? 1 : -1) * Math.exp(-t / (dur / 2.5));
  }
}

/** Shared exponential-ish decay with a hard stop at the note boundary. */
function envelope(t, dur) {
  const tail = Math.min(1, (dur - t) / 0.02); // 20ms cut at the note boundary
  return Math.max(0, tail);
}

// ---- percussion -----------------------------------------------------------
// Renderers share the melodic signature (freq unused) so patterns can place
// hits anywhere in the beat.

function kick(data, sr, startSeconds) {
  const start = Math.floor(startSeconds * sr);
  const length = Math.min(Math.floor(0.15 * sr), data.length - start);
  let phase = 0;
  for (let i = 0; i < length; i++) {
    const t = i / sr;
    phase += (2 * Math.PI * (45 + 110 * Math.exp(-t / 0.03))) / sr;
    data[start + i] += Math.sin(phase) * Math.exp(-t / 0.09);
  }
}

function snare(data, sr, startSeconds) {
  const start = Math.floor(startSeconds * sr);
  const length = Math.min(Math.floor(0.18 * sr), data.length - start);
  for (let i = 0; i < length; i++) {
    const t = i / sr;
    const noise = (Math.random() * 2 - 1) * Math.exp(-t / 0.05) * 0.8;
    const body = Math.sin(2 * Math.PI * 185 * t) * Math.exp(-t / 0.06) * 0.5;
    data[start + i] += noise + body;
  }
}

function hat(data, sr, startSeconds) {
  const start = Math.floor(startSeconds * sr);
  const length = Math.min(Math.floor(0.06 * sr), data.length - start);
  let prev = 0;
  for (let i = 0; i < length; i++) {
    const t = i / sr;
    const noise = Math.random() * 2 - 1;
    data[start + i] += (noise - prev) * Math.exp(-t / 0.02); // crude highpass
    prev = noise;
  }
}

function shaker(data, sr, startSeconds) {
  const start = Math.floor(startSeconds * sr);
  const length = Math.min(Math.floor(0.05 * sr), data.length - start);
  let filtered = 0;
  for (let i = 0; i < length; i++) {
    const t = i / sr;
    filtered = 0.6 * filtered + 0.4 * (Math.random() * 2 - 1);
    data[start + i] += filtered * Math.exp(-t / 0.025);
  }
}

function block(data, sr, startSeconds) {
  const start = Math.floor(startSeconds * sr);
  const length = Math.min(Math.floor(0.07 * sr), data.length - start);
  for (let i = 0; i < length; i++) {
    const t = i / sr;
    data[start + i] +=
      (Math.sin(2 * Math.PI * 950 * t) + 0.5 * Math.sin(2 * Math.PI * 1450 * t)) *
      Math.exp(-t / 0.02);
  }
}

function tom(data, sr, startSeconds) {
  tomAt(data, sr, startSeconds, 100);
}

function tomHigh(data, sr, startSeconds) {
  tomAt(data, sr, startSeconds, 170);
}

function tomAt(data, sr, startSeconds, baseHz) {
  const start = Math.floor(startSeconds * sr);
  const length = Math.min(Math.floor(0.2 * sr), data.length - start);
  let phase = 0;
  for (let i = 0; i < length; i++) {
    const t = i / sr;
    phase += (2 * Math.PI * (baseHz + 60 * Math.exp(-t / 0.04))) / sr;
    data[start + i] += Math.sin(phase) * Math.exp(-t / 0.11);
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
