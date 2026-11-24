import type {MachineSnapshot} from './types';

export interface ControlHUDCallbacks {
  onPrimaryAction: () => void;
  onScramble: () => void;
  onResetCamera: () => void;
  onToggleMute: () => boolean;
}

const ICON_PICKUP = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>`;
const ICON_PUTDOWN = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg>`;
const ICON_SCRAMBLE = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>`;
const ICON_RESET_CAM = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>`;
const ICON_SOUND_ON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`;
const ICON_SOUND_OFF = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`;

/**
 * Minimal, accessible 2D DOM HUD overlay:
 * - Top-left compact machine status pill (STANDBY, APPROACHING, GRIPPING, HOLDING — READY)
 * - Sleek collapsible floating bottom control bar with Pick Up / Put Down button,
 *   camera reset, and audio mute toggle (clean slot ready for Scramble & Auto-Solve in Parts 2 & 3).
 */
export class ControlHUD {
  private readonly root: HTMLElement;
  private readonly statusSwatch: HTMLSpanElement;
  private readonly statusValue: HTMLSpanElement;
  private readonly primaryBtn: HTMLButtonElement;
  private readonly primaryIcon: HTMLSpanElement;
  private readonly primaryText: HTMLSpanElement;
  private readonly scrambleBtn: HTMLButtonElement;
  private readonly scrambleText: HTMLSpanElement;
  private readonly muteBtn: HTMLButtonElement;
  private readonly resetCamBtn: HTMLButtonElement;
  private readonly collapseBtn: HTMLButtonElement;
  private readonly dockWrap: HTMLDivElement;

  private collapsed = false;
  private readonly onKeyDown: (e: KeyboardEvent) => void;

  constructor(root: HTMLElement, callbacks: ControlHUDCallbacks) {
    this.root = root;
    this.root.innerHTML = '';

    // 1. Top-Left Machine Status Pill
    const statusCluster = document.createElement('div');
    statusCluster.className = 'status-cluster';

    const statusPill = document.createElement('div');
    statusPill.className = 'status-pill';
    statusPill.setAttribute('role', 'status');
    statusPill.setAttribute('data-testid', 'machine-status-pill');

    this.statusSwatch = document.createElement('span');
    this.statusSwatch.className = 'status-swatch';
    this.statusSwatch.setAttribute('data-led', 'idle');

    const statusMeta = document.createElement('div');
    statusMeta.className = 'status-meta';

    const statusTag = document.createElement('span');
    statusTag.className = 'status-tag';
    statusTag.textContent = 'STATE';

    this.statusValue = document.createElement('span');
    this.statusValue.className = 'status-value';
    this.statusValue.textContent = 'STANDBY';

    statusMeta.append(statusTag, this.statusValue);
    statusPill.append(this.statusSwatch, statusMeta);
    statusCluster.append(statusPill);

    // 2. Bottom Floating Collapsible Control Dock
    this.dockWrap = document.createElement('div');
    this.dockWrap.className = 'control-dock-wrap';

    this.collapseBtn = document.createElement('button');
    this.collapseBtn.type = 'button';
    this.collapseBtn.className = 'dock-collapse-btn';
    this.collapseBtn.setAttribute('aria-expanded', 'true');
    this.collapseBtn.textContent = '▾ Hide Controls';
    this.collapseBtn.addEventListener('click', () => this.toggleCollapsed());

    const bar = document.createElement('div');
    bar.className = 'control-bar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Robotics workbench controls');

    this.primaryBtn = document.createElement('button');
    this.primaryBtn.type = 'button';
    this.primaryBtn.className = 'btn-primary';
    this.primaryBtn.setAttribute('data-mode', 'pickup');
    this.primaryBtn.setAttribute('data-testid', 'primary-action-btn');

    this.primaryIcon = document.createElement('span');
    this.primaryIcon.innerHTML = ICON_PICKUP;
    this.primaryIcon.style.display = 'inline-flex';

    this.primaryText = document.createElement('span');
    this.primaryText.textContent = 'Pick Up Cube';

    this.primaryBtn.append(this.primaryIcon, this.primaryText);
    this.primaryBtn.addEventListener('click', () => {
      callbacks.onPrimaryAction();
    });

    this.scrambleBtn = document.createElement('button');
    this.scrambleBtn.type = 'button';
    this.scrambleBtn.className = 'btn-scramble';
    this.scrambleBtn.setAttribute('data-active', 'false');
    this.scrambleBtn.setAttribute('data-testid', 'scramble-btn');

    const scrambleIcon = document.createElement('span');
    scrambleIcon.innerHTML = ICON_SCRAMBLE;
    scrambleIcon.style.display = 'inline-flex';

    this.scrambleText = document.createElement('span');
    this.scrambleText.textContent = 'Scramble';

    this.scrambleBtn.append(scrambleIcon, this.scrambleText);
    this.scrambleBtn.addEventListener('click', () => {
      callbacks.onScramble();
    });

    const divider = document.createElement('div');
    divider.className = 'dock-divider';
    divider.setAttribute('aria-hidden', 'true');

    this.resetCamBtn = document.createElement('button');
    this.resetCamBtn.type = 'button';
    this.resetCamBtn.className = 'btn-icon';
    this.resetCamBtn.setAttribute('aria-label', 'Reset camera view');
    this.resetCamBtn.title = 'Reset Camera View (R)';
    this.resetCamBtn.innerHTML = ICON_RESET_CAM;
    this.resetCamBtn.addEventListener('click', () => callbacks.onResetCamera());

    this.muteBtn = document.createElement('button');
    this.muteBtn.type = 'button';
    this.muteBtn.className = 'btn-icon';
    this.muteBtn.setAttribute('aria-label', 'Mute servo audio');
    this.muteBtn.setAttribute('aria-pressed', 'false');
    this.muteBtn.title = 'Toggle Servo Audio (M)';
    this.muteBtn.innerHTML = ICON_SOUND_ON;
    this.muteBtn.addEventListener('click', () => {
      const muted = callbacks.onToggleMute();
      this.setMutedVisual(muted);
    });

    const hint = document.createElement('span');
    hint.className = 'control-hint';
    hint.textContent = 'Drag: Orbit · Scroll: Zoom';

    bar.append(
      this.primaryBtn,
      this.scrambleBtn,
      divider,
      this.resetCamBtn,
      this.muteBtn,
      hint,
    );
    this.dockWrap.append(this.collapseBtn, bar);

    this.root.append(statusCluster, this.dockWrap);

    this.onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      if (e.code === 'KeyH') {
        this.toggleCollapsed();
      } else if (e.code === 'KeyR') {
        callbacks.onResetCamera();
      } else if (e.code === 'KeyM') {
        this.setMutedVisual(callbacks.onToggleMute());
      }
    };
    window.addEventListener('keydown', this.onKeyDown);
  }

  private toggleCollapsed(): void {
    this.collapsed = !this.collapsed;
    this.dockWrap.classList.toggle('collapsed', this.collapsed);
    this.collapseBtn.setAttribute('aria-expanded', String(!this.collapsed));
    this.collapseBtn.textContent = this.collapsed
      ? '▴ Show Controls'
      : '▾ Hide Controls';
  }

  private setMutedVisual(muted: boolean): void {
    this.muteBtn.setAttribute('aria-pressed', String(muted));
    this.muteBtn.setAttribute(
      'aria-label',
      muted ? 'Unmute servo audio' : 'Mute servo audio',
    );
    this.muteBtn.innerHTML = muted ? ICON_SOUND_OFF : ICON_SOUND_ON;
  }

  /** Hides 2D DOM HUD when presenting inside a WebXR headset (spatial UICard takes over). */
  setVisible(visible: boolean): void {
    this.root.style.display = visible ? '' : 'none';
  }

  updateFromSnapshot(snapshot: MachineSnapshot): void {
    this.statusSwatch.setAttribute('data-led', snapshot.ledMode);
    this.statusValue.textContent = snapshot.statusLabel;

    const showPutDown =
      snapshot.isHolding ||
      snapshot.state === 'SCRAMBLING' ||
      snapshot.state === 'LOWERING' ||
      snapshot.state === 'RELEASING' ||
      snapshot.state === 'RETURNING';

    this.primaryBtn.disabled = snapshot.isBusy;
    this.primaryBtn.setAttribute('data-mode', showPutDown ? 'putdown' : 'pickup');
    this.primaryText.textContent = snapshot.primaryButtonLabel;
    this.primaryIcon.innerHTML = showPutDown ? ICON_PUTDOWN : ICON_PICKUP;

    this.scrambleBtn.disabled = snapshot.isBusy;
    this.scrambleBtn.setAttribute(
      'data-active',
      snapshot.state === 'SCRAMBLING' ? 'true' : 'false',
    );
    this.scrambleText.textContent = snapshot.scrambleButtonLabel;

    // Expose machine state cleanly on body for accessibility & automated checks
    document.body.dataset.machineState = snapshot.state;
    document.body.dataset.scrambled = String(snapshot.isScrambled);
    document.body.dataset.moveHistoryCount = String(snapshot.moveHistoryCount);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    this.root.innerHTML = '';
  }
}
