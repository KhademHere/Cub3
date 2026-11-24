import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import * as xb from 'xrblocks';

import {AnimationController} from './AnimationController';
import type {CubeMoveNotation} from './cubeMoves';
import {LAB_DIMENSIONS} from './kinematics';
import {createLabMaterials, type LabMaterialLibrary} from './materials';
import {RoboticArm} from './RoboticArm';
import {RubiksCube} from './RubiksCube';
import {ServoAudio} from './ServoAudio';
import type {MachineSnapshot, MotionSpeed, PuzzleType} from './types';

const DEFAULT_CAMERA_POS = new THREE.Vector3(0, 1.66, 0.38);
const DEFAULT_CAMERA_TARGET = new THREE.Vector3(
  0,
  LAB_DIMENSIONS.TABLE_TOP_Y + 0.22,
  LAB_DIMENSIONS.TABLE_CENTER_Z,
);

/**
 * Main XR Blocks scene script assembling the high-contrast robotics lab:
 * - Industrial workbench table with precision grid & recessed circular resting pad
 * - Studio PBR lighting rig + RoomEnvironment reflections + depth fog
 * - Symmetrical left & right articulated mechanical robotic arms
 * - 27-cubie modular RubiksCube
 * - Smooth damped OrbitControls (desktop) + Spatial UICard (XR headset)
 */
export class WorkbenchScene extends xb.Script {
  private readonly isSoftwareGl: boolean;
  private readonly onSnapshotCallback?: (snapshot: MachineSnapshot) => void;

  private materials!: LabMaterialLibrary;
  private leftArm!: RoboticArm;
  private rightArm!: RoboticArm;
  private rubiksCube!: RubiksCube;
  private cubeShadowMesh!: THREE.Mesh;
  private audio!: ServoAudio;
  private controller!: AnimationController;
  private controls: OrbitControls | null = null;
  private envRenderTarget: THREE.WebGLRenderTarget | null = null;

  // Smooth camera reset state (cancelled immediately on manual OrbitControls interaction)
  private resettingCamera = false;
  private readonly ownedGeometries: THREE.BufferGeometry[] = [];
  private readonly ownedMaterials: THREE.Material[] = [];

  // XR Spatial UI card (shown in immersive XR sessions so headset users can pinch controls)
  private xrCard: xb.UICard | null = null;
  private xrStatusText: xb.UIText | null = null;
  private xrActionButton: xb.UIButton | null = null;
  private xrScrambleButton: xb.UIButton | null = null;
  private xrSolveButton: xb.UIButton | null = null;
  private xrPuzzleButton: xb.UIButton | null = null;
  private unsubscribeController: (() => void) | null = null;
  private onXrVisibilityChange?: (inXr: boolean) => void;

  constructor(options: {
    isSoftwareGl: boolean;
    onSnapshot?: (snapshot: MachineSnapshot) => void;
    onXrVisibilityChange?: (inXr: boolean) => void;
  }) {
    super();
    this.isSoftwareGl = options.isSoftwareGl;
    this.onSnapshotCallback = options.onSnapshot;
    this.onXrVisibilityChange = options.onXrVisibilityChange;
  }

  init(): void {
    const renderer = xb.core.renderer;
    const scene = xb.core.scene;
    const camera = xb.core.camera;

    let maxAnisotropy = 4;
    if (renderer instanceof THREE.WebGLRenderer) {
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.12;
      renderer.setPixelRatio(
        this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2),
      );
      renderer.shadowMap.enabled = !this.isSoftwareGl;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      maxAnisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

      // Generate studio PBR reflections via RoomEnvironment on every device
      const pmrem = new THREE.PMREMGenerator(renderer);
      const roomEnv = new RoomEnvironment();
      this.envRenderTarget = pmrem.fromScene(roomEnv, 0.04);
      scene.environment = this.envRenderTarget.texture;
      scene.environmentIntensity = 0.72;
      roomEnv.dispose();
      pmrem.dispose();
    }

    // High-contrast robotics lab atmosphere + horizon-matched fog
    const bgHex = 0x0d121a;
    scene.background = new THREE.Color(bgHex);
    scene.fog = new THREE.FogExp2(bgHex, 0.14);

    this.materials = createLabMaterials(maxAnisotropy);
    this.audio = new ServoAudio();

    this.setupLighting();
    this.buildLabEnvironment();
    this.buildIndustrialWorkbench();

    // Create symmetrical industrial robotic arms & modular 27-cubie Rubik's Cube
    this.leftArm = new RoboticArm('left', this.materials);
    this.rightArm = new RoboticArm('right', this.materials);
    this.rubiksCube = new RubiksCube(this.materials);
    this.add(this.leftArm, this.rightArm, this.rubiksCube);

    // Build XR-native spatial control card (active in WebXR sessions)
    this.buildSpatialXrCard();

    // Wire AnimationController
    this.controller = new AnimationController({
      leftArm: this.leftArm,
      rightArm: this.rightArm,
      rubiksCube: this.rubiksCube,
      cubeShadowMesh: this.cubeShadowMesh,
      audio: this.audio,
    });

    this.unsubscribeController = this.controller.subscribe((snapshot) => {
      this.onSnapshotCallback?.(snapshot);
      if (this.xrStatusText) {
        // Keep spatial MSDF text ASCII-safe to prevent missing-glyph warnings
        this.xrStatusText.text = snapshot.statusLabel
          .replace(/•/g, '-')
          .replace(/—/g, '-')
          .replace(/✓/g, 'OK');
      }
      if (this.xrActionButton) {
        this.xrActionButton.label = snapshot.primaryButtonLabel;
        this.xrActionButton.disabled = snapshot.primaryButtonDisabled;
      }
      if (this.xrScrambleButton) {
        this.xrScrambleButton.label = snapshot.scrambleButtonLabel;
        this.xrScrambleButton.disabled = snapshot.scrambleButtonDisabled;
      }
      if (this.xrSolveButton) {
        this.xrSolveButton.label = snapshot.solveButtonLabel.replace(/✓/g, 'OK');
        this.xrSolveButton.disabled = snapshot.solveButtonDisabled;
      }
      if (this.xrPuzzleButton) {
        this.xrPuzzleButton.label =
          snapshot.puzzleType === 'mirror'
            ? 'Switch: Classic 3x3'
            : 'Switch: Mirror Cube';
        this.xrPuzzleButton.disabled = snapshot.puzzleSwitcherDisabled;
      }
    });

    // Frame camera heroically and attach smooth damped OrbitControls for desktop
    camera.fov = 42;
    camera.near = 0.05;
    camera.far = 40;
    camera.position.copy(DEFAULT_CAMERA_POS);
    camera.lookAt(DEFAULT_CAMERA_TARGET);
    camera.updateProjectionMatrix();

    if (renderer instanceof THREE.WebGLRenderer) {
      this.setupOrbitControls(camera, renderer.domElement);
    }
  }

  private trackGeo<T extends THREE.BufferGeometry>(geo: T): T {
    this.ownedGeometries.push(geo);
    return geo;
  }

  private trackMat<T extends THREE.Material>(mat: T): T {
    this.ownedMaterials.push(mat);
    return mat;
  }

  private setupLighting(): void {
    // Cool-tinted studio hemisphere fill for crisp ambient balance
    const hemi = new THREE.HemisphereLight(0xdbeafe, 0x1e293b, 0.95);
    hemi.position.set(0, 6, 0);
    this.add(hemi);

    // Warm studio key light with tight orthographic shadow frustum on the tabletop
    const keyLight = new THREE.DirectionalLight(0xfff5e6, 2.35);
    keyLight.position.set(1.45, 3.1, 0.65);
    keyLight.target.position.set(
      0,
      LAB_DIMENSIONS.TABLE_TOP_Y,
      LAB_DIMENSIONS.TABLE_CENTER_Z,
    );
    keyLight.castShadow = !this.isSoftwareGl;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.camera.near = 0.5;
    keyLight.shadow.camera.far = 6.5;
    const d = 1.35;
    keyLight.shadow.camera.left = -d;
    keyLight.shadow.camera.right = d;
    keyLight.shadow.camera.top = d;
    keyLight.shadow.camera.bottom = -d;
    keyLight.shadow.bias = -0.0004;
    keyLight.shadow.normalBias = 0.018;
    keyLight.shadow.radius = 3;
    this.add(keyLight, keyLight.target);

    // Cool cyan-blue rim light from behind to carve metallic silhouettes
    const rimLight = new THREE.DirectionalLight(0x7dd3fc, 1.35);
    rimLight.position.set(-1.3, 2.35, LAB_DIMENSIONS.TABLE_CENTER_Z - 1.75);
    rimLight.target.position.set(
      0,
      LAB_DIMENSIONS.TABLE_TOP_Y + 0.18,
      LAB_DIMENSIONS.TABLE_CENTER_Z,
    );
    this.add(rimLight, rimLight.target);

    // Subtle soft fill light on the opposite front flank
    const fillLight = new THREE.DirectionalLight(0xcbd5e1, 0.55);
    fillLight.position.set(-1.7, 1.65, 0.45);
    fillLight.target.position.set(
      0,
      LAB_DIMENSIONS.TABLE_TOP_Y + 0.1,
      LAB_DIMENSIONS.TABLE_CENTER_Z,
    );
    this.add(fillLight, fillLight.target);
  }

  private buildLabEnvironment(): void {
    // Seamless dark robotics lab floor extending smoothly into fog
    const floorGeo = this.trackGeo(new THREE.PlaneGeometry(24, 24));
    const floor = new THREE.Mesh(floorGeo, this.materials.labFloor);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0;
    floor.receiveShadow = true;
    this.add(floor);

    // Subtle industrial lab floor grid centered under the workbench
    const floorGrid = new THREE.GridHelper(12, 24, 0x263245, 0x18202c);
    floorGrid.position.set(0, 0.002, LAB_DIMENSIONS.TABLE_CENTER_Z);
    this.add(floorGrid);

    // Overhead studio light gantry bar (gives an authentic robotics bay reflection & framing)
    const gantryGroup = new THREE.Group();
    gantryGroup.position.set(0, 2.45, LAB_DIMENSIONS.TABLE_CENTER_Z);

    const beamGeo = this.trackGeo(new THREE.BoxGeometry(1.75, 0.045, 0.08));
    const beam = new THREE.Mesh(beamGeo, this.materials.tableFrame);
    gantryGroup.add(beam);

    const diffuserMat = this.trackMat(
      new THREE.MeshBasicMaterial({color: 0xe0f2fe}),
    );
    const diffuserGeo = this.trackGeo(new THREE.BoxGeometry(1.48, 0.012, 0.042));
    const diffuser = new THREE.Mesh(diffuserGeo, diffuserMat);
    diffuser.position.y = -0.025;
    gantryGroup.add(diffuser);

    // Vertical suspension rods
    const rodGeo = this.trackGeo(new THREE.CylinderGeometry(0.012, 0.012, 1.2, 12));
    const leftRod = new THREE.Mesh(rodGeo, this.materials.darkAnodized);
    leftRod.position.set(-0.78, 0.62, 0);
    const rightRod = new THREE.Mesh(rodGeo, this.materials.darkAnodized);
    rightRod.position.set(0.78, 0.62, 0);
    gantryGroup.add(leftRod, rightRod);

    this.add(gantryGroup);
  }

  private buildIndustrialWorkbench(): void {
    const tableGroup = new THREE.Group();
    tableGroup.name = 'IndustrialWorkbench';
    const topY = LAB_DIMENSIONS.TABLE_TOP_Y;
    const centerZ = LAB_DIMENSIONS.TABLE_CENTER_Z;
    const tableW = 1.66;
    const tableD = 0.86;
    const slabH = 0.056;

    tableGroup.position.set(0, 0, centerZ);

    // Main matte dark-slate precision tabletop slab
    const slabGeo = this.trackGeo(new THREE.BoxGeometry(tableW, slabH, tableD));
    const slab = new THREE.Mesh(slabGeo, this.materials.tableTop);
    slab.position.set(0, topY - slabH / 2, 0);
    slab.castShadow = true;
    slab.receiveShadow = true;
    tableGroup.add(slab);

    // Brushed steel bumper trim rails around all four edges of the tabletop
    const railH = slabH + 0.008;
    const railT = 0.016;
    const frontBackRailGeo = this.trackGeo(
      new THREE.BoxGeometry(tableW + railT * 2, railH, railT),
    );
    const frontRail = new THREE.Mesh(frontBackRailGeo, this.materials.tableEdge);
    frontRail.position.set(0, topY - slabH / 2 - 0.001, tableD / 2 + railT / 2);
    frontRail.castShadow = true;
    frontRail.receiveShadow = true;
    const backRail = frontRail.clone();
    backRail.position.z = -(tableD / 2 + railT / 2);

    const sideRailGeo = this.trackGeo(new THREE.BoxGeometry(railT, railH, tableD));
    const leftRail = new THREE.Mesh(sideRailGeo, this.materials.tableEdge);
    leftRail.position.set(-(tableW / 2 + railT / 2), topY - slabH / 2 - 0.001, 0);
    leftRail.castShadow = true;
    leftRail.receiveShadow = true;
    const rightRail = leftRail.clone();
    rightRail.position.x = tableW / 2 + railT / 2;

    tableGroup.add(frontRail, backRail, leftRail, rightRail);

    // Heavy structural steel under-frame apron & 4 industrial legs grounded at y = 0
    const legH = topY - slabH;
    const legGeo = this.trackGeo(new THREE.BoxGeometry(0.068, legH, 0.068));
    const footGeo = this.trackGeo(new THREE.CylinderGeometry(0.048, 0.054, 0.022, 16));
    const legX = tableW / 2 - 0.11;
    const legZ = tableD / 2 - 0.1;

    const legCoords: [number, number][] = [
      [-legX, -legZ],
      [legX, -legZ],
      [-legX, legZ],
      [legX, legZ],
    ];
    for (const [lx, lz] of legCoords) {
      const leg = new THREE.Mesh(legGeo, this.materials.tableFrame);
      leg.position.set(lx, legH / 2, lz);
      leg.castShadow = true;
      leg.receiveShadow = true;
      tableGroup.add(leg);

      const foot = new THREE.Mesh(footGeo, this.materials.machinedSteel);
      foot.position.set(lx, 0.011, lz);
      tableGroup.add(foot);
    }

    // Structural crossbeams connecting the legs
    const longBeamGeo = this.trackGeo(new THREE.BoxGeometry(legX * 2, 0.048, 0.042));
    const rearBeam = new THREE.Mesh(longBeamGeo, this.materials.tableFrame);
    rearBeam.position.set(0, 0.24, -legZ);
    const upperApronFront = new THREE.Mesh(longBeamGeo, this.materials.tableFrame);
    upperApronFront.position.set(0, topY - slabH - 0.03, legZ);
    const upperApronBack = new THREE.Mesh(longBeamGeo, this.materials.tableFrame);
    upperApronBack.position.set(0, topY - slabH - 0.03, -legZ);

    const sideBeamGeo = this.trackGeo(new THREE.BoxGeometry(0.042, 0.048, legZ * 2));
    const leftBeam = new THREE.Mesh(sideBeamGeo, this.materials.tableFrame);
    leftBeam.position.set(-legX, 0.24, 0);
    const rightBeam = new THREE.Mesh(sideBeamGeo, this.materials.tableFrame);
    rightBeam.position.set(legX, 0.24, 0);
    tableGroup.add(rearBeam, upperApronFront, upperApronBack, leftBeam, rightBeam);

    // Recessed circular resting pad at the center of the workbench
    const padOuterRadius = 0.22;
    const padInnerRadius = 0.19;

    // Outer chamfered machined aluminum bezel ring
    const ringGeo = this.trackGeo(
      new THREE.RingGeometry(padInnerRadius, padOuterRadius, 48),
    );
    const ringMesh = new THREE.Mesh(ringGeo, this.materials.padRing);
    ringMesh.rotation.x = -Math.PI / 2;
    ringMesh.position.y = topY + 0.0042;
    ringMesh.receiveShadow = true;
    tableGroup.add(ringMesh);

    // Raised bevel rim wall around the circular pad
    const rimWallGeo = this.trackGeo(
      new THREE.CylinderGeometry(padOuterRadius, padOuterRadius + 0.01, 0.005, 48, 1, true),
    );
    const rimWall = new THREE.Mesh(rimWallGeo, this.materials.padRing);
    rimWall.position.y = topY + 0.0025;
    tableGroup.add(rimWall);

    // Recessed matte dark resting surface disc where the Rubik's Cube sits
    const padDiscGeo = this.trackGeo(
      new THREE.CylinderGeometry(padInnerRadius, padInnerRadius, 0.003, 48),
    );
    const padDisc = new THREE.Mesh(padDiscGeo, this.materials.padRecess);
    padDisc.position.y = topY + LAB_DIMENSIONS.PAD_SURFACE_OFFSET / 2;
    padDisc.receiveShadow = true;
    tableGroup.add(padDisc);

    // Subtle precision cyan registration ring around the inner resting pad
    const ledRingMat = this.trackMat(
      new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.45,
      }),
    );
    const ledRingGeo = this.trackGeo(
      new THREE.RingGeometry(padInnerRadius - 0.005, padInnerRadius, 48),
    );
    const ledRing = new THREE.Mesh(ledRingGeo, ledRingMat);
    ledRing.rotation.x = -Math.PI / 2;
    ledRing.position.y = topY + LAB_DIMENSIONS.PAD_SURFACE_OFFSET + 0.0008;
    tableGroup.add(ledRing);

    // Dynamic radial contact shadow right beneath the Rubik's Cube
    const cubeShadowGeo = this.trackGeo(new THREE.PlaneGeometry(0.32, 0.32));
    this.cubeShadowMesh = new THREE.Mesh(
      cubeShadowGeo,
      this.materials.contactShadow.clone(),
    );
    this.ownedMaterials.push(this.cubeShadowMesh.material as THREE.Material);
    this.cubeShadowMesh.rotation.x = -Math.PI / 2;
    this.cubeShadowMesh.position.set(
      0,
      topY + LAB_DIMENSIONS.PAD_SURFACE_OFFSET + 0.0014,
      0,
    );
    tableGroup.add(this.cubeShadowMesh);

    this.add(tableGroup);
  }

  private buildSpatialXrCard(): void {
    this.xrStatusText = new xb.UIText({
      text: 'STANDBY',
      style: {
        fontSize: 20,
        fontWeight: 'bold',
        textAlign: 'center',
        color: '#38bdf8',
      },
    });
    this.xrActionButton = new xb.UIButton({
      label: 'Pick Up Cube',
      style: {flexGrow: 1},
      onClick: () => {
        this.triggerPrimaryAction();
      },
    });
    this.xrScrambleButton = new xb.UIButton({
      label: 'Scramble',
      style: {flexGrow: 1},
      onClick: () => {
        this.toggleScramble();
      },
    });
    this.xrSolveButton = new xb.UIButton({
      label: 'Auto-Solve',
      style: {flexGrow: 1},
      onClick: () => {
        this.triggerAutoSolve();
      },
    });
    this.xrPuzzleButton = new xb.UIButton({
      label: 'Switch: Mirror Cube',
      style: {width: '100%'},
      onClick: () => {
        const next: PuzzleType =
          this.controller?.getPuzzleType() === 'mirror' ? 'classic' : 'mirror';
        this.requestPuzzleSwitch(next);
      },
    });
    this.xrCard = new xb.UICard({
      size: {width: 0.64, height: 'auto'},
      manipulation: true,
      edge: true,
      style: {
        flexDirection: 'column',
        gap: 10,
        padding: 16,
      },
      children: [
        new xb.UIText({
          text: 'CUBEBOTICS LAB',
          style: {fontSize: 16, opacity: 0.72, textAlign: 'center'},
        }),
        this.xrStatusText,
        new xb.UIPanel({
          style: {width: '100%', flexDirection: 'row', gap: 10},
          children: [
            this.xrActionButton,
            this.xrScrambleButton,
            this.xrSolveButton,
          ],
        }),
        this.xrPuzzleButton,
      ],
    });
    // Positioned neatly at the front-right corner of the workbench for XR headset reach
    this.xrCard.position.set(
      0,
      LAB_DIMENSIONS.TABLE_TOP_Y + 0.14,
      LAB_DIMENSIONS.TABLE_CENTER_Z + 0.52,
    );
    this.xrCard.rotation.x = -0.35;
    // Hidden on desktop where the sleek 2D floating HUD owns the controls; shown in WebXR
    this.xrCard.visible = false;
    this.add(this.xrCard);
  }

  private setupOrbitControls(
    camera: THREE.PerspectiveCamera,
    domElement: HTMLCanvasElement,
  ): void {
    const controls = new OrbitControls(camera, domElement);
    controls.target.copy(DEFAULT_CAMERA_TARGET);
    controls.enableDamping = !this.isSoftwareGl;
    controls.dampingFactor = 0.075;
    controls.enablePan = true;
    controls.panSpeed = 0.65;
    controls.rotateSpeed = 0.72;
    controls.zoomSpeed = 0.85;
    controls.minDistance = 0.65;
    controls.maxDistance = 3.2;
    controls.minPolarAngle = 0.2;
    controls.maxPolarAngle = Math.PI * 0.485;
    controls.addEventListener('start', () => {
      this.resettingCamera = false;
    });
    controls.update();
    this.controls = controls;
  }

  onXRSessionStarted(): void {
    if (this.controls) this.controls.enabled = false;
    if (this.xrCard) this.xrCard.visible = true;
    this.onXrVisibilityChange?.(true);
  }

  onXRSessionEnded(): void {
    if (this.controls) this.controls.enabled = true;
    if (this.xrCard) this.xrCard.visible = false;
    this.onXrVisibilityChange?.(false);
  }

  triggerPrimaryAction(): boolean {
    return this.controller?.togglePickUpPutDown() ?? false;
  }

  toggleScramble(): boolean {
    return this.controller?.toggleScramble() ?? false;
  }

  triggerScramble(customSequence?: CubeMoveNotation[]): boolean {
    return this.controller?.triggerScramble(customSequence) ?? false;
  }

  triggerAutoSolve(): boolean {
    return this.controller?.triggerAutoSolve() ?? false;
  }

  requestPuzzleSwitch(target: PuzzleType): boolean {
    return this.controller?.requestPuzzleSwitch(target) ?? false;
  }

  setSpeedMultiplier(speed: MotionSpeed): void {
    this.controller?.setSpeedMultiplier(speed);
  }

  isCubeSolved(): boolean {
    return this.rubiksCube?.isSolved() ?? true;
  }

  resetCameraView(): void {
    if (!this.controls) return;
    if (this.isSoftwareGl) {
      xb.core.camera.position.copy(DEFAULT_CAMERA_POS);
      this.controls.target.copy(DEFAULT_CAMERA_TARGET);
      this.controls.update();
    } else {
      this.resettingCamera = true;
    }
  }

  toggleMute(): boolean {
    return this.audio.toggleMuted();
  }

  getAnimationController(): AnimationController {
    return this.controller;
  }

  getRubiksCube(): RubiksCube {
    return this.rubiksCube;
  }

  update(): void {
    const maxFrameDt = this.isSoftwareGl ? 1.0 : 0.1;
    const dt = Math.min(xb.getDeltaTime(), maxFrameDt);
    const maxSlice = this.isSoftwareGl ? 0.06 : 0.1;
    let remaining = dt;
    while (remaining > 1e-6) {
      const slice = Math.min(remaining, maxSlice);
      this.controller.update(slice);
      remaining -= slice;
    }

    const isPresenting =
      xb.core.renderer instanceof THREE.WebGLRenderer &&
      xb.core.renderer.xr.isPresenting;

    if (this.controls && !isPresenting) {
      if (this.resettingCamera) {
        const alpha = 1 - Math.exp(-6.5 * dt);
        xb.core.camera.position.lerp(DEFAULT_CAMERA_POS, alpha);
        this.controls.target.lerp(DEFAULT_CAMERA_TARGET, alpha);
        if (
          xb.core.camera.position.distanceTo(DEFAULT_CAMERA_POS) < 0.005 &&
          this.controls.target.distanceTo(DEFAULT_CAMERA_TARGET) < 0.005
        ) {
          xb.core.camera.position.copy(DEFAULT_CAMERA_POS);
          this.controls.target.copy(DEFAULT_CAMERA_TARGET);
          this.resettingCamera = false;
        }
      }
      this.controls.update();
    }
  }

  dispose(): void {
    this.unsubscribeController?.();
    this.controller?.dispose();
    this.controls?.dispose();
    this.leftArm?.dispose();
    this.rightArm?.dispose();
    this.rubiksCube?.dispose();
    this.audio?.dispose();
    this.materials?.dispose();
    this.envRenderTarget?.dispose();
    for (const geo of this.ownedGeometries) geo.dispose();
    for (const mat of this.ownedMaterials) mat.dispose();
  }
}
