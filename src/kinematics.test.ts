import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LAB_DIMENSIONS,
  computeForwardKinematics,
  easeInOutCubic,
  easeInOutQuint,
  evalCubicBezier3,
  getJawInnerSeparation,
  solveArmIK,
} from './kinematics';

test('easing curves hit exact endpoints and stay monotonic', () => {
  for (const ease of [easeInOutCubic, easeInOutQuint]) {
    assert.equal(ease(0), 0);
    assert.equal(ease(0.5), 0.5);
    assert.equal(ease(1), 1);
    assert.equal(ease(-0.5), 0);
    assert.equal(ease(1.5), 1);

    let prev = 0;
    for (let i = 1; i <= 40; i++) {
      const cur = ease(i / 40);
      assert.ok(cur >= prev, `Expected monotonic increase at step ${i}`);
      prev = cur;
    }
  }
});

test('analytical IK + FK round-trip matches exact contact targets for both arms', () => {
  const z = LAB_DIMENSIONS.TABLE_CENTER_Z;
  const half = LAB_DIMENSIONS.CUBE_HALF;

  const testCases = [
    {
      name: 'standby left',
      side: 'left' as const,
      target: {x: -0.305, y: LAB_DIMENSIONS.CUBE_REST_Y + 0.255, z: z - 0.035},
      pitch: -0.14,
    },
    {
      name: 'standby right',
      side: 'right' as const,
      target: {x: 0.305, y: LAB_DIMENSIONS.CUBE_REST_Y + 0.255, z: z - 0.035},
      pitch: -0.14,
    },
    {
      name: 'clamp on table left',
      side: 'left' as const,
      target: {x: -half, y: LAB_DIMENSIONS.CUBE_REST_Y, z},
      pitch: 0,
    },
    {
      name: 'clamp on table right',
      side: 'right' as const,
      target: {x: half, y: LAB_DIMENSIONS.CUBE_REST_Y, z},
      pitch: 0,
    },
    {
      name: 'hovering ready left',
      side: 'left' as const,
      target: {x: -half, y: LAB_DIMENSIONS.CUBE_HOLD_Y, z},
      pitch: 0,
    },
    {
      name: 'hovering ready right',
      side: 'right' as const,
      target: {x: half, y: LAB_DIMENSIONS.CUBE_HOLD_Y, z},
      pitch: 0,
    },
  ];

  for (const tc of testCases) {
    const angles = solveArmIK(tc.side, tc.target, {
      jawOpen: 0,
      gripperWorldPitch: tc.pitch,
    });
    const fk = computeForwardKinematics(tc.side, angles);

    const err = Math.hypot(
      fk.contactPad.x - tc.target.x,
      fk.contactPad.y - tc.target.y,
      fk.contactPad.z - tc.target.z,
    );
    assert.ok(
      err < 1e-4,
      `${tc.name}: expected FK contact error < 1e-4m, got ${err}`,
    );
    // Elbow must always stay above the tabletop (elbow-up industrial posture)
    assert.ok(
      fk.elbow.y > LAB_DIMENSIONS.TABLE_TOP_Y + 0.2,
      `${tc.name}: expected elbow-up posture above table, got y=${fk.elbow.y}`,
    );
  }
});

test('parallel jaw separation makes exact cube contact at jawOpen=0 and clears cube when open', () => {
  assert.equal(getJawInnerSeparation(0), LAB_DIMENSIONS.CUBE_SIZE);
  assert.ok(getJawInnerSeparation(1) > LAB_DIMENSIONS.CUBE_SIZE + 0.06);
});

test('cubic Bezier interpolation starts and ends at anchor points', () => {
  const p0 = {x: -0.3, y: 1.2, z: -1.1};
  const p1 = {x: -0.25, y: 1.25, z: -1.06};
  const p2 = {x: -0.18, y: 1.0, z: -1.05};
  const p3 = {x: -0.127, y: 0.958, z: -1.05};

  assert.deepEqual(evalCubicBezier3(p0, p1, p2, p3, 0), p0);
  assert.deepEqual(evalCubicBezier3(p0, p1, p2, p3, 1), p3);
});
