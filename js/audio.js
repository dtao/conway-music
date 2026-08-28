// Audio engine: loads the developer-configured sound bank (explicit file
// list or JSON manifest), falling back to a synthesized pluck bank, and
// manages one looping voice per living cell.

const ATTACK = 0.008;
const RELEASE = 0.05;
const VOICE_GAIN = 0.28;

export class AudioEngine {
  constructor(config) {
    this.config = config;
    this.ctx = null;
    this.master = null;
    this.buffers = [];
    this.bankLabel = "";
    this.voices = new Map(); // cell index -> { source, gain, startedAt }
    this.maxVoices = config.maxVoices || 64;
  }

  /** Must be called from a user gesture (browsers gate audio on one). */
  async init() {
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

    await this._loadBank();
  }

  get now() {
    return this.ctx.currentTime;
  }

  async _loadBank() {
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
        this.bankLabel += ` (${this.buffers.length} sounds)`;
        return;
      }
      console.warn("Conway Music: no configured audio could be loaded; using synth bank.");
    }

    this.buffers = buildSynthBank(this.ctx);
    this.bankLabel = `built-in synth (${this.buffers.length} notes)`;
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

/**
 * Fallback bank: Karplus–Strong plucked strings over a minor pentatonic
 * scale, so the app makes music with zero audio files configured.
 */
function buildSynthBank(ctx, noteSeconds = 0.5) {
  const root = 110; // A2
  const pentatonic = [0, 3, 5, 7, 10];
  const buffers = [];
  for (let octave = 0; octave < 4; octave++) {
    for (const semitone of pentatonic) {
      const freq = root * Math.pow(2, octave + semitone / 12);
      buffers.push(pluckBuffer(ctx, freq, noteSeconds));
    }
  }
  return buffers;
}

function pluckBuffer(ctx, freq, seconds) {
  const sampleRate = ctx.sampleRate;
  const length = Math.floor(sampleRate * seconds);
  const buffer = ctx.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);

  const period = Math.max(2, Math.round(sampleRate / freq));
  const delay = new Float32Array(period);
  for (let i = 0; i < period; i++) delay[i] = Math.random() * 2 - 1;

  let idx = 0;
  for (let i = 0; i < length; i++) {
    const current = delay[idx];
    const next = delay[(idx + 1) % period];
    delay[idx] = 0.996 * 0.5 * (current + next);
    data[i] = current;
    idx = (idx + 1) % period;
  }

  // Fade the edges so the buffer loops without clicking.
  const fade = Math.min(Math.floor(sampleRate * 0.01), Math.floor(length / 4));
  for (let i = 0; i < fade; i++) {
    const k = i / fade;
    data[i] *= k;
    data[length - 1 - i] *= k;
  }
  return buffer;
}
