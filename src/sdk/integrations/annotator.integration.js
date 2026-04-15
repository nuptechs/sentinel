// ─────────────────────────────────────────────
// Sentinel SDK — Annotator Integration
// State-of-the-art QA overlay with Shadow DOM isolation.
//
// Features:
//   • Glassmorphic command bar (inspired by Jam.dev/Marker.io)
//   • Pin mode — click to place numbered markers with comments
//   • Draw mode — freehand red canvas annotations
//   • Screenshot with composited annotations (pins + strokes)
//   • Element selector (XPath + CSS)
//   • Audio / Video recording controls (delegates to MediaIntegration)
//   • AI-powered title/type/severity suggestion
//   • Submit panel with type chips, severity, description
//   • Error/network failure badges
//   • Session recording indicator
//
// All DOM is inside a Shadow DOM — zero CSS leaks.
// ─────────────────────────────────────────────

import { Integration } from '../core/integration.js';

// ── SVG Icons ───────────────────────────────

const ICONS = {
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3c0 2 3 3 3 4.5S9 12 9 14h6c0-2-3-2.5-3-4.5S15 7 15 5a3 3 0 0 0-3-3z"/><line x1="12" y1="14" x2="12" y2="22"/></svg>',
  draw: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>',
  video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  screenshot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
  sparkle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v1m0 16v1m8.66-13.66l-.71.71M4.05 19.95l-.71.71M21 12h-1M4 12H3m16.95 7.95l-.71-.71M4.05 4.05l-.71-.71"/><circle cx="12" cy="12" r="4"/></svg>',
  target: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>',
};

// ── CSS ─────────────────────────────────────

const ANNOTATOR_CSS = `
  :host {
    all: initial;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 13px; color: #e2e8f0;
    --s-glass: rgba(15, 23, 42, 0.75);
    --s-glass-border: rgba(148, 163, 184, 0.15);
    --s-accent: #6366f1;
    --s-accent-glow: rgba(99,102,241,0.4);
    --s-success: #22c55e;
    --s-danger: #ef4444;
    --s-warn: #f59e0b;
    --s-radius: 16px;
    --s-radius-sm: 10px;
  }

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  /* ── FAB trigger ── */
  .s-fab {
    position: fixed; bottom: 24px; right: 24px;
    width: 52px; height: 52px; border-radius: 50%;
    background: linear-gradient(135deg, #6366f1, #8b5cf6);
    border: 1px solid rgba(255,255,255,0.15);
    color: white; font-size: 22px; display: flex; align-items: center;
    justify-content: center; cursor: pointer; pointer-events: auto;
    box-shadow: 0 4px 24px var(--s-accent-glow), 0 0 0 0 var(--s-accent-glow);
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    animation: s-pulse 3s ease-in-out infinite;
    z-index: 2147483647;
  }
  .s-fab:hover { transform: scale(1.08); box-shadow: 0 8px 32px var(--s-accent-glow); }
  .s-fab.active { background: linear-gradient(135deg, #ef4444, #f97316); animation: none; }
  @keyframes s-pulse {
    0%, 100% { box-shadow: 0 4px 24px var(--s-accent-glow), 0 0 0 0 var(--s-accent-glow); }
    50% { box-shadow: 0 4px 24px var(--s-accent-glow), 0 0 0 8px transparent; }
  }

  /* ── Error badge on FAB ── */
  .s-fab-badge {
    position: absolute; top: -4px; right: -4px;
    width: 18px; height: 18px; border-radius: 50%;
    background: #fbbf24; color: #1a1a1a; font-size: 10px;
    display: none; align-items: center; justify-content: center;
    font-weight: 700; border: 2px solid white;
  }
  .s-fab-badge.visible { display: flex; }

  /* ── Command bar ── */
  .s-bar {
    position: fixed; bottom: 24px; left: 50%;
    transform: translateX(-50%) translateY(120px); opacity: 0;
    display: flex; align-items: center; gap: 4px;
    padding: 6px 8px; border-radius: 28px;
    background: var(--s-glass);
    backdrop-filter: blur(24px) saturate(1.8);
    -webkit-backdrop-filter: blur(24px) saturate(1.8);
    border: 1px solid var(--s-glass-border);
    box-shadow: 0 8px 48px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.05);
    transition: all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
    pointer-events: auto; z-index: 2147483646;
  }
  .s-bar.visible { transform: translateX(-50%) translateY(0); opacity: 1; }

  .s-bar-btn {
    position: relative; width: 42px; height: 42px; border-radius: 50%;
    background: transparent; border: 1px solid transparent;
    color: #94a3b8; cursor: pointer; display: flex; align-items: center;
    justify-content: center; transition: all 0.2s;
  }
  .s-bar-btn:hover { color: #e2e8f0; background: rgba(148,163,184,0.12); }
  .s-bar-btn.active { color: var(--s-accent); border-color: var(--s-accent); background: rgba(99,102,241,0.1); }
  .s-bar-btn.recording { color: var(--s-danger); animation: s-rec-blink 1s ease-in-out infinite; }
  @keyframes s-rec-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }

  .s-bar-btn svg { width: 20px; height: 20px; }

  .s-bar-divider { width: 1px; height: 24px; background: var(--s-glass-border); margin: 0 4px; }

  .s-bar-btn .s-tooltip {
    position: absolute; bottom: 52px; left: 50%; transform: translateX(-50%);
    padding: 4px 10px; border-radius: 8px; background: var(--s-glass);
    backdrop-filter: blur(12px); border: 1px solid var(--s-glass-border);
    font-size: 11px; color: #cbd5e1; white-space: nowrap;
    opacity: 0; pointer-events: none; transition: opacity 0.15s;
  }
  .s-bar-btn:hover .s-tooltip { opacity: 1; }

  /* ── Pin mode overlay ── */
  .s-pin-overlay {
    position: fixed; inset: 0; z-index: 2147483641;
    cursor: crosshair; pointer-events: auto;
  }

  .s-pin {
    position: fixed; width: 28px; height: 28px; border-radius: 50%;
    background: var(--s-accent); border: 2px solid white;
    color: white; font-size: 11px; font-weight: 700;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; transform: translate(-50%, -50%) scale(0);
    animation: s-pin-drop 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
    box-shadow: 0 2px 12px var(--s-accent-glow);
    pointer-events: auto; z-index: 2147483642;
  }
  @keyframes s-pin-drop { to { transform: translate(-50%, -50%) scale(1); } }

  .s-pin-comment {
    position: fixed; width: 260px; padding: 10px; border-radius: var(--s-radius-sm);
    background: var(--s-glass); backdrop-filter: blur(20px);
    border: 1px solid var(--s-glass-border);
    box-shadow: 0 4px 24px rgba(0,0,0,0.3);
    animation: s-fade-in 0.2s ease; pointer-events: auto;
    z-index: 2147483643;
  }
  .s-pin-comment textarea {
    width: 100%; height: 56px; resize: none;
    background: rgba(148,163,184,0.08); border: 1px solid var(--s-glass-border);
    border-radius: 8px; padding: 8px; color: #e2e8f0; font-size: 12px;
    font-family: inherit; outline: none;
  }
  .s-pin-comment textarea:focus { border-color: var(--s-accent); }
  .s-pin-comment-actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 6px; }
  .s-pin-comment-actions button {
    padding: 4px 12px; border-radius: 6px; font-size: 11px;
    font-weight: 500; cursor: pointer; border: none; transition: all 0.15s;
  }
  .s-pin-save { background: var(--s-accent); color: white; }
  .s-pin-save:hover { filter: brightness(1.15); }
  .s-pin-cancel { background: rgba(148,163,184,0.12); color: #94a3b8; }

  @keyframes s-fade-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }

  /* ── Draw overlay ── */
  .s-draw-canvas {
    position: fixed; inset: 0; z-index: 2147483642;
    cursor: crosshair; pointer-events: auto;
  }

  /* ── Element selector highlight ── */
  .s-highlight {
    position: fixed; pointer-events: none;
    border: 3px solid var(--s-accent); border-radius: 4px;
    background: rgba(99,102,241,0.08);
    z-index: 2147483641;
    transition: all 0.1s ease;
    box-shadow: 0 0 0 4000px rgba(0,0,0,0.15);
  }
  .s-highlight-label {
    position: absolute; bottom: -24px; left: 0;
    background: var(--s-accent); color: white;
    padding: 2px 8px; border-radius: 4px;
    font-size: 11px; font-family: monospace; white-space: nowrap;
  }

  /* ── Submit panel ── */
  .s-submit-panel {
    position: fixed; bottom: 84px; left: 50%;
    transform: translateX(-50%); width: 420px; max-width: calc(100vw - 32px);
    padding: 20px; border-radius: var(--s-radius);
    background: var(--s-glass); backdrop-filter: blur(24px) saturate(1.8);
    -webkit-backdrop-filter: blur(24px) saturate(1.8);
    border: 1px solid var(--s-glass-border);
    box-shadow: 0 16px 64px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.05);
    animation: s-panel-up 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
    pointer-events: auto; z-index: 2147483645;
  }
  @keyframes s-panel-up { from { opacity: 0; transform: translateX(-50%) translateY(20px); } }

  .s-submit-panel h3 {
    font-size: 15px; font-weight: 600; color: #f1f5f9; margin-bottom: 14px;
    display: flex; align-items: center; gap: 8px;
  }
  .s-submit-panel h3::before {
    content: ''; width: 8px; height: 8px; border-radius: 50%;
    background: var(--s-accent); box-shadow: 0 0 8px var(--s-accent-glow);
  }

  .s-field { margin-bottom: 12px; }
  .s-field label { display: block; font-size: 11px; color: #94a3b8; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
  .s-field textarea, .s-field select {
    width: 100%; padding: 10px 12px; border-radius: var(--s-radius-sm);
    background: rgba(148,163,184,0.06); border: 1px solid var(--s-glass-border);
    color: #e2e8f0; font-size: 13px; font-family: inherit; outline: none;
    transition: border-color 0.2s;
  }
  .s-field textarea { height: 72px; resize: vertical; }
  .s-field textarea:focus, .s-field select:focus { border-color: var(--s-accent); }
  .s-field select option { background: #1e293b; }

  .s-attachments { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
  .s-attachment-chip {
    display: flex; align-items: center; gap: 4px;
    padding: 4px 10px; border-radius: 20px; font-size: 11px;
    background: rgba(99,102,241,0.12); color: var(--s-accent);
    border: 1px solid rgba(99,102,241,0.2);
  }
  .s-attachment-chip.audio { background: rgba(34,197,94,0.12); color: var(--s-success); border-color: rgba(34,197,94,0.2); }
  .s-attachment-chip.video { background: rgba(245,158,11,0.12); color: var(--s-warn); border-color: rgba(245,158,11,0.2); }

  .s-type-row { display: flex; gap: 6px; flex-wrap: wrap; }
  .s-type-chip {
    padding: 6px 14px; border-radius: 20px; font-size: 12px; cursor: pointer;
    background: rgba(148,163,184,0.06); border: 1px solid var(--s-glass-border);
    color: #94a3b8; transition: all 0.15s;
  }
  .s-type-chip:hover { border-color: var(--s-accent); color: #e2e8f0; }
  .s-type-chip.selected { background: rgba(99,102,241,0.15); border-color: var(--s-accent); color: var(--s-accent); }

  .s-submit-actions { display: flex; gap: 8px; margin-top: 16px; }
  .s-btn {
    flex: 1; padding: 10px; border-radius: var(--s-radius-sm);
    font-size: 13px; font-weight: 600; cursor: pointer; border: none; transition: all 0.2s;
  }
  .s-btn-primary {
    background: linear-gradient(135deg, #6366f1, #8b5cf6); color: white;
    box-shadow: 0 4px 16px var(--s-accent-glow);
  }
  .s-btn-primary:hover { filter: brightness(1.15); transform: translateY(-1px); }
  .s-btn-primary:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
  .s-btn-ghost { background: transparent; color: #94a3b8; border: 1px solid var(--s-glass-border); }

  .s-status { text-align: center; padding: 8px; font-size: 12px; margin-top: 8px; border-radius: 8px; animation: s-fade-in 0.2s; }
  .s-status.success { color: var(--s-success); background: rgba(34,197,94,0.08); }
  .s-status.error { color: var(--s-danger); background: rgba(239,68,68,0.08); }
  .s-status.loading { color: var(--s-accent); background: rgba(99,102,241,0.08); }

  /* ── Recording indicator ── */
  .s-rec-indicator {
    position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
    display: flex; align-items: center; gap: 8px;
    padding: 8px 16px; border-radius: 20px;
    background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.3);
    backdrop-filter: blur(12px); color: #fca5a5; font-size: 12px; font-weight: 500;
    animation: s-fade-in 0.3s; pointer-events: auto; z-index: 2147483645;
  }
  .s-rec-dot {
    width: 8px; height: 8px; border-radius: 50%; background: var(--s-danger);
    animation: s-rec-blink 1s ease-in-out infinite;
  }
  .s-rec-stop {
    width: 24px; height: 24px; border-radius: 50%;
    background: transparent; border: none; color: #fca5a5;
    cursor: pointer; display: flex; align-items: center; justify-content: center;
    font-size: 14px;
  }

  /* ── AI thinking dots ── */
  .s-ai-thinking {
    display: flex; align-items: center; gap: 8px; padding: 12px;
    border-radius: var(--s-radius-sm); background: rgba(99,102,241,0.06);
    border: 1px solid rgba(99,102,241,0.15); margin-top: 8px;
  }
  .s-ai-dots { display: flex; gap: 4px; }
  .s-ai-dots span {
    width: 6px; height: 6px; border-radius: 50%; background: var(--s-accent);
    animation: s-ai-bounce 1.4s ease-in-out infinite;
  }
  .s-ai-dots span:nth-child(2) { animation-delay: 0.2s; }
  .s-ai-dots span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes s-ai-bounce {
    0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
    40% { transform: scale(1); opacity: 1; }
  }

  /* ── Context badges ── */
  .s-context-badges { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }
  .s-context-badge {
    padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 500;
  }
  .s-badge-error { background: #fef2f2; color: #dc2626; border: 1px solid #fecaca; }
  .s-badge-network { background: #fff7ed; color: #ea580c; border: 1px solid #fed7aa; }
  .s-badge-replay { background: #f0fdf4; color: #16a34a; border: 1px solid #bbf7d0; }

  /* ── AI Suggest button ── */
  .s-ai-suggest {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 4px 10px; border-radius: 6px;
    border: 1px solid var(--s-glass-border); background: rgba(99,102,241,0.06);
    color: var(--s-accent); cursor: pointer; font-size: 11px;
    font-weight: 500; transition: all 0.15s; margin-left: 8px;
  }
  .s-ai-suggest:hover { background: rgba(99,102,241,0.12); border-color: var(--s-accent); }
  .s-ai-suggest.loading { opacity: 0.6; pointer-events: none; }
`;

// ── Helpers ─────────────────────────────────

function uid() {
  return crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getElementPath(el) {
  const parts = [];
  let cur = el;
  while (cur && cur !== document.body && parts.length < 6) {
    let selector = cur.tagName.toLowerCase();
    if (cur.id) { selector += `#${cur.id}`; parts.unshift(selector); break; }
    if (cur.className && typeof cur.className === 'string') {
      const cls = cur.className.trim().split(/\s+/).slice(0, 2).join('.');
      if (cls) selector += `.${cls}`;
    }
    const parent = cur.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
      if (siblings.length > 1) selector += `:nth-child(${Array.from(parent.children).indexOf(cur) + 1})`;
    }
    parts.unshift(selector);
    cur = parent;
  }
  return parts.join(' > ');
}

function getXPath(el) {
  const parts = [];
  let cur = el;
  while (cur && cur !== document.body) {
    let idx = 1;
    let sib = cur.previousElementSibling;
    while (sib) { if (sib.tagName === cur.tagName) idx++; sib = sib.previousElementSibling; }
    parts.unshift(`${cur.tagName.toLowerCase()}[${idx}]`);
    cur = cur.parentElement;
  }
  return '/' + parts.join('/');
}

async function captureScreenshot(excludeId) {
  try {
    const h2c = await import('html2canvas');
    const html2canvas = h2c.default || h2c;
    if (!html2canvas) return null;
    const canvas = await html2canvas(document.body, {
      backgroundColor: '#ffffff', logging: false, useCORS: true,
      scale: Math.min(window.devicePixelRatio || 1, 2),
      ignoreElements: (el) => el.id === excludeId || el.getAttribute?.('data-sentinel-block') !== null,
    });
    return canvas.toDataURL('image/png', 0.8);
  } catch {
    return null;
  }
}

// ── Integration ─────────────────────────────

export class AnnotatorIntegration extends Integration {
  constructor(opts = {}) {
    super();
    this._position = opts.position || 'bottom-right';
    this._enableAudio = opts.enableAudio ?? true;
    this._enableVideo = opts.enableVideo ?? true;

    // Refs set during setup
    this._reporter = null;
    this._shadowHost = null;
    this._mediaIntegration = null;
    this._recorderIntegration = null;

    // State
    this._mode = 'idle'; // idle | pin | draw | select | submit
    this._barVisible = false;
    this._pins = [];
    this._strokes = [];
    this._currentStroke = null;
    this._audioBlob = null;
    this._videoBlob = null;
    this._screenshotData = null;
    this._selectedType = 'bug';
    this._highlightedElement = null;
    this._activePinPopup = null;
    this._recentErrors = [];
    this._recentNetworkFailures = [];

    // DOM refs inside shadow
    this._fab = null;
    this._bar = null;
    this._badge = null;
    this._keydownHandler = null;
    this._errorHandler = null;
    this._networkFailureHandler = null;
    this._badgeInterval = null;
  }

  get name() { return 'annotator'; }

  setup({ reporter, shadowHost, options }) {
    this._reporter = reporter;
    this._shadowHost = shadowHost;

    // Find sibling integrations
    this._mediaIntegration = options._integrationInstances?.find(i => i.name === 'media') || null;
    this._recorderIntegration = options._integrationInstances?.find(i => i.name === 'recorder') || null;

    // Ensure shadow DOM is mounted
    const shadow = shadowHost.mount();
    shadowHost.injectCSS(ANNOTATOR_CSS);

    this._buildUI(shadow);
    this._startErrorCapture();
    this._setupKeyboard();
  }

  teardown() {
    this._stopErrorCapture();
    if (this._keydownHandler) {
      document.removeEventListener('keydown', this._keydownHandler);
      this._keydownHandler = null;
    }
    if (this._badgeInterval) {
      clearInterval(this._badgeInterval);
      this._badgeInterval = null;
    }
    this._shadowHost?.clearContent();
  }

  // ── Build UI ──────────────────────────────

  _buildUI(shadow) {
    // FAB
    this._fab = document.createElement('button');
    this._fab.className = 's-fab';
    this._fab.innerHTML = ICONS.sparkle;
    this._fab.title = 'Sentinel QA (⌘⇧K)';
    this._fab.addEventListener('click', () => this._toggleBar());

    this._badge = document.createElement('div');
    this._badge.className = 's-fab-badge';
    this._fab.appendChild(this._badge);

    shadow.appendChild(this._fab);

    // Command bar
    this._bar = document.createElement('div');
    this._bar.className = 's-bar';
    this._bar.innerHTML = `
      <button class="s-bar-btn" data-action="pin">${ICONS.pin}<span class="s-tooltip">Marcar na tela</span></button>
      <button class="s-bar-btn" data-action="select">${ICONS.target}<span class="s-tooltip">Selecionar elemento</span></button>
      <button class="s-bar-btn" data-action="draw">${ICONS.draw}<span class="s-tooltip">Desenhar</span></button>
      <button class="s-bar-btn" data-action="screenshot">${ICONS.screenshot}<span class="s-tooltip">Captura de tela</span></button>
      <span class="s-bar-divider"></span>
      ${this._enableAudio ? `<button class="s-bar-btn" data-action="audio">${ICONS.mic}<span class="s-tooltip">Gravar áudio</span></button>` : ''}
      ${this._enableVideo ? `<button class="s-bar-btn" data-action="video">${ICONS.video}<span class="s-tooltip">Gravar vídeo</span></button>` : ''}
      ${(this._enableAudio || this._enableVideo) ? '<span class="s-bar-divider"></span>' : ''}
      <button class="s-bar-btn" data-action="submit">${ICONS.send}<span class="s-tooltip">Enviar relatório</span></button>
      <button class="s-bar-btn" data-action="close">${ICONS.x}<span class="s-tooltip">Fechar</span></button>
    `;

    this._bar.addEventListener('click', (e) => {
      const btn = e.target.closest('.s-bar-btn');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'pin') this._enterPinMode();
      else if (action === 'select') this._enterSelectMode();
      else if (action === 'draw') this._enterDrawMode();
      else if (action === 'screenshot') this._doScreenshot();
      else if (action === 'audio') this._toggleAudio(btn);
      else if (action === 'video') this._toggleVideo(btn);
      else if (action === 'submit') this._openSubmitPanel();
      else if (action === 'close') this._toggleBar();
    });

    shadow.appendChild(this._bar);

    // Badge update interval
    this._badgeInterval = setInterval(() => this._updateErrorBadge(), 5000);
  }

  // ── Error/Network auto-capture ────────────

  _startErrorCapture() {
    this._errorHandler = (event) => {
      this._recentErrors.push({
        message: event.message, filename: event.filename,
        lineno: event.lineno, colno: event.colno,
        stack: event.error?.stack, timestamp: Date.now(),
      });
      if (this._recentErrors.length > 10) this._recentErrors.shift();
      this._updateErrorBadge();
    };
    window.addEventListener('error', this._errorHandler);

    this._networkFailureHandler = (event) => {
      if (event.detail?.type === 'network' && event.detail?.payload?.phase === 'error') {
        this._recentNetworkFailures.push(event.detail.payload);
        if (this._recentNetworkFailures.length > 10) this._recentNetworkFailures.shift();
      }
    };
    window.addEventListener('sentinel-network-failure', this._networkFailureHandler);
  }

  _stopErrorCapture() {
    if (this._errorHandler) { window.removeEventListener('error', this._errorHandler); this._errorHandler = null; }
    if (this._networkFailureHandler) { window.removeEventListener('sentinel-network-failure', this._networkFailureHandler); this._networkFailureHandler = null; }
  }

  _updateErrorBadge() {
    if (!this._badge) return;
    const count = this._recentErrors.length;
    if (count > 0) {
      this._badge.textContent = count > 9 ? '9+' : String(count);
      this._badge.classList.add('visible');
    } else {
      this._badge.classList.remove('visible');
    }
  }

  // ── Keyboard ──────────────────────────────

  _setupKeyboard() {
    this._keydownHandler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        this._toggleBar();
      }
      if (e.key === 'Escape' && this._barVisible && this._mode !== 'submit') {
        this._exitMode();
      }
    };
    document.addEventListener('keydown', this._keydownHandler);
  }

  // ── Bar toggle ────────────────────────────

  _toggleBar() {
    this._barVisible = !this._barVisible;
    this._bar.classList.toggle('visible', this._barVisible);
    this._fab.classList.toggle('active', this._barVisible);
    if (!this._barVisible) this._exitMode();
  }

  _exitMode() {
    this._mode = 'idle';
    const shadow = this._shadowHost.root;
    if (!shadow) return;
    shadow.querySelector('.s-pin-overlay')?.remove();
    shadow.querySelector('.s-draw-canvas')?.remove();
    shadow.querySelector('.s-submit-panel')?.remove();
    shadow.querySelector('.s-rec-indicator')?.remove();
    shadow.querySelector('.s-highlight')?.remove();
    this._activePinPopup?.remove();
    this._activePinPopup = null;
    this._stopSelecting();
    this._updateBarButtons();
  }

  _updateBarButtons() {
    this._bar.querySelectorAll('.s-bar-btn').forEach(btn => {
      const a = btn.dataset.action;
      btn.classList.toggle('active',
        (a === 'pin' && this._mode === 'pin') ||
        (a === 'draw' && this._mode === 'draw') ||
        (a === 'select' && this._mode === 'select')
      );
    });
  }

  // ── Pin Mode ──────────────────────────────

  _enterPinMode() {
    this._exitMode();
    this._mode = 'pin';
    this._updateBarButtons();

    const shadow = this._shadowHost.root;
    const overlay = document.createElement('div');
    overlay.className = 's-pin-overlay';

    overlay.addEventListener('click', (e) => {
      if (this._activePinPopup) { this._activePinPopup.remove(); this._activePinPopup = null; }

      // Temporarily hide overlay to get the real element
      overlay.style.pointerEvents = 'none';
      const target = document.elementFromPoint(e.clientX, e.clientY);
      overlay.style.pointerEvents = 'auto';

      const pin = {
        id: uid(), x: e.clientX, y: e.clientY,
        elementPath: target ? getElementPath(target) : '',
        comment: '', timestamp: Date.now(),
      };

      const marker = document.createElement('div');
      marker.className = 's-pin';
      marker.style.left = `${pin.x}px`;
      marker.style.top = `${pin.y}px`;
      marker.textContent = String(this._pins.length + 1);
      shadow.appendChild(marker);

      const popup = document.createElement('div');
      popup.className = 's-pin-comment';
      popup.style.left = `${Math.min(pin.x + 20, window.innerWidth - 280)}px`;
      popup.style.top = `${Math.min(pin.y + 20, window.innerHeight - 120)}px`;
      popup.innerHTML = `
        <textarea placeholder="Descreva o problema aqui..." autofocus></textarea>
        <div class="s-pin-comment-actions">
          <button class="s-pin-cancel">✕</button>
          <button class="s-pin-save">Salvar</button>
        </div>
      `;
      shadow.appendChild(popup);
      this._activePinPopup = popup;

      const ta = popup.querySelector('textarea');
      setTimeout(() => ta?.focus(), 50);

      popup.querySelector('.s-pin-save').addEventListener('click', () => {
        pin.comment = ta.value.trim();
        this._pins.push(pin);
        popup.remove();
        this._activePinPopup = null;
      });
      popup.querySelector('.s-pin-cancel').addEventListener('click', () => {
        marker.remove();
        popup.remove();
        this._activePinPopup = null;
      });
    });

    shadow.appendChild(overlay);
  }

  // ── Element Select Mode ───────────────────

  _enterSelectMode() {
    this._exitMode();
    this._mode = 'select';
    this._updateBarButtons();
    document.body.style.cursor = 'crosshair';

    const shadow = this._shadowHost.root;
    const highlight = document.createElement('div');
    highlight.className = 's-highlight';
    highlight.style.display = 'none';
    const label = document.createElement('div');
    label.className = 's-highlight-label';
    highlight.appendChild(label);
    shadow.appendChild(highlight);

    this._selectMouseMove = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el.closest('[data-sentinel-block]') || el.id === 'sentinel-root') {
        highlight.style.display = 'none';
        return;
      }
      const rect = el.getBoundingClientRect();
      Object.assign(highlight.style, {
        top: `${rect.top}px`, left: `${rect.left}px`,
        width: `${rect.width}px`, height: `${rect.height}px`, display: 'block',
      });
      const tag = el.tagName.toLowerCase();
      const id = el.id ? `#${el.id}` : '';
      const cls = el.className && typeof el.className === 'string' ? `.${el.className.split(' ')[0]}` : '';
      label.textContent = `<${tag}${id}${cls}>`;
    };

    this._selectClick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el.closest('[data-sentinel-block]') || el.id === 'sentinel-root') return;

      this._highlightedElement = {
        tagName: el.tagName.toLowerCase(),
        id: el.id || undefined,
        className: (typeof el.className === 'string' ? el.className : '') || undefined,
        textContent: el.textContent?.trim().slice(0, 120),
        rect: el.getBoundingClientRect().toJSON(),
        xpath: getXPath(el),
        cssSelector: getElementPath(el),
      };

      this._stopSelecting();
      this._mode = 'idle';
      this._updateBarButtons();
    };

    document.addEventListener('mousemove', this._selectMouseMove, true);
    document.addEventListener('click', this._selectClick, true);
  }

  _stopSelecting() {
    document.body.style.cursor = '';
    const shadow = this._shadowHost?.root;
    shadow?.querySelector('.s-highlight')?.remove();
    if (this._selectMouseMove) { document.removeEventListener('mousemove', this._selectMouseMove, true); this._selectMouseMove = null; }
    if (this._selectClick) { document.removeEventListener('click', this._selectClick, true); this._selectClick = null; }
  }

  // ── Draw Mode ─────────────────────────────

  _enterDrawMode() {
    this._exitMode();
    this._mode = 'draw';
    this._updateBarButtons();

    const shadow = this._shadowHost.root;
    const canvas = document.createElement('canvas');
    canvas.className = 's-draw-canvas';
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const ctx = canvas.getContext('2d');
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Redraw existing strokes
    for (const s of this._strokes) this._drawStroke(ctx, s);

    let drawing = false;
    canvas.addEventListener('pointerdown', (e) => {
      drawing = true;
      this._currentStroke = { points: [{ x: e.clientX, y: e.clientY }], color: '#ef4444', width: 3 };
      ctx.strokeStyle = this._currentStroke.color;
      ctx.lineWidth = this._currentStroke.width;
      ctx.beginPath();
      ctx.moveTo(e.clientX, e.clientY);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drawing || !this._currentStroke) return;
      this._currentStroke.points.push({ x: e.clientX, y: e.clientY });
      ctx.lineTo(e.clientX, e.clientY);
      ctx.stroke();
    });
    canvas.addEventListener('pointerup', () => {
      if (this._currentStroke && this._currentStroke.points.length > 1) this._strokes.push(this._currentStroke);
      this._currentStroke = null;
      drawing = false;
    });

    shadow.appendChild(canvas);
  }

  _drawStroke(ctx, s) {
    if (s.points.length < 2) return;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.beginPath();
    ctx.moveTo(s.points[0].x, s.points[0].y);
    for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
    ctx.stroke();
  }

  // ── Screenshot ────────────────────────────

  async _doScreenshot() {
    // Temporarily hide shadow host for clean capture
    const host = this._shadowHost.host;
    if (host) host.style.display = 'none';
    await new Promise(r => setTimeout(r, 100));
    this._screenshotData = await captureScreenshot('sentinel-root');
    if (host) host.style.display = '';

    // Composite annotations onto screenshot
    if (this._screenshotData && (this._strokes.length > 0 || this._pins.length > 0)) {
      this._screenshotData = await this._compositeAnnotations(this._screenshotData);
    }

    // Flash feedback
    const shadow = this._shadowHost.root;
    const flash = document.createElement('div');
    flash.style.cssText = 'position:fixed;inset:0;background:white;z-index:2147483647;pointer-events:none;animation:s-fade-in 0.1s;';
    shadow.appendChild(flash);
    setTimeout(() => flash.remove(), 150);
  }

  async _compositeAnnotations(baseImageData) {
    const img = new Image();
    await new Promise((resolve) => { img.onload = resolve; img.src = baseImageData; });

    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);

    const sx = img.width / window.innerWidth;
    const sy = img.height / window.innerHeight;

    // Draw strokes
    for (const s of this._strokes) {
      if (s.points.length < 2) continue;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width * sx;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(s.points[0].x * sx, s.points[0].y * sy);
      for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x * sx, s.points[i].y * sy);
      ctx.stroke();
    }

    // Draw pins
    for (let i = 0; i < this._pins.length; i++) {
      const p = this._pins[i];
      const px = p.x * sx, py = p.y * sy, r = 14 * sx;
      ctx.fillStyle = '#6366f1';
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2 * sx;
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.font = `bold ${11 * sx}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), px, py);
    }

    return canvas.toDataURL('image/png', 0.85);
  }

  // ── Audio / Video ─────────────────────────

  async _toggleAudio(btn) {
    const audio = this._mediaIntegration?.audio;
    if (!audio) return;

    if (audio.isRecording) {
      this._audioBlob = await audio.stop();
      btn.classList.remove('recording');
      this._shadowHost.root?.querySelector('.s-rec-indicator')?.remove();
    } else {
      try {
        await audio.start();
        btn.classList.add('recording');
        this._showRecIndicator('Gravando áudio…');
      } catch { /* Permission denied */ }
    }
  }

  async _toggleVideo(btn) {
    const video = this._mediaIntegration?.video;
    if (!video) return;

    if (video.isRecording) {
      this._videoBlob = await video.stop();
      btn.classList.remove('recording');
      this._shadowHost.root?.querySelector('.s-rec-indicator')?.remove();
    } else {
      try {
        await video.start();
        btn.classList.add('recording');
        this._showRecIndicator('Gravando tela…');
      } catch { /* Permission denied / cancelled */ }
    }
  }

  _showRecIndicator(text) {
    const shadow = this._shadowHost.root;
    if (!shadow) return;
    shadow.querySelector('.s-rec-indicator')?.remove();
    const ind = document.createElement('div');
    ind.className = 's-rec-indicator';
    ind.innerHTML = `<span class="s-rec-dot"></span>${text}<button class="s-rec-stop">■</button>`;
    ind.querySelector('.s-rec-stop').addEventListener('click', () => {
      const audioBtn = this._bar.querySelector('[data-action="audio"]');
      const videoBtn = this._bar.querySelector('[data-action="video"]');
      if (this._mediaIntegration?.audio?.isRecording && audioBtn) this._toggleAudio(audioBtn);
      if (this._mediaIntegration?.video?.isRecording && videoBtn) this._toggleVideo(videoBtn);
    });
    shadow.appendChild(ind);
  }

  // ── Submit Panel ──────────────────────────

  _openSubmitPanel() {
    this._mode = 'submit';
    const shadow = this._shadowHost.root;
    if (!shadow) return;

    shadow.querySelector('.s-pin-overlay')?.remove();
    shadow.querySelector('.s-draw-canvas')?.remove();
    shadow.querySelector('.s-submit-panel')?.remove();
    this._updateBarButtons();

    const panel = document.createElement('div');
    panel.className = 's-submit-panel';

    const attachments = [];
    if (this._screenshotData) attachments.push('<span class="s-attachment-chip">📸 Screenshot</span>');
    if (this._pins.length) attachments.push(`<span class="s-attachment-chip">${this._pins.length} pin${this._pins.length > 1 ? 's' : ''}</span>`);
    if (this._strokes.length) attachments.push(`<span class="s-attachment-chip">${this._strokes.length} anotaç${this._strokes.length > 1 ? 'ões' : 'ão'}</span>`);
    if (this._audioBlob) attachments.push(`<span class="s-attachment-chip audio">🎙 Áudio (${(this._audioBlob.size / 1024).toFixed(0)}KB)</span>`);
    if (this._videoBlob) attachments.push(`<span class="s-attachment-chip video">🎬 Vídeo (${(this._videoBlob.size / 1024 / 1024).toFixed(1)}MB)</span>`);
    if (this._highlightedElement) attachments.push(`<span class="s-attachment-chip">🎯 ${this._highlightedElement.tagName}${this._highlightedElement.id ? '#' + this._highlightedElement.id : ''}</span>`);

    // Context badges
    const badges = [];
    if (this._recentErrors.length > 0) badges.push(`<span class="s-context-badge s-badge-error">${this._recentErrors.length} error${this._recentErrors.length > 1 ? 's' : ''}</span>`);
    if (this._recentNetworkFailures.length > 0) badges.push(`<span class="s-context-badge s-badge-network">${this._recentNetworkFailures.length} network failure${this._recentNetworkFailures.length > 1 ? 's' : ''}</span>`);
    if (this._recorderIntegration?.isRunning) badges.push('<span class="s-context-badge s-badge-replay">● Recording</span>');

    const types = [
      { value: 'bug', label: '🐛 Bug' },
      { value: 'ux', label: '🎨 UX' },
      { value: 'visual', label: '👁 Visual' },
      { value: 'performance', label: '⚡ Perf' },
      { value: 'data', label: '📊 Dados' },
    ];

    panel.innerHTML = `
      <h3>Reportar Problema</h3>
      ${badges.length ? `<div class="s-context-badges">${badges.join('')}</div>` : ''}
      ${attachments.length ? `<div class="s-attachments">${attachments.join('')}</div>` : ''}
      <div class="s-field">
        <label>Descrição <button class="s-ai-suggest">✨ AI Suggest</button></label>
        <textarea data-field="description" placeholder="O que aconteceu?"></textarea>
      </div>
      <div class="s-field">
        <label>Tipo</label>
        <div class="s-type-row">
          ${types.map(t => `<button class="s-type-chip${t.value === this._selectedType ? ' selected' : ''}" data-type="${t.value}">${t.label}</button>`).join('')}
        </div>
      </div>
      <div class="s-field">
        <label>Severidade</label>
        <select data-field="severity">
          <option value="medium">🟡 Média</option>
          <option value="high">🟠 Alta</option>
          <option value="critical">🔴 Crítica</option>
          <option value="low">🟢 Baixa</option>
        </select>
      </div>
      <div class="s-submit-actions">
        <button class="s-btn s-btn-ghost" data-action="cancel-submit">Cancelar</button>
        <button class="s-btn s-btn-primary" data-action="do-submit">${ICONS.send} Enviar</button>
      </div>
      <div class="s-status-area"></div>
    `;

    // Type selection
    panel.querySelectorAll('.s-type-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        panel.querySelectorAll('.s-type-chip').forEach(c => c.classList.remove('selected'));
        chip.classList.add('selected');
        this._selectedType = chip.dataset.type || 'bug';
      });
    });

    // AI Suggest
    panel.querySelector('.s-ai-suggest').addEventListener('click', () => this._aiSuggest(panel));

    // Cancel
    panel.querySelector('[data-action="cancel-submit"]').addEventListener('click', () => {
      panel.remove();
      this._mode = 'idle';
    });

    // Submit
    panel.querySelector('[data-action="do-submit"]').addEventListener('click', () => this._submitFinding(panel));

    shadow.appendChild(panel);
    setTimeout(() => panel.querySelector('textarea')?.focus(), 100);
  }

  // ── AI Suggest ────────────────────────────

  async _aiSuggest(panel) {
    const desc = panel.querySelector('[data-field="description"]')?.value?.trim();
    if (!desc) return;

    const btn = panel.querySelector('.s-ai-suggest');
    btn.classList.add('loading');
    btn.textContent = '⏳ Analisando...';

    try {
      const result = await this._reporter.suggestTitle({
        description: desc,
        pageUrl: location.href,
        element: this._highlightedElement,
        browserContext: {
          errors: this._recentErrors.slice(-5),
          networkFailures: this._recentNetworkFailures.slice(-5),
        },
      });

      if (result.type) {
        this._selectedType = result.type;
        panel.querySelectorAll('.s-type-chip').forEach(c => {
          c.classList.toggle('selected', c.dataset.type === result.type);
        });
      }
      if (result.severity) panel.querySelector('[data-field="severity"]').value = result.severity;
    } catch {
      // Silently fail — user can submit manually
    } finally {
      btn.classList.remove('loading');
      btn.textContent = '✨ AI Suggest';
    }
  }

  // ── Submit Finding ────────────────────────

  async _submitFinding(panel) {
    const desc = panel.querySelector('[data-field="description"]')?.value?.trim();
    const severity = panel.querySelector('[data-field="severity"]')?.value;
    const statusEl = panel.querySelector('.s-status-area');
    const submitBtn = panel.querySelector('[data-action="do-submit"]');

    // Build description from all sources
    const parts = [];
    if (desc) parts.push(desc);
    for (let i = 0; i < this._pins.length; i++) {
      const pin = this._pins[i];
      if (pin.comment) parts.push(`📌 [Pin ${i + 1}] ${pin.comment} (em ${pin.elementPath || 'elemento'})`);
      else parts.push(`📌 [Pin ${i + 1}] em ${pin.elementPath || 'elemento'} (x:${pin.x}, y:${pin.y})`);
    }

    const fullDescription = parts.join('\n\n');
    if (!fullDescription && !this._audioBlob && !this._videoBlob && !this._screenshotData) {
      statusEl.innerHTML = '<div class="s-status error">Adicione uma descrição, áudio, vídeo ou marcação.</div>';
      return;
    }

    submitBtn.disabled = true;
    statusEl.innerHTML = `<div class="s-ai-thinking"><div class="s-ai-dots"><span></span><span></span><span></span></div><span style="font-size:12px;color:#94a3b8">Sentinel AI analisando…</span></div>`;

    try {
      // Auto-capture screenshot if not already done
      if (!this._screenshotData && this._pins.length === 0 && this._strokes.length === 0) {
        const host = this._shadowHost.host;
        if (host) host.style.display = 'none';
        await new Promise(r => setTimeout(r, 50));
        this._screenshotData = await captureScreenshot('sentinel-root');
        if (host) host.style.display = '';
      }

      // Navigation context
      const navEntries = performance.getEntriesByType?.('navigation') || [];
      const resourceEntries = performance.getEntriesByType?.('resource')?.slice(-20) || [];

      const annotation = {
        description: fullDescription || '(Veja anexos de áudio/vídeo)',
        url: location.href,
        screenshot: this._screenshotData,
        element: this._highlightedElement,
        pins: this._pins.map(p => ({ x: p.x, y: p.y, elementPath: p.elementPath, comment: p.comment })),
        strokes: this._strokes.length,
        hasAudio: !!this._audioBlob,
        hasVideo: !!this._videoBlob,
        audioSize: this._audioBlob?.size || 0,
        videoSize: this._videoBlob?.size || 0,
      };

      const finding = await this._reporter.reportFinding({
        annotation,
        browserContext: {
          userAgent: navigator.userAgent,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          url: location.href,
          route: location.pathname + location.hash,
          referrer: document.referrer,
          errors: this._recentErrors.slice(-10),
          networkFailures: this._recentNetworkFailures.slice(-10),
          navigation: navEntries.map(n => ({ type: n.type, redirectCount: n.redirectCount, duration: n.duration })),
          resources: resourceEntries.map(r => ({ name: r.name?.split('?')[0], duration: Math.round(r.duration), type: r.initiatorType })),
          timing: {
            domContentLoaded: Math.round((performance.timing?.domContentLoadedEventEnd || 0) - (performance.timing?.navigationStart || 0)),
            loaded: Math.round((performance.timing?.loadEventEnd || 0) - (performance.timing?.navigationStart || 0)),
          },
        },
        type: this._selectedType,
        severity: severity || 'medium',
        source: 'manual',
      });

      statusEl.innerHTML = '<div class="s-status success">✅ Relatório enviado! AI diagnosis starting...</div>';

      // Reset state
      this._recentErrors = [];
      this._recentNetworkFailures = [];
      this._updateErrorBadge();

      setTimeout(() => {
        this._resetAnnotationState();
        panel.remove();
        this._mode = 'idle';
      }, 1800);

    } catch (err) {
      statusEl.innerHTML = `<div class="s-status error">Erro: ${err.message}</div>`;
      submitBtn.disabled = false;
    }
  }

  _resetAnnotationState() {
    this._pins.length = 0;
    this._strokes.length = 0;
    this._audioBlob = null;
    this._videoBlob = null;
    this._screenshotData = null;
    this._selectedType = 'bug';
    this._highlightedElement = null;
    // Remove pin markers from shadow DOM
    this._shadowHost.root?.querySelectorAll('.s-pin').forEach(el => el.remove());
  }
}
