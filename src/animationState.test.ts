import assert from 'node:assert/strict';
import test from 'node:test';

import {DEFAULT_DURATIONS, RoboticsChoreography} from './animationState';
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
