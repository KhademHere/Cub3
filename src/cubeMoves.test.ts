import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import {
  MOVE_SPECS,
  generateScrambleSequence,
  getInverseMove,
  getMoveSpec,
  snapQuaternionToExact90,
  type CubeFace,
  type CubeMoveNotation,
} from './cubeMoves';
import type {LabMaterialLibrary} from './materials';
import {RubiksCube} from './RubiksCube';

const ALL_CUBE_MOVES = Object.keys(MOVE_SPECS) as CubeMoveNotation[];

/** Minimal headless material stub so RubiksCube runs cleanly in node:test without DOM canvas. */
function createHeadlessMaterials(): LabMaterialLibrary {
  const std = new THREE.MeshStandardMaterial();
  const phys = new THREE.MeshPhysicalMaterial();
  const basic = new THREE.MeshBasicMaterial();
  return {
    tableTop: std,
    tableEdge: std,
    tableFrame: std,
    padRecess: std,
    padRing: std,
    labFloor: std,
    gunmetal: std,
    brushedAluminum: phys,
    darkAnodized: std,
    machinedSteel: phys,
    rubberGrip: std,
    cableSheath: std,
    cubeCore: std,
    cubeTiles: {
      white: phys,
      yellow: phys,
      red: phys,
      orange: phys,
      blue: phys,
      green: phys,
    },
    contactShadow: basic,
    dispose: () => {
      std.dispose();
      phys.dispose();
      basic.dispose();
    },
  };
}

function makeSeededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

test('all 12 standard cube moves have exact inverses and consistent axes', () => {
  assert.equal(ALL_CUBE_MOVES.length, 12);
  for (const notation of ALL_CUBE_MOVES) {
    const spec = getMoveSpec(notation);
    const inv = getInverseMove(notation);
    const invSpec = MOVE_SPECS[inv];

    assert.equal(spec.face, invSpec.face);
    assert.equal(spec.axis, invSpec.axis);
    assert.equal(spec.layer, invSpec.layer);
    assert.equal(spec.quarterTurns, -invSpec.quarterTurns);
    assert.equal(getInverseMove(inv), notation);
  }
});

test('generateScrambleSequence produces balanced 14-16 move sequences across 50 seeds', () => {
  const opposite: Record<CubeFace, CubeFace> = {
    U: 'D',
    D: 'U',
    L: 'R',
    R: 'L',
    F: 'B',
    B: 'F',
  };

  for (let seed = 1; seed <= 50; seed++) {
    const seq = generateScrambleSequence(makeSeededRng(seed));
    assert.ok(
      seq.length >= 14 && seq.length <= 16,
      `Seed ${seed}: expected 14-16 moves, got ${seq.length}`,
    );

    const facesSeen = new Set<CubeFace>();
    for (let i = 0; i < seq.length; i++) {
      const face = getMoveSpec(seq[i]).face;
      facesSeen.add(face);
      if (i > 0) {
        const prevFace = getMoveSpec(seq[i - 1]).face;
        assert.notEqual(
          face,
          prevFace,
          `Seed ${seed}: consecutive same face ${face} at index ${i}`,
        );
      }
      if (i > 1) {
        const prevFace = getMoveSpec(seq[i - 1]).face;
        const prevPrevFace = getMoveSpec(seq[i - 2]).face;
        assert.ok(
          !(face === prevPrevFace && prevFace === opposite[face]),
          `Seed ${seed}: redundant ABA sequence ${seq[i - 2]} ${seq[i - 1]} ${seq[i]}`,
        );
      }
    }

    assert.equal(
      facesSeen.size,
      6,
      `Seed ${seed}: expected all 6 faces distributed in scramble`,
    );
  }
});

test('snapQuaternionToExact90 locks noisy orientations to exact orthogonal 90-degree matrices', () => {
  const m = new THREE.Matrix4();
  const baseEuler = new THREE.Euler(Math.PI / 2, -Math.PI / 2, Math.PI);
  const noisy = new THREE.Quaternion().setFromEuler(baseEuler);
  const jitter = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(0.03, -0.025, 0.018),
  );
  noisy.multiply(jitter).normalize();

  snapQuaternionToExact90(noisy);
  m.makeRotationFromQuaternion(noisy);

  const e = m.elements;
  const rotEntries = [e[0], e[1], e[2], e[4], e[5], e[6], e[8], e[9], e[10]];
  for (const val of rotEntries) {
    assert.ok(
      Math.abs(val - Math.round(val)) < 1e-6,
      `Expected exact integer basis entry (-1, 0, 1), got ${val}`,
    );
  }
  assert.ok(Math.abs(m.determinant() - 1) < 1e-6);
});

test('RubiksCube executes 2 consecutive scrambles (32 moves) with zero drift and exact inverse solve', () => {
  const materials = createHeadlessMaterials();
  const cube = new RubiksCube(materials);
  assert.equal(cube.cubies.length, 27);

  // Snapshot initial solved coordinates & identity quaternions
  const initialCoords = cube.cubies.map((u) => ({...u.coord}));

  const scramble1 = generateScrambleSequence(makeSeededRng(101));
  const scramble2 = generateScrambleSequence(makeSeededRng(202));
  const allMoves: CubeMoveNotation[] = [...scramble1, ...scramble2];
  assert.ok(allMoves.length >= 28 && allMoves.length <= 32);

  // Run every move through the exact animated pivot pipeline (partial progress + commit)
  for (const move of allMoves) {
    cube.beginMove(move);
    cube.setActiveMoveProgress(0.25);
    cube.setActiveMoveProgress(0.75);
    cube.setActiveMoveProgress(1.0);
    cube.commitActiveMove(true);
  }

  assert.equal(cube.getMoveHistory().length, allMoves.length);
  assert.deepEqual([...cube.getMoveHistory()], allMoves);

  // Verify zero positional drift & exact 90-degree orthogonal quaternions across all 27 cubies
  const occupied = new Set<string>();
  const mat = new THREE.Matrix4();
  for (const unit of cube.cubies) {
    assert.equal(unit.group.parent, cube);

    const {x, y, z} = unit.coord;
    assert.ok(x === -1 || x === 0 || x === 1);
    assert.ok(y === -1 || y === 0 || y === 1);
    assert.ok(z === -1 || z === 0 || z === 1);
    occupied.add(`${x},${y},${z}`);

    assert.ok(Math.abs(unit.group.position.x - x * cube.cubieSpacing) < 1e-12);
    assert.ok(Math.abs(unit.group.position.y - y * cube.cubieSpacing) < 1e-12);
    assert.ok(Math.abs(unit.group.position.z - z * cube.cubieSpacing) < 1e-12);

    mat.makeRotationFromQuaternion(unit.group.quaternion);
    const e = mat.elements;
    for (const val of [e[0], e[1], e[2], e[4], e[5], e[6], e[8], e[9], e[10]]) {
      assert.ok(
        Math.abs(val - Math.round(val)) < 1e-6,
        `Non-orthogonal rotation entry after 30+ moves: ${val}`,
      );
    }
  }
  assert.equal(occupied.size, 27, 'All 27 cubies must occupy 27 unique grid slots');

  // Verify Part 3 Auto-Solve readiness: reversed inverse of moveHistory restores exact solved cube
  const solveSequence = [...cube.getMoveHistory()].reverse().map(getInverseMove);
  for (const invMove of solveSequence) {
    cube.beginMove(invMove);
    cube.setActiveMoveProgress(1);
    cube.commitActiveMove(false);
  }

  const identity = new THREE.Quaternion();
  for (let i = 0; i < cube.cubies.length; i++) {
    const unit = cube.cubies[i];
    const orig = initialCoords[i];
    assert.deepEqual(unit.coord, orig, `Cubie ${i} did not return to original slot`);
    assert.ok(
      unit.group.quaternion.angleTo(identity) < 1e-5,
      `Cubie ${i} quaternion did not return to exact identity`,
    );
  }

  cube.dispose();
  materials.dispose();
});
