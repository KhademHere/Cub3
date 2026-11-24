import * as THREE from 'three';

import type {FaceAxis, FaceLayer} from './types';

export type CubeFace = 'U' | 'D' | 'L' | 'R' | 'F' | 'B';
export type CubeMoveNotation =
  | 'U'
  | "U'"
  | 'D'
  | "D'"
  | 'L'
  | "L'"
  | 'R'
  | "R'"
  | 'F'
  | "F'"
  | 'B'
  | "B'";

export interface CubeMoveSpec {
  notation: CubeMoveNotation;
  face: CubeFace;
  axis: FaceAxis;
  layer: FaceLayer;
  /** Signed quarter-turns (+1 = +90deg, -1 = -90deg) around the positive world axis. */
  quarterTurns: 1 | -1;
  /** Exact target rotation in radians around the cube's local axis. */
  angleRad: number;
  /** True for prime (counter-clockwise) moves. */
  prime: boolean;
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
    };
    specs[ccwNotation] = {
      notation: ccwNotation,
      face,
      axis: meta.axis,
      layer: meta.layer,
      quarterTurns: ccw,
      angleRad: ccw * (Math.PI / 2),
      prime: true,
    };
  }
  return specs;
})();

export function getMoveSpec(notation: CubeMoveNotation): CubeMoveSpec {
  return MOVE_SPECS[notation];
}

export function getInverseMove(notation: CubeMoveNotation): CubeMoveNotation {
  return notation.endsWith("'")
    ? (notation[0] as CubeMoveNotation)
    : (`${notation}'` as CubeMoveNotation);
}

/**
 * Stateful on-the-fly scramble move generator supporting indefinite continuous scrambling.
 * - Never repeats the exact same face twice in a row (no R followed by R or R').
 * - Prevents opposite-face ABA redundancies (e.g. R, L, R').
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
  next(): CubeMoveNotation {
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
    const prime = this.rng() < 0.5;
    const notation = (prime ? `${chosenFace}'` : chosenFace) as CubeMoveNotation;

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
): CubeMoveNotation[] {
  const length =
    lengthOverride !== undefined
      ? Math.max(6, Math.floor(lengthOverride))
      : 14 + Math.floor(rng() * 3);

  const generator = new ContinuousScrambleGenerator(rng);
  const sequence: CubeMoveNotation[] = [];
  for (let i = 0; i < length; i++) {
    sequence.push(generator.next());
  }
  return sequence;
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
