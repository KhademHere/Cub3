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
  assert.ok(Math.abs(leftFk.contactPad.x + LAB_DIMENSIONS.CUBE_HALF) < 1e-3);
  assert.ok(Math.abs(rightFk.contactPad.x - LAB_DIMENSIONS.CUBE_HALF) < 1e-3);

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


