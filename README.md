# Drift — Brainwave Looper

Seamless infinite brainwave MP3 looper for focus, meditation, and sleep.

Drift analyzes each MP3 you add, finds the true loop region (encoder delay and padding are trimmed using gapless metadata), and plays it back with equal-power crossfades so the seam disappears. Long files over 30 minutes are streamed with a dual-deck crossfade scheduler instead of being decoded in full.

## Features

- Seamless looping with adjustable crossfade (50–2000 ms)
- Automatic loop trim, with manual In/Out markers on the waveform
- Binaural beat detection (FFT analysis of the stereo channels)
- 3-band EQ and savable presets
- Sleep timer with a gentle fade-out
- Works fully offline as a PWA — add it to your home screen
- Your library lives in IndexedDB with persistent-storage protection and verified saves
- Export/restore a full library backup (MP3s + trims + presets) from the Library backup panel
- Light and dark themes — follows your system, or use the toggle in the header

## Run it

Any static host works. The live deployment is on Netlify:

https://drift-brainwave-looper.netlify.app

## Files

- `index.html` — the app shell
- `app.js` — playback engine, MP3 analysis, storage, backup/restore
- `styles.css` — light and dark themes
- `manifest.json` — PWA manifest
- `sw.js` — service worker (offline app shell)
