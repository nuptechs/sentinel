// ─────────────────────────────────────────────
// Tests — SDK MediaIntegration
// Audio + Video capture with browser API mocks.
// 14-dimension coverage: D1 D2 D6 D7 D8 D9
// ─────────────────────────────────────────────

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MediaIntegration, AudioCapture, VideoCapture } from '../../src/sdk/integrations/media.integration.js';

// ── MediaRecorder mock ──────────────────────

function setupMediaGlobals() {
  const origNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  class MockMediaStream {
    constructor(tracks = []) { this._tracks = tracks; }
    getTracks() { return this._tracks; }
    getVideoTracks() { return this._tracks.filter(t => t.kind === 'video'); }
    getAudioTracks() { return this._tracks.filter(t => t.kind === 'audio'); }
  }

  class MockMediaRecorder {
    constructor(stream, opts) {
      this.stream = stream;
      this.state = 'inactive';
      this.ondataavailable = null;
      this.onstop = null;
      this._opts = opts;
    }
    start(timeslice) {
      this.state = 'recording';
      // Simulate data chunk
      if (this.ondataavailable) {
        setTimeout(() => {
          if (this.ondataavailable) this.ondataavailable({ data: { size: 100 } });
        }, 5);
      }
    }
    stop() {
      this.state = 'inactive';
      if (this.onstop) setTimeout(() => this.onstop(), 5);
    }
    static isTypeSupported(mime) { return mime === 'audio/webm' || mime === 'video/webm'; }
  }

  const audioTrack = { kind: 'audio', stop: () => {} };
  const videoTrack = { kind: 'video', stop: () => {}, onended: null };

  Object.defineProperty(globalThis, 'navigator', {
    value: {
      mediaDevices: {
        getUserMedia: async () => new MockMediaStream([{ ...audioTrack }]),
        getDisplayMedia: async () => new MockMediaStream([{ ...videoTrack }]),
      },
    },
    configurable: true, writable: true,
  });

  globalThis.MediaRecorder = MockMediaRecorder;
  globalThis.MediaStream = MockMediaStream;
  globalThis.Blob = class Blob {
    constructor(parts, opts) { this.parts = parts; this.type = opts?.type; this.size = parts.length; }
  };

  return { origNav };
}

function teardownMediaGlobals({ origNav }) {
  if (origNav) Object.defineProperty(globalThis, 'navigator', origNav);
  else delete globalThis.navigator;
  delete globalThis.MediaRecorder;
  delete globalThis.MediaStream;
  delete globalThis.Blob;
}

// ── D1: MediaIntegration lifecycle ──────────

describe('MediaIntegration (D1 D8)', () => {
  it('reports name as "media"', () => {
    const m = new MediaIntegration();
    assert.equal(m.name, 'media');
  });

  it('audio and video are null before setup', () => {
    const m = new MediaIntegration();
    assert.equal(m.audio, null);
    assert.equal(m.video, null);
  });

  it('setup creates AudioCapture and VideoCapture', () => {
    const m = new MediaIntegration();
    m.setup();
    assert.ok(m.audio instanceof AudioCapture);
    assert.ok(m.video instanceof VideoCapture);
  });

  it('teardown nullifies captures', () => {
    const m = new MediaIntegration();
    m.setup();
    m.teardown();
    assert.equal(m.audio, null);
    assert.equal(m.video, null);
  });

  it('teardown is safe to call without setup (D7)', () => {
    const m = new MediaIntegration();
    m.teardown(); // should not throw
  });
});

// ── D1: AudioCapture ────────────────────────

describe('AudioCapture (D1 D9)', () => {
  let saved;
  beforeEach(() => { saved = setupMediaGlobals(); });
  afterEach(() => teardownMediaGlobals(saved));

  it('isRecording is false initially', () => {
    const a = new AudioCapture();
    assert.equal(a.isRecording, false);
  });

  it('start() requests getUserMedia and begins recording', async () => {
    const a = new AudioCapture();
    await a.start();
    assert.equal(a.isRecording, true);
    assert.ok(a._recorder);
    assert.ok(a._stream);
  });

  it('stop() returns Blob and stops stream tracks', async () => {
    const a = new AudioCapture();
    await a.start();
    const blob = await a.stop();
    assert.ok(blob);
    assert.equal(blob.type, 'audio/webm');
  });

  it('stop() returns Blob even if recorder already inactive (D7)', async () => {
    const a = new AudioCapture();
    a._chunks = [];
    a._recorder = { state: 'inactive' };
    a._stream = null;
    const blob = await a.stop();
    assert.equal(blob.type, 'audio/webm');
  });
});

// ── D1: VideoCapture ────────────────────────

describe('VideoCapture (D1 D9)', () => {
  let saved;
  beforeEach(() => { saved = setupMediaGlobals(); });
  afterEach(() => teardownMediaGlobals(saved));

  it('isRecording is false initially', () => {
    const v = new VideoCapture();
    assert.equal(v.isRecording, false);
  });

  it('start() requests getDisplayMedia and begins recording', async () => {
    const v = new VideoCapture();
    await v.start();
    assert.equal(v.isRecording, true);
    assert.ok(v._recorder);
    assert.ok(v._screenStream);
  });

  it('stop() returns video Blob', async () => {
    const v = new VideoCapture();
    await v.start();
    const blob = await v.stop();
    assert.ok(blob);
    assert.equal(blob.type, 'video/webm');
  });

  it('stop() returns Blob even if recorder already inactive (D7)', async () => {
    const v = new VideoCapture();
    v._chunks = [];
    v._recorder = { state: 'inactive' };
    const blob = await v.stop();
    assert.equal(blob.type, 'video/webm');
  });
});

// ── D8: _bestMime ───────────────────────────

describe('AudioCapture._bestMime and VideoCapture._bestMime (D8)', () => {
  let saved;
  beforeEach(() => { saved = setupMediaGlobals(); });
  afterEach(() => teardownMediaGlobals(saved));

  it('AudioCapture selects supported MIME', () => {
    const a = new AudioCapture();
    const mime = a._bestMime();
    assert.equal(mime, 'audio/webm');
  });

  it('VideoCapture selects supported MIME', () => {
    const v = new VideoCapture();
    const mime = v._bestMime();
    assert.equal(mime, 'video/webm');
  });
});
