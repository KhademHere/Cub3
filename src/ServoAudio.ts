import type {MachineState} from './types';

/**
 * 100% procedural Web Audio API synthesizer for refined electromechanical
 * servo sweeps and parallel clamp clicks (zero external audio assets).
 */
export class ServoAudio {
  private ctx: AudioContext | null = null;
  private muted = false;

  isMuted(): boolean {
    return this.muted;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  toggleMuted(): boolean {
    this.muted = !this.muted;
    return this.muted;
  }

  /** Lazily unlocks AudioContext on first user interaction. */
  unlock(): void {
    if (typeof window === 'undefined') return;
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as {webkitAudioContext?: typeof AudioContext})
          .webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
  }

  playTransitionCue(nextState: MachineState): void {
    if (this.muted || !this.ctx || this.ctx.state !== 'running') return;

    switch (nextState) {
      case 'APPROACHING':
        this.playServoSweep(180, 290, 0.55, 0.032);
        break;
      case 'GRIPPING':
        this.playClampClick(520, 0.055);
        break;
      case 'LIFTING':
        this.playServoSweep(240, 390, 0.65, 0.036);
        break;
      case 'HOLDING':
        this.playClampClick(780, 0.032);
        break;
      case 'LOWERING':
        this.playServoSweep(360, 210, 0.65, 0.032);
        break;
      case 'RELEASING':
        this.playClampClick(380, 0.042);
        break;
      case 'RETURNING':
        this.playServoSweep(260, 165, 0.55, 0.028);
        break;
      case 'STANDBY':
        break;
    }
  }

  private playServoSweep(
    startFreq: number,
    endFreq: number,
    durationSec: number,
    peakGain: number,
  ): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;

    const osc = this.ctx.createOscillator();
    const filter = this.ctx.createBiquadFilter();
    const gain = this.ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(startFreq, now);
    osc.frequency.exponentialRampToValueAtTime(endFreq, now + durationSec);

    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(startFreq * 1.8, now);
    filter.Q.setValueAtTime(2.5, now);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(peakGain, now + 0.08);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + durationSec);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(now);
    osc.stop(now + durationSec + 0.02);
  }

  private playClampClick(freq: number, peakGain: number): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, now);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.45, now + 0.075);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(peakGain, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.085);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(now);
    osc.stop(now + 0.095);
  }

  dispose(): void {
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
  }
}
