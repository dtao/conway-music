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

  // Up to three grids can run at once, splitting the screen; each is an
  // independent Game of Life stepping on its own rhythm against the shared
  // beat clock and chord progression. gridRhythms gives each grid's step
  // length in beats: quarter notes, dotted quarters, dotted eighths.
  gridCount: 1,
  gridRhythms: [1, 1.5, 0.75],

  // One Game of Life generation elapses per beat.
  bpm: 96,

  // Sounds are scattered across the grid with a seeded shuffle so the
  // layout is stable across reloads. Change the seed for a new layout.
  assignmentSeed: 42,

  // Safety cap on simultaneously sounding cells (oldest voices are the
  // quietest casualties of a very crowded board).
  maxVoices: 64,

  // Lead overlays: up to two monophonic sustained solo voices floating
  // above the grid (lead 1 clarinet-ish, lead 2 a warmer cello-ish voice
  // an octave lower). Each beat they follow a rolling recency-weighted
  // average of the notes the board is playing, snapped to the current
  // mode; the board's population trend deterministically picks the
  // harmony (stable = the consensus note, growing = the third above,
  // shrinking = the sixth), and when both voices sing, lead 2 always
  // takes the next interval in that cycle so the pair harmonizes. Volume
  // and brightness swell smoothly with board activity. Toggle live in the
  // top panel (or L / shift+L). Off by default.
  leads: [false, false],

  // Sound mode: which note pool melodic cells draw from. The dropdown
  // currently offers three chord progressions — "famcg" (F–Am–C–G),
  // "ema" (Em–A dorian vamp), and "cdbc" (C–D–Bm–C) — while the earlier
  // scale-field modes (minor, cmajor, edorian, wholetone) remain in the
  // code marked hidden. Modes are data in js/audio.js (SOUND_MODES): add
  // one there and it appears in the selector; hidden: true keeps it out.
  soundMode: "famcg",

  // Geographic mode: when true, a cell's position shapes its sound — rows
  // pick the register and voice family (sustained pads low, bright bells
  // and chips high), percussion gathers in the bottom two rows, and the
  // scale degree follows the column so horizontal motion reads as melodic
  // motion. When false, sounds are scattered at random (still unique per
  // cell in parametric synth mode).
  geographic: false,

  // Composed sequences added to the built-in synth bank, written in a
  // compact notation, one character per sixteenth note:
  //   1-7  note onset on that scale degree (in A minor: 1=A 2=B 3=C 4=D
  //        5=E 6=F 7=G)
  //   -    sustain the previous note
  //   .    rest
  //   ' ,  raise / lower the next note by an octave (takes no grid time)
  // Four sixteenths per beat; longer strings make multi-beat phrases that
  // loop on their own cycle. `voice` picks the synth timbre: pluck, muted,
  // bell, pad, or chip.
  sequences: [
    // C, B, A — a falling sigh
    { voice: "pluck", seq: "3-2-1---" },
    { voice: "bell", seq: "3--21---" },
    { voice: "pad", seq: "3---2---1-------" },

    // A, C, E — rising arpeggio
    { voice: "pluck", seq: "1-3-5---" },
    { voice: "muted", seq: "1--3--5-" }, // 3-3-2 tresillo
    { voice: "chip", seq: "1.3.5---" },

    // F, C, E, C, A, C, E, C — rolling arpeggio
    { voice: "pluck", seq: "63531353" },
    { voice: "muted", seq: "6-3-5-3-1-3-5-3-" },

    // B, C, A, B, G, A, F, E — winding descent below the root
    { voice: "pluck", seq: "2-3-1-2-,7-1-,6-,5-" },
    { voice: "bell", seq: "2--31--2,7--1,6--,5" },

    // E, D, C, B — stepping down
    { voice: "pluck", seq: "5-4-3-2-" },
    { voice: "chip", seq: "54--32--" },
    { voice: "pad", seq: "5---4---3---2---" },
    { voice: "bell", seq: "5.4.3.2." },
  ],
};
