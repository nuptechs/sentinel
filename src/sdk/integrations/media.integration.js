// ─────────────────────────────────────────────
// Sentinel SDK — Media Integration
// Audio recording (getUserMedia) and
// Video/screen recording (getDisplayMedia).
// ─────────────────────────────────────────────

import { Integration } from '../core/integration.js';

export class MediaIntegration extends Integration {
  constructor() {
    super();
    this._audio = null;
    this._video = null;
  }

  get name() { return 'media'; }
  get audio() { return this._audio; }
  get video() { return this._video; }

  setup() {
    this._audio = new AudioCapture();
    this._video = new VideoCapture();
  }

  teardown() {
    if (this._audio?.isRecording) this._audio.stop().catch(() => {});
    if (this._video?.isRecording) this._video.stop().catch(() => {});
    this._audio = null;
    this._video = null;
  }
}

// ── AudioCapture ────────────────────────────

export class AudioCapture {
  constructor() {
    this._recorder = null;
    this._chunks = [];
    this._stream = null;
  }

  get isRecording() {
    return this._recorder?.state === 'recording';
  }

  async start() {
    this._stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this._chunks = [];
    this._recorder = new MediaRecorder(this._stream, { mimeType: this._bestMime() });
    this._recorder.ondataavailable = (e) => { if (e.data.size > 0) this._chunks.push(e.data); };
    this._recorder.start(100);
  }

  stop() {
    return new Promise((resolve) => {
      if (!this._recorder || this._recorder.state === 'inactive') {
        resolve(new Blob(this._chunks, { type: 'audio/webm' }));
        return;
      }
      this._recorder.onstop = () => {
        this._stream?.getTracks().forEach(t => t.stop());
        resolve(new Blob(this._chunks, { type: 'audio/webm' }));
      };
      this._recorder.stop();
    });
  }

  _bestMime() {
    for (const mime of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']) {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime)) return mime;
    }
    return 'audio/webm';
  }
}

// ── VideoCapture ────────────────────────────

export class VideoCapture {
  constructor() {
    this._recorder = null;
    this._chunks = [];
    this._screenStream = null;
    this._audioStream = null;
  }

  get isRecording() {
    return this._recorder?.state === 'recording';
  }

  async start() {
    this._screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: false,
    });

    try {
      this._audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      // Video without audio is acceptable
    }

    const tracks = [...this._screenStream.getTracks()];
    if (this._audioStream) tracks.push(...this._audioStream.getTracks());

    const combined = new MediaStream(tracks);
    this._chunks = [];
    this._recorder = new MediaRecorder(combined, {
      mimeType: this._bestMime(),
      videoBitsPerSecond: 2_500_000,
    });
    this._recorder.ondataavailable = (e) => { if (e.data.size > 0) this._chunks.push(e.data); };

    // Auto-stop when user stops screen sharing
    this._screenStream.getVideoTracks()[0].onended = () => this.stop();
    this._recorder.start(200);
  }

  stop() {
    return new Promise((resolve) => {
      if (!this._recorder || this._recorder.state === 'inactive') {
        resolve(new Blob(this._chunks, { type: 'video/webm' }));
        return;
      }
      this._recorder.onstop = () => {
        this._screenStream?.getTracks().forEach(t => t.stop());
        this._audioStream?.getTracks().forEach(t => t.stop());
        resolve(new Blob(this._chunks, { type: 'video/webm' }));
      };
      this._recorder.stop();
    });
  }

  _bestMime() {
    for (const mime of ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']) {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime)) return mime;
    }
    return 'video/webm';
  }
}
