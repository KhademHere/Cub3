export type MachineState =
  | 'STANDBY'
  | 'APPROACHING'
  | 'GRIPPING'
  | 'LIFTING'
  | 'HOLDING'
  | 'LOWERING'
  | 'RELEASING'
  | 'RETURNING';

export type ArmLedMode = 'idle' | 'moving' | 'gripping';

export type ArmSide = 'left' | 'right';

export type FaceAxis = 'x' | 'y' | 'z';
export type FaceLayer = -1 | 0 | 1;

export interface CubieCoord {
  x: FaceLayer;
  y: FaceLayer;
  z: FaceLayer;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface ArmJointAngles {
  /** Turret yaw rotation around Y axis (radians). 0 points toward cube along ±X. */
  baseYaw: number;
  /** Shoulder elevation angle measured from horizontal inward direction (radians). */
  shoulderPitch: number;
  /** Relative elbow pitch angle from lower boom to forearm (radians, negative bends downward). */
  elbowPitch: number;
  /** Relative wrist pitch angle keeping the gripper level in world space (radians). */
  wristPitch: number;
  /** Wrist roll around the gripper's inward X axis (radians) — ready for Parts 2 & 3 twists. */
  wristRoll: number;
  /** Normalized jaw opening: 0 = exact clamp contact on cube, 1 = fully open standby. */
  jawOpen: number;
}

export interface MachineSnapshot {
  state: MachineState;
  statusLabel: string;
  ledMode: ArmLedMode;
  isBusy: boolean;
  isHolding: boolean;
  primaryButtonLabel: string;
  phaseProgress: number;
}

export const MACHINE_STATUS_LABELS: Record<MachineState, string> = {
  STANDBY: 'STANDBY',
  APPROACHING: 'APPROACHING',
  GRIPPING: 'GRIPPING',
  LIFTING: 'GRIPPING — LIFTING',
  HOLDING: 'HOLDING — READY',
  LOWERING: 'GRIPPING — LOWERING',
  RELEASING: 'RELEASING',
  RETURNING: 'RETURNING',
};

export function getArmLedMode(state: MachineState): ArmLedMode {
  switch (state) {
    case 'STANDBY':
      return 'idle';
    case 'APPROACHING':
    case 'RELEASING':
    case 'RETURNING':
      return 'moving';
    case 'GRIPPING':
    case 'LIFTING':
    case 'HOLDING':
    case 'LOWERING':
      return 'gripping';
  }
}

export function isMachineBusy(state: MachineState): boolean {
  return state !== 'STANDBY' && state !== 'HOLDING';
}
