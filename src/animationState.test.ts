import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import {DEFAULT_DURATIONS, RoboticsChoreography} from './animationState';
import {getMoveSpec, type CubeMoveNotation} from './cubeMoves';
import {LAB_DIMENSIONS, computeForwardKinematics} from './kinematics';
import type {LabMaterialLibrary} from './materials';
import {RoboticArm} from './RoboticArm';
import type {MachineState} from './types';

function advanceBy(choreo: RoboticsChoreography, seconds: number) {
  let frame = choreo.evaluateFrame();
  let remaining = seconds;
  while (remaining > 1e-6) {
    const dt = Math.min(0.02, remaining);
    frame = choreo.step(dt);
    remaining -= dt;
  }
  return frame;
}

test('full Pick Up -> Hold -> Put Down lifecycle transitions cleanly and blocks mid-flight clicks', () => {
  const choreo = new RoboticsChoreography();
  const seenStates: MachineState[] = [];
  choreo.subscribe((snap) => {
    if (seenStates[seenStates.length - 1] !== snap.state) {
      seenStates.push(snap.state);
    }
  });

  assert.equal(choreo.getState(), 'STANDBY');
  assert.equal(choreo.isBusy(), false);
  assert.equal(choreo.canPerformCubeMove(), false);

  // Trigger Pick Up
  assert.equal(choreo.triggerPrimaryAction(), true);
  assert.equal(choreo.getState(), 'APPROACHING');
  assert.equal(choreo.isBusy(), true);

  // Overlapping trigger mid-flight must be ignored
  assert.equal(choreo.triggerPrimaryAction(), false);

  // Run through approach + grip + lift
  const pickUpTotal =
    DEFAULT_DURATIONS.approach + DEFAULT_DURATIONS.grip + DEFAULT_DURATIONS.lift + 0.05;
  const heldFrame = advanceBy(choreo, pickUpTotal);

  assert.equal(choreo.getState(), 'HOLDING');
  assert.equal(choreo.isBusy(), false);
  assert.equal(choreo.canPerformCubeMove(), true);
  assert.equal(heldFrame.cubeAttached, true);
  assert.equal(heldFrame.leftAngles.jawOpen, 0);
  assert.equal(heldFrame.rightAngles.jawOpen, 0);
  assert.ok(
    Math.abs(heldFrame.cubePosition.y - LAB_DIMENSIONS.CUBE_HOLD_Y) < 0.005,
    `Expected cube hovering near ${LAB_DIMENSIONS.CUBE_HOLD_Y}, got ${heldFrame.cubePosition.y}`,
  );

  // Verify both arms are locked symmetrically on the cube's left & right center faces
  const leftFk = computeForwardKinematics('left', heldFrame.leftAngles);
  const rightFk = computeForwardKinematics('right', heldFrame.rightAngles);
  assert.ok(Math.abs(leftFk.contactPad.x + LAB_DIMENSIONS.CUBE_OUTER_HALF) < 1e-3);
  assert.ok(Math.abs(rightFk.contactPad.x - LAB_DIMENSIONS.CUBE_OUTER_HALF) < 1e-3);
  assert.ok(Math.abs(leftFk.contactPad.y - heldFrame.cubePosition.y) < 1e-3);
  assert.ok(Math.abs(rightFk.contactPad.y - heldFrame.cubePosition.y) < 1e-3);

  // Trigger Put Down
  assert.equal(choreo.triggerPrimaryAction(), true);
  assert.equal(choreo.getState(), 'LOWERING');
  assert.equal(choreo.triggerPrimaryAction(), false);

  const putDownTotal =
    DEFAULT_DURATIONS.lower +
    DEFAULT_DURATIONS.release +
    DEFAULT_DURATIONS.returnHome +
    0.05;
  const restFrame = advanceBy(choreo, putDownTotal);

  assert.equal(choreo.getState(), 'STANDBY');
  assert.equal(choreo.isBusy(), false);
  assert.equal(restFrame.cubeAttached, false);
  assert.equal(restFrame.leftAngles.jawOpen, 1);
  assert.equal(restFrame.rightAngles.jawOpen, 1);
  assert.ok(
    Math.abs(restFrame.cubePosition.y - LAB_DIMENSIONS.CUBE_REST_Y) < 1e-4,
  );

  assert.deepEqual(seenStates, [
    'STANDBY',
    'APPROACHING',
    'GRIPPING',
    'LIFTING',
    'HOLDING',
    'LOWERING',
    'RELEASING',
    'RETURNING',
    'STANDBY',
  ]);
});

test('Auto-Lift Scramble from STANDBY, double Scramble from HOLDING, and smooth Put Down', () => {
  const choreo = new RoboticsChoreography();
  const seenStates: MachineState[] = [];
  const committedAll: string[] = [];

  choreo.subscribe((snap) => {
    if (seenStates[seenStates.length - 1] !== snap.state) {
      seenStates.push(snap.state);
    }
  });

  // 1. Trigger Scramble directly from STANDBY -> auto-lifts first!
  const seq1: CubeMoveNotation[] = ['R', "U'", 'F', 'L', "D'", 'B'];
  assert.equal(choreo.triggerScramble(seq1), true);
  assert.equal(choreo.getState(), 'APPROACHING');
  assert.equal(choreo.isBusy(), true);

  // Overlapping clicks during auto-lift must be cleanly locked out
  assert.equal(choreo.triggerPrimaryAction(), false);
  assert.equal(choreo.triggerScramble(), false);

  let sawScramblingStatus = false;
  let sawScramblingLed = false;
  let safetySteps = 0;
  while (choreo.getState() !== 'HOLDING' && safetySteps < 2000) {
    const frame = choreo.step(0.02);
    committedAll.push(...frame.committedMoves);
    if (frame.snapshot.state === 'SCRAMBLING') {
      assert.equal(choreo.triggerPrimaryAction(), false);
      assert.equal(choreo.triggerScramble(), false);
      if (frame.snapshot.statusLabel.startsWith('SCRAMBLING • Move ')) {
        sawScramblingStatus = true;
      }
      if (frame.snapshot.ledMode === 'scrambling') {
        sawScramblingLed = true;
      }
    }
    safetySteps += 1;
  }

  assert.equal(choreo.getState(), 'HOLDING');
  assert.equal(sawScramblingStatus, true);
  assert.equal(sawScramblingLed, true);
  assert.equal(choreo.getSnapshot().statusLabel, 'HOLDING — SCRAMBLED');
  assert.equal(choreo.getSnapshot().isScrambled, true);
  assert.deepEqual(committedAll, seq1);
  assert.equal(choreo.getSnapshot().moveHistoryCount, seq1.length);

  // 2. Run a second Scramble directly from HOLDING (no extra lift!)
  const seq2: CubeMoveNotation[] = ["R'", 'U', "F'", "L'", 'D', "B'"];
  assert.equal(choreo.triggerScramble(seq2), true);
  assert.equal(choreo.getState(), 'SCRAMBLING');

  safetySteps = 0;
  while (choreo.getState() !== 'HOLDING' && safetySteps < 2000) {
    const frame = choreo.step(0.02);
    committedAll.push(...frame.committedMoves);
    safetySteps += 1;
  }

  assert.equal(choreo.getState(), 'HOLDING');
  assert.equal(choreo.getSnapshot().moveHistoryCount, seq1.length + seq2.length);
  assert.deepEqual(committedAll, [...seq1, ...seq2]);

  // 3. Put Down scrambled cube cleanly back onto the center pad
  assert.equal(choreo.triggerPrimaryAction(), true);
  assert.equal(choreo.getState(), 'LOWERING');
  const putDownTotal =
    DEFAULT_DURATIONS.lower +
    DEFAULT_DURATIONS.release +
    DEFAULT_DURATIONS.returnHome +
    0.05;
  const restFrame = advanceBy(choreo, putDownTotal);
  assert.equal(choreo.getState(), 'STANDBY');
  assert.ok(Math.abs(restFrame.cubePosition.y - LAB_DIMENSIONS.CUBE_REST_Y) < 1e-4);
  assert.ok(Math.abs(restFrame.cubeYaw) < 1e-6);

  assert.deepEqual(seenStates, [
    'STANDBY',
    'APPROACHING',
    'GRIPPING',
    'LIFTING',
    'SCRAMBLING',
    'HOLDING',
    'SCRAMBLING',
    'HOLDING',
    'LOWERING',
    'RELEASING',
    'RETURNING',
    'STANDBY',
  ]);
});

test('all 12 face moves stay inside IK workspace envelope with tabletop clearance and flush grip', () => {
  const choreo = new RoboticsChoreography();
  const all12 = ['L', "L'", 'R', "R'", 'U', "U'", 'D', "D'", 'F', "F'", 'B', "B'"] as const;

  assert.equal(choreo.triggerScramble([...all12]), true);

  let twistsObserved = 0;
  let lastTurnId = -1;
  let steps = 0;

  while (choreo.getState() !== 'HOLDING' && steps < 4000) {
    const frame = choreo.step(0.02);
    steps += 1;

    const leftFk = computeForwardKinematics('left', frame.leftAngles);
    const rightFk = computeForwardKinematics('right', frame.rightAngles);

    // Every joint must stay safely above tabletop surface
    assert.ok(
      leftFk.elbow.y > LAB_DIMENSIONS.TABLE_TOP_Y + 0.08 &&
        leftFk.wrist.y > LAB_DIMENSIONS.TABLE_TOP_Y + 0.08,
      `Left arm dipped too close to table: elbow=${leftFk.elbow.y}, wrist=${leftFk.wrist.y}`,
    );
    assert.ok(
      rightFk.elbow.y > LAB_DIMENSIONS.TABLE_TOP_Y + 0.08 &&
        rightFk.wrist.y > LAB_DIMENSIONS.TABLE_TOP_Y + 0.08,
      `Right arm dipped too close to table: elbow=${rightFk.elbow.y}, wrist=${rightFk.wrist.y}`,
    );

    if (frame.activeFaceTurn) {
      if (frame.activeFaceTurn.turnId !== lastTurnId) {
        lastTurnId = frame.activeFaceTurn.turnId;
        twistsObserved += 1;
      }
      // During active twist, both jaws must remain firmly closed (0) with zero gap
      assert.equal(frame.leftAngles.jawOpen, 0);
      assert.equal(frame.rightAngles.jawOpen, 0);

      // Verify both gripper pads sit flush against cube faces (exact half-width distance along one axis)
      const dxL = Math.abs(leftFk.contactPad.x - frame.cubePosition.x);
      const dyL = Math.abs(leftFk.contactPad.y - frame.cubePosition.y);
      const dzL = Math.abs(leftFk.contactPad.z - frame.cubePosition.z);
      const distL = Math.hypot(dxL, dyL, dzL);

      const dxR = Math.abs(rightFk.contactPad.x - frame.cubePosition.x);
      const dyR = Math.abs(rightFk.contactPad.y - frame.cubePosition.y);
      const dzR = Math.abs(rightFk.contactPad.z - frame.cubePosition.z);
      const distR = Math.hypot(dxR, dyR, dzR);

      assert.ok(
        Math.abs(distL - LAB_DIMENSIONS.CUBE_OUTER_HALF) < 2e-3,
        `Left contact pad drifted during ${frame.activeFaceTurn.move}: dist=${distL}`,
      );
      assert.ok(
        Math.abs(distR - LAB_DIMENSIONS.CUBE_OUTER_HALF) < 2e-3,
        `Right contact pad drifted during ${frame.activeFaceTurn.move}: dist=${distR}`,
      );
    }
  }

  assert.equal(choreo.getState(), 'HOLDING');
  assert.equal(twistsObserved, 12);
});

test('indefinite continuous scramble runs past 26+ moves, stops gracefully mid-twist, resumes without resetting history, and puts down cleanly', () => {
  let seed = 424242;
  const rng = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const choreo = new RoboticsChoreography({}, rng);
  const committedHistory: CubeMoveNotation[] = [];

  // 1. Auto-lift start from STANDBY via toggleScramble()
  assert.equal(choreo.toggleScramble(), true);
  assert.equal(choreo.getState(), 'APPROACHING');
  assert.equal(choreo.getSnapshot().primaryButtonDisabled, true);
  assert.equal(choreo.getSnapshot().scrambleButtonDisabled, true);
  assert.equal(choreo.getSnapshot().scrambleButtonLabel, 'Lifting...');

  // Step through lift and run continuously past 26 moves (proving no 16-move cap!)
  let sawActiveStopButton = false;
  let sawOpenEndedStatus = false;
  let steps = 0;
  while (committedHistory.length < 26 && steps < 10000) {
    const frame = choreo.step(0.02);
    committedHistory.push(...frame.committedMoves);
    if (frame.snapshot.state === 'SCRAMBLING') {
      assert.equal(frame.snapshot.primaryButtonDisabled, true);
      assert.equal(frame.snapshot.scrambleButtonDisabled, false);
      assert.equal(frame.snapshot.scrambleButtonMode, 'stop');
      assert.equal(frame.snapshot.scrambleButtonLabel, 'Stop Scramble');
      assert.equal(choreo.triggerPrimaryAction(), false);
      sawActiveStopButton = true;
      if (/^SCRAMBLING • Move \d+ \([UDLRFB]'?\)$/.test(frame.snapshot.statusLabel)) {
        sawOpenEndedStatus = true;
      }
    }
    steps += 1;
  }

  assert.equal(sawActiveStopButton, true);
  assert.equal(sawOpenEndedStatus, true);
  assert.ok(committedHistory.length >= 26, `Expected >= 26 moves, got ${committedHistory.length}`);
  assert.equal(choreo.getState(), 'SCRAMBLING');

  // 2. Advance until the next move (move 27) is actively mid-twist, then click Stop Scramble!
  let stopTriggeredMidTwist = false;
  let activeMoveAtStop: CubeMoveNotation | null = null;
  steps = 0;
  while (!stopTriggeredMidTwist && steps < 500) {
    const frame = choreo.step(0.02);
    committedHistory.push(...frame.committedMoves);
    if (
      frame.activeFaceTurn &&
      frame.activeFaceTurn.easedProgress > 0.25 &&
      frame.activeFaceTurn.easedProgress < 0.75
    ) {
      activeMoveAtStop = frame.activeFaceTurn.move;
      assert.equal(choreo.toggleScramble(), true);
      stopTriggeredMidTwist = true;
    }
    steps += 1;
  }

  assert.equal(stopTriggeredMidTwist, true, 'Expected to catch an active mid-twist frame');
  const stoppingSnap = choreo.getSnapshot();
  assert.equal(stoppingSnap.state, 'SCRAMBLING');
  assert.equal(stoppingSnap.isStoppingScramble, true);
  assert.ok(stoppingSnap.statusLabel.startsWith('STOPPING...'));
  assert.equal(stoppingSnap.scrambleButtonDisabled, true);
  assert.equal(stoppingSnap.primaryButtonDisabled, true);
  // Second stop click while already stopping is cleanly ignored
  assert.equal(choreo.toggleScramble(), false);

  // 3. Step until the current move finishes its twist + neutral regrip and halts cleanly in HOLDING
  let lastFrame = choreo.evaluateFrame();
  steps = 0;
  while (choreo.getState() !== 'HOLDING' && steps < 1000) {
    lastFrame = choreo.step(0.02);
    committedHistory.push(...lastFrame.committedMoves);
    steps += 1;
  }

  assert.equal(choreo.getState(), 'HOLDING');
  assert.equal(committedHistory[committedHistory.length - 1], activeMoveAtStop);
  assert.equal(choreo.getSnapshot().statusLabel, 'HOLDING — SCRAMBLED');
  assert.equal(choreo.getSnapshot().scrambleButtonLabel, 'Scramble');
  assert.equal(choreo.getSnapshot().scrambleButtonMode, 'start');
  assert.equal(choreo.getSnapshot().scrambleButtonDisabled, false);
  assert.equal(choreo.getSnapshot().primaryButtonDisabled, false);
  assert.equal(choreo.getSnapshot().moveHistoryCount, committedHistory.length);

  // Verify grippers returned cleanly to neutral left/right hold with zero yaw
  assert.ok(Math.abs(lastFrame.cubeYaw) < 1e-6);
  assert.equal(lastFrame.leftAngles.jawOpen, 0);
  assert.equal(lastFrame.rightAngles.jawOpen, 0);
  const leftFk = computeForwardKinematics('left', lastFrame.leftAngles);
  const rightFk = computeForwardKinematics('right', lastFrame.rightAngles);
  assert.ok(Math.abs(leftFk.contactPad.x + LAB_DIMENSIONS.CUBE_OUTER_HALF) < 1e-3);
  assert.ok(Math.abs(rightFk.contactPad.x - LAB_DIMENSIONS.CUBE_OUTER_HALF) < 1e-3);

  // 4. Resume scrambling without resetting moveHistory
  const countBeforeResume = committedHistory.length;
  assert.equal(choreo.toggleScramble(), true);
  assert.equal(choreo.getState(), 'SCRAMBLING');
  assert.equal(choreo.getSnapshot().scrambleProgress?.moveNumber, countBeforeResume + 1);

  while (committedHistory.length < countBeforeResume + 3) {
    const f = choreo.step(0.02);
    committedHistory.push(...f.committedMoves);
  }
  assert.equal(choreo.toggleScramble(), true);
  while (choreo.getState() !== 'HOLDING') {
    const f = choreo.step(0.02);
    committedHistory.push(...f.committedMoves);
  }
  assert.ok(choreo.getSnapshot().moveHistoryCount >= countBeforeResume + 3);

  // 5. Put Down scrambled cube cleanly back onto the resting pad
  assert.equal(choreo.triggerPrimaryAction(), true);
  const restFrame = advanceBy(
    choreo,
    DEFAULT_DURATIONS.lower +
      DEFAULT_DURATIONS.release +
      DEFAULT_DURATIONS.returnHome +
      0.05,
  );
  assert.equal(choreo.getState(), 'STANDBY');
  assert.ok(Math.abs(restFrame.cubePosition.y - LAB_DIMENSIONS.CUBE_REST_Y) < 1e-4);
});

test('Auto-Solve from STANDBY auto-lifts, executes optimized solution, celebrates with lockstep pitch, and settles in HOLDING — SOLVED', () => {
  const choreo = new RoboticsChoreography();
  const seenStates: MachineState[] = [];
  choreo.subscribe((snap) => {
    if (seenStates[seenStates.length - 1] !== snap.state) {
      seenStates.push(snap.state);
    }
  });

  // Initially solved -> Auto-Solve button must be disabled
  assert.equal(choreo.getSnapshot().solveButtonDisabled, true);

  // 1. Back-to-back scrambles with redundant junction moves (R U' U U' -> R U')
  const scramble1: CubeMoveNotation[] = ['R', 'U', 'F'];
  const scramble2: CubeMoveNotation[] = ["F'", 'L', 'L', 'L', "D'"];
  const recordedHistory: CubeMoveNotation[] = [];

  assert.equal(choreo.triggerScramble(scramble1), true);
  while (choreo.getState() !== 'HOLDING') {
    const f = choreo.step(0.02);
    if (f.committedMovesRecordHistory) recordedHistory.push(...f.committedMoves);
  }
  assert.equal(choreo.triggerScramble(scramble2), true);
  while (choreo.getState() !== 'HOLDING') {
    const f = choreo.step(0.02);
    if (f.committedMovesRecordHistory) recordedHistory.push(...f.committedMoves);
  }
  assert.deepEqual(recordedHistory, [...scramble1, ...scramble2]);
  assert.equal(choreo.getSnapshot().solveButtonDisabled, false);

  // 2. Put Down scrambled cube onto the workbench table
  assert.equal(choreo.triggerPrimaryAction(), true);
  advanceBy(
    choreo,
    DEFAULT_DURATIONS.lower +
      DEFAULT_DURATIONS.release +
      DEFAULT_DURATIONS.returnHome +
      0.05,
  );
  assert.equal(choreo.getState(), 'STANDBY');
  assert.equal(choreo.getSnapshot().solveButtonDisabled, false);

  // 3. Trigger Auto-Solve directly from STANDBY -> must auto-lift first!
  assert.equal(choreo.triggerAutoSolve(recordedHistory), true);
  assert.equal(choreo.getState(), 'APPROACHING');
  assert.equal(choreo.getSnapshot().solveButtonLabel, 'Lifting...');
  assert.equal(choreo.getSnapshot().solveButtonDisabled, true);
  assert.equal(choreo.getSnapshot().primaryButtonDisabled, true);
  assert.equal(choreo.getSnapshot().scrambleButtonDisabled, true);

  // 4. Step through Auto-Lift -> SOLVING -> CELEBRATING -> HOLDING
  const solveMovesExecuted: CubeMoveNotation[] = [];
  let sawSolvingTelemetry = false;
  let sawSolvingLed = false;
  let sawCelebratingTilt = false;
  let sawClearHistoryFlag = false;
  let steps = 0;

  while (steps < 4000) {
    const frame = choreo.step(0.02);
    steps += 1;

    if (frame.committedMoves.length > 0) {
      assert.equal(
        frame.committedMovesRecordHistory,
        false,
        'Solve moves must never be appended to scramble moveHistory',
      );
      solveMovesExecuted.push(...frame.committedMoves);
    }
    if (frame.clearHistoryOnFinish) {
      sawClearHistoryFlag = true;
    }

    if (frame.snapshot.state === 'SOLVING') {
      assert.equal(choreo.triggerPrimaryAction(), false);
      assert.equal(choreo.toggleScramble(), false);
      assert.equal(choreo.triggerAutoSolve(recordedHistory), false);
      if (/^SOLVING • \d+ moves? left \([UDLRFB]'?\)$/.test(frame.snapshot.statusLabel)) {
        sawSolvingTelemetry = true;
      }
      if (frame.snapshot.ledMode === 'solving') {
        sawSolvingLed = true;
      }
    }

    if (frame.snapshot.state === 'CELEBRATING') {
      assert.equal(frame.snapshot.statusLabel, 'SOLVED ✓');
      assert.equal(frame.snapshot.ledMode, 'celebrating');
      // Both clamped grippers must stay in exact 1:1 lockstep with cubePitch
      assert.equal(frame.leftAngles.jawOpen, 0);
      assert.equal(frame.rightAngles.jawOpen, 0);
      assert.ok(Math.abs(frame.leftAngles.wristRoll - frame.cubePitch) < 1e-6);
      assert.ok(Math.abs(frame.rightAngles.wristRoll + frame.cubePitch) < 1e-6);
      if (Math.abs(frame.cubePitch) > 0.25) {
        sawCelebratingTilt = true;
      }
    }

    if (frame.snapshot.state === 'HOLDING' && sawClearHistoryFlag) {
      break;
    }
  }

  // Raw history had 8 moves (R U F F' L L L D'); optimized solution collapses F F' and L L L -> D L U' R' (4 moves!)
  assert.deepEqual(solveMovesExecuted, ['D', 'L', "U'", "R'"]);
  assert.equal(sawSolvingTelemetry, true);
  assert.equal(sawSolvingLed, true);
  assert.equal(sawCelebratingTilt, true);
  assert.equal(sawClearHistoryFlag, true);

  const finalSnap = choreo.getSnapshot();
  assert.equal(finalSnap.state, 'HOLDING');
  assert.equal(finalSnap.statusLabel, 'HOLDING — SOLVED ✓');
  assert.equal(finalSnap.isScrambled, false);
  assert.equal(finalSnap.isSolvedBadge, true);
  assert.equal(finalSnap.solveButtonDisabled, true);
  assert.equal(finalSnap.solveButtonLabel, 'Solved');
  assert.equal(finalSnap.primaryButtonDisabled, false);
  assert.equal(finalSnap.scrambleButtonDisabled, false);
  assert.equal(finalSnap.moveHistoryCount, 0);

  assert.deepEqual(seenStates, [
    'STANDBY',
    'APPROACHING',
    'GRIPPING',
    'LIFTING',
    'SCRAMBLING',
    'HOLDING',
    'SCRAMBLING',
    'HOLDING',
    'LOWERING',
    'RELEASING',
    'RETURNING',
    'STANDBY',
    'APPROACHING',
    'GRIPPING',
    'LIFTING',
    'SOLVING',
    'CELEBRATING',
    'HOLDING',
  ]);
});

test('Motion speed multiplier (0.5x, 1x, 2x) scales choreography timing accurately even mid-sequence', () => {
  const measureLiftTime = (speed: 0.5 | 1 | 2): number => {
    const c = new RoboticsChoreography();
    c.setSpeedMultiplier(speed);
    assert.equal(c.getSpeedMultiplier(), speed);
    c.triggerPrimaryAction();
    let elapsed = 0;
    while (c.getState() !== 'HOLDING' && elapsed < 30) {
      c.step(0.01);
      elapsed += 0.01;
    }
    return elapsed;
  };

  const tHalf = measureLiftTime(0.5);
  const tOne = measureLiftTime(1);
  const tDouble = measureLiftTime(2);

  assert.ok(
    Math.abs(tHalf / tOne - 2) < 0.05,
    `Expected 0.5x (${tHalf.toFixed(2)}s) to be ~2x slower than 1x (${tOne.toFixed(2)}s)`,
  );
  assert.ok(
    Math.abs(tOne / tDouble - 2) < 0.05,
    `Expected 2x (${tDouble.toFixed(2)}s) to be ~2x faster than 1x (${tOne.toFixed(2)}s)`,
  );

  // Verify live mid-solve speed switching works without errors or stuck state
  const liveChoreo = new RoboticsChoreography();
  liveChoreo.triggerScramble(['R', 'U', 'F']);
  while (liveChoreo.getState() !== 'HOLDING') {
    liveChoreo.step(0.02);
  }
  assert.equal(liveChoreo.triggerAutoSolve(['R', 'U', 'F']), true);
  liveChoreo.setSpeedMultiplier(0.5);
  liveChoreo.step(0.05);
  assert.equal(liveChoreo.getSnapshot().speedMultiplier, 0.5);
  liveChoreo.setSpeedMultiplier(2);
  assert.equal(liveChoreo.getSnapshot().speedMultiplier, 2);
  while (liveChoreo.getState() !== 'HOLDING') {
    liveChoreo.step(0.02);
  }
  assert.equal(liveChoreo.getSnapshot().statusLabel, 'HOLDING — SOLVED ✓');
});

interface OBB3 {
  label: string;
  center: THREE.Vector3;
  axes: [THREE.Vector3, THREE.Vector3, THREE.Vector3];
  half: [number, number, number];
  radius: number;
}

function makeMockMaterials(): LabMaterialLibrary {
  const mat = new THREE.MeshBasicMaterial();
  return new Proxy({} as LabMaterialLibrary, {
    get: () => mat,
  });
}

interface TrackedMesh {
  mesh: THREE.Mesh;
  label: string;
  localCenter: THREE.Vector3;
  localHalf: [number, number, number];
  checkTabletop: boolean;
}

function collectArmMeshes(arm: RoboticArm): TrackedMesh[] {
  const turret = arm.getObjectByName('BaseTurretYaw');
  const shoulder = arm.getObjectByName('ShoulderPitch');
  assert.ok(turret && shoulder, 'Expected arm hierarchy pivots');

  const tracked: TrackedMesh[] = [];
  const isDescendantOf = (node: THREE.Object3D, ancestor: THREE.Object3D): boolean => {
    let cur: THREE.Object3D | null = node;
    while (cur) {
      if (cur === ancestor) return true;
      cur = cur.parent;
    }
    return false;
  };

  turret.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    obj.geometry.computeBoundingBox();
    const bb = obj.geometry.boundingBox;
    if (!bb) return;
    const localCenter = new THREE.Vector3();
    const localSize = new THREE.Vector3();
    bb.getCenter(localCenter);
    bb.getSize(localSize);
    const parentName = obj.parent?.name || 'anon';
    tracked.push({
      mesh: obj,
      label: `${arm.side}:${parentName}`,
      localCenter,
      localHalf: [localSize.x / 2, localSize.y / 2, localSize.z / 2],
      checkTabletop: isDescendantOf(obj, shoulder),
    });
  });

  return tracked;
}

function buildWorldOBB(item: TrackedMesh): OBB3 {
  const m = item.mesh.matrixWorld;
  const e = m.elements;
  const ax = new THREE.Vector3(e[0], e[1], e[2]);
  const ay = new THREE.Vector3(e[4], e[5], e[6]);
  const az = new THREE.Vector3(e[8], e[9], e[10]);
  const sx = ax.length();
  const sy = ay.length();
  const sz = az.length();
  ax.divideScalar(sx || 1);
  ay.divideScalar(sy || 1);
  az.divideScalar(sz || 1);

  const center = item.localCenter.clone().applyMatrix4(m);
  const hx = item.localHalf[0] * sx;
  const hy = item.localHalf[1] * sy;
  const hz = item.localHalf[2] * sz;

  return {
    label: item.label,
    center,
    axes: [ax, ay, az],
    half: [hx, hy, hz],
    radius: Math.hypot(hx, hy, hz),
  };
}

function buildBoxOBB(
  label: string,
  matrixWorld: THREE.Matrix4,
  localCenter: THREE.Vector3,
  half: [number, number, number],
): OBB3 {
  const e = matrixWorld.elements;
  const ax = new THREE.Vector3(e[0], e[1], e[2]).normalize();
  const ay = new THREE.Vector3(e[4], e[5], e[6]).normalize();
  const az = new THREE.Vector3(e[8], e[9], e[10]).normalize();
  return {
    label,
    center: localCenter.clone().applyMatrix4(matrixWorld),
    axes: [ax, ay, az],
    half,
    radius: Math.hypot(half[0], half[1], half[2]),
  };
}

/**
 * Exact 15-axis 3D Separating Axis Theorem (SAT) OBB-vs-OBB overlap test.
 * Returns positive penetration depth in meters if intersecting, or <= 0 if separated.
 */
function obbOverlapDepth(a: OBB3, b: OBB3): number {
  const dx = b.center.x - a.center.x;
  const dy = b.center.y - a.center.y;
  const dz = b.center.z - a.center.z;
  const distSq = dx * dx + dy * dy + dz * dz;
  const rSum = a.radius + b.radius;
  if (distSq >= rSum * rSum) return -1;

  let minOverlap = Infinity;
  const testAxis = (nx: number, ny: number, nz: number): boolean => {
    const lenSq = nx * nx + ny * ny + nz * nz;
    if (lenSq < 1e-10) return true;
    const invLen = 1 / Math.sqrt(lenSq);
    const ux = nx * invLen;
    const uy = ny * invLen;
    const uz = nz * invLen;

    const projDist = Math.abs(dx * ux + dy * uy + dz * uz);
    const rA =
      Math.abs(a.axes[0].x * ux + a.axes[0].y * uy + a.axes[0].z * uz) * a.half[0] +
      Math.abs(a.axes[1].x * ux + a.axes[1].y * uy + a.axes[1].z * uz) * a.half[1] +
      Math.abs(a.axes[2].x * ux + a.axes[2].y * uy + a.axes[2].z * uz) * a.half[2];
    const rB =
      Math.abs(b.axes[0].x * ux + b.axes[0].y * uy + b.axes[0].z * uz) * b.half[0] +
      Math.abs(b.axes[1].x * ux + b.axes[1].y * uy + b.axes[1].z * uz) * b.half[1] +
      Math.abs(b.axes[2].x * ux + b.axes[2].y * uy + b.axes[2].z * uz) * b.half[2];

    const overlap = rA + rB - projDist;
    if (overlap <= 0) return false;
    if (overlap < minOverlap) minOverlap = overlap;
    return true;
  };

  // 3 face normals of A
  for (let i = 0; i < 3; i++) {
    if (!testAxis(a.axes[i].x, a.axes[i].y, a.axes[i].z)) return 0;
  }
  // 3 face normals of B
  for (let j = 0; j < 3; j++) {
    if (!testAxis(b.axes[j].x, b.axes[j].y, b.axes[j].z)) return 0;
  }
  // 9 cross products of edges
  for (let i = 0; i < 3; i++) {
    const ai = a.axes[i];
    for (let j = 0; j < 3; j++) {
      const bj = b.axes[j];
      const cx = ai.y * bj.z - ai.z * bj.y;
      const cy = ai.z * bj.x - ai.x * bj.z;
      const cz = ai.x * bj.y - ai.y * bj.x;
      if (!testAxis(cx, cy, cz)) return 0;
    }
  }

  return minOverlap;
}

function obbMinY(o: OBB3): number {
  return (
    o.center.y -
    (Math.abs(o.axes[0].y) * o.half[0] +
      Math.abs(o.axes[1].y) * o.half[1] +
      Math.abs(o.axes[2].y) * o.half[2])
  );
}

test('3D mesh SAT collision audit: zero arm-to-arm overlap, zero cube clipping, and tabletop clearance across Pick Up, all 12 moves, Celebration, and Put Down', () => {
  const materials = makeMockMaterials();
  const leftArm = new RoboticArm('left', materials);
  const rightArm = new RoboticArm('right', materials);
  const leftTracked = collectArmMeshes(leftArm);
  const rightTracked = collectArmMeshes(rightArm);

  const choreo = new RoboticsChoreography();
  const all12: CubeMoveNotation[] = [
    'L', "L'", 'R', "R'", 'U', "U'", 'D', "D'", 'F', "F'", 'B', "B'",
  ];

  // Cube body half-extent shrunk by 0.6mm from CUBE_OUTER_HALF (0.107m -> 0.1064m,
  // right at actual outer beveled tile surface 0.10653m) so flush clamping passes while
  // any penetration into the cube body or stickers triggers an immediate failure.
  const CUBE_COLLISION_HALF = 0.1062;
  const LAYER_THICKNESS_HALF = 0.035; // 70mm outer slice

  const cubeMatrix = new THREE.Matrix4();
  const cubePos = new THREE.Vector3();
  const cubeEuler = new THREE.Euler();
  const cubeQuat = new THREE.Quaternion();
  const unitScale = new THREE.Vector3(1, 1, 1);

  const layerPivotMatrix = new THREE.Matrix4();
  const layerRotQuat = new THREE.Quaternion();
  const layerAxisVec = new THREE.Vector3();

  let worstArmOverlap = 0;
  let worstArmDetail = '';
  let worstCubeOverlap = 0;
  let worstCubeDetail = '';
  let lowestArmY = Infinity;
  let lowestArmDetail = '';
  let framesChecked = 0;

  const auditFrame = (frame: ReturnType<RoboticsChoreography['evaluateFrame']>) => {
    framesChecked += 1;
    leftArm.applyJointAngles(frame.leftAngles);
    rightArm.applyJointAngles(frame.rightAngles);
    leftArm.updateMatrixWorld(true);
    rightArm.updateMatrixWorld(true);

    const leftOBBs = leftTracked.map((t) => ({t, obb: buildWorldOBB(t)}));
    const rightOBBs = rightTracked.map((t) => ({t, obb: buildWorldOBB(t)}));
    const contextTag = `${frame.snapshot.state} (${frame.snapshot.statusLabel})`;

    // 1. Outward elbow orientation invariant
    const leftFk = computeForwardKinematics('left', frame.leftAngles);
    const rightFk = computeForwardKinematics('right', frame.rightAngles);
    assert.ok(
      leftFk.elbow.x < -0.15,
      `Left elbow crossed inward at ${contextTag}: elbow.x=${leftFk.elbow.x.toFixed(4)}`,
    );
    assert.ok(
      rightFk.elbow.x > 0.15,
      `Right elbow crossed inward at ${contextTag}: elbow.x=${rightFk.elbow.x.toFixed(4)}`,
    );

    // 2. Strict tabletop clearance for every shoulder/elbow/wrist/jaw mesh
    for (const group of [leftOBBs, rightOBBs]) {
      for (const {t, obb} of group) {
        if (!t.checkTabletop) continue;
        const minY = obbMinY(obb);
        if (minY < lowestArmY) {
          lowestArmY = minY;
          lowestArmDetail = `${obb.label} at ${contextTag}`;
        }
      }
    }

    // 3. Zero arm-to-arm 3D mesh overlap (all moving left parts vs all moving right parts)
    for (const l of leftOBBs) {
      for (const r of rightOBBs) {
        const overlap = obbOverlapDepth(l.obb, r.obb);
        if (overlap > worstArmOverlap) {
          worstArmOverlap = overlap;
          worstArmDetail = `${l.obb.label} vs ${r.obb.label} (${(overlap * 1000).toFixed(2)}mm) at ${contextTag}`;
        }
      }
    }

    // 4. Zero arm-to-cube clipping (accounts for cube position, yaw, pitch, and active turning slice!)
    cubePos.set(frame.cubePosition.x, frame.cubePosition.y, frame.cubePosition.z);
    cubeEuler.set(frame.cubePitch, frame.cubeYaw, 0, 'XYZ');
    cubeQuat.setFromEuler(cubeEuler);
    cubeMatrix.compose(cubePos, cubeQuat, unitScale);

    if (!frame.activeFaceTurn) {
      const cubeOBB = buildBoxOBB(
        'RubiksCube',
        cubeMatrix,
        new THREE.Vector3(0, 0, 0),
        [CUBE_COLLISION_HALF, CUBE_COLLISION_HALF, CUBE_COLLISION_HALF],
      );
      for (const item of [...leftOBBs, ...rightOBBs]) {
        const overlap = obbOverlapDepth(item.obb, cubeOBB);
        if (overlap > worstCubeOverlap) {
          worstCubeOverlap = overlap;
          worstCubeDetail = `${item.obb.label} vs Cube (${(overlap * 1000).toFixed(2)}mm) at ${contextTag}`;
        }
      }
    } else {
      // During an active face twist, split cube into:
      //  (a) the 2 stationary layers (width 140mm along twist axis)
      //  (b) the 1 rotating layer (width 70mm, rotated by live angle)
      const spec = getMoveSpec(frame.activeFaceTurn.move);
      const angle = spec.angleRad * frame.activeFaceTurn.easedProgress;
      layerAxisVec.set(
        spec.axis === 'x' ? 1 : 0,
        spec.axis === 'y' ? 1 : 0,
        spec.axis === 'z' ? 1 : 0,
      );
      layerRotQuat.setFromAxisAngle(layerAxisVec, angle);
      layerPivotMatrix.makeRotationFromQuaternion(layerRotQuat);
      const rotLayerWorld = cubeMatrix.clone().multiply(layerPivotMatrix);

      const stationaryCenter = layerAxisVec.clone().multiplyScalar(-spec.layer * LAYER_THICKNESS_HALF);
      const stationaryHalf: [number, number, number] = [
        spec.axis === 'x' ? CUBE_COLLISION_HALF - LAYER_THICKNESS_HALF : CUBE_COLLISION_HALF,
        spec.axis === 'y' ? CUBE_COLLISION_HALF - LAYER_THICKNESS_HALF : CUBE_COLLISION_HALF,
        spec.axis === 'z' ? CUBE_COLLISION_HALF - LAYER_THICKNESS_HALF : CUBE_COLLISION_HALF,
      ];
      const stationaryOBB = buildBoxOBB('CubeStationary2Layers', cubeMatrix, stationaryCenter, stationaryHalf);

      const turningCenter = layerAxisVec
        .clone()
        .multiplyScalar(spec.layer * (CUBE_COLLISION_HALF - LAYER_THICKNESS_HALF));
      const turningHalf: [number, number, number] = [
        spec.axis === 'x' ? LAYER_THICKNESS_HALF : CUBE_COLLISION_HALF,
        spec.axis === 'y' ? LAYER_THICKNESS_HALF : CUBE_COLLISION_HALF,
        spec.axis === 'z' ? LAYER_THICKNESS_HALF : CUBE_COLLISION_HALF,
      ];
      const turningOBB = buildBoxOBB('CubeTurningLayer', rotLayerWorld, turningCenter, turningHalf);

      for (const item of [...leftOBBs, ...rightOBBs]) {
        const o1 = obbOverlapDepth(item.obb, stationaryOBB);
        if (o1 > worstCubeOverlap) {
          worstCubeOverlap = o1;
          worstCubeDetail = `${item.obb.label} vs StationaryLayers (${(o1 * 1000).toFixed(2)}mm) at ${contextTag}`;
        }
        const o2 = obbOverlapDepth(item.obb, turningOBB);
        if (o2 > worstCubeOverlap) {
          worstCubeOverlap = o2;
          worstCubeDetail = `${item.obb.label} vs TurningLayer (${(o2 * 1000).toFixed(2)}mm) at ${contextTag}`;
        }
      }
    }
  };

  // Audit initial STANDBY frame
  auditFrame(choreo.evaluateFrame());

  // Audit Pick Up + all 12 face moves
  assert.equal(choreo.triggerScramble(all12), true);
  let steps = 0;
  while (choreo.getState() !== 'HOLDING' && steps < 6000) {
    auditFrame(choreo.step(0.01));
    steps += 1;
  }
  assert.equal(choreo.getState(), 'HOLDING');

  // Audit Auto-Solve + Celebration flourish
  assert.equal(choreo.triggerAutoSolve(['R', 'U', 'F', 'D', 'L', 'B']), true);
  steps = 0;
  while (steps < 6000) {
    const f = choreo.step(0.01);
    auditFrame(f);
    steps += 1;
    if (f.snapshot.state === 'HOLDING' && f.snapshot.isSolvedBadge) break;
  }
  assert.equal(choreo.getState(), 'HOLDING');

  // Audit Put Down back to STANDBY
  assert.equal(choreo.triggerPrimaryAction(), true);
  steps = 0;
  while (choreo.getState() !== 'STANDBY' && steps < 2000) {
    auditFrame(choreo.step(0.01));
    steps += 1;
  }
  assert.equal(choreo.getState(), 'STANDBY');

  assert.ok(framesChecked > 2500, `Expected dense audit, checked ${framesChecked} frames`);
  assert.equal(
    worstArmOverlap,
    0,
    `Detected arm-to-arm 3D mesh overlap: ${worstArmDetail}`,
  );
  assert.equal(
    worstCubeOverlap,
    0,
    `Detected arm-to-cube 3D mesh clipping: ${worstCubeDetail}`,
  );
  assert.ok(
    lowestArmY > LAB_DIMENSIONS.TABLE_TOP_Y + 0.03,
    `Arm mesh dipped too close to tabletop (${LAB_DIMENSIONS.TABLE_TOP_Y}m): minY=${lowestArmY.toFixed(4)}m (${lowestArmDetail})`,
  );

  leftArm.dispose();
  rightArm.dispose();
});




