import * as THREE from 'three';

import {RoboticsChoreography} from './animationState';
import {getMoveSpec, type CubeMoveNotation} from './cubeMoves';
import type {RoboticArm} from './RoboticArm';
import type {RubiksCube} from './RubiksCube';
import type {ServoAudio} from './ServoAudio';
import type {MachineSnapshot, MachineState, MotionSpeed} from './types';

export interface AnimationControllerConfig {
  leftArm: RoboticArm;
  rightArm: RoboticArm;
  rubiksCube: RubiksCube;
  cubeShadowMesh: THREE.Mesh;
  audio: ServoAudio;
}

/**
 * Coordinates the RoboticsChoreography state machine with the 3D RoboticArms,
 * RubiksCube face-turn pivot engine, dynamic tabletop contact shadow, and procedural servo audio.
 */
export class AnimationController {
  public readonly choreography: RoboticsChoreography;
  private readonly leftArm: RoboticArm;
  private readonly rightArm: RoboticArm;
  private readonly rubiksCube: RubiksCube;
  private readonly cubeShadowMesh: THREE.Mesh;
  private readonly audio: ServoAudio;

  private lastState: MachineState = 'STANDBY';
  private activeTurnId = -1;
  private unsubscribeAudio: () => void;

  constructor(config: AnimationControllerConfig) {
    this.leftArm = config.leftArm;
    this.rightArm = config.rightArm;
    this.rubiksCube = config.rubiksCube;
    this.cubeShadowMesh = config.cubeShadowMesh;
    this.audio = config.audio;

    this.choreography = new RoboticsChoreography();
    this.unsubscribeAudio = this.choreography.subscribe((snapshot) => {
      if (snapshot.state !== this.lastState) {
        this.lastState = snapshot.state;
        this.audio.playTransitionCue(snapshot.state);
      }
      this.leftArm.setLedMode(snapshot.ledMode);
      this.rightArm.setLedMode(snapshot.ledMode);
    });

    // Apply initial poised standby pose immediately on frame 0
    this.applyFrame(this.choreography.evaluateFrame(), 0.016);
  }

  getSnapshot(): MachineSnapshot {
    return this.choreography.getSnapshot();
  }

  subscribe(listener: (snapshot: MachineSnapshot) => void): () => void {
    return this.choreography.subscribe(listener);
  }

  /** Triggers Pick Up or Put Down depending on whether the cube is currently held. */
  togglePickUpPutDown(): boolean {
    this.audio.unlock();
    return this.choreography.triggerPrimaryAction();
  }

  /**
   * Toggles indefinite continuous scrambling ("Scramble" ↔ "Stop Scramble"):
   * auto-lifts from STANDBY, resumes smoothly from HOLDING, or requests a graceful stop if active.
   */
  toggleScramble(): boolean {
    this.audio.unlock();
    return this.choreography.toggleScramble();
  }

  /** Requests a graceful stop after the currently executing face turn finishes. */
  requestStopScramble(): boolean {
    return this.choreography.requestStopScramble();
  }

  /**
   * Triggers either continuous scrambling or an explicit deterministic move queue.
   * Automatically lifts the cube first if currently resting in STANDBY.
   */
  triggerScramble(customSequence?: CubeMoveNotation[]): boolean {
    this.audio.unlock();
    return this.choreography.triggerScramble(customSequence);
  }

  /**
   * Reads the accumulated moveHistory from RubiksCube, computes an optimized
   * deterministic solution, and executes it (auto-lifting first if in STANDBY).
   */
  triggerAutoSolve(): boolean {
    this.audio.unlock();
    const history = this.rubiksCube.getMoveHistory();
    return this.choreography.triggerAutoSolve(history);
  }

  /** Updates live playback speed multiplier (0.5x, 1x, 2x) even mid-sequence. */
  setSpeedMultiplier(speed: MotionSpeed): void {
    this.choreography.setSpeedMultiplier(speed);
  }

  getSpeedMultiplier(): MotionSpeed {
    return this.choreography.getSpeedMultiplier();
  }

  isCubeSolved(): boolean {
    return this.rubiksCube.isSolved();
  }

  canRunCubeMoves(): boolean {
    return this.choreography.canPerformCubeMove();
  }

  /** Advances choreography and updates all 3D transforms with zero per-frame allocations. */
  update(dt: number): void {
    const safeDt = Math.max(0, Math.min(dt, 0.25));
    const frame = this.choreography.step(safeDt);
    this.applyFrame(frame, safeDt);
  }

  private applyFrame(
    frame: ReturnType<RoboticsChoreography['evaluateFrame']>,
    dt: number,
  ): void {
    const recordHistory = frame.committedMovesRecordHistory;

    // 1. Commit any face turns that finished during this frame step (zero skipped moves)
    for (const completedMove of frame.committedMoves) {
      if (this.activeTurnId === -1) {
        // Move started and finished inside a single large dt step
        this.rubiksCube.applyMoveInstant(completedMove, recordHistory);
      } else {
        this.rubiksCube.commitActiveMove(recordHistory);
        this.activeTurnId = -1;
      }
      this.audio.playLayerLockClick();
    }

    // 2. Clear accumulated moveHistory once Auto-Solve completes & verify zero-drift solved state
    if (frame.clearHistoryOnFinish) {
      this.rubiksCube.clearMoveHistory();
    }

    // 3. Drive live active face-turn pivot in exact lockstep with the twisting gripper wrist
    if (frame.activeFaceTurn) {
      if (this.activeTurnId !== frame.activeFaceTurn.turnId) {
        this.activeTurnId = frame.activeFaceTurn.turnId;
        this.rubiksCube.beginMove(frame.activeFaceTurn.move);
        this.audio.playFaceTwistCue(
          getMoveSpec(frame.activeFaceTurn.move).prime,
          frame.snapshot.speedMultiplier,
        );
      }
      this.rubiksCube.setActiveMoveProgress(frame.activeFaceTurn.easedProgress);
    }

    // 4. Apply arm joint angles & LED visuals
    this.leftArm.applyJointAngles(frame.leftAngles);
    this.rightArm.applyJointAngles(frame.rightAngles);

    this.leftArm.updateVisuals(dt);
    this.rightArm.updateVisuals(dt);

    // 5. Position & orient the Rubik's Cube rigidly at the gripper midpoint
    this.rubiksCube.position.set(
      frame.cubePosition.x,
      frame.cubePosition.y,
      frame.cubePosition.z,
    );
    this.rubiksCube.rotation.set(frame.cubePitch, frame.cubeYaw, 0);

    // 6. Softly expand, translate, and soften the radial contact shadow on the pad
    const liftNorm = Math.min(1, frame.cubeLiftHeight / 0.28);
    const shadowScale = 1 + liftNorm * 0.42;
    this.cubeShadowMesh.scale.setScalar(shadowScale);
    this.cubeShadowMesh.position.x = frame.cubePosition.x * 0.65;
    const mat = this.cubeShadowMesh.material as THREE.MeshBasicMaterial;
    mat.opacity = 0.56 * (1 - liftNorm * 0.62);
  }

  dispose(): void {
    this.unsubscribeAudio();
  }
}
