// Developer configuration for Conway Music.
//
// Loaded as a plain script before the app starts; edit values here to point
// the app at your own audio, change the grid size, tempo, etc. No build step.
window.CONWAY_MUSIC_CONFIG = {
  audio: {
    // Where sounds come from, tried in order:
    //
    // 1. `files` — an explicit list of audio URLs (absolute, or relative to
    //    `baseUrl`). Any format the browser can decode (wav, mp3, ogg, ...).
    //
    //      files: ["kick.wav", "snare.wav", "lick-beat-1.wav"],
    //
    // 2. `manifestUrl` — URL of a JSON file listing audio URLs, either a
    //    bare array (["a.wav", "b.wav"]) or {"files": ["a.wav", "b.wav"]}.
    //    Paths in the manifest resolve relative to the manifest itself.
    //
    // 3. If neither yields any decodable audio, the app falls back to a
    //    built-in bank of synthesized plucked-string notes (minor
    //    pentatonic) so it is playable with zero setup.
    files: null,
    baseUrl: "",
    manifestUrl: "sounds/manifest.json",
  },

  // Logical grid dimensions (cells), scaled to fill the screen.
  grid: {
    cols: 36,
    rows: 22,
  },

  // One Game of Life generation elapses per beat.
  bpm: 120,

  // Sounds are scattered across the grid with a seeded shuffle so the
  // layout is stable across reloads. Change the seed for a new layout.
  assignmentSeed: 42,

  // Safety cap on simultaneously sounding cells (oldest voices are the
  // quietest casualties of a very crowded board).
  maxVoices: 64,
};
