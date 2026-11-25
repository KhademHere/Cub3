import * as THREE from 'three';

import type {FaceAxis, FaceLayer, PuzzleType} from './types';

export type CubeFace = 'U' | 'D' | 'L' | 'R' | 'F' | 'B';
export type CubeMoveNotation =
  | 'U'
  | "U'"
  | 'D'
  | "D'"
  | 'L'
  | "L'"
  | 'L2'
  | 'R'
  | "R'"
  | 'R2'
  | 'F'
  | "F'"
  | 'F2'
  | 'B'
  | "B'"
  | 'B2';

export interface CubeMoveSpec {
  notation: CubeMoveNotation;
  face: CubeFace;
  axis: FaceAxis;
  layer: FaceLayer;
  /** Signed quarter-turns (+1 = +90deg, -1 = -90deg, 2 = 180deg) around the positive world axis. */
  quarterTurns: 1 | -1 | 2;
  /** Exact target rotation in radians around the cube's local axis. */
  angleRad: number;
  /** True for prime (counter-clockwise) quarter-turn moves. */
  prime: boolean;
  /** True for 180-degree half-turn moves (L2, R2, F2, B2). */
  isHalfTurn: boolean;
}

const FACE_META: Record<
  CubeFace,
  {axis: FaceAxis; layer: FaceLayer; cwQuarterTurn: 1 | -1; opposite: CubeFace}
> = {
  U: {axis: 'y', layer: 1, cwQuarterTurn: -1, opposite: 'D'},
  D: {axis: 'y', layer: -1, cwQuarterTurn: 1, opposite: 'U'},
  R: {axis: 'x', layer: 1, cwQuarterTurn: -1, opposite: 'L'},
  L: {axis: 'x', layer: -1, cwQuarterTurn: 1, opposite: 'R'},
  F: {axis: 'z', layer: 1, cwQuarterTurn: -1, opposite: 'B'},
  B: {axis: 'z', layer: -1, cwQuarterTurn: 1, opposite: 'F'},
};

export const ALL_FACES: readonly CubeFace[] = ['U', 'D', 'L', 'R', 'F', 'B'];
export const DOMINO_MOVES: readonly CubeMoveNotation[] = [
  'U',
  "U'",
  'D',
  "D'",
  'L2',
  'R2',
  'F2',
  'B2',
];

export const MOVE_SPECS: Record<CubeMoveNotation, CubeMoveSpec> = (() => {
  const specs = {} as Record<CubeMoveNotation, CubeMoveSpec>;
  for (const face of ALL_FACES) {
    const meta = FACE_META[face];
    const cw = meta.cwQuarterTurn;
    const ccw = (cw * -1) as 1 | -1;
    const cwNotation = face as CubeMoveNotation;
    const ccwNotation = `${face}'` as CubeMoveNotation;

    specs[cwNotation] = {
      notation: cwNotation,
      face,
      axis: meta.axis,
      layer: meta.layer,
      quarterTurns: cw,
      angleRad: cw * (Math.PI / 2),
      prime: false,
      isHalfTurn: false,
    };
    specs[ccwNotation] = {
      notation: ccwNotation,
      face,
      axis: meta.axis,
      layer: meta.layer,
      quarterTurns: ccw,
      angleRad: ccw * (Math.PI / 2),
      prime: true,
      isHalfTurn: false,
    };

    if (face === 'L' || face === 'R' || face === 'F' || face === 'B') {
      const halfNotation = `${face}2` as CubeMoveNotation;
      specs[halfNotation] = {
        notation: halfNotation,
        face,
        axis: meta.axis,
        layer: meta.layer,
        quarterTurns: 2,
        angleRad: cw * Math.PI,
        prime: false,
        isHalfTurn: true,
      };
    }
  }
  return specs;
})();

export function getMoveSpec(notation: CubeMoveNotation): CubeMoveSpec {
  return MOVE_SPECS[notation];
}

export function getInverseMove(notation: CubeMoveNotation): CubeMoveNotation {
  if (notation.endsWith('2')) {
    return notation;
  }
  return notation.endsWith("'")
    ? (notation[0] as CubeMoveNotation)
    : (`${notation}'` as CubeMoveNotation);
}

/**
 * Stateful on-the-fly scramble move generator supporting indefinite continuous scrambling.
 * - Supports both 3x3x3 puzzles (all 12 quarter turns) and 3x3x2 Domino Cuboid
 *   (`U`, `U'`, `D`, `D'`, `L2`, `R2`, `F2`, `B2`).
 * - Never repeats the exact same face twice in a row (no R followed by R, R', or R2).
 * - Prevents opposite-face ABA redundancies (e.g. R, L, R' or R2, L2, R2).
 * - Continuously balances face frequency so turns remain evenly distributed across all 6 faces.
 */
export class ContinuousScrambleGenerator {
  private readonly rng: () => number;
  private readonly faceCounts: Record<CubeFace, number> = {
    U: 0,
    D: 0,
    L: 0,
    R: 0,
    F: 0,
    B: 0,
  };
  private prevFace: CubeFace | null = null;
  private prevPrevFace: CubeFace | null = null;

  constructor(rng: () => number = Math.random) {
    this.rng = rng;
  }

  /** Generates the next balanced, non-redundant random face turn on the fly. */
  next(puzzleType: PuzzleType = 'classic'): CubeMoveNotation {
    const allowedFaces = ALL_FACES.filter((face) => {
      if (face === this.prevFace) return false;
      if (
        this.prevFace !== null &&
        this.prevPrevFace !== null &&
        FACE_META[this.prevFace].opposite === this.prevPrevFace &&
        face === this.prevPrevFace
      ) {
        return false;
      }
      return true;
    });

    const minCount = Math.min(...allowedFaces.map((f) => this.faceCounts[f]));
    const balanced = allowedFaces.filter((f) => this.faceCounts[f] <= minCount + 1);
    const pool = balanced.length > 0 ? balanced : allowedFaces;

    const chosenFace = pool[Math.floor(this.rng() * pool.length)];
    let notation: CubeMoveNotation;
    if (
      puzzleType === 'domino' &&
      chosenFace !== 'U' &&
      chosenFace !== 'D'
    ) {
      notation = `${chosenFace}2` as CubeMoveNotation;
    } else {
      const prime = this.rng() < 0.5;
      notation = (prime ? `${chosenFace}'` : chosenFace) as CubeMoveNotation;
    }

    this.faceCounts[chosenFace] += 1;
    this.prevPrevFace = this.prevFace;
    this.prevFace = chosenFace;
    return notation;
  }

  /** Seeds history context when resuming after a custom move without resetting counts. */
  recordExternalFace(face: CubeFace): void {
    this.faceCounts[face] += 1;
    this.prevPrevFace = this.prevFace;
    this.prevFace = face;
  }

  getFaceCounts(): Readonly<Record<CubeFace, number>> {
    return {...this.faceCounts};
  }
}

/**
 * Generates a finite balanced random scramble sequence (useful for tests & scripted demos).
 */
export function generateScrambleSequence(
  rng: () => number = Math.random,
  lengthOverride?: number,
  puzzleType: PuzzleType = 'classic',
): CubeMoveNotation[] {
  const length =
    lengthOverride !== undefined
      ? Math.max(6, Math.floor(lengthOverride))
      : 14 + Math.floor(rng() * 3);

  const generator = new ContinuousScrambleGenerator(rng);
  const sequence: CubeMoveNotation[] = [];
  for (let i = 0; i < length; i++) {
    sequence.push(generator.next(puzzleType));
  }
  return sequence;
}

/**
 * Optimizes a cube move sequence to eliminate all redundant turns:
 * - Cancels adjacent inverse pairs (e.g., `L L'` -> removed, `R L R'` -> `L`)
 * - Cancels adjacent identical 180° turns (e.g., `R2 R2` -> removed, `R2 L2 R2` -> `L2`)
 * - Collapses triple identical turns into a single inverse (`U U U` -> `U'`)
 * - Cancels 4 identical turns (`F F F F` -> removed)
 * - Repeats passes until full fixed-point convergence so cascading cancellations
 *   (e.g., `R U U' R'` or `R2 U U' R2`) also reduce cleanly to empty.
 *
 * Uses exact group theory on disjoint opposite-face pairs (`{U,D}`, `{L,R}`, `{F,B}`),
 * which commute because they act on non-overlapping layers along the same axis.
 */
export function optimizeMoveSequence(
  moves: readonly CubeMoveNotation[],
  puzzleType: PuzzleType = 'classic',
): CubeMoveNotation[] {
  let current: CubeMoveNotation[] = [...moves];

  let changed = true;
  while (changed) {
    changed = false;
    const next: CubeMoveNotation[] = [];
    let i = 0;

    while (i < current.length) {
      const startSpec = getMoveSpec(current[i]);
      const axis = startSpec.axis;
      // Collect maximal contiguous run of moves sharing the same rotation axis
      let j = i;
      const runFaces = new Map<CubeFace, number>();
      const faceHadHalfTurn = new Map<CubeFace, boolean>();
      const faceOrder: CubeFace[] = [];

      while (j < current.length && getMoveSpec(current[j]).axis === axis) {
        const spec = getMoveSpec(current[j]);
        if (!runFaces.has(spec.face)) {
          faceOrder.push(spec.face);
          runFaces.set(spec.face, 0);
        }
        if (spec.isHalfTurn) {
          faceHadHalfTurn.set(spec.face, true);
        }
        // Track clockwise quarter-turns (+1 CW, -1 prime, +2 half-turn)
        const delta = spec.isHalfTurn ? 2 : spec.prime ? -1 : 1;
        runFaces.set(spec.face, (runFaces.get(spec.face) ?? 0) + delta);
        j += 1;
      }

      const reduced: CubeMoveNotation[] = [];
      for (const face of faceOrder) {
        const raw = runFaces.get(face) ?? 0;
        const mod = ((raw % 4) + 4) % 4;
        if (mod === 1) {
          reduced.push(face as CubeMoveNotation);
        } else if (mod === 2) {
          const emitHalfTurn =
            face !== 'U' &&
            face !== 'D' &&
            (puzzleType === 'domino' || faceHadHalfTurn.get(face) === true);
          if (emitHalfTurn) {
            reduced.push(`${face}2` as CubeMoveNotation);
          } else {
            reduced.push(face as CubeMoveNotation, face as CubeMoveNotation);
          }
        } else if (mod === 3) {
          reduced.push(`${face}'` as CubeMoveNotation);
        }
      }

      const runLen = j - i;
      if (
        reduced.length !== runLen ||
        reduced.some((m, idx) => m !== current[i + idx])
      ) {
        changed = true;
      }

      next.push(...reduced);
      i = j;
    }

    current = next;
  }

  return current;
}

/**
 * Generates an exact, optimized Part 3 Auto-Solve queue from accumulated `moveHistory`:
 * 1. Reverses the recorded history and inverts every move (`R` <-> `R'`, `R2` <-> `R2`).
 * 2. Runs the fixed-point Move Optimization Pass for an intelligent, minimal solve.
 */
export function computeOptimizedSolution(
  moveHistory: readonly CubeMoveNotation[],
  puzzleType: PuzzleType = 'classic',
): CubeMoveNotation[] {
  if (moveHistory.length === 0) return [];
  const reversedInverses: CubeMoveNotation[] = [];
  for (let i = moveHistory.length - 1; i >= 0; i--) {
    reversedInverses.push(getInverseMove(moveHistory[i]));
  }
  return optimizeMoveSequence(reversedInverses, puzzleType);
}

const _rotMat = new THREE.Matrix4();
const _snappedMat = new THREE.Matrix4();
const _colX = new THREE.Vector3();
const _colY = new THREE.Vector3();
const _colZ = new THREE.Vector3();

function snapAxisColumn(v: THREE.Vector3): void {
  const ax = Math.abs(v.x);
  const ay = Math.abs(v.y);
  const az = Math.abs(v.z);
  if (ax >= ay && ax >= az) {
    v.set(v.x >= 0 ? 1 : -1, 0, 0);
  } else if (ay >= ax && ay >= az) {
    v.set(0, v.y >= 0 ? 1 : -1, 0);
  } else {
    v.set(0, 0, v.z >= 0 ? 1 : -1);
  }
}

/**
 * Zero-drift orthogonal snapping: snaps any quaternion to the nearest exact
 * 90-degree cube orientation matrix (entries strictly in {-1, 0, 1}, det = +1).
 */
export function snapQuaternionToExact90(q: THREE.Quaternion): THREE.Quaternion {
  _rotMat.makeRotationFromQuaternion(q);
  _rotMat.extractBasis(_colX, _colY, _colZ);

  snapAxisColumn(_colX);
  snapAxisColumn(_colY);
  // Guarantee right-handed orthogonality (det = +1)
  _colZ.crossVectors(_colX, _colY);
  if (_colZ.lengthSq() < 0.5) {
    // Fallback if floating point somehow snapped X and Y onto same axis
    _rotMat.extractBasis(_colX, _colY, _colZ);
    snapAxisColumn(_colX);
    snapAxisColumn(_colZ);
    _colY.crossVectors(_colZ, _colX);
  }
  snapAxisColumn(_colZ);

  _snappedMat.makeBasis(_colX, _colY, _colZ);
  q.setFromRotationMatrix(_snappedMat).normalize();
  return q;
}
