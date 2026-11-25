import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import {
  ContinuousScrambleGenerator,
  DOMINO_MOVES,
  MOVE_SPECS,
  computeOptimizedSolution,
  generateScrambleSequence,
  getInverseMove,
  getMoveSpec,
  optimizeMoveSequence,
  snapQuaternionToExact90,
  type CubeFace,
  type CubeMoveNotation,
} from './cubeMoves';
import type {LabMaterialLibrary} from './materials';
import {
  MIRROR_CORE_SLICE_UNIT,
  MIRROR_LAYER_UNITS,
  RubiksCube,
} from './RubiksCube';

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
    mirrorCubeCore: std,
    mirrorCubeTiles: {
      xAxis: phys,
      yAxis: phys,
      zAxis: phys,
    },
    dominoCubeCore: std,
    dominoCubeTiles: {
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

test('all 16 cube moves (12 quarter-turns + 4 half-turns) have exact inverses and consistent axes', () => {
  assert.equal(ALL_CUBE_MOVES.length, 16);
  for (const notation of ALL_CUBE_MOVES) {
    const spec = getMoveSpec(notation);
    const inv = getInverseMove(notation);
    const invSpec = MOVE_SPECS[inv];

    assert.equal(spec.face, invSpec.face);
    assert.equal(spec.axis, invSpec.axis);
    assert.equal(spec.layer, invSpec.layer);
    if (spec.isHalfTurn) {
      assert.equal(inv, notation);
      assert.equal(spec.quarterTurns, 2);
      assert.ok(Math.abs(Math.abs(spec.angleRad) - Math.PI) < 1e-9);
    } else {
      assert.equal(spec.quarterTurns, -invSpec.quarterTurns);
      assert.ok(Math.abs(Math.abs(spec.angleRad) - Math.PI / 2) < 1e-9);
    }
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

test('ContinuousScrambleGenerator produces 200+ evenly balanced non-redundant moves on the fly', () => {
  const opposite: Record<CubeFace, CubeFace> = {
    U: 'D',
    D: 'U',
    L: 'R',
    R: 'L',
    F: 'B',
    B: 'F',
  };

  const gen = new ContinuousScrambleGenerator(makeSeededRng(777));
  const moves: CubeMoveNotation[] = [];
  for (let i = 0; i < 200; i++) {
    const move = gen.next();
    moves.push(move);
    const face = getMoveSpec(move).face;
    if (i > 0) {
      assert.notEqual(face, getMoveSpec(moves[i - 1]).face);
    }
    if (i > 1) {
      const prev = getMoveSpec(moves[i - 1]).face;
      const prevPrev = getMoveSpec(moves[i - 2]).face;
      assert.ok(!(face === prevPrev && prev === opposite[face]));
    }
  }

  const counts = Object.values(gen.getFaceCounts());
  const minCount = Math.min(...counts);
  const maxCount = Math.max(...counts);
  assert.ok(
    maxCount - minCount <= 2,
    `Expected even distribution across 6 faces over 200 moves, got ${JSON.stringify(gen.getFaceCounts())}`,
  );
});

test('optimizeMoveSequence cancels inverse pairs, collapses triples, quads, commuting opposite faces, and cascades', () => {
  // Adjacent inverse cancellation
  assert.deepEqual(optimizeMoveSequence(['L', "L'"]), []);
  assert.deepEqual(optimizeMoveSequence(['R', 'U', "U'", "R'"]), []);

  // Triple identical move collapse: U U U -> U' and R' R' R' -> R
  assert.deepEqual(optimizeMoveSequence(['U', 'U', 'U']), ["U'"]);
  assert.deepEqual(optimizeMoveSequence(["R'", "R'", "R'"]), ['R']);

  // Quad identical cancellation: F F F F -> []
  assert.deepEqual(optimizeMoveSequence(['F', 'F', 'F', 'F']), []);

  // Commuting opposite faces: R L R' -> L
  assert.deepEqual(optimizeMoveSequence(['R', 'L', "R'"]), ['L']);

  // Cascading cancellation across multiple axes: F U R L R' L' U' F' -> []
  assert.deepEqual(
    optimizeMoveSequence(['F', 'U', 'R', 'L', "R'", "L'", "U'", "F'"]),
    [],
  );

  // Mixed sequence preserving non-redundant moves
  assert.deepEqual(
    optimizeMoveSequence(['R', 'U', 'U', 'U', 'F', "F'", 'D']),
    ['R', "U'", 'D'],
  );
});

test('computeOptimizedSolution solves back-to-back scrambles on RubiksCube back to 100% solved state with zero drift', () => {
  const materials = createHeadlessMaterials();
  const cube = new RubiksCube(materials);
  assert.equal(cube.isSolved(), true);

  // Perform two back-to-back scrambles + redundant junction moves to exercise optimizer
  const scramble1 = generateScrambleSequence(makeSeededRng(303));
  const scramble2 = generateScrambleSequence(makeSeededRng(404));
  const junction: CubeMoveNotation[] = ['U', 'U', 'U', 'R', "R'", 'L', 'R', "L'"];
  const combined: CubeMoveNotation[] = [...scramble1, ...junction, ...scramble2];

  for (const move of combined) {
    cube.beginMove(move);
    cube.setActiveMoveProgress(1);
    cube.commitActiveMove(true);
  }

  assert.equal(cube.isSolved(), false);
  assert.equal(cube.getMoveHistory().length, combined.length);

  const solution = computeOptimizedSolution(cube.getMoveHistory());
  // Optimizer must strictly reduce the redundant junction moves
  assert.ok(
    solution.length < combined.length,
    `Expected optimized solution (${solution.length}) to be shorter than raw history (${combined.length})`,
  );

  for (const move of solution) {
    cube.beginMove(move);
    cube.setActiveMoveProgress(0.5);
    cube.setActiveMoveProgress(1);
    cube.commitActiveMove(false);
  }

  cube.clearMoveHistory();
  assert.equal(cube.getMoveHistory().length, 0);
  assert.equal(cube.isSolved(), true, 'Cube must be 100% solved after optimized Auto-Solve');

  cube.dispose();
  materials.dispose();
});

test('Mirror Cube has exact M=0.86 core alignment, 3.00-unit solved footprint, zero cubie overlap over 50 moves, and exact Auto-Solve', () => {
  const materials = createHeadlessMaterials();
  const cube = new RubiksCube(materials, 'mirror');

  assert.equal(cube.getPuzzleType(), 'mirror');
  assert.equal(cube.cubies.length, 27);
  assert.equal(cube.isSolved(), true);

  // 1. Verify exact M = 0.86 core alignment and 3.00-unit total solved width on all 3 axes
  for (const axis of ['x', 'y', 'z'] as const) {
    assert.equal(MIRROR_LAYER_UNITS[axis]['0'], MIRROR_CORE_SLICE_UNIT);
    const totalUnits =
      MIRROR_LAYER_UNITS[axis]['-1'] +
      MIRROR_LAYER_UNITS[axis]['0'] +
      MIRROR_LAYER_UNITS[axis]['1'];
    assert.ok(
      Math.abs(totalUnits - 3.0) < 1e-9,
      `Expected ${axis}-axis total 3.00 units, got ${totalUnits}`,
    );
  }

  // Solved outer bounds must be strictly asymmetric around core (0,0,0) yet span ~0.210m+tiles per axis
  const solvedBounds = cube.getBoundsSnapshot();
  assert.equal(solvedBounds.puzzleType, 'mirror');
  assert.ok(Math.abs(solvedBounds.maxX) > Math.abs(solvedBounds.minX) + 0.05);
  assert.ok(Math.abs(solvedBounds.maxY) > Math.abs(solvedBounds.minY) + 0.04);
  assert.ok(Math.abs(solvedBounds.maxZ) > Math.abs(solvedBounds.minZ) + 0.03);
  assert.ok(Math.abs((solvedBounds.maxX - solvedBounds.minX) - 0.214) < 0.004);
  assert.ok(Math.abs((solvedBounds.maxY - solvedBounds.minY) - 0.214) < 0.004);
  assert.ok(Math.abs((solvedBounds.maxZ - solvedBounds.minZ) - 0.214) < 0.004);

  // Helper: pairwise cubie AABB intersection check (verifies zero cubie-to-cubie overlap!)
  const assertZeroCubieOverlap = (stepLabel: string) => {
    const boxes = cube.cubies.map((u) => {
      const a = u.localMin.clone().applyQuaternion(u.group.quaternion).add(u.group.position);
      const b = u.localMax.clone().applyQuaternion(u.group.quaternion).add(u.group.position);
      return {
        name: u.group.name,
        minX: Math.min(a.x, b.x),
        maxX: Math.max(a.x, b.x),
        minY: Math.min(a.y, b.y),
        maxY: Math.max(a.y, b.y),
        minZ: Math.min(a.z, b.z),
        maxZ: Math.max(a.z, b.z),
      };
    });
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const A = boxes[i];
        const B = boxes[j];
        const ox = Math.min(A.maxX, B.maxX) - Math.max(A.minX, B.minX);
        const oy = Math.min(A.maxY, B.maxY) - Math.max(A.minY, B.minY);
        const oz = Math.min(A.maxZ, B.maxZ) - Math.max(A.minZ, B.minZ);
        assert.ok(
          ox <= 1e-4 || oy <= 1e-4 || oz <= 1e-4,
          `Cubie overlap at ${stepLabel}: ${A.name} vs ${B.name} (${(ox * 1000).toFixed(2)}, ${(oy * 1000).toFixed(2)}, ${(oz * 1000).toFixed(2)} mm)`,
        );
      }
    }
  };

  assertZeroCubieOverlap('solved');

  // 2. Run 50 continuous random moves on Mirror Cube and verify shape-shifting + zero overlap
  const gen = new ContinuousScrambleGenerator(makeSeededRng(9001));
  let maxObservedSpan = 0;
  for (let i = 0; i < 50; i++) {
    const move = gen.next();
    cube.beginMove(move);
    cube.setActiveMoveProgress(0.5);
    cube.setActiveMoveProgress(1);
    cube.commitActiveMove(true);
    assertZeroCubieOverlap(`scramble move ${i + 1} (${move})`);

    const b = cube.getBoundsSnapshot();
    maxObservedSpan = Math.max(
      maxObservedSpan,
      b.maxX - b.minX,
      b.maxY - b.minY,
      b.maxZ - b.minZ,
    );
  }

  assert.equal(cube.isSolved(), false);
  assert.ok(
    maxObservedSpan > 0.24,
    `Expected scrambled Mirror Cube to physically expand beyond solved 0.214m width, got ${maxObservedSpan.toFixed(4)}m`,
  );

  // 3. Deterministic optimized Auto-Solve restores 100% solved Mirror Cube with zero drift
  const solution = computeOptimizedSolution(cube.getMoveHistory());
  for (let i = 0; i < solution.length; i++) {
    cube.beginMove(solution[i]);
    cube.setActiveMoveProgress(1);
    cube.commitActiveMove(false);
    assertZeroCubieOverlap(`solve move ${i + 1} (${solution[i]})`);
  }
  cube.clearMoveHistory();
  assert.equal(cube.isSolved(), true, 'Mirror Cube must fold back to 100% solved state');

  // 4. Switching back to Classic 3x3 rebuilds cleanly and clears history
  cube.applyMoveInstant('R', true);
  assert.equal(cube.getMoveHistory().length, 1);
  cube.setPuzzleType('classic');
  assert.equal(cube.getPuzzleType(), 'classic');
  assert.equal(cube.getMoveHistory().length, 0);
  assert.equal(cube.isSolved(), true);

  cube.dispose();
  materials.dispose();
});

test('Domino Cuboid optimizer cancels 180-degree pairs, handles commuting half-turns, and collapses U/D triples', () => {
  // Identical 180-degree self-inverse cancellation
  assert.deepEqual(optimizeMoveSequence(['R2', 'R2'], 'domino'), []);
  assert.deepEqual(optimizeMoveSequence(['L2', 'L2'], 'domino'), []);
  assert.deepEqual(optimizeMoveSequence(['F2', 'F2'], 'domino'), []);
  assert.deepEqual(optimizeMoveSequence(['B2', 'B2'], 'domino'), []);

  // Commuting opposite 180-degree faces: R2 L2 R2 -> L2, F2 B2 F2 -> B2
  assert.deepEqual(optimizeMoveSequence(['R2', 'L2', 'R2'], 'domino'), ['L2']);
  assert.deepEqual(optimizeMoveSequence(['F2', 'B2', 'F2'], 'domino'), ['B2']);

  // Cascading cancellation across U/D and 180-degree side flips
  assert.deepEqual(optimizeMoveSequence(['R2', 'U', "U'", 'R2'], 'domino'), []);
  assert.deepEqual(
    optimizeMoveSequence(['F2', 'U', 'U', 'U', 'D', "D'", 'F2'], 'domino'),
    ['F2', "U'", 'F2'],
  );

  // U/D double turn stays two quarter-turns (never emits invalid U2)
  assert.deepEqual(optimizeMoveSequence(['U', 'U'], 'domino'), ['U', 'U']);

  // computeOptimizedSolution reverses and inverts Domino moves properly
  assert.deepEqual(
    computeOptimizedSolution(['U', 'R2', "D'", 'F2'], 'domino'),
    ['F2', 'D', 'R2', "U'"],
  );
});

test('ContinuousScrambleGenerator in domino mode produces 120 balanced legal Domino moves without redundancy', () => {
  const opposite: Record<CubeFace, CubeFace> = {
    U: 'D',
    D: 'U',
    L: 'R',
    R: 'L',
    F: 'B',
    B: 'F',
  };
  const legalDomino = new Set<CubeMoveNotation>(DOMINO_MOVES);

  const gen = new ContinuousScrambleGenerator(makeSeededRng(2026));
  const moves: CubeMoveNotation[] = [];
  for (let i = 0; i < 120; i++) {
    const move = gen.next('domino');
    assert.ok(legalDomino.has(move), `Illegal Domino move generated: ${move}`);
    moves.push(move);
    const face = getMoveSpec(move).face;
    if (i > 0) {
      assert.notEqual(face, getMoveSpec(moves[i - 1]).face);
    }
    if (i > 1) {
      const prev = getMoveSpec(moves[i - 1]).face;
      const prevPrev = getMoveSpec(moves[i - 2]).face;
      assert.ok(!(face === prevPrev && prev === opposite[face]));
    }
  }

  const counts = Object.values(gen.getFaceCounts());
  const minCount = Math.min(...counts);
  const maxCount = Math.max(...counts);
  assert.ok(
    maxCount - minCount <= 2,
    `Expected balanced Domino face distribution over 120 moves, got ${JSON.stringify(gen.getFaceCounts())}`,
  );
});

test('3x3x2 Domino Cuboid has 18 cubies, 3x2x3 footprint, zero cubie overlap over 50 moves, and exact Auto-Solve', () => {
  const materials = createHeadlessMaterials();
  const cube = new RubiksCube(materials, 'domino');

  assert.equal(cube.getPuzzleType(), 'domino');
  assert.equal(cube.cubies.length, 18);
  assert.equal(cube.isSolved(), true);

  // Verify exact 3x2x3 solved bounds (~0.214m x 0.144m x 0.214m) centered at (0,0,0)
  const solvedBounds = cube.getBoundsSnapshot();
  assert.equal(solvedBounds.puzzleType, 'domino');
  assert.ok(Math.abs(solvedBounds.maxX + solvedBounds.minX) < 1e-6);
  assert.ok(Math.abs(solvedBounds.maxY + solvedBounds.minY) < 1e-6);
  assert.ok(Math.abs(solvedBounds.maxZ + solvedBounds.minZ) < 1e-6);
  assert.ok(Math.abs((solvedBounds.maxX - solvedBounds.minX) - 0.214) < 0.004);
  assert.ok(Math.abs((solvedBounds.maxY - solvedBounds.minY) - 0.144) < 0.004);
  assert.ok(Math.abs((solvedBounds.maxZ - solvedBounds.minZ) - 0.214) < 0.004);

  // Verify exact cubie counts per layer: 9 on U/D, 6 on L2/R2/F2/B2
  assert.equal(cube.getLayerCubies('y', 1).length, 9);
  assert.equal(cube.getLayerCubies('y', -1).length, 9);
  assert.equal(cube.getLayerCubies('x', -1).length, 6);
  assert.equal(cube.getLayerCubies('x', 1).length, 6);
  assert.equal(cube.getLayerCubies('z', 1).length, 6);
  assert.equal(cube.getLayerCubies('z', -1).length, 6);

  const assertZeroDominoDriftAndOverlap = (stepLabel: string) => {
    const occupied = new Set<string>();
    const boxes = cube.cubies.map((u) => {
      assert.equal(u.group.parent, cube);
      const {x, y, z} = u.coord;
      assert.ok(x === -1 || x === 0 || x === 1, `Bad X coord ${x} at ${stepLabel}`);
      assert.ok(y === -0.5 || y === 0.5, `Bad Y coord ${y} at ${stepLabel}`);
      assert.ok(z === -1 || z === 0 || z === 1, `Bad Z coord ${z} at ${stepLabel}`);
      occupied.add(`${x},${y},${z}`);

      assert.ok(Math.abs(u.group.position.x - x * cube.cubieSpacing) < 1e-12);
      assert.ok(Math.abs(u.group.position.y - y * cube.cubieSpacing) < 1e-12);
      assert.ok(Math.abs(u.group.position.z - z * cube.cubieSpacing) < 1e-12);

      const a = u.localMin.clone().applyQuaternion(u.group.quaternion).add(u.group.position);
      const b = u.localMax.clone().applyQuaternion(u.group.quaternion).add(u.group.position);
      return {
        name: u.group.name,
        minX: Math.min(a.x, b.x),
        maxX: Math.max(a.x, b.x),
        minY: Math.min(a.y, b.y),
        maxY: Math.max(a.y, b.y),
        minZ: Math.min(a.z, b.z),
        maxZ: Math.max(a.z, b.z),
      };
    });
    assert.equal(occupied.size, 18, `Expected 18 unique Domino slots at ${stepLabel}`);

    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const A = boxes[i];
        const B = boxes[j];
        const ox = Math.min(A.maxX, B.maxX) - Math.max(A.minX, B.minX);
        const oy = Math.min(A.maxY, B.maxY) - Math.max(A.minY, B.minY);
        const oz = Math.min(A.maxZ, B.maxZ) - Math.max(A.minZ, B.minZ);
        assert.ok(
          ox <= 1e-4 || oy <= 1e-4 || oz <= 1e-4,
          `Domino cubie overlap at ${stepLabel}: ${A.name} vs ${B.name}`,
        );
      }
    }
  };

  assertZeroDominoDriftAndOverlap('solved');

  // Execute 50 random Domino moves (mix of ±90° U/D and 180° L2/R2/F2/B2)
  const gen = new ContinuousScrambleGenerator(makeSeededRng(3322));
  for (let i = 0; i < 50; i++) {
    const move = gen.next('domino');
    cube.beginMove(move);
    cube.setActiveMoveProgress(0.5);
    cube.setActiveMoveProgress(1);
    cube.commitActiveMove(true);
    assertZeroDominoDriftAndOverlap(`scramble ${i + 1} (${move})`);
  }
  assert.equal(cube.isSolved(), false);

  // Optimized Auto-Solve restores 100% solved Domino Cuboid
  const solution = computeOptimizedSolution(cube.getMoveHistory(), 'domino');
  for (let i = 0; i < solution.length; i++) {
    cube.beginMove(solution[i]);
    cube.setActiveMoveProgress(0.5);
    cube.setActiveMoveProgress(1);
    cube.commitActiveMove(false);
    assertZeroDominoDriftAndOverlap(`solve ${i + 1} (${solution[i]})`);
  }
  cube.clearMoveHistory();
  assert.equal(cube.isSolved(), true, 'Domino Cuboid must return to 100% solved state');

  cube.dispose();
  materials.dispose();
});




