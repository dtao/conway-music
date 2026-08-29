# Conway Music

A full-screen web experience that crosses Conway's Game of Life with a step
sequencer. Every cell on the grid holds a sound — imagine each cell carrying
one beat of a 4-bar guitar lick. You paint a starting pattern, press Play,
and the board evolves by the classic Game of Life rules at a set BPM. Every
living cell plays its sound for every beat it stays alive, looping its clip
if it survives longer than the clip lasts. The music *is* the simulation:
gliders become melodies, oscillators become riffs, and still lifes become
drones.

## Running it

It's a static site with no build step. Serve the directory and open it:

```sh
npx serve .
# or
python3 -m http.server 8000
```

Then visit the printed URL. (A server is needed so the app can fetch audio;
without one it still runs using the built-in synth bank.)

## Playing it

1. **Click cells** (click-drag paints) to define the starting configuration.
   Painting a cell on previews its sound. **Hold a cell** (long press,
   mouse or touch) to audition its full song — a chord-mode cell plays its
   entire progression cycle — until you release; slide while holding to
   audition neighbors.
2. Press **Play**. Each beat advances one generation; cells that are born
   start playing, cells that die stop.
3. You can keep painting while it plays — cells join or leave the music
   immediately.

Controls: **Play/Pause** (Space), **Step** one generation (S), **Random**
pattern (R), **Clear** (C), **Share**, and a **BPM** slider (40–240). The
grid wraps at the edges (a torus), so patterns never fall off the board.

## Riff presets

The **Riffs…** menu in the control bar stamps a classic Game of Life
pattern onto the board as a ready-made composition — gliders and
spaceships for traveling melodies, the pulsar and pentadecathlon for
long oscillating chord cycles, the Gosper glider gun for endless
arpeggios, and methuselahs (R-pentomino, acorn, diehard) for
slow-evolving jams. Presets are defined in `js/patterns.js` as simple
`O`/`.` string art, so adding your own is a copy-paste job.

## Sharing patterns

The board lives in the URL: whenever you edit while paused, the location
hash updates with the grid size, BPM, and a bit-packed encoding of the
alive cells. Copy the address (or hit **Share**, which copies it to the
clipboard) and anyone opening the link gets your starting pattern and
tempo, ready to play. If their grid is configured to a different size, the
shared pattern is centered onto it.

## Configuring sounds

Edit `config.js` — it's loaded as a plain script, so changes take effect on
reload:

```js
window.CONWAY_MUSIC_CONFIG = {
  audio: {
    files: null,                          // explicit list of audio URLs, or
    baseUrl: "",                          //   ...resolved against this base
    manifestUrl: "sounds/manifest.json",  // or a JSON manifest of files
  },
  grid: { cols: 36, rows: 22 },
  bpm: 120,
  assignmentSeed: 42,  // change for a different sound-to-cell layout
  maxVoices: 64,       // cap on simultaneously sounding cells
};
```

Sound sources are tried in order:

1. `audio.files` — an explicit array of audio URLs.
2. `audio.manifestUrl` — a JSON file listing audio URLs (see
   `sounds/README.md` for the format).
3. **Fallback — parametric synth**: every cell gets its own synthesis
   recipe, deterministically derived from `assignmentSeed`, so all 792
   cells are unique. A recipe picks a category (melodic figure, composed
   sequence, or percussion — roughly 75/15/10), a voice (Karplus–Strong
   pluck, muted pluck, FM bell, soft pad, or chip pulse), pitch material
   on the A natural minor scale, a rhythm, and continuous timbre
   parameters: string damping, FM ratio and index, pulse width, envelope
   speeds, a few cents of detune, and a unique noise seed (so no two
   plucks are ever literally identical). Buffers render lazily on a
   cell's first birth into a capped cache, and a BPM change re-renders
   everything to fit the new beat while cells keep their sound identity.
   Percussion cells render desaturated (silver) so drums are
   recognizable on the board. Every voice is also placed in the stereo
   field by its column — travelers like gliders literally move through
   the mix — with a small per-cell gain trim for depth.

### Multiple grids

The **Grids** buttons above the board (keys 1/2/3) run up to three Games
of Life at once, splitting the screen. Each grid is an independent
simulation stepping at its own note value against the shared beat clock:
the first in quarter notes, the second in dotted quarters, the third in
dotted eighths (`gridRhythms` in `config.js`). Every cell's figure is
rendered to fit its grid's step, so the same rhythm notation breathes at
three different paces — a three-layer polyrhythm that realigns every
three bars.

Harmony stays coherent: in a chord-progression mode, every grid draws
its notes from the chord sounding when its step begins, so the layers
follow the changes together no matter how their steps straddle the bar
lines. Whole-bar pads stay on the quarter-note grid (the rhythmic
layers trade them for muted plucks), painting works on any grid, Random
reseeds all visible grids, riffs stamp every visible grid (the same
formation phasing against itself at three rates), and shared URLs
capture every layer. Changing the grid count mid-play keeps the music
going: a joining grid comes in on its own lattice in phase, a leaving
one falls silent.

### Voice families

The **family selector** in the control bar (or `voiceFamily` in
`config.js`) swaps the instrument palette every cell draws from while
keeping the rest of a cell's recipe (notes, rhythm, register) intact:

- **Classic** — the original bank: Karplus–Strong plucks, FM bells,
  additive pads, chip pulses.
- **Orchestral** — pizzicato, staccato and sustained strings, horns,
  and breathy flutes.
- **Wavesynth** — FM electric piano, glassy inharmonic FM, square
  stabs, supersaw-ish pads, wide-ranging PWM.
- **8-bit** — pulse waves at 50/25/12.5% duty and struck or sustained
  triangles.

Percussion is shared across families. Families are data
(`VOICE_FAMILIES` in `js/audio.js`): a mapping from the five voice
roles onto the synthesis primitives with per-cell timbre distributions
— add an entry and it appears in the selector.

### Effects

The collapsible **FX panel** on the right (collapsed by default)
toggles three master effects, all bus-level so their cost is constant
no matter how many voices play:

- **Reverb** — convolution over a procedurally generated impulse
  response, fed by per-kind sends: percussion stays tight, melodic
  voices get a touch, pads and leads swim.
- **Delay** — tempo-synced to a dotted eighth, with a darkened feedback
  loop, on the same per-kind sends.
- **Chorus** — an LFO-modulated short delay coloring only the pad/lead
  bus.

All three are on by default (`effects` in `config.js`); reverb and
delay sends are physically disconnected while off, so a disabled
effect costs nothing.

### Lead overlays

The **Leads** panel above the grid toggles up to two solo voices that
float over the board (lead 1: L, lead 2: shift+L). Each beat the
conductor takes a rolling, recency-weighted average of every note the
board is currently sounding (an 8-beat window), folds it into each
voice's register, snaps it to the current mode's note pool, and glides
there with a short portamento. Volume and brightness track board
activity through slow ramps, so the voices swell as the colony blooms
and fade as it dies back.

Which note a voice sings is chosen deterministically by the board's
**population trend**: a stable board sings the consensus note itself, a
growing one the third above, a shrinking one the sixth. When both
voices are on, lead 2 always takes the next interval in that cycle, so
the pair harmonizes instead of doubling — lead 1 is a clarinet-ish
soloist, lead 2 a warmer cello-ish voice an octave lower, panned to the
other side and slower to swell. Defaults come from `leads` in
`config.js`; synth-mode only, since audio files carry no pitch
information.

The bottom control bar collapses (the &#9662; handle) down to just
Play/Pause when you want the grid unobstructed.

### Sound modes

The **mode selector** in the control bar (or `soundMode` in `config.js`)
currently offers three chord progressions. In a progression mode, every
melodic cell becomes a riff that follows the changes: it keeps its own
rhythm, voice, and timbre, but draws its notes from the current bar's
chord pool (dominant chord tones weighted 3×, "sparse" color notes 1×).
Cells born mid-cycle join in phase — the whole board tracks the
progression — and the lead overlays snap to the tones of the chord
sounding right now. Pads hold one chord tone per bar.

- **F–Am–C–G** — one bar per chord over a 16-beat cycle (F: F A B C E ·
  Am: A B C E · C: C E G B · G: G B D F).
- **Em–A** — a dorian vamp: two bars of E minor (E G B dominant, C♯ and
  D sparse), two of A major (A C♯ E dominant, G sparse).
- **C–D–Bm–C** — a lydian-leaning cycle: C (C E G B, sparse D), D
  (D F♯ A, sparse C), Bm (B D F♯, sparse G and A), back to C (C E G,
  sparse B).
- **C–Am–F** — two bars of C, one each of Am and F, each triad joined
  by a sparse color tone pinned to the upper registers (high B over C
  and Am, high E over F).
- **G–Bm–F–Am** — mixes F♯ (in Bm) and F natural (in F) via per-note
  semitone offsets in the chord pools, with sparse high A, E, and B
  color tones.
- **D–Dm–A–A** — D major melting into D minor (F♯ flattening to F),
  resolving to two bars of A major with sparse G♯ and B color.
- **A–E–B–F♯m** — a bright pop rotation that sits entirely in A lydian
  (A B C♯ D♯ E F♯ G♯), each triad with one sparse color tone.
- **C♯–A♯–G–E** — roots falling by minor thirds, a chromatic mediant
  cycle whose pools are written as raw semitones (no single scale
  holds it).
- **F♯m–F–Am–G♯ ×2** — a double-length, fully chromatic cycle: four
  bars, then the same progression transposed up a tritone (Cm, B, D♯m,
  D), 32 beats per revolution.

Four earlier scale-field modes (A minor field, C major triads, E dorian
drift, Whole-tone dream) remain in the code marked `hidden: true` —
remove the flag in `SOUND_MODES` to restore them to the dropdown.

Modes are pure data (`SOUND_MODES` in `js/audio.js`): a weighted degree
pool or a `progression` of per-chord pools, an optional mode-specific
`scale` (7 semitone offsets from the A root) for notes outside A natural
minor, and a sequence pool. Add an entry there and it appears in the
selector automatically. Every cell remains unique in every mode, and the
lead overlays follow whichever scale the mode defines.

### Geographic mode

Set `geographic: true` in `config.js` to make the board play like an
instrument: rows pick the register and voice family (sustained pads at
the bottom rising to bright bells and chips at the top), percussion
gathers in the bottom two rows, and the scale degree follows the column
so horizontal motion reads as melodic motion — a glider actually goes
somewhere. Off by default; every cell remains unique either way.

   Rhythms are written in a sixteenth-grid notation, four characters per
   beat: each `1` starts a note that sustains until the next `1` (or the
   end of the beat), and leading `0`s are rest. The bank currently uses
   `1000` (quarter note), `1010` (two eighths), `1001` (dotted eighth +
   sixteenth), `1100` (sixteenth into a dotted eighth), `0110` (sixteenth
   rest, sixteenth, eighth), plus `0010` (offbeat eighth) and `1111`
   (running sixteenths) for percussion — adding more in `js/audio.js` is a
   one-line change.

## Composed sequences

`config.js` can add multi-beat melodic phrases to the synth bank via
`sequences`, written in a pitch extension of the rhythm notation — still
one character per sixteenth:

| Char | Meaning |
| --- | --- |
| `1`–`7` | note onset on that scale degree (A minor: 1=A 2=B 3=C 4=D 5=E 6=F 7=G) |
| `-` | sustain the previous note |
| `.` | rest |
| `'` / `,` | raise / lower the next note by an octave (takes no grid time) |

So `3-2-1---` is a two-beat C–B–A figure (two eighths into a half note),
`1--3--5-` is a 3-3-2 tresillo up an A minor arpeggio, and
`2-3-1-2-,7-1-,6-,5-` winds down below the root over four beats. Each
entry names a `voice` (`pluck`, `muted`, `bell`, `pad`, or `chip`).
Multi-beat sequences loop on their own cycle, so cells carrying them phase
against one-beat cells. The default config ships fourteen composed
sequences; generate your own and drop them in.

Sounds are scattered across the grid with a seeded shuffle: the assignment is
stable across reloads, and each cell's color hue corresponds to its sound, so
you can compose by color. Clips loop seamlessly while a cell stays alive, so
clips that are a whole number of beats long at your BPM sound tightest.

## How the audio works

- A look-ahead scheduler (Web Audio clock, not `setTimeout`) advances one
  Game of Life generation per beat and schedules voice starts/stops
  sample-accurately on the beat.
- Each living cell is one looping `AudioBufferSourceNode` with a short
  attack/release ramp to avoid clicks; a master compressor keeps crowded
  boards from clipping, and `maxVoices` caps polyphony by stealing the
  oldest voice.
- Visuals are driven by the same clock: beat snapshots of the grid are
  queued with their audio timestamps and applied when their moment arrives,
  so what you see stays locked to what you hear.
