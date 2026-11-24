import {
  LAB_DIMENSIONS,
  clamp01,
  easeInOutCubic,
  easeInOutQuint,
  evalCubicBezier3,
  lerp,
  solveArmIK,
} from './kinematics';
import {
  MACHINE_STATUS_LABELS,
  getArmLedMode,
  isMachineBusy,
  type ArmJointAngles,
  type MachineSnapshot,
  type MachineState,
  type Vec3,
} from './types';

export interface ChoreographyDurations {
  approach: number;
  grip: number;
  lift: number;
  lower: number;
  release: number;
  returnHome: number;
}

export const DEFAULT_DURATIONS: ChoreographyDurations = {
  approach: 1.35,
  grip: 0.65,
  lift: 1.25,
  lower: 1.25,
  release: 0.6,
  returnHome: 1.3,
};

export interface ChoreographyFrame {
  leftAngles: ArmJointAngles;
  rightAngles: ArmJointAngles;
  cubePosition: Vec3;
  cubeAttached: boolean;
  /** Height of cube above resting pad (0 when seated, > 0 when lifted). */
  cubeLiftHeight: number;
  snapshot: MachineSnapshot;
}

/** Pre-computed symmetrical anchor points in world space. */
function makeWaypoints() {
  const z = LAB_DIMENSIONS.TABLE_CENTER_Z;
  const restY = LAB_DIMENSIONS.CUBE_REST_Y;
  const holdY = LAB_DIMENSIONS.CUBE_HOLD_Y;
  const half = LAB_DIMENSIONS.CUBE_HALF;

  // Poised industrial standby: slightly elevated, open wide, swept slightly back
  const leftStandby: Vec3 = {x: -0.305, y: restY + 0.255, z: z - 0.035};
  const rightStandby: Vec3 = {x: 0.305, y: restY + 0.255, z: z - 0.035};

  // Curved Bezier control points for graceful industrial sweep inward
  const leftCtrl1: Vec3 = {x: -0.255, y: restY + 0.295, z: z - 0.012};
  const leftCtrl2: Vec3 = {x: -0.178, y: restY + 0.055, z: z};
  const rightCtrl1: Vec3 = {x: 0.255, y: restY + 0.295, z: z - 0.012};
  const rightCtrl2: Vec3 = {x: 0.178, y: restY + 0.055, z: z};

  // Approach endpoint: aligned squarely with cube's left & right center faces, 22mm clear before clamp
  const preClampGap = 0.022;
  const leftPreClamp: Vec3 = {x: -(half + preClampGap), y: restY, z};
  const rightPreClamp: Vec3 = {x: half + preClampGap, y: restY, z};

  // Exact clamp contact on cube's left (-X) and right (+X) faces — zero clipping
  const leftClampRest: Vec3 = {x: -half, y: restY, z};
  const rightClampRest: Vec3 = {x: half, y: restY, z};

  // Central hovering Ready Position in mid-air
  const leftClampHold: Vec3 = {x: -half, y: holdY, z};
  const rightClampHold: Vec3 = {x: half, y: holdY, z};

  return {
    leftStandby,
    rightStandby,
    leftCtrl1,
    leftCtrl2,
    rightCtrl1,
    rightCtrl2,
    leftPreClamp,
    rightPreClamp,
    leftClampRest,
    rightClampRest,
    leftClampHold,
    rightClampHold,
  };
}

/**
 * Pure, framework-agnostic robotics choreography state machine.
 * Handles Pick Up and Put Down sequences with quintic/cubic easing and exposes
 * clean hooks for Part 2 (Scramble) and Part 3 (Auto-Solve).
 */
export class RoboticsChoreography {
  private state: MachineState = 'STANDBY';
  private phaseElapsed = 0;
  private totalTime = 0;
  private readonly durations: ChoreographyDurations;
  private readonly wp = makeWaypoints();
  private readonly listeners = new Set<(snapshot: MachineSnapshot) => void>();

  // Scratch vectors to prevent GC allocations during 60fps evaluation
  private readonly _leftPos: Vec3 = {x: 0, y: 0, z: 0};
  private readonly _rightPos: Vec3 = {x: 0, y: 0, z: 0};
  private readonly _cubePos: Vec3 = {
    x: 0,
    y: LAB_DIMENSIONS.CUBE_REST_Y,
    z: LAB_DIMENSIONS.TABLE_CENTER_Z,
  };

  constructor(durations: Partial<ChoreographyDurations> = {}) {
    this.durations = {...DEFAULT_DURATIONS, ...durations};
  }

  getState(): MachineState {
    return this.state;
  }

  isBusy(): boolean {
    return isMachineBusy(this.state);
  }

  isHolding(): boolean {
    return this.state === 'HOLDING';
  }

  /** Hook for Part 2 (Scramble) and Part 3 (Auto-Solve) to check if cube can be twisted. */
  canPerformCubeMove(): boolean {
    return this.state === 'HOLDING';
  }

  getSnapshot(): MachineSnapshot {
    const duration = this.getPhaseDuration(this.state);
    const phaseProgress = duration > 0 ? clamp01(this.phaseElapsed / duration) : 1;
    const holdingOrLowering =
      this.state === 'HOLDING' ||
      this.state === 'LOWERING' ||
      this.state === 'RELEASING' ||
      this.state === 'RETURNING';

    let primaryButtonLabel = 'Pick Up Cube';
    if (this.state === 'HOLDING') {
      primaryButtonLabel = 'Put Down Cube';
    } else if (
      this.state === 'APPROACHING' ||
      this.state === 'GRIPPING' ||
      this.state === 'LIFTING'
    ) {
      primaryButtonLabel = 'Picking Up...';
    } else if (holdingOrLowering) {
      primaryButtonLabel = 'Putting Down...';
    }

    return {
      state: this.state,
      statusLabel: MACHINE_STATUS_LABELS[this.state],
      ledMode: getArmLedMode(this.state),
      isBusy: this.isBusy(),
      isHolding: this.isHolding(),
      primaryButtonLabel,
      phaseProgress,
    };
  }

  subscribe(listener: (snapshot: MachineSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Triggers Pick Up when in STANDBY, or Put Down when in HOLDING.
   * Cleanly ignored while any animation is mid-flight.
   */
  triggerPrimaryAction(): boolean {
    if (this.state === 'STANDBY') {
      this.transitionTo('APPROACHING');
      return true;
    }
    if (this.state === 'HOLDING') {
      this.transitionTo('LOWERING');
      return true;
    }
    return false;
  }

  /** Advances choreography by `dt` seconds and returns the current pose frame. */
  step(dt: number): ChoreographyFrame {
    const safeDt = Math.max(0, Math.min(dt, 0.25));
    this.totalTime += safeDt;

    if (this.isBusy()) {
      this.phaseElapsed += safeDt;
      this.advancePhasesIfComplete();
    }

    return this.evaluateFrame();
  }

  /** Evaluates the exact kinematic pose for the current state without advancing time. */
  evaluateFrame(): ChoreographyFrame {
    const wp = this.wp;
    let jawOpen = 1;
    let gripperPitch = 0;
    let cubeAttached = false;

    this._cubePos.x = 0;
    this._cubePos.y = LAB_DIMENSIONS.CUBE_REST_Y;
    this._cubePos.z = LAB_DIMENSIONS.TABLE_CENTER_Z;

    switch (this.state) {
      case 'STANDBY': {
        // Subtle weighted servo breathing micro-idle
        const breatheY = Math.sin(this.totalTime * 1.45) * 0.0045;
        const breatheX = Math.cos(this.totalTime * 0.9) * 0.002;
        this._leftPos.x = wp.leftStandby.x - breatheX;
        this._leftPos.y = wp.leftStandby.y + breatheY;
        this._leftPos.z = wp.leftStandby.z;

        this._rightPos.x = wp.rightStandby.x + breatheX;
        this._rightPos.y = wp.rightStandby.y + breatheY;
        this._rightPos.z = wp.rightStandby.z;

        // Slight poised downward cant in standby, straightening to dead-level during approach
        gripperPitch = -0.14;
        jawOpen = 1;
        break;
      }

      case 'APPROACHING': {
        const rawT = clamp01(this.phaseElapsed / this.durations.approach);
        const t = easeInOutQuint(rawT);
        evalCubicBezier3(
          wp.leftStandby,
          wp.leftCtrl1,
          wp.leftCtrl2,
          wp.leftPreClamp,
          t,
          this._leftPos,
        );
        evalCubicBezier3(
          wp.rightStandby,
          wp.rightCtrl1,
          wp.rightCtrl2,
          wp.rightPreClamp,
          t,
          this._rightPos,
        );
        gripperPitch = lerp(-0.14, 0, easeInOutCubic(rawT));
        jawOpen = 1;
        break;
      }

      case 'GRIPPING': {
        const rawT = clamp01(this.phaseElapsed / this.durations.grip);
        const tPos = easeInOutCubic(Math.min(1, rawT / 0.55));
        const tJaw = easeInOutCubic(rawT);

        this._leftPos.x = lerp(wp.leftPreClamp.x, wp.leftClampRest.x, tPos);
        this._leftPos.y = wp.leftClampRest.y;
        this._leftPos.z = wp.leftClampRest.z;

        this._rightPos.x = lerp(wp.rightPreClamp.x, wp.rightClampRest.x, tPos);
        this._rightPos.y = wp.rightClampRest.y;
        this._rightPos.z = wp.rightClampRest.z;

        gripperPitch = 0;
        jawOpen = lerp(1, 0, tJaw);
        break;
      }

      case 'LIFTING': {
        const rawT = clamp01(this.phaseElapsed / this.durations.lift);
        const t = easeInOutQuint(rawT);
        const y = lerp(LAB_DIMENSIONS.CUBE_REST_Y, LAB_DIMENSIONS.CUBE_HOLD_Y, t);

        this._leftPos.x = wp.leftClampRest.x;
        this._leftPos.y = y;
        this._leftPos.z = wp.leftClampRest.z;

        this._rightPos.x = wp.rightClampRest.x;
        this._rightPos.y = y;
        this._rightPos.z = wp.rightClampRest.z;

        this._cubePos.y = y;
        cubeAttached = true;
        gripperPitch = 0;
        jawOpen = 0;
        break;
      }

      case 'HOLDING': {
        // Steady rigid hold in mid-air ready for future twisting moves
        const microHover = Math.sin(this.totalTime * 1.1) * 0.0018;
        const y = LAB_DIMENSIONS.CUBE_HOLD_Y + microHover;

        this._leftPos.x = wp.leftClampHold.x;
        this._leftPos.y = y;
        this._leftPos.z = wp.leftClampHold.z;

        this._rightPos.x = wp.rightClampHold.x;
        this._rightPos.y = y;
        this._rightPos.z = wp.rightClampHold.z;

        this._cubePos.y = y;
        cubeAttached = true;
        gripperPitch = 0;
        jawOpen = 0;
        break;
      }

      case 'LOWERING': {
        const rawT = clamp01(this.phaseElapsed / this.durations.lower);
        const t = easeInOutQuint(rawT);
        const y = lerp(LAB_DIMENSIONS.CUBE_HOLD_Y, LAB_DIMENSIONS.CUBE_REST_Y, t);

        this._leftPos.x = wp.leftClampRest.x;
        this._leftPos.y = y;
        this._leftPos.z = wp.leftClampRest.z;

        this._rightPos.x = wp.rightClampRest.x;
        this._rightPos.y = y;
        this._rightPos.z = wp.rightClampRest.z;

        this._cubePos.y = y;
        cubeAttached = true;
        gripperPitch = 0;
        jawOpen = 0;
        break;
      }

      case 'RELEASING': {
        const rawT = clamp01(this.phaseElapsed / this.durations.release);
        const tJaw = easeInOutCubic(rawT);
        // Back the center anvil out slightly after jaws begin opening
        const tRetract = easeInOutCubic(clamp01((rawT - 0.35) / 0.65));

        this._leftPos.x = lerp(wp.leftClampRest.x, wp.leftPreClamp.x, tRetract);
        this._leftPos.y = wp.leftClampRest.y;
        this._leftPos.z = wp.leftClampRest.z;

        this._rightPos.x = lerp(wp.rightClampRest.x, wp.rightPreClamp.x, tRetract);
        this._rightPos.y = wp.rightClampRest.y;
        this._rightPos.z = wp.rightClampRest.z;

        gripperPitch = 0;
        jawOpen = lerp(0, 1, tJaw);
        break;
      }

      case 'RETURNING': {
        const rawT = clamp01(this.phaseElapsed / this.durations.returnHome);
        const t = easeInOutQuint(rawT);
        evalCubicBezier3(
          wp.leftPreClamp,
          wp.leftCtrl2,
          wp.leftCtrl1,
          wp.leftStandby,
          t,
          this._leftPos,
        );
        evalCubicBezier3(
          wp.rightPreClamp,
          wp.rightCtrl2,
          wp.rightCtrl1,
          wp.rightStandby,
          t,
          this._rightPos,
        );
        gripperPitch = lerp(0, -0.14, easeInOutCubic(rawT));
        jawOpen = 1;
        break;
      }
    }

    const leftAngles = solveArmIK('left', this._leftPos, {
      jawOpen,
      gripperWorldPitch: gripperPitch,
    });
    const rightAngles = solveArmIK('right', this._rightPos, {
      jawOpen,
      gripperWorldPitch: gripperPitch,
    });

    return {
      leftAngles,
      rightAngles,
      cubePosition: {
        x: this._cubePos.x,
        y: this._cubePos.y,
        z: this._cubePos.z,
      },
      cubeAttached,
      cubeLiftHeight: Math.max(0, this._cubePos.y - LAB_DIMENSIONS.CUBE_REST_Y),
      snapshot: this.getSnapshot(),
    };
  }

  private getPhaseDuration(state: MachineState): number {
    switch (state) {
      case 'APPROACHING':
        return this.durations.approach;
      case 'GRIPPING':
        return this.durations.grip;
      case 'LIFTING':
        return this.durations.lift;
      case 'LOWERING':
        return this.durations.lower;
      case 'RELEASING':
        return this.durations.release;
      case 'RETURNING':
        return this.durations.returnHome;
      default:
        return 0;
    }
  }

  private getNextState(state: MachineState): MachineState | null {
    switch (state) {
      case 'APPROACHING':
        return 'GRIPPING';
      case 'GRIPPING':
        return 'LIFTING';
      case 'LIFTING':
        return 'HOLDING';
      case 'LOWERING':
        return 'RELEASING';
      case 'RELEASING':
        return 'RETURNING';
      case 'RETURNING':
        return 'STANDBY';
      default:
        return null;
    }
  }

  private advancePhasesIfComplete(): void {
    while (this.isBusy()) {
      const duration = this.getPhaseDuration(this.state);
      if (duration <= 0 || this.phaseElapsed < duration) {
        break;
      }
      const overflow = this.phaseElapsed - duration;
      const next = this.getNextState(this.state);
      if (!next) {
        this.phaseElapsed = duration;
        break;
      }
      this.transitionTo(next, overflow);
    }
  }

  private transitionTo(next: MachineState, carryElapsed = 0): void {
    this.state = next;
    this.phaseElapsed = isMachineBusy(next) ? carryElapsed : 0;
    this.notify();
  }

  private notify(): void {
    const snap = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snap);
    }
  }
}
