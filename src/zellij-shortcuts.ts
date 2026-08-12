// Floating shortcut balls injected into the Zellij Web entry page.
//
// Both balls (the main shortcut ring and the direction-key ring) share one
// browser-side base class (`CodepilotShortcutBall`) and the same arc layout.
// The per-ball configuration below only differs in the shortcut keys /
// sequences, plus a default side and whether the ball may auto-collapse.
//
// The page also installs a touch scroll bridge for Codex TUI sessions: on
// mobile, a vertical swipe in the main chat view opens Codex's full-transcript
// overlay (Zellij must be locked first, otherwise Ctrl+T is intercepted) and
// then turns the swipe into PageUp/PageDown so the conversation can actually
// be paged through.

export const ZELLIJ_SHORTCUTS_SCRIPT_PATH = '/codepilot-zellij-shortcuts.js';

export interface ShortcutButtonSpec {
  /** Optional keyboard key name (e.g. "ArrowUp") used as the hint. */
  key?: string;
  /** Byte values of the terminal escape sequence to write. */
  sequence: number[];
  /** Hint label rendered under the button. */
  hint: string;
  ariaLabel: string;
  /** Visible button text. */
  label: string;
  /** Optional confirmation message shown before sending. */
  confirm?: string;
  /** Keep the ring expanded after sending this button. */
  keepExpanded?: boolean;
}

export interface ShortcutBallSpec {
  id: string;
  ariaLabel: string;
  storageKey: string;
  initialSide?: 'left' | 'right';
  buttons: ShortcutButtonSpec[];
}

export const SHORTCUT_BALLS: ShortcutBallSpec[] = [
  {
    id: 'codepilot-zellij-shortcuts',
    ariaLabel: '终端快捷键盘',
    storageKey: 'codepilot-zellij-shortcuts-position-v2',
    initialSide: 'right',
    buttons: [
      { sequence: [16, 110], hint: 'Ctrl+P N', ariaLabel: '发送 Ctrl+P N', label: 'N' },
      {
        sequence: [16, 120],
        confirm: 'Ctrl+P X 会关闭当前 Zellij 面板，是否继续？',
        hint: 'Ctrl+P X',
        ariaLabel: '关闭当前 Zellij 面板（需确认）',
        label: 'X',
      },
      { sequence: [3], hint: 'Ctrl+C', ariaLabel: '发送 Ctrl+C', label: 'C' },
      { sequence: [9], hint: 'Tab', ariaLabel: '发送 Tab', label: 'Tab', keepExpanded: true },
      { key: 'ArrowUp', sequence: [27, 91, 65], hint: 'ArrowUp', ariaLabel: '发送上方向键', label: '↑', keepExpanded: true },
      { key: 'ArrowDown', sequence: [27, 91, 66], hint: 'ArrowDown', ariaLabel: '发送下方向键', label: '↓', keepExpanded: true },
    ],
  },
  {
    id: 'codepilot-zellij-shortcuts-arrows',
    ariaLabel: '方向键快捷键盘',
    storageKey: 'codepilot-zellij-shortcuts-position-v2-arrows',
    initialSide: 'left',
    buttons: [
      { key: 'ArrowUp', sequence: [27, 91, 65], hint: 'ArrowUp', ariaLabel: '发送上方向键', label: '↑', keepExpanded: true },
      { key: 'ArrowLeft', sequence: [27, 91, 68], hint: 'ArrowLeft', ariaLabel: '发送左方向键', label: '←', keepExpanded: true },
      { key: 'ArrowRight', sequence: [27, 91, 67], hint: 'ArrowRight', ariaLabel: '发送右方向键', label: '→', keepExpanded: true },
      { key: 'ArrowDown', sequence: [27, 91, 66], hint: 'ArrowDown', ariaLabel: '发送下方向键', label: '↓', keepExpanded: true },
    ],
  },
];

const renderShortcutButton = (button: ShortcutButtonSpec): string => {
  const attributes = [
    button.key ? `data-key="${button.key}"` : '',
    `data-sequence="${button.sequence.join(',')}"`,
    button.confirm ? `data-confirm="${button.confirm}"` : '',
    button.keepExpanded ? 'data-keep-expanded="true"' : '',
    `data-hint="${button.hint}"`,
    `aria-label="${button.ariaLabel}"`,
  ].filter(Boolean).join(' ');
  return `<button type="button" tabindex="-1" class="codepilot-ring-action" ${attributes}>${button.label}</button>`;
};

const renderShortcutBall = (ball: ShortcutBallSpec): string => {
  const attributes = [
    `id="${ball.id}"`,
    'class="codepilot-zellij-toolbar"',
    `data-storage-key="${ball.storageKey}"`,
    ball.initialSide ? `data-initial-side="${ball.initialSide}"` : '',
    'role="toolbar"',
    `aria-label="${ball.ariaLabel}"`,
    'data-expanded="false"',
    'data-idle="true"',
  ].filter(Boolean).join(' ');
  return `<div ${attributes}>
  <button type="button" tabindex="-1" class="codepilot-shortcut-toggle" aria-label="展开快捷键盘" aria-expanded="false">+</button>
${ball.buttons.map(button => `  ${renderShortcutButton(button)}`).join('\n')}
</div>`;
};

export const ZELLIJ_SHORTCUTS_SCRIPT = `(() => {
  const edgeGap = 8;
  const isTouchDevice = () => navigator.maxTouchPoints > 0;
  const scheduleFrame = window.requestAnimationFrame?.bind(window) || (callback => window.setTimeout(callback, 16));
  const cancelFrame = window.cancelAnimationFrame?.bind(window) || window.clearTimeout.bind(window);
  const isTerminalFocused = () => {
    const active = document.activeElement;
    return active instanceof HTMLElement && active.classList.contains('xterm-helper-textarea');
  };
  const blurEditable = () => {
    const active = document.activeElement;
    // Never blur the Zellij xterm textarea: losing that focus makes the Codex
    // TUI input non-editable on touch devices (soft keyboard + focus are both
    // dropped). Other page inputs may still be dismissed normally.
    if (active instanceof HTMLElement
      && !active.classList.contains('xterm-helper-textarea')
      && active.matches('input, textarea, [contenteditable="true"]')) {
      active.blur();
    }
  };
  const updateSoftKeyboardState = () => {
    const active = document.activeElement;
    const editableFocused = active instanceof HTMLElement && active.matches('input, textarea, [contenteditable="true"]');
    const viewportHeight = window.visualViewport?.height || window.innerHeight;
    const keyboardVisible = editableFocused && viewportHeight < window.innerHeight * .8;
    document.documentElement.classList.toggle('codepilot-soft-keyboard-open', keyboardVisible);
  };
  const scheduleViewportRecovery = () => {
    for (const delay of [80, 350, 800]) {
      window.setTimeout(() => {
        updateSoftKeyboardState();
        if (!document.documentElement.classList.contains('codepilot-soft-keyboard-open')) {
          window.dispatchEvent(new Event('resize'));
        }
      }, delay);
    }
  };
  class CodepilotShortcutBall {
    constructor(toolbar) {
      this.toolbar = toolbar;
      this.storageKey = toolbar.dataset.storageKey || 'codepilot-zellij-shortcuts-position-v2-' + toolbar.id;
      this.mobileWidthStorageKey = 'codepilot-zellij-shortcuts-mobile-width';
      this.dragState = null;
      this.dragFrame = 0;
      this.pendingDragPoint = null;
      this.idleTimer = 0;
      this.toolbarSide = 'right';
      this.toolbarTopRatio = 1;
      this.toolbarScale = 1;
      this.suppressToggleClick = false;
      this.terminalWasFocused = false;
      this.moveToolbar = this.moveToolbar.bind(this);
      this.stopDragging = this.stopDragging.bind(this);
      this.onDocumentPointerDown = this.onDocumentPointerDown.bind(this);
      this.attach();
      this.init();
    }
    wakeToolbar() {
      if (this.idleTimer) window.clearTimeout(this.idleTimer);
      this.idleTimer = 0;
      this.toolbar.dataset.idle = 'false';
    }
    scheduleIdle() {
      this.wakeToolbar();
      if (this.toolbar.dataset.expanded === 'true') return;
      this.idleTimer = window.setTimeout(() => {
        this.idleTimer = 0;
        if (this.toolbar.dataset.expanded !== 'true' && !this.dragState) {
          this.snapToolbarToEdge(true);
          this.toolbar.dataset.idle = 'true';
        }
      }, 3000);
    }
    sendSequence(sequence) {
      const sendFunction = window.__zjImeBypass && window.__zjImeBypass.sendFn;
      if (typeof sendFunction === 'function') sendFunction(sequence);
      // If the tap stole focus from the terminal (some mobile browsers focus the
      // tapped button despite pointerdown preventDefault), give it back so the
      // user can keep editing. Only restore when the terminal had focus before
      // the interaction — never pop the soft keyboard open unexpectedly.
      if (this.terminalWasFocused && !isTerminalFocused()) {
        const term = window.term;
        if (term && typeof term.focus === 'function') term.focus();
      }
    }
    updateToolbarScale() {
      const visualScale = window.visualViewport && Number.isFinite(window.visualViewport.scale)
        ? window.visualViewport.scale
        : 1;
      const screenWidth = window.screen && Number.isFinite(window.screen.width) ? window.screen.width : window.innerWidth;
      const touchDevice = navigator.maxTouchPoints > 0;
      const mobileUserAgent = /Mobile|iPhone|iPod/u.test(navigator.userAgent);
      let mobileWidth = 430;
      let hasSavedMobileWidth = false;
      try {
        const savedMobileWidth = Number(window.localStorage.getItem(this.mobileWidthStorageKey));
        if (Number.isFinite(savedMobileWidth) && savedMobileWidth >= 280 && savedMobileWidth <= 700) {
          mobileWidth = savedMobileWidth;
          hasSavedMobileWidth = true;
        }
        if (touchDevice && mobileUserAgent && window.innerWidth < 700) {
          mobileWidth = window.innerWidth;
          hasSavedMobileWidth = true;
          window.localStorage.setItem(this.mobileWidthStorageKey, String(mobileWidth));
        }
      } catch {}
      const savedViewportRatio = hasSavedMobileWidth && window.innerWidth > mobileWidth * 1.4
        ? window.innerWidth / mobileWidth
        : 1;
      const desktopLikeTouch = touchDevice
        && !mobileUserAgent
        && window.innerWidth >= 700
        && window.innerWidth <= 1400
        && window.devicePixelRatio >= 1.5;
      const screenRatio = touchDevice && screenWidth > 0 && window.innerWidth > screenWidth * 1.4
        ? window.innerWidth / screenWidth
        : 1;
      const desktopModeRatio = Math.max(savedViewportRatio, desktopLikeTouch ? window.innerWidth / mobileWidth : screenRatio);
      const visualModeRatio = visualScale < .95 ? 1 / visualScale : 1;
      const toolbarScale = Math.min(2.5, Math.max(1, visualModeRatio, desktopModeRatio));
      this.toolbarScale = toolbarScale;
      this.toolbar.style.setProperty('--shortcut-scale', String(toolbarScale));
      this.toolbar.style.setProperty('--shortcut-size', 2.8 * toolbarScale + 'rem');
      this.toolbar.style.setProperty('--shortcut-font-size', .78 * toolbarScale + 'rem');
      this.toolbar.style.setProperty('--shortcut-toggle-font-size', 1.15 * toolbarScale + 'rem');
      this.toolbar.style.setProperty('--shortcut-hint-font-size', .58 * toolbarScale + 'rem');
      this.toolbar.style.setProperty('--shortcut-hint-gap', .18 * toolbarScale + 'rem');
    }
    placeToolbar(left, top, persist) {
      const width = this.toolbar.offsetWidth || 45;
      const height = this.toolbar.offsetHeight || 45;
      const innerRadius = 85 * this.toolbarScale;
      const outerRadius = innerRadius + 67.5 * this.toolbarScale;
      const actionCount = this.toolbar.querySelectorAll('.codepilot-ring-action').length;
      // Keep the same 20-degree angular step between buttons as the main ball,
      // so every ball's adjacent button spacing and distance from the ball
      // center match the main ring. The direction-key ball (4 buttons) then
      // sits exactly on the main ball's middle four arc positions.
      const halfArc = (actionCount - 1) * 10;
      const verticalReach = Math.sin(halfArc * Math.PI / 180) * outerRadius;
      const boundedLeft = Math.max(edgeGap, Math.min(left, window.innerWidth - width - edgeGap));
      const minimumTop = edgeGap + verticalReach;
      const maximumTop = window.innerHeight - height - edgeGap - verticalReach;
      const boundedTop = Math.max(minimumTop, Math.min(top, Math.max(minimumTop, maximumTop)));
      const arcAngles = Array.from({ length: actionCount }, (_, index) => {
        const angle = actionCount > 1 ? -halfArc + index * halfArc * 2 / (actionCount - 1) : 0;
        return angle * Math.PI / 180;
      });
      this.toolbar.style.left = Math.round(boundedLeft * 100) / 100 + 'px';
      this.toolbar.style.top = Math.round(boundedTop * 100) / 100 + 'px';
      this.toolbar.style.right = 'auto';
      this.toolbar.style.bottom = 'auto';
      const direction = boundedLeft + width / 2 < window.innerWidth / 2 ? 1 : -1;
      const availableHeight = Math.max(1, window.innerHeight - height - edgeGap * 2);
      this.toolbarSide = direction === 1 ? 'left' : 'right';
      this.toolbarTopRatio = Math.max(0, Math.min(1, (boundedTop - edgeGap) / availableHeight));
      this.toolbar.style.setProperty('--shortcut-x', String(direction));
      this.toolbar.style.setProperty('--shortcut-idle-translate', direction * width * -.84 + 'px');
      arcAngles.forEach((angle, index) => {
        this.toolbar.style.setProperty('--shortcut-' + (index + 1) + '-x', Math.round((Math.cos(angle) * outerRadius - innerRadius) * 100) / 100 + 'px');
        this.toolbar.style.setProperty('--shortcut-' + (index + 1) + '-y', Math.round(Math.sin(angle) * outerRadius * 100) / 100 + 'px');
      });
      if (persist) {
        try { window.localStorage.setItem(this.storageKey, JSON.stringify({ side: this.toolbarSide, topRatio: this.toolbarTopRatio })); } catch {}
      }
    }
    snapToolbarToEdge(persist) {
      const rect = this.toolbar.getBoundingClientRect();
      const width = rect.width || this.toolbar.offsetWidth || 45;
      const snappedLeft = rect.left + width / 2 < window.innerWidth / 2
        ? edgeGap
        : window.innerWidth - width - edgeGap;
      this.placeToolbar(snappedLeft, rect.top, persist);
    }
    setExpanded(expanded) {
      this.wakeToolbar();
      this.toolbar.dataset.expanded = String(expanded);
      const toggle = this.toolbar.querySelector('.codepilot-shortcut-toggle');
      if (toggle instanceof HTMLButtonElement) {
        toggle.setAttribute('aria-label', expanded ? '收起快捷键盘' : '展开快捷键盘');
        toggle.setAttribute('aria-expanded', String(expanded));
      }
      if (!expanded) this.scheduleIdle();
    }
    stopDragging(event) {
      if (!this.dragState || event.pointerId !== this.dragState.pointerId) return;
      if (this.dragFrame) cancelFrame(this.dragFrame);
      this.dragFrame = 0;
      if (this.pendingDragPoint) {
        this.placeToolbar(this.pendingDragPoint.left, this.pendingDragPoint.top, false);
        this.pendingDragPoint = null;
      }
      if (this.dragState.moved) {
        this.suppressToggleClick = true;
        this.snapToolbarToEdge(true);
      }
      this.dragState = null;
      window.removeEventListener('pointermove', this.moveToolbar);
      window.removeEventListener('pointerup', this.stopDragging);
      window.removeEventListener('pointercancel', this.stopDragging);
      this.scheduleIdle();
    }
    moveToolbar(event) {
      if (!this.dragState || event.pointerId !== this.dragState.pointerId) return;
      const deltaX = event.clientX - this.dragState.pointerX;
      const deltaY = event.clientY - this.dragState.pointerY;
      if (!this.dragState.moved && Math.hypot(deltaX, deltaY) < 5) return;
      if (!this.dragState.moved) this.setExpanded(false);
      this.dragState.moved = true;
      this.pendingDragPoint = { left: this.dragState.left + deltaX, top: this.dragState.top + deltaY };
      if (!this.dragFrame) {
        this.dragFrame = scheduleFrame(() => {
          this.dragFrame = 0;
          if (!this.pendingDragPoint) return;
          this.placeToolbar(this.pendingDragPoint.left, this.pendingDragPoint.top, false);
          this.pendingDragPoint = null;
        });
      }
    }
    onPointerDown(event) {
      const button = event.target instanceof Element ? event.target.closest('button') : null;
      if (!(button instanceof HTMLButtonElement)) return;
      event.preventDefault();
      this.wakeToolbar();
      this.terminalWasFocused = isTerminalFocused();
      if (!button.classList.contains('codepilot-ring-action') || isTouchDevice()) blurEditable();
      if (!button.classList.contains('codepilot-shortcut-toggle')) return;
      const rect = this.toolbar.getBoundingClientRect();
      this.dragState = { pointerId: event.pointerId, pointerX: event.clientX, pointerY: event.clientY, left: rect.left, top: rect.top, moved: false };
      button.setPointerCapture?.(event.pointerId);
      window.addEventListener('pointermove', this.moveToolbar);
      window.addEventListener('pointerup', this.stopDragging);
      window.addEventListener('pointercancel', this.stopDragging);
    }
    onClick(event) {
      const button = event.target instanceof Element ? event.target.closest('button') : null;
      if (!(button instanceof HTMLButtonElement)) return;
      this.wakeToolbar();
      if (!button.classList.contains('codepilot-ring-action') || isTouchDevice()) blurEditable();
      if (button.classList.contains('codepilot-shortcut-toggle')) {
        if (this.suppressToggleClick) {
          this.suppressToggleClick = false;
          return;
        }
        this.setExpanded(this.toolbar.dataset.expanded !== 'true');
        return;
      }
      const sequence = button.dataset.sequence;
      if (sequence) {
        const confirmation = button.dataset.confirm;
        const encodedSequence = String.fromCharCode(...sequence.split(',').map(Number));
        if (confirmation && !window.confirm(confirmation)) return;
        this.sendSequence(encodedSequence);
        if (button.dataset.keepExpanded !== 'true') this.setExpanded(false);
      }
    }
    onDocumentPointerDown(event) {
      const target = event.target;
      if (target instanceof Node
        && !this.toolbar.contains(target)
        && this.toolbar.dataset.expanded === 'true') {
        this.setExpanded(false);
      }
    }
    attach() {
      this.toolbar.addEventListener('pointerdown', event => this.onPointerDown(event));
      this.toolbar.addEventListener('click', event => this.onClick(event));
      document.addEventListener('pointerdown', this.onDocumentPointerDown);
      window.addEventListener('resize', () => this.onResize());
      window.visualViewport?.addEventListener('resize', () => {
        updateSoftKeyboardState();
        this.updateToolbarScale();
        const width = this.toolbar.offsetWidth || 45;
        const height = this.toolbar.offsetHeight || 45;
        const availableHeight = Math.max(1, window.innerHeight - height - edgeGap * 2);
        const left = this.toolbarSide === 'left' ? edgeGap : window.innerWidth - width - edgeGap;
        this.placeToolbar(left, edgeGap + this.toolbarTopRatio * availableHeight, true);
      });
    }
    onResize() {
      this.updateToolbarScale();
      const width = this.toolbar.offsetWidth || 45;
      const height = this.toolbar.offsetHeight || 45;
      const availableHeight = Math.max(1, window.innerHeight - height - edgeGap * 2);
      const left = this.toolbarSide === 'left' ? edgeGap : window.innerWidth - width - edgeGap;
      this.placeToolbar(left, edgeGap + this.toolbarTopRatio * availableHeight, true);
    }
    init() {
      try {
        this.updateToolbarScale();
        const saved = JSON.parse(window.localStorage.getItem(this.storageKey) || 'null');
        const width = this.toolbar.offsetWidth || 45;
        const height = this.toolbar.offsetHeight || 45;
        if (saved && (saved.side === 'left' || saved.side === 'right') && Number.isFinite(saved.topRatio)) {
          const left = saved.side === 'left' ? edgeGap : window.innerWidth - width - edgeGap;
          const top = edgeGap + Math.max(0, Math.min(1, saved.topRatio)) * Math.max(1, window.innerHeight - height - edgeGap * 2);
          this.placeToolbar(left, top, false);
        } else if (saved && Number.isFinite(saved.top)) {
          this.placeToolbar(window.innerWidth - width - edgeGap, saved.top, true);
        } else if (this.toolbar.dataset.initialSide === 'left') {
          this.placeToolbar(edgeGap, (window.innerHeight - height) / 2, false);
        } else {
          this.placeToolbar(window.innerWidth - width - edgeGap, (window.innerHeight - height) / 2, false);
        }
      } catch {}
      window.setTimeout(() => this.updateToolbarScale(), 0);
      updateSoftKeyboardState();
      this.toolbar.dataset.idle = 'true';
    }
  }
  document.querySelectorAll('.codepilot-zellij-toolbar').forEach(toolbar => new CodepilotShortcutBall(toolbar));
  const scrollBridge = (() => {
    const TRANSCRIPT_HEADER = 'T R A N S C R I P T';
    const FULLSCREEN_HEADERS = ['D I F F', 'P A T C H', 'E X E C', 'P E R M I S S I O N S'];
    const PAGE_UP = '\x1b[5~';
    const PAGE_DOWN = '\x1b[6~';
    // Pixels of vertical finger travel that flip one transcript page.
    const PAGE_SWIPE_THRESHOLD = 120;
    const state = {
      active: false,
      startX: 0,
      startY: 0,
      lastY: 0,
      accum: 0,
      opening: false,
      closing: false,
      transcriptRequested: false,
      queuedPage: null,
      weLocked: false,
    };
    const pill = document.getElementById('codepilot-transcript-close');
    const sendRaw = data => {
      const sendFn = window.__zjImeBypass && window.__zjImeBypass.sendFn;
      if (typeof sendFn === 'function') sendFn(data);
    };
    const bufferHead = rowCount => {
      const term = window.term;
      if (!term || !term.buffer || !term.buffer.active) return '';
      const buffer = term.buffer.active;
      let text = '';
      const end = Math.min(buffer.length, rowCount);
      for (let y = 0; y < end; y += 1) {
        const line = buffer.getLine(y);
        if (line) text += line.translateToString(true) + '\\n';
      }
      return text;
    };
    // The welcome box ("OpenAI Codex") can scroll out of the first rows once a
    // conversation grows, so scan the whole visible buffer and match any
    // Codex-only UI marker before hijacking touch scrolling.
    const isCodexTerminal = () => {
      // Managed repository sessions are created with the fixed Codex command,
      // so the server-side marker remains reliable after Codex's identifying
      // text has scrolled out of Zellij's zero-scrollback xterm buffer.
      if (pill?.dataset.codexSession === 'true') return true;
      // The markers can wrap across narrow mobile lines, so collapse any
      // newline/space runs before matching multi-word UI text.
      const full = bufferHead(Number.POSITIVE_INFINITY).replace(/\\s+/gu, ' ');
      return full.includes('OpenAI Codex')
        || full.includes('ctrl + t to view transcript')
        || full.includes('Explain this codebase')
        || full.includes('/model to change')
        || full.includes('esc to interrupt');
    };
    const currentOverlay = () => {
      const head = bufferHead(8);
      if (head.includes(TRANSCRIPT_HEADER)) return TRANSCRIPT_HEADER;
      for (const header of FULLSCREEN_HEADERS) {
        if (head.includes(header)) return header;
      }
      return null;
    };
    const statusRow = () => {
      const term = window.term;
      if (!term || !term.buffer || !term.buffer.active) return '';
      const buffer = term.buffer.active;
      const line = buffer.getLine(buffer.length - 1);
      return line ? line.translateToString(true) : '';
    };
    const isLocked = () => {
      const row = statusRow();
      return /<g> LOCK/.test(row) && !/<p> PANE/.test(row);
    };
    const updatePill = () => {
      if (!pill) return;
      const transcriptVisible = currentOverlay() === TRANSCRIPT_HEADER;
      pill.hidden = !(isTouchDevice() && transcriptVisible);
      if (transcriptVisible) state.transcriptRequested = true;
      else if (!state.opening && !state.closing) state.transcriptRequested = false;
    };
    const waitForTranscript = attempt => {
      const overlay = currentOverlay();
      if (overlay === TRANSCRIPT_HEADER) {
        state.opening = false;
        state.transcriptRequested = true;
        if (state.queuedPage) sendRaw(state.queuedPage);
        state.queuedPage = null;
        updatePill();
        return;
      }
      if (overlay || attempt >= 20) {
        state.opening = false;
        state.transcriptRequested = false;
        state.queuedPage = null;
        updatePill();
        return;
      }
      window.setTimeout(() => waitForTranscript(attempt + 1), 100);
    };
    const openTranscript = initialPage => {
      if (state.opening || state.closing || state.transcriptRequested) return;
      state.opening = true;
      state.transcriptRequested = true;
      state.queuedPage = initialPage;
      if (!isLocked()) {
        state.weLocked = true;
        sendRaw('\x07'); // Ctrl+G: lock Zellij so Ctrl+T reaches Codex
      }
      window.setTimeout(() => {
        sendRaw('\x14'); // Ctrl+T: open the Codex transcript overlay
        waitForTranscript(0);
      }, 120);
    };
    const closeTranscript = () => {
      if (state.opening || state.closing) return;
      state.closing = true;
      if (!isLocked()) sendRaw('\x07'); // lock so Ctrl+T is not intercepted
      window.setTimeout(() => {
        sendRaw('\x14'); // close the transcript overlay
        window.setTimeout(() => {
          if (state.weLocked) {
            sendRaw('\x07'); // restore the Zellij mode we changed
            state.weLocked = false;
          }
          state.closing = false;
          state.transcriptRequested = false;
          state.queuedPage = null;
          updatePill();
        }, 180);
      }, 120);
    };
    // direction < 0 means "finger moved down" (older content, PageUp);
    // direction > 0 means "finger moved up" (newer content, PageDown).
    const pageTranscript = direction => {
      const overlay = currentOverlay();
      if (overlay === TRANSCRIPT_HEADER) {
        sendRaw(direction < 0 ? PAGE_UP : PAGE_DOWN);
        return;
      }
      if (overlay) return; // diff/approval overlay: keep native behavior
      if (!isCodexTerminal()) return;
      if (state.opening || state.transcriptRequested) {
        // Keep at most one initial page request while the phone is waiting for
        // Codex to render. Most importantly, never toggle Ctrl+T again here.
        if (direction < 0) state.queuedPage = PAGE_UP;
        return;
      }
      openTranscript(direction < 0 ? PAGE_UP : null);
    };
    const onTouchStart = event => {
      const touch = event.touches && event.touches[0];
      if (!touch) return;
      const target = event.target;
      if (target instanceof Element
        && target.closest('.codepilot-zellij-toolbar, #codepilot-transcript-close')) return;
      state.startX = touch.clientX;
      state.startY = touch.clientY;
      state.lastY = touch.clientY;
      state.accum = 0;
      state.active = true;
    };
    const onTouchMove = event => {
      if (!state.active || !event.touches || event.touches.length !== 1) return;
      const overlay = currentOverlay();
      if (overlay && overlay !== TRANSCRIPT_HEADER) return;
      if (!overlay && !isCodexTerminal()) return;
      const touch = event.touches[0];
      if (Math.abs(touch.clientX - state.startX) > Math.abs(touch.clientY - state.startY)) return;
      event.preventDefault();
      event.stopPropagation();
      state.accum += touch.clientY - state.lastY;
      state.lastY = touch.clientY;
      while (state.accum >= PAGE_SWIPE_THRESHOLD) {
        state.accum -= PAGE_SWIPE_THRESHOLD;
        pageTranscript(-1);
      }
      while (state.accum <= -PAGE_SWIPE_THRESHOLD) {
        state.accum += PAGE_SWIPE_THRESHOLD;
        pageTranscript(1);
      }
    };
    const onTouchEnd = () => {
      state.active = false;
      state.accum = 0;
    };
    document.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
    document.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
    document.addEventListener('touchend', onTouchEnd, { capture: true, passive: true });
    if (pill) {
      pill.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        closeTranscript();
      });
    }
    window.setInterval(updatePill, 700);
    window.setTimeout(updatePill, 1500);
  })();
  document.addEventListener('focusin', updateSoftKeyboardState);
  document.addEventListener('focusout', scheduleViewportRecovery);
  window.addEventListener('pageshow', scheduleViewportRecovery);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleViewportRecovery();
  });
})();`;

export const renderZellijShortcuts = (codexSession = false): string => `
<style id="codepilot-zellij-shortcuts-style">
  html:not(.codepilot-soft-keyboard-open), html:not(.codepilot-soft-keyboard-open) body, html:not(.codepilot-soft-keyboard-open) #terminal { height: 100dvh !important; min-height: 100dvh !important; }
  .codepilot-zellij-toolbar { --shortcut-scale: 1; --shortcut-size: 2.8rem; --shortcut-font-size: .78rem; --shortcut-toggle-font-size: 1.15rem; --shortcut-hint-font-size: .58rem; --shortcut-hint-gap: .18rem; --shortcut-idle-offset: -2.35rem; --shortcut-x: -1; --shortcut-1-x: .81rem; --shortcut-1-y: -7.3rem; --shortcut-2-x: 2.94rem; --shortcut-2-y: -4.77rem; --shortcut-3-x: 4.07rem; --shortcut-3-y: -1.66rem; --shortcut-4-x: 4.07rem; --shortcut-4-y: 1.66rem; --shortcut-5-x: 2.94rem; --shortcut-5-y: 4.77rem; --shortcut-6-x: .81rem; --shortcut-6-y: 7.3rem; position: fixed; right: max(.8rem, env(safe-area-inset-right, 0px)); bottom: max(.8rem, env(safe-area-inset-bottom, 0px)); z-index: 2147483647; width: var(--shortcut-size); height: var(--shortcut-size); pointer-events: none; }
  .codepilot-zellij-toolbar button { position: absolute; display: grid; place-items: center; width: var(--shortcut-size); height: var(--shortcut-size); padding: 0; border: 1px solid #617a72; border-radius: 50%; color: #eff8f5; background: rgba(27, 44, 39, .97); box-shadow: 0 .35rem 1rem rgba(0, 0, 0, .35); font: 700 var(--shortcut-font-size) ui-monospace, SFMono-Regular, Consolas, monospace; touch-action: manipulation; pointer-events: auto; transition: transform .18s ease, opacity .14s ease, background .14s ease; }
  .codepilot-zellij-toolbar button:active { background: #45635a; }
  .codepilot-zellij-toolbar .codepilot-shortcut-toggle { right: 0; bottom: 0; z-index: 2; color: #07110f; border-color: #8aebca; background: #73e1bd; box-shadow: 0 .18rem .35rem rgba(0, 0, 0, .48), 0 .75rem 1.6rem rgba(0, 0, 0, .42), 0 0 1.15rem rgba(115, 225, 189, .3), inset 0 .12rem .18rem rgba(255, 255, 255, .38), inset 0 -.16rem .22rem rgba(15, 92, 70, .3); font-size: var(--shortcut-toggle-font-size); touch-action: none; will-change: left, top, transform; transition: transform .18s ease, opacity .18s ease, background .14s ease; }
  .codepilot-zellij-toolbar[data-idle="true"] .codepilot-shortcut-toggle { opacity: .32; transform: translateX(var(--shortcut-idle-translate, 2.35rem)); box-shadow: 0 0 .35rem rgba(0, 0, 0, .22); }
  .codepilot-zellij-toolbar .codepilot-shortcut-toggle:active { box-shadow: 0 .1rem .2rem rgba(0, 0, 0, .42), 0 .35rem .8rem rgba(0, 0, 0, .36), 0 0 .8rem rgba(115, 225, 189, .22), inset 0 .16rem .3rem rgba(15, 92, 70, .38); }
  .codepilot-zellij-toolbar .codepilot-ring-action { right: 0; bottom: 0; opacity: 0; transform: translate(0, 0) scale(.72); }
  .codepilot-zellij-toolbar .codepilot-ring-action::after { content: attr(data-hint); position: absolute; top: calc(100% + var(--shortcut-hint-gap)); color: #b7cbc5; font: 600 var(--shortcut-hint-font-size) ui-monospace, SFMono-Regular, Consolas, monospace; white-space: nowrap; }
  .codepilot-zellij-toolbar[data-expanded="true"] .codepilot-ring-action { opacity: 1; }
  .codepilot-zellij-toolbar[data-expanded="true"] .codepilot-ring-action:nth-of-type(2) { transform: translate(calc(var(--shortcut-x) * var(--shortcut-1-x)), var(--shortcut-1-y)) scale(1); }
  .codepilot-zellij-toolbar[data-expanded="true"] .codepilot-ring-action:nth-of-type(3) { transform: translate(calc(var(--shortcut-x) * var(--shortcut-2-x)), var(--shortcut-2-y)) scale(1); }
  .codepilot-zellij-toolbar[data-expanded="true"] .codepilot-ring-action:nth-of-type(4) { transform: translate(calc(var(--shortcut-x) * var(--shortcut-3-x)), var(--shortcut-3-y)) scale(1); }
  .codepilot-zellij-toolbar[data-expanded="true"] .codepilot-ring-action:nth-of-type(5) { transform: translate(calc(var(--shortcut-x) * var(--shortcut-4-x)), var(--shortcut-4-y)) scale(1); }
  .codepilot-zellij-toolbar[data-expanded="true"] .codepilot-ring-action:nth-of-type(6) { transform: translate(calc(var(--shortcut-x) * var(--shortcut-5-x)), var(--shortcut-5-y)) scale(1); }
  .codepilot-zellij-toolbar[data-expanded="true"] .codepilot-ring-action:nth-of-type(7) { transform: translate(calc(var(--shortcut-x) * var(--shortcut-6-x)), var(--shortcut-6-y)) scale(1); }
  .codepilot-zellij-toolbar[data-expanded="true"] .codepilot-shortcut-toggle { opacity: 1; transform: rotate(45deg); }
  .codepilot-transcript-close { position: fixed; top: max(.55rem, env(safe-area-inset-top, 0px)); left: 50%; transform: translateX(-50%); z-index: 2147483646; padding: .35rem .85rem; border: 1px solid #8aebca; border-radius: 999px; color: #eff8f5; background: rgba(27, 44, 39, .96); box-shadow: 0 .25rem .8rem rgba(0, 0, 0, .35); font: 600 .78rem ui-monospace, SFMono-Regular, Consolas, monospace; cursor: pointer; touch-action: manipulation; pointer-events: auto; }
  .codepilot-transcript-close[hidden] { display: none; }
  .codepilot-transcript-close:active { background: #45635a; }
</style>
${SHORTCUT_BALLS.map(renderShortcutBall).join('\n')}
<button type="button" id="codepilot-transcript-close" class="codepilot-transcript-close" data-codex-session="${String(codexSession)}" aria-label="收起对话全文，返回聊天" hidden>‹ 返回</button>
<script src="${ZELLIJ_SHORTCUTS_SCRIPT_PATH}"></script>`;

export const ZELLIJ_SHORTCUTS = renderZellijShortcuts();
