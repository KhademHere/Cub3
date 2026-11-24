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
      case 'SCRAMBLING':
        this.playServoSweep(290, 440, 0.3, 0.03);
        break;
      case 'SOLVING':
        this.playServoSweep(310, 490, 0.34, 0.032);
        break;
      case 'CELEBRATING':
        this.playSolvedChime();
        break;
      case 'STANDBY':
        break;
    }
  }

  /** Plays a crisp, weighted wrist-actuator servo whirr for each 90-degree face turn. */
  playFaceTwistCue(prime: boolean, speedMultiplier = 1): void {
    if (this.muted || !this.ctx || this.ctx.state !== 'running') return;
    const dur = Math.max(0.11, 0.24 / Math.max(0.5, speedMultiplier));
    this.playServoSweep(prime ? 350 : 280, prime ? 250 : 410, dur, 0.024);
  }

  /** Plays a crisp, tactile magnetic detent click the instant a 90-degree layer locks into place. */
  playLayerLockClick(): void {
    if (this.muted || !this.ctx || this.ctx.state !== 'running') return;
    this.playClampClick(920, 0.038);
  }

  /** Plays a subtle, calm dual-harmonic completion chime when the cube finishes solving. */
  private playSolvedChime(): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const notes = [523.25, 659.25, 783.99]; // C5 - E5 - G5 clean triad
    notes.forEach((freq, idx) => {
      if (!this.ctx) return;
      const start = now + idx * 0.095;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(0.034, start + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.42);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(start);
      osc.stop(start + 0.45);
    });
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
