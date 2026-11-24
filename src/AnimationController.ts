import * as THREE from 'three';

import {RoboticsChoreography} from './animationState';
import {getMoveSpec, type CubeMoveNotation} from './cubeMoves';
import type {RoboticArm} from './RoboticArm';
import type {RubiksCube} from './RubiksCube';
import type {ServoAudio} from './ServoAudio';
import type {MachineSnapshot, MachineState} from './types';

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
 * Clean extension point for Part 2 (Scramble) & Part 3 (Auto-Solve) move queues.
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
   * Triggers a balanced 14-16 move robotic scramble.
   * Automatically lifts the cube first if currently resting in STANDBY.
   */
  triggerScramble(customSequence?: CubeMoveNotation[]): boolean {
    this.audio.unlock();
    return this.choreography.triggerScramble(customSequence);
  }

  /** Hook for future Part 3 (Auto-Solve) commands. */
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
    // 1. Commit any face turns that finished during this frame step (zero skipped moves)
    for (const completedMove of frame.committedMoves) {
      if (this.activeTurnId === -1) {
        // Move started and finished inside a single large dt step
        this.rubiksCube.applyMoveInstant(completedMove, true);
      } else {
        this.rubiksCube.commitActiveMove(true);
        this.activeTurnId = -1;
      }
    }

    // 2. Drive live active face-turn pivot in exact lockstep with the twisting gripper wrist
    if (frame.activeFaceTurn) {
      if (this.activeTurnId !== frame.activeFaceTurn.turnId) {
        this.activeTurnId = frame.activeFaceTurn.turnId;
        this.rubiksCube.beginMove(frame.activeFaceTurn.move);
        this.audio.playFaceTwistCue(getMoveSpec(frame.activeFaceTurn.move).prime);
      }
      this.rubiksCube.setActiveMoveProgress(frame.activeFaceTurn.easedProgress);
    }

    // 3. Apply arm joint angles & LED visuals
    this.leftArm.applyJointAngles(frame.leftAngles);
    this.rightArm.applyJointAngles(frame.rightAngles);

    this.leftArm.updateVisuals(dt);
    this.rightArm.updateVisuals(dt);

    // 4. Position & orient the Rubik's Cube rigidly at the gripper midpoint
    this.rubiksCube.position.set(
      frame.cubePosition.x,
      frame.cubePosition.y,
      frame.cubePosition.z,
    );
    this.rubiksCube.rotation.set(0, frame.cubeYaw, 0);

    // 5. Softly expand, translate, and soften the radial contact shadow on the pad
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
