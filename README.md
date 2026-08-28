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
   Painting a cell on previews its sound.
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
3. **Fallback**: a built-in bank of 142 synthesized sounds, so the app is
   playable with zero setup. Five melodic voices (Karplus–Strong plucks,
   muted plucks, FM bells, soft pads, chip squares) on the A minor
   pentatonic scale; 70 two-note figures (eighth+eighth and dotted
   eighth+sixteenth rhythms, rising or falling by pentatonic steps —
   roughly 3rds, 4ths, and 5ths); and 12 percussion patterns (kick, snare,
   hats, shaker, woodblock, toms, some on the offbeat). Every clip is
   rendered to last exactly one beat, and the bank retunes itself when you
   change the BPM. Percussion cells render desaturated (silver) so drums
   are recognizable on the board.

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
