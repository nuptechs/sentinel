// ─────────────────────────────────────────────
// Sentinel SDK — QA Annotator Overlay v2
// Jam.dev-inspired one-click QA with:
// - Auto screenshot (html2canvas)
// - AI-powered title suggestion
// - Polished element selector with visual feedback
// - Console errors + network failures auto-attached
// - Session replay indicator
// ─────────────────────────────────────────────

export class Annotator {
  constructor({ reporter, recorder, position = 'bottom-right', serverUrl } = {}) {
    if (!reporter) throw new Error('Annotator: reporter is required');
    this._reporter = reporter;
    this._recorder = recorder || null;
    this._position = position;
    this._serverUrl = serverUrl || reporter._serverUrl || '';
    this._apiKey = reporter._apiKey || null;
    this._root = null;
    this._panel = null;
    this._isOpen = false;
    this._highlightedElement = null;
    this._highlightOverlay = null;
    this._selecting = false;
    this._screenshotData = null;
    this._suggestingTitle = false;
    this._recentErrors = [];
    this._recentNetworkFailures = [];
    this._errorListener = null;
    this._networkFailureCapture = null;
  }

  mount() {
    if (this._root) return;
    this._root = document.createElement('div');
    this._root.id = 'sentinel-annotator';
    this._root.setAttribute('data-sentinel-block', '');
    this._injectStyles();
    this._createTriggerButton();
    this._startErrorCapture();
    document.body.appendChild(this._root);
  }

  unmount() {
    this._stopSelecting();
    this._stopErrorCapture();
    if (this._root) { this._root.remove(); this._root = null; }
  }

  // ── Error/Network auto-capture ────────────

  _startErrorCapture() {
    this._errorListener = (event) => {
      this._recentErrors.push({
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        stack: event.error?.stack,
        timestamp: Date.now(),
      });
      if (this._recentErrors.length > 10) this._recentErrors.shift();
    };
    window.addEventListener('error', this._errorListener);

    // Track network failures from patched fetch (if recorder is active)
    this._networkFailureCapture = (event) => {
      if (event.detail?.type === 'network' && event.detail?.payload?.phase === 'error') {
        this._recentNetworkFailures.push(event.detail.payload);
        if (this._recentNetworkFailures.length > 10) this._recentNetworkFailures.shift();
      }
    };
    window.addEventListener('sentinel-network-failure', this._networkFailureCapture);
  }

  _stopErrorCapture() {
    if (this._errorListener) { window.removeEventListener('error', this._errorListener); this._errorListener = null; }
    if (this._networkFailureCapture) { window.removeEventListener('sentinel-network-failure', this._networkFailureCapture); this._networkFailureCapture = null; }
  }

  // ── Styles ────────────────────────────────

  _injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      #sentinel-annotator {
        position: fixed; z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 14px; line-height: 1.5;
        ${this._positionCSS()}
      }
      #sentinel-annotator * { box-sizing: border-box; }

      /* Trigger button */
      .sentinel-trigger {
        width: 52px; height: 52px; border-radius: 50%;
        background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
        color: white; border: none; cursor: pointer; font-size: 22px;
        box-shadow: 0 4px 16px rgba(239,68,68,0.4), 0 2px 4px rgba(0,0,0,0.1);
        display: flex; align-items: center; justify-content: center;
        transition: all 0.2s ease;
        position: relative;
      }
      .sentinel-trigger:hover { transform: scale(1.1); box-shadow: 0 6px 24px rgba(239,68,68,0.5), 0 3px 6px rgba(0,0,0,0.15); }
      .sentinel-trigger:active { transform: scale(0.95); }
      .sentinel-trigger .sentinel-badge {
        position: absolute; top: -4px; right: -4px;
        width: 18px; height: 18px; border-radius: 50%;
        background: #fbbf24; color: #1a1a1a; font-size: 10px;
        display: flex; align-items: center; justify-content: center;
        font-weight: 700; border: 2px solid white;
      }

      /* Recording indicator */
      .sentinel-recording {
        position: absolute; top: -2px; left: -2px;
        width: 12px; height: 12px; border-radius: 50%;
        background: #22c55e;
        animation: sentinel-pulse 2s ease-in-out infinite;
      }
      @keyframes sentinel-pulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.5; transform: scale(1.3); }
      }

      /* Panel */
      .sentinel-panel {
        position: absolute; ${this._panelPositionCSS()}
        width: 360px; max-height: 520px;
        background: white; border-radius: 16px;
        box-shadow: 0 12px 48px rgba(0,0,0,0.2), 0 4px 12px rgba(0,0,0,0.08);
        padding: 20px; display: none; color: #1a1a1a;
        overflow-y: auto;
      }
      .sentinel-panel.open { display: block; animation: sentinel-slide-up 0.2s ease-out; }
      @keyframes sentinel-slide-up { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }

      .sentinel-panel-header {
        display: flex; align-items: center; justify-content: space-between;
        margin-bottom: 16px;
      }
      .sentinel-panel-header h3 { margin: 0; font-size: 16px; font-weight: 600; }
      .sentinel-panel-close {
        width: 28px; height: 28px; border-radius: 6px;
        border: none; background: #f3f4f6; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        font-size: 16px; color: #6b7280; transition: background 0.15s;
      }
      .sentinel-panel-close:hover { background: #e5e7eb; }

      /* Screenshot preview */
      .sentinel-screenshot-preview {
        width: 100%; height: 120px; border-radius: 8px;
        border: 1px solid #e5e7eb; margin-bottom: 12px;
        overflow: hidden; position: relative; background: #f9fafb;
      }
      .sentinel-screenshot-preview img {
        width: 100%; height: 100%; object-fit: cover; opacity: 0.9;
      }
      .sentinel-screenshot-preview .sentinel-screenshot-label {
        position: absolute; bottom: 6px; right: 6px;
        background: rgba(0,0,0,0.6); color: white;
        padding: 2px 8px; border-radius: 4px; font-size: 11px;
      }
      .sentinel-screenshot-placeholder {
        width: 100%; height: 80px; border-radius: 8px;
        border: 2px dashed #d1d5db; margin-bottom: 12px;
        display: flex; align-items: center; justify-content: center;
        color: #9ca3af; font-size: 13px; cursor: pointer;
        transition: border-color 0.15s;
      }
      .sentinel-screenshot-placeholder:hover { border-color: #9ca3af; }

      /* Element selector */
      .sentinel-btn-select {
        width: 100%; padding: 10px; border-radius: 8px;
        border: 1px solid #e5e7eb; background: #fefce8;
        color: #854d0e; cursor: pointer; font-size: 13px;
        font-weight: 500; margin-bottom: 12px;
        display: flex; align-items: center; gap: 8px;
        transition: all 0.15s;
      }
      .sentinel-btn-select:hover { background: #fef9c3; border-color: #fbbf24; }
      .sentinel-btn-select.active { background: #fbbf24; color: white; border-color: #f59e0b; }
      .sentinel-selected-info {
        font-size: 12px; color: #6b7280; padding: 6px 10px;
        background: #f3f4f6; border-radius: 6px; margin-bottom: 12px;
        display: flex; align-items: center; gap: 6px;
      }
      .sentinel-selected-info .sentinel-clear {
        margin-left: auto; cursor: pointer; color: #ef4444; font-size: 11px;
      }

      /* Form fields */
      .sentinel-panel label {
        display: block; margin-bottom: 4px;
        font-weight: 500; font-size: 13px; color: #374151;
      }
      .sentinel-panel textarea, .sentinel-panel select, .sentinel-panel input {
        width: 100%; padding: 10px 12px;
        border: 1px solid #d1d5db; border-radius: 8px;
        font-size: 13px; box-sizing: border-box;
        margin-bottom: 12px; font-family: inherit;
        transition: border-color 0.15s, box-shadow 0.15s;
        background: white;
      }
      .sentinel-panel textarea:focus, .sentinel-panel select:focus, .sentinel-panel input:focus {
        outline: none; border-color: #2563eb;
        box-shadow: 0 0 0 3px rgba(37,99,235,0.1);
      }
      .sentinel-panel textarea { height: 80px; resize: vertical; }

      /* AI suggestion */
      .sentinel-ai-suggest {
        display: inline-flex; align-items: center; gap: 4px;
        padding: 4px 10px; border-radius: 6px;
        border: 1px solid #e5e7eb; background: #f8fafc;
        color: #6366f1; cursor: pointer; font-size: 11px;
        font-weight: 500; transition: all 0.15s; margin-left: 8px;
      }
      .sentinel-ai-suggest:hover { background: #eef2ff; border-color: #c7d2fe; }
      .sentinel-ai-suggest.loading { opacity: 0.6; pointer-events: none; }

      /* Type/severity row */
      .sentinel-row { display: flex; gap: 8px; margin-bottom: 12px; }
      .sentinel-row > div { flex: 1; }
      .sentinel-row label { margin-bottom: 4px; }
      .sentinel-row select { margin-bottom: 0; }

      /* Actions */
      .sentinel-actions { display: flex; gap: 8px; margin-top: 4px; }
      .sentinel-btn { flex: 1; padding: 10px; border: none; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 600; transition: all 0.15s; }
      .sentinel-btn-primary { background: #2563eb; color: white; }
      .sentinel-btn-primary:hover { background: #1d4ed8; }
      .sentinel-btn-primary:disabled { background: #93c5fd; cursor: not-allowed; }
      .sentinel-btn-secondary { background: #f3f4f6; color: #374151; }
      .sentinel-btn-secondary:hover { background: #e5e7eb; }

      /* Context badges */
      .sentinel-context-badges {
        display: flex; gap: 6px; flex-wrap: wrap;
        margin-bottom: 12px;
      }
      .sentinel-context-badge {
        padding: 3px 8px; border-radius: 4px;
        font-size: 11px; font-weight: 500;
      }
      .sentinel-badge-error { background: #fef2f2; color: #dc2626; border: 1px solid #fecaca; }
      .sentinel-badge-network { background: #fff7ed; color: #ea580c; border: 1px solid #fed7aa; }
      .sentinel-badge-replay { background: #f0fdf4; color: #16a34a; border: 1px solid #bbf7d0; }

      /* Info/success */
      .sentinel-info { font-size: 12px; margin-top: 8px; min-height: 18px; }

      /* Highlight overlay for element selection */
      .sentinel-highlight {
        position: fixed; pointer-events: none;
        border: 3px solid #ef4444; border-radius: 4px;
        background: rgba(239,68,68,0.08);
        z-index: 2147483646;
        transition: all 0.1s ease;
        box-shadow: 0 0 0 4000px rgba(0,0,0,0.15);
      }
      .sentinel-highlight-label {
        position: absolute; bottom: -24px; left: 0;
        background: #ef4444; color: white;
        padding: 2px 8px; border-radius: 4px;
        font-size: 11px; font-family: monospace;
        white-space: nowrap;
      }
    `;
    this._root.appendChild(style);
  }

  _positionCSS() {
    const map = {
      'bottom-right': 'bottom: 20px; right: 20px;',
      'bottom-left': 'bottom: 20px; left: 20px;',
      'top-right': 'top: 20px; right: 20px;',
      'top-left': 'top: 20px; left: 20px;',
    };
    return map[this._position] || map['bottom-right'];
  }

  _panelPositionCSS() {
    if (this._position.startsWith('bottom')) return 'bottom: 64px; right: 0;';
    return 'top: 64px; right: 0;';
  }

  // ── Trigger Button ────────────────────────

  _createTriggerButton() {
    const btn = document.createElement('button');
    btn.className = 'sentinel-trigger';
    btn.innerHTML = '🐛';
    btn.title = 'Report an issue (Sentinel)';
    btn.addEventListener('click', () => this._toggle());

    // Recording indicator
    if (this._recorder?.isRunning) {
      const dot = document.createElement('div');
      dot.className = 'sentinel-recording';
      btn.appendChild(dot);
    }

    // Error badge
    this._badgeEl = document.createElement('div');
    this._badgeEl.className = 'sentinel-badge';
    this._badgeEl.style.display = 'none';
    btn.appendChild(this._badgeEl);
    this._updateErrorBadge();
    this._badgeInterval = setInterval(() => this._updateErrorBadge(), 5000);

    this._root.appendChild(btn);
    this._createPanel();
  }

  _updateErrorBadge() {
    const count = this._recentErrors.length;
    if (count > 0 && this._badgeEl) {
      this._badgeEl.textContent = count > 9 ? '9+' : String(count);
      this._badgeEl.style.display = 'flex';
    } else if (this._badgeEl) {
      this._badgeEl.style.display = 'none';
    }
  }

  // ── Panel ─────────────────────────────────

  _createPanel() {
    this._panel = document.createElement('div');
    this._panel.className = 'sentinel-panel';
    this._panel.innerHTML = `
      <div class="sentinel-panel-header">
        <h3>🐛 Report Issue</h3>
        <button class="sentinel-panel-close" data-action="close">&times;</button>
      </div>

      <div class="sentinel-screenshot-container"></div>

      <button class="sentinel-btn-select" data-action="select">
        <span>🎯</span>
        <span>Select Element</span>
      </button>
      <div class="sentinel-selected-info" style="display:none;"></div>

      <div class="sentinel-context-badges"></div>

      <div>
        <label>
          Description
          <button class="sentinel-ai-suggest" data-action="ai-suggest" title="AI suggests title, type & severity">✨ AI Suggest</button>
        </label>
        <textarea data-field="description" placeholder="Descreva o problema encontrado..."></textarea>
      </div>

      <div>
        <label>Title <span style="font-weight:400;color:#9ca3af">(auto-generated if blank)</span></label>
        <input type="text" data-field="title" placeholder="AI will suggest a title...">
      </div>

      <div class="sentinel-row">
        <div>
          <label>Type</label>
          <select data-field="type">
            <option value="bug">🐛 Bug</option>
            <option value="ux">🎨 UX Issue</option>
            <option value="visual">👁 Visual</option>
            <option value="performance">⚡ Performance</option>
            <option value="data">📊 Data Issue</option>
            <option value="other">📌 Other</option>
          </select>
        </div>
        <div>
          <label>Severity</label>
          <select data-field="severity">
            <option value="medium">🟡 Medium</option>
            <option value="high">🟠 High</option>
            <option value="critical">🔴 Critical</option>
            <option value="low">🟢 Low</option>
          </select>
        </div>
      </div>

      <div class="sentinel-actions">
        <button class="sentinel-btn sentinel-btn-secondary" data-action="cancel">Cancel</button>
        <button class="sentinel-btn sentinel-btn-primary" data-action="submit">Submit Report</button>
      </div>
      <div class="sentinel-info"></div>
    `;

    // Wire events
    this._panel.querySelector('[data-action="close"]').addEventListener('click', () => this._close());
    this._panel.querySelector('[data-action="select"]').addEventListener('click', () => this._toggleSelecting());
    this._panel.querySelector('[data-action="ai-suggest"]').addEventListener('click', () => this._aiSuggest());
    this._panel.querySelector('[data-action="cancel"]').addEventListener('click', () => this._close());
    this._panel.querySelector('[data-action="submit"]').addEventListener('click', () => this._submit());

    this._root.appendChild(this._panel);
  }

  _toggle() { this._isOpen ? this._close() : this._open(); }

  async _open() {
    this._isOpen = true;
    this._panel.classList.add('open');
    this._updateContextBadges();
    await this._captureScreenshot();
  }

  _close() {
    this._isOpen = false;
    this._panel.classList.remove('open');
    this._stopSelecting();
    this._resetForm();
  }

  _resetForm() {
    this._panel.querySelector('[data-field="description"]').value = '';
    this._panel.querySelector('[data-field="title"]').value = '';
    this._panel.querySelector('[data-field="type"]').value = 'bug';
    this._panel.querySelector('[data-field="severity"]').value = 'medium';
    this._panel.querySelector('.sentinel-selected-info').style.display = 'none';
    this._highlightedElement = null;
    this._screenshotData = null;
    this._panel.querySelector('.sentinel-screenshot-container').innerHTML = '';
  }

  // ── Context Badges ────────────────────────

  _updateContextBadges() {
    const container = this._panel.querySelector('.sentinel-context-badges');
    container.innerHTML = '';

    if (this._recentErrors.length > 0) {
      const badge = document.createElement('span');
      badge.className = 'sentinel-context-badge sentinel-badge-error';
      badge.textContent = `${this._recentErrors.length} error${this._recentErrors.length > 1 ? 's' : ''} captured`;
      container.appendChild(badge);
    }

    if (this._recentNetworkFailures.length > 0) {
      const badge = document.createElement('span');
      badge.className = 'sentinel-context-badge sentinel-badge-network';
      badge.textContent = `${this._recentNetworkFailures.length} network failure${this._recentNetworkFailures.length > 1 ? 's' : ''}`;
      container.appendChild(badge);
    }

    if (this._recorder?.isRunning) {
      const badge = document.createElement('span');
      badge.className = 'sentinel-context-badge sentinel-badge-replay';
      badge.textContent = '● Recording session';
      container.appendChild(badge);
    }
  }

  // ── Screenshot ────────────────────────────

  async _captureScreenshot() {
    const container = this._panel.querySelector('.sentinel-screenshot-container');
    try {
      const html2canvas = (await import('html2canvas')).default;
      const canvas = await html2canvas(document.body, {
        ignoreElements: (el) => el.id === 'sentinel-annotator',
        scale: 0.5, logging: false,
        width: window.innerWidth, height: window.innerHeight,
        windowWidth: window.innerWidth, windowHeight: window.innerHeight,
      });
      this._screenshotData = canvas.toDataURL('image/jpeg', 0.6);
      container.innerHTML = `
        <div class="sentinel-screenshot-preview">
          <img src="${this._screenshotData}" alt="Screenshot">
          <span class="sentinel-screenshot-label">📷 Auto-captured</span>
        </div>
      `;
    } catch {
      container.innerHTML = `
        <div class="sentinel-screenshot-placeholder" data-action="retry-screenshot">
          📷 Screenshot unavailable — click to retry
        </div>
      `;
      container.querySelector('[data-action="retry-screenshot"]')?.addEventListener('click', () => this._captureScreenshot());
    }
  }

  // ── Element Selector ──────────────────────

  _toggleSelecting() {
    this._selecting ? this._stopSelecting() : this._startSelecting();
  }

  _startSelecting() {
    this._selecting = true;
    const selectBtn = this._panel.querySelector('[data-action="select"]');
    selectBtn.classList.add('active');
    selectBtn.querySelector('span:last-child').textContent = 'Click element to select...';
    document.body.style.cursor = 'crosshair';

    this._highlightOverlay = document.createElement('div');
    this._highlightOverlay.className = 'sentinel-highlight';
    this._highlightOverlay.setAttribute('data-sentinel-block', '');
    this._highlightLabel = document.createElement('div');
    this._highlightLabel.className = 'sentinel-highlight-label';
    this._highlightOverlay.appendChild(this._highlightLabel);
    document.body.appendChild(this._highlightOverlay);

    this._onMouseMove = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el.closest('#sentinel-annotator')) {
        this._highlightOverlay.style.display = 'none';
        return;
      }
      const rect = el.getBoundingClientRect();
      Object.assign(this._highlightOverlay.style, {
        top: `${rect.top}px`, left: `${rect.left}px`,
        width: `${rect.width}px`, height: `${rect.height}px`, display: 'block',
      });
      const tag = el.tagName.toLowerCase();
      const id = el.id ? `#${el.id}` : '';
      const cls = el.className && typeof el.className === 'string' ? `.${el.className.split(' ')[0]}` : '';
      this._highlightLabel.textContent = `<${tag}${id}${cls}>`;
    };

    this._onClick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el.closest('#sentinel-annotator')) return;

      this._highlightedElement = {
        tagName: el.tagName.toLowerCase(),
        id: el.id || undefined,
        className: (typeof el.className === 'string' ? el.className : '') || undefined,
        textContent: el.textContent?.trim().slice(0, 120),
        rect: el.getBoundingClientRect().toJSON(),
        xpath: this._getXPath(el),
        cssSelector: this._getCSSSelector(el),
      };

      const info = this._panel.querySelector('.sentinel-selected-info');
      const display = `<${this._highlightedElement.tagName}${this._highlightedElement.id ? '#' + this._highlightedElement.id : ''}>`;
      info.innerHTML = `🎯 ${display} <span class="sentinel-clear" data-action="clear-selection">✕ clear</span>`;
      info.style.display = 'flex';
      info.querySelector('[data-action="clear-selection"]').addEventListener('click', () => {
        this._highlightedElement = null;
        info.style.display = 'none';
      });

      this._stopSelecting();
    };

    document.addEventListener('mousemove', this._onMouseMove, true);
    document.addEventListener('click', this._onClick, true);
  }

  _stopSelecting() {
    this._selecting = false;
    const selectBtn = this._panel?.querySelector('[data-action="select"]');
    if (selectBtn) {
      selectBtn.classList.remove('active');
      selectBtn.querySelector('span:last-child').textContent = 'Select Element';
    }
    document.body.style.cursor = '';
    if (this._highlightOverlay) { this._highlightOverlay.remove(); this._highlightOverlay = null; }
    if (this._onMouseMove) { document.removeEventListener('mousemove', this._onMouseMove, true); this._onMouseMove = null; }
    if (this._onClick) { document.removeEventListener('click', this._onClick, true); this._onClick = null; }
  }

  _getXPath(el) {
    const parts = [];
    let current = el;
    while (current && current !== document.body) {
      let index = 1;
      let sibling = current.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === current.tagName) index++;
        sibling = sibling.previousElementSibling;
      }
      parts.unshift(`${current.tagName.toLowerCase()}[${index}]`);
      current = current.parentElement;
    }
    return '/' + parts.join('/');
  }

  _getCSSSelector(el) {
    if (el.id) return `#${el.id}`;
    const parts = [];
    let current = el;
    while (current && current !== document.body && parts.length < 5) {
      let selector = current.tagName.toLowerCase();
      if (current.id) { parts.unshift(`#${current.id}`); break; }
      if (current.className && typeof current.className === 'string') {
        const cls = current.className.trim().split(/\s+/).slice(0, 2).join('.');
        if (cls) selector += `.${cls}`;
      }
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
        if (siblings.length > 1) selector += `:nth-child(${Array.from(parent.children).indexOf(current) + 1})`;
      }
      parts.unshift(selector);
      current = current.parentElement;
    }
    return parts.join(' > ');
  }

  // ── AI Title Suggestion ───────────────────

  async _aiSuggest() {
    const description = this._panel.querySelector('[data-field="description"]').value.trim();
    if (!description) {
      this._showInfo('Write a description first, then click AI Suggest.', true);
      return;
    }

    const suggestBtn = this._panel.querySelector('[data-action="ai-suggest"]');
    suggestBtn.classList.add('loading');
    suggestBtn.textContent = '⏳ Analyzing...';

    try {
      const headers = { 'Content-Type': 'application/json', 'X-Sentinel-SDK': 'browser/2.0' };
      if (this._apiKey) headers['X-Sentinel-Key'] = this._apiKey;

      const res = await fetch(`${this._serverUrl}/api/findings/suggest-title`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          description,
          pageUrl: location.href,
          element: this._highlightedElement,
          browserContext: {
            errors: this._recentErrors.slice(-5),
            networkFailures: this._recentNetworkFailures.slice(-5),
          },
        }),
      });

      if (res.ok) {
        const { data } = await res.json();
        if (data.title) this._panel.querySelector('[data-field="title"]').value = data.title;
        if (data.type) this._panel.querySelector('[data-field="type"]').value = data.type;
        if (data.severity) this._panel.querySelector('[data-field="severity"]').value = data.severity;
        this._showInfo('✨ AI suggestion applied!', false);
      } else {
        this._showInfo('AI suggestion unavailable.', true);
      }
    } catch {
      this._showInfo('AI suggestion failed — submit manually.', true);
    } finally {
      suggestBtn.classList.remove('loading');
      suggestBtn.textContent = '✨ AI Suggest';
    }
  }

  // ── Submit ────────────────────────────────

  async _submit() {
    const description = this._panel.querySelector('[data-field="description"]').value.trim();
    const title = this._panel.querySelector('[data-field="title"]').value.trim();
    const type = this._panel.querySelector('[data-field="type"]').value;
    const severity = this._panel.querySelector('[data-field="severity"]').value;

    if (!description) {
      this._showInfo('Please describe the issue.', true);
      return;
    }

    const submitBtn = this._panel.querySelector('[data-action="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending...';

    try {
      await this._reporter.reportFinding({
        annotation: {
          description,
          screenshot: this._screenshotData,
          element: this._highlightedElement,
          url: location.href,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          timestamp: Date.now(),
        },
        browserContext: {
          url: location.href,
          userAgent: navigator.userAgent,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          errors: this._recentErrors.slice(-10),
          networkFailures: this._recentNetworkFailures.slice(-10),
          timestamp: Date.now(),
        },
        type, severity, source: 'manual',
        title: title || undefined,
      });

      this._showInfo('✅ Issue reported! AI diagnosis starting...', false);
      this._recentErrors = [];
      this._recentNetworkFailures = [];
      this._updateErrorBadge();
      setTimeout(() => this._close(), 2000);
    } catch (err) {
      this._showInfo(`Error: ${err.message}`, true);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit Report';
    }
  }

  _showInfo(text, isError) {
    const info = this._panel.querySelector('.sentinel-info');
    info.textContent = text;
    info.style.color = isError ? '#ef4444' : '#22c55e';
  }
}
