import assert from 'node:assert/strict';
import test from 'node:test';

import {DEFAULT_DURATIONS, RoboticsChoreography} from './animationState';
import type {CubeMoveNotation} from './cubeMoves';
import {LAB_DIMENSIONS, computeForwardKinematics} from './kinematics';
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
  assert.ok(Math.abs(leftFk.contactPad.x + LAB_DIMENSIONS.CUBE_HALF) < 1e-3);
  assert.ok(Math.abs(rightFk.contactPad.x - LAB_DIMENSIONS.CUBE_HALF) < 1e-3);
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
        Math.abs(distL - LAB_DIMENSIONS.CUBE_HALF) < 2e-3,
        `Left contact pad drifted during ${frame.activeFaceTurn.move}: dist=${distL}`,
      );
      assert.ok(
        Math.abs(distR - LAB_DIMENSIONS.CUBE_HALF) < 2e-3,
        `Right contact pad drifted during ${frame.activeFaceTurn.move}: dist=${distR}`,
      );
    }
  }

  assert.equal(choreo.getState(), 'HOLDING');
  assert.equal(twistsObserved, 12);
});

