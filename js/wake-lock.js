/**
 * Režim skladu — ochrana proti zhasnutí displeje na mobilech a tabletech.
 * 1. Primárně využívá nativní Screen Wake Lock API (navigator.wakeLock) přímo v hlavním okně.
 * 2. Záložně využívá tiché hardware video pro starší iOS Safari / Android prohlížeče.
 * 3. Automaticky obnovuje zámek při návratu do aplikace (visibilitychange / focus / první dotyk).
 */

const SILENT_MP4_DATA_URI =
  'data:video/mp4;base64,AAAAHGZ0eXBtcDQyAAAAAG1wNDJpc29tYXZjMQAAADFtb292AAAAbG12aGQAAAAA5x/a1OccftcAAAPoAAAAAAABAAABAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAGXRyYWsAAABZdGtoZAAAAAPnH9rU5xx+1wAAAAEAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAA';

export class WakeLockController {
  constructor({ enabled = true, onStatusChange = null } = {}) {
    this.enabled = enabled;
    this.onStatusChange = onStatusChange;
    this.sentinel = null;
    this.videoEl = null;
    this.mode = 'off'; // 'native' | 'fallback' | 'pending' | 'off'
    this._boundReacquire = this._reacquire.bind(this);
    this._boundGesture = this._onFirstGesture.bind(this);
  }

  init() {
    this._ensureVideoElement();
    document.addEventListener('visibilitychange', () => {
      if (this.enabled && document.visibilityState === 'visible') {
        this._acquire();
      }
    });
    window.addEventListener('focus', this._boundReacquire);
    document.addEventListener('pointerdown', this._boundGesture, { passive: true });
    document.addEventListener('keydown', this._boundGesture, { passive: true });

    if (this.enabled) {
      this._acquire();
    } else {
      this._setMode('off');
    }
  }

  setEnabled(nextEnabled) {
    this.enabled = Boolean(nextEnabled);
    if (this.enabled) {
      this._acquire();
    } else {
      this._release();
    }
    return this.enabled;
  }

  toggle() {
    return this.setEnabled(!this.enabled);
  }

  _ensureVideoElement() {
    if (this.videoEl) return;
    const v = document.createElement('video');
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.muted = true;
    v.loop = true;
    v.setAttribute('aria-hidden', 'true');
    v.tabIndex = -1;
    v.style.cssText =
      'position:fixed;width:1px;height:1px;bottom:0;left:0;opacity:0.001;pointer-events:none;z-index:-1;';
    const src = document.createElement('source');
    src.src = SILENT_MP4_DATA_URI;
    src.type = 'video/mp4';
    v.appendChild(src);
    document.body.appendChild(v);
    this.videoEl = v;
  }

  _onFirstGesture() {
    if (!this.enabled) return;
    if (this.mode !== 'native') {
      this._acquire();
    }
  }

  _reacquire() {
    if (this.enabled && document.visibilityState === 'visible') {
      this._acquire();
    }
  }

  async _acquire() {
    if (!this.enabled) return;

    // 1. Nativní Screen Wake Lock API
    if ('wakeLock' in navigator && navigator.wakeLock?.request) {
      try {
        if (!this.sentinel || this.sentinel.released) {
          this.sentinel = await navigator.wakeLock.request('screen');
          this.sentinel.addEventListener('release', () => {
            if (this.enabled && document.visibilityState === 'visible') {
              setTimeout(() => this._acquire(), 900);
            }
          });
        }
        this._setMode('native');
        return;
      } catch {
        // Fallback na tiché video (např. při úsporném režimu nebo bez gesta)
      }
    }

    // 2. Fallback video loop (iOS / starší prohlížeče)
    if (this.videoEl) {
      try {
        if (this.videoEl.paused) {
          await this.videoEl.play();
        }
        this._setMode('fallback');
        return;
      } catch {
        this._setMode('pending');
      }
    }
  }

  async _release() {
    if (this.sentinel) {
      try {
        await this.sentinel.release();
      } catch {
        // ignore
      }
      this.sentinel = null;
    }
    if (this.videoEl && !this.videoEl.paused) {
      try {
        this.videoEl.pause();
      } catch {
        // ignore
      }
    }
    this._setMode('off');
  }

  _setMode(mode) {
    this.mode = mode;
    if (typeof this.onStatusChange === 'function') {
      this.onStatusChange({ enabled: this.enabled, mode });
    }
  }
}
