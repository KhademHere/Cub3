import type {ArmJointAngles, ArmSide, Vec3} from './types';

/**
 * Shared physical dimensions (in meters) for the workbench, Rubik's Cube,
 * and symmetrical 6-axis industrial robotic manipulator arms.
 */
export const LAB_DIMENSIONS = {
  /** Top surface of the industrial workbench table (ergonomic standing height). */
  TABLE_TOP_Y: 0.85,
  /** Z center of the workbench pad in XR world space (in front of user origin). */
  TABLE_CENTER_Z: -1.05,
  /** Nominal inner body side length of the 3x3x3 Rubik's Cube (21 cm display scale). */
  CUBE_SIZE: 0.21,
  /** Half nominal body side length of the Rubik's Cube. */
  CUBE_HALF: 0.105,
  /**
   * Exact outer half-width including extruded glossy sticker tiles + bevel (0.10653m)
   * plus a 0.47mm anti-z-fighting epsilon so clamped rubber pads sit mathematically flush.
   */
  CUBE_OUTER_HALF: 0.107,
  /** Exact assembled outer cube width across opposing tile surfaces. */
  CUBE_OUTER_SIZE: 0.214,
  /** Slight height of the recessed pad floor above the tabletop surface. */
  PAD_SURFACE_OFFSET: 0.003,
  /** Cube center Y when resting neatly on the center pad (tiles flush on pad). */
  CUBE_REST_Y: 0.85 + 0.003 + 0.107,
  /** Cube center Y when lifted to the central hovering "Ready Position". */
  CUBE_HOLD_Y: 0.85 + 0.36,
  /** Symmetrical X offset of the left (-X) and right (+X) arm base turrets. */
  ARM_BASE_X: 0.56,
  /** Height from workbench tabletop to the shoulder pitch pivot axis. */
  SHOULDER_HEIGHT: 0.16,
  /** Length of the heavy lower arm boom (shoulder axis to elbow axis). */
  LOWER_BOOM_LENGTH: 0.36,
  /** Length of the forearm strut (elbow axis to wrist pitch axis). */
  FOREARM_LENGTH: 0.32,
  /** Distance from wrist pitch pivot to the gripper's center contact plane along inward axis. */
  GRIPPER_REACH: 0.118,
  /** Extra outward clearance (meters) per jaw finger when jawOpen = 1 (clears cube diagonal). */
  JAW_MAX_OPEN_OFFSET: 0.048,
  /** Depth that each jaw finger reaches inward past the contact plane (strictly within 70mm outer layer). */
  JAW_FINGER_OVERLAP: 0.028,
} as const;

export function clamp01(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t;
}

/** Smooth C1 ease-in-out cubic curve for mechanical acceleration/deceleration. */
export function easeInOutCubic(t: number): number {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/** Ultra-smooth C2 ease-in-out quintic curve (zero acceleration at start and stop). */
export function easeInOutQuint(t: number): number {
  const x = clamp01(t);
  return x < 0.5
    ? 16 * x * x * x * x * x
    : 1 - Math.pow(-2 * x + 2, 5) / 2;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Evaluates a cubic Bézier curve at parameter t ∈ [0, 1]. */
export function evalCubicBezier3(
  p0: Vec3,
  p1: Vec3,
  p2: Vec3,
  p3: Vec3,
  t: number,
  out: Vec3 = {x: 0, y: 0, z: 0},
): Vec3 {
  const u = 1 - t;
  const tt = t * t;
  const uu = u * u;
  const uuu = uu * u;
  const ttt = tt * t;
  const c1 = 3 * uu * t;
  const c2 = 3 * u * tt;

  out.x = uuu * p0.x + c1 * p1.x + c2 * p2.x + ttt * p3.x;
  out.y = uuu * p0.y + c1 * p1.y + c2 * p2.y + ttt * p3.y;
  out.z = uuu * p0.z + c1 * p1.z + c2 * p2.z + ttt * p3.z;
  return out;
}

/**
 * Returns the inner face separation between the two parallel rubberized jaw pads
 * for a given normalized jawOpen ∈ [0, 1].
 * At jawOpen = 0, separation equals CUBE_OUTER_SIZE exactly (flush on outer tile faces, zero clipping).
 */
export function getJawInnerSeparation(jawOpen: number): number {
  const open = clamp01(jawOpen);
  return (
    LAB_DIMENSIONS.CUBE_OUTER_SIZE +
    open * 2 * LAB_DIMENSIONS.JAW_MAX_OPEN_OFFSET
  );
}

/**
 * Computes the arm base origin in world coordinates.
 */
export function getArmBasePosition(side: ArmSide): Vec3 {
  return {
    x: side === 'left' ? -LAB_DIMENSIONS.ARM_BASE_X : LAB_DIMENSIONS.ARM_BASE_X,
    y: LAB_DIMENSIONS.TABLE_TOP_Y,
    z: LAB_DIMENSIONS.TABLE_CENTER_Z,
  };
}

/**
 * Analytical 2-link planar + turret yaw Inverse Kinematics solver for each industrial arm.
 *
 * Coordinate convention:
 * - Each arm sits at `(±ARM_BASE_X, TABLE_TOP_Y, TABLE_CENTER_Z)`.
 * - Its inward direction toward the cube is `+X` for the left arm (`inwardSign = +1`)
 *   and `-X` for the right arm (`inwardSign = -1`).
 * - The target `contactWorldPos` is the exact world position of the gripper's
 *   center face contact pad (facing inward toward the cube's left or right center face).
 * - The wrist pitch keeps the gripper angled at `gripperWorldPitch` (default `0`, dead-level
 *   horizontal so the gripper aligns flush with the cube's ±X face).
 */
export function solveArmIK(
  side: ArmSide,
  contactWorldPos: Vec3,
  options: {
    jawOpen?: number;
    wristRoll?: number;
    gripperWorldPitch?: number;
  } = {},
): ArmJointAngles {
  const jawOpen = clamp01(options.jawOpen ?? 1);
  const wristRoll = options.wristRoll ?? 0;
  const gripperWorldPitch = options.gripperWorldPitch ?? 0;

  const base = getArmBasePosition(side);
  const inwardSign = side === 'left' ? 1 : -1;

  // Vector from base center to desired gripper contact center in world XZ
  const dxWorld = contactWorldPos.x - base.x;
  const dzWorld = contactWorldPos.z - base.z;

  // Express horizontal displacement in arm-local inward frame:
  // forward = inward toward cube, lateral = orthogonal in XZ
  const forward = dxWorld * inwardSign;
  const lateral = dzWorld;

  // Turret yaw rotates the arm's vertical reach plane toward the target in XZ
  // For left arm (+X inward), rotating around +Y by yaw moves +X toward -Z:
  //   x' = cos(yaw), z' = -sin(yaw)  =>  yaw = atan2(-lateral, forward)
  // For right arm (-X inward), rotating around +Y by yaw moves -X toward +Z:
  //   x' = -cos(yaw), z' = sin(yaw)  =>  yaw = atan2(lateral, forward)
  const baseYaw =
    side === 'left'
      ? Math.atan2(-lateral, Math.max(0.001, forward))
      : Math.atan2(lateral, Math.max(0.001, forward));

  const radialToContact = Math.hypot(forward, lateral);

  // Back off from the gripper contact pad along the gripper's axis to locate the wrist pitch pivot
  const wristRadial =
    radialToContact - LAB_DIMENSIONS.GRIPPER_REACH * Math.cos(gripperWorldPitch);
  const shoulderY = base.y + LAB_DIMENSIONS.SHOULDER_HEIGHT;
  const wristY =
    contactWorldPos.y -
    shoulderY -
    LAB_DIMENSIONS.GRIPPER_REACH * Math.sin(gripperWorldPitch);

  const L1 = LAB_DIMENSIONS.LOWER_BOOM_LENGTH;
  const L2 = LAB_DIMENSIONS.FOREARM_LENGTH;

  // Clamp reach safely within physical arm envelope to avoid NaN
  const minReach = Math.abs(L1 - L2) + 0.01;
  const maxReach = L1 + L2 - 0.005;
  const rawDist = Math.hypot(wristRadial, wristY);
  const dist = Math.min(maxReach, Math.max(minReach, rawDist));

  const scale = rawDist > 1e-6 ? dist / rawDist : 1;
  const rClamped = wristRadial * scale;
  const yClamped = wristY * scale;

  // Law of cosines for elbow-up industrial robot configuration
  const cosElbow = Math.max(
    -1,
    Math.min(1, (dist * dist - L1 * L1 - L2 * L2) / (2 * L1 * L2)),
  );
  // Negative elbowPitch bends forearm downward from the elevated lower boom (elbow-up)
  const elbowPitch = -Math.acos(cosElbow);

  const targetAngle = Math.atan2(yClamped, rClamped);
  const k1 = L1 + L2 * Math.cos(elbowPitch);
  const k2 = L2 * Math.sin(elbowPitch);
  const shoulderPitch = targetAngle - Math.atan2(k2, k1);

  // Keep the gripper oriented at gripperWorldPitch in the arm's vertical plane
  const wristPitch = gripperWorldPitch - (shoulderPitch + elbowPitch);

  return {
    baseYaw,
    shoulderPitch,
    elbowPitch,
    wristPitch,
    wristRoll,
    jawOpen,
  };
}

/**
 * Forward Kinematics matching the exact joint hierarchy of RoboticArm.
 * Used for deterministic verification tests ensuring zero IK/FK drift.
 */
export function computeForwardKinematics(
  side: ArmSide,
  angles: ArmJointAngles,
): {
  shoulder: Vec3;
  elbow: Vec3;
  wrist: Vec3;
  contactPad: Vec3;
} {
  const base = getArmBasePosition(side);
  const inwardSign = side === 'left' ? 1 : -1;

  const L1 = LAB_DIMENSIONS.LOWER_BOOM_LENGTH;
  const L2 = LAB_DIMENSIONS.FOREARM_LENGTH;
  const Lg = LAB_DIMENSIONS.GRIPPER_REACH;

  const a1 = angles.shoulderPitch;
  const a2 = a1 + angles.elbowPitch;
  const a3 = a2 + angles.wristPitch;

  const r1 = L1 * Math.cos(a1);
  const y1 = L1 * Math.sin(a1);

  const r2 = r1 + L2 * Math.cos(a2);
  const y2 = y1 + L2 * Math.sin(a2);

  const r3 = r2 + Lg * Math.cos(a3);
  const y3 = y2 + Lg * Math.sin(a3);

  const cosY = Math.cos(angles.baseYaw);
  const sinY = Math.sin(angles.baseYaw);

  const toWorld = (radial: number, relY: number): Vec3 => {
    const x = base.x + inwardSign * radial * cosY;
    const z =
      side === 'left'
        ? base.z - radial * sinY
        : base.z + radial * sinY;
    return {
      x,
      y: base.y + LAB_DIMENSIONS.SHOULDER_HEIGHT + relY,
      z,
    };
  };

  return {
    shoulder: toWorld(0, 0),
    elbow: toWorld(r1, y1),
    wrist: toWorld(r2, y2),
    contactPad: toWorld(r3, y3),
  };
}
