import * as THREE from 'three';
import {RoundedBoxGeometry} from 'three/addons/geometries/RoundedBoxGeometry.js';

import {LAB_DIMENSIONS} from './kinematics';
import type {LabMaterialLibrary} from './materials';
import type {CubieCoord, FaceAxis, FaceLayer} from './types';

export interface CubieUnit {
  group: THREE.Group;
  coord: CubieCoord;
}

/**
 * Creates a rounded-square extruded sticker tile geometry for authentic
 * glossy Rubik's Cube face caps.
 */
function createRoundedTileGeometry(
  size: number,
  cornerRadius: number,
  thickness: number,
): THREE.ExtrudeGeometry {
  const half = size / 2;
  const r = Math.min(cornerRadius, half * 0.45);
  const shape = new THREE.Shape();

  shape.moveTo(-half + r, -half);
  shape.lineTo(half - r, -half);
  shape.quadraticCurveTo(half, -half, half, -half + r);
  shape.lineTo(half, half - r);
  shape.quadraticCurveTo(half, half, half - r, half);
  shape.lineTo(-half + r, half);
  shape.quadraticCurveTo(-half, half, -half, half - r);
  shape.lineTo(-half, -half + r);
  shape.quadraticCurveTo(-half, -half, -half + r, -half);

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: true,
    bevelThickness: thickness * 0.45,
    bevelSize: thickness * 0.45,
    bevelSegments: 2,
    curveSegments: 6,
  });
  geo.center();
  return geo;
}

/**
 * Modular 3x3x3 Rubik's Cube constructed from 27 individual rounded cubies
 * with a clean internal pivot-rotation structure ready for Parts 2 & 3 face turns.
 */
export class RubiksCube extends THREE.Group {
  public readonly cubies: CubieUnit[] = [];
  public readonly pivotGroup: THREE.Group;
  public readonly cubieSpacing: number;
  public readonly totalSize: number;

  private readonly cubieBodyGeometry: THREE.BufferGeometry;
  private readonly tileGeometry: THREE.BufferGeometry;
  private activeLayerCubies: CubieUnit[] = [];

  constructor(materials: LabMaterialLibrary) {
    super();
    this.name = 'RubiksCube';

    this.totalSize = LAB_DIMENSIONS.CUBE_SIZE;
    this.cubieSpacing = this.totalSize / 3;
    const cubieSize = this.cubieSpacing * 0.962;
    const tileSize = cubieSize * 0.81;
    const tileThickness = 0.0022;
    const tileOffset = cubieSize / 2 + tileThickness * 0.35;

    this.cubieBodyGeometry = new RoundedBoxGeometry(
      cubieSize,
      cubieSize,
      cubieSize,
      3,
      cubieSize * 0.11,
    );
    this.tileGeometry = createRoundedTileGeometry(
      tileSize,
      tileSize * 0.16,
      tileThickness,
    );

    this.pivotGroup = new THREE.Group();
    this.pivotGroup.name = 'FaceRotationPivot';
    this.add(this.pivotGroup);

    const layers: FaceLayer[] = [-1, 0, 1];
    for (const x of layers) {
      for (const y of layers) {
        for (const z of layers) {
          const cubieGroup = new THREE.Group();
          cubieGroup.name = `Cubie_${x}_${y}_${z}`;
          cubieGroup.position.set(
            x * this.cubieSpacing,
            y * this.cubieSpacing,
            z * this.cubieSpacing,
          );

          const body = new THREE.Mesh(
            this.cubieBodyGeometry,
            materials.cubeCore,
          );
          body.castShadow = true;
          body.receiveShadow = true;
          cubieGroup.add(body);

          // Standard Western color scheme:
          // +Y White, -Y Yellow, +X Red, -X Orange, +Z Green, -Z Blue
          if (y === 1) {
            this.addTile(
              cubieGroup,
              materials.cubeTiles.white,
              new THREE.Vector3(0, tileOffset, 0),
              new THREE.Euler(-Math.PI / 2, 0, 0),
            );
          }
          if (y === -1) {
            this.addTile(
              cubieGroup,
              materials.cubeTiles.yellow,
              new THREE.Vector3(0, -tileOffset, 0),
              new THREE.Euler(Math.PI / 2, 0, 0),
            );
          }
          if (x === 1) {
            this.addTile(
              cubieGroup,
              materials.cubeTiles.red,
              new THREE.Vector3(tileOffset, 0, 0),
              new THREE.Euler(0, Math.PI / 2, 0),
            );
          }
          if (x === -1) {
            this.addTile(
              cubieGroup,
              materials.cubeTiles.orange,
              new THREE.Vector3(-tileOffset, 0, 0),
              new THREE.Euler(0, -Math.PI / 2, 0),
            );
          }
          if (z === 1) {
            this.addTile(
              cubieGroup,
              materials.cubeTiles.green,
              new THREE.Vector3(0, 0, tileOffset),
              new THREE.Euler(0, 0, 0),
            );
          }
          if (z === -1) {
            this.addTile(
              cubieGroup,
              materials.cubeTiles.blue,
              new THREE.Vector3(0, 0, -tileOffset),
              new THREE.Euler(0, Math.PI, 0),
            );
          }

          this.add(cubieGroup);
          this.cubies.push({
            group: cubieGroup,
            coord: {x, y, z},
          });
        }
      }
    }
  }

  private addTile(
    parent: THREE.Group,
    material: THREE.Material,
    position: THREE.Vector3,
    rotation: THREE.Euler,
  ): void {
    const tile = new THREE.Mesh(this.tileGeometry, material);
    tile.position.copy(position);
    tile.rotation.copy(rotation);
    tile.castShadow = false;
    tile.receiveShadow = true;
    parent.add(tile);
  }

  /**
   * Returns the 9 cubies currently occupying a specific face layer.
   * Ready for Part 2 (Scramble) & Part 3 (Auto-Solve) 90-degree face turns.
   */
  getLayerCubies(axis: FaceAxis, layer: FaceLayer): CubieUnit[] {
    return this.cubies.filter((unit) => unit.coord[axis] === layer);
  }

  /**
   * Attaches the 9 cubies of `(axis, layer)` to `pivotGroup` so callers can
   * smoothly animate `pivotGroup.rotation[axis]` from `0` to `±Math.PI / 2`.
   */
  beginFaceTurn(axis: FaceAxis, layer: FaceLayer): THREE.Group {
    this.pivotGroup.rotation.set(0, 0, 0);
    this.pivotGroup.position.set(0, 0, 0);
    this.pivotGroup.updateMatrixWorld(true);

    this.activeLayerCubies = this.getLayerCubies(axis, layer);
    for (const unit of this.activeLayerCubies) {
      this.pivotGroup.attach(unit.group);
    }
    return this.pivotGroup;
  }

  /**
   * Commits a finished face turn back into the cube root and snaps all cubie
   * positions & orientations to exact 90-degree lattice increments to eliminate
   * floating-point drift over long Scramble/Auto-Solve sequences.
   */
  commitFaceTurn(axis: FaceAxis, quarterTurns: number): void {
    const angle = quarterTurns * (Math.PI / 2);
    this.pivotGroup.rotation[axis] = angle;
    this.pivotGroup.updateMatrixWorld(true);

    for (const unit of this.activeLayerCubies) {
      this.attach(unit.group);

      // Snap logical grid coordinates & exact local position
      const nx = Math.round(unit.group.position.x / this.cubieSpacing) as FaceLayer;
      const ny = Math.round(unit.group.position.y / this.cubieSpacing) as FaceLayer;
      const nz = Math.round(unit.group.position.z / this.cubieSpacing) as FaceLayer;
      unit.coord.x = nx;
      unit.coord.y = ny;
      unit.coord.z = nz;
      unit.group.position.set(
        nx * this.cubieSpacing,
        ny * this.cubieSpacing,
        nz * this.cubieSpacing,
      );

      // Snap Euler angles to exact 90° multiples
      const e = unit.group.rotation;
      const snap = (rad: number) =>
        Math.round(rad / (Math.PI / 2)) * (Math.PI / 2);
      unit.group.rotation.set(snap(e.x), snap(e.y), snap(e.z));
    }

    this.pivotGroup.rotation.set(0, 0, 0);
    this.activeLayerCubies = [];
  }

  dispose(): void {
    this.cubieBodyGeometry.dispose();
    this.tileGeometry.dispose();
  }
}
