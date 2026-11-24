import type {CubeMoveNotation} from './cubeMoves';

export type MachineState =
  | 'STANDBY'
  | 'APPROACHING'
  | 'GRIPPING'
  | 'LIFTING'
  | 'HOLDING'
  | 'SCRAMBLING'
  | 'LOWERING'
  | 'RELEASING'
  | 'RETURNING';

export type ArmLedMode = 'idle' | 'moving' | 'gripping' | 'scrambling';

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
  /** Relative wrist pitch angle keeping the gripper aligned in world space (radians). */
  wristPitch: number;
  /** Wrist roll around the gripper's inward axis (radians). */
  wristRoll: number;
  /** Normalized jaw opening: 0 = exact clamp contact on cube, 1 = fully open standby. */
  jawOpen: number;
}

export type ScrambleButtonMode = 'start' | 'stop' | 'busy';

export interface ScrambleProgress {
  /** 1-based open-ended live move number across scramble sessions. */
  moveNumber: number;
  currentMove: CubeMoveNotation;
  isStopping: boolean;
}

export interface MachineSnapshot {
  state: MachineState;
  statusLabel: string;
  ledMode: ArmLedMode;
  isBusy: boolean;
  isHolding: boolean;
  isScrambled: boolean;
  isScrambling: boolean;
  isStoppingScramble: boolean;
  primaryButtonLabel: string;
  primaryButtonDisabled: boolean;
  scrambleButtonLabel: string;
  scrambleButtonMode: ScrambleButtonMode;
  scrambleButtonDisabled: boolean;
  phaseProgress: number;
  scrambleProgress: ScrambleProgress | null;
  moveHistoryCount: number;
}

export const MACHINE_STATUS_LABELS: Record<MachineState, string> = {
  STANDBY: 'STANDBY',
  APPROACHING: 'APPROACHING',
  GRIPPING: 'GRIPPING',
  LIFTING: 'GRIPPING — LIFTING',
  HOLDING: 'HOLDING — READY',
  SCRAMBLING: 'SCRAMBLING',
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
    case 'SCRAMBLING':
      return 'scrambling';
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
