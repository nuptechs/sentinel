// ─────────────────────────────────────────────
// Sentinel SDK — Shadow DOM Host
// Isolates all Sentinel UI inside a Shadow DOM
// to prevent CSS leaks in either direction.
// ─────────────────────────────────────────────

export class ShadowHost {
  /**
   * @param {object} [opts]
   * @param {string} [opts.id='sentinel-root']
   */
  constructor({ id = 'sentinel-root' } = {}) {
    this._id = id;
    this._host = null;
    this._shadow = null;
    this._mounted = false;
  }

  get root() {
    return this._shadow;
  }

  get host() {
    return this._host;
  }

  get isMounted() {
    return this._mounted;
  }

  /**
   * Create the shadow host and attach a closed shadow DOM.
   * Idempotent — calling mount() twice is safe.
   */
  mount() {
    if (this._mounted) return this._shadow;

    // Remove any leftover from previous sessions
    const existing = document.getElementById(this._id);
    if (existing) existing.remove();

    this._host = document.createElement('div');
    this._host.id = this._id;
    this._host.setAttribute('data-sentinel-block', '');
    // Position fixed so it doesn't affect page layout
    this._host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;';

    this._shadow = this._host.attachShadow({ mode: 'open' });

    document.body.appendChild(this._host);
    this._mounted = true;
    return this._shadow;
  }

  /**
   * Inject CSS into the shadow DOM.
   */
  injectCSS(css) {
    if (!this._shadow) return;
    const style = document.createElement('style');
    style.textContent = css;
    this._shadow.appendChild(style);
  }

  /**
   * Create an element inside the shadow DOM.
   */
  createElement(tag, className) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    return el;
  }

  /**
   * Append an element to the shadow root.
   */
  append(element) {
    if (this._shadow) this._shadow.appendChild(element);
  }

  /**
   * Remove all children from the shadow root (except styles).
   */
  clearContent() {
    if (!this._shadow) return;
    const children = Array.from(this._shadow.childNodes);
    for (const child of children) {
      if (child.nodeName !== 'STYLE') {
        child.remove();
      }
    }
  }

  /**
   * Remove the shadow host from the DOM entirely.
   */
  unmount() {
    if (this._host) {
      this._host.remove();
      this._host = null;
      this._shadow = null;
    }
    this._mounted = false;
  }
}
