import * as THREE from 'three';

import {
  LAB_DIMENSIONS,
  clamp01,
  getArmBasePosition,
  getJawHalfPosition,
} from './kinematics';
import type {LabMaterialLibrary} from './materials';
import type {ArmJointAngles, ArmLedMode, ArmSide} from './types';

const LED_PALETTE: Record<ArmLedMode, {color: number; emissive: number; intensity: number}> = {
  idle: {color: 0x38bdf8, emissive: 0x06b6d4, intensity: 1.55},
  moving: {color: 0xfbbf24, emissive: 0xf59e0b, intensity: 2.1},
  gripping: {color: 0x34d399, emissive: 0x10b981, intensity: 2.25},
  scrambling: {color: 0xfbbf24, emissive: 0xf59e0b, intensity: 2.35},
  solving: {color: 0x22d3ee, emissive: 0x06b6d4, intensity: 2.35},
  celebrating: {color: 0x2dd4bf, emissive: 0x10b981, intensity: 2.75},
};

/**
 * Symmetrical 6-axis industrial robotic manipulator arm built from precision
 * geometric assemblies (zero humanoid anatomy):
 * - Bolted rotary base turret with bearing ring & LED status collar
 * - Cylindrical servo drums with metallic cooling rings
 * - Twin-ribbed heavy lower arm boom with braided hydraulic/data conduit
 * - Tapered forearm strut with counterbalance actuator
 * - Rotating harmonic-drive wrist actuator (aligned for future face twists)
 * - 2-jaw parallel mechanical clamp gripper with diamond-knurled rubberized pads
 */
export class RoboticArm extends THREE.Group {
  public readonly side: ArmSide;
  private readonly inwardSign: number;

  // Articulated joint hierarchy matching kinematics.ts exactly
  private readonly baseTurretPivot: THREE.Group;
  private readonly shoulderPivot: THREE.Group;
  private readonly elbowPivot: THREE.Group;
  private readonly wristPitchPivot: THREE.Group;
  private readonly wristRollPivot: THREE.Group;
  private readonly gripperContactMarker: THREE.Object3D;

  // Parallel mechanical jaw carriages
  private readonly frontJawCarriage: THREE.Group;
  private readonly rearJawCarriage: THREE.Group;
  private readonly jawPadThickness = 0.011;

  // Dynamic LED status material unique per arm (for smooth state color transitions)
  private readonly ledMaterial: THREE.MeshStandardMaterial;
  private readonly targetLedColor = new THREE.Color(LED_PALETTE.idle.color);
  private readonly targetLedEmissive = new THREE.Color(LED_PALETTE.idle.emissive);
  private targetLedIntensity = LED_PALETTE.idle.intensity;
  private ledMode: ArmLedMode = 'idle';
  private ledPulseTime = 0;

  private readonly ownedGeometries: THREE.BufferGeometry[] = [];

  constructor(side: ArmSide, materials: LabMaterialLibrary) {
    super();
    this.side = side;
    this.inwardSign = side === 'left' ? 1 : -1;
    this.name = side === 'left' ? 'LeftRoboticArm' : 'RightRoboticArm';

    const basePos = getArmBasePosition(side);
    this.position.set(basePos.x, basePos.y, basePos.z);

    this.ledMaterial = new THREE.MeshStandardMaterial({
      color: LED_PALETTE.idle.color,
      emissive: LED_PALETTE.idle.emissive,
      emissiveIntensity: LED_PALETTE.idle.intensity,
      roughness: 0.25,
      metalness: 0.1,
    });

    // 1. STATIC BOLTED PEDESTAL FLANGE (anchored flush to workbench tabletop)
    this.buildBoltedBasePlate(materials);

    // 2. ROTARY BASE TURRET (Y-axis yaw)
    this.baseTurretPivot = new THREE.Group();
    this.baseTurretPivot.name = 'BaseTurretYaw';
    this.add(this.baseTurretPivot);
    this.buildRotaryTurret(materials);

    // 3. SHOULDER SERVO PIVOT (located at y = SHOULDER_HEIGHT)
    this.shoulderPivot = new THREE.Group();
    this.shoulderPivot.name = 'ShoulderPitch';
    this.shoulderPivot.position.set(0, LAB_DIMENSIONS.SHOULDER_HEIGHT, 0);
    this.baseTurretPivot.add(this.shoulderPivot);
    this.buildServoDrum(this.shoulderPivot, 0.056, 0.112, materials);
    this.buildLowerArmBoom(materials);

    // 4. ELBOW SERVO PIVOT (located at +inwardSign * LOWER_BOOM_LENGTH along shoulder local X)
    this.elbowPivot = new THREE.Group();
    this.elbowPivot.name = 'ElbowPitch';
    this.elbowPivot.position.set(
      this.inwardSign * LAB_DIMENSIONS.LOWER_BOOM_LENGTH,
      0,
      0,
    );
    this.shoulderPivot.add(this.elbowPivot);
    this.buildServoDrum(this.elbowPivot, 0.046, 0.096, materials);
    this.buildForearmStrut(materials);

    // 5. WRIST PITCH PIVOT (located at +inwardSign * FOREARM_LENGTH along elbow local X)
    this.wristPitchPivot = new THREE.Group();
    this.wristPitchPivot.name = 'WristPitch';
    this.wristPitchPivot.position.set(
      this.inwardSign * LAB_DIMENSIONS.FOREARM_LENGTH,
      0,
      0,
    );
    this.elbowPivot.add(this.wristPitchPivot);
    // Compact 27mm radius keeps wrist servo strictly inside Mirror Cube's 30.1mm middle-slice half-width
    this.buildServoDrum(this.wristPitchPivot, 0.027, 0.068, materials);

    // 6. ROTATING WRIST ACTUATOR (X-axis roll for future cube face twisting)
    this.wristRollPivot = new THREE.Group();
    this.wristRollPivot.name = 'WristRollActuator';
    this.wristPitchPivot.add(this.wristRollPivot);
    const {frontJaw, rearJaw, contactMarker} =
      this.buildWristAndParallelGripper(materials);
    this.frontJawCarriage = frontJaw;
    this.rearJawCarriage = rearJaw;
    this.gripperContactMarker = contactMarker;

    this.setJawOpen(1);
  }

  private trackGeo<T extends THREE.BufferGeometry>(geo: T): T {
    this.ownedGeometries.push(geo);
    return geo;
  }

  private addMesh(
    parent: THREE.Object3D,
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    pos?: [number, number, number],
    rot?: [number, number, number],
    castShadow = true,
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(geo, mat);
    if (pos) mesh.position.set(pos[0], pos[1], pos[2]);
    if (rot) mesh.rotation.set(rot[0], rot[1], rot[2]);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  private buildBoltedBasePlate(materials: LabMaterialLibrary): void {
    // Grounding radial contact shadow right on the tabletop
    const shadowGeo = this.trackGeo(new THREE.CircleGeometry(0.155, 32));
    const shadow = new THREE.Mesh(shadowGeo, materials.contactShadow);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.0012;
    this.add(shadow);

    // Heavy octagonal-chamfered base plate
    const plateGeo = this.trackGeo(new THREE.CylinderGeometry(0.115, 0.126, 0.022, 8));
    this.addMesh(this, plateGeo, materials.darkAnodized, [0, 0.011, 0], [0, Math.PI / 8, 0]);

    // Brushed aluminum precision mounting flange ring
    const flangeGeo = this.trackGeo(new THREE.CylinderGeometry(0.098, 0.104, 0.012, 32));
    this.addMesh(this, flangeGeo, materials.brushedAluminum, [0, 0.028, 0]);

    // 8 machined hex anchor bolts arranged around perimeter
    const boltGeo = this.trackGeo(new THREE.CylinderGeometry(0.0065, 0.0065, 0.01, 6));
    const boltRadius = 0.108;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      this.addMesh(
        this,
        boltGeo,
        materials.machinedSteel,
        [Math.cos(a) * boltRadius, 0.024, Math.sin(a) * boltRadius],
        undefined,
        false,
      );
    }
  }

  private buildRotaryTurret(materials: LabMaterialLibrary): void {
    // Slew bearing ring
    const bearingGeo = this.trackGeo(new THREE.CylinderGeometry(0.086, 0.09, 0.022, 32));
    this.addMesh(this.baseTurretPivot, bearingGeo, materials.machinedSteel, [0, 0.044, 0]);

    // Recessed glowing LED status collar around rotary turret
    const ledCollarGeo = this.trackGeo(new THREE.CylinderGeometry(0.0885, 0.0885, 0.0065, 32));
    this.addMesh(
      this.baseTurretPivot,
      ledCollarGeo,
      this.ledMaterial,
      [0, 0.056, 0],
      undefined,
      false,
    );

    // Heavy gunmetal turret housing drum
    const drumGeo = this.trackGeo(new THREE.CylinderGeometry(0.076, 0.084, 0.056, 24));
    this.addMesh(this.baseTurretPivot, drumGeo, materials.gunmetal, [0, 0.087, 0]);

    // Twin vertical yoke cheeks supporting the shoulder servo drum
    const cheekGeo = this.trackGeo(new THREE.BoxGeometry(0.082, 0.084, 0.022));
    this.addMesh(this.baseTurretPivot, cheekGeo, materials.gunmetal, [0, 0.132, 0.056]);
    this.addMesh(this.baseTurretPivot, cheekGeo, materials.gunmetal, [0, 0.132, -0.056]);

    // Brushed aluminum cheek side trims
    const trimGeo = this.trackGeo(new THREE.BoxGeometry(0.062, 0.056, 0.004));
    this.addMesh(this.baseTurretPivot, trimGeo, materials.brushedAluminum, [0, 0.132, 0.069], undefined, false);
    this.addMesh(this.baseTurretPivot, trimGeo, materials.brushedAluminum, [0, 0.132, -0.069], undefined, false);
  }

  /**
   * Builds a detailed cylindrical servo actuator drum along the Z axis with
   * metallic end rings, dark housing, and twin recessed LED status bands.
   */
  private buildServoDrum(
    parent: THREE.Object3D,
    radius: number,
    width: number,
    materials: LabMaterialLibrary,
  ): void {
    // Core servo cylinder (aligned along Z axis)
    const coreGeo = this.trackGeo(new THREE.CylinderGeometry(radius, radius, width, 28));
    this.addMesh(parent, coreGeo, materials.darkAnodized, [0, 0, 0], [Math.PI / 2, 0, 0]);

    // Twin brushed aluminum bevel rings on both faces
    const ringGeo = this.trackGeo(
      new THREE.CylinderGeometry(radius * 1.04, radius * 1.04, width * 0.12, 28),
    );
    this.addMesh(parent, ringGeo, materials.brushedAluminum, [0, 0, width * 0.34], [Math.PI / 2, 0, 0]);
    this.addMesh(parent, ringGeo, materials.brushedAluminum, [0, 0, -width * 0.34], [Math.PI / 2, 0, 0]);

    // Machined steel outer end caps
    const capGeo = this.trackGeo(
      new THREE.CylinderGeometry(radius * 0.72, radius * 0.84, width * 0.12, 24),
    );
    this.addMesh(parent, capGeo, materials.machinedSteel, [0, 0, width * 0.52], [Math.PI / 2, 0, 0]);
    this.addMesh(parent, capGeo, materials.machinedSteel, [0, 0, -width * 0.52], [Math.PI / 2, 0, 0]);

    // Glowing LED status bands recessed near the outer rings
    const ledGeo = this.trackGeo(
      new THREE.CylinderGeometry(radius * 1.055, radius * 1.055, width * 0.055, 28),
    );
    this.addMesh(parent, ledGeo, this.ledMaterial, [0, 0, width * 0.24], [Math.PI / 2, 0, 0], false);
    this.addMesh(parent, ledGeo, this.ledMaterial, [0, 0, -width * 0.24], [Math.PI / 2, 0, 0], false);
  }

  private buildLowerArmBoom(materials: LabMaterialLibrary): void {
    const L1 = LAB_DIMENSIONS.LOWER_BOOM_LENGTH;
    const midX = (this.inwardSign * L1) / 2;

    // Central gunmetal structural beam
    const coreGeo = this.trackGeo(new THREE.BoxGeometry(L1 * 0.88, 0.054, 0.044));
    this.addMesh(this.shoulderPivot, coreGeo, materials.gunmetal, [midX, 0, 0]);

    // Twin brushed aluminum structural side flanges (I-beam industrial read)
    const sidePlateGeo = this.trackGeo(new THREE.BoxGeometry(L1 * 0.76, 0.064, 0.01));
    this.addMesh(this.shoulderPivot, sidePlateGeo, materials.brushedAluminum, [midX, 0, 0.029]);
    this.addMesh(this.shoulderPivot, sidePlateGeo, materials.brushedAluminum, [midX, 0, -0.029]);

    // Dark recessed spine rails along top & bottom edges
    const railGeo = this.trackGeo(new THREE.BoxGeometry(L1 * 0.72, 0.012, 0.052));
    this.addMesh(this.shoulderPivot, railGeo, materials.darkAnodized, [midX, 0.031, 0]);
    this.addMesh(this.shoulderPivot, railGeo, materials.darkAnodized, [midX, -0.031, 0]);

    // Side status LED light bar embedded cleanly into the brushed aluminum plate
    const ledBarGeo = this.trackGeo(new THREE.BoxGeometry(L1 * 0.42, 0.007, 0.004));
    this.addMesh(this.shoulderPivot, ledBarGeo, this.ledMaterial, [midX, 0, 0.0355], undefined, false);
    this.addMesh(this.shoulderPivot, ledBarGeo, this.ledMaterial, [midX, 0, -0.0355], undefined, false);

    // Braided external power/servo conduit tube curving neatly over the boom spine
    const s = this.inwardSign;
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(s * 0.03, 0.044, 0.016),
      new THREE.Vector3(s * L1 * 0.32, 0.068, 0.022),
      new THREE.Vector3(s * L1 * 0.68, 0.066, 0.02),
      new THREE.Vector3(s * (L1 - 0.03), 0.038, 0.015),
    ]);
    const cableGeo = this.trackGeo(new THREE.TubeGeometry(curve, 18, 0.0065, 8, false));
    this.addMesh(this.shoulderPivot, cableGeo, materials.cableSheath, undefined, undefined, false);
  }

  private buildForearmStrut(materials: LabMaterialLibrary): void {
    const L2 = LAB_DIMENSIONS.FOREARM_LENGTH;
    const s = this.inwardSign;
    const midX = (s * L2) / 2;

    // Rear counterbalance servo motor canister behind the elbow joint
    const counterGeo = this.trackGeo(new THREE.CylinderGeometry(0.032, 0.028, 0.074, 20));
    this.addMesh(
      this.elbowPivot,
      counterGeo,
      materials.gunmetal,
      [-s * 0.052, 0.01, 0],
      [0, 0, Math.PI / 2],
    );
    const counterCapGeo = this.trackGeo(new THREE.CylinderGeometry(0.026, 0.026, 0.01, 20));
    this.addMesh(
      this.elbowPivot,
      counterCapGeo,
      materials.brushedAluminum,
      [-s * 0.092, 0.01, 0],
      [0, 0, Math.PI / 2],
    );

    // Twin machined aluminum parallel forearm struts
    const strutGeo = this.trackGeo(new THREE.CylinderGeometry(0.013, 0.015, L2 * 0.86, 16));
    this.addMesh(
      this.elbowPivot,
      strutGeo,
      materials.brushedAluminum,
      [midX, 0.014, 0.02],
      [0, 0, Math.PI / 2],
    );
    this.addMesh(
      this.elbowPivot,
      strutGeo,
      materials.brushedAluminum,
      [midX, 0.014, -0.02],
      [0, 0, Math.PI / 2],
    );

    // Lower gunmetal actuator housing running along the forearm underside
    const housingGeo = this.trackGeo(new THREE.BoxGeometry(L2 * 0.78, 0.032, 0.044));
    this.addMesh(this.elbowPivot, housingGeo, materials.gunmetal, [midX, -0.01, 0]);

    // Precision cross-bracing collar midway along forearm
    const collarGeo = this.trackGeo(new THREE.BoxGeometry(0.026, 0.056, 0.062));
    this.addMesh(this.elbowPivot, collarGeo, materials.darkAnodized, [midX, 0.004, 0]);
  }

  private buildWristAndParallelGripper(materials: LabMaterialLibrary): {
    frontJaw: THREE.Group;
    rearJaw: THREE.Group;
    contactMarker: THREE.Object3D;
  } {
    const s = this.inwardSign;
    const Lg = LAB_DIMENSIONS.GRIPPER_REACH;

    // Rotating cylindrical harmonic-drive wrist actuator (radius <= 28mm < 30.1mm Mirror Cube M/2!)
    const wristLen = 0.052;
    const wristGeo = this.trackGeo(new THREE.CylinderGeometry(0.0245, 0.0265, wristLen, 24));
    this.addMesh(
      this.wristRollPivot,
      wristGeo,
      materials.gunmetal,
      [s * (0.026 + wristLen / 2), 0, 0],
      [0, 0, Math.PI / 2],
    );

    // Silver machined flange ring on wrist actuator
    const wristRingGeo = this.trackGeo(new THREE.CylinderGeometry(0.028, 0.028, 0.01, 24));
    this.addMesh(
      this.wristRollPivot,
      wristRingGeo,
      materials.brushedAluminum,
      [s * 0.042, 0, 0],
      [0, 0, Math.PI / 2],
    );

    // Glowing LED status band around the rotating wrist
    const wristLedGeo = this.trackGeo(new THREE.CylinderGeometry(0.0275, 0.0275, 0.006, 24));
    this.addMesh(
      this.wristRollPivot,
      wristLedGeo,
      this.ledMaterial,
      [s * 0.062, 0, 0],
      [0, 0, Math.PI / 2],
      false,
    );

    // Parallel Linear Rail Block (crossbar spanning along Z where the 2 jaws slide)
    // Compact 40mm height keeps the stabilizing gripper strictly within the 60.2mm Mirror Cube middle slice!
    // Span accommodates protruding asymmetric Mirror Cube blocks up to 0.144m + open jaw clearance.
    const railX = s * (Lg - 0.022);
    const railSpanZ = 0.396;

    const railBodyGeo = this.trackGeo(new THREE.BoxGeometry(0.032, 0.04, railSpanZ));
    this.addMesh(this.wristRollPivot, railBodyGeo, materials.darkAnodized, [railX, 0, 0]);

    // Twin precision chrome guide rods along Z inside the rail block
    const guideRodGeo = this.trackGeo(new THREE.CylinderGeometry(0.004, 0.004, railSpanZ + 0.006, 12));
    this.addMesh(
      this.wristRollPivot,
      guideRodGeo,
      materials.machinedSteel,
      [railX + s * 0.011, 0.012, 0],
      [Math.PI / 2, 0, 0],
      false,
    );
    this.addMesh(
      this.wristRollPivot,
      guideRodGeo,
      materials.machinedSteel,
      [railX + s * 0.011, -0.012, 0],
      [Math.PI / 2, 0, 0],
      false,
    );

    // Center registration rubber bumper facing the cube's center cubie face
    // Its inner contact face sits precisely at x = s * Lg (flush on outer sticker plane, zero clipping!)
    const centerPadThickness = 0.006;
    const centerPadGeo = this.trackGeo(new THREE.BoxGeometry(centerPadThickness, 0.04, 0.04));
    this.addMesh(
      this.wristRollPivot,
      centerPadGeo,
      materials.rubberGrip,
      [s * (Lg - centerPadThickness / 2), 0, 0],
      undefined,
      false,
    );

    // Exact contact reference marker (matches kinematics.ts contactPad!)
    const contactMarker = new THREE.Object3D();
    contactMarker.position.set(s * Lg, 0, 0);
    this.wristRollPivot.add(contactMarker);

    // Build two symmetrical parallel mechanical clamping jaws (Front +Z, Rear -Z)
    const buildJawCarriage = (zSign: 1 | -1): THREE.Group => {
      const carriage = new THREE.Group();
      carriage.name = zSign > 0 ? 'FrontJawCarriage' : 'RearJawCarriage';
      this.wristRollPivot.add(carriage);

      const fingerOverlap = LAB_DIMENSIONS.JAW_FINGER_OVERLAP;
      const padT = this.jawPadThickness;
      const fingerThicknessZ = 0.015;

      // Sliding carriage block riding on the chrome guide rails (height 44mm <= center slice)
      const blockGeo = this.trackGeo(new THREE.BoxGeometry(0.036, 0.044, 0.024));
      this.addMesh(
        carriage,
        blockGeo,
        materials.brushedAluminum,
        [railX, 0, zSign * (padT + fingerThicknessZ * 0.6)],
      );

      // Machined gunmetal L-finger extending inward alongside the cube's outer layer only
      const fingerLenX = fingerOverlap + 0.022;
      const fingerCenterX = s * (Lg + fingerOverlap * 0.5 - 0.011);
      const fingerGeo = this.trackGeo(new THREE.BoxGeometry(fingerLenX, 0.038, fingerThicknessZ));
      this.addMesh(
        carriage,
        fingerGeo,
        materials.gunmetal,
        [fingerCenterX, 0, zSign * (padT + fingerThicknessZ / 2)],
      );

      // Brushed aluminum outer reinforcing rib on jaw finger
      const ribGeo = this.trackGeo(new THREE.BoxGeometry(fingerLenX * 0.78, 0.016, 0.0045));
      this.addMesh(
        carriage,
        ribGeo,
        materials.brushedAluminum,
        [fingerCenterX, 0, zSign * (padT + fingerThicknessZ + 0.0022)],
        undefined,
        false,
      );

      // Dark diamond-knurled rubberized grip pad!
      // Inner gripping surface sits at local z = 0 in the carriage frame so positioning
      // carriage.position.z = zSign * (innerSeparation / 2) yields exact mathematical flush contact.
      const padGeo = this.trackGeo(new THREE.BoxGeometry(fingerOverlap * 0.92, 0.044, padT));
      this.addMesh(
        carriage,
        padGeo,
        materials.rubberGrip,
        [s * (Lg + fingerOverlap * 0.5), 0, zSign * (padT / 2)],
      );

      return carriage;
    };

    const frontJaw = buildJawCarriage(1);
    const rearJaw = buildJawCarriage(-1);

    return {frontJaw, rearJaw, contactMarker};
  }

  /**
   * Sets the parallel gripper jaw opening (`0` = exact flush clamp on live puzzle face,
   * `1` = fully open clearance). Supports independent front (+Z) and rear (-Z) clamp extents
   * for shape-shifting Mirror Cube blocks.
   */
  setJawOpen(
    jawOpen: number,
    frontExtent: number = LAB_DIMENSIONS.CUBE_OUTER_HALF,
    rearExtent: number = LAB_DIMENSIONS.CUBE_OUTER_HALF,
  ): void {
    const open = clamp01(jawOpen);
    this.frontJawCarriage.position.z = getJawHalfPosition(frontExtent, open);
    this.rearJawCarriage.position.z = -getJawHalfPosition(rearExtent, open);
  }

  /**
   * Applies solved joint angles to the hierarchical industrial arm rig.
   * Rotation signs are derived directly from `computeForwardKinematics` so
   * Three.js transforms match the analytical solver to < 0.1 mm.
   */
  applyJointAngles(angles: ArmJointAngles): void {
    // Turret yaw around +Y
    this.baseTurretPivot.rotation.y = angles.baseYaw;

    // For Left arm (inward = +X), +Z rotation lifts +X toward +Y.
    // For Right arm (inward = -X), -Z rotation lifts -X toward +Y.
    const pitchSign = this.inwardSign;
    this.shoulderPivot.rotation.z = pitchSign * angles.shoulderPitch;
    this.elbowPivot.rotation.z = pitchSign * angles.elbowPitch;
    this.wristPitchPivot.rotation.z = pitchSign * angles.wristPitch;

    // Wrist roll around the inward X axis (ready for Parts 2 & 3 twists)
    this.wristRollPivot.rotation.x = this.inwardSign * angles.wristRoll;

    this.setJawOpen(
      angles.jawOpen,
      angles.frontJawExtent ?? LAB_DIMENSIONS.CUBE_OUTER_HALF,
      angles.rearJawExtent ?? LAB_DIMENSIONS.CUBE_OUTER_HALF,
    );
  }

  /** Updates the target LED color state (idle cyan / moving amber / gripping emerald / solving / celebrating). */
  setLedMode(mode: ArmLedMode): void {
    this.ledMode = mode;
    const preset = LED_PALETTE[mode];
    this.targetLedColor.setHex(preset.color);
    this.targetLedEmissive.setHex(preset.emissive);
    this.targetLedIntensity = preset.intensity;
  }

  /** Smoothly interpolates joint LED colors and drives state-specific rhythmic pulses. */
  updateVisuals(dt: number): void {
    const safeDt = Math.min(dt, 0.05);
    this.ledPulseTime += safeDt;
    const alpha = 1 - Math.exp(-8 * safeDt);
    this.ledMaterial.color.lerp(this.targetLedColor, alpha);
    this.ledMaterial.emissive.lerp(this.targetLedEmissive, alpha);

    let desiredIntensity = this.targetLedIntensity;
    if (this.ledMode === 'scrambling') {
      desiredIntensity = this.targetLedIntensity + Math.sin(this.ledPulseTime * 7.5) * 0.65;
    } else if (this.ledMode === 'solving') {
      desiredIntensity = this.targetLedIntensity + Math.sin(this.ledPulseTime * 5.2) * 0.5;
    } else if (this.ledMode === 'celebrating') {
      desiredIntensity = this.targetLedIntensity + Math.sin(this.ledPulseTime * 6.0) * 0.85;
    }

    this.ledMaterial.emissiveIntensity +=
      (desiredIntensity - this.ledMaterial.emissiveIntensity) * alpha;
  }

  /** Returns the world position of the gripper's center contact plane. */
  getContactWorldPosition(out: THREE.Vector3): THREE.Vector3 {
    this.updateMatrixWorld(true);
    return this.gripperContactMarker.getWorldPosition(out);
  }

  dispose(): void {
    for (const geo of this.ownedGeometries) {
      geo.dispose();
    }
    this.ledMaterial.dispose();
  }
}
