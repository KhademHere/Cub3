import {
  ContinuousScrambleGenerator,
  getMoveSpec,
  type CubeMoveNotation,
  type CubeMoveSpec,
} from './cubeMoves';
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
  type ScrambleButtonMode,
  type ScrambleProgress,
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

export interface ActiveFaceTurnFrame {
  move: CubeMoveNotation;
  /** Monotonic ID uniquely identifying this individual face turn execution. */
  turnId: number;
  /** Smooth eased progress ∈ [0, 1] of the 90-degree layer twist. */
  easedProgress: number;
}

export interface ChoreographyFrame {
  leftAngles: ArmJointAngles;
  rightAngles: ArmJointAngles;
  cubePosition: Vec3;
  /** Whole-cube yaw around world Y during F/B overhead pass-off moves (0 at rest/hold). */
  cubeYaw: number;
  cubeAttached: boolean;
  /** Height of cube above resting pad (0 when seated, > 0 when lifted). */
  cubeLiftHeight: number;
  /** Present while a face layer is actively being twisted by a clamped gripper wrist. */
  activeFaceTurn: ActiveFaceTurnFrame | null;
  /** Moves whose twist phase finished during this step() call (ordered). */
  committedMoves: CubeMoveNotation[];
  snapshot: MachineSnapshot;
}

interface MoveSubStep {
  kind: string;
  duration: number;
  isTwist?: boolean;
}

/**
 * Builds the ordered physical manipulation micro-steps for any of the 12 standard moves.
 * Every micro-step maintains exact perpendicular flush contact and zero clipping.
 */
function buildMoveSteps(spec: CubeMoveSpec): MoveSubStep[] {
  if (spec.face === 'L' || spec.face === 'R') {
    return [
      {kind: 'lr_twist', duration: 0.30, isTwist: true},
      {kind: 'lr_open', duration: 0.12},
      {kind: 'lr_unwind', duration: 0.20},
      {kind: 'lr_close', duration: 0.12},
    ];
  }
  if (spec.face === 'U') {
    return [
      {kind: 'u_open_right', duration: 0.14},
      {kind: 'u_to_top', duration: 0.30},
      {kind: 'u_clamp_top', duration: 0.12},
      {kind: 'u_twist', duration: 0.30, isTwist: true},
      {kind: 'u_release_top', duration: 0.12},
      {kind: 'u_to_side', duration: 0.30},
      {kind: 'u_clamp_side', duration: 0.14},
    ];
  }
  if (spec.face === 'D') {
    return [
      {kind: 'd_open_left', duration: 0.14},
      {kind: 'd_to_bottom', duration: 0.30},
      {kind: 'd_clamp_bottom', duration: 0.12},
      {kind: 'd_twist', duration: 0.30, isTwist: true},
      {kind: 'd_release_bottom', duration: 0.12},
      {kind: 'd_to_side', duration: 0.30},
      {kind: 'd_clamp_side', duration: 0.14},
    ];
  }
  // F or B: Right arm grips Top (+Y), Left backs clear past cube diagonal,
  // Right yaws entire cube ∓90deg to present F/B face flush to Left arm,
  // Left clamps & twists layer 90deg, unwinds & backs clear, Right restores upright!
  return [
    {kind: 'fb_open_right', duration: 0.13},
    {kind: 'fb_right_to_top', duration: 0.28},
    {kind: 'fb_clamp_top', duration: 0.11},
    {kind: 'fb_open_retract_left', duration: 0.15},
    {kind: 'fb_present_cube', duration: 0.26},
    {kind: 'fb_advance_clamp_left', duration: 0.15},
    {kind: 'fb_twist', duration: 0.30, isTwist: true},
    {kind: 'fb_open_unwind_retract_left', duration: 0.20},
    {kind: 'fb_restore_cube', duration: 0.26},
    {kind: 'fb_advance_reclamp_left', duration: 0.15},
    {kind: 'fb_release_top', duration: 0.11},
    {kind: 'fb_right_to_side', duration: 0.28},
    {kind: 'fb_reclamp_right', duration: 0.13},
  ];
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

  // Overhead (U/F/B) cube shift position: right arm reaches straight down (-pi/2) cleanly inside IK envelope
  const sideRetract = 0.068;
  const rightSideClear: Vec3 = {x: half + sideRetract, y: holdY, z};
  const leftSideClear: Vec3 = {x: -(half + sideRetract), y: holdY, z};

  const cubeTopPos: Vec3 = {x: 0.09, y: 1.15, z};
  const rightTopContact: Vec3 = {x: cubeTopPos.x, y: cubeTopPos.y + half, z};
  const rightTopClear: Vec3 = {x: cubeTopPos.x, y: cubeTopPos.y + half + 0.055, z};
  const rightTopArc1: Vec3 = {x: 0.31, y: holdY + 0.125, z};
  const rightTopArc2: Vec3 = {x: 0.24, y: cubeTopPos.y + half + 0.14, z};

  // Underneath (D) cube shift position: left arm reaches straight up (+pi/2) well above tabletop
  const cubeBottomPos: Vec3 = {x: -0.09, y: 1.24, z};
  const leftBottomContact: Vec3 = {x: cubeBottomPos.x, y: cubeBottomPos.y - half, z};
  const leftBottomClear: Vec3 = {x: cubeBottomPos.x, y: cubeBottomPos.y - half - 0.045, z};
  const leftBottomArc1: Vec3 = {x: -0.31, y: holdY - 0.09, z};
  const leftBottomArc2: Vec3 = {x: -0.24, y: cubeBottomPos.y - half - 0.085, z};

  // Diagonal-clear retraction offset for Left arm while Right arm spins whole cube 90deg around Y
  const leftSpinClearOffset = 0.095;

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
    rightSideClear,
    leftSideClear,
    cubeTopPos,
    rightTopContact,
    rightTopClear,
    rightTopArc1,
    rightTopArc2,
    cubeBottomPos,
    leftBottomContact,
    leftBottomClear,
    leftBottomArc1,
    leftBottomArc2,
    leftSpinClearOffset,
  };
}

/**
 * Pure, framework-agnostic robotics choreography state machine.
 * Handles Part 1 (Pick Up / Put Down) and Part 2 (Synchronized Dual-Arm Scrambling)
 * with quintic/cubic easing and clean hooks for Part 3 (Auto-Solve).
 */
export class RoboticsChoreography {
  private state: MachineState = 'STANDBY';
  private phaseElapsed = 0;
  private totalTime = 0;
  private readonly durations: ChoreographyDurations;
  private readonly wp = makeWaypoints();
  private readonly listeners = new Set<(snapshot: MachineSnapshot) => void>();

  // Indefinite Continuous Scramble + Custom Move Queue State (reusable for Part 3 Auto-Solve!)
  private readonly scrambleGenerator: ContinuousScrambleGenerator;
  private continuousScrambleActive = false;
  private pendingContinuousScramble = false;
  private stopScrambleRequested = false;

  private moveQueue: CubeMoveNotation[] = [];
  private pendingMoveQueue: CubeMoveNotation[] | null = null;
  private currentMoveIndex = 0;
  private currentMoveSpec: CubeMoveSpec | null = null;
  private currentSteps: MoveSubStep[] = [];
  private currentStepIndex = 0;
  private stepElapsed = 0;
  private turnIdCounter = 0;
  private currentTurnId = 0;
  private scrambledFlag = false;
  private totalCommittedMoves = 0;

  // Scratch vectors to prevent GC allocations during 60fps evaluation
  private readonly _leftPos: Vec3 = {x: 0, y: 0, z: 0};
  private readonly _rightPos: Vec3 = {x: 0, y: 0, z: 0};
  private readonly _cubePos: Vec3 = {
    x: 0,
    y: LAB_DIMENSIONS.CUBE_REST_Y,
    z: LAB_DIMENSIONS.TABLE_CENTER_Z,
  };

  constructor(
    durations: Partial<ChoreographyDurations> = {},
    rng: () => number = Math.random,
  ) {
    this.durations = {...DEFAULT_DURATIONS, ...durations};
    this.scrambleGenerator = new ContinuousScrambleGenerator(rng);
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

  isScrambled(): boolean {
    return this.scrambledFlag;
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
    if (this.state === 'HOLDING' || this.state === 'SCRAMBLING') {
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

    const isScrambling = this.state === 'SCRAMBLING';
    const isStoppingScramble = isScrambling && this.stopScrambleRequested;
    const isAutoLiftingToScramble =
      (this.pendingContinuousScramble || this.pendingMoveQueue !== null) &&
      this.isBusy() &&
      !isScrambling;

    let scrambleProgress: ScrambleProgress | null = null;
    let statusLabel = MACHINE_STATUS_LABELS[this.state];
    let scrambleButtonLabel = 'Scramble';
    let scrambleButtonMode: ScrambleButtonMode = 'start';
    let scrambleButtonDisabled = this.isBusy();

    if (isScrambling && this.currentMoveSpec) {
      // Open-ended 1-based live move number; increments cleanly as each turn completes
      const moveNumber = this.currentTurnId;
      scrambleProgress = {
        moveNumber,
        currentMove: this.currentMoveSpec.notation,
        isStopping: isStoppingScramble,
      };
      if (isStoppingScramble) {
        statusLabel = `STOPPING... • Move ${moveNumber} (${this.currentMoveSpec.notation})`;
        scrambleButtonLabel = 'Stopping...';
        scrambleButtonMode = 'busy';
        scrambleButtonDisabled = true;
      } else {
        statusLabel = `SCRAMBLING • Move ${moveNumber} (${this.currentMoveSpec.notation})`;
        scrambleButtonLabel = 'Stop Scramble';
        scrambleButtonMode = 'stop';
        scrambleButtonDisabled = false;
      }
    } else if (this.state === 'HOLDING' && this.scrambledFlag) {
      statusLabel = 'HOLDING — SCRAMBLED';
      scrambleButtonLabel = 'Scramble';
      scrambleButtonMode = 'start';
      scrambleButtonDisabled = false;
    } else if (isAutoLiftingToScramble) {
      scrambleButtonLabel = 'Lifting...';
      scrambleButtonMode = 'busy';
      scrambleButtonDisabled = true;
    }

    return {
      state: this.state,
      statusLabel,
      ledMode: getArmLedMode(this.state),
      isBusy: this.isBusy(),
      isHolding: this.isHolding(),
      isScrambled: this.scrambledFlag,
      isScrambling,
      isStoppingScramble,
      primaryButtonLabel,
      primaryButtonDisabled: this.isBusy(),
      scrambleButtonLabel,
      scrambleButtonMode,
      scrambleButtonDisabled,
      phaseProgress,
      scrambleProgress,
      moveHistoryCount: this.totalCommittedMoves,
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
   * Cleanly ignored while any animation or scramble is mid-flight.
   */
  triggerPrimaryAction(): boolean {
    if (this.state === 'STANDBY') {
      this.pendingMoveQueue = null;
      this.pendingContinuousScramble = false;
      this.transitionTo('APPROACHING');
      return true;
    }
    if (this.state === 'HOLDING') {
      this.pendingMoveQueue = null;
      this.pendingContinuousScramble = false;
      this.transitionTo('LOWERING');
      return true;
    }
    return false;
  }

  /**
   * Toggle control for the "Scramble" ↔ "Stop Scramble" button:
   * - In STANDBY: auto-lifts the cube and starts indefinite continuous scrambling.
   * - In HOLDING: immediately starts (or resumes) indefinite continuous scrambling without resetting history.
   * - In SCRAMBLING: requests a graceful stop after the current 90-degree turn and neutral regrip finish.
   */
  toggleScramble(): boolean {
    if (this.state === 'SCRAMBLING') {
      return this.requestStopScramble();
    }
    if (this.isBusy()) return false;

    if (this.state === 'STANDBY') {
      this.pendingMoveQueue = null;
      this.pendingContinuousScramble = true;
      this.transitionTo('APPROACHING');
      return true;
    }
    if (this.state === 'HOLDING') {
      this.startContinuousScramble();
      return true;
    }
    return false;
  }

  /**
   * Requests a graceful stop of the active scramble.
   * Never cuts off a face twist mid-rotation — finishes the active move, snaps cubies
   * cleanly to grid, returns grippers to neutral left/right hold, then exits to HOLDING.
   */
  requestStopScramble(): boolean {
    if (this.state !== 'SCRAMBLING' || this.stopScrambleRequested) {
      return false;
    }
    this.stopScrambleRequested = true;
    this.notify();
    return true;
  }

  /**
   * Starts either indefinite continuous scrambling (when no customSequence is passed)
   * or an explicit deterministic move queue (useful for Part 3 Auto-Solve & tests).
   */
  triggerScramble(customSequence?: CubeMoveNotation[]): boolean {
    if (this.isBusy()) return false;

    if (!customSequence || customSequence.length === 0) {
      return this.toggleScramble();
    }

    const sequence = [...customSequence];
    if (this.state === 'STANDBY') {
      this.pendingContinuousScramble = false;
      this.pendingMoveQueue = sequence;
      this.transitionTo('APPROACHING');
      return true;
    }
    if (this.state === 'HOLDING') {
      this.startMoveSequence(sequence);
      return true;
    }
    return false;
  }

  /** Advances choreography by `dt` seconds and returns the current pose frame. */
  step(dt: number): ChoreographyFrame {
    const safeDt = Math.max(0, Math.min(dt, 0.25));
    this.totalTime += safeDt;

    const committedMoves: CubeMoveNotation[] = [];

    if (this.state === 'SCRAMBLING') {
      this.advanceScramble(safeDt, committedMoves);
    } else if (this.isBusy()) {
      this.phaseElapsed += safeDt;
      this.advancePhasesIfComplete(committedMoves);
    }

    return this.evaluateFrame(committedMoves);
  }

  /** Evaluates the exact kinematic pose for the current state without advancing time. */
  evaluateFrame(committedMoves: CubeMoveNotation[] = []): ChoreographyFrame {
    const wp = this.wp;
    let leftJawOpen = 1;
    let rightJawOpen = 1;
    let leftPitch = 0;
    let rightPitch = 0;
    let leftRoll = 0;
    let rightRoll = 0;
    let cubeYaw = 0;
    let cubeAttached = false;
    let activeFaceTurn: ActiveFaceTurnFrame | null = null;

    this._cubePos.x = 0;
    this._cubePos.y = LAB_DIMENSIONS.CUBE_REST_Y;
    this._cubePos.z = LAB_DIMENSIONS.TABLE_CENTER_Z;

    switch (this.state) {
      case 'STANDBY': {
        const breatheY = Math.sin(this.totalTime * 1.45) * 0.0045;
        const breatheX = Math.cos(this.totalTime * 0.9) * 0.002;
        this._leftPos.x = wp.leftStandby.x - breatheX;
        this._leftPos.y = wp.leftStandby.y + breatheY;
        this._leftPos.z = wp.leftStandby.z;

        this._rightPos.x = wp.rightStandby.x + breatheX;
        this._rightPos.y = wp.rightStandby.y + breatheY;
        this._rightPos.z = wp.rightStandby.z;

        leftPitch = -0.14;
        rightPitch = -0.14;
        leftJawOpen = 1;
        rightJawOpen = 1;
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
        const pitch = lerp(-0.14, 0, easeInOutCubic(rawT));
        leftPitch = pitch;
        rightPitch = pitch;
        leftJawOpen = 1;
        rightJawOpen = 1;
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

        leftJawOpen = lerp(1, 0, tJaw);
        rightJawOpen = leftJawOpen;
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
        leftJawOpen = 0;
        rightJawOpen = 0;
        break;
      }

      case 'HOLDING': {
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
        leftJawOpen = 0;
        rightJawOpen = 0;
        break;
      }

      case 'SCRAMBLING': {
        const pose = this.evaluateScramblePose();
        this._leftPos.x = pose.leftPos.x;
        this._leftPos.y = pose.leftPos.y;
        this._leftPos.z = pose.leftPos.z;
        this._rightPos.x = pose.rightPos.x;
        this._rightPos.y = pose.rightPos.y;
        this._rightPos.z = pose.rightPos.z;
        this._cubePos.x = pose.cubePos.x;
        this._cubePos.y = pose.cubePos.y;
        this._cubePos.z = pose.cubePos.z;
        cubeYaw = pose.cubeYaw;
        leftPitch = pose.leftPitch;
        rightPitch = pose.rightPitch;
        leftRoll = pose.leftRoll;
        rightRoll = pose.rightRoll;
        leftJawOpen = pose.leftJawOpen;
        rightJawOpen = pose.rightJawOpen;
        activeFaceTurn = pose.activeFaceTurn;
        cubeAttached = true;
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
        leftJawOpen = 0;
        rightJawOpen = 0;
        break;
      }

      case 'RELEASING': {
        const rawT = clamp01(this.phaseElapsed / this.durations.release);
        const tJaw = easeInOutCubic(rawT);
        const tRetract = easeInOutCubic(clamp01((rawT - 0.35) / 0.65));

        this._leftPos.x = lerp(wp.leftClampRest.x, wp.leftPreClamp.x, tRetract);
        this._leftPos.y = wp.leftClampRest.y;
        this._leftPos.z = wp.leftClampRest.z;

        this._rightPos.x = lerp(wp.rightClampRest.x, wp.rightPreClamp.x, tRetract);
        this._rightPos.y = wp.rightClampRest.y;
        this._rightPos.z = wp.rightClampRest.z;

        leftJawOpen = lerp(0, 1, tJaw);
        rightJawOpen = leftJawOpen;
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
        const pitch = lerp(0, -0.14, easeInOutCubic(rawT));
        leftPitch = pitch;
        rightPitch = pitch;
        leftJawOpen = 1;
        rightJawOpen = 1;
        break;
      }
    }

    const leftAngles = solveArmIK('left', this._leftPos, {
      jawOpen: leftJawOpen,
      wristRoll: leftRoll,
      gripperWorldPitch: leftPitch,
    });
    const rightAngles = solveArmIK('right', this._rightPos, {
      jawOpen: rightJawOpen,
      wristRoll: rightRoll,
      gripperWorldPitch: rightPitch,
    });

    return {
      leftAngles,
      rightAngles,
      cubePosition: {
        x: this._cubePos.x,
        y: this._cubePos.y,
        z: this._cubePos.z,
      },
      cubeYaw,
      cubeAttached,
      cubeLiftHeight: Math.max(0, this._cubePos.y - LAB_DIMENSIONS.CUBE_REST_Y),
      activeFaceTurn,
      committedMoves,
      snapshot: this.getSnapshot(),
    };
  }

  /**
   * Computes exact dual-arm positions, wrist pitches, wrist rolls, jaw openings,
   * and synchronized face-turn progress for the active scramble micro-step.
   */
  private evaluateScramblePose(): {
    leftPos: Vec3;
    rightPos: Vec3;
    cubePos: Vec3;
    cubeYaw: number;
    leftPitch: number;
    rightPitch: number;
    leftRoll: number;
    rightRoll: number;
    leftJawOpen: number;
    rightJawOpen: number;
    activeFaceTurn: ActiveFaceTurnFrame | null;
  } {
    const wp = this.wp;
    const half = LAB_DIMENSIONS.CUBE_HALF;
    const z = LAB_DIMENSIONS.TABLE_CENTER_Z;
    const holdY = LAB_DIMENSIONS.CUBE_HOLD_Y;

    // Default to standard hovering hold pose
    const cubePos: Vec3 = {x: 0, y: holdY, z};
    const leftPos: Vec3 = {x: -half, y: holdY, z};
    const rightPos: Vec3 = {x: half, y: holdY, z};
    let cubeYaw = 0;
    let leftPitch = 0;
    let rightPitch = 0;
    let leftRoll = 0;
    let rightRoll = 0;
    let leftJawOpen = 0;
    let rightJawOpen = 0;
    let activeFaceTurn: ActiveFaceTurnFrame | null = null;

    const spec = this.currentMoveSpec;
    const step = this.currentSteps[this.currentStepIndex];
    if (!spec || !step) {
      return {
        leftPos,
        rightPos,
        cubePos,
        cubeYaw,
        leftPitch,
        rightPitch,
        leftRoll,
        rightRoll,
        leftJawOpen,
        rightJawOpen,
        activeFaceTurn,
      };
    }

    const rawT = clamp01(this.stepElapsed / step.duration);
    const tCubic = easeInOutCubic(rawT);
    const tQuint = easeInOutQuint(rawT);

    // -------------------------------------------------------------------------
    // 1. L / L' and R / R': Direct synchronized wrist twist + jaw release/unwind
    // -------------------------------------------------------------------------
    if (spec.face === 'L' || spec.face === 'R') {
      const isLeft = spec.face === 'L';
      // Left wristRollPivot.rotation.x = +leftRoll; Right wristRollPivot.rotation.x = -rightRoll
      const twistTarget = isLeft ? spec.angleRad : -spec.angleRad;

      switch (step.kind) {
        case 'lr_twist':
          if (isLeft) leftRoll = twistTarget * tQuint;
          else rightRoll = twistTarget * tQuint;
          activeFaceTurn = {
            move: spec.notation,
            turnId: this.currentTurnId,
            easedProgress: tQuint,
          };
          break;
        case 'lr_open':
          if (isLeft) {
            leftRoll = twistTarget;
            leftJawOpen = tCubic;
          } else {
            rightRoll = twistTarget;
            rightJawOpen = tCubic;
          }
          break;
        case 'lr_unwind':
          if (isLeft) {
            leftRoll = lerp(twistTarget, 0, tQuint);
            leftJawOpen = 1;
          } else {
            rightRoll = lerp(twistTarget, 0, tQuint);
            rightJawOpen = 1;
          }
          break;
        case 'lr_close':
          if (isLeft) leftJawOpen = lerp(1, 0, tCubic);
          else rightJawOpen = lerp(1, 0, tCubic);
          break;
      }
      return {
        leftPos,
        rightPos,
        cubePos,
        cubeYaw,
        leftPitch,
        rightPitch,
        leftRoll,
        rightRoll,
        leftJawOpen,
        rightJawOpen,
        activeFaceTurn,
      };
    }

    // -------------------------------------------------------------------------
    // 2. U / U': Left holds -X, Right arches cleanly overhead to +Y and twists
    // -------------------------------------------------------------------------
    if (spec.face === 'U') {
      // Right overhead at pitch = -PI/2 rotates around world +Y by (-rightRoll)
      const twistTarget = -spec.angleRad;

      switch (step.kind) {
        case 'u_open_right':
          rightJawOpen = easeInOutCubic(clamp01(rawT / 0.55));
          rightPos.x = lerp(wp.rightClampHold.x, wp.rightSideClear.x, tQuint);
          break;
        case 'u_to_top':
          cubePos.x = lerp(0, wp.cubeTopPos.x, tQuint);
          cubePos.y = lerp(holdY, wp.cubeTopPos.y, tQuint);
          leftPos.x = cubePos.x - half;
          leftPos.y = cubePos.y;
          evalCubicBezier3(
            wp.rightSideClear,
            wp.rightTopArc1,
            wp.rightTopArc2,
            wp.rightTopClear,
            tQuint,
            rightPos,
          );
          rightPitch = lerp(0, -Math.PI / 2, easeInOutCubic(clamp01((rawT - 0.14) / 0.86)));
          rightJawOpen = 1;
          break;
        case 'u_clamp_top':
          cubePos.x = wp.cubeTopPos.x;
          cubePos.y = wp.cubeTopPos.y;
          leftPos.x = cubePos.x - half;
          leftPos.y = cubePos.y;
          rightPos.x = wp.rightTopContact.x;
          rightPos.y = lerp(wp.rightTopClear.y, wp.rightTopContact.y, easeInOutCubic(clamp01(rawT / 0.55)));
          rightPitch = -Math.PI / 2;
          rightJawOpen = lerp(1, 0, easeInOutCubic(clamp01((rawT - 0.25) / 0.75)));
          break;
        case 'u_twist':
          cubePos.x = wp.cubeTopPos.x;
          cubePos.y = wp.cubeTopPos.y;
          leftPos.x = cubePos.x - half;
          leftPos.y = cubePos.y;
          rightPos.x = wp.rightTopContact.x;
          rightPos.y = wp.rightTopContact.y;
          rightPitch = -Math.PI / 2;
          rightRoll = twistTarget * tQuint;
          activeFaceTurn = {
            move: spec.notation,
            turnId: this.currentTurnId,
            easedProgress: tQuint,
          };
          break;
        case 'u_release_top':
          cubePos.x = wp.cubeTopPos.x;
          cubePos.y = wp.cubeTopPos.y;
          leftPos.x = cubePos.x - half;
          leftPos.y = cubePos.y;
          rightPos.x = wp.rightTopContact.x;
          rightPos.y = lerp(wp.rightTopContact.y, wp.rightTopClear.y, easeInOutCubic(clamp01((rawT - 0.35) / 0.65)));
          rightPitch = -Math.PI / 2;
          rightRoll = twistTarget;
          rightJawOpen = easeInOutCubic(clamp01(rawT / 0.6));
          break;
        case 'u_to_side':
          cubePos.x = lerp(wp.cubeTopPos.x, 0, tQuint);
          cubePos.y = lerp(wp.cubeTopPos.y, holdY, tQuint);
          leftPos.x = cubePos.x - half;
          leftPos.y = cubePos.y;
          evalCubicBezier3(
            wp.rightTopClear,
            wp.rightTopArc2,
            wp.rightTopArc1,
            wp.rightSideClear,
            tQuint,
            rightPos,
          );
          rightPitch = lerp(-Math.PI / 2, 0, easeInOutCubic(clamp01(rawT / 0.86)));
          rightRoll = lerp(twistTarget, 0, tQuint);
          rightJawOpen = 1;
          break;
        case 'u_clamp_side':
          rightPos.x = lerp(wp.rightSideClear.x, wp.rightClampHold.x, easeInOutCubic(clamp01(rawT / 0.55)));
          rightJawOpen = lerp(1, 0, easeInOutCubic(clamp01((rawT - 0.3) / 0.7)));
          break;
      }
      return {
        leftPos,
        rightPos,
        cubePos,
        cubeYaw,
        leftPitch,
        rightPitch,
        leftRoll,
        rightRoll,
        leftJawOpen,
        rightJawOpen,
        activeFaceTurn,
      };
    }

    // -------------------------------------------------------------------------
    // 3. D / D': Right holds +X, Left sweeps underneath to -Y and twists
    // -------------------------------------------------------------------------
    if (spec.face === 'D') {
      // Left underneath at pitch = +PI/2 rotates around world +Y by (+leftRoll)
      const twistTarget = spec.angleRad;

      switch (step.kind) {
        case 'd_open_left':
          leftJawOpen = easeInOutCubic(clamp01(rawT / 0.55));
          leftPos.x = lerp(wp.leftClampHold.x, wp.leftSideClear.x, tQuint);
          break;
        case 'd_to_bottom':
          cubePos.x = lerp(0, wp.cubeBottomPos.x, tQuint);
          cubePos.y = lerp(holdY, wp.cubeBottomPos.y, tQuint);
          rightPos.x = cubePos.x + half;
          rightPos.y = cubePos.y;
          evalCubicBezier3(
            wp.leftSideClear,
            wp.leftBottomArc1,
            wp.leftBottomArc2,
            wp.leftBottomClear,
            tQuint,
            leftPos,
          );
          leftPitch = lerp(0, Math.PI / 2, easeInOutCubic(clamp01((rawT - 0.14) / 0.86)));
          leftJawOpen = 1;
          break;
        case 'd_clamp_bottom':
          cubePos.x = wp.cubeBottomPos.x;
          cubePos.y = wp.cubeBottomPos.y;
          rightPos.x = cubePos.x + half;
          rightPos.y = cubePos.y;
          leftPos.x = wp.leftBottomContact.x;
          leftPos.y = lerp(wp.leftBottomClear.y, wp.leftBottomContact.y, easeInOutCubic(clamp01(rawT / 0.55)));
          leftPitch = Math.PI / 2;
          leftJawOpen = lerp(1, 0, easeInOutCubic(clamp01((rawT - 0.25) / 0.75)));
          break;
        case 'd_twist':
          cubePos.x = wp.cubeBottomPos.x;
          cubePos.y = wp.cubeBottomPos.y;
          rightPos.x = cubePos.x + half;
          rightPos.y = cubePos.y;
          leftPos.x = wp.leftBottomContact.x;
          leftPos.y = wp.leftBottomContact.y;
          leftPitch = Math.PI / 2;
          leftRoll = twistTarget * tQuint;
          activeFaceTurn = {
            move: spec.notation,
            turnId: this.currentTurnId,
            easedProgress: tQuint,
          };
          break;
        case 'd_release_bottom':
          cubePos.x = wp.cubeBottomPos.x;
          cubePos.y = wp.cubeBottomPos.y;
          rightPos.x = cubePos.x + half;
          rightPos.y = cubePos.y;
          leftPos.x = wp.leftBottomContact.x;
          leftPos.y = lerp(wp.leftBottomContact.y, wp.leftBottomClear.y, easeInOutCubic(clamp01((rawT - 0.35) / 0.65)));
          leftPitch = Math.PI / 2;
          leftRoll = twistTarget;
          leftJawOpen = easeInOutCubic(clamp01(rawT / 0.6));
          break;
        case 'd_to_side':
          cubePos.x = lerp(wp.cubeBottomPos.x, 0, tQuint);
          cubePos.y = lerp(wp.cubeBottomPos.y, holdY, tQuint);
          rightPos.x = cubePos.x + half;
          rightPos.y = cubePos.y;
          evalCubicBezier3(
            wp.leftBottomClear,
            wp.leftBottomArc2,
            wp.leftBottomArc1,
            wp.leftSideClear,
            tQuint,
            leftPos,
          );
          leftPitch = lerp(Math.PI / 2, 0, easeInOutCubic(clamp01(rawT / 0.86)));
          leftRoll = lerp(twistTarget, 0, tQuint);
          leftJawOpen = 1;
          break;
        case 'd_clamp_side':
          leftPos.x = lerp(wp.leftSideClear.x, wp.leftClampHold.x, easeInOutCubic(clamp01(rawT / 0.55)));
          leftJawOpen = lerp(1, 0, easeInOutCubic(clamp01((rawT - 0.3) / 0.7)));
          break;
      }
      return {
        leftPos,
        rightPos,
        cubePos,
        cubeYaw,
        leftPitch,
        rightPitch,
        leftRoll,
        rightRoll,
        leftJawOpen,
        rightJawOpen,
        activeFaceTurn,
      };
    }

    // -------------------------------------------------------------------------
    // 4. F / F' and B / B': Dual-arm overhead pass-off & 90deg cube re-orientation
    // -------------------------------------------------------------------------
    // For F (+Z): yaw whole cube -PI/2 so +Z faces -X (Left arm); Left twists by -angleRad
    // For B (-Z): yaw whole cube +PI/2 so -Z faces -X (Left arm); Left twists by +angleRad
    const presentYaw = spec.face === 'F' ? -Math.PI / 2 : Math.PI / 2;
    const leftTwistTarget = spec.face === 'F' ? -spec.angleRad : spec.angleRad;
    const leftAtCubeX = wp.cubeTopPos.x - half;
    const leftClearX = leftAtCubeX - wp.leftSpinClearOffset;

    switch (step.kind) {
      case 'fb_open_right':
        rightJawOpen = easeInOutCubic(clamp01(rawT / 0.55));
        rightPos.x = lerp(wp.rightClampHold.x, wp.rightSideClear.x, tQuint);
        break;
      case 'fb_right_to_top':
        cubePos.x = lerp(0, wp.cubeTopPos.x, tQuint);
        cubePos.y = lerp(holdY, wp.cubeTopPos.y, tQuint);
        leftPos.x = cubePos.x - half;
        leftPos.y = cubePos.y;
        evalCubicBezier3(
          wp.rightSideClear,
          wp.rightTopArc1,
          wp.rightTopArc2,
          wp.rightTopClear,
          tQuint,
          rightPos,
        );
        rightPitch = lerp(0, -Math.PI / 2, easeInOutCubic(clamp01((rawT - 0.14) / 0.86)));
        rightJawOpen = 1;
        break;
      case 'fb_clamp_top':
        cubePos.x = wp.cubeTopPos.x;
        cubePos.y = wp.cubeTopPos.y;
        leftPos.x = leftAtCubeX;
        leftPos.y = cubePos.y;
        rightPos.x = wp.rightTopContact.x;
        rightPos.y = lerp(wp.rightTopClear.y, wp.rightTopContact.y, easeInOutCubic(clamp01(rawT / 0.55)));
        rightPitch = -Math.PI / 2;
        rightJawOpen = lerp(1, 0, easeInOutCubic(clamp01((rawT - 0.25) / 0.75)));
        break;
      case 'fb_open_retract_left':
        cubePos.x = wp.cubeTopPos.x;
        cubePos.y = wp.cubeTopPos.y;
        rightPos.x = wp.rightTopContact.x;
        rightPos.y = wp.rightTopContact.y;
        rightPitch = -Math.PI / 2;
        leftJawOpen = easeInOutCubic(clamp01(rawT / 0.55));
        leftPos.x = lerp(leftAtCubeX, leftClearX, tQuint);
        leftPos.y = cubePos.y;
        break;
      case 'fb_present_cube':
        cubePos.x = wp.cubeTopPos.x;
        cubePos.y = wp.cubeTopPos.y;
        cubeYaw = presentYaw * tQuint;
        rightPos.x = wp.rightTopContact.x;
        rightPos.y = wp.rightTopContact.y;
        rightPitch = -Math.PI / 2;
        rightRoll = -cubeYaw;
        leftPos.x = leftClearX;
        leftPos.y = cubePos.y;
        leftJawOpen = 1;
        break;
      case 'fb_advance_clamp_left':
        cubePos.x = wp.cubeTopPos.x;
        cubePos.y = wp.cubeTopPos.y;
        cubeYaw = presentYaw;
        rightPos.x = wp.rightTopContact.x;
        rightPos.y = wp.rightTopContact.y;
        rightPitch = -Math.PI / 2;
        rightRoll = -presentYaw;
        leftPos.x = lerp(leftClearX, leftAtCubeX, easeInOutQuint(clamp01(rawT / 0.6)));
        leftPos.y = cubePos.y;
        leftJawOpen = lerp(1, 0, easeInOutCubic(clamp01((rawT - 0.35) / 0.65)));
        break;
      case 'fb_twist':
        cubePos.x = wp.cubeTopPos.x;
        cubePos.y = wp.cubeTopPos.y;
        cubeYaw = presentYaw;
        rightPos.x = wp.rightTopContact.x;
        rightPos.y = wp.rightTopContact.y;
        rightPitch = -Math.PI / 2;
        rightRoll = -presentYaw;
        leftPos.x = leftAtCubeX;
        leftPos.y = cubePos.y;
        leftRoll = leftTwistTarget * tQuint;
        activeFaceTurn = {
          move: spec.notation,
          turnId: this.currentTurnId,
          easedProgress: tQuint,
        };
        break;
      case 'fb_open_unwind_retract_left':
        cubePos.x = wp.cubeTopPos.x;
        cubePos.y = wp.cubeTopPos.y;
        cubeYaw = presentYaw;
        rightPos.x = wp.rightTopContact.x;
        rightPos.y = wp.rightTopContact.y;
        rightPitch = -Math.PI / 2;
        rightRoll = -presentYaw;
        leftJawOpen = easeInOutCubic(clamp01(rawT / 0.45));
        leftPos.x = lerp(leftAtCubeX, leftClearX, tQuint);
        leftPos.y = cubePos.y;
        leftRoll = lerp(
          leftTwistTarget,
          0,
          easeInOutQuint(clamp01((rawT - 0.25) / 0.75)),
        );
        break;
      case 'fb_restore_cube':
        cubePos.x = wp.cubeTopPos.x;
        cubePos.y = wp.cubeTopPos.y;
        cubeYaw = lerp(presentYaw, 0, tQuint);
        rightPos.x = wp.rightTopContact.x;
        rightPos.y = wp.rightTopContact.y;
        rightPitch = -Math.PI / 2;
        rightRoll = -cubeYaw;
        leftPos.x = leftClearX;
        leftPos.y = cubePos.y;
        leftJawOpen = 1;
        break;
      case 'fb_advance_reclamp_left':
        cubePos.x = wp.cubeTopPos.x;
        cubePos.y = wp.cubeTopPos.y;
        rightPos.x = wp.rightTopContact.x;
        rightPos.y = wp.rightTopContact.y;
        rightPitch = -Math.PI / 2;
        leftPos.x = lerp(leftClearX, leftAtCubeX, easeInOutQuint(clamp01(rawT / 0.6)));
        leftPos.y = cubePos.y;
        leftJawOpen = lerp(1, 0, easeInOutCubic(clamp01((rawT - 0.35) / 0.65)));
        break;
      case 'fb_release_top':
        cubePos.x = wp.cubeTopPos.x;
        cubePos.y = wp.cubeTopPos.y;
        leftPos.x = leftAtCubeX;
        leftPos.y = cubePos.y;
        rightPos.x = wp.rightTopContact.x;
        rightPos.y = lerp(wp.rightTopContact.y, wp.rightTopClear.y, easeInOutCubic(clamp01((rawT - 0.35) / 0.65)));
        rightPitch = -Math.PI / 2;
        rightJawOpen = easeInOutCubic(clamp01(rawT / 0.6));
        break;
      case 'fb_right_to_side':
        cubePos.x = lerp(wp.cubeTopPos.x, 0, tQuint);
        cubePos.y = lerp(wp.cubeTopPos.y, holdY, tQuint);
        leftPos.x = cubePos.x - half;
        leftPos.y = cubePos.y;
        evalCubicBezier3(
          wp.rightTopClear,
          wp.rightTopArc2,
          wp.rightTopArc1,
          wp.rightSideClear,
          tQuint,
          rightPos,
        );
        rightPitch = lerp(-Math.PI / 2, 0, easeInOutCubic(clamp01(rawT / 0.86)));
        rightJawOpen = 1;
        break;
      case 'fb_reclamp_right':
        rightPos.x = lerp(wp.rightSideClear.x, wp.rightClampHold.x, easeInOutCubic(clamp01(rawT / 0.55)));
        rightJawOpen = lerp(1, 0, easeInOutCubic(clamp01((rawT - 0.3) / 0.7)));
        break;
    }

    return {
      leftPos,
      rightPos,
      cubePos,
      cubeYaw,
      leftPitch,
      rightPitch,
      leftRoll,
      rightRoll,
      leftJawOpen,
      rightJawOpen,
      activeFaceTurn,
    };
  }

  private startContinuousScramble(): void {
    this.continuousScrambleActive = true;
    this.pendingContinuousScramble = false;
    this.stopScrambleRequested = false;
    this.moveQueue = [];
    this.pendingMoveQueue = null;
    this.currentMoveIndex = 0;
    this.loadMoveNotation(this.scrambleGenerator.next());
    this.transitionTo('SCRAMBLING');
  }

  private startMoveSequence(sequence: CubeMoveNotation[]): void {
    this.continuousScrambleActive = false;
    this.pendingContinuousScramble = false;
    this.stopScrambleRequested = false;
    this.moveQueue = sequence;
    this.pendingMoveQueue = null;
    this.currentMoveIndex = 0;
    const first = this.moveQueue[0];
    if (first) {
      this.scrambleGenerator.recordExternalFace(getMoveSpec(first).face);
      this.loadMoveNotation(first);
      this.transitionTo('SCRAMBLING');
    }
  }

  private loadMoveNotation(notation: CubeMoveNotation): void {
    this.currentMoveSpec = getMoveSpec(notation);
    this.currentSteps = buildMoveSteps(this.currentMoveSpec);
    this.currentStepIndex = 0;
    this.stepElapsed = 0;
    this.turnIdCounter += 1;
    this.currentTurnId = this.turnIdCounter;
  }

  private advanceScramble(dt: number, committedMoves: CubeMoveNotation[]): void {
    this.stepElapsed += dt;

    while (this.state === 'SCRAMBLING') {
      const step = this.currentSteps[this.currentStepIndex];
      if (!step) {
        this.finishScramble();
        break;
      }
      if (this.stepElapsed < step.duration) {
        break;
      }

      const overflow = this.stepElapsed - step.duration;
      if (step.isTwist && this.currentMoveSpec) {
        committedMoves.push(this.currentMoveSpec.notation);
        this.totalCommittedMoves += 1;
        this.scrambledFlag = true;
      }

      this.currentStepIndex += 1;
      if (this.currentStepIndex < this.currentSteps.length) {
        this.stepElapsed = overflow;
      } else {
        // Current move + neutral regrip finished cleanly!
        if (this.stopScrambleRequested) {
          this.finishScramble();
          break;
        }

        if (this.continuousScrambleActive) {
          // Generate the next non-redundant move on the fly indefinitely
          const nextMove = this.scrambleGenerator.next();
          this.loadMoveNotation(nextMove);
          this.stepElapsed = overflow;
          this.notify();
        } else {
          // Finite scripted sequence (tests / Part 3 Auto-Solve)
          this.currentMoveIndex += 1;
          if (this.currentMoveIndex < this.moveQueue.length) {
            const nextMove = this.moveQueue[this.currentMoveIndex];
            this.scrambleGenerator.recordExternalFace(getMoveSpec(nextMove).face);
            this.loadMoveNotation(nextMove);
            this.stepElapsed = overflow;
            this.notify();
          } else {
            this.finishScramble();
            break;
          }
        }
      }
    }
  }

  private finishScramble(): void {
    this.continuousScrambleActive = false;
    this.stopScrambleRequested = false;
    this.moveQueue = [];
    this.currentMoveSpec = null;
    this.currentSteps = [];
    this.currentStepIndex = 0;
    this.stepElapsed = 0;
    this.transitionTo('HOLDING');
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

  private advancePhasesIfComplete(committedMoves: CubeMoveNotation[]): void {
    while (this.isBusy() && this.state !== 'SCRAMBLING') {
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

      // Seamless Auto-Lift Integration: once LIFTING reaches HOLDING, immediately start scrambling!
      if (next === 'HOLDING' && this.pendingContinuousScramble) {
        this.startContinuousScramble();
        if (overflow > 0) {
          this.advanceScramble(overflow, committedMoves);
        }
        break;
      }
      if (next === 'HOLDING' && this.pendingMoveQueue && this.pendingMoveQueue.length > 0) {
        const queued = this.pendingMoveQueue;
        this.startMoveSequence(queued);
        if (overflow > 0) {
          this.advanceScramble(overflow, committedMoves);
        }
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
