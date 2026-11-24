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
  type FaceStripMetrics,
  type MachineSnapshot,
  type MachineState,
  type MotionSpeed,
  type PuzzleBoundsSnapshot,
  type PuzzleType,
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
  swap: number;
}

export const DEFAULT_DURATIONS: ChoreographyDurations = {
  approach: 1.35,
  grip: 0.65,
  lift: 1.25,
  celebrate: 1.5,
  lower: 1.25,
  release: 0.6,
  returnHome: 1.3,
  swap: 0.64,
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
  /** Whole-cube pitch around world X during completion presentation flourish or D-flip (0 otherwise). */
  cubePitch: number;
  /** Whole-cube yaw around world Y during F/B overhead pass-off moves or puzzle swap (0 at rest/hold). */
  cubeYaw: number;
  /** Uniform scale of the puzzle mesh (1 normally; smoothly animates 1 -> 0 -> 1 during SWAPPING). */
  cubeScale: number;
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
  /** Non-null on the exact mid-swap frame when AnimationController should rebuild the puzzle geometry. */
  commitPuzzleSwap: PuzzleType | null;
  snapshot: MachineSnapshot;
}

interface MoveSubStep {
  kind: string;
  duration: number;
  isTwist?: boolean;
}

export function createClassicBoundsSnapshot(): PuzzleBoundsSnapshot {
  const h = LAB_DIMENSIONS.CUBE_OUTER_HALF;
  const symmetric: FaceStripMetrics = {
    stripNormal: h,
    faceNormal: h,
    jawPos: h,
    jawNeg: h,
  };
  return {
    puzzleType: 'classic',
    minX: -h,
    maxX: h,
    minY: -h,
    maxY: h,
    minZ: -h,
    maxZ: h,
    maxSpinRadius: Math.hypot(h, h),
    faces: {
      L: {...symmetric},
      R: {...symmetric},
      U: {...symmetric},
      D: {...symmetric},
      F: {...symmetric},
      B: {...symmetric},
      U_FB: {...symmetric},
    },
  };
}

function cloneBoundsSnapshot(b: PuzzleBoundsSnapshot): PuzzleBoundsSnapshot {
  return {
    puzzleType: b.puzzleType,
    minX: b.minX,
    maxX: b.maxX,
    minY: b.minY,
    maxY: b.maxY,
    minZ: b.minZ,
    maxZ: b.maxZ,
    maxSpinRadius: b.maxSpinRadius,
    faces: {
      L: {...b.faces.L},
      R: {...b.faces.R},
      U: {...b.faces.U},
      D: {...b.faces.D},
      F: {...b.faces.F},
      B: {...b.faces.B},
      U_FB: {...b.faces.U_FB},
    },
  };
}

/** Computes the exact cube center Y so its lowest face/block sits flush on the circular pad. */
function getCubeRestY(bounds: PuzzleBoundsSnapshot): number {
  if (bounds.puzzleType === 'classic') {
    return LAB_DIMENSIONS.CUBE_REST_Y;
  }
  return LAB_DIMENSIONS.TABLE_TOP_Y + LAB_DIMENSIONS.PAD_SURFACE_OFFSET + -bounds.minY;
}

/** Computes the mid-air hover height (slightly elevated for Mirror Cube's taller protruding blocks). */
function getCubeHoldY(bounds: PuzzleBoundsSnapshot): number {
  return bounds.puzzleType === 'mirror'
    ? LAB_DIMENSIONS.CUBE_HOLD_Y + 0.03
    : LAB_DIMENSIONS.CUBE_HOLD_Y;
}

/**
 * Builds the ordered physical manipulation micro-steps for any of the 12 standard moves.
 * Every transition enforces a strict 3-step Retract -> Exterior Arc / Unwind -> Straight Approach
 * clearance protocol so neither arm ever clips into the cube, the other arm, or the tabletop.
 */
function buildMoveSteps(spec: CubeMoveSpec): MoveSubStep[] {
  if (spec.face === 'L' || spec.face === 'R') {
    return [
      {kind: 'lr_twist', duration: 0.3, isTwist: true},
      {kind: 'lr_open_retract', duration: 0.14},
      {kind: 'lr_unwind', duration: 0.2},
      {kind: 'lr_approach_close', duration: 0.15},
    ];
  }
  if (spec.face === 'U') {
    return [
      {kind: 'u_open_right', duration: 0.14},
      {kind: 'u_to_top', duration: 0.32},
      {kind: 'u_clamp_top', duration: 0.14},
      {kind: 'u_twist', duration: 0.3, isTwist: true},
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
      {kind: 'd_twist', duration: 0.3, isTwist: true},
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
  // 4. Left advances & clamps -X (on ±Z, strictly inside stationary middle-Y slice!).
  // 5. Right opens, lifts straight UP clear of cube, unwinds wrist roll back to ±Z
  //    (strictly centered on stationary middle slice X ∈ [-22mm, +22mm]), and re-clamps +Y!
  // 6. Left twists F/B 90deg with pure horizontal clearance from Right gripper!
  // 7. Left opens, retracts wide clear, and unwinds wrist roll back to 0 in open air.
  // 8. Right restores cube yaw smoothly back to 0 (rotating its wrist 0 -> +presentYaw).
  // 9. Left advances & re-clamps -X; Right releases +Y, lifts straight UP, arcs cleanly
  //    back to right side while unwinding roll to 0, approaches flush & re-clamps +X!
  return [
    {kind: 'fb_open_right', duration: 0.13},
    {kind: 'fb_right_to_top', duration: 0.3},
    {kind: 'fb_clamp_top', duration: 0.13},
    {kind: 'fb_open_retract_left', duration: 0.15},
    {kind: 'fb_present_cube', duration: 0.26},
    {kind: 'fb_advance_clamp_left', duration: 0.15},
    {kind: 'fb_right_release_top_unwind', duration: 0.13},
    {kind: 'fb_right_unwind_top', duration: 0.18},
    {kind: 'fb_right_reclamp_top', duration: 0.13},
    {kind: 'fb_twist', duration: 0.3, isTwist: true},
    {kind: 'fb_open_retract_left_post', duration: 0.15},
    {kind: 'fb_unwind_left_clear', duration: 0.16},
    {kind: 'fb_restore_cube', duration: 0.26},
    {kind: 'fb_advance_reclamp_left', duration: 0.15},
    {kind: 'fb_release_top', duration: 0.13},
    {kind: 'fb_right_to_side', duration: 0.3},
    {kind: 'fb_reclamp_right', duration: 0.13},
  ];
}

/** Computes dynamic waypoints tailored to the live puzzle's measured outer surface extents. */
function makeDynamicWaypoints(
  preBounds: PuzzleBoundsSnapshot,
  curBounds: PuzzleBoundsSnapshot,
) {
  const z = LAB_DIMENSIONS.TABLE_CENTER_Z;
  const isMirror = curBounds.puzzleType === 'mirror';
  const restY = getCubeRestY(curBounds);
  const holdY = getCubeHoldY(curBounds);

  const preL = preBounds.faces.L;
  const preR = preBounds.faces.R;
  const curL = curBounds.faces.L;
  const curR = curBounds.faces.R;

  const standbyX = isMirror ? 0.34 : 0.32;
  const leftStandby: Vec3 = {x: -standbyX, y: restY + 0.265, z: z - 0.035};
  const rightStandby: Vec3 = {x: standbyX, y: restY + 0.265, z: z - 0.035};

  const ctrl1X = isMirror ? 0.315 : 0.295;
  const ctrl2X = isMirror
    ? Math.max(0.265, Math.max(curL.faceNormal, curR.faceNormal) + 0.12)
    : 0.225;
  const leftCtrl1: Vec3 = {x: -ctrl1X, y: restY + 0.28, z: z - 0.012};
  const leftCtrl2: Vec3 = {x: -ctrl2X, y: restY + 0.095, z};
  const rightCtrl1: Vec3 = {x: ctrl1X, y: restY + 0.28, z: z - 0.012};
  const rightCtrl2: Vec3 = {x: ctrl2X, y: restY + 0.095, z};

  const preClampGap = isMirror ? 0.062 : 0.058;
  const leftPreClamp: Vec3 = {x: -(curL.faceNormal + preClampGap), y: restY, z};
  const rightPreClamp: Vec3 = {x: curR.faceNormal + preClampGap, y: restY, z};

  const leftClampRest: Vec3 = {x: -curL.stripNormal, y: restY, z};
  const rightClampRest: Vec3 = {x: curR.stripNormal, y: restY, z};

  const leftClampHoldPre: Vec3 = {x: -preL.stripNormal, y: holdY, z};
  const rightClampHoldPre: Vec3 = {x: preR.stripNormal, y: holdY, z};
  const leftClampHoldCur: Vec3 = {x: -curL.stripNormal, y: holdY, z};
  const rightClampHoldCur: Vec3 = {x: curR.stripNormal, y: holdY, z};

  const lrUnwindRetract = isMirror ? 0.068 : 0.062;
  const maxLFace = Math.max(preL.faceNormal, curL.faceNormal);
  const maxRFace = Math.max(preR.faceNormal, curR.faceNormal);
  const leftUnwindClear: Vec3 = {x: -(maxLFace + lrUnwindRetract), y: holdY, z};
  const rightUnwindClear: Vec3 = {x: maxRFace + lrUnwindRetract, y: holdY, z};

  const sideRetract = isMirror ? 0.092 : 0.088;
  const rightSideClearPre: Vec3 = {x: preR.faceNormal + sideRetract, y: holdY, z};
  const rightSideClearCur: Vec3 = {x: curR.faceNormal + sideRetract, y: holdY, z};

  // Overhead (U/D/F/B) cube shift position: keeps Right arm strictly inside 0.675m IK envelope
  // even when a 1.60-thick Mirror Cube block protrudes +0.144m upward!
  const cubeTopPos: Vec3 = isMirror ? {x: 0.13, y: 1.12, z} : {x: 0.09, y: 1.13, z};

  const maxUFace = Math.max(preBounds.faces.U.faceNormal, curBounds.faces.U.faceNormal);
  const maxDFace = Math.max(preBounds.faces.D.faceNormal, curBounds.faces.D.faceNormal);

  const topClearGap = isMirror ? 0.084 : 0.082;
  const rightTopContactU: Vec3 = {
    x: cubeTopPos.x,
    y: cubeTopPos.y + preBounds.faces.U.stripNormal,
    z,
  };
  const rightTopContactUFB: Vec3 = {
    x: cubeTopPos.x,
    y: cubeTopPos.y + curBounds.faces.U_FB.stripNormal,
    z,
  };
  const rightTopClearU: Vec3 = {
    x: cubeTopPos.x,
    y: cubeTopPos.y + maxUFace + topClearGap,
    z,
  };

  const rightTopContactD: Vec3 = {
    x: cubeTopPos.x,
    y: cubeTopPos.y + preBounds.faces.D.stripNormal,
    z,
  };
  const rightTopClearD: Vec3 = {
    x: cubeTopPos.x,
    y: cubeTopPos.y + maxDFace + topClearGap,
    z,
  };

  const arcTopY = Math.max(rightTopClearU.y, rightTopClearD.y);
  const rightTopArc1: Vec3 = isMirror
    ? {
        x: Math.max(0.35, Math.max(rightSideClearPre.x, rightSideClearCur.x) + 0.12),
        y: Math.max(1.36, arcTopY - 0.01),
        z,
      }
    : {x: 0.34, y: 1.34, z};
  const rightTopArc2: Vec3 = isMirror
    ? {
        x: Math.max(0.3, cubeTopPos.x + 0.18),
        y: Math.max(1.42, arcTopY + 0.04),
        z,
      }
    : {x: 0.28, y: 1.42, z};

  // Wide diagonal + opposing-rail clearance for Left arm during F/B whole-cube 90deg yaw
  const maxSpinR = Math.max(preBounds.maxSpinRadius, curBounds.maxSpinRadius);
  const leftSpinClearDist = isMirror
    ? Math.max(maxSpinR, 0.195) + 0.06
    : LAB_DIMENSIONS.CUBE_OUTER_HALF + 0.125;

  return {
    restY,
    holdY,
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
    leftClampHoldPre,
    rightClampHoldPre,
    leftClampHoldCur,
    rightClampHoldCur,
    leftUnwindClear,
    rightUnwindClear,
    rightSideClearPre,
    rightSideClearCur,
    cubeTopPos,
    rightTopContactU,
    rightTopContactUFB,
    rightTopClearU,
    rightTopContactD,
    rightTopClearD,
    rightTopArc1,
    rightTopArc2,
    leftSpinClearDist,
  };
}

/**
 * Pure, framework-agnostic robotics choreography state machine.
 * Handles Pick Up / Put Down, Indefinite Continuous Scrambling, Deterministic Auto-Solve,
 * Dynamic Mirror Cube Gripper Adaptation, and Smooth Puzzle Switching.
 */
export class RoboticsChoreography {
  private state: MachineState = 'STANDBY';
  private phaseElapsed = 0;
  private totalTime = 0;
  private readonly durations: ChoreographyDurations;
  private readonly listeners = new Set<(snapshot: MachineSnapshot) => void>();

  // Active Puzzle Mode & Live Surface Bounds (adapted dynamically for Mirror Cube)
  private puzzleType: PuzzleType = 'classic';
  private activeBounds: PuzzleBoundsSnapshot = createClassicBoundsSnapshot();
  private twistStartBounds: PuzzleBoundsSnapshot = createClassicBoundsSnapshot();
  private pendingPuzzleSwap: PuzzleType | null = null;
  private swapTargetPuzzle: PuzzleType | null = null;
  private swapCommitted = false;

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

  getPuzzleType(): PuzzleType {
    return this.puzzleType;
  }

  /**
   * Synchronizes live measured outer surface bounds from `RubiksCube.getBoundsSnapshot()`
   * so approach standoffs, resting height, and jaw carriages stay dead-flush on Mirror Cube blocks.
   */
  syncPuzzleBounds(bounds: PuzzleBoundsSnapshot): void {
    this.activeBounds = cloneBoundsSnapshot(bounds);
    this.puzzleType = bounds.puzzleType;
    if (this.state === 'STANDBY' || this.state === 'HOLDING') {
      this.twistStartBounds = cloneBoundsSnapshot(bounds);
    }
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

  /** Checks whether the cube is currently held in neutral mid-air ready for moves. */
  canPerformCubeMove(): boolean {
    return this.state === 'HOLDING';
  }

  /**
   * Switches between `'classic'` and `'mirror'` puzzles cleanly:
   * - Ignored while any animation, scramble, solve, or swap is already running.
   * - If currently in `HOLDING`, smoothly executes Put Down Cube first, then swaps on the pad.
   * - If in `STANDBY`, smoothly animates the swap directly on the resting pad.
   */
  requestPuzzleSwitch(target: PuzzleType): boolean {
    if (this.isBusy() || target === this.puzzleType) {
      return false;
    }
    this.pendingMoveQueue = null;
    this.pendingContinuousScramble = false;
    this.pendingSolveQueue = null;

    if (this.state === 'HOLDING') {
      this.pendingPuzzleSwap = target;
      this.transitionTo('LOWERING');
      return true;
    }
    if (this.state === 'STANDBY') {
      this.startSwapTo(target);
      return true;
    }
    return false;
  }

  private startSwapTo(target: PuzzleType, carryElapsed = 0): void {
    this.pendingPuzzleSwap = null;
    this.swapTargetPuzzle = target;
    this.swapCommitted = false;
    this.transitionTo('SWAPPING', carryElapsed);
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
    } else if (this.state === 'SWAPPING') {
      primaryButtonLabel = 'Swapping...';
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
      statusLabel =
        this.puzzleType === 'mirror' ? 'SOLVED ✓ • MIRROR' : 'SOLVED ✓';
      solveButtonLabel = 'Solved';
      solveButtonDisabled = true;
    } else if (this.state === 'SWAPPING') {
      const targetName =
        (this.swapTargetPuzzle ?? this.puzzleType) === 'mirror'
          ? 'MIRROR CUBE'
          : 'CLASSIC 3x3';
      statusLabel = `SWAPPING • ${targetName}`;
    } else if (isAutoLiftingToSolve) {
      solveButtonLabel = 'Lifting...';
      solveButtonDisabled = true;
    } else if (this.state === 'HOLDING' && this.scrambledFlag) {
      statusLabel =
        this.puzzleType === 'mirror'
          ? 'HOLDING — SCRAMBLED • MIRROR'
          : 'HOLDING — SCRAMBLED';
      scrambleButtonLabel = 'Scramble';
      scrambleButtonMode = 'start';
      scrambleButtonDisabled = false;
    } else if (this.state === 'HOLDING' && this.justSolvedFlag) {
      statusLabel =
        this.puzzleType === 'mirror'
          ? 'HOLDING — SOLVED ✓ • MIRROR'
          : 'HOLDING — SOLVED ✓';
      solveButtonLabel = 'Solved';
      solveButtonDisabled = true;
    } else if (this.state === 'HOLDING' && this.puzzleType === 'mirror') {
      statusLabel = 'HOLDING — READY • MIRROR';
    } else if (this.state === 'STANDBY') {
      if (this.puzzleType === 'mirror') {
        statusLabel = 'STANDBY • MIRROR CUBE';
      }
      if (this.justSolvedFlag && !this.scrambledFlag) {
        solveButtonLabel = 'Solved';
        solveButtonDisabled = true;
      }
    } else if (isAutoLiftingToScramble) {
      scrambleButtonLabel = 'Lifting...';
      scrambleButtonMode = 'busy';
      scrambleButtonDisabled = true;
    }

    return {
      state: this.state,
      puzzleType: this.puzzleType,
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
      puzzleSwitcherDisabled: this.isBusy(),
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
   * Cleanly ignored while any animation, scramble, solve, or swap is mid-flight.
   */
  triggerPrimaryAction(): boolean {
    if (this.state === 'STANDBY') {
      this.pendingMoveQueue = null;
      this.pendingContinuousScramble = false;
      this.pendingSolveQueue = null;
      this.pendingPuzzleSwap = null;
      this.transitionTo('APPROACHING');
      return true;
    }
    if (this.state === 'HOLDING') {
      this.pendingMoveQueue = null;
      this.pendingContinuousScramble = false;
      this.pendingSolveQueue = null;
      this.pendingPuzzleSwap = null;
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
      this.pendingPuzzleSwap = null;
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
      this.pendingPuzzleSwap = null;
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
      this.pendingPuzzleSwap = null;
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
    let commitPuzzleSwap: PuzzleType | null = null;

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
      if (result.commitPuzzleSwap) {
        commitPuzzleSwap = result.commitPuzzleSwap;
      }
    }

    // Mid-swap commit hook (triggers once at 45% of SWAPPING phase)
    if (
      this.state === 'SWAPPING' &&
      !this.swapCommitted &&
      this.swapTargetPuzzle !== null &&
      this.phaseElapsed / this.durations.swap >= 0.45
    ) {
      commitPuzzleSwap = this.applySwapCommit();
    }

    return this.evaluateFrame(
      committedMoves,
      committedMovesRecordHistory,
      clearHistoryOnFinish,
      commitPuzzleSwap,
    );
  }

  private applySwapCommit(): PuzzleType | null {
    if (this.swapCommitted || !this.swapTargetPuzzle) return null;
    const target = this.swapTargetPuzzle;
    this.swapCommitted = true;
    this.puzzleType = target;
    this.scrambledFlag = false;
    this.justSolvedFlag = false;
    this.totalCommittedMoves = 0;
    this.solveTotalMoves = 0;
    this.moveQueue = [];
    this.notify();
    return target;
  }

  /** Evaluates the exact kinematic pose for the current state without advancing time. */
  evaluateFrame(
    committedMoves: CubeMoveNotation[] = [],
    committedMovesRecordHistory = true,
    clearHistoryOnFinish = false,
    commitPuzzleSwap: PuzzleType | null = null,
  ): ChoreographyFrame {
    const curBounds = this.activeBounds;
    const preBounds = this.twistStartBounds;
    const wp = makeDynamicWaypoints(preBounds, curBounds);
    const isMirror = curBounds.puzzleType === 'mirror';

    let leftJawOpen = 1;
    let rightJawOpen = 1;
    let leftPitch = 0;
    let rightPitch = 0;
    let leftRoll = 0;
    let rightRoll = 0;
    let cubePitch = 0;
    let cubeYaw = 0;
    let cubeScale = 1;
    let cubeAttached = false;
    let activeFaceTurn: ActiveFaceTurnFrame | null = null;

    // Live jaw extents (undefined for Classic 3x3 -> uses exact symmetric CUBE_OUTER_HALF)
    let leftFrontJaw: number | undefined = isMirror ? curBounds.faces.L.jawPos : undefined;
    let leftRearJaw: number | undefined = isMirror ? curBounds.faces.L.jawNeg : undefined;
    let rightFrontJaw: number | undefined = isMirror ? curBounds.faces.R.jawPos : undefined;
    let rightRearJaw: number | undefined = isMirror ? curBounds.faces.R.jawNeg : undefined;

    this._cubePos.x = 0;
    this._cubePos.y = wp.restY;
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

      case 'SWAPPING': {
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

        const rawT = clamp01(this.phaseElapsed / this.durations.swap);
        if (rawT < 0.45) {
          const u = easeInOutCubic(rawT / 0.45);
          cubeScale = lerp(1, 0.001, u);
          cubeYaw = lerp(0, Math.PI * 0.45, u);
          this._cubePos.y = wp.restY + Math.sin(u * Math.PI * 0.5) * 0.036;
        } else {
          const v = easeInOutQuint((rawT - 0.45) / 0.55);
          cubeScale = lerp(0.001, 1, v);
          cubeYaw = lerp(-Math.PI * 0.45, 0, v);
          this._cubePos.y = wp.restY + (1 - v) * 0.042;
        }
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
        const y = lerp(wp.restY, wp.holdY, t);

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
        const y = wp.holdY + microHover;

        this._leftPos.x = wp.leftClampHoldCur.x;
        this._leftPos.y = y;
        this._leftPos.z = wp.leftClampHoldCur.z;

        this._rightPos.x = wp.rightClampHoldCur.x;
        this._rightPos.y = y;
        this._rightPos.z = wp.rightClampHoldCur.z;

        this._cubePos.y = y;
        cubeAttached = true;
        leftJawOpen = 0;
        rightJawOpen = 0;
        break;
      }

      case 'SCRAMBLING':
      case 'SOLVING': {
        const pose = this.evaluateActiveMovePose(wp, preBounds, curBounds);
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
        leftFrontJaw = pose.leftFrontJaw;
        leftRearJaw = pose.leftRearJaw;
        rightFrontJaw = pose.rightFrontJaw;
        rightRearJaw = pose.rightRearJaw;
        activeFaceTurn = pose.activeFaceTurn;
        cubeAttached = true;
        break;
      }

      case 'CELEBRATING': {
        const rawT = clamp01(this.phaseElapsed / this.durations.celebrate);
        const liftFlourish = Math.sin(rawT * Math.PI) * 0.026;
        const y = wp.holdY + liftFlourish;

        let tilt = 0;
        if (rawT < 0.36) {
          tilt = lerp(0, 0.44, easeInOutQuint(rawT / 0.36));
        } else if (rawT < 0.72) {
          tilt = lerp(0.44, -0.22, easeInOutQuint((rawT - 0.36) / 0.36));
        } else {
          tilt = lerp(-0.22, 0, easeInOutQuint((rawT - 0.72) / 0.28));
        }

        this._leftPos.x = wp.leftClampHoldCur.x;
        this._leftPos.y = y;
        this._leftPos.z = wp.leftClampHoldCur.z;

        this._rightPos.x = wp.rightClampHoldCur.x;
        this._rightPos.y = y;
        this._rightPos.z = wp.rightClampHoldCur.z;

        this._cubePos.y = y;
        cubePitch = tilt;
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
        const y = lerp(wp.holdY, wp.restY, t);

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
      frontJawExtent: leftFrontJaw,
      rearJawExtent: leftRearJaw,
    });
    const rightAngles = solveArmIK('right', this._rightPos, {
      jawOpen: rightJawOpen,
      wristRoll: rightRoll,
      gripperWorldPitch: rightPitch,
      frontJawExtent: rightFrontJaw,
      rearJawExtent: rightRearJaw,
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
      cubeScale,
      cubeAttached,
      cubeLiftHeight: Math.max(0, this._cubePos.y - wp.restY),
      activeFaceTurn,
      committedMoves,
      committedMovesRecordHistory,
      clearHistoryOnFinish,
      commitPuzzleSwap,
      snapshot: this.getSnapshot(),
    };
  }

  /**
   * Computes exact dual-arm positions, wrist pitches, wrist rolls, jaw openings,
   * live jaw carriage extents, and synchronized face-turn progress for the active micro-step.
   */
  private evaluateActiveMovePose(
    wp: ReturnType<typeof makeDynamicWaypoints>,
    preBounds: PuzzleBoundsSnapshot,
    curBounds: PuzzleBoundsSnapshot,
  ): {
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
    leftFrontJaw: number | undefined;
    leftRearJaw: number | undefined;
    rightFrontJaw: number | undefined;
    rightRearJaw: number | undefined;
    activeFaceTurn: ActiveFaceTurnFrame | null;
  } {
    const isMirror = curBounds.puzzleType === 'mirror';
    const z = LAB_DIMENSIONS.TABLE_CENTER_Z;
    const holdY = wp.holdY;

    const preL = preBounds.faces.L;
    const preR = preBounds.faces.R;
    const curL = curBounds.faces.L;
    const curR = curBounds.faces.R;

    const cubePos: Vec3 = {x: 0, y: holdY, z};
    const leftPos: Vec3 = {x: -preL.stripNormal, y: holdY, z};
    const rightPos: Vec3 = {x: preR.stripNormal, y: holdY, z};
    let cubePitch = 0;
    let cubeYaw = 0;
    let leftPitch = 0;
    let rightPitch = 0;
    let leftRoll = 0;
    let rightRoll = 0;
    let leftJawOpen = 0;
    let rightJawOpen = 0;
    let leftFrontJaw: number | undefined = isMirror ? preL.jawPos : undefined;
    let leftRearJaw: number | undefined = isMirror ? preL.jawNeg : undefined;
    let rightFrontJaw: number | undefined = isMirror ? preR.jawPos : undefined;
    let rightRearJaw: number | undefined = isMirror ? preR.jawNeg : undefined;
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
        leftFrontJaw,
        leftRearJaw,
        rightFrontJaw,
        rightRearJaw,
        activeFaceTurn,
      };
    }

    const rawT = clamp01(this.stepElapsed / step.duration);
    const tQuint = easeInOutQuint(rawT);

    // -------------------------------------------------------------------------
    // 1. L / L' and R / R': Twist -> Open & Retract Clear -> Unwind -> Approach & Clamp
    // -------------------------------------------------------------------------
    if (spec.face === 'L' || spec.face === 'R') {
      const isLeft = spec.face === 'L';
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
            leftPos.x = lerp(wp.leftClampHoldPre.x, wp.leftUnwindClear.x, tRetract);
          } else {
            rightRoll = twistTarget;
            rightJawOpen = tOpen;
            rightPos.x = lerp(wp.rightClampHoldPre.x, wp.rightUnwindClear.x, tRetract);
          }
          break;
        }
        case 'lr_unwind':
          if (isLeft) {
            leftPos.x = wp.leftUnwindClear.x;
            leftRoll = lerp(twistTarget, 0, tQuint);
            leftJawOpen = 1;
            if (isMirror) {
              leftFrontJaw = lerp(preL.jawPos, curL.jawPos, tQuint);
              leftRearJaw = lerp(preL.jawNeg, curL.jawNeg, tQuint);
            }
          } else {
            rightPos.x = wp.rightUnwindClear.x;
            rightRoll = lerp(twistTarget, 0, tQuint);
            rightJawOpen = 1;
            if (isMirror) {
              rightFrontJaw = lerp(preR.jawPos, curR.jawPos, tQuint);
              rightRearJaw = lerp(preR.jawNeg, curR.jawNeg, tQuint);
            }
          }
          break;
        case 'lr_approach_close': {
          const tIn = easeInOutQuint(clamp01(rawT / 0.58));
          const tClose = easeInOutCubic(clamp01((rawT - 0.48) / 0.52));
          if (isLeft) {
            leftPos.x = lerp(wp.leftUnwindClear.x, wp.leftClampHoldCur.x, tIn);
            leftJawOpen = lerp(1, 0, tClose);
            if (isMirror) {
              leftFrontJaw = curL.jawPos;
              leftRearJaw = curL.jawNeg;
            }
          } else {
            rightPos.x = lerp(wp.rightUnwindClear.x, wp.rightClampHoldCur.x, tIn);
            rightJawOpen = lerp(1, 0, tClose);
            if (isMirror) {
              rightFrontJaw = curR.jawPos;
              rightRearJaw = curR.jawNeg;
            }
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
        leftFrontJaw,
        leftRearJaw,
        rightFrontJaw,
        rightRearJaw,
        activeFaceTurn,
      };
    }

    // -------------------------------------------------------------------------
    // 2. U / U': Left holds -X center slice, Right Retracts -> Exterior Arc -> Approaches +Y
    // -------------------------------------------------------------------------
    if (spec.face === 'U') {
      const twistTarget = -spec.angleRad;
      const preU = preBounds.faces.U;

      switch (step.kind) {
        case 'u_open_right':
          rightJawOpen = easeInOutCubic(clamp01(rawT / 0.45));
          rightPos.x = lerp(
            wp.rightClampHoldPre.x,
            wp.rightSideClearPre.x,
            easeInOutQuint(clamp01((rawT - 0.25) / 0.75)),
          );
          break;
        case 'u_to_top':
          cubePos.x = lerp(0, wp.cubeTopPos.x, tQuint);
          cubePos.y = lerp(holdY, wp.cubeTopPos.y, tQuint);
          leftPos.x = cubePos.x - preL.stripNormal;
          leftPos.y = cubePos.y;
          evalCubicBezier3(
            wp.rightSideClearPre,
            wp.rightTopArc1,
            wp.rightTopArc2,
            wp.rightTopClearU,
            tQuint,
            rightPos,
          );
          rightPitch = lerp(0, -Math.PI / 2, easeInOutCubic(clamp01((rawT - 0.14) / 0.86)));
          rightJawOpen = 1;
          if (isMirror) {
            rightFrontJaw = lerp(preR.jawPos, preU.jawPos, tQuint);
            rightRearJaw = lerp(preR.jawNeg, preU.jawNeg, tQuint);
          }
          break;
        case 'u_clamp_top':
          cubePos.x = wp.cubeTopPos.x;
          cubePos.y = wp.cubeTopPos.y;
          leftPos.x = cubePos.x - preL.stripNormal;
          leftPos.y = cubePos.y;
          rightPos.x = wp.rightTopContactU.x;
          rightPos.y = lerp(
            wp.rightTopClearU.y,
            wp.rightTopContactU.y,
            easeInOutQuint(clamp01(rawT / 0.56)),
          );
          rightPitch = -Math.PI / 2;
          rightJawOpen = lerp(1, 0, easeInOutCubic(clamp01((rawT - 0.48) / 0.52)));
          if (isMirror) {
            rightFrontJaw = preU.jawPos;
            rightRearJaw = preU.jawNeg;
          }
          break;
        case 'u_twist':
          cubePos.x = wp.cubeTopPos.x;
          cubePos.y = wp.cubeTopPos.y;
          leftPos.x = cubePos.x - preL.stripNormal;
          leftPos.y = cubePos.y;
          rightPos.x = wp.rightTopContactU.x;
          rightPos.y = wp.rightTopContactU.y;
          rightPitch = -Math.PI / 2;
          rightRoll = twistTarget * tQuint;
          if (isMirror) {
            rightFrontJaw = preU.jawPos;
            rightRearJaw = preU.jawNeg;
          }
          activeFaceTurn = {
            move: spec.notation,
            turnId: this.currentTurnId,
            easedProgress: tQuint,
          };
          break;
        case 'u_release_top':
          cubePos.x = wp.cubeTopPos.x;
          cubePos.y = wp.cubeTopPos.y;
          leftPos.x = cubePos.x - preL.stripNormal;
          leftPos.y = cubePos.y;
          rightPos.x = wp.rightTopContactU.x;
          rightPos.y = lerp(
            wp.rightTopContactU.y,
            wp.rightTopClearU.y,
            easeInOutQuint(clamp01((rawT - 0.35) / 0.65)),
          );
          rightPitch = -Math.PI / 2;
          rightRoll = twistTarget;
          rightJawOpen = easeInOutCubic(clamp01(rawT / 0.48));
          if (isMirror) {
            rightFrontJaw = preU.jawPos;
            rightRearJaw = preU.jawNeg;
          }
          break;
        case 'u_to_side':
          cubePos.x = lerp(wp.cubeTopPos.x, 0, tQuint);
          cubePos.y = lerp(wp.cubeTopPos.y, holdY, tQuint);
          leftPos.x = cubePos.x - curL.stripNormal;
          leftPos.y = cubePos.y;
          evalCubicBezier3(
            wp.rightTopClearU,
            wp.rightTopArc2,
            wp.rightTopArc1,
            wp.rightSideClearCur,
            tQuint,
            rightPos,
          );
          rightPitch = lerp(-Math.PI / 2, 0, easeInOutCubic(clamp01(rawT / 0.86)));
          rightRoll = lerp(twistTarget, 0, tQuint);
          rightJawOpen = 1;
          if (isMirror) {
            rightFrontJaw = lerp(preU.jawPos, curR.jawPos, tQuint);
            rightRearJaw = lerp(preU.jawNeg, curR.jawNeg, tQuint);
          }
          break;
        case 'u_clamp_side':
          leftPos.x = -curL.stripNormal;
          rightPos.x = lerp(
            wp.rightSideClearCur.x,
            wp.rightClampHoldCur.x,
            easeInOutQuint(clamp01(rawT / 0.56)),
          );
          rightJawOpen = lerp(1, 0, easeInOutCubic(clamp01((rawT - 0.48) / 0.52)));
          if (isMirror) {
            rightFrontJaw = curR.jawPos;
            rightRearJaw = curR.jawNeg;
          }
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
        leftFrontJaw,
        leftRearJaw,
        rightFrontJaw,
        rightRearJaw,
        activeFaceTurn,
      };
    }

    // -------------------------------------------------------------------------
    // 3. D / D': Synchronized 180° Dual-Arm Cube Flip -> Overhead Right Arm Twist
    // -------------------------------------------------------------------------
    if (spec.face === 'D') {
      const twistTarget = spec.angleRad;
      const preD = preBounds.faces.D;
      // When cubePitch = PI, cube-local +Z maps to world -Z and -Z maps to world +Z
      const dFrontJaw = preD.jawNeg;
      const dRearJaw = preD.jawPos;

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
            wp.rightClampHoldPre.x,
            wp.rightSideClearPre.x,
            easeInOutQuint(clamp01((rawT - 0.25) / 0.75)),
          );
          break;
        case 'd_to_top':
          cubePitch = Math.PI;
          leftRoll = Math.PI;
          cubePos.x = lerp(0, wp.cubeTopPos.x, tQuint);
          cubePos.y = lerp(holdY, wp.cubeTopPos.y, tQuint);
          leftPos.x = cubePos.x - preL.stripNormal;
          leftPos.y = cubePos.y;
          evalCubicBezier3(
            wp.rightSideClearPre,
            wp.rightTopArc1,
            wp.rightTopArc2,
            wp.rightTopClearD,
            tQuint,
            rightPos,
          );
          rightPitch = lerp(0, -Math.PI / 2, easeInOutCubic(clamp01((rawT - 0.14) / 0.86)));
          rightRoll = lerp(-Math.PI, 0, easeInOutCubic(clamp01((rawT - 0.1) / 0.8)));
          rightJawOpen = 1;
          if (isMirror) {
            rightFrontJaw = lerp(preR.jawPos, dFrontJaw, tQuint);
            rightRearJaw = lerp(preR.jawNeg, dRearJaw, tQuint);
          }
          break;
        case 'd_clamp_top':
          cubePitch = Math.PI;
          leftRoll = Math.PI;
          cubePos.x = wp.cubeTopPos.x;
          cubePos.y = wp.cubeTopPos.y;
          leftPos.x = cubePos.x - preL.stripNormal;
          leftPos.y = cubePos.y;
          rightPos.x = wp.rightTopContactD.x;
          rightPos.y = lerp(
            wp.rightTopClearD.y,
            wp.rightTopContactD.y,
            easeInOutQuint(clamp01(rawT / 0.56)),
          );
          rightPitch = -Math.PI / 2;
          rightRoll = 0;
          rightJawOpen = lerp(1, 0, easeInOutCubic(clamp01((rawT - 0.48) / 0.52)));
          if (isMirror) {
            rightFrontJaw = dFrontJaw;
            rightRearJaw = dRearJaw;
          }
          break;
        case 'd_twist':
          cubePitch = Math.PI;
          leftRoll = Math.PI;
          cubePos.x = wp.cubeTopPos.x;
          cubePos.y = wp.cubeTopPos.y;
          leftPos.x = cubePos.x - preL.stripNormal;
          leftPos.y = cubePos.y;
          rightPos.x = wp.rightTopContactD.x;
          rightPos.y = wp.rightTopContactD.y;
          rightPitch = -Math.PI / 2;
          rightRoll = twistTarget * tQuint;
          if (isMirror) {
            rightFrontJaw = dFrontJaw;
            rightRearJaw = dRearJaw;
          }
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
          leftPos.x = cubePos.x - preL.stripNormal;
          leftPos.y = cubePos.y;
          rightPos.x = wp.rightTopContactD.x;
          rightPos.y = lerp(
            wp.rightTopContactD.y,
            wp.rightTopClearD.y,
            easeInOutQuint(clamp01((rawT - 0.35) / 0.65)),
          );
          rightPitch = -Math.PI / 2;
          rightRoll = twistTarget;
          rightJawOpen = easeInOutCubic(clamp01(rawT / 0.48));
          if (isMirror) {
            rightFrontJaw = dFrontJaw;
            rightRearJaw = dRearJaw;
          }
          break;
        case 'd_to_side':
          cubePitch = Math.PI;
          leftRoll = Math.PI;
          cubePos.x = lerp(wp.cubeTopPos.x, 0, tQuint);
          cubePos.y = lerp(wp.cubeTopPos.y, holdY, tQuint);
          leftPos.x = cubePos.x - curL.stripNormal;
          leftPos.y = cubePos.y;
          evalCubicBezier3(
            wp.rightTopClearD,
            wp.rightTopArc2,
            wp.rightTopArc1,
            wp.rightSideClearCur,
            tQuint,
            rightPos,
          );
          rightPitch = lerp(-Math.PI / 2, 0, easeInOutCubic(clamp01(rawT / 0.86)));
          rightRoll = lerp(twistTarget, -Math.PI, easeInOutCubic(clamp01((rawT - 0.1) / 0.8)));
          rightJawOpen = 1;
          if (isMirror) {
            rightFrontJaw = lerp(dFrontJaw, curR.jawPos, tQuint);
            rightRearJaw = lerp(dRearJaw, curR.jawNeg, tQuint);
          }
          break;
        case 'd_clamp_side':
          cubePitch = Math.PI;
          leftRoll = Math.PI;
          rightRoll = -Math.PI;
          leftPos.x = -curL.stripNormal;
          rightPos.x = lerp(
            wp.rightSideClearCur.x,
            wp.rightClampHoldCur.x,
            easeInOutQuint(clamp01(rawT / 0.56)),
          );
          rightJawOpen = lerp(1, 0, easeInOutCubic(clamp01((rawT - 0.48) / 0.52)));
          if (isMirror) {
            rightFrontJaw = curR.jawPos;
            rightRearJaw = curR.jawNeg;
          }
          break;
        case 'd_unflip_cube':
          cubePitch = lerp(Math.PI, 0, tQuint);
          leftRoll = cubePitch;
          rightRoll = -cubePitch;
          leftPos.x = -curL.stripNormal;
          rightPos.x = curR.stripNormal;
          if (isMirror) {
            leftFrontJaw = curL.jawPos;
            leftRearJaw = curL.jawNeg;
            rightFrontJaw = curR.jawPos;
            rightRearJaw = curR.jawNeg;
          }
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
        leftFrontJaw,
        leftRearJaw,
        rightFrontJaw,
        rightRearJaw,
        activeFaceTurn,
      };
    }

    // -------------------------------------------------------------------------
    // 4. F / F' and B / B': Zero-Overlap Overhead Pass-Off & Middle-Slice Regrip
    // -------------------------------------------------------------------------
    const isFront = spec.face === 'F';
    const presentYaw = isFront ? -Math.PI / 2 : Math.PI / 2;
    const leftTwistTarget = isFront ? -spec.angleRad : spec.angleRad;

    const preU = preBounds.faces.U;
    const preTargetFace = isFront ? preBounds.faces.F : preBounds.faces.B;
    const uFbFace = curBounds.faces.U_FB;

    // World +Z maps to cube +X at cubeYaw = -PI/2 (F), and to cube -X at cubeYaw = +PI/2 (B)
    const fbLeftFrontJaw = isFront ? preTargetFace.jawPos : preTargetFace.jawNeg;
    const fbLeftRearJaw = isFront ? preTargetFace.jawNeg : preTargetFace.jawPos;
    const uFbRightFrontJaw = isFront ? uFbFace.jawPos : uFbFace.jawNeg;
    const uFbRightRearJaw = isFront ? uFbFace.jawNeg : uFbFace.jawPos;

    const leftAtPreLX = wp.cubeTopPos.x - preL.stripNormal;
    const leftAtCurLX = wp.cubeTopPos.x - curL.stripNormal;
    const leftAtTargetX = wp.cubeTopPos.x - preTargetFace.stripNormal;
    const leftClearX = wp.cubeTopPos.x - wp.leftSpinClearDist;

    switch (step.kind) {
      case 'fb_open_right':
        rightJawOpen = easeInOutCubic(clamp01(rawT / 0.45));
        rightPos.x = lerp(
          wp.rightClampHoldPre.x,
          wp.rightSideClearPre.x,
          easeInOutQuint(clamp01((rawT - 0.25) / 0.75)),
        );
        break;
      case 'fb_right_to_top':
        cubePos.x = lerp(0, wp.cubeTopPos.x, tQuint);
        cubePos.y = lerp(holdY, wp.cubeTopPos.y, tQuint);
        leftPos.x = cubePos.x - preL.stripNormal;
        leftPos.y = cubePos.y;
        evalCubicBezier3(
          wp.rightSideClearPre,
          wp.rightTopArc1,
          wp.rightTopArc2,
          wp.rightTopClearU,
          tQuint,
          rightPos,
        );
        rightPitch = lerp(0, -Math.PI / 2, easeInOutCubic(clamp01((rawT - 0.14) / 0.86)));
        rightJawOpen = 1;
        if (isMirror) {
          rightFrontJaw = lerp(preR.jawPos, preU.jawPos, tQuint);
          rightRearJaw = lerp(preR.jawNeg, preU.jawNeg, tQuint);
        }
        break;
      case 'fb_clamp_top':
        cubePos.x = wp.cubeTopPos.x;
        cubePos.y = wp.cubeTopPos.y;
        leftPos.x = leftAtPreLX;
        leftPos.y = cubePos.y;
        rightPos.x = wp.rightTopContactU.x;
        rightPos.y = lerp(
          wp.rightTopClearU.y,
          wp.rightTopContactU.y,
          easeInOutQuint(clamp01(rawT / 0.56)),
        );
        rightPitch = -Math.PI / 2;
        rightJawOpen = lerp(1, 0, easeInOutCubic(clamp01((rawT - 0.48) / 0.52)));
        if (isMirror) {
          rightFrontJaw = preU.jawPos;
          rightRearJaw = preU.jawNeg;
        }
        break;
      case 'fb_open_retract_left':
        cubePos.x = wp.cubeTopPos.x;
        cubePos.y = wp.cubeTopPos.y;
        rightPos.x = wp.rightTopContactU.x;
        rightPos.y = wp.rightTopContactU.y;
        rightPitch = -Math.PI / 2;
        leftJawOpen = easeInOutCubic(clamp01(rawT / 0.42));
        leftPos.x = lerp(
          leftAtPreLX,
          leftClearX,
          easeInOutQuint(clamp01((rawT - 0.22) / 0.78)),
        );
        leftPos.y = cubePos.y;
        if (isMirror) {
          rightFrontJaw = preU.jawPos;
          rightRearJaw = preU.jawNeg;
        }
        break;
      case 'fb_present_cube':
        cubePos.x = wp.cubeTopPos.x;
        cubePos.y = wp.cubeTopPos.y;
        cubeYaw = presentYaw * tQuint;
        rightPos.x = wp.rightTopContactU.x;
        rightPos.y = wp.rightTopContactU.y;
        rightPitch = -Math.PI / 2;
        rightRoll = -cubeYaw;
        leftPos.x = leftClearX;
        leftPos.y = cubePos.y;
        leftJawOpen = 1;
        if (isMirror) {
          rightFrontJaw = preU.jawPos;
          rightRearJaw = preU.jawNeg;
          leftFrontJaw = lerp(preL.jawPos, fbLeftFrontJaw, tQuint);
          leftRearJaw = lerp(preL.jawNeg, fbLeftRearJaw, tQuint);
        }
        break;
      case 'fb_advance_clamp_left':
        cubePos.x = wp.cubeTopPos.x;
        cubePos.y = wp.cubeTopPos.y;
        cubeYaw = presentYaw;
        rightPos.x = wp.rightTopContactU.x;
        rightPos.y = wp.rightTopContactU.y;
        rightPitch = -Math.PI / 2;
        rightRoll = -presentYaw;
        leftPos.x = lerp(
          leftClearX,
          leftAtTargetX,
          easeInOutQuint(clamp01(rawT / 0.58)),
        );
        leftPos.y = cubePos.y;
        leftJawOpen = lerp(1, 0, easeInOutCubic(clamp01((rawT - 0.48) / 0.52)));
        if (isMirror) {
          rightFrontJaw = preU.jawPos;
          rightRearJaw = preU.jawNeg;
          leftFrontJaw = fbLeftFrontJaw;
          leftRearJaw = fbLeftRearJaw;
        }
        break;
      case 'fb_right_release_top_unwind':
        cubePos.x = wp.cubeTopPos.x;
        cubePos.y = wp.cubeTopPos.y;
        cubeYaw = presentYaw;
        leftPos.x = leftAtTargetX;
        leftPos.y = cubePos.y;
        rightPos.x = wp.rightTopContactU.x;
        rightPos.y = lerp(
          wp.rightTopContactU.y,
          wp.rightTopClearU.y,
          easeInOutQuint(clamp01((rawT - 0.35) / 0.65)),
        );
        rightPitch = -Math.PI / 2;
        rightRoll = -presentYaw;
        rightJawOpen = easeInOutCubic(clamp01(rawT / 0.48));
        if (isMirror) {
          rightFrontJaw = preU.jawPos;
          rightRearJaw = preU.jawNeg;
          leftFrontJaw = fbLeftFrontJaw;
          leftRearJaw = fbLeftRearJaw;
        }
        break;
      case 'fb_right_unwind_top':
        cubePos.x = wp.cubeTopPos.x;
        cubePos.y = wp.cubeTopPos.y;
        cubeYaw = presentYaw;
        leftPos.x = leftAtTargetX;
        leftPos.y = cubePos.y;
        rightPos.x = wp.rightTopClearU.x;
        rightPos.y = wp.rightTopClearU.y;
        rightPitch = -Math.PI / 2;
        rightRoll = lerp(-presentYaw, 0, tQuint);
        rightJawOpen = 1;
        if (isMirror) {
          rightFrontJaw = lerp(preU.jawPos, uFbRightFrontJaw, tQuint);
          rightRearJaw = lerp(preU.jawNeg, uFbRightRearJaw, tQuint);
          leftFrontJaw = fbLeftFrontJaw;
          leftRearJaw = fbLeftRearJaw;
        }
        break;
      case 'fb_right_reclamp_top':
        cubePos.x = wp.cubeTopPos.x;
        cubePos.y = wp.cubeTopPos.y;
        cubeYaw = presentYaw;
        leftPos.x = leftAtTargetX;
        leftPos.y = cubePos.y;
        rightPos.x = wp.rightTopContactUFB.x;
        rightPos.y = lerp(
          wp.rightTopClearU.y,
          wp.rightTopContactUFB.y,
          easeInOutQuint(clamp01(rawT / 0.56)),
        );
        rightPitch = -Math.PI / 2;
        rightRoll = 0;
        rightJawOpen = lerp(1, 0, easeInOutCubic(clamp01((rawT - 0.48) / 0.52)));
        if (isMirror) {
          rightFrontJaw = uFbRightFrontJaw;
          rightRearJaw = uFbRightRearJaw;
          leftFrontJaw = fbLeftFrontJaw;
          leftRearJaw = fbLeftRearJaw;
        }
        break;
      case 'fb_twist':
        cubePos.x = wp.cubeTopPos.x;
        cubePos.y = wp.cubeTopPos.y;
        cubeYaw = presentYaw;
        rightPos.x = wp.rightTopContactUFB.x;
        rightPos.y = wp.rightTopContactUFB.y;
        rightPitch = -Math.PI / 2;
        rightRoll = 0;
        leftPos.x = leftAtTargetX;
        leftPos.y = cubePos.y;
        leftRoll = leftTwistTarget * tQuint;
        if (isMirror) {
          rightFrontJaw = uFbRightFrontJaw;
          rightRearJaw = uFbRightRearJaw;
          leftFrontJaw = fbLeftFrontJaw;
          leftRearJaw = fbLeftRearJaw;
        }
        activeFaceTurn = {
          move: spec.notation,
          turnId: this.currentTurnId,
          easedProgress: tQuint,
        };
        break;
      case 'fb_open_retract_left_post':
        cubePos.x = wp.cubeTopPos.x;
        cubePos.y = wp.cubeTopPos.y;
        cubeYaw = presentYaw;
        rightPos.x = wp.rightTopContactUFB.x;
        rightPos.y = wp.rightTopContactUFB.y;
        rightPitch = -Math.PI / 2;
        rightRoll = 0;
        leftJawOpen = easeInOutCubic(clamp01(rawT / 0.42));
        leftPos.x = lerp(
          leftAtTargetX,
          leftClearX,
          easeInOutQuint(clamp01((rawT - 0.25) / 0.75)),
        );
        leftPos.y = cubePos.y;
        leftRoll = leftTwistTarget;
        if (isMirror) {
          rightFrontJaw = uFbRightFrontJaw;
          rightRearJaw = uFbRightRearJaw;
          leftFrontJaw = fbLeftFrontJaw;
          leftRearJaw = fbLeftRearJaw;
        }
        break;
      case 'fb_unwind_left_clear':
        cubePos.x = wp.cubeTopPos.x;
        cubePos.y = wp.cubeTopPos.y;
        cubeYaw = presentYaw;
        rightPos.x = wp.rightTopContactUFB.x;
        rightPos.y = wp.rightTopContactUFB.y;
        rightPitch = -Math.PI / 2;
        rightRoll = 0;
        leftPos.x = leftClearX;
        leftPos.y = cubePos.y;
        leftJawOpen = 1;
        leftRoll = lerp(leftTwistTarget, 0, tQuint);
        if (isMirror) {
          rightFrontJaw = uFbRightFrontJaw;
          rightRearJaw = uFbRightRearJaw;
          leftFrontJaw = lerp(fbLeftFrontJaw, curL.jawPos, tQuint);
          leftRearJaw = lerp(fbLeftRearJaw, curL.jawNeg, tQuint);
        }
        break;
      case 'fb_restore_cube':
        cubePos.x = wp.cubeTopPos.x;
        cubePos.y = wp.cubeTopPos.y;
        cubeYaw = lerp(presentYaw, 0, tQuint);
        rightPos.x = wp.rightTopContactUFB.x;
        rightPos.y = wp.rightTopContactUFB.y;
        rightPitch = -Math.PI / 2;
        rightRoll = presentYaw * tQuint;
        leftPos.x = leftClearX;
        leftPos.y = cubePos.y;
        leftJawOpen = 1;
        if (isMirror) {
          rightFrontJaw = uFbRightFrontJaw;
          rightRearJaw = uFbRightRearJaw;
          leftFrontJaw = curL.jawPos;
          leftRearJaw = curL.jawNeg;
        }
        break;
      case 'fb_advance_reclamp_left':
        cubePos.x = wp.cubeTopPos.x;
        cubePos.y = wp.cubeTopPos.y;
        rightPos.x = wp.rightTopContactUFB.x;
        rightPos.y = wp.rightTopContactUFB.y;
        rightPitch = -Math.PI / 2;
        rightRoll = presentYaw;
        leftPos.x = lerp(
          leftClearX,
          leftAtCurLX,
          easeInOutQuint(clamp01(rawT / 0.58)),
        );
        leftPos.y = cubePos.y;
        leftJawOpen = lerp(1, 0, easeInOutCubic(clamp01((rawT - 0.48) / 0.52)));
        if (isMirror) {
          rightFrontJaw = uFbRightFrontJaw;
          rightRearJaw = uFbRightRearJaw;
          leftFrontJaw = curL.jawPos;
          leftRearJaw = curL.jawNeg;
        }
        break;
      case 'fb_release_top':
        cubePos.x = wp.cubeTopPos.x;
        cubePos.y = wp.cubeTopPos.y;
        leftPos.x = leftAtCurLX;
        leftPos.y = cubePos.y;
        rightPos.x = wp.rightTopContactUFB.x;
        rightPos.y = lerp(
          wp.rightTopContactUFB.y,
          wp.rightTopClearU.y,
          easeInOutQuint(clamp01((rawT - 0.35) / 0.65)),
        );
        rightPitch = -Math.PI / 2;
        rightRoll = presentYaw;
        rightJawOpen = easeInOutCubic(clamp01(rawT / 0.48));
        if (isMirror) {
          rightFrontJaw = uFbRightFrontJaw;
          rightRearJaw = uFbRightRearJaw;
          leftFrontJaw = curL.jawPos;
          leftRearJaw = curL.jawNeg;
        }
        break;
      case 'fb_right_to_side':
        cubePos.x = lerp(wp.cubeTopPos.x, 0, tQuint);
        cubePos.y = lerp(wp.cubeTopPos.y, holdY, tQuint);
        leftPos.x = cubePos.x - curL.stripNormal;
        leftPos.y = cubePos.y;
        evalCubicBezier3(
          wp.rightTopClearU,
          wp.rightTopArc2,
          wp.rightTopArc1,
          wp.rightSideClearCur,
          tQuint,
          rightPos,
        );
        rightPitch = lerp(-Math.PI / 2, 0, easeInOutCubic(clamp01(rawT / 0.86)));
        rightRoll = lerp(presentYaw, 0, tQuint);
        rightJawOpen = 1;
        if (isMirror) {
          rightFrontJaw = lerp(uFbRightFrontJaw, curR.jawPos, tQuint);
          rightRearJaw = lerp(uFbRightRearJaw, curR.jawNeg, tQuint);
          leftFrontJaw = curL.jawPos;
          leftRearJaw = curL.jawNeg;
        }
        break;
      case 'fb_reclamp_right':
        leftPos.x = -curL.stripNormal;
        rightPos.x = lerp(
          wp.rightSideClearCur.x,
          wp.rightClampHoldCur.x,
          easeInOutQuint(clamp01(rawT / 0.56)),
        );
        rightJawOpen = lerp(1, 0, easeInOutCubic(clamp01((rawT - 0.48) / 0.52)));
        if (isMirror) {
          rightFrontJaw = curR.jawPos;
          rightRearJaw = curR.jawNeg;
          leftFrontJaw = curL.jawPos;
          leftRearJaw = curL.jawNeg;
        }
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
      leftFrontJaw,
      leftRearJaw,
      rightFrontJaw,
      rightRearJaw,
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
    this.twistStartBounds = cloneBoundsSnapshot(this.activeBounds);
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
        if (!isSolving && this.stopScrambleRequested) {
          this.finishScramble();
          break;
        }

        if (!isSolving && this.continuousScrambleActive) {
          const nextMove = this.scrambleGenerator.next();
          this.loadMoveNotation(nextMove);
          this.stepElapsed = overflow;
          this.notify();
        } else {
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
      case 'SWAPPING':
        return this.durations.swap;
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
      case 'SWAPPING':
        return 'STANDBY';
      default:
        return null;
    }
  }

  private advancePhasesIfComplete(committedMoves: CubeMoveNotation[]): {
    didSolveMove: boolean;
    solvedNow: boolean;
    commitPuzzleSwap: PuzzleType | null;
  } {
    let didSolveMove = false;
    let solvedNow = false;
    let commitPuzzleSwap: PuzzleType | null = null;

    while (
      this.isBusy() &&
      this.state !== 'SCRAMBLING' &&
      this.state !== 'SOLVING'
    ) {
      const duration = this.getPhaseDuration(this.state);
      if (duration <= 0 || this.phaseElapsed < duration) {
        break;
      }

      // If SWAPPING completed inside a single large dt step, ensure swap still commits!
      if (this.state === 'SWAPPING' && !this.swapCommitted) {
        commitPuzzleSwap = this.applySwapCommit();
      }

      const overflow = this.phaseElapsed - duration;
      const next = this.getNextState(this.state);
      if (!next) {
        this.phaseElapsed = duration;
        break;
      }

      // If user clicked the Puzzle Switcher while HOLDING, Put Down finished -> seamlessly enter SWAPPING!
      if (next === 'STANDBY' && this.pendingPuzzleSwap !== null) {
        this.startSwapTo(this.pendingPuzzleSwap, overflow);
        continue;
      }

      if (next === 'STANDBY' && this.state === 'SWAPPING') {
        this.swapTargetPuzzle = null;
        this.swapCommitted = false;
      }

      // Seamless Auto-Lift Integration: once LIFTING reaches HOLDING, immediately start scrambling or solving!
      if (next === 'HOLDING' && this.pendingContinuousScramble) {
        this.startContinuousScramble();
        if (overflow > 0) {
          this.advanceActiveMove(overflow, committedMoves);
        }
        break;
      }
      if (
        next === 'HOLDING' &&
        this.pendingMoveQueue &&
        this.pendingMoveQueue.length > 0
      ) {
        const queued = this.pendingMoveQueue;
        this.startMoveSequence(queued);
        if (overflow > 0) {
          this.advanceActiveMove(overflow, committedMoves);
        }
        break;
      }
      if (
        next === 'HOLDING' &&
        this.pendingSolveQueue &&
        this.pendingSolveQueue.length > 0
      ) {
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

    return {didSolveMove, solvedNow, commitPuzzleSwap};
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
