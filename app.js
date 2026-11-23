(() => {
  'use strict';

  const STREAMING_THRESHOLD_SEC = 1800;
  const MIN_CROSSFADE_MS = 50;
  const MAX_CROSSFADE_MS = 2000;
  const DEFAULT_CROSSFADE_MS = 150;
  const MIN_LOOP_GAP_SEC = 2;
  const FADE_CURVE_SIZE = 256;
  const BUFFER_CACHE_LIMIT = 2;
  const DB_NAME = 'drift_audio_db';
  const DB_VERSION = 2;
  const STORE_META = 'tracks';
  const STORE_DATA = 'audioData';
  const STORE_SETTINGS = 'settings';
  const PRESETS_KEY = 'drift_presets_v1';

  const BITRATE_TABLE = {
    1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
    2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0]
  };
  const SAMPLERATE_TABLE = {
    3: [44100, 48000, 32000],
    2: [22050, 24000, 16000],
    0: [11025, 12000, 8000]
  };

  // Equal-power crossfade curves (sin/cos) preserve constant acoustic power across loop seams.
  const FADE_IN_CURVE = new Float32Array(FADE_CURVE_SIZE);
  const FADE_OUT_CURVE = new Float32Array(FADE_CURVE_SIZE);
  for (let i = 0; i < FADE_CURVE_SIZE; i++) {
    const t = i / (FADE_CURVE_SIZE - 1);
    FADE_IN_CURVE[i] = Math.sin(t * 0.5 * Math.PI);
    FADE_OUT_CURVE[i] = Math.cos(t * 0.5 * Math.PI);
  }

  const state = {
    tracks: [],
    currentTrackId: null,
    isPlaying: false,
    volume: 0.85,
    muted: false,
    crossfadeMs: DEFAULT_CROSSFADE_MS,
    eq: { low: 0, mid: 0, high: 0 },
    sleepMinutes: 0,
    sleepTotalSec: 0,
    sleepRemainingSec: 0,
    sleepEndTime: null,
    sleepFadeActive: false,
    elapsedSec: 0,
    lastElapsedTick: null,
    presets: [],
    activeTab: 'trim',
    sheetOpen: false,
    editingPresetId: null,
    loadingCount: 0
  };

  let dbPromise = null;
  let audioCtx = null;
  let eqLow = null;
  let eqMid = null;
  let eqHigh = null;
  let sleepGain = null;
  let masterGain = null;
  let keepAliveEl = null;
  let keepAliveUrl = null;
  let streamDecks = [];
  let activeStreamDeckIdx = 0;
  let streamStandbyPrepared = false;
  let streamSwitching = false;
  let streamTrackId = null;

  let playbackGen = 0;
  let scheduledNodes = [];
  let nextLoopStartCtx = 0;
  let activeBufferTrackId = null;
  let schedulerWorker = null;
  let schedulerFallbackId = null;
  let playheadRafId = null;
  let mediaArtworkUrl = null;
  let dragCounter = 0;
  let trimSaveTimeout = null;

  const bufferCache = new Map();
  const objectUrlCache = new Map();

  let pendingRestore = null;
  const restoreIdMap = new Map();

  const dom = {
    dropOverlay: document.getElementById('dropOverlay'),
    fileInput: document.getElementById('fileInput'),
    headerAddBtn: document.getElementById('headerAddBtn'),
    themeToggleBtn: document.getElementById('themeToggleBtn'),
    themeMoonIcon: document.getElementById('themeMoonIcon'),
    themeSunIcon: document.getElementById('themeSunIcon'),
    vizBars: document.getElementById('vizBars'),
    loopProgressFill: document.getElementById('loopProgressFill'),
    loadingBar: document.getElementById('loadingBar'),
    loadingText: document.getElementById('loadingText'),
    errorBanner: document.getElementById('errorBanner'),
    errorText: document.getElementById('errorText'),
    dismissErrorBtn: document.getElementById('dismissErrorBtn'),
    iosNote: document.getElementById('iosNote'),
    dismissIosBtn: document.getElementById('dismissIosBtn'),
    emptyState: document.getElementById('emptyState'),
    emptyDropZone: document.getElementById('emptyDropZone'),
    emptyAddBtn: document.getElementById('emptyAddBtn'),
    playerView: document.getElementById('playerView'),
    binauralReadout: document.getElementById('binauralReadout'),
    elapsedTime: document.getElementById('elapsedTime'),
    currentTrackTitle: document.getElementById('currentTrackTitle'),
    prevTrackBtn: document.getElementById('prevTrackBtn'),
    playPauseBtn: document.getElementById('playPauseBtn'),
    playIcon: document.getElementById('playIcon'),
    pauseIcon: document.getElementById('pauseIcon'),
    nextTrackBtn: document.getElementById('nextTrackBtn'),
    muteBtn: document.getElementById('muteBtn'),
    volIcon: document.getElementById('volIcon'),
    volMuteIcon: document.getElementById('volMuteIcon'),
    volumeSlider: document.getElementById('volumeSlider'),
    volumeValue: document.getElementById('volumeValue'),
    trackCount: document.getElementById('trackCount'),
    trackList: document.getElementById('trackList'),
    timerRemaining: document.getElementById('timerRemaining'),
    timerPresets: document.getElementById('timerPresets'),
    toolsTriggerWrap: document.getElementById('toolsTriggerWrap'),
    openToolsBtn: document.getElementById('openToolsBtn'),
    sheetBackdrop: document.getElementById('sheetBackdrop'),
    toolsSheet: document.getElementById('toolsSheet'),
    sheetHandleArea: document.getElementById('sheetHandleArea'),
    closeToolsBtn: document.getElementById('closeToolsBtn'),
    resetTrimBtn: document.getElementById('resetTrimBtn'),
    waveformWrap: document.getElementById('waveformWrap'),
    waveformCanvas: document.getElementById('waveformCanvas'),
    trimStartHandle: document.getElementById('trimStartHandle'),
    trimEndHandle: document.getElementById('trimEndHandle'),
    trimInText: document.getElementById('trimInText'),
    trimLenText: document.getElementById('trimLenText'),
    trimOutText: document.getElementById('trimOutText'),
    crossfadeSlider: document.getElementById('crossfadeSlider'),
    crossfadeValue: document.getElementById('crossfadeValue'),
    resetEqBtn: document.getElementById('resetEqBtn'),
    eqLowSlider: document.getElementById('eqLowSlider'),
    eqLowValue: document.getElementById('eqLowValue'),
    eqMidSlider: document.getElementById('eqMidSlider'),
    eqMidValue: document.getElementById('eqMidValue'),
    eqHighSlider: document.getElementById('eqHighSlider'),
    eqHighValue: document.getElementById('eqHighValue'),
    savePresetForm: document.getElementById('savePresetForm'),
    presetNameInput: document.getElementById('presetNameInput'),
    presetNotice: document.getElementById('presetNotice'),
    presetList: document.getElementById('presetList'),
    storageStatus: document.getElementById('storageStatus'),
    exportBackupBtn: document.getElementById('exportBackupBtn'),
    importBackupBtn: document.getElementById('importBackupBtn'),
    backupInput: document.getElementById('backupInput')
  };

  function generateId() {
    if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
  }

  function formatTime(sec) {
    const s = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
  }

  function formatPreciseTime(sec) {
    const val = Math.max(0, sec || 0);
    const h = Math.floor(val / 3600);
    const m = Math.floor((val % 3600) / 60);
    const s = (val % 60).toFixed(1).padStart(4, '0');
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${s}` : `${pad(m)}:${s}`;
  }

  function stripMp3Ext(filename) {
    return filename.replace(/\.mp3$/i, '').trim() || filename;
  }

  function getCurrentTrack() {
    return state.tracks.find((t) => t.id === state.currentTrackId) || null;
  }

  function getMinGapForTrack(track) {
    const required = Math.max(MIN_LOOP_GAP_SEC, (state.crossfadeMs / 1000) * 2);
    return track ? Math.min(track.duration, required) : required;
  }

  function clampTrimBounds(track, start, end) {
    const dur = track.duration;
    const minGap = getMinGapForTrack(track);
    let s = Math.max(0, Math.min(start, dur - minGap));
    let e = Math.min(dur, Math.max(end, s + minGap));
    if (e - s < minGap) {
      s = Math.max(0, e - minGap);
      e = Math.min(dur, s + minGap);
    }
    return { trimStart: s, trimEnd: e };
  }

  function showError(msg) {
    dom.errorText.textContent = msg;
    dom.errorBanner.hidden = false;
  }

  function clearError() {
    dom.errorBanner.hidden = true;
    dom.errorText.textContent = '';
  }

  function setLoading(delta, text) {
    state.loadingCount = Math.max(0, state.loadingCount + delta);
    if (text) dom.loadingText.textContent = text;
    dom.loadingBar.hidden = state.loadingCount === 0;
  }

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_DATA)) {
          db.createObjectStore(STORE_DATA, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
          db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function dbSaveTrack(meta, arrayBuffer) {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_META, STORE_DATA], 'readwrite');
      tx.objectStore(STORE_META).put(meta);
      tx.objectStore(STORE_DATA).put({ id: meta.id, buffer: arrayBuffer });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    // Read the audio back and confirm every byte landed. A silent partial
    // write would otherwise surface weeks later as a missing track.
    const saved = await dbGetAudioData(meta.id);
    if (!saved || saved.byteLength !== arrayBuffer.byteLength) {
      await dbDeleteTrack(meta.id).catch(() => {});
      throw new Error(`Could not save "${meta.name}" to device storage. The track was not added.`);
    }
  }

  async function dbUpdateTrackMeta(meta) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readwrite');
      tx.objectStore(STORE_META).put(meta);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function dbGetAllMeta() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readonly');
      const req = tx.objectStore(STORE_META).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbGetAudioData(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_DATA, 'readonly');
      const req = tx.objectStore(STORE_DATA).get(id);
      req.onsuccess = () => resolve(req.result ? req.result.buffer : null);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbDeleteTrack(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_META, STORE_DATA], 'readwrite');
      tx.objectStore(STORE_META).delete(id);
      tx.objectStore(STORE_DATA).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function dbPutSetting(key, value) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SETTINGS, 'readwrite');
      tx.objectStore(STORE_SETTINGS).put({ key, value });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function dbGetSetting(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SETTINGS, 'readonly');
      const req = tx.objectStore(STORE_SETTINGS).get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : undefined);
      req.onerror = () => reject(req.error);
    });
  }

  // Ask the browser to exempt this app's storage from automatic eviction.
  // Persisted storage is only removed when the user deliberately clears it.
  async function ensurePersistentStorage() {
    try {
      if (!navigator.storage) return false;
      if (navigator.storage.persisted && await navigator.storage.persisted()) return true;
      if (navigator.storage.persist) return await navigator.storage.persist();
      return false;
    } catch {
      return false;
    }
  }

  async function updateStorageStatus() {
    if (!dom.storageStatus) return;
    try {
      const persisted = navigator.storage && navigator.storage.persisted
        ? await navigator.storage.persisted()
        : false;
      dom.storageStatus.textContent = persisted ? 'Protected' : 'Standard';
    } catch {
      dom.storageStatus.textContent = '';
    }
  }

  async function loadPresetsFromStorage() {
    // Presets live in IndexedDB (the durable store). localStorage is kept as a
    // one-time migration source and a write-through mirror.
    try {
      const stored = await dbGetSetting('presets');
      if (Array.isArray(stored)) {
        state.presets = stored;
        return;
      }
    } catch {}
    try {
      const raw = localStorage.getItem(PRESETS_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      state.presets = Array.isArray(parsed) ? parsed : [];
      if (state.presets.length > 0) {
        dbPutSetting('presets', state.presets).catch(() => {});
      }
    } catch {
      state.presets = [];
    }
  }

  function savePresetsToStorage() {
    dbPutSetting('presets', state.presets).catch(() => {});
    try {
      localStorage.setItem(PRESETS_KEY, JSON.stringify(state.presets));
    } catch {}
  }

  function createSilentWavUrl() {
    const sampleRate = 8000;
    const numSamples = 8000;
    const buf = new ArrayBuffer(44 + numSamples * 2);
    const view = new DataView(buf);
    const writeStr = (off, s) => {
      for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + numSamples * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, numSamples * 2, true);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }

  function createMediaArtwork() {
    if (mediaArtworkUrl) return mediaArtworkUrl;
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const c = canvas.getContext('2d');
    c.fillStyle = '#FAF9F7';
    c.fillRect(0, 0, 256, 256);
    c.strokeStyle = 'rgba(91, 124, 141, 0.28)';
    c.lineWidth = 6;
    c.beginPath();
    c.arc(128, 128, 82, 0, Math.PI * 2);
    c.stroke();
    c.strokeStyle = 'rgba(91, 124, 141, 0.58)';
    c.lineWidth = 7;
    c.beginPath();
    c.arc(128, 128, 52, 0, Math.PI * 2);
    c.stroke();
    c.fillStyle = '#5B7C8D';
    c.beginPath();
    c.arc(128, 128, 20, 0, Math.PI * 2);
    c.fill();
    mediaArtworkUrl = canvas.toDataURL('image/png');
    return mediaArtworkUrl;
  }

  function ensureAudioContext() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioCtx = new Ctx();
      eqLow = audioCtx.createBiquadFilter();
      eqLow.type = 'lowshelf';
      eqLow.frequency.value = 200;
      eqLow.gain.value = state.eq.low;

      eqMid = audioCtx.createBiquadFilter();
      eqMid.type = 'peaking';
      eqMid.frequency.value = 1000;
      eqMid.Q.value = 1;
      eqMid.gain.value = state.eq.mid;

      eqHigh = audioCtx.createBiquadFilter();
      eqHigh.type = 'highshelf';
      eqHigh.frequency.value = 4000;
      eqHigh.gain.value = state.eq.high;

      sleepGain = audioCtx.createGain();
      sleepGain.gain.value = 1;

      masterGain = audioCtx.createGain();
      masterGain.gain.value = state.muted ? 0 : state.volume;

      eqLow.connect(eqMid);
      eqMid.connect(eqHigh);
      eqHigh.connect(sleepGain);
      sleepGain.connect(masterGain);
      masterGain.connect(audioCtx.destination);

      streamDecks = [0, 1].map(() => {
        const el = document.createElement('audio');
        el.preload = 'auto';
        el.playsInline = true;
        const source = audioCtx.createMediaElementSource(el);
        const gain = audioCtx.createGain();
        gain.gain.value = 0;
        source.connect(gain);
        gain.connect(eqLow);
        return { el, source, gain, url: null, stopTimer: null };
      });

      keepAliveUrl = createSilentWavUrl();
      keepAliveEl = document.createElement('audio');
      keepAliveEl.src = keepAliveUrl;
      keepAliveEl.loop = true;
      keepAliveEl.playsInline = true;

      audioCtx.onstatechange = () => {
        if (state.isPlaying && audioCtx.state === 'suspended') {
          audioCtx.resume().catch(() => {});
        }
      };
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  function decodeFrameHeader(bytes, offset) {
    if (offset + 4 > bytes.length) return null;
    const b0 = bytes[offset];
    const b1 = bytes[offset + 1];
    const b2 = bytes[offset + 2];
    const b3 = bytes[offset + 3];
    if (b0 !== 0xFF || (b1 & 0xE0) !== 0xE0) return null;
    const versionBits = (b1 >> 3) & 0x03;
    const layerBits = (b1 >> 1) & 0x03;
    if (versionBits === 1 || layerBits !== 1) return null;
    const bitrateIdx = (b2 >> 4) & 0x0F;
    const srIdx = (b2 >> 2) & 0x03;
    if (bitrateIdx === 0 || bitrateIdx === 15 || srIdx === 3) return null;
    const isMpeg1 = versionBits === 3;
    const bitrate = BITRATE_TABLE[isMpeg1 ? 1 : 2][bitrateIdx] * 1000;
    const sampleRate = SAMPLERATE_TABLE[versionBits][srIdx];
    const paddingBit = (b2 >> 1) & 0x01;
    const samplesPerFrame = isMpeg1 ? 1152 : 576;
    const frameSize = Math.floor(((isMpeg1 ? 144 : 72) * bitrate) / sampleRate) + paddingBit;
    if (frameSize < 24) return null;
    const channelMode = (b3 >> 6) & 0x03;
    const isMono = channelMode === 3;
    return { isMpeg1, bitrate, sampleRate, samplesPerFrame, frameSize, isMono };
  }

  // Parses MPEG Layer III frames and LAME/Xing gapless headers to locate encoder delay and end padding.
  function parseMp3Structure(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    if (bytes.length < 64) return null;

    let offset = 0;
    // Skip leading ID3v2 tag if present before scanning for the first MPEG sync word.
    if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33 && bytes.length >= 10) {
      const size =
        ((bytes[6] & 0x7F) << 21) |
        ((bytes[7] & 0x7F) << 14) |
        ((bytes[8] & 0x7F) << 7) |
        (bytes[9] & 0x7F);
      const hasFooter = (bytes[5] & 0x10) !== 0;
      offset = 10 + size + (hasFooter ? 10 : 0);
    }

    const scanLimit = Math.min(bytes.length - 4, offset + 32768);
    let firstFrameOffset = -1;
    let firstHeader = null;
    for (let i = offset; i < scanLimit; i++) {
      const hdr = decodeFrameHeader(bytes, i);
      if (hdr && i + hdr.frameSize + 4 <= bytes.length) {
        const nextHdr = decodeFrameHeader(bytes, i + hdr.frameSize);
        if (nextHdr && nextHdr.sampleRate === hdr.sampleRate) {
          firstFrameOffset = i;
          firstHeader = hdr;
          break;
        }
      }
    }
    if (firstFrameOffset < 0 || !firstHeader) return null;

    // Inspect the first frame for a Xing/Info VBR header and LAME gapless delay/padding fields.
    const sideInfoSize = firstHeader.isMpeg1
      ? (firstHeader.isMono ? 17 : 32)
      : (firstHeader.isMono ? 9 : 17);
    const xingOffset = firstFrameOffset + 4 + sideInfoSize;
    let hasXing = false;
    let hasLame = false;
    let xingFrames = 0;
    let encoderDelay = 0;
    let encoderPadding = 0;

    if (xingOffset + 12 <= bytes.length) {
      const tag = String.fromCharCode(
        bytes[xingOffset], bytes[xingOffset + 1], bytes[xingOffset + 2], bytes[xingOffset + 3]
      );
      if (tag === 'Xing' || tag === 'Info') {
        hasXing = true;
        const view = new DataView(arrayBuffer);
        const flags = view.getUint32(xingOffset + 4, false);
        let p = xingOffset + 8;
        if (flags & 0x01) {
          xingFrames = view.getUint32(p, false);
          p += 4;
        }
        if (flags & 0x02) p += 4;
        if (flags & 0x04) p += 100;
        if (flags & 0x08) p += 4;

        // LAME/Lavf/Lavc writes a 9-byte encoder version string followed by delay/padding at +21..+23.
        const lameCandidates = [p, xingOffset + 120];
        for (const lamePos of lameCandidates) {
          if (lamePos + 24 <= firstFrameOffset + firstHeader.frameSize && lamePos + 24 <= bytes.length) {
            const enc = String.fromCharCode(
              bytes[lamePos], bytes[lamePos + 1], bytes[lamePos + 2], bytes[lamePos + 3]
            );
            if (enc === 'LAME' || enc === 'Lavf' || enc === 'Lavc' || enc === 'GOGO' || enc === 'L3.9') {
              const b21 = bytes[lamePos + 21];
              const b22 = bytes[lamePos + 22];
              const b23 = bytes[lamePos + 23];
              encoderDelay = (b21 << 4) | (b22 >> 4);
              encoderPadding = ((b22 & 0x0F) << 8) | b23;
              hasLame = true;
              break;
            }
          }
        }
      }
    }

    // Walk frame headers across the file to obtain exact duration and frame offsets for streaming slices.
    let endLimit = bytes.length;
    if (endLimit >= 128 && bytes[endLimit - 128] === 0x54 && bytes[endLimit - 127] === 0x41 && bytes[endLimit - 126] === 0x47) {
      endLimit -= 128;
    }

    const frameOffsets = [];
    const frameSizes = [];
    let pos = firstFrameOffset;
    while (pos + 4 <= endLimit) {
      const hdr = decodeFrameHeader(bytes, pos);
      if (!hdr || pos + hdr.frameSize > bytes.length) {
        let resync = -1;
        const limit = Math.min(endLimit - 4, pos + 2048);
        for (let k = pos + 1; k < limit; k++) {
          const cand = decodeFrameHeader(bytes, k);
          if (cand && cand.sampleRate === firstHeader.sampleRate) {
            resync = k;
            break;
          }
        }
        if (resync < 0) break;
        pos = resync;
        continue;
      }
      frameOffsets.push(pos);
      frameSizes.push(hdr.frameSize);
      pos += hdr.frameSize;
    }

    const audioFrameCount = hasXing ? Math.max(1, frameOffsets.length - 1) : frameOffsets.length;
    const totalFrames = xingFrames > 0 ? xingFrames : audioFrameCount;
    const duration = (totalFrames * firstHeader.samplesPerFrame) / firstHeader.sampleRate;

    return {
      sampleRate: firstHeader.sampleRate,
      samplesPerFrame: firstHeader.samplesPerFrame,
      isMono: firstHeader.isMono,
      hasXing,
      hasLame,
      encoderDelay,
      encoderPadding,
      totalFrames,
      duration,
      frameOffsets,
      frameSizes
    };
  }

  // Fallback silence detector scans RMS windows from both ends to strip encoder padding when no LAME tag exists.
  function detectSilenceBounds(audioBuffer, threshold = 0.003, maxTrimSec = null) {
    const sr = audioBuffer.sampleRate;
    const len = audioBuffer.length;
    const chCount = audioBuffer.numberOfChannels;
    const channels = [];
    for (let c = 0; c < chCount; c++) channels.push(audioBuffer.getChannelData(c));

    const winSize = Math.max(32, Math.floor(sr * 0.002));
    const maxSamples = maxTrimSec != null ? Math.min(len, Math.floor(maxTrimSec * sr)) : len;

    let startSample = 0;
    for (let i = 0; i < maxSamples; i += winSize) {
      const end = Math.min(len, i + winSize);
      let sumSq = 0;
      for (let c = 0; c < chCount; c++) {
        const data = channels[c];
        for (let j = i; j < end; j++) sumSq += data[j] * data[j];
      }
      const rms = Math.sqrt(sumSq / ((end - i) * chCount));
      if (rms >= threshold) {
        startSample = i;
        break;
      }
    }

    let endSample = len;
    const minEnd = maxTrimSec != null ? Math.max(0, len - Math.floor(maxTrimSec * sr)) : 0;
    for (let i = len; i > minEnd; i -= winSize) {
      const start = Math.max(0, i - winSize);
      let sumSq = 0;
      for (let c = 0; c < chCount; c++) {
        const data = channels[c];
        for (let j = start; j < i; j++) sumSq += data[j] * data[j];
      }
      const rms = Math.sqrt(sumSq / ((i - start) * chCount));
      if (rms >= threshold) {
        endSample = i;
        break;
      }
    }

    return {
      startSec: startSample / sr,
      endSec: endSample / sr
    };
  }

  // Determines automatic loop trim points from LAME gapless headers (checking if the browser already trimmed them) or silence detection.
  function computeAutoTrim(audioBuffer, mp3Info) {
    const dur = audioBuffer.duration;
    let startSec = 0;
    let endSec = dur;

    if (mp3Info.hasLame && (mp3Info.encoderDelay > 0 || mp3Info.encoderPadding > 0)) {
      const scale = audioBuffer.sampleRate / mp3Info.sampleRate;
      const expectedRawSamples = mp3Info.totalFrames * mp3Info.samplesPerFrame * scale;
      const expectedGaplessSamples =
        (mp3Info.totalFrames * mp3Info.samplesPerFrame - mp3Info.encoderDelay - mp3Info.encoderPadding) * scale;
      const diffGapless = Math.abs(audioBuffer.length - expectedGaplessSamples);
      const diffRaw = Math.abs(audioBuffer.length - expectedRawSamples);

      if (diffGapless < diffRaw && diffGapless < mp3Info.samplesPerFrame * scale * 0.5) {
        // Browser decoder already applied LAME gapless trim; only trim strict digital zero remnants.
        const fine = detectSilenceBounds(audioBuffer, 0.0005, 0.12);
        startSec = fine.startSec;
        endSec = fine.endSec;
      } else {
        // Browser kept raw MP3 padding frames; apply LAME delay/padding plus any decoded Xing silence frame.
        const extraXing = audioBuffer.length >= (mp3Info.totalFrames + 0.75) * mp3Info.samplesPerFrame * scale
          ? mp3Info.samplesPerFrame / mp3Info.sampleRate
          : 0;
        const lameStart = (mp3Info.encoderDelay / mp3Info.sampleRate) + extraXing;
        const lameEnd = dur - (mp3Info.encoderPadding / mp3Info.sampleRate);
        const fine = detectSilenceBounds(audioBuffer, 0.001, 0.25);
        startSec = Math.max(lameStart, fine.startSec);
        endSec = Math.min(lameEnd, fine.endSec);
      }
    } else {
      const bounds = detectSilenceBounds(audioBuffer, 0.003);
      startSec = bounds.startSec;
      endSec = bounds.endSec;
    }

    if (endSec - startSec < Math.min(dur, MIN_LOOP_GAP_SEC)) {
      return { start: 0, end: dur };
    }
    return { start: Math.max(0, startSec), end: Math.min(dur, endSec) };
  }

  function sliceMp3Frames(arrayBuffer, mp3Info, startIdx, count) {
    const total = mp3Info.frameOffsets.length;
    if (total === 0) return null;
    const sIdx = Math.max(0, Math.min(startIdx, total - 1));
    const eIdx = Math.max(sIdx, Math.min(sIdx + count - 1, total - 1));
    const byteStart = mp3Info.frameOffsets[sIdx];
    const byteEnd = mp3Info.frameOffsets[eIdx] + mp3Info.frameSizes[eIdx];
    return arrayBuffer.slice(byteStart, byteEnd);
  }

  // Computes encoder padding trim for long (>30 min) files without decoding the full PCM buffer.
  async function computeStreamingAutoTrim(ctx, arrayBuffer, mp3Info) {
    const dur = mp3Info.duration;
    if (mp3Info.hasLame && (mp3Info.encoderDelay > 0 || mp3Info.encoderPadding > 0)) {
      const start = mp3Info.encoderDelay / mp3Info.sampleRate;
      const end = dur - (mp3Info.encoderPadding / mp3Info.sampleRate);
      if (end - start >= MIN_LOOP_GAP_SEC) {
        return { start: Math.max(0, start), end: Math.min(dur, end) };
      }
    }

    let startSec = 0;
    let endSec = dur;
    const framesPerSec = mp3Info.sampleRate / mp3Info.samplesPerFrame;
    const edgeFrames = Math.ceil(framesPerSec * 2.5);
    const firstAudioIdx = mp3Info.hasXing ? 1 : 0;

    try {
      const headSlice = sliceMp3Frames(arrayBuffer, mp3Info, firstAudioIdx, edgeFrames);
      if (headSlice) {
        const headBuf = await ctx.decodeAudioData(headSlice);
        startSec = detectSilenceBounds(headBuf, 0.003).startSec;
      }
    } catch {}

    try {
      const tailStartIdx = Math.max(firstAudioIdx, mp3Info.frameOffsets.length - edgeFrames);
      const tailSlice = sliceMp3Frames(arrayBuffer, mp3Info, tailStartIdx, edgeFrames);
      if (tailSlice) {
        const tailBuf = await ctx.decodeAudioData(tailSlice);
        const tailBounds = detectSilenceBounds(tailBuf, 0.003);
        const trailingSilence = Math.max(0, tailBuf.duration - tailBounds.endSec);
        endSec = Math.max(startSec + MIN_LOOP_GAP_SEC, dur - trailingSilence);
      }
    } catch {}

    if (endSec - startSec < Math.min(dur, MIN_LOOP_GAP_SEC)) {
      return { start: 0, end: dur };
    }
    return { start: startSec, end: endSec };
  }

  function extractBufferPeaks(audioBuffer, barCount = 220) {
    const len = audioBuffer.length;
    const chCount = audioBuffer.numberOfChannels;
    const channels = [];
    for (let c = 0; c < chCount; c++) channels.push(audioBuffer.getChannelData(c));

    const peaks = new Array(barCount);
    const blockSize = Math.max(1, Math.floor(len / barCount));
    const stride = Math.max(1, Math.floor(blockSize / 64));
    let maxPeak = 0.001;

    for (let i = 0; i < barCount; i++) {
      const start = i * blockSize;
      const end = Math.min(len, start + blockSize);
      let peak = 0;
      for (let j = start; j < end; j += stride) {
        for (let c = 0; c < chCount; c++) {
          const v = Math.abs(channels[c][j]);
          if (v > peak) peak = v;
        }
      }
      peaks[i] = peak;
      if (peak > maxPeak) maxPeak = peak;
    }

    return peaks.map((p) => Math.round((p / maxPeak) * 1000) / 1000);
  }

  async function scanStreamingPeaks(ctx, arrayBuffer, mp3Info, barCount = 120) {
    const firstAudioIdx = mp3Info.hasXing ? 1 : 0;
    const totalFrames = Math.max(1, mp3Info.frameOffsets.length - firstAudioIdx);
    const peaks = new Array(barCount).fill(0);
    let maxPeak = 0.001;
    let decodedAny = false;

    for (let i = 0; i < barCount; i++) {
      const frameIdx = firstAudioIdx + Math.floor((i / barCount) * totalFrames);
      const slice = sliceMp3Frames(arrayBuffer, mp3Info, frameIdx, 5);
      if (slice) {
        try {
          const buf = await ctx.decodeAudioData(slice);
          const data = buf.getChannelData(0);
          const skip = Math.min(Math.floor(data.length * 0.35), mp3Info.samplesPerFrame * 2);
          let peak = 0;
          for (let j = skip; j < data.length; j += 4) {
            const v = Math.abs(data[j]);
            if (v > peak) peak = v;
          }
          peaks[i] = peak;
          if (peak > maxPeak) maxPeak = peak;
          decodedAny = true;
        } catch {
          peaks[i] = i > 0 ? peaks[i - 1] : 0.3;
        }
      }
      if (i % 12 === 11) {
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    if (!decodedAny) {
      let maxSz = 1;
      for (let i = 0; i < barCount; i++) {
        const idx = firstAudioIdx + Math.floor((i / barCount) * totalFrames);
        const sz = mp3Info.frameSizes[idx] || 1;
        peaks[i] = sz;
        if (sz > maxSz) maxSz = sz;
      }
      return peaks.map((p) => Math.round((0.25 + 0.75 * (p / maxSz)) * 1000) / 1000);
    }

    return peaks.map((p) => Math.round((p / maxPeak) * 1000) / 1000);
  }

  // In-place iterative radix-2 Cooley-Tukey FFT used for per-channel binaural frequency analysis.
  function radix2FFT(re, im) {
    const n = re.length;
    let j = 0;
    for (let i = 0; i < n; i++) {
      if (i < j) {
        let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
        tmp = im[i]; im[i] = im[j]; im[j] = tmp;
      }
      let m = n >> 1;
      while (m >= 1 && j >= m) {
        j -= m;
        m >>= 1;
      }
      j += m;
    }

    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const angleStep = (-2 * Math.PI) / size;
      const wStepRe = Math.cos(angleStep);
      const wStepIm = Math.sin(angleStep);
      for (let start = 0; start < n; start += size) {
        let wRe = 1;
        let wIm = 0;
        for (let k = 0; k < half; k++) {
          const even = start + k;
          const odd = even + half;
          const tRe = wRe * re[odd] - wIm * im[odd];
          const tIm = wRe * im[odd] + wIm * re[odd];
          re[odd] = re[even] - tRe;
          im[odd] = im[even] - tIm;
          re[even] += tRe;
          im[even] += tIm;
          const nextWRe = wRe * wStepRe - wIm * wStepIm;
          wIm = wRe * wStepIm + wIm * wStepRe;
          wRe = nextWRe;
        }
      }
    }
  }

  // Analyzes a few seconds of left and right channels separately via FFT and computes the beat difference.
  function analyzeBinaural(audioBuffer, trimStart = 0, trimEnd = null) {
    if (!audioBuffer || audioBuffer.numberOfChannels < 2) return null;

    const sr = audioBuffer.sampleRate;
    const leftData = audioBuffer.getChannelData(0);
    const rightData = audioBuffer.getChannelData(1);

    const startSample = Math.max(0, Math.floor(trimStart * sr));
    const endSample = Math.min(audioBuffer.length, Math.floor((trimEnd != null ? trimEnd : audioBuffer.duration) * sr));
    const regionLen = endSample - startSample;
    if (regionLen < 2048) return null;

    // 65536-point FFT yields ~0.67 Hz raw bin spacing; parabolic interpolation resolves beats below 0.05 Hz.
    const fftSize = 65536;
    const halfBins = fftSize >> 1;
    const windowLen = Math.min(fftSize, regionLen);
    const hop = Math.floor(windowLen * 0.5);
    const maxFrames = Math.max(1, Math.min(3, Math.floor((regionLen - windowLen) / Math.max(1, hop)) + 1));
    const totalSpan = windowLen + (maxFrames - 1) * hop;
    const baseOffset = startSample + Math.max(0, Math.floor((regionLen - totalSpan) * 0.5));

    const hann = new Float32Array(windowLen);
    for (let i = 0; i < windowLen; i++) {
      hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (windowLen - 1)));
    }

    const computeDominantPeak = (channelData) => {
      const avgMag = new Float64Array(halfBins);
      const re = new Float64Array(fftSize);
      const im = new Float64Array(fftSize);

      for (let f = 0; f < maxFrames; f++) {
        re.fill(0);
        im.fill(0);
        const off = baseOffset + f * hop;
        for (let i = 0; i < windowLen; i++) {
          re[i] = channelData[off + i] * hann[i];
        }
        radix2FFT(re, im);
        for (let b = 0; b < halfBins; b++) {
          avgMag[b] += Math.hypot(re[b], im[b]);
        }
      }

      // Restrict carrier search to 40-1500 Hz where binaural tones reside.
      const minBin = Math.max(2, Math.floor((40 * fftSize) / sr));
      const maxBin = Math.min(halfBins - 2, Math.ceil((1500 * fftSize) / sr));
      let peakBin = -1;
      let peakVal = 0;
      const bandMags = [];

      for (let b = minBin; b <= maxBin; b++) {
        const m = avgMag[b] / maxFrames;
        bandMags.push(m);
        if (m > peakVal) {
          peakVal = m;
          peakBin = b;
        }
      }

      if (peakBin < 0 || peakVal <= 0) return null;
      bandMags.sort((a, b) => a - b);
      const median = bandMags[Math.floor(bandMags.length * 0.5)] || 1e-12;
      // Require a clear tonal peak above the spectral floor so broadband noise is rejected.
      if (peakVal < median * 6) return null;

      // Parabolic interpolation on log magnitudes refines the peak between FFT bins.
      const alpha = Math.log(Math.max(1e-12, avgMag[peakBin - 1]));
      const beta = Math.log(Math.max(1e-12, avgMag[peakBin]));
      const gamma = Math.log(Math.max(1e-12, avgMag[peakBin + 1]));
      const denom = alpha - 2 * beta + gamma;
      const delta = denom !== 0 ? 0.5 * (alpha - gamma) / denom : 0;
      const refinedBin = peakBin + Math.max(-0.5, Math.min(0.5, delta));
      return (refinedBin * sr) / fftSize;
    };

    const leftHz = computeDominantPeak(leftData);
    const rightHz = computeDominantPeak(rightData);
    if (leftHz == null || rightHz == null) return null;

    const beatHz = Math.abs(leftHz - rightHz);
    if (beatHz < 0.5 || beatHz > 100) return null;

    let band = 'Gamma';
    if (beatHz < 4) band = 'Delta';
    else if (beatHz < 8) band = 'Theta';
    else if (beatHz < 13) band = 'Alpha';
    else if (beatHz < 30) band = 'Beta';

    return {
      hz: Math.round(beatHz * 10) / 10,
      band,
      leftHz: Math.round(leftHz * 10) / 10,
      rightHz: Math.round(rightHz * 10) / 10
    };
  }

  async function analyzeStreamingBinaural(ctx, arrayBuffer, mp3Info) {
    if (mp3Info.isMono) return null;
    const framesPerSec = mp3Info.sampleRate / mp3Info.samplesPerFrame;
    const sampleFrames = Math.ceil(framesPerSec * 4.5);
    const midIdx = Math.max(
      mp3Info.hasXing ? 1 : 0,
      Math.floor(mp3Info.frameOffsets.length * 0.35)
    );
    const slice = sliceMp3Frames(arrayBuffer, mp3Info, midIdx, sampleFrames);
    if (!slice) return null;
    try {
      const buf = await ctx.decodeAudioData(slice);
      return analyzeBinaural(buf, 0.15, Math.max(0.5, buf.duration - 0.15));
    } catch {
      return null;
    }
  }

  function cacheDecodedBuffer(id, audioBuffer) {
    if (bufferCache.has(id)) bufferCache.delete(id);
    bufferCache.set(id, audioBuffer);
    while (bufferCache.size > BUFFER_CACHE_LIMIT) {
      const oldestKey = bufferCache.keys().next().value;
      if (oldestKey === state.currentTrackId) break;
      bufferCache.delete(oldestKey);
    }
  }

  async function getTrackDecodedBuffer(track) {
    if (bufferCache.has(track.id)) return bufferCache.get(track.id);
    const ctx = ensureAudioContext();
    const raw = await dbGetAudioData(track.id);
    if (!raw) throw new Error('Track audio missing from storage.');
    const decoded = await ctx.decodeAudioData(raw.slice(0));
    cacheDecodedBuffer(track.id, decoded);
    return decoded;
  }

  async function getTrackObjectUrl(track) {
    if (objectUrlCache.has(track.id)) return objectUrlCache.get(track.id);
    const raw = await dbGetAudioData(track.id);
    if (!raw) throw new Error('Track audio missing from storage.');
    const url = URL.createObjectURL(new Blob([raw], { type: 'audio/mpeg' }));
    objectUrlCache.set(track.id, url);
    return url;
  }

  async function ingestFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    clearError();
    const ctx = ensureAudioContext();
    const failedMessages = [];

    for (const file of files) {
      setLoading(1, `Analyzing "${file.name}"…`);
      try {
        const arrayBuffer = await file.arrayBuffer();

        // Video files (e.g. clips from Gemini): decode the audio track and
        // loop it like any other track; the video itself is shown in the
        // player. Stored with kind:'video' so the UI can frame it.
        const isVideoFile = (file.type && file.type.indexOf('video/') === 0) ||
          /\.(mp4|m4v|mov|webm)$/i.test(file.name);
        if (isVideoFile) {
          let decoded;
          try {
            decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
          } catch {
            throw new Error(`Could not read audio from "${file.name}". MP4 works best.`);
          }
          const duration = decoded.duration;
          const autoTrim = computeAutoTrim(decoded, { hasLame: false });
          const peaks = extractBufferPeaks(decoded, 220);
          const binaural = analyzeBinaural(decoded, autoTrim.start, autoTrim.end);
          const id = generateId();
          const meta = {
            id,
            name: file.name.replace(/\.[^.]+$/, ''),
            size: file.size,
            duration,
            autoTrimStart: autoTrim.start,
            autoTrimEnd: autoTrim.end,
            trimStart: autoTrim.start,
            trimEnd: autoTrim.end,
            isStreaming: false,
            kind: 'video',
            mime: file.type || 'video/mp4',
            peaks,
            binaural,
            addedAt: Date.now()
          };
          await dbSaveTrack(meta, arrayBuffer);
          cacheDecodedBuffer(id, decoded);
          state.tracks.push(meta);
          await applyRestoreMatch(meta);
          if (!state.currentTrackId) state.currentTrackId = id;
          continue;
        }

        const mp3Info = parseMp3Structure(arrayBuffer);
        if (!mp3Info) {
          throw new Error(`"${file.name}" is not a valid MP3 file.`);
        }

        const isStreaming = mp3Info.duration > STREAMING_THRESHOLD_SEC;
        let duration = mp3Info.duration;
        let autoTrim;
        let peaks;
        let binaural;

        if (!isStreaming) {
          let decoded;
          try {
            decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
          } catch {
            throw new Error(`Could not decode "${file.name}".`);
          }
          duration = decoded.duration;
          autoTrim = computeAutoTrim(decoded, mp3Info);
          peaks = extractBufferPeaks(decoded, 220);
          binaural = analyzeBinaural(decoded, autoTrim.start, autoTrim.end);
          const id = generateId();
          const meta = {
            id,
            name: stripMp3Ext(file.name),
            size: file.size,
            duration,
            autoTrimStart: autoTrim.start,
            autoTrimEnd: autoTrim.end,
            trimStart: autoTrim.start,
            trimEnd: autoTrim.end,
            isStreaming: false,
            peaks,
            binaural,
            addedAt: Date.now()
          };
          await dbSaveTrack(meta, arrayBuffer);
          cacheDecodedBuffer(id, decoded);
          state.tracks.push(meta);
          await applyRestoreMatch(meta);
          if (!state.currentTrackId) state.currentTrackId = id;
        } else {
          autoTrim = await computeStreamingAutoTrim(ctx, arrayBuffer, mp3Info);
          setLoading(0, `Scanning waveform for "${file.name}"…`);
          peaks = await scanStreamingPeaks(ctx, arrayBuffer, mp3Info, 120);
          binaural = await analyzeStreamingBinaural(ctx, arrayBuffer, mp3Info);
          const id = generateId();
          const meta = {
            id,
            name: stripMp3Ext(file.name),
            size: file.size,
            duration,
            autoTrimStart: autoTrim.start,
            autoTrimEnd: autoTrim.end,
            trimStart: autoTrim.start,
            trimEnd: autoTrim.end,
            isStreaming: true,
            peaks,
            binaural,
            addedAt: Date.now()
          };
          await dbSaveTrack(meta, arrayBuffer);
          state.tracks.push(meta);
          await applyRestoreMatch(meta);
          if (!state.currentTrackId) state.currentTrackId = id;
        }
      } catch (err) {
        failedMessages.push(err && err.message ? err.message : `Could not load "${file.name}".`);
      } finally {
        setLoading(-1);
      }
    }

    if (failedMessages.length > 0) {
      showError(failedMessages.join(' '));
    }

    ensurePersistentStorage().then(() => updateStorageStatus());
    renderAll();
  }

  // When a backup restore is in progress, reapply the saved loop region to a
  // freshly ingested track matched by name + file size.
  async function applyRestoreMatch(meta) {
    if (!pendingRestore || !Array.isArray(pendingRestore.tracks)) return;
    const saved = pendingRestore.tracks.find((s) => s.name === meta.name && s.size === meta.size);
    if (!saved) return;
    const bounds = clampTrimBounds(meta, saved.trimStart, saved.trimEnd);
    meta.trimStart = bounds.trimStart;
    meta.trimEnd = bounds.trimEnd;
    restoreIdMap.set(saved.id, meta.id);
    await dbUpdateTrackMeta(meta).catch(() => {});
  }

  async function exportBackup() {
    if (state.tracks.length === 0) {
      showError('Add a track before exporting a backup.');
      return;
    }
    clearError();
    setLoading(1, 'Preparing backup…');
    try {
      const backup = {
        app: 'drift',
        version: 1,
        exportedAt: new Date().toISOString(),
        tracks: state.tracks.map((t) => ({
          id: t.id,
          name: t.name,
          size: t.size,
          duration: t.duration,
          trimStart: t.trimStart,
          trimEnd: t.trimEnd,
          isStreaming: t.isStreaming,
          kind: t.kind || 'audio',
          mime: t.mime || null
        })),
        presets: state.presets
      };
      const files = [
        new File([JSON.stringify(backup, null, 2)], 'drift-backup.json', { type: 'application/json' })
      ];
      for (const t of state.tracks) {
        const raw = await dbGetAudioData(t.id);
        if (!raw) continue;
        if (t.kind === 'video') {
          const mime = t.mime || 'video/mp4';
          const ext = mime.indexOf('webm') >= 0 ? 'webm' : (mime.indexOf('quicktime') >= 0 ? 'mov' : 'mp4');
          files.push(new File([raw], `${t.name}.${ext}`, { type: mime }));
        } else {
          files.push(new File([raw], `${t.name}.mp3`, { type: 'audio/mpeg' }));
        }
      }
      if (navigator.canShare && navigator.share && navigator.canShare({ files })) {
        await navigator.share({ files, title: 'Drift library backup' });
      } else {
        for (const f of files) {
          const url = URL.createObjectURL(f);
          const a = document.createElement('a');
          a.href = url;
          a.download = f.name;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 4000);
          await new Promise((r) => setTimeout(r, 350));
        }
      }
    } catch (err) {
      if (!err || err.name !== 'AbortError') {
        showError('Backup export failed. Your library is unchanged.');
      }
    } finally {
      setLoading(-1);
    }
  }

  async function importBackup(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const jsonFile = files.find((f) => /\.json$/i.test(f.name));
    const mp3Files = files.filter((f) => /\.(mp3|mp4|m4v|mov|webm)$/i.test(f.name) || f.type === 'audio/mpeg' || (f.type && f.type.indexOf('video/') === 0));

    if (jsonFile) {
      try {
        const parsed = JSON.parse(await jsonFile.text());
        if (parsed && parsed.app === 'drift' && Array.isArray(parsed.tracks)) {
          pendingRestore = parsed;
          restoreIdMap.clear();
        }
      } catch {}
    }

    if (mp3Files.length > 0) {
      await ingestFiles(mp3Files);
    }

    if (pendingRestore) {
      if (Array.isArray(pendingRestore.presets)) {
        for (const preset of pendingRestore.presets) {
          const newTrackId = restoreIdMap.get(preset.trackId);
          if (!newTrackId) continue;
          const dupe = state.presets.some((p) => p.name === preset.name && p.trackId === newTrackId);
          if (dupe) continue;
          state.presets.push({ ...preset, id: generateId(), trackId: newTrackId });
        }
        savePresetsToStorage();
      }
      pendingRestore = null;
      restoreIdMap.clear();
      renderAll();
    } else if (jsonFile && mp3Files.length === 0) {
      showError('That backup file has no tracks with it. Select the audio/video files from the backup as well.');
    }
  }

  function applyGainCurveSafely(gainParam, curve, startTime, duration, minStartTime = 0) {
    const now = audioCtx.currentTime;
    const t0 = Math.max(startTime, now + 0.003, minStartTime);
    const dur = Math.max(0.015, duration);
    gainParam.setValueCurveAtTime(curve, t0, dur);
    return { start: t0, end: t0 + dur };
  }

  function fadeOutAndClearBufferNodes(fadeSec, now) {
    const t0 = Math.max(now, audioCtx.currentTime + 0.003);
    const dur = Math.max(0.02, fadeSec);
    for (const node of scheduledNodes) {
      if (node.startTime > t0) {
        try { node.source.stop(t0); } catch {}
        try { node.source.disconnect(); } catch {}
        try { node.gain.disconnect(); } catch {}
      } else {
        const curVal = node.gain.gain.value;
        node.gain.gain.cancelScheduledValues(t0);
        node.gain.gain.setValueAtTime(curVal, t0);
        if (curVal > 0.0005) {
          const scaled = new Float32Array(FADE_CURVE_SIZE);
          for (let i = 0; i < FADE_CURVE_SIZE; i++) scaled[i] = FADE_OUT_CURVE[i] * curVal;
          node.gain.gain.setValueCurveAtTime(scaled, t0 + 0.002, dur);
        }
        const src = node.source;
        const g = node.gain;
        setTimeout(() => {
          try { src.stop(); } catch {}
          try { src.disconnect(); } catch {}
          try { g.disconnect(); } catch {}
        }, Math.ceil((dur + 0.15) * 1000));
      }
    }
    scheduledNodes = [];
    activeBufferTrackId = null;
  }

  function fadeOutStreamingDecks(fadeSec, now) {
    const t0 = Math.max(now, audioCtx.currentTime + 0.003);
    const dur = Math.max(0.02, fadeSec);
    for (const deck of streamDecks) {
      if (deck.stopTimer) {
        clearTimeout(deck.stopTimer);
        deck.stopTimer = null;
      }
      const curVal = deck.gain.gain.value;
      deck.gain.gain.cancelScheduledValues(t0);
      deck.gain.gain.setValueAtTime(curVal, t0);
      if (curVal > 0.0005 && !deck.el.paused) {
        const scaled = new Float32Array(FADE_CURVE_SIZE);
        for (let i = 0; i < FADE_CURVE_SIZE; i++) scaled[i] = FADE_OUT_CURVE[i] * curVal;
        deck.gain.gain.setValueCurveAtTime(scaled, t0 + 0.002, dur);
        deck.stopTimer = setTimeout(() => {
          deck.el.pause();
          deck.stopTimer = null;
        }, Math.ceil((dur + 0.12) * 1000));
      } else {
        deck.el.pause();
        deck.gain.gain.setValueAtTime(0, t0);
      }
    }
    streamTrackId = null;
    streamStandbyPrepared = false;
  }

  // Schedules overlapping AudioBufferSourceNodes ahead of AudioContext.currentTime with equal-power seams.
  function scheduleBufferLoops(track, audioBuffer, gen) {
    if (!state.isPlaying || gen !== playbackGen || activeBufferTrackId !== track.id) return;

    const now = audioCtx.currentTime;
    const loopLen = Math.max(0.1, track.trimEnd - track.trimStart);
    const cf = Math.min(state.crossfadeMs / 1000, Math.max(0.05, loopLen * 0.49));
    const step = Math.max(0.05, loopLen - cf);
    const fadeInDur = Math.min(cf, Math.max(0.015, step - 0.005));
    // 3.5s lookahead survives 1 Hz background timer throttling on mobile and desktop browsers.
    const lookahead = Math.max(3.5, cf + 1.0);

    // Garbage-collect finished buffer nodes after their fade-out completes.
    const remaining = [];
    for (const node of scheduledNodes) {
      if (node.fadeOutEndCtx != null && now > node.fadeOutEndCtx + 0.15) {
        try { node.source.stop(); } catch {}
        try { node.source.disconnect(); } catch {}
        try { node.gain.disconnect(); } catch {}
      } else {
        remaining.push(node);
      }
    }
    scheduledNodes = remaining;

    while (nextLoopStartCtx < now + lookahead) {
      const prevNode = scheduledNodes[scheduledNodes.length - 1];
      const minSeam = prevNode ? prevNode.fadeInEndCtx + 0.003 : 0;
      const seamTime = Math.max(nextLoopStartCtx, now + 0.005, minSeam);

      if (prevNode && !prevNode.fadeOutScheduled) {
        const outWindow = applyGainCurveSafely(prevNode.gain.gain, FADE_OUT_CURVE, seamTime, cf, minSeam);
        prevNode.fadeOutStartCtx = outWindow.start;
        prevNode.fadeOutEndCtx = outWindow.end;
        prevNode.fadeOutScheduled = true;
      }

      const source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      const gain = audioCtx.createGain();
      gain.gain.setValueAtTime(0, seamTime);
      const inWindow = applyGainCurveSafely(gain.gain, FADE_IN_CURVE, seamTime, fadeInDur);
      source.connect(gain);
      gain.connect(eqLow);
      source.start(seamTime, track.trimStart);

      scheduledNodes.push({
        source,
        gain,
        startTime: seamTime,
        fadeInEndCtx: inWindow.end,
        bufferOffset: track.trimStart,
        fadeOutScheduled: false,
        fadeOutStartCtx: null,
        fadeOutEndCtx: null
      });

      nextLoopStartCtx = seamTime + step;
    }
  }

  function loadAndSeekDeck(deck, url, targetTime) {
    return new Promise((resolve) => {
      const doSeek = () => {
        const clamped = Math.max(0, Math.min(targetTime, Number.isFinite(deck.el.duration) ? Math.max(0, deck.el.duration - 0.1) : targetTime));
        if (Math.abs(deck.el.currentTime - clamped) < 0.03) {
          resolve();
          return;
        }
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          deck.el.removeEventListener('seeked', finish);
          resolve();
        };
        deck.el.addEventListener('seeked', finish, { once: true });
        try { deck.el.currentTime = clamped; } catch { finish(); }
        setTimeout(finish, 400);
      };

      if (deck.url !== url) {
        deck.url = url;
        deck.el.src = url;
        deck.el.load();
      }
      if (deck.el.readyState >= 1) {
        doSeek();
      } else {
        let loaded = false;
        const onMeta = () => {
          if (loaded) return;
          loaded = true;
          deck.el.removeEventListener('loadedmetadata', onMeta);
          doSeek();
        };
        deck.el.addEventListener('loadedmetadata', onMeta, { once: true });
        setTimeout(onMeta, 1500);
      }
    });
  }

  // Alternating dual-<audio> equal-power crossfade scheduler for tracks longer than 30 minutes.
  async function triggerStreamCrossfade(track, gen, immediate = false) {
    if (streamSwitching || !state.isPlaying || gen !== playbackGen || streamTrackId !== track.id) return;
    streamSwitching = true;
    try {
      const outIdx = activeStreamDeckIdx;
      const inIdx = 1 - outIdx;
      const outDeck = streamDecks[outIdx];
      const inDeck = streamDecks[inIdx];
      const url = await getTrackObjectUrl(track);
      if (!state.isPlaying || gen !== playbackGen) return;

      if (inDeck.stopTimer) {
        clearTimeout(inDeck.stopTimer);
        inDeck.stopTimer = null;
      }
      if (!streamStandbyPrepared || immediate || Math.abs(inDeck.el.currentTime - track.trimStart) > 0.1) {
        await loadAndSeekDeck(inDeck, url, track.trimStart);
      }
      if (!state.isPlaying || gen !== playbackGen) return;

      const cf = Math.min(state.crossfadeMs / 1000, Math.max(0.05, (track.trimEnd - track.trimStart) * 0.49));
      const now = audioCtx.currentTime;
      inDeck.gain.gain.cancelScheduledValues(now);
      inDeck.gain.gain.setValueAtTime(0, now);

      await inDeck.el.play();
      if (!state.isPlaying || gen !== playbackGen) {
        inDeck.el.pause();
        return;
      }

      const t0 = audioCtx.currentTime + 0.008;
      const outVal = outDeck.gain.gain.value;
      outDeck.gain.gain.cancelScheduledValues(t0);
      outDeck.gain.gain.setValueAtTime(outVal, t0);
      const outCurve = new Float32Array(FADE_CURVE_SIZE);
      for (let i = 0; i < FADE_CURVE_SIZE; i++) outCurve[i] = FADE_OUT_CURVE[i] * outVal;
      outDeck.gain.gain.setValueCurveAtTime(outCurve, t0 + 0.002, cf);

      inDeck.gain.gain.cancelScheduledValues(t0);
      inDeck.gain.gain.setValueAtTime(0, t0);
      inDeck.gain.gain.setValueCurveAtTime(FADE_IN_CURVE, t0 + 0.002, cf);

      activeStreamDeckIdx = inIdx;
      streamStandbyPrepared = false;

      if (outDeck.stopTimer) clearTimeout(outDeck.stopTimer);
      outDeck.stopTimer = setTimeout(() => {
        outDeck.el.pause();
        outDeck.stopTimer = null;
      }, Math.ceil((cf + 0.15) * 1000));
    } catch {} finally {
      streamSwitching = false;
    }
  }

  // Applies live crossfade or trim marker updates to the active loop without interrupting playback.
  function rescheduleLiveLoop() {
    const track = getCurrentTrack();
    if (!state.isPlaying || !track || !audioCtx) return;

    const cf = Math.min(state.crossfadeMs / 1000, Math.max(0.05, (track.trimEnd - track.trimStart) * 0.49));

    if (!track.isStreaming && activeBufferTrackId === track.id) {
      const audioBuffer = bufferCache.get(track.id);
      if (!audioBuffer) return;
      const now = audioCtx.currentTime;

      let current = null;
      for (const node of scheduledNodes) {
        if (node.startTime <= now && (!node.fadeOutScheduled || node.fadeOutStartCtx > now)) {
          current = node;
        }
      }

      const toCancel = scheduledNodes.filter((n) => n !== current && n.startTime > now);
      for (const n of toCancel) {
        try { n.source.stop(now); } catch {}
        try { n.source.disconnect(); } catch {}
        try { n.gain.disconnect(); } catch {}
      }
      scheduledNodes = scheduledNodes.filter((n) => !toCancel.includes(n));

      if (current) {
        if (current.fadeOutScheduled && current.fadeOutStartCtx > now) {
          current.fadeOutScheduled = false;
          current.fadeOutStartCtx = null;
          current.fadeOutEndCtx = null;
          const holdTime = Math.max(now + 0.003, current.fadeInEndCtx || now + 0.003);
          current.gain.gain.cancelScheduledValues(holdTime);
          if (now >= (current.fadeInEndCtx || 0)) {
            current.gain.gain.setValueAtTime(1, now + 0.003);
          }
        }

        const currentPos = current.bufferOffset + (now - current.startTime);
        if (currentPos < track.trimStart || currentPos >= track.trimEnd - cf - 0.04) {
          nextLoopStartCtx = Math.max(now + 0.025, (current.fadeInEndCtx || 0) + 0.005);
        } else {
          nextLoopStartCtx = current.startTime + (track.trimEnd - current.bufferOffset) - cf;
        }
        scheduleBufferLoops(track, audioBuffer, playbackGen);
      }
    } else if (track.isStreaming && streamTrackId === track.id) {
      streamStandbyPrepared = false;
      const activeDeck = streamDecks[activeStreamDeckIdx];
      const pos = activeDeck.el.currentTime;
      if (pos < track.trimStart || pos >= track.trimEnd - cf - 0.06) {
        triggerStreamCrossfade(track, playbackGen, true);
      }
    }
  }

  async function startTrackPlayback(track, crossfadeFromCurrent = false) {
    if (!track) return;
    const ctx = ensureAudioContext();
    await ctx.resume().catch(() => {});

    const gen = ++playbackGen;
    const loopLen = Math.max(0.1, track.trimEnd - track.trimStart);
    const cf = Math.min(state.crossfadeMs / 1000, Math.max(0.05, loopLen * 0.49));
    const step = Math.max(0.05, loopLen - cf);
    const entryFade = crossfadeFromCurrent ? Math.min(cf, Math.max(0.015, step - 0.005)) : 0.03;

    try {
      if (!track.isStreaming) {
        const audioBuffer = await getTrackDecodedBuffer(track);
        if (gen !== playbackGen) return;

        const now = ctx.currentTime;
        if (crossfadeFromCurrent) {
          fadeOutAndClearBufferNodes(cf, now);
          fadeOutStreamingDecks(cf, now);
        } else {
          fadeOutAndClearBufferNodes(0.02, now);
          fadeOutStreamingDecks(0.02, now);
        }

        const startAt = ctx.currentTime + 0.02;
        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0, startAt);
        const inWindow = applyGainCurveSafely(gain.gain, FADE_IN_CURVE, startAt + 0.002, entryFade);
        source.connect(gain);
        gain.connect(eqLow);
        source.start(startAt, track.trimStart);

        activeBufferTrackId = track.id;
        scheduledNodes = [{
          source,
          gain,
          startTime: startAt,
          fadeInEndCtx: inWindow.end,
          bufferOffset: track.trimStart,
          fadeOutScheduled: false,
          fadeOutStartCtx: null,
          fadeOutEndCtx: null
        }];

        nextLoopStartCtx = startAt + step;
        state.isPlaying = true;
        state.lastElapsedTick = Date.now();
        armSleepTimerIfNeeded();

        if (keepAliveEl && keepAliveEl.paused) {
          keepAliveEl.play().catch(() => {});
        }
        scheduleBufferLoops(track, audioBuffer, gen);
      } else {
        const url = await getTrackObjectUrl(track);
        if (gen !== playbackGen) return;

        const targetIdx = crossfadeFromCurrent && streamTrackId ? (1 - activeStreamDeckIdx) : 0;
        const targetDeck = streamDecks[targetIdx];
        const otherDeck = streamDecks[1 - targetIdx];

        if (targetDeck.stopTimer) {
          clearTimeout(targetDeck.stopTimer);
          targetDeck.stopTimer = null;
        }
        await loadAndSeekDeck(targetDeck, url, track.trimStart);
        if (gen !== playbackGen) return;

        const now = ctx.currentTime;
        if (crossfadeFromCurrent) {
          fadeOutAndClearBufferNodes(cf, now);
          if (!otherDeck.el.paused) {
            const curVal = otherDeck.gain.gain.value;
            otherDeck.gain.gain.cancelScheduledValues(now + 0.005);
            otherDeck.gain.gain.setValueAtTime(curVal, now + 0.005);
            const outCurve = new Float32Array(FADE_CURVE_SIZE);
            for (let i = 0; i < FADE_CURVE_SIZE; i++) outCurve[i] = FADE_OUT_CURVE[i] * curVal;
            otherDeck.gain.gain.setValueCurveAtTime(outCurve, now + 0.007, cf);
            otherDeck.stopTimer = setTimeout(() => {
              otherDeck.el.pause();
              otherDeck.stopTimer = null;
            }, Math.ceil((cf + 0.15) * 1000));
          }
        } else {
          fadeOutAndClearBufferNodes(0.02, now);
          otherDeck.el.pause();
          otherDeck.gain.gain.setValueAtTime(0, now);
        }

        targetDeck.gain.gain.cancelScheduledValues(now);
        targetDeck.gain.gain.setValueAtTime(0, now);
        await targetDeck.el.play();
        if (gen !== playbackGen) {
          targetDeck.el.pause();
          return;
        }

        applyGainCurveSafely(targetDeck.gain.gain, FADE_IN_CURVE, ctx.currentTime + 0.005, entryFade);
        activeStreamDeckIdx = targetIdx;
        streamTrackId = track.id;
        streamStandbyPrepared = false;
        state.isPlaying = true;
        state.lastElapsedTick = Date.now();
        armSleepTimerIfNeeded();

        if (keepAliveEl && !keepAliveEl.paused) {
          keepAliveEl.pause();
        }
      }

      updateMediaSession();
      renderTransport();
      startPlayheadLoopIfVisible();
    } catch (err) {
      state.isPlaying = false;
      showError(`Could not play "${track.name}": ${err.message || 'playback error'}.`);
      renderTransport();
    }
  }

  function stopPlayback(fadeSec = 0.04) {
    playbackGen++;
    state.isPlaying = false;
    state.lastElapsedTick = null;

    if (state.sleepEndTime) {
      state.sleepRemainingSec = Math.max(0, (state.sleepEndTime - Date.now()) / 1000);
      state.sleepEndTime = null;
      state.sleepFadeActive = false;
      if (sleepGain && audioCtx) {
        const now = audioCtx.currentTime;
        sleepGain.gain.cancelScheduledValues(now);
        sleepGain.gain.setValueAtTime(1, now);
      }
    }

    if (audioCtx) {
      const now = audioCtx.currentTime;
      fadeOutAndClearBufferNodes(fadeSec, now);
      fadeOutStreamingDecks(fadeSec, now);
    }

    if (keepAliveEl && !keepAliveEl.paused) {
      keepAliveEl.pause();
    }

    updateMediaSession();
    renderTransport();
    stopPlayheadLoop();
  }

  function armSleepTimerIfNeeded() {
    if (state.sleepMinutes > 0 && state.sleepRemainingSec > 0 && !state.sleepEndTime) {
      state.sleepEndTime = Date.now() + state.sleepRemainingSec * 1000;
      state.sleepFadeActive = false;
      const fadeWindow = Math.min(60, state.sleepTotalSec);
      if (state.sleepRemainingSec <= fadeWindow && sleepGain && audioCtx) {
        const frac = Math.max(0.001, state.sleepRemainingSec / Math.max(0.1, fadeWindow));
        const now = audioCtx.currentTime;
        sleepGain.gain.cancelScheduledValues(now);
        sleepGain.gain.setValueAtTime(frac, now);
        sleepGain.gain.linearRampToValueAtTime(0.0001, now + state.sleepRemainingSec);
        state.sleepFadeActive = true;
      }
    }
  }

  function setSleepTimer(minutes) {
    state.sleepMinutes = minutes;
    state.sleepFadeActive = false;

    if (sleepGain && audioCtx) {
      const now = audioCtx.currentTime;
      sleepGain.gain.cancelScheduledValues(now);
      sleepGain.gain.setValueAtTime(sleepGain.gain.value, now);
      sleepGain.gain.linearRampToValueAtTime(1, now + 0.08);
    }

    if (minutes <= 0) {
      state.sleepTotalSec = 0;
      state.sleepRemainingSec = 0;
      state.sleepEndTime = null;
    } else {
      state.sleepTotalSec = minutes * 60;
      state.sleepRemainingSec = state.sleepTotalSec;
      state.sleepEndTime = state.isPlaying ? Date.now() + state.sleepTotalSec * 1000 : null;
    }
    renderSleepTimer();
  }

  // Heartbeat runs loop lookahead scheduling, streaming pre-seek/crossfade, elapsed clock, and sleep fade.
  function schedulerTick() {
    const nowMs = Date.now();

    if (state.isPlaying) {
      if (state.lastElapsedTick != null) {
        const dt = (nowMs - state.lastElapsedTick) / 1000;
        if (dt > 0 && dt < 10) {
          state.elapsedSec += dt;
          dom.elapsedTime.textContent = formatTime(state.elapsedSec);
        }
      }
      state.lastElapsedTick = nowMs;
      updateLoopProgress();

      const track = getCurrentTrack();
      if (track && audioCtx) {
        if (!track.isStreaming && activeBufferTrackId === track.id) {
          const buf = bufferCache.get(track.id);
          if (buf) scheduleBufferLoops(track, buf, playbackGen);
        } else if (track.isStreaming && streamTrackId === track.id && !streamSwitching) {
          const activeDeck = streamDecks[activeStreamDeckIdx];
          const standbyDeck = streamDecks[1 - activeStreamDeckIdx];
          const cf = Math.min(state.crossfadeMs / 1000, Math.max(0.05, (track.trimEnd - track.trimStart) * 0.49));
          const remaining = (track.trimEnd - cf) - activeDeck.el.currentTime;

          if (remaining <= 5 && !streamStandbyPrepared) {
            streamStandbyPrepared = true;
            getTrackObjectUrl(track).then((url) => loadAndSeekDeck(standbyDeck, url, track.trimStart)).catch(() => {
              streamStandbyPrepared = false;
            });
          }
          if (remaining <= 0.14 || activeDeck.el.ended) {
            triggerStreamCrossfade(track, playbackGen, false);
          }
        }
      }

      if (state.sleepEndTime != null) {
        const remSec = Math.max(0, (state.sleepEndTime - nowMs) / 1000);
        state.sleepRemainingSec = remSec;
        const fadeWindow = Math.min(60, state.sleepTotalSec);

        if (remSec <= fadeWindow && remSec > 0 && !state.sleepFadeActive && sleepGain && audioCtx) {
          state.sleepFadeActive = true;
          const nowCtx = audioCtx.currentTime;
          sleepGain.gain.cancelScheduledValues(nowCtx);
          sleepGain.gain.setValueAtTime(sleepGain.gain.value, nowCtx);
          sleepGain.gain.linearRampToValueAtTime(0.0001, nowCtx + remSec);
        }

        if (remSec <= 0) {
          stopPlayback(0.02);
          state.sleepMinutes = 0;
          state.sleepTotalSec = 0;
          state.sleepRemainingSec = 0;
          state.sleepEndTime = null;
          state.sleepFadeActive = false;
          if (sleepGain && audioCtx) {
            const nowCtx = audioCtx.currentTime;
            sleepGain.gain.cancelScheduledValues(nowCtx);
            sleepGain.gain.setValueAtTime(1, nowCtx);
          }
          renderSleepTimer();
        } else {
          dom.timerRemaining.textContent = formatTime(Math.ceil(remSec));
        }
      }
    }
  }

  function startScheduler() {
    try {
      const workerCode = 'setInterval(() => postMessage(0), 120);';
      const url = URL.createObjectURL(new Blob([workerCode], { type: 'application/javascript' }));
      schedulerWorker = new Worker(url);
      schedulerWorker.onmessage = schedulerTick;
      URL.revokeObjectURL(url);
    } catch {
      schedulerFallbackId = setInterval(schedulerTick, 120);
    }
  }

  function getCurrentPlayhead() {
    const track = getCurrentTrack();
    if (!track || !state.isPlaying || !audioCtx) return null;
    if (!track.isStreaming && activeBufferTrackId === track.id) {
      const now = audioCtx.currentTime;
      for (let i = scheduledNodes.length - 1; i >= 0; i--) {
        const n = scheduledNodes[i];
        if (n.startTime <= now) {
          const pos = n.bufferOffset + (now - n.startTime);
          return Math.max(0, Math.min(track.duration, pos));
        }
      }
    } else if (track.isStreaming && streamTrackId === track.id) {
      return streamDecks[activeStreamDeckIdx].el.currentTime;
    }
    return null;
  }

  function selectTrack(trackId) {
    const track = state.tracks.find((t) => t.id === trackId);
    if (!track) return;
    const changed = state.currentTrackId !== trackId;
    state.currentTrackId = trackId;

    const clamped = clampTrimBounds(track, track.trimStart, track.trimEnd);
    track.trimStart = clamped.trimStart;
    track.trimEnd = clamped.trimEnd;

    renderAll();

    if (changed && state.isPlaying) {
      startTrackPlayback(track, true);
    } else {
      updateMediaSession();
    }
  }

  function stepTrack(delta) {
    if (state.tracks.length < 2) return;
    const idx = state.tracks.findIndex((t) => t.id === state.currentTrackId);
    const nextIdx = (idx + delta + state.tracks.length) % state.tracks.length;
    selectTrack(state.tracks[nextIdx].id);
  }

  async function removeTrack(trackId) {
    const idx = state.tracks.findIndex((t) => t.id === trackId);
    if (idx < 0) return;

    const wasCurrent = state.currentTrackId === trackId;
    if (wasCurrent && state.isPlaying) {
      stopPlayback(0.05);
    }

    state.tracks.splice(idx, 1);
    bufferCache.delete(trackId);
    if (objectUrlCache.has(trackId)) {
      URL.revokeObjectURL(objectUrlCache.get(trackId));
      objectUrlCache.delete(trackId);
    }
    await dbDeleteTrack(trackId).catch(() => {});

    if (wasCurrent) {
      state.currentTrackId = state.tracks.length > 0
        ? state.tracks[Math.min(idx, state.tracks.length - 1)].id
        : null;
      if (!state.currentTrackId && state.sheetOpen) {
        closeToolsSheet();
      }
    }

    renderAll();
    updateMediaSession();
  }

  function applyVolume(vol, muted = state.muted) {
    state.volume = Math.max(0, Math.min(1, vol));
    state.muted = muted;
    if (masterGain && audioCtx) {
      const target = state.muted ? 0 : state.volume;
      masterGain.gain.setTargetAtTime(target, audioCtx.currentTime, 0.015);
    }
    dom.volumeSlider.value = String(Math.round(state.volume * 100));
    dom.volumeValue.textContent = `${Math.round(state.volume * 100)}%`;
    dom.volIcon.hidden = state.muted || state.volume === 0;
    dom.volMuteIcon.hidden = !(state.muted || state.volume === 0);
    dom.muteBtn.setAttribute('aria-label', state.muted ? 'Unmute' : 'Mute');
  }

  function applyEq(low, mid, high) {
    state.eq = {
      low: Math.max(-12, Math.min(12, low)),
      mid: Math.max(-12, Math.min(12, mid)),
      high: Math.max(-12, Math.min(12, high))
    };
    if (audioCtx) {
      const now = audioCtx.currentTime;
      eqLow.gain.setTargetAtTime(state.eq.low, now, 0.02);
      eqMid.gain.setTargetAtTime(state.eq.mid, now, 0.02);
      eqHigh.gain.setTargetAtTime(state.eq.high, now, 0.02);
    }
    renderEq();
  }

  function applyCrossfadeMs(ms) {
    let clampedMs = Math.max(MIN_CROSSFADE_MS, Math.min(MAX_CROSSFADE_MS, Math.round(ms)));
    const track = getCurrentTrack();
    if (track) {
      const maxAllowedMs = Math.max(MIN_CROSSFADE_MS, Math.floor((track.duration * 0.5) * 1000));
      clampedMs = Math.min(clampedMs, maxAllowedMs);
    }
    state.crossfadeMs = clampedMs;
    dom.crossfadeSlider.value = String(clampedMs);
    dom.crossfadeValue.textContent = `${clampedMs} ms`;

    if (track) {
      const bounds = clampTrimBounds(track, track.trimStart, track.trimEnd);
      if (bounds.trimStart !== track.trimStart || bounds.trimEnd !== track.trimEnd) {
        track.trimStart = bounds.trimStart;
        track.trimEnd = bounds.trimEnd;
        scheduleTrimPersist(track);
        renderTrimView();
      }
      if (state.isPlaying) {
        rescheduleLiveLoop();
      }
    }
  }

  function scheduleTrimPersist(track) {
    if (trimSaveTimeout) clearTimeout(trimSaveTimeout);
    trimSaveTimeout = setTimeout(() => {
      dbUpdateTrackMeta(track).catch(() => {});
    }, 250);
  }

  function updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const track = getCurrentTrack();
    if (!track) {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
      return;
    }
    const artist = track.binaural
      ? `${track.binaural.hz.toFixed(1)} Hz · ${track.binaural.band}`
      : 'Seamless Loop';
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.name,
      artist,
      album: 'Drift',
      artwork: [{ src: createMediaArtwork(), sizes: '256x256', type: 'image/png' }]
    });
    navigator.mediaSession.playbackState = state.isPlaying ? 'playing' : 'paused';
  }

  function setupMediaSessionHandlers() {
    if (!('mediaSession' in navigator)) return;
    const safeHandle = (action, fn) => {
      try { navigator.mediaSession.setActionHandler(action, fn); } catch {}
    };
    safeHandle('play', () => {
      const track = getCurrentTrack();
      if (track && !state.isPlaying) startTrackPlayback(track, false);
    });
    safeHandle('pause', () => {
      if (state.isPlaying) stopPlayback(0.04);
    });
    safeHandle('stop', () => {
      if (state.isPlaying) stopPlayback(0.04);
    });
    safeHandle('previoustrack', () => stepTrack(-1));
    safeHandle('nexttrack', () => stepTrack(1));
  }

  function renderAll() {
    const hasTracks = state.tracks.length > 0;
    dom.emptyState.hidden = hasTracks;
    dom.playerView.hidden = !hasTracks;
    dom.headerAddBtn.hidden = !hasTracks;
    dom.toolsTriggerWrap.hidden = !hasTracks;

    syncAppChrome();

    if (!hasTracks) return;

    const track = getCurrentTrack();
    dom.currentTrackTitle.textContent = track ? track.name : 'Select a track';
    if (track && track.binaural) {
      dom.binauralReadout.textContent = `${track.binaural.hz.toFixed(1)} Hz · ${track.binaural.band}`;
      dom.binauralReadout.classList.remove('neutral');
    } else {
      dom.binauralReadout.textContent = 'No binaural beat detected';
      dom.binauralReadout.classList.add('neutral');
    }

    dom.elapsedTime.textContent = formatTime(state.elapsedSec);
    dom.prevTrackBtn.disabled = state.tracks.length < 2;
    dom.nextTrackBtn.disabled = state.tracks.length < 2;

    renderTransport();
    renderTrackList();
    renderSleepTimer();
    renderTrimView();
    renderEq();
    renderPresets();
  }

  function renderTransport() {
    dom.playPauseBtn.classList.toggle('playing', state.isPlaying);
    dom.playPauseBtn.setAttribute('aria-label', state.isPlaying ? 'Pause' : 'Play');
    dom.playIcon.hidden = state.isPlaying;
    dom.pauseIcon.hidden = !state.isPlaying;
    document.body.classList.toggle('is-playing', state.isPlaying);
    syncTransportChrome();
  }

  function updateLoopProgress() {
    if (!dom.loopProgressFill) return;
    const track = getCurrentTrack();
    const playhead = track ? getCurrentPlayhead() : null;
    let pct = 0;
    if (track && playhead != null) {
      const span = Math.max(0.1, track.trimEnd - track.trimStart);
      pct = Math.min(1, Math.max(0, (playhead - track.trimStart) / span));
    }
    dom.loopProgressFill.style.width = `${(pct * 100).toFixed(1)}%`;
    syncProgressChrome(track, playhead, pct);
  }

  function renderTrackList() {
    dom.trackCount.textContent = String(state.tracks.length);
    dom.trackList.innerHTML = '';

    for (const track of state.tracks) {
      const li = document.createElement('li');
      li.className = 'track-item' + (track.id === state.currentTrackId ? ' active' : '');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(track.id === state.currentTrackId));

      const selectBtn = document.createElement('button');
      selectBtn.type = 'button';
      selectBtn.className = 'track-select-btn';
      selectBtn.addEventListener('click', () => selectTrack(track.id));

      const mainWrap = document.createElement('span');
      mainWrap.className = 'track-item-main';
      const dot = document.createElement('span');
      dot.className = 'track-dot';
      const nameSpan = document.createElement('span');
      nameSpan.className = 'track-item-name';
      nameSpan.textContent = track.name;
      if (track.kind === 'video') {
        const chip = document.createElement('span');
        chip.className = 'track-kind-chip';
        chip.textContent = 'Video';
        mainWrap.append(dot, nameSpan, chip);
      } else {
        mainWrap.append(dot, nameSpan);
      }

      const durSpan = document.createElement('span');
      durSpan.className = 'track-item-dur';
      durSpan.textContent = formatTime(track.duration);

      selectBtn.append(mainWrap, durSpan);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'track-remove-btn';
      removeBtn.setAttribute('aria-label', `Remove ${track.name}`);
      removeBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeTrack(track.id);
      });

      li.append(selectBtn, removeBtn);
      dom.trackList.appendChild(li);
    }
  }

  function renderSleepTimer() {
    const buttons = dom.timerPresets.querySelectorAll('.pill-btn');
    for (const btn of buttons) {
      const mins = Number(btn.dataset.minutes);
      btn.classList.toggle('active', mins === state.sleepMinutes);
    }
    if (state.sleepMinutes <= 0) {
      dom.timerRemaining.textContent = 'Off';
      dom.timerRemaining.classList.add('idle');
    } else {
      dom.timerRemaining.textContent = formatTime(Math.ceil(state.sleepRemainingSec));
      dom.timerRemaining.classList.remove('idle');
    }
  }

  function renderEq() {
    const fmt = (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;
    dom.eqLowSlider.value = String(state.eq.low);
    dom.eqMidSlider.value = String(state.eq.mid);
    dom.eqHighSlider.value = String(state.eq.high);
    dom.eqLowValue.textContent = fmt(state.eq.low);
    dom.eqMidValue.textContent = fmt(state.eq.mid);
    dom.eqHighValue.textContent = fmt(state.eq.high);
  }

  function renderTrimView() {
    const track = getCurrentTrack();
    if (!track) return;
    dom.trimInText.textContent = formatPreciseTime(track.trimStart);
    dom.trimOutText.textContent = formatPreciseTime(track.trimEnd);
    dom.trimLenText.textContent = formatPreciseTime(Math.max(0, track.trimEnd - track.trimStart));

    const startPct = (track.trimStart / track.duration) * 100;
    const endPct = (track.trimEnd / track.duration) * 100;
    dom.trimStartHandle.style.left = `${startPct}%`;
    dom.trimEndHandle.style.left = `${endPct}%`;
    dom.trimStartHandle.setAttribute('aria-valuenow', startPct.toFixed(1));
    dom.trimEndHandle.setAttribute('aria-valuenow', endPct.toFixed(1));

    dom.crossfadeSlider.value = String(state.crossfadeMs);
    dom.crossfadeValue.textContent = `${state.crossfadeMs} ms`;
    drawWaveform();
  }

  function drawWaveform() {
    const track = getCurrentTrack();
    if (!track || !state.sheetOpen || state.activeTab !== 'trim') return;
    const canvas = dom.waveformCanvas;
    const rect = dom.waveformWrap.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const width = rect.width;
    const height = rect.height;
    ctx.clearRect(0, 0, width, height);

    const startX = (track.trimStart / track.duration) * width;
    const endX = (track.trimEnd / track.duration) * width;
    const dark = getEffectiveTheme() === 'dark';

    ctx.fillStyle = dark ? 'rgba(0, 0, 0, 0.32)' : 'rgba(28, 32, 38, 0.045)';
    ctx.fillRect(0, 0, startX, height);
    ctx.fillRect(endX, 0, width - endX, height);

    ctx.fillStyle = dark ? 'rgba(56, 150, 248, 0.10)' : 'rgba(91, 124, 141, 0.07)';
    ctx.fillRect(startX, 0, Math.max(0, endX - startX), height);

    const peaks = track.peaks || [];
    const count = peaks.length;
    if (count > 0) {
      const barStep = width / count;
      const barWidth = Math.max(1.2, barStep * 0.58);
      const midY = height * 0.5;
      const maxBarH = height * 0.78;

      for (let i = 0; i < count; i++) {
        const x = i * barStep + (barStep - barWidth) * 0.5;
        const barH = Math.max(3, peaks[i] * maxBarH);
        const inside = x + barWidth * 0.5 >= startX && x + barWidth * 0.5 <= endX;
        ctx.fillStyle = inside
          ? (dark ? '#3FA9F5' : '#5B7C8D')
          : (dark ? 'rgba(157, 178, 204, 0.22)' : 'rgba(28, 32, 38, 0.18)');
        ctx.fillRect(x, midY - barH * 0.5, barWidth, barH);
      }
    }

    const playhead = getCurrentPlayhead();
    if (playhead != null) {
      const px = (playhead / track.duration) * width;
      ctx.fillStyle = dark ? '#EDF4FF' : '#1C2026';
      ctx.fillRect(px - 0.75, 0, 1.5, height);
    }
  }

  function startPlayheadLoopIfVisible() {
    if (playheadRafId != null) return;
    if (!state.isPlaying || !state.sheetOpen || state.activeTab !== 'trim') return;
    const tick = () => {
      if (!state.isPlaying || !state.sheetOpen || state.activeTab !== 'trim') {
        playheadRafId = null;
        return;
      }
      drawWaveform();
      playheadRafId = requestAnimationFrame(tick);
    };
    playheadRafId = requestAnimationFrame(tick);
  }

  function stopPlayheadLoop() {
    if (playheadRafId != null) {
      cancelAnimationFrame(playheadRafId);
      playheadRafId = null;
    }
    drawWaveform();
  }

  function showPresetNotice(msg, isError = false) {
    dom.presetNotice.textContent = msg;
    dom.presetNotice.classList.toggle('error', isError);
    dom.presetNotice.hidden = false;
  }

  function clearPresetNotice() {
    dom.presetNotice.hidden = true;
    dom.presetNotice.textContent = '';
  }

  function renderPresets() {
    dom.presetList.innerHTML = '';
    if (state.presets.length === 0) {
      const li = document.createElement('li');
      li.className = 'preset-empty';
      li.textContent = 'No saved presets yet.';
      dom.presetList.appendChild(li);
      return;
    }

    for (const preset of state.presets) {
      const li = document.createElement('li');
      li.className = 'preset-item';

      if (state.editingPresetId === preset.id) {
        const form = document.createElement('form');
        form.className = 'preset-edit-form';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'text-input';
        input.maxLength = 48;
        input.value = preset.name;
        input.required = true;
        input.setAttribute('aria-label', 'Rename preset');

        const saveBtn = document.createElement('button');
        saveBtn.type = 'submit';
        saveBtn.className = 'primary-btn compact';
        saveBtn.textContent = 'Save';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'icon-btn subtle';
        cancelBtn.setAttribute('aria-label', 'Cancel rename');
        cancelBtn.innerHTML = '&times;';
        cancelBtn.addEventListener('click', () => {
          state.editingPresetId = null;
          renderPresets();
        });

        form.addEventListener('submit', (e) => {
          e.preventDefault();
          const trimmed = input.value.trim();
          if (!trimmed) return;
          preset.name = trimmed;
          state.editingPresetId = null;
          savePresetsToStorage();
          clearPresetNotice();
          renderPresets();
        });

        form.append(input, saveBtn, cancelBtn);
        li.appendChild(form);
        setTimeout(() => input.focus(), 0);
      } else {
        const row = document.createElement('div');
        row.className = 'preset-row';

        const loadBtn = document.createElement('button');
        loadBtn.type = 'button';
        loadBtn.className = 'preset-load-btn';
        const nameEl = document.createElement('span');
        nameEl.className = 'preset-name';
        nameEl.textContent = preset.name;
        const subEl = document.createElement('span');
        subEl.className = 'preset-sub';
        subEl.textContent = `${preset.trackName} · ${preset.crossfadeMs} ms`;
        loadBtn.append(nameEl, subEl);
        loadBtn.addEventListener('click', () => loadPreset(preset));

        const actions = document.createElement('div');
        actions.className = 'preset-actions';

        const renameBtn = document.createElement('button');
        renameBtn.type = 'button';
        renameBtn.className = 'icon-btn subtle';
        renameBtn.setAttribute('aria-label', `Rename ${preset.name}`);
        renameBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>';
        renameBtn.addEventListener('click', () => {
          state.editingPresetId = preset.id;
          renderPresets();
        });

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'icon-btn subtle';
        delBtn.setAttribute('aria-label', `Delete ${preset.name}`);
        delBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>';
        delBtn.addEventListener('click', () => {
          state.presets = state.presets.filter((p) => p.id !== preset.id);
          savePresetsToStorage();
          clearPresetNotice();
          renderPresets();
        });

        actions.append(renameBtn, delBtn);
        row.append(loadBtn, actions);
        li.appendChild(row);
      }

      dom.presetList.appendChild(li);
    }
  }

  function loadPreset(preset) {
    const track = state.tracks.find((t) => t.id === preset.trackId);
    if (!track) {
      showPresetNotice(
        `Cannot load "${preset.name}": track "${preset.trackName}" has been removed from your library.`,
        true
      );
      return;
    }

    clearPresetNotice();
    state.crossfadeMs = Math.max(MIN_CROSSFADE_MS, Math.min(MAX_CROSSFADE_MS, preset.crossfadeMs));
    const bounds = clampTrimBounds(track, preset.trimStart, preset.trimEnd);
    track.trimStart = bounds.trimStart;
    track.trimEnd = bounds.trimEnd;
    dbUpdateTrackMeta(track).catch(() => {});

    applyEq(preset.eq.low, preset.eq.mid, preset.eq.high);
    applyVolume(preset.volume, false);

    const switched = state.currentTrackId !== track.id;
    state.currentTrackId = track.id;
    renderAll();

    if (state.isPlaying) {
      if (switched) {
        startTrackPlayback(track, true);
      } else {
        rescheduleLiveLoop();
      }
    } else {
      updateMediaSession();
    }
    showPresetNotice(`Loaded "${preset.name}".`, false);
  }

  function openToolsSheet() {
    state.sheetOpen = true;
    dom.sheetBackdrop.hidden = false;
    dom.toolsSheet.hidden = false;
    dom.openToolsBtn.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => {
      dom.sheetBackdrop.classList.add('open');
      dom.toolsSheet.classList.add('open');
      renderTrimView();
      startPlayheadLoopIfVisible();
    });
  }

  function closeToolsSheet() {
    state.sheetOpen = false;
    state.editingPresetId = null;
    dom.sheetBackdrop.classList.remove('open');
    dom.toolsSheet.classList.remove('open');
    dom.openToolsBtn.setAttribute('aria-expanded', 'false');
    stopPlayheadLoop();
    setTimeout(() => {
      if (!state.sheetOpen) {
        dom.sheetBackdrop.hidden = true;
        dom.toolsSheet.hidden = true;
      }
    }, 280);
  }

  function switchTab(tabName) {
    state.activeTab = tabName;
    const tabs = dom.toolsSheet.querySelectorAll('.tab-btn');
    for (const btn of tabs) {
      const active = btn.dataset.tab === tabName;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', String(active));
    }
    for (const name of ['trim', 'eq', 'presets']) {
      const panel = document.getElementById(`tab-${name}`);
      panel.hidden = name !== tabName;
      panel.classList.toggle('active', name === tabName);
    }
    if (tabName === 'trim') {
      requestAnimationFrame(() => {
        renderTrimView();
        startPlayheadLoopIfVisible();
      });
    } else {
      stopPlayheadLoop();
    }
  }

  function setupTrimInteractions() {
    let dragging = null;

    const updateFromClientX = (clientX) => {
      const track = getCurrentTrack();
      if (!track || !dragging) return;
      const rect = dom.waveformWrap.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
      const sec = ratio * track.duration;
      const minGap = getMinGapForTrack(track);

      if (dragging === 'start') {
        track.trimStart = Math.max(0, Math.min(sec, track.trimEnd - minGap));
      } else {
        track.trimEnd = Math.min(track.duration, Math.max(sec, track.trimStart + minGap));
      }
      renderTrimView();
      if (state.isPlaying) rescheduleLiveLoop();
    };

    const bindHandle = (el, which) => {
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        dragging = which;
        el.setPointerCapture(e.pointerId);
        updateFromClientX(e.clientX);
      });
      el.addEventListener('pointermove', (e) => {
        if (dragging !== which) return;
        updateFromClientX(e.clientX);
      });
      const endDrag = () => {
        if (dragging !== which) return;
        dragging = null;
        const track = getCurrentTrack();
        if (track) scheduleTrimPersist(track);
      };
      el.addEventListener('pointerup', endDrag);
      el.addEventListener('pointercancel', endDrag);
      el.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        const track = getCurrentTrack();
        if (!track) return;
        e.preventDefault();
        const step = e.shiftKey ? 5 : 0.5;
        const dir = e.key === 'ArrowRight' ? 1 : -1;
        const minGap = getMinGapForTrack(track);
        if (which === 'start') {
          track.trimStart = Math.max(0, Math.min(track.trimStart + dir * step, track.trimEnd - minGap));
        } else {
          track.trimEnd = Math.min(track.duration, Math.max(track.trimEnd + dir * step, track.trimStart + minGap));
        }
        renderTrimView();
        if (state.isPlaying) rescheduleLiveLoop();
        scheduleTrimPersist(track);
      });
    };

    bindHandle(dom.trimStartHandle, 'start');
    bindHandle(dom.trimEndHandle, 'end');

    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => drawWaveform()).observe(dom.waveformWrap);
    }
  }

  function setupSheetSwipeClose() {
    let startY = null;
    dom.sheetHandleArea.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      startY = e.clientY;
    });
    dom.sheetHandleArea.addEventListener('pointerup', (e) => {
      if (startY != null && e.clientY - startY > 48) {
        closeToolsSheet();
      }
      startY = null;
    });
  }

  function setupEventListeners() {
    const triggerFilePicker = () => {
      dom.fileInput.value = '';
      dom.fileInput.click();
    };

    dom.emptyAddBtn.addEventListener('click', triggerFilePicker);
    dom.headerAddBtn.addEventListener('click', triggerFilePicker);
    dom.fileInput.addEventListener('change', (e) => ingestFiles(e.target.files));

    dom.exportBackupBtn.addEventListener('click', exportBackup);
    dom.importBackupBtn.addEventListener('click', () => {
      dom.backupInput.value = '';
      dom.backupInput.click();
    });
    dom.backupInput.addEventListener('change', (e) => importBackup(e.target.files));

    dom.themeToggleBtn.addEventListener('click', toggleTheme);
    if (window.matchMedia) {
      const schemeWatcher = window.matchMedia('(prefers-color-scheme: dark)');
      const onSchemeChange = () => {
        applyThemeUI();
        drawWaveform();
      };
      if (typeof schemeWatcher.addEventListener === 'function') {
        schemeWatcher.addEventListener('change', onSchemeChange);
      } else if (typeof schemeWatcher.addListener === 'function') {
        schemeWatcher.addListener(onSchemeChange);
      }
    }

    dom.dismissErrorBtn.addEventListener('click', clearError);
    dom.dismissIosBtn.addEventListener('click', () => {
      dom.iosNote.hidden = true;
      try { localStorage.setItem('drift_ios_note_dismissed', '1'); } catch {}
    });

    window.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
      e.preventDefault();
      dragCounter++;
      if (state.tracks.length === 0) {
        dom.emptyDropZone.classList.add('drag-over');
      } else {
        dom.dropOverlay.hidden = false;
      }
    });

    window.addEventListener('dragover', (e) => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
      e.preventDefault();
    });

    window.addEventListener('dragleave', () => {
      dragCounter = Math.max(0, dragCounter - 1);
      if (dragCounter === 0) {
        dom.emptyDropZone.classList.remove('drag-over');
        dom.dropOverlay.hidden = true;
      }
    });

    window.addEventListener('drop', (e) => {
      e.preventDefault();
      dragCounter = 0;
      dom.emptyDropZone.classList.remove('drag-over');
      dom.dropOverlay.hidden = true;
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        ingestFiles(e.dataTransfer.files);
      }
    });

    dom.playPauseBtn.addEventListener('click', () => {
      const track = getCurrentTrack();
      if (!track) return;
      if (state.isPlaying) {
        stopPlayback(0.04);
      } else {
        startTrackPlayback(track, false);
      }
    });

    dom.prevTrackBtn.addEventListener('click', () => stepTrack(-1));
    dom.nextTrackBtn.addEventListener('click', () => stepTrack(1));

    dom.volumeSlider.addEventListener('input', (e) => {
      applyVolume(Number(e.target.value) / 100, false);
    });
    dom.muteBtn.addEventListener('click', () => {
      applyVolume(state.volume, !state.muted);
    });

    dom.timerPresets.addEventListener('click', (e) => {
      const btn = e.target.closest('.pill-btn');
      if (!btn) return;
      setSleepTimer(Number(btn.dataset.minutes));
    });

    dom.openToolsBtn.addEventListener('click', openToolsSheet);
    dom.closeToolsBtn.addEventListener('click', closeToolsSheet);
    dom.sheetBackdrop.addEventListener('click', closeToolsSheet);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.sheetOpen) closeToolsSheet();
    });

    dom.toolsSheet.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    dom.crossfadeSlider.addEventListener('input', (e) => {
      applyCrossfadeMs(Number(e.target.value));
    });

    dom.resetTrimBtn.addEventListener('click', () => {
      const track = getCurrentTrack();
      if (!track) return;
      const bounds = clampTrimBounds(track, track.autoTrimStart, track.autoTrimEnd);
      track.trimStart = bounds.trimStart;
      track.trimEnd = bounds.trimEnd;
      renderTrimView();
      if (state.isPlaying) rescheduleLiveLoop();
      scheduleTrimPersist(track);
    });

    const onEqInput = () => {
      applyEq(
        Number(dom.eqLowSlider.value),
        Number(dom.eqMidSlider.value),
        Number(dom.eqHighSlider.value)
      );
    };
    dom.eqLowSlider.addEventListener('input', onEqInput);
    dom.eqMidSlider.addEventListener('input', onEqInput);
    dom.eqHighSlider.addEventListener('input', onEqInput);
    dom.resetEqBtn.addEventListener('click', () => applyEq(0, 0, 0));

    dom.savePresetForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const track = getCurrentTrack();
      const name = dom.presetNameInput.value.trim();
      if (!track || !name) return;

      const preset = {
        id: generateId(),
        name,
        trackId: track.id,
        trackName: track.name,
        trimStart: track.trimStart,
        trimEnd: track.trimEnd,
        crossfadeMs: state.crossfadeMs,
        eq: { ...state.eq },
        volume: state.volume,
        createdAt: Date.now()
      };
      state.presets.unshift(preset);
      savePresetsToStorage();
      dom.presetNameInput.value = '';
      showPresetNotice(`Saved "${preset.name}".`, false);
      renderPresets();
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && state.isPlaying && audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }
      schedulerTick();
    });

    setupTrimInteractions();
    setupSheetSwipeClose();
  }

  function getEffectiveTheme() {
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'dark' || attr === 'light') return attr;
    return 'dark';
  }

  function applyThemeUI() {
    const dark = getEffectiveTheme() === 'dark';
    if (dom.themeMoonIcon) dom.themeMoonIcon.hidden = dark;
    if (dom.themeSunIcon) dom.themeSunIcon.hidden = !dark;
    if (dom.themeToggleBtn) {
      dom.themeToggleBtn.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#070D1D' : '#FAF9F7');
  }

  function buildVizBars() {
    if (!dom.vizBars || dom.vizBars.childElementCount) return;
    const heights = [42, 68, 90, 58, 76, 100, 64, 84, 50, 72, 95, 60, 88, 46, 70, 98, 56, 80, 66, 92, 52, 74, 62, 86];
    heights.forEach((h, i) => {
      const bar = document.createElement('span');
      bar.style.setProperty('--h', h);
      bar.style.animationDelay = `${(i % 8) * 0.09}s`;
      bar.style.animationDuration = `${0.75 + (i % 5) * 0.13}s`;
      dom.vizBars.appendChild(bar);
    });
  }

  function toggleTheme() {
    const next = getEffectiveTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('drift_theme', next); } catch {}
    applyThemeUI();
    drawWaveform();
  }

  function detectIosAndShowNote() {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    let dismissed = false;
    try { dismissed = localStorage.getItem('drift_ios_note_dismissed') === '1'; } catch {}
    if (isIOS && !dismissed) {
      dom.iosNote.hidden = false;
    }
  }

  async function init() {
    await loadPresetsFromStorage();
    setupEventListeners();
    setupMediaSessionHandlers();
    detectIosAndShowNote();
    startScheduler();
    applyVolume(state.volume, false);
    applyThemeUI();
    buildVizBars();

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }

    await ensurePersistentStorage();
    updateStorageStatus();

    try {
      const saved = await dbGetAllMeta();
      saved.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
      state.tracks = saved;
      if (state.tracks.length > 0) {
        state.currentTrackId = state.tracks[0].id;
      }
    } catch {
      showError('Could not open local storage for saved tracks.');
    }

    renderAll();
  }

  /* ---------- App chrome: tab navigation, mini player, video frame ---------- */

  const chrome = {
    tabBar: document.getElementById('tabBar'),
    libraryView: document.getElementById('libraryView'),
    moreView: document.getElementById('moreView'),
    libraryAddBtn: document.getElementById('libraryAddBtn'),
    tabToolsBtn: document.getElementById('tabToolsBtn'),
    miniPlayer: document.getElementById('miniPlayer'),
    miniTitle: document.getElementById('miniTitle'),
    miniMeta: document.getElementById('miniMeta'),
    miniPlayBtn: document.getElementById('miniPlayBtn'),
    miniPlayIcon: document.getElementById('miniPlayIcon'),
    miniPauseIcon: document.getElementById('miniPauseIcon'),
    miniNextBtn: document.getElementById('miniNextBtn'),
    miniInfoBtn: document.getElementById('miniInfoBtn'),
    miniProgressFill: document.getElementById('miniProgressFill'),
    videoFrame: document.getElementById('videoFrame'),
    trackVideo: document.getElementById('trackVideo')
  };

  let activeView = 'player';
  let chromeVideoTrackId = null;
  let chromeVideoUrl = null;
  let chromeVideoGen = 0;

  function miniMetaText(track) {
    if (!state.isPlaying) return 'Paused';
    return track.binaural ? `Looping · ${track.binaural.hz.toFixed(1)} Hz ${track.binaural.band}` : 'Looping';
  }

  function showView(name) {
    activeView = name;
    document.querySelectorAll('.tab-item[data-view]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.view === name);
    });
    syncAppChrome();
  }

  function syncAppChrome() {
    const hasTracks = state.tracks.length > 0;
    const track = getCurrentTrack();

    chrome.tabBar.hidden = !hasTracks;
    dom.playerView.hidden = !hasTracks || activeView !== 'player';
    chrome.libraryView.hidden = !hasTracks || activeView !== 'library';
    chrome.moreView.hidden = !hasTracks || activeView !== 'more';

    chrome.miniPlayer.hidden = !(hasTracks && activeView !== 'player');
    if (track) {
      chrome.miniTitle.textContent = track.name;
      chrome.miniMeta.textContent = miniMetaText(track);
    }
    syncVideoFrame(track);
    syncTransportChrome();
  }

  async function syncVideoFrame(track) {
    const video = chrome.trackVideo;
    if (!track || track.kind !== 'video') {
      chrome.videoFrame.hidden = true;
      if (chromeVideoTrackId) {
        chromeVideoGen++;
        chromeVideoTrackId = null;
        try { video.pause(); } catch {}
        video.removeAttribute('src');
        video.load();
        if (chromeVideoUrl) { URL.revokeObjectURL(chromeVideoUrl); chromeVideoUrl = null; }
      }
      return;
    }
    chrome.videoFrame.hidden = false;
    if (chromeVideoTrackId === track.id) {
      if (state.isPlaying) video.play().catch(() => {});
      return;
    }
    const gen = ++chromeVideoGen;
    try {
      const raw = await dbGetAudioData(track.id);
      if (!raw || gen !== chromeVideoGen) return;
      if (chromeVideoUrl) URL.revokeObjectURL(chromeVideoUrl);
      chromeVideoUrl = URL.createObjectURL(new Blob([raw], { type: track.mime || 'video/mp4' }));
      chromeVideoTrackId = track.id;
      video.src = chromeVideoUrl;
      const seekToStart = () => {
        try { video.currentTime = track.trimStart; } catch {}
        if (state.isPlaying) video.play().catch(() => {});
        video.removeEventListener('loadedmetadata', seekToStart);
      };
      video.addEventListener('loadedmetadata', seekToStart);
    } catch {}
  }

  function syncTransportChrome() {
    if (!chrome.miniPlayIcon) return;
    chrome.miniPlayIcon.hidden = state.isPlaying;
    chrome.miniPauseIcon.hidden = !state.isPlaying;
    const track = getCurrentTrack();
    if (track) chrome.miniMeta.textContent = miniMetaText(track);
    const video = chrome.trackVideo;
    if (track && track.kind === 'video' && chromeVideoTrackId === track.id) {
      if (state.isPlaying) video.play().catch(() => {});
      else video.pause();
    }
  }

  function syncProgressChrome(track, playhead, pct) {
    if (chrome.miniProgressFill) {
      chrome.miniProgressFill.style.width = `${(pct * 100).toFixed(1)}%`;
    }
    const video = chrome.trackVideo;
    if (track && track.kind === 'video' && playhead != null &&
        chromeVideoTrackId === track.id && video.readyState >= 1) {
      if (Math.abs(video.currentTime - playhead) > 0.45) {
        try { video.currentTime = playhead; } catch {}
      }
    }
  }

  document.querySelectorAll('.tab-item[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => showView(btn.dataset.view));
  });
  chrome.tabToolsBtn.addEventListener('click', () => dom.openToolsBtn.click());
  chrome.libraryAddBtn.addEventListener('click', () => dom.fileInput.click());
  chrome.miniPlayBtn.addEventListener('click', () => dom.playPauseBtn.click());
  chrome.miniNextBtn.addEventListener('click', () => dom.nextTrackBtn.click());
  chrome.miniInfoBtn.addEventListener('click', () => showView('player'));

  init();
})();
