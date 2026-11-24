import {
  ContinuousScrambleGenerator,
  computeOptimizedSolution,
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
  type MotionSpeed,
  type ScrambleButtonMode,
  type ScrambleProgress,
  type SolveProgress,
  type Vec3,
} from './types';

export interface ChoreographyDurations {
  approach: number;
  grip: number;
  lift: number;
  celebrate: number;
  lower: number;
  release: number;
  returnHome: number;
}

export const DEFAULT_DURATIONS: ChoreographyDurations = {
  approach: 1.35,
  grip: 0.65,
  lift: 1.25,
  celebrate: 1.5,
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
  /** Whole-cube pitch around world X during completion presentation flourish (0 otherwise). */
  cubePitch: number;
  /** Whole-cube yaw around world Y during F/B overhead pass-off moves (0 at rest/hold). */
  cubeYaw: number;
  cubeAttached: boolean;
  /** Height of cube above resting pad (0 when seated, > 0 when lifted). */
  cubeLiftHeight: number;
  /** Present while a face layer is actively being twisted by a clamped gripper wrist. */
  activeFaceTurn: ActiveFaceTurnFrame | null;
  /** Moves whose twist phase finished during this step() call (ordered). */
  committedMoves: CubeMoveNotation[];
  /** Whether committed moves in this frame should be appended to RubiksCube moveHistory. */
  committedMovesRecordHistory: boolean;
  /** True on the exact frame a solve completes so RubiksCube clears moveHistory. */
  clearHistoryOnFinish: boolean;
  snapshot: MachineSnapshot;
}

interface MoveSubStep {
  kind: string;
  duration: number;
  isTwist?: boolean;
}

/**
 * Builds the ordered physical manipulation micro-steps for any of the 12 standard moves.
 * Every transition enforces a strict 3-step Retract -> Exterior Arc / Unwind -> Straight Approach
 * clearance protocol so neither arm ever clips into the cube, the other arm, or the tabletop.
 */
function buildMoveSteps(spec: CubeMoveSpec): MoveSubStep[] {
  if (spec.face === 'L' || spec.face === 'R') {
    return [
      {kind: 'lr_twist', duration: 0.30, isTwist: true},
      {kind: 'lr_open_retract', duration: 0.14},
      {kind: 'lr_unwind', duration: 0.20},
      {kind: 'lr_approach_close', duration: 0.15},
    ];
  }
  if (spec.face === 'U') {
    return [
      {kind: 'u_open_right', duration: 0.14},
      {kind: 'u_to_top', duration: 0.32},
      {kind: 'u_clamp_top', duration: 0.14},
      {kind: 'u_twist', duration: 0.30, isTwist: true},
      {kind: 'u_release_top', duration: 0.14},
      {kind: 'u_to_side', duration: 0.32},
      {kind: 'u_clamp_side', duration: 0.14},
    ];
  }
  if (spec.face === 'D') {
    return [
      {kind: 'd_flip_cube', duration: 0.34},
      {kind: 'd_open_right', duration: 0.14},
      {kind: 'd_to_top', duration: 0.32},
      {kind: 'd_clamp_top', duration: 0.14},
      {kind: 'd_twist', duration: 0.30, isTwist: true},
      {kind: 'd_release_top', duration: 0.14},
      {kind: 'd_to_side', duration: 0.32},
      {kind: 'd_clamp_side', duration: 0.14},
      {kind: 'd_unflip_cube', duration: 0.34},
    ];
  }
  // F or B:
  // 1. Right retracts out, arcs overhead, clamps +Y on ±Z.
  // 2. Left opens & retracts wide clear of cube diagonal + rotating Right rail.
  // 3. Right yaws whole cube ∓90deg to present F/B flush to Left (-X).
  // 4. Left advances & clamps -X (on ±Z, 57mm clear below Right jaws!).
  // 5. Right opens, lifts straight UP clear of cube, unwinds wrist roll back to ±Z
  //    (strictly centered on stationary middle slice X ∈ [-22mm, +22mm]), and re-clamps +Y!
  // 6. Left twists F/B 90deg with 57mm pure horizontal clearance from Right gripper!
  // 7. Left opens, retracts wide clear, and unwinds wrist roll back to 0 in open air.
  // 8. Right restores cube yaw smoothly back to 0 (rotating its wrist 0 -> +presentYaw).
  // 9. Left advances & re-clamps -X; Right releases +Y, lifts straight UP, arcs cleanly
  //    back to right side while unwinding roll to 0, approaches flush & re-clamps +X!
  return [
    {kind: 'fb_open_right', duration: 0.13},
    {kind: 'fb_right_to_top', duration: 0.30},
    {kind: 'fb_clamp_top', duration: 0.13},
    {kind: 'fb_open_retract_left', duration: 0.15},
    {kind: 'fb_present_cube', duration: 0.26},
    {kind: 'fb_advance_clamp_left', duration: 0.15},
    {kind: 'fb_right_release_top_unwind', duration: 0.13},
    {kind: 'fb_right_unwind_top', duration: 0.18},
    {kind: 'fb_right_reclamp_top', duration: 0.13},
    {kind: 'fb_twist', duration: 0.30, isTwist: true},
    {kind: 'fb_open_retract_left_post', duration: 0.15},
    {kind: 'fb_unwind_left_clear', duration: 0.16},
    {kind: 'fb_restore_cube', duration: 0.26},
    {kind: 'fb_advance_reclamp_left', duration: 0.15},
    {kind: 'fb_release_top', duration: 0.13},
    {kind: 'fb_right_to_side', duration: 0.30},
    {kind: 'fb_reclamp_right', duration: 0.13},
  ];
}

/** Pre-computed symmetrical anchor points in world space (exact flush outer tile contact + safe clearance). */
function makeWaypoints() {
  const z = LAB_DIMENSIONS.TABLE_CENTER_Z;
  const restY = LAB_DIMENSIONS.CUBE_REST_Y;
  const holdY = LAB_DIMENSIONS.CUBE_HOLD_Y;
  const half = LAB_DIMENSIONS.CUBE_OUTER_HALF;

  // Poised industrial standby: elevated, open wide, flared outward
  const leftStandby: Vec3 = {x: -0.32, y: restY + 0.265, z: z - 0.035};
  const rightStandby: Vec3 = {x: 0.32, y: restY + 0.265, z: z - 0.035};

  // Elevated exterior Bezier control points so Pick Up / Put Down descend cleanly
  // outside the cube and never dip into the workbench surface or cube corners
  const leftCtrl1: Vec3 = {x: -0.295, y: restY + 0.28, z: z - 0.012};
  const leftCtrl2: Vec3 = {x: -0.225, y: restY + 0.095, z: z};
  const rightCtrl1: Vec3 = {x: 0.295, y: restY + 0.28, z: z - 0.012};
  const rightCtrl2: Vec3 = {x: 0.225, y: restY + 0.095, z: z};

  // Horizontal pre-clamp standoff: 58mm outside outer tile surface (jaw tips 30mm completely clear!)
  const preClampGap = 0.058;
  const leftPreClamp: Vec3 = {x: -(half + preClampGap), y: restY, z};
  const rightPreClamp: Vec3 = {x: half + preClampGap, y: restY, z};

  // Exact flush clamp contact on cube's left (-X) and right (+X) outer tile surfaces
  const leftClampRest: Vec3 = {x: -half, y: restY, z};
  const rightClampRest: Vec3 = {x: half, y: restY, z};

  // Central hovering Ready Position in mid-air
  const leftClampHold: Vec3 = {x: -half, y: holdY, z};
  const rightClampHold: Vec3 = {x: half, y: holdY, z};

  // Safe retract standoff for L/R wrist unwind (62mm outside cube face -> jaw tips 34mm clear!)
  const lrUnwindRetract = 0.062;
  const leftUnwindClear: Vec3 = {x: -(half + lrUnwindRetract), y: holdY, z};
  const rightUnwindClear: Vec3 = {x: half + lrUnwindRetract, y: holdY, z};

  // Mandatory exterior retract standoff for face-to-face arcs (88mm outside cube face -> jaw tips 60mm clear!)
  const sideRetract = 0.088;
  const rightSideClear: Vec3 = {x: half + sideRetract, y: holdY, z};
  const leftSideClear: Vec3 = {x: -(half + sideRetract), y: holdY, z};

  // Overhead (U/F/B) cube shift position: right arm reaches straight down (-pi/2) well inside IK envelope
  const cubeTopPos: Vec3 = {x: 0.09, y: 1.13, z};
  const rightTopContact: Vec3 = {x: cubeTopPos.x, y: cubeTopPos.y + half, z};
  const rightTopClear: Vec3 = {x: cubeTopPos.x, y: cubeTopPos.y + half + 0.082, z};
  const rightTopArc1: Vec3 = {x: 0.34, y: 1.34, z};
  const rightTopArc2: Vec3 = {x: 0.28, y: 1.42, z};

  // Underneath (D) cube shift position: left arm reaches straight up (+pi/2) with >= 75mm tabletop clearance!
  const cubeBottomPos: Vec3 = {x: -0.09, y: 1.27, z};
  const leftBottomContact: Vec3 = {x: cubeBottomPos.x, y: cubeBottomPos.y - half, z};
  const leftBottomClear: Vec3 = {x: cubeBottomPos.x, y: cubeBottomPos.y - half - 0.082, z};
  const leftBottomArc1: Vec3 = {x: -0.34, y: 1.09, z};
  const leftBottomArc2: Vec3 = {x: -0.28, y: 1.02, z};

  // Wide diagonal + opposing-rail clearance for Left arm during F/B whole-cube 90deg yaw
  // Jaw tips sit at cubeX - (0.107 + 0.125 - 0.028) = cubeX - 0.204m (> 30mm clear of rotating Right rail!)
  const leftSpinClearOffset = 0.125;

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
    leftUnwindClear,
    rightUnwindClear,
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

  // Indefinite Continuous Scramble + Deterministic Auto-Solve Queue State
  private readonly scrambleGenerator: ContinuousScrambleGenerator;
  private continuousScrambleActive = false;
  private pendingContinuousScramble = false;
  private stopScrambleRequested = false;

  private moveQueue: CubeMoveNotation[] = [];
  private pendingMoveQueue: CubeMoveNotation[] | null = null;
  private pendingSolveQueue: CubeMoveNotation[] | null = null;
  private currentMoveIndex = 0;
  private currentMoveSpec: CubeMoveSpec | null = null;
  private currentSteps: MoveSubStep[] = [];
  private currentStepIndex = 0;
  private stepElapsed = 0;
  private turnIdCounter = 0;
  private currentTurnId = 0;
  private scrambledFlag = false;
  private justSolvedFlag = false;
  private totalCommittedMoves = 0;
  private solveTotalMoves = 0;
  private speedMultiplier: MotionSpeed = 1;
  private pendingClearHistory = false;

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

  getSpeedMultiplier(): MotionSpeed {
    return this.speedMultiplier;
  }

  /**
   * Adjusts choreography playback speed live (0.5x Precision, 1x Smooth, 2x Turbo)
   * even mid-scramble or mid-solve without disrupting easing or zero-drift snapping.
   */
  setSpeedMultiplier(speed: MotionSpeed): void {
    if (this.speedMultiplier === speed) return;
    this.speedMultiplier = speed;
    this.notify();
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
    if (
      this.state === 'HOLDING' ||
      this.state === 'SCRAMBLING' ||
      this.state === 'SOLVING' ||
      this.state === 'CELEBRATING'
    ) {
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
    const isSolving = this.state === 'SOLVING';
    const isCelebrating = this.state === 'CELEBRATING';
    const isAutoLiftingToScramble =
      (this.pendingContinuousScramble || this.pendingMoveQueue !== null) &&
      this.isBusy() &&
      !isScrambling;
    const isAutoLiftingToSolve =
      this.pendingSolveQueue !== null && this.isBusy() && !isSolving;

    let scrambleProgress: ScrambleProgress | null = null;
    let solveProgress: SolveProgress | null = null;
    let statusLabel = MACHINE_STATUS_LABELS[this.state];
    let scrambleButtonLabel = 'Scramble';
    let scrambleButtonMode: ScrambleButtonMode = 'start';
    let scrambleButtonDisabled = this.isBusy();

    const isSolvedBadge =
      isCelebrating || (this.justSolvedFlag && !this.scrambledFlag);

    let solveButtonLabel = 'Auto-Solve';
    let solveButtonDisabled =
      this.isBusy() || !this.scrambledFlag || this.totalCommittedMoves === 0;

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
    } else if (isSolving && this.currentMoveSpec) {
      const remainingMoves = Math.max(
        1,
        this.moveQueue.length - this.currentMoveIndex,
      );
      solveProgress = {
        remainingMoves,
        totalMoves: this.solveTotalMoves,
        currentMove: this.currentMoveSpec.notation,
      };
      const unit = remainingMoves === 1 ? 'move' : 'moves';
      statusLabel = `SOLVING • ${remainingMoves} ${unit} left (${this.currentMoveSpec.notation})`;
      solveButtonLabel = 'Solving...';
      solveButtonDisabled = true;
    } else if (isCelebrating) {
      statusLabel = 'SOLVED ✓';
      solveButtonLabel = 'Solved';
      solveButtonDisabled = true;
    } else if (isAutoLiftingToSolve) {
      solveButtonLabel = 'Lifting...';
      solveButtonDisabled = true;
    } else if (this.state === 'HOLDING' && this.scrambledFlag) {
      statusLabel = 'HOLDING — SCRAMBLED';
      scrambleButtonLabel = 'Scramble';
      scrambleButtonMode = 'start';
      scrambleButtonDisabled = false;
    } else if (this.state === 'HOLDING' && this.justSolvedFlag) {
      statusLabel = 'HOLDING — SOLVED ✓';
      solveButtonLabel = 'Solved';
      solveButtonDisabled = true;
    } else if (this.state === 'STANDBY' && this.justSolvedFlag && !this.scrambledFlag) {
      solveButtonLabel = 'Solved';
      solveButtonDisabled = true;
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
      isSolving,
      isSolvedBadge,
      primaryButtonLabel,
      primaryButtonDisabled: this.isBusy(),
      scrambleButtonLabel,
      scrambleButtonMode,
      scrambleButtonDisabled,
      solveButtonLabel,
      solveButtonDisabled,
      speedMultiplier: this.speedMultiplier,
      phaseProgress,
      scrambleProgress,
      solveProgress,
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
   * Cleanly ignored while any animation, scramble, or solve is mid-flight.
   */
  triggerPrimaryAction(): boolean {
    if (this.state === 'STANDBY') {
      this.pendingMoveQueue = null;
      this.pendingContinuousScramble = false;
      this.pendingSolveQueue = null;
      this.transitionTo('APPROACHING');
      return true;
    }
    if (this.state === 'HOLDING') {
      this.pendingMoveQueue = null;
      this.pendingContinuousScramble = false;
      this.pendingSolveQueue = null;
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
      this.pendingSolveQueue = null;
      this.pendingContinuousScramble = true;
      this.justSolvedFlag = false;
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
   * or an explicit deterministic move queue.
   */
  triggerScramble(customSequence?: CubeMoveNotation[]): boolean {
    if (this.isBusy()) return false;

    if (!customSequence || customSequence.length === 0) {
      return this.toggleScramble();
    }

    const sequence = [...customSequence];
    if (this.state === 'STANDBY') {
      this.pendingContinuousScramble = false;
      this.pendingSolveQueue = null;
      this.pendingMoveQueue = sequence;
      this.justSolvedFlag = false;
      this.transitionTo('APPROACHING');
      return true;
    }
    if (this.state === 'HOLDING') {
      this.startMoveSequence(sequence);
      return true;
    }
    return false;
  }

  /**
   * Computes a mathematically exact, optimized solution from accumulated `moveHistory`
   * and executes it through the synchronized dual-arm manipulation engine.
   * Automatically lifts the cube first if currently resting in STANDBY.
   */
  triggerAutoSolve(moveHistory: readonly CubeMoveNotation[]): boolean {
    if (this.isBusy() || moveHistory.length === 0) {
      return false;
    }

    const solution = computeOptimizedSolution(moveHistory);
    if (solution.length === 0) {
      // Moves cancelled out to identity — mark solved cleanly
      this.scrambledFlag = false;
      this.justSolvedFlag = true;
      this.totalCommittedMoves = 0;
      this.solveTotalMoves = 0;
      this.pendingClearHistory = true;
      if (this.state === 'HOLDING') {
        this.transitionTo('CELEBRATING');
      } else {
        this.notify();
      }
      return true;
    }

    if (this.state === 'STANDBY') {
      this.pendingContinuousScramble = false;
      this.pendingMoveQueue = null;
      this.pendingSolveQueue = solution;
      this.transitionTo('APPROACHING');
      return true;
    }
    if (this.state === 'HOLDING') {
      this.startSolveSequence(solution);
      return true;
    }
    return false;
  }

  /** Advances choreography by `dt` seconds and returns the current pose frame. */
  step(dt: number): ChoreographyFrame {
    const safeDt = Math.max(0, Math.min(dt, 0.25));
    this.totalTime += safeDt;

    const scaledDt = safeDt * this.speedMultiplier;
    const committedMoves: CubeMoveNotation[] = [];
    let committedMovesRecordHistory = this.state !== 'SOLVING';
    let clearHistoryOnFinish = this.pendingClearHistory;
    this.pendingClearHistory = false;

    if (this.state === 'SCRAMBLING' || this.state === 'SOLVING') {
      committedMovesRecordHistory = this.state === 'SCRAMBLING';
      const solvedNow = this.advanceActiveMove(scaledDt, committedMoves);
      if (solvedNow) {
        clearHistoryOnFinish = true;
      }
    } else if (this.isBusy()) {
      this.phaseElapsed += scaledDt;
      const result = this.advancePhasesIfComplete(committedMoves);
      if (result.didSolveMove) {
        committedMovesRecordHistory = false;
      }
      if (result.solvedNow) {
        clearHistoryOnFinish = true;
      }
    }

    return this.evaluateFrame(
      committedMoves,
      committedMovesRecordHistory,
      clearHistoryOnFinish,
    );
  }

  /** Evaluates the exact kinematic pose for the current state without advancing time. */
  evaluateFrame(
    committedMoves: CubeMoveNotation[] = [],
    committedMovesRecordHistory = true,
    clearHistoryOnFinish = false,
  ): ChoreographyFrame {
    const wp = this.wp;
    let leftJawOpen = 1;
    let rightJawOpen = 1;
    let leftPitch = 0;
    let rightPitch = 0;
    let leftRoll = 0;
    let rightRoll = 0;
    let cubePitch = 0;
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
        // Two-stage clean clamp: advance straight inward with jaws wide open, then clamp flush!
        const rawT = clamp01(this.phaseElapsed / this.durations.grip);
        const tPos = easeInOutQuint(clamp01(rawT / 0.52));
        const tJaw = easeInOutCubic(clamp01((rawT - 0.45) / 0.55));

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

      case 'SCRAMBLING':
      case 'SOLVING': {
        const pose = this.evaluateActiveMovePose();
        this._leftPos.x = pose.leftPos.x;
        this._leftPos.y = pose.leftPos.y;
        this._leftPos.z = pose.leftPos.z;
        this._rightPos.x = pose.rightPos.x;
        this._rightPos.y = pose.rightPos.y;
        this._rightPos.z = pose.rightPos.z;
        this._cubePos.x = pose.cubePos.x;
        this._cubePos.y = pose.cubePos.y;
        this._cubePos.z = pose.cubePos.z;
        cubePitch = pose.cubePitch;
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

      case 'CELEBRATING': {
        // Subtle, refined presentation tilt in mid-air while both clamps rotate
        // in exact 1:1 lockstep on the left (-X) and right (+X) cube faces.
        const rawT = clamp01(this.phaseElapsed / this.durations.celebrate);
        const liftFlourish = Math.sin(rawT * Math.PI) * 0.026;
        const y = LAB_DIMENSIONS.CUBE_HOLD_Y + liftFlourish;

        // Smooth quintic presentation bow: 0 -> +0.44 rad -> -0.22 rad -> 0
        let tilt = 0;
        if (rawT < 0.36) {
          tilt = lerp(0, 0.44, easeInOutQuint(rawT / 0.36));
        } else if (rawT < 0.72) {
          tilt = lerp(0.44, -0.22, easeInOutQuint((rawT - 0.36) / 0.36));
        } else {
          tilt = lerp(-0.22, 0, easeInOutQuint((rawT - 0.72) / 0.28));
        }

        this._leftPos.x = wp.leftClampHold.x;
        this._leftPos.y = y;
        this._leftPos.z = wp.leftClampHold.z;

        this._rightPos.x = wp.rightClampHold.x;
        this._rightPos.y = y;
        this._rightPos.z = wp.rightClampHold.z;

        this._cubePos.y = y;
        cubePitch = tilt;
        // Left wristRollPivot.rotation.x = +leftRoll; Right wristRollPivot.rotation.x = -rightRoll
        leftRoll = tilt;
        rightRoll = -tilt;
        leftJawOpen = 0;
        rightJawOpen = 0;
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
        // Two-stage clean release: open jaws wide first, then retract straight outward clear of cube!
        const rawT = clamp01(this.phaseElapsed / this.durations.release);
        const tJaw = easeInOutCubic(clamp01(rawT / 0.48));
        const tRetract = easeInOutQuint(clamp01((rawT - 0.42) / 0.58));

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
      cubePitch,
      cubeYaw,
      cubeAttached,
      cubeLiftHeight: Math.max(0, this._cubePos.y - LAB_DIMENSIONS.CUBE_REST_Y),
      activeFaceTurn,
      committedMoves,
      committedMovesRecordHistory,
      clearHistoryOnFinish,
      snapshot: this.getSnapshot(),
    };
  }

  /**
   * Computes exact dual-arm positions, wrist pitches, wrist rolls, jaw openings,
   * and synchronized face-turn progress for the active scramble or auto-solve micro-step.
   */
  private evaluateActiveMovePose(): {
    leftPos: Vec3;
    rightPos: Vec3;
    cubePos: Vec3;
    cubePitch: number;
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
    const half = LAB_DIMENSIONS.CUBE_OUTER_HALF;
    const z = LAB_DIMENSIONS.TABLE_CENTER_Z;
    const holdY = LAB_DIMENSIONS.CUBE_HOLD_Y;

    // Default to standard hovering hold pose
    const cubePos: Vec3 = {x: 0, y: holdY, z};
    const leftPos: Vec3 = {x: -half, y: holdY, z};
    const rightPos: Vec3 = {x: half, y: holdY, z};
    let cubePitch = 0;
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
        cubePitch,
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
    // 1. L / L' and R / R': Twist -> Open & Retract Clear -> Unwind -> Approach & Clamp
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
        case 'lr_open_retract': {
          const tOpen = easeInOutCubic(clamp01(rawT / 0.5));
          const tRetract = easeInOutQuint(clamp01((rawT - 0.32) / 0.68));
          if (isLeft) {
            leftRoll = twistTarget;
            leftJawOpen = tOpen;
            leftPos.x = lerp(wp.leftClampHold.x, wp.leftUnwindClear.x, tRetract);
          } else {
            rightRoll = twistTarget;
            rightJawOpen = tOpen;
            rightPos.x = lerp(wp.rightClampHold.x, wp.rightUnwindClear.x, tRetract);
          }
          break;
        }
        case 'lr_unwind':
          if (isLeft) {
            leftPos.x = wp.leftUnwindClear.x;
            leftRoll = lerp(twistTarget, 0, tQuint);
            leftJawOpen = 1;
          } else {
            rightPos.x = wp.rightUnwindClear.x;
            rightRoll = lerp(twistTarget, 0, tQuint);
            rightJawOpen = 1;
          }
          break;
        case 'lr_approach_close': {
          const tIn = easeInOutQuint(clamp01(rawT / 0.58));
          const tClose = easeInOutCubic(clamp01((rawT - 0.48) / 0.52));
          if (isLeft) {
            leftPos.x = lerp(wp.leftUnwindClear.x, wp.leftClampHold.x, tIn);
            leftJawOpen = lerp(1, 0, tClose);
          } else {
            rightPos.x = lerp(wp.rightUnwindClear.x, wp.rightClampHold.x, tIn);
            rightJawOpen = lerp(1, 0, tClose);
          }
          break;
        }
      }
      return {
        leftPos,
        rightPos,
        cubePos,
        cubePitch,
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
    // 2. U / U': Left holds -X center slice, Right Retracts -> Exterior Arc -> Approaches +Y
    // -------------------------------------------------------------------------
    if (spec.face === 'U') {
      // Right overhead at pitch = -PI/2 rotates around world +Y by (-rightRoll)
      const twistTarget = -spec.angleRad;

      switch (step.kind) {
        case 'u_open_right':
          rightJawOpen = easeInOutCubic(clamp01(rawT / 0.45));
          rightPos.x = lerp(
            wp.rightClampHold.x,
            wp.rightSideClear.x,
            easeInOutQuint(clamp01((rawT - 0.25) / 0.75)),
          );
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
          rightPos.y = lerp(
            wp.rightTopClear.y,
            wp.rightTopContact.y,
            easeInOutQuint(clamp01(rawT / 0.56)),
          );
          rightPitch = -Math.PI / 2;
          rightJawOpen = lerp(1, 0, easeInOutCubic(clamp01((rawT - 0.48) / 0.52)));
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
          rightPos.y = lerp(
            wp.rightTopContact.y,
            wp.rightTopClear.y,
            easeInOutQuint(clamp01((rawT - 0.35) / 0.65)),
          );
          rightPitch = -Math.PI / 2;
          rightRoll = twistTarget;
          rightJawOpen = easeInOutCubic(clamp01(rawT / 0.48));
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
          rightPos.x = lerp(
            wp.rightSideClear.x,
            wp.rightClampHold.x,
            easeInOutQuint(clamp01(rawT / 0.56)),
          );
          rightJawOpen = lerp(1, 0, easeInOutCubic(clamp01((rawT - 0.48) / 0.52)));
          break;
      }
      return {
        leftPos,
        rightPos,
        cubePos,
        cubePitch,
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
    // 3. D / D': Synchronized 180° Dual-Arm Cube Flip -> Overhead Right Arm Twist
    // Keeps both elbows strictly up & outward with ZERO forearm-to-cube clipping
    // and generous tabletop clearance throughout the entire sequence.
    // -------------------------------------------------------------------------
    if (spec.face === 'D') {
      // With cubePitch = +PI, local -Y (D face) points straight UP (+Y) and local +Y
      // points along world -Y. Right overhead at pitch = -PI/2 rotates around world +Y
      // by (-rightRoll), so rightRoll = +spec.angleRad matches local D rotation 1:1.
      const twistTarget = spec.angleRad;

      switch (step.kind) {
        case 'd_flip_cube':
          cubePitch = Math.PI * tQuint;
          leftRoll = cubePitch;
          rightRoll = -cubePitch;
          break;
        case 'd_open_right':
          cubePitch = Math.PI;
          leftRoll = Math.PI;
          rightRoll = -Math.PI;
          rightJawOpen = easeInOutCubic(clamp01(rawT / 0.45));
          rightPos.x = lerp(
            wp.rightClampHold.x,
            wp.rightSideClear.x,
            easeInOutQuint(clamp01((rawT - 0.25) / 0.75)),
          );
          break;
        case 'd_to_top':
          cubePitch = Math.PI;
          leftRoll = Math.PI;
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
          rightRoll = lerp(-Math.PI, 0, easeInOutCubic(clamp01((rawT - 0.1) / 0.8)));
          rightJawOpen = 1;
          break;
        case 'd_clamp_top':
          cubePitch = Math.PI;
          leftRoll = Math.PI;
          cubePos.x = wp.cubeTopPos.x;
          cubePos.y = wp.cubeTopPos.y;
          leftPos.x = cubePos.x - half;
          leftPos.y = cubePos.y;
          rightPos.x = wp.rightTopContact.x;
          rightPos.y = lerp(
            wp.rightTopClear.y,
            wp.rightTopContact.y,
            easeInOutQuint(clamp01(rawT / 0.56)),
          );
          rightPitch = -Math.PI / 2;
          rightRoll = 0;
          rightJawOpen = lerp(1, 0, easeInOutCubic(clamp01((rawT - 0.48) / 0.52)));
          break;
        case 'd_twist':
          cubePitch = Math.PI;
          leftRoll = Math.PI;
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
        case 'd_release_top':
          cubePitch = Math.PI;
          leftRoll = Math.PI;
          cubePos.x = wp.cubeTopPos.x;
          cubePos.y = wp.cubeTopPos.y;
          leftPos.x = cubePos.x - half;
          leftPos.y = cubePos.y;
          rightPos.x = wp.rightTopContact.x;
          rightPos.y = lerp(
            wp.rightTopContact.y,
            wp.rightTopClear.y,
            easeInOutQuint(clamp01((rawT - 0.35) / 0.65)),
          );
          rightPitch = -Math.PI / 2;
          rightRoll = twistTarget;
          rightJawOpen = easeInOutCubic(clamp01(rawT / 0.48));
          break;
        case 'd_to_side':
          cubePitch = Math.PI;
          leftRoll = Math.PI;
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
          rightRoll = lerp(twistTarget, -Math.PI, easeInOutCubic(clamp01((rawT - 0.1) / 0.8)));
          rightJawOpen = 1;
          break;
        case 'd_clamp_side':
          cubePitch = Math.PI;
          leftRoll = Math.PI;
          rightRoll = -Math.PI;
          rightPos.x = lerp(
            wp.rightSideClear.x,
            wp.rightClampHold.x,
            easeInOutQuint(clamp01(rawT / 0.56)),
          );
          rightJawOpen = lerp(1, 0, easeInOutCubic(clamp01((rawT - 0.48) / 0.52)));
          break;
        case 'd_unflip_cube':
          cubePitch = lerp(Math.PI, 0, tQuint);
          leftRoll = cubePitch;
          rightRoll = -cubePitch;
          break;
      }
      return {
        leftPos,
        rightPos,
        cubePos,
        cubePitch,
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
    // 4. F / F' and B / B': Zero-Overlap Overhead Pass-Off & Middle-Slice Regrip
    // -------------------------------------------------------------------------
    // For F (+Z): yaw whole cube -PI/2 so +Z faces -X (Left arm); Left twists by -angleRad
    // For B (-Z): yaw whole cube +PI/2 so -Z faces -X (Left arm); Left twists by +angleRad
    const presentYaw = spec.face === 'F' ? -Math.PI / 2 : Math.PI / 2;
    const leftTwistTarget = spec.face === 'F' ? -spec.angleRad : spec.angleRad;
    const leftAtCubeX = wp.cubeTopPos.x - half;
    const leftClearX = leftAtCubeX - wp.leftSpinClearOffset;

    switch (step.kind) {
      case 'fb_open_right':
        rightJawOpen = easeInOutCubic(clamp01(rawT / 0.45));
        rightPos.x = lerp(
          wp.rightClampHold.x,
          wp.rightSideClear.x,
          easeInOutQuint(clamp01((rawT - 0.25) / 0.75)),
        );
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
        rightPos.y = lerp(
          wp.rightTopClear.y,
          wp.rightTopContact.y,
          easeInOutQuint(clamp01(rawT / 0.56)),
        );
        rightPitch = -Math.PI / 2;
        rightJawOpen = lerp(1, 0, easeInOutCubic(clamp01((rawT - 0.48) / 0.52)));
        break;
      case 'fb_open_retract_left':
        cubePos.x = wp.cubeTopPos.x;
        cubePos.y = wp.cubeTopPos.y;
        rightPos.x = wp.rightTopContact.x;
        rightPos.y = wp.rightTopContact.y;
        rightPitch = -Math.PI / 2;
        leftJawOpen = easeInOutCubic(clamp01(rawT / 0.42));
        leftPos.x = lerp(
          leftAtCubeX,
          leftClearX,
          easeInOutQuint(clamp01((rawT - 0.22) / 0.78)),
        );
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
        leftPos.x = lerp(
          leftClearX,
          leftAtCubeX,
          easeInOutQuint(clamp01(rawT / 0.58)),
        );
        leftPos.y = cubePos.y;
        leftJawOpen = lerp(1, 0, easeInOutCubic(clamp01((rawT - 0.48) / 0.52)));
        break;
      case 'fb_right_release_top_unwind':
        // Right opens & lifts straight UP clear above cube while Left stabilizes -X
        cubePos.x = wp.cubeTopPos.x;
        cubePos.y = wp.cubeTopPos.y;
        cubeYaw = presentYaw;
        leftPos.x = leftAtCubeX;
        leftPos.y = cubePos.y;
        rightPos.x = wp.rightTopContact.x;
        rightPos.y = lerp(
          wp.rightTopContact.y,
          wp.rightTopClear.y,
          easeInOutQuint(clamp01((rawT - 0.35) / 0.65)),
        );
        rightPitch = -Math.PI / 2;
        rightRoll = -presentYaw;
        rightJawOpen = easeInOutCubic(clamp01(rawT / 0.48));
        break;
      case 'fb_right_unwind_top':
        // Right unwinds wrist roll back to 0 (±Z jaws) in open air above cube!
        cubePos.x = wp.cubeTopPos.x;
        cubePos.y = wp.cubeTopPos.y;
        cubeYaw = presentYaw;
        leftPos.x = leftAtCubeX;
        leftPos.y = cubePos.y;
        rightPos.x = wp.rightTopClear.x;
        rightPos.y = wp.rightTopClear.y;
        rightPitch = -Math.PI / 2;
        rightRoll = lerp(-presentYaw, 0, tQuint);
        rightJawOpen = 1;
        break;
      case 'fb_right_reclamp_top':
        // Right descends straight down onto +Y middle slice (X ∈ [-22mm, +22mm]) -> 57mm clear of Left!
        cubePos.x = wp.cubeTopPos.x;
        cubePos.y = wp.cubeTopPos.y;
        cubeYaw = presentYaw;
        leftPos.x = leftAtCubeX;
        leftPos.y = cubePos.y;
        rightPos.x = wp.rightTopContact.x;
        rightPos.y = lerp(
          wp.rightTopClear.y,
          wp.rightTopContact.y,
          easeInOutQuint(clamp01(rawT / 0.56)),
        );
        rightPitch = -Math.PI / 2;
        rightRoll = 0;
        rightJawOpen = lerp(1, 0, easeInOutCubic(clamp01((rawT - 0.48) / 0.52)));
        break;
      case 'fb_twist':
        // Left twists presented F/B outer layer 90deg; Right holds stationary middle slice with 57mm gap!
        cubePos.x = wp.cubeTopPos.x;
        cubePos.y = wp.cubeTopPos.y;
        cubeYaw = presentYaw;
        rightPos.x = wp.rightTopContact.x;
        rightPos.y = wp.rightTopContact.y;
        rightPitch = -Math.PI / 2;
        rightRoll = 0;
        leftPos.x = leftAtCubeX;
        leftPos.y = cubePos.y;
        leftRoll = leftTwistTarget * tQuint;
        activeFaceTurn = {
          move: spec.notation,
          turnId: this.currentTurnId,
          easedProgress: tQuint,
        };
        break;
      case 'fb_open_retract_left_post':
        // Left opens & retracts straight outward well clear of cube before unwinding!
        cubePos.x = wp.cubeTopPos.x;
        cubePos.y = wp.cubeTopPos.y;
        cubeYaw = presentYaw;
        rightPos.x = wp.rightTopContact.x;
        rightPos.y = wp.rightTopContact.y;
        rightPitch = -Math.PI / 2;
        rightRoll = 0;
        leftJawOpen = easeInOutCubic(clamp01(rawT / 0.42));
        leftPos.x = lerp(
          leftAtCubeX,
          leftClearX,
          easeInOutQuint(clamp01((rawT - 0.25) / 0.75)),
        );
        leftPos.y = cubePos.y;
        leftRoll = leftTwistTarget;
        break;
      case 'fb_unwind_left_clear':
        // Left unwinds wrist roll back to 0 in open air at leftClearX (zero corner clip!)
        cubePos.x = wp.cubeTopPos.x;
        cubePos.y = wp.cubeTopPos.y;
        cubeYaw = presentYaw;
        rightPos.x = wp.rightTopContact.x;
        rightPos.y = wp.rightTopContact.y;
        rightPitch = -Math.PI / 2;
        rightRoll = 0;
        leftPos.x = leftClearX;
        leftPos.y = cubePos.y;
        leftJawOpen = 1;
        leftRoll = lerp(leftTwistTarget, 0, tQuint);
        break;
      case 'fb_restore_cube':
        // Right restores cube upright (cubeYaw: presentYaw -> 0 by rolling rightRoll: 0 -> +presentYaw)
        cubePos.x = wp.cubeTopPos.x;
        cubePos.y = wp.cubeTopPos.y;
        cubeYaw = lerp(presentYaw, 0, tQuint);
        rightPos.x = wp.rightTopContact.x;
        rightPos.y = wp.rightTopContact.y;
        rightPitch = -Math.PI / 2;
        rightRoll = presentYaw * tQuint;
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
        rightRoll = presentYaw;
        leftPos.x = lerp(
          leftClearX,
          leftAtCubeX,
          easeInOutQuint(clamp01(rawT / 0.58)),
        );
        leftPos.y = cubePos.y;
        leftJawOpen = lerp(1, 0, easeInOutCubic(clamp01((rawT - 0.48) / 0.52)));
        break;
      case 'fb_release_top':
        cubePos.x = wp.cubeTopPos.x;
        cubePos.y = wp.cubeTopPos.y;
        leftPos.x = leftAtCubeX;
        leftPos.y = cubePos.y;
        rightPos.x = wp.rightTopContact.x;
        rightPos.y = lerp(
          wp.rightTopContact.y,
          wp.rightTopClear.y,
          easeInOutQuint(clamp01((rawT - 0.35) / 0.65)),
        );
        rightPitch = -Math.PI / 2;
        rightRoll = presentYaw;
        rightJawOpen = easeInOutCubic(clamp01(rawT / 0.48));
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
        rightRoll = lerp(presentYaw, 0, tQuint);
        rightJawOpen = 1;
        break;
      case 'fb_reclamp_right':
        rightPos.x = lerp(
          wp.rightSideClear.x,
          wp.rightClampHold.x,
          easeInOutQuint(clamp01(rawT / 0.56)),
        );
        rightJawOpen = lerp(1, 0, easeInOutCubic(clamp01((rawT - 0.48) / 0.52)));
        break;
    }

    return {
      leftPos,
      rightPos,
      cubePos,
      cubePitch,
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
    this.pendingSolveQueue = null;
    this.stopScrambleRequested = false;
    this.justSolvedFlag = false;
    this.moveQueue = [];
    this.pendingMoveQueue = null;
    this.currentMoveIndex = 0;
    this.solveTotalMoves = 0;
    this.loadMoveNotation(this.scrambleGenerator.next());
    this.transitionTo('SCRAMBLING');
  }

  private startMoveSequence(sequence: CubeMoveNotation[]): void {
    this.continuousScrambleActive = false;
    this.pendingContinuousScramble = false;
    this.pendingSolveQueue = null;
    this.stopScrambleRequested = false;
    this.justSolvedFlag = false;
    this.moveQueue = sequence;
    this.pendingMoveQueue = null;
    this.currentMoveIndex = 0;
    this.solveTotalMoves = 0;
    const first = this.moveQueue[0];
    if (first) {
      this.scrambleGenerator.recordExternalFace(getMoveSpec(first).face);
      this.loadMoveNotation(first);
      this.transitionTo('SCRAMBLING');
    }
  }

  private startSolveSequence(solution: CubeMoveNotation[]): void {
    this.continuousScrambleActive = false;
    this.pendingContinuousScramble = false;
    this.pendingMoveQueue = null;
    this.pendingSolveQueue = null;
    this.stopScrambleRequested = false;
    this.justSolvedFlag = false;
    this.moveQueue = solution;
    this.currentMoveIndex = 0;
    this.solveTotalMoves = solution.length;
    const first = this.moveQueue[0];
    if (first) {
      this.loadMoveNotation(first);
      this.transitionTo('SOLVING');
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

  /**
   * Advances active SCRAMBLING or SOLVING micro-steps.
   * Returns `true` if a SOLVING sequence finished during this call.
   */
  private advanceActiveMove(
    dt: number,
    committedMoves: CubeMoveNotation[],
  ): boolean {
    this.stepElapsed += dt;
    let solvedNow = false;

    while (this.state === 'SCRAMBLING' || this.state === 'SOLVING') {
      const isSolving = this.state === 'SOLVING';
      const step = this.currentSteps[this.currentStepIndex];
      if (!step) {
        if (isSolving) {
          this.finishSolve();
          solvedNow = true;
        } else {
          this.finishScramble();
        }
        break;
      }
      if (this.stepElapsed < step.duration) {
        break;
      }

      const overflow = this.stepElapsed - step.duration;
      if (step.isTwist && this.currentMoveSpec) {
        committedMoves.push(this.currentMoveSpec.notation);
        if (!isSolving) {
          this.totalCommittedMoves += 1;
          this.scrambledFlag = true;
        }
      }

      this.currentStepIndex += 1;
      if (this.currentStepIndex < this.currentSteps.length) {
        this.stepElapsed = overflow;
      } else {
        // Current move + neutral regrip finished cleanly!
        if (!isSolving && this.stopScrambleRequested) {
          this.finishScramble();
          break;
        }

        if (!isSolving && this.continuousScrambleActive) {
          // Generate the next non-redundant move on the fly indefinitely
          const nextMove = this.scrambleGenerator.next();
          this.loadMoveNotation(nextMove);
          this.stepElapsed = overflow;
          this.notify();
        } else {
          // Finite move queue (deterministic scramble or Auto-Solve)
          this.currentMoveIndex += 1;
          if (this.currentMoveIndex < this.moveQueue.length) {
            const nextMove = this.moveQueue[this.currentMoveIndex];
            if (!isSolving) {
              this.scrambleGenerator.recordExternalFace(getMoveSpec(nextMove).face);
            }
            this.loadMoveNotation(nextMove);
            this.stepElapsed = overflow;
            this.notify();
          } else if (isSolving) {
            this.finishSolve(overflow);
            solvedNow = true;
            break;
          } else {
            this.finishScramble();
            break;
          }
        }
      }
    }

    return solvedNow;
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

  private finishSolve(carryElapsed = 0): void {
    this.continuousScrambleActive = false;
    this.stopScrambleRequested = false;
    this.moveQueue = [];
    this.currentMoveSpec = null;
    this.currentSteps = [];
    this.currentStepIndex = 0;
    this.stepElapsed = 0;
    this.scrambledFlag = false;
    this.justSolvedFlag = true;
    this.totalCommittedMoves = 0;
    this.solveTotalMoves = 0;
    this.transitionTo('CELEBRATING', carryElapsed);
  }

  private getPhaseDuration(state: MachineState): number {
    switch (state) {
      case 'APPROACHING':
        return this.durations.approach;
      case 'GRIPPING':
        return this.durations.grip;
      case 'LIFTING':
        return this.durations.lift;
      case 'CELEBRATING':
        return this.durations.celebrate;
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
      case 'CELEBRATING':
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

  private advancePhasesIfComplete(committedMoves: CubeMoveNotation[]): {
    didSolveMove: boolean;
    solvedNow: boolean;
  } {
    let didSolveMove = false;
    let solvedNow = false;

    while (
      this.isBusy() &&
      this.state !== 'SCRAMBLING' &&
      this.state !== 'SOLVING'
    ) {
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

      // Seamless Auto-Lift Integration: once LIFTING reaches HOLDING, immediately start scrambling or solving!
      if (next === 'HOLDING' && this.pendingContinuousScramble) {
        this.startContinuousScramble();
        if (overflow > 0) {
          this.advanceActiveMove(overflow, committedMoves);
        }
        break;
      }
      if (next === 'HOLDING' && this.pendingMoveQueue && this.pendingMoveQueue.length > 0) {
        const queued = this.pendingMoveQueue;
        this.startMoveSequence(queued);
        if (overflow > 0) {
          this.advanceActiveMove(overflow, committedMoves);
        }
        break;
      }
      if (next === 'HOLDING' && this.pendingSolveQueue && this.pendingSolveQueue.length > 0) {
        const solution = this.pendingSolveQueue;
        this.startSolveSequence(solution);
        didSolveMove = true;
        if (overflow > 0) {
          solvedNow = this.advanceActiveMove(overflow, committedMoves);
        }
        break;
      }

      this.transitionTo(next, overflow);
    }

    return {didSolveMove, solvedNow};
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
