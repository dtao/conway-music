# Sounds

Drop your audio clips in this directory (or anywhere else you like) and list
them in a `manifest.json` next to them:

```json
{
  "files": [
    "guitar-lick-beat-1.wav",
    "guitar-lick-beat-2.wav",
    "guitar-lick-beat-3.wav",
    "guitar-lick-beat-4.wav"
  ]
}
```

A bare JSON array (`["a.wav", "b.wav"]`) works too. Paths resolve relative to
the manifest, so absolute URLs and subdirectories are both fine. Any format
the browser can decode works: wav, mp3, ogg, flac, m4a.

Then point `config.js` at it (the default already looks here):

```js
audio: {
  manifestUrl: "sounds/manifest.json",
}
```

Alternatively, skip the manifest and list files directly in `config.js` via
`audio.files` (resolved against `audio.baseUrl`).

Clips work best when their length is a whole number of beats at your chosen
BPM (e.g. 0.5 s per beat at 120 BPM) — each living cell loops its clip
seamlessly for as long as it stays alive. If no manifest or files are found,
the app falls back to a built-in bank of synthesized plucked-string notes.

`manifest.example.json` in this directory shows the format; rename it to
`manifest.json` once you've added real files.
