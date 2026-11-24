import * as THREE from 'three';
import {RoundedBoxGeometry} from 'three/addons/geometries/RoundedBoxGeometry.js';

import {
  getMoveSpec,
  snapQuaternionToExact90,
  type CubeMoveNotation,
  type CubeMoveSpec,
} from './cubeMoves';
import {LAB_DIMENSIONS} from './kinematics';
import type {LabMaterialLibrary} from './materials';
import type {
  CubieCoord,
  FaceAxis,
  FaceLayer,
  FaceStripMetrics,
  PuzzleBoundsSnapshot,
  PuzzleType,
} from './types';

export interface CubieUnit {
  group: THREE.Group;
  coord: CubieCoord;
  readonly solvedCoord: Readonly<CubieCoord>;
  /** Exact cubie-center position in cube-local space when solved (relative to core `(0, 0, 0)`). */
  readonly solvedPos: THREE.Vector3;
  /** Exact cubie-local AABB minimum corner (relative to cubie center, including outer beveled tiles). */
  readonly localMin: THREE.Vector3;
  /** Exact cubie-local AABB maximum corner (relative to cubie center, including outer beveled tiles). */
  readonly localMax: THREE.Vector3;
}

/**
 * Exact Mirror Cube (Bump Cube) slice thicknesses in cubie units (`1 unit = CUBE_SIZE / 3 = 0.070m`).
 * Crucial Core-Alignment Rule:
 * - Middle slice `M = 0.86` is IDENTICAL across all 3 axes and centered at `(0, 0, 0)`,
 *   placing all 6 internal cut planes mathematically at `±0.43` units (`±0.0301m`).
 * - Total solved footprint along each axis is `3.00` units (`0.210m`), matching Classic 3x3.
 */
export const MIRROR_CORE_SLICE_UNIT = 0.86;
export const MIRROR_LAYER_UNITS: Record<FaceAxis, Record<FaceLayer, number>> = {
  x: {'-1': 0.54, '0': MIRROR_CORE_SLICE_UNIT, '1': 1.6},
  y: {'-1': 0.68, '0': MIRROR_CORE_SLICE_UNIT, '1': 1.46},
  z: {'-1': 0.78, '0': MIRROR_CORE_SLICE_UNIT, '1': 1.36},
};

const MIRROR_CUBIE_GAP = 0.0026;
const MIRROR_TILE_THICKNESS = 0.0016;
const MIRROR_TILE_INSET = 0.0068;
const MIRROR_FLUSH_EPS = 0.0005;

/** Computes the exact center offset (in cubie units) of a Mirror Cube layer relative to core `0`. */
export function getMirrorLayerCenterUnit(
  axis: FaceAxis,
  layer: FaceLayer,
): number {
  const halfM = MIRROR_CORE_SLICE_UNIT / 2;
  if (layer === 0) return 0;
  const thickness = MIRROR_LAYER_UNITS[axis][layer];
  return layer < 0 ? -(halfM + thickness / 2) : halfM + thickness / 2;
}

/** Rotates discrete integer cubie coordinates by an exact 90-degree multiple around `axis`. */
function rotateCoordExact90(
  coord: CubieCoord,
  axis: FaceAxis,
  quarterTurns: number,
): void {
  const steps = ((quarterTurns % 4) + 4) % 4;
  for (let i = 0; i < steps; i++) {
    const {x, y, z} = coord;
    if (axis === 'x') {
      coord.y = (-z || 0) as FaceLayer;
      coord.z = (y || 0) as FaceLayer;
    } else if (axis === 'y') {
      coord.x = (z || 0) as FaceLayer;
      coord.z = (-x || 0) as FaceLayer;
    } else {
      coord.x = (-y || 0) as FaceLayer;
      coord.y = (x || 0) as FaceLayer;
    }
  }
}

/**
 * Creates a rounded-rectangle extruded tile geometry for both glossy Classic 3x3
 * stickers and brushed silver-chrome Mirror Cube outer plates.
 */
function createRoundedRectTileGeometry(
  width: number,
  height: number,
  cornerRadius: number,
  thickness: number,
): THREE.ExtrudeGeometry {
  const hw = width / 2;
  const hh = height / 2;
  const r = Math.min(cornerRadius, hw * 0.42, hh * 0.42);
  const shape = new THREE.Shape();

  shape.moveTo(-hw + r, -hh);
  shape.lineTo(hw - r, -hh);
  shape.quadraticCurveTo(hw, -hh, hw, -hh + r);
  shape.lineTo(hw, hh - r);
  shape.quadraticCurveTo(hw, hh, hw - r, hh);
  shape.lineTo(-hw + r, hh);
  shape.quadraticCurveTo(-hw, hh, -hw, hh - r);
  shape.lineTo(-hw, -hh + r);
  shape.quadraticCurveTo(-hw, -hh, -hw + r, -hh);

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: true,
    bevelThickness: thickness * 0.42,
    bevelSize: thickness * 0.42,
    bevelSegments: 2,
    curveSegments: 6,
  });
  geo.center();

  // Normalize UVs smoothly into [0, 1] x [0, 1] so procedural brushed-chrome grain renders crisply
  const posAttr = geo.attributes.position;
  const uvAttr = geo.attributes.uv;
  if (posAttr && uvAttr) {
    const spanW = Math.max(1e-5, width);
    const spanH = Math.max(1e-5, height);
    for (let i = 0; i < posAttr.count; i++) {
      const px = posAttr.getX(i);
      const py = posAttr.getY(i);
      uvAttr.setXY(i, px / spanW + 0.5, py / spanH + 0.5);
    }
    uvAttr.needsUpdate = true;
  }

  return geo;
}

/**
 * Modular 3x3x3 Puzzle supporting both:
 * - `'classic'`: Standard 27-cubie glossy 6-color Rubik's Cube
 * - `'mirror'`: Shape-shifting 27-cubie Metallic Mirror Cube (Bump Cube) with exact
 *   core-aligned `M = 0.86` cut planes, asymmetric outer layers, and brushed silver-chrome tiles
 *
 * Includes exact 90-degree pivot turns, zero-drift orthogonal snapping, persistent `moveHistory`,
 * and real-time `getBoundsSnapshot()` outer surface measurements for dynamic robotic grippers.
 */
export class RubiksCube extends THREE.Group {
  public readonly cubies: CubieUnit[] = [];
  public readonly pivotGroup: THREE.Group;
  public readonly cubieSpacing: number;
  public readonly totalSize: number;

  /** Persistent ordered record of every committed face turn for Auto-Solve. */
  public readonly moveHistory: CubeMoveNotation[] = [];

  private readonly materials: LabMaterialLibrary;
  private puzzleType: PuzzleType;
  private ownedGeometries: THREE.BufferGeometry[] = [];
  private activeLayerCubies: CubieUnit[] = [];
  private activeMoveSpec: CubeMoveSpec | null = null;

  // Reusable scratch vectors for zero-allocation bounds measurement
  private readonly _cornerA = new THREE.Vector3();
  private readonly _cornerB = new THREE.Vector3();

  constructor(
    materials: LabMaterialLibrary,
    initialType: PuzzleType = 'classic',
  ) {
    super();
    this.name = 'RubiksCube';
    this.materials = materials;
    this.puzzleType = initialType;

    this.totalSize = LAB_DIMENSIONS.CUBE_SIZE;
    this.cubieSpacing = this.totalSize / 3;

    this.pivotGroup = new THREE.Group();
    this.pivotGroup.name = 'FaceRotationPivot';
    this.add(this.pivotGroup);

    this.rebuildPuzzle(initialType);
  }

  getPuzzleType(): PuzzleType {
    return this.puzzleType;
  }

  /**
   * Switches between `'classic'` and `'mirror'` puzzles cleanly:
   * disposes previous cubie geometries, clears move history, and constructs a fresh solved puzzle.
   */
  setPuzzleType(type: PuzzleType): void {
    this.rebuildPuzzle(type);
  }

  private clearExistingCubies(): void {
    if (this.activeMoveSpec) {
      this.activeMoveSpec = null;
      this.activeLayerCubies = [];
    }
    this.pivotGroup.rotation.set(0, 0, 0);
    this.pivotGroup.position.set(0, 0, 0);
    this.pivotGroup.clear();

    for (const unit of this.cubies) {
      unit.group.removeFromParent();
    }
    this.cubies.length = 0;

    for (const geo of this.ownedGeometries) {
      geo.dispose();
    }
    this.ownedGeometries = [];
    this.moveHistory.length = 0;
  }

  private trackGeometry<T extends THREE.BufferGeometry>(geo: T): T {
    this.ownedGeometries.push(geo);
    return geo;
  }

  private rebuildPuzzle(type: PuzzleType): void {
    this.clearExistingCubies();
    this.puzzleType = type;

    if (type === 'classic') {
      this.buildClassicCubies();
    } else {
      this.buildMirrorCubies();
    }
    this.updateMatrixWorld(true);
  }

  private buildClassicCubies(): void {
    const cubieSize = this.cubieSpacing * 0.962;
    const tileSize = cubieSize * 0.81;
    const tileThickness = 0.0022;
    const tileOffset = cubieSize / 2 + tileThickness * 0.35;
    const tileHalfDepth = tileThickness * 0.5 + tileThickness * 0.42;
    const tileProtrusion = tileOffset + tileHalfDepth - cubieSize / 2;

    const bodyGeo = this.trackGeometry(
      new RoundedBoxGeometry(
        cubieSize,
        cubieSize,
        cubieSize,
        3,
        cubieSize * 0.11,
      ),
    );
    const tileGeo = this.trackGeometry(
      createRoundedRectTileGeometry(
        tileSize,
        tileSize,
        tileSize * 0.16,
        tileThickness,
      ),
    );

    const layers: FaceLayer[] = [-1, 0, 1];
    for (const x of layers) {
      for (const y of layers) {
        for (const z of layers) {
          const cubieGroup = new THREE.Group();
          cubieGroup.name = `Cubie_${x}_${y}_${z}`;
          const solvedPos = new THREE.Vector3(
            x * this.cubieSpacing,
            y * this.cubieSpacing,
            z * this.cubieSpacing,
          );
          cubieGroup.position.copy(solvedPos);

          const body = new THREE.Mesh(bodyGeo, this.materials.cubeCore);
          body.castShadow = true;
          body.receiveShadow = true;
          cubieGroup.add(body);

          // Standard Western color scheme:
          // +Y White, -Y Yellow, +X Red, -X Orange, +Z Green, -Z Blue
          if (y === 1) {
            this.addTile(
              cubieGroup,
              tileGeo,
              this.materials.cubeTiles.white,
              new THREE.Vector3(0, tileOffset, 0),
              new THREE.Euler(-Math.PI / 2, 0, 0),
            );
          }
          if (y === -1) {
            this.addTile(
              cubieGroup,
              tileGeo,
              this.materials.cubeTiles.yellow,
              new THREE.Vector3(0, -tileOffset, 0),
              new THREE.Euler(Math.PI / 2, 0, 0),
            );
          }
          if (x === 1) {
            this.addTile(
              cubieGroup,
              tileGeo,
              this.materials.cubeTiles.red,
              new THREE.Vector3(tileOffset, 0, 0),
              new THREE.Euler(0, Math.PI / 2, 0),
            );
          }
          if (x === -1) {
            this.addTile(
              cubieGroup,
              tileGeo,
              this.materials.cubeTiles.orange,
              new THREE.Vector3(-tileOffset, 0, 0),
              new THREE.Euler(0, -Math.PI / 2, 0),
            );
          }
          if (z === 1) {
            this.addTile(
              cubieGroup,
              tileGeo,
              this.materials.cubeTiles.green,
              new THREE.Vector3(0, 0, tileOffset),
              new THREE.Euler(0, 0, 0),
            );
          }
          if (z === -1) {
            this.addTile(
              cubieGroup,
              tileGeo,
              this.materials.cubeTiles.blue,
              new THREE.Vector3(0, 0, -tileOffset),
              new THREE.Euler(0, Math.PI, 0),
            );
          }

          const half = cubieSize / 2;
          const localMin = new THREE.Vector3(
            -half - (x === -1 ? tileProtrusion : 0),
            -half - (y === -1 ? tileProtrusion : 0),
            -half - (z === -1 ? tileProtrusion : 0),
          );
          const localMax = new THREE.Vector3(
            half + (x === 1 ? tileProtrusion : 0),
            half + (y === 1 ? tileProtrusion : 0),
            half + (z === 1 ? tileProtrusion : 0),
          );

          this.add(cubieGroup);
          this.cubies.push({
            group: cubieGroup,
            coord: {x, y, z},
            solvedCoord: {x, y, z},
            solvedPos,
            localMin,
            localMax,
          });
        }
      }
    }
  }

  private buildMirrorCubies(): void {
    const unit = this.cubieSpacing;
    const tileThickness = MIRROR_TILE_THICKNESS;
    const tileCenterBump = tileThickness * 0.25;
    const tileHalfDepth = tileThickness * 0.5 + tileThickness * 0.42;
    const tileProtrusion = tileCenterBump + tileHalfDepth;

    const layers: FaceLayer[] = [-1, 0, 1];
    for (const x of layers) {
      for (const y of layers) {
        for (const z of layers) {
          const sx = MIRROR_LAYER_UNITS.x[x] * unit;
          const sy = MIRROR_LAYER_UNITS.y[y] * unit;
          const sz = MIRROR_LAYER_UNITS.z[z] * unit;

          const bx = sx - MIRROR_CUBIE_GAP;
          const by = sy - MIRROR_CUBIE_GAP;
          const bz = sz - MIRROR_CUBIE_GAP;
          const minDim = Math.min(bx, by, bz);
          const cornerRadius = Math.min(0.0042, minDim * 0.11);

          const cubieGroup = new THREE.Group();
          cubieGroup.name = `MirrorCubie_${x}_${y}_${z}`;

          const solvedPos = new THREE.Vector3(
            getMirrorLayerCenterUnit('x', x) * unit,
            getMirrorLayerCenterUnit('y', y) * unit,
            getMirrorLayerCenterUnit('z', z) * unit,
          );
          cubieGroup.position.copy(solvedPos);

          const bodyGeo = this.trackGeometry(
            new RoundedBoxGeometry(bx, by, bz, 3, cornerRadius),
          );
          const body = new THREE.Mesh(bodyGeo, this.materials.mirrorCubeCore);
          body.castShadow = true;
          body.receiveShadow = true;
          cubieGroup.add(body);

          // Brushed silver-chrome metallic tiles on all outward faces
          if (y === 1 || y === -1) {
            const tw = Math.max(0.012, bx - MIRROR_TILE_INSET);
            const th = Math.max(0.012, bz - MIRROR_TILE_INSET);
            const tileGeo = this.trackGeometry(
              createRoundedRectTileGeometry(
                tw,
                th,
                Math.min(0.0055, Math.min(tw, th) * 0.16),
                tileThickness,
              ),
            );
            this.addTile(
              cubieGroup,
              tileGeo,
              this.materials.mirrorCubeTiles.yAxis,
              new THREE.Vector3(0, y * (by / 2 + tileCenterBump), 0),
              new THREE.Euler(y === 1 ? -Math.PI / 2 : Math.PI / 2, 0, 0),
            );
          }

          if (x === 1 || x === -1) {
            const tw = Math.max(0.012, bz - MIRROR_TILE_INSET);
            const th = Math.max(0.012, by - MIRROR_TILE_INSET);
            const tileGeo = this.trackGeometry(
              createRoundedRectTileGeometry(
                tw,
                th,
                Math.min(0.0055, Math.min(tw, th) * 0.16),
                tileThickness,
              ),
            );
            this.addTile(
              cubieGroup,
              tileGeo,
              this.materials.mirrorCubeTiles.xAxis,
              new THREE.Vector3(x * (bx / 2 + tileCenterBump), 0, 0),
              new THREE.Euler(0, x === 1 ? Math.PI / 2 : -Math.PI / 2, 0),
            );
          }

          if (z === 1 || z === -1) {
            const tw = Math.max(0.012, bx - MIRROR_TILE_INSET);
            const th = Math.max(0.012, by - MIRROR_TILE_INSET);
            const tileGeo = this.trackGeometry(
              createRoundedRectTileGeometry(
                tw,
                th,
                Math.min(0.0055, Math.min(tw, th) * 0.16),
                tileThickness,
              ),
            );
            this.addTile(
              cubieGroup,
              tileGeo,
              this.materials.mirrorCubeTiles.zAxis,
              new THREE.Vector3(0, 0, z * (bz / 2 + tileCenterBump)),
              new THREE.Euler(0, z === 1 ? 0 : Math.PI, 0),
            );
          }

          const localMin = new THREE.Vector3(
            -bx / 2 - (x === -1 ? tileProtrusion : 0),
            -by / 2 - (y === -1 ? tileProtrusion : 0),
            -bz / 2 - (z === -1 ? tileProtrusion : 0),
          );
          const localMax = new THREE.Vector3(
            bx / 2 + (x === 1 ? tileProtrusion : 0),
            by / 2 + (y === 1 ? tileProtrusion : 0),
            bz / 2 + (z === 1 ? tileProtrusion : 0),
          );

          this.add(cubieGroup);
          this.cubies.push({
            group: cubieGroup,
            coord: {x, y, z},
            solvedCoord: {x, y, z},
            solvedPos,
            localMin,
            localMax,
          });
        }
      }
    }
  }

  private addTile(
    parent: THREE.Group,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    position: THREE.Vector3,
    rotation: THREE.Euler,
  ): void {
    const tile = new THREE.Mesh(geometry, material);
    tile.position.copy(position);
    tile.rotation.copy(rotation);
    tile.castShadow = false;
    tile.receiveShadow = true;
    parent.add(tile);
  }

  /**
   * Identifies the 9 cubies belonging to the requested layer strictly by their
   * exact discrete integer layer coordinate (`-1`, `0`, `1`).
   */
  getLayerCubies(axis: FaceAxis, layer: FaceLayer): CubieUnit[] {
    return this.cubies.filter((unit) => unit.coord[axis] === layer);
  }

  /**
   * Measures exact outer surface extents of the puzzle and every gripped 3-cubie strip
   * in cube-local space so robotic grippers sit flush on protruding or recessed blocks.
   * For `'classic'`, returns exact symmetric `CUBE_OUTER_HALF` to keep Classic 3x3 bit-identical.
   */
  getBoundsSnapshot(): PuzzleBoundsSnapshot {
    if (this.puzzleType === 'classic') {
      const h = LAB_DIMENSIONS.CUBE_OUTER_HALF;
      const symmetricFace: FaceStripMetrics = {
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
          L: {...symmetricFace},
          R: {...symmetricFace},
          U: {...symmetricFace},
          D: {...symmetricFace},
          F: {...symmetricFace},
          B: {...symmetricFace},
          U_FB: {...symmetricFace},
        },
      };
    }

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let maxSpinRadius = 0;

    const initFace = (): FaceStripMetrics => ({
      stripNormal: 0,
      faceNormal: 0,
      jawPos: 0,
      jawNeg: 0,
    });
    const faces = {
      L: initFace(),
      R: initFace(),
      U: initFace(),
      D: initFace(),
      F: initFace(),
      B: initFace(),
      U_FB: initFace(),
    };

    const eps = MIRROR_FLUSH_EPS;

    for (const unit of this.cubies) {
      // Exact rotated AABB of this cubie in cube-local space (quaternion is exact 90-deg orthogonal)
      this._cornerA
        .copy(unit.localMin)
        .applyQuaternion(unit.group.quaternion)
        .add(unit.group.position);
      this._cornerB
        .copy(unit.localMax)
        .applyQuaternion(unit.group.quaternion)
        .add(unit.group.position);

      const cMinX = Math.min(this._cornerA.x, this._cornerB.x);
      const cMaxX = Math.max(this._cornerA.x, this._cornerB.x);
      const cMinY = Math.min(this._cornerA.y, this._cornerB.y);
      const cMaxY = Math.max(this._cornerA.y, this._cornerB.y);
      const cMinZ = Math.min(this._cornerA.z, this._cornerB.z);
      const cMaxZ = Math.max(this._cornerA.z, this._cornerB.z);

      if (cMinX < minX) minX = cMinX;
      if (cMaxX > maxX) maxX = cMaxX;
      if (cMinY < minY) minY = cMinY;
      if (cMaxY > maxY) maxY = cMaxY;
      if (cMinZ < minZ) minZ = cMinZ;
      if (cMaxZ > maxZ) maxZ = cMaxZ;

      const absX = Math.max(Math.abs(cMinX), Math.abs(cMaxX));
      const absZ = Math.max(Math.abs(cMinZ), Math.abs(cMaxZ));
      const spinR = Math.hypot(absX, absZ);
      if (spinR > maxSpinRadius) maxSpinRadius = spinR;

      const {x, y, z} = unit.coord;

      // L (-X face)
      if (x === -1) {
        faces.L.faceNormal = Math.max(faces.L.faceNormal, -cMinX + eps);
        if (y === 0) {
          faces.L.stripNormal = Math.max(faces.L.stripNormal, -cMinX + eps);
          faces.L.jawPos = Math.max(faces.L.jawPos, cMaxZ + eps);
          faces.L.jawNeg = Math.max(faces.L.jawNeg, -cMinZ + eps);
        }
      }

      // R (+X face)
      if (x === 1) {
        faces.R.faceNormal = Math.max(faces.R.faceNormal, cMaxX + eps);
        if (y === 0) {
          faces.R.stripNormal = Math.max(faces.R.stripNormal, cMaxX + eps);
          faces.R.jawPos = Math.max(faces.R.jawPos, cMaxZ + eps);
          faces.R.jawNeg = Math.max(faces.R.jawNeg, -cMinZ + eps);
        }
      }

      // U (+Y face): standard strip along Z (x === 0) and F/B stabilizing strip along X (z === 0)
      if (y === 1) {
        faces.U.faceNormal = Math.max(faces.U.faceNormal, cMaxY + eps);
        faces.U_FB.faceNormal = Math.max(faces.U_FB.faceNormal, cMaxY + eps);
        if (x === 0) {
          faces.U.stripNormal = Math.max(faces.U.stripNormal, cMaxY + eps);
          faces.U.jawPos = Math.max(faces.U.jawPos, cMaxZ + eps);
          faces.U.jawNeg = Math.max(faces.U.jawNeg, -cMinZ + eps);
        }
        if (z === 0) {
          faces.U_FB.stripNormal = Math.max(
            faces.U_FB.stripNormal,
            cMaxY + eps,
          );
          faces.U_FB.jawPos = Math.max(faces.U_FB.jawPos, cMaxX + eps);
          faces.U_FB.jawNeg = Math.max(faces.U_FB.jawNeg, -cMinX + eps);
        }
      }

      // D (-Y face, flipped upside-down to +Y during D moves): strip along Z (x === 0)
      if (y === -1) {
        faces.D.faceNormal = Math.max(faces.D.faceNormal, -cMinY + eps);
        if (x === 0) {
          faces.D.stripNormal = Math.max(faces.D.stripNormal, -cMinY + eps);
          faces.D.jawPos = Math.max(faces.D.jawPos, cMaxZ + eps);
          faces.D.jawNeg = Math.max(faces.D.jawNeg, -cMinZ + eps);
        }
      }

      // F (+Z face, presented to Left arm via yaw -PI/2): strip along X (y === 0)
      if (z === 1) {
        faces.F.faceNormal = Math.max(faces.F.faceNormal, cMaxZ + eps);
        if (y === 0) {
          faces.F.stripNormal = Math.max(faces.F.stripNormal, cMaxZ + eps);
          faces.F.jawPos = Math.max(faces.F.jawPos, cMaxX + eps);
          faces.F.jawNeg = Math.max(faces.F.jawNeg, -cMinX + eps);
        }
      }

      // B (-Z face, presented to Left arm via yaw +PI/2): strip along X (y === 0)
      if (z === -1) {
        faces.B.faceNormal = Math.max(faces.B.faceNormal, -cMinZ + eps);
        if (y === 0) {
          faces.B.stripNormal = Math.max(faces.B.stripNormal, -cMinZ + eps);
          faces.B.jawPos = Math.max(faces.B.jawPos, cMaxX + eps);
          faces.B.jawNeg = Math.max(faces.B.jawNeg, -cMinX + eps);
        }
      }
    }

    return {
      puzzleType: 'mirror',
      minX: minX - eps,
      maxX: maxX + eps,
      minY: minY - eps,
      maxY: maxY + eps,
      minZ: minZ - eps,
      maxZ: maxZ + eps,
      maxSpinRadius: maxSpinRadius + eps,
      faces,
    };
  }

  /**
   * Begins an animated 90-degree face turn for standard cube notation (`U`, `R'`, etc.).
   * Attaches the 9 target layer cubies to `pivotGroup`.
   */
  beginMove(notation: CubeMoveNotation): CubeMoveSpec {
    if (this.activeMoveSpec) {
      this.commitActiveMove();
    }
    const spec = getMoveSpec(notation);
    this.activeMoveSpec = spec;
    this.beginFaceTurn(spec.axis, spec.layer);
    return spec;
  }

  /**
   * Updates the active pivot rotation smoothly using eased progress `t ∈ [0, 1]`.
   */
  setActiveMoveProgress(easedProgress: number): void {
    if (!this.activeMoveSpec) return;
    this.pivotGroup.rotation.set(0, 0, 0);
    this.pivotGroup.rotation[this.activeMoveSpec.axis] =
      this.activeMoveSpec.angleRad * easedProgress;
  }

  /**
   * Commits the active face turn, snaps all moved cubies to exact integer grid
   * coordinates, exact 90-degree orthogonal quaternions, and zero-drift local positions,
   * and appends to `moveHistory`.
   */
  commitActiveMove(recordHistory = true): void {
    if (!this.activeMoveSpec) return;
    const spec = this.activeMoveSpec;
    this.activeMoveSpec = null;
    this.commitFaceTurn(spec.axis, spec.quarterTurns);
    if (recordHistory) {
      this.moveHistory.push(spec.notation);
    }
  }

  /** Convenience helper for instant deterministic execution (used in tests/solvers). */
  applyMoveInstant(notation: CubeMoveNotation, recordHistory = true): void {
    this.beginMove(notation);
    this.setActiveMoveProgress(1);
    this.commitActiveMove(recordHistory);
  }

  getMoveHistory(): readonly CubeMoveNotation[] {
    return this.moveHistory;
  }

  /** Clears the recorded move history once an Auto-Solve completes cleanly. */
  clearMoveHistory(): void {
    this.moveHistory.length = 0;
  }

  /**
   * Mathematically verifies that all 27 cubies sit at their exact solved integer grid
   * coordinates, exact solved local positions, and exact solved orientations.
   */
  isSolved(): boolean {
    const identity = new THREE.Quaternion();
    const normal = new THREE.Vector3();
    const expected = new THREE.Vector3();

    for (const unit of this.cubies) {
      const {x, y, z} = unit.solvedCoord;
      // 1. Exact integer grid slot & zero-drift local position
      if (unit.coord.x !== x || unit.coord.y !== y || unit.coord.z !== z) {
        return false;
      }
      if (unit.group.position.distanceTo(unit.solvedPos) > 1e-6) {
        return false;
      }

      // 2. Orientation check: corners & edges must match exact identity;
      //    face centers (|x|+|y|+|z| === 1) must preserve their outward face normal.
      const nonZeroAxes = Math.abs(x) + Math.abs(y) + Math.abs(z);
      if (nonZeroAxes >= 2) {
        if (unit.group.quaternion.angleTo(identity) > 1e-4) {
          return false;
        }
      } else if (nonZeroAxes === 1) {
        expected.set(x, y, z);
        normal.copy(expected).applyQuaternion(unit.group.quaternion);
        if (normal.dot(expected) < 0.9999) {
          return false;
        }
      }
    }
    return true;
  }

  /**
   * Attaches the 9 cubies of `(axis, layer)` to `pivotGroup` so callers can
   * smoothly animate `pivotGroup.rotation[axis]` from `0` to `±Math.PI / 2`.
   */
  beginFaceTurn(axis: FaceAxis, layer: FaceLayer): THREE.Group {
    this.pivotGroup.rotation.set(0, 0, 0);
    this.pivotGroup.position.set(0, 0, 0);
    this.updateMatrixWorld(true);

    this.activeLayerCubies = this.getLayerCubies(axis, layer);
    for (const unit of this.activeLayerCubies) {
      this.pivotGroup.attach(unit.group);
    }
    return this.pivotGroup;
  }

  /**
   * Commits a finished face turn back into the cube root and enforces strict
   * zero-drift snapping on discrete grid coordinates (-1, 0, 1), exact
   * 90-degree orthogonal quaternions, and exact recomputed local positions
   * (`solvedPos.applyQuaternion(snappedQuat)`).
   */
  commitFaceTurn(axis: FaceAxis, quarterTurns: number): void {
    const angle = quarterTurns * (Math.PI / 2);
    this.pivotGroup.rotation.set(0, 0, 0);
    this.pivotGroup.rotation[axis] = angle;
    this.updateMatrixWorld(true);

    for (const unit of this.activeLayerCubies) {
      this.attach(unit.group);

      // 1. Rotate discrete integer coordinates cleanly (works identically for Classic & Mirror)
      rotateCoordExact90(unit.coord, axis, quarterTurns);

      // 2. Snap quaternion to exact orthogonal 90-degree matrix (zero drift!)
      snapQuaternionToExact90(unit.group.quaternion);
      unit.group.rotation.setFromQuaternion(unit.group.quaternion);

      // 3. Recompute exact local position directly from solvedPos * snappedQuat (0.000mm drift!)
      unit.group.position
        .copy(unit.solvedPos)
        .applyQuaternion(unit.group.quaternion);
    }

    this.pivotGroup.rotation.set(0, 0, 0);
    this.activeLayerCubies = [];
    this.updateMatrixWorld(true);
  }

  dispose(): void {
    this.clearExistingCubies();
  }
}
