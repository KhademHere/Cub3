import * as THREE from 'three';

export interface LabMaterialLibrary {
  tableTop: THREE.MeshStandardMaterial;
  tableEdge: THREE.MeshStandardMaterial;
  tableFrame: THREE.MeshStandardMaterial;
  padRing: THREE.MeshStandardMaterial;
  padRecess: THREE.MeshStandardMaterial;
  labFloor: THREE.MeshStandardMaterial;
  gunmetal: THREE.MeshStandardMaterial;
  darkAnodized: THREE.MeshStandardMaterial;
  brushedAluminum: THREE.MeshPhysicalMaterial;
  machinedSteel: THREE.MeshStandardMaterial;
  rubberGrip: THREE.MeshStandardMaterial;
  cableSheath: THREE.MeshStandardMaterial;
  contactShadow: THREE.MeshBasicMaterial;
  cubeCore: THREE.MeshStandardMaterial;
  cubeTiles: Record<
    'white' | 'yellow' | 'red' | 'orange' | 'blue' | 'green',
    THREE.MeshPhysicalMaterial
  >;
  mirrorCubeCore: THREE.MeshStandardMaterial;
  mirrorCubeTiles: {
    xAxis: THREE.MeshPhysicalMaterial;
    yAxis: THREE.MeshPhysicalMaterial;
    zAxis: THREE.MeshPhysicalMaterial;
  };
  dominoCubeCore: THREE.MeshStandardMaterial;
  dominoCubeTiles: Record<
    'white' | 'yellow' | 'red' | 'orange' | 'blue' | 'green',
    THREE.MeshPhysicalMaterial
  >;
  dispose: () => void;
}

/**
 * Generates a high-resolution procedural dark-slate workbench tabletop texture
 * with precision metrology grid lines, crosshair axes, and subtle surface micro-grain.
 */
function createWorkbenchGridTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const width = 1024;
  const height = 512;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  // Matte dark-slate base with subtle radial studio vignette
  const bgGrad = ctx.createRadialGradient(
    width * 0.5,
    height * 0.5,
    40,
    width * 0.5,
    height * 0.5,
    width * 0.58,
  );
  bgGrad.addColorStop(0, '#222a36');
  bgGrad.addColorStop(0.65, '#19202a');
  bgGrad.addColorStop(1, '#131820');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, width, height);

  // Subtle deterministic slate micro-grain
  let seed = 4219;
  const nextRand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  ctx.fillStyle = 'rgba(255, 255, 255, 0.014)';
  for (let i = 0; i < 4800; i++) {
    const x = nextRand() * width;
    const y = nextRand() * height;
    const w = 1 + nextRand() * 2;
    ctx.fillRect(x, y, w, 1);
  }

  // Minor precision grid (every 32px)
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.075)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= width; x += 32) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, height);
  }
  for (let y = 0; y <= height; y += 32) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(width, y + 0.5);
  }
  ctx.stroke();

  // Major precision grid (every 128px)
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.17)';
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  for (let x = 0; x <= width; x += 128) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, height);
  }
  for (let y = 0; y <= height; y += 128) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(width, y + 0.5);
  }
  ctx.stroke();

  // Centerline metrology crosshairs (X and Z calibration lines)
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.28)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([8, 6]);
  ctx.beginPath();
  ctx.moveTo(40, height / 2 + 0.5);
  ctx.lineTo(width - 40, height / 2 + 0.5);
  ctx.moveTo(width / 2 + 0.5, 28);
  ctx.lineTo(width / 2 + 0.5, height - 28);
  ctx.stroke();
  ctx.setLineDash([]);

  // Outer technical perimeter border
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.26)';
  ctx.lineWidth = 2;
  ctx.strokeRect(20, 20, width - 40, height - 40);

  // Subtle calibration ring markings around center pad
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.22)';
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  ctx.arc(width / 2, height / 2, 134, 0, Math.PI * 2);
  ctx.stroke();

  // Subtle corner technical labels
  ctx.fillStyle = 'rgba(148, 163, 184, 0.42)';
  ctx.font = '600 11px monospace';
  ctx.fillText('CELL 01 // DUAL-AXIS MANIPULATOR BAY', 34, 42);
  ctx.fillText('DATUM X-00 / Z-00', width - 165, 42);
  ctx.fillText('L-BASE [-560mm]', 120, height - 32);
  ctx.fillText('R-BASE [+560mm]', width - 228, height - 32);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = maxAnisotropy;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Generates a fine linear brushed-metal bump/roughness texture for aluminum parts.
 */
function createBrushedMetalTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, size, size);

  let seed = 1337;
  const rand = () => {
    seed = (seed * 48271) % 2147483647;
    return (seed - 1) / 2147483646;
  };

  for (let y = 0; y < size; y++) {
    const tone = Math.floor(110 + rand() * 40);
    ctx.fillStyle = `rgb(${tone},${tone},${tone})`;
    ctx.fillRect(0, y, size, 1);
  }

  for (let i = 0; i < 600; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const len = 24 + rand() * 80;
    const bright = rand() > 0.5 ? 175 : 85;
    ctx.fillStyle = `rgba(${bright},${bright},${bright},0.22)`;
    ctx.fillRect(x, y, len, 1);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(2, 2);
  texture.anisotropy = maxAnisotropy;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Generates a high-resolution directional hairline brushed-chrome texture
 * for Mirror Cube metallic tiles (albedo/sheen + fine brushed bump).
 */
function createMirrorChromeTextures(maxAnisotropy: number): {
  albedoMap: THREE.CanvasTexture;
  bumpMap: THREE.CanvasTexture;
} {
  const size = 512;
  const albedoCanvas = document.createElement('canvas');
  albedoCanvas.width = size;
  albedoCanvas.height = size;
  const aCtx = albedoCanvas.getContext('2d')!;

  const bumpCanvas = document.createElement('canvas');
  bumpCanvas.width = size;
  bumpCanvas.height = size;
  const bCtx = bumpCanvas.getContext('2d')!;

  // Subtle aerospace silver-chrome gradient base
  const grad = aCtx.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, '#eef3fa');
  grad.addColorStop(0.5, '#dbe3ee');
  grad.addColorStop(1, '#e8eef7');
  aCtx.fillStyle = grad;
  aCtx.fillRect(0, 0, size, size);

  bCtx.fillStyle = '#808080';
  bCtx.fillRect(0, 0, size, size);

  let seed = 8821;
  const rand = () => {
    seed = (seed * 48271) % 2147483647;
    return (seed - 1) / 2147483646;
  };

  // Continuous fine horizontal hairline brush strokes
  for (let y = 0; y < size; y++) {
    const delta = Math.floor((rand() - 0.5) * 26);
    const aTone = Math.min(255, Math.max(198, 228 + delta));
    aCtx.fillStyle = `rgba(${aTone},${aTone + 2},${Math.min(255, aTone + 6)},0.34)`;
    aCtx.fillRect(0, y, size, 1);

    const bTone = Math.min(255, Math.max(70, 128 + delta * 2));
    bCtx.fillStyle = `rgb(${bTone},${bTone},${bTone})`;
    bCtx.fillRect(0, y, size, 1);
  }

  // Crisp micro-specular directional brush streaks
  for (let i = 0; i < 1100; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const len = 36 + rand() * 140;
    const bright = rand() > 0.48;
    aCtx.fillStyle = bright ? 'rgba(255,255,255,0.20)' : 'rgba(130,145,165,0.16)';
    aCtx.fillRect(x, y, len, 1);
    bCtx.fillStyle = bright ? 'rgba(215,215,215,0.28)' : 'rgba(65,65,65,0.28)';
    bCtx.fillRect(x, y, len, 1);
  }

  const albedoMap = new THREE.CanvasTexture(albedoCanvas);
  albedoMap.colorSpace = THREE.SRGBColorSpace;
  albedoMap.wrapS = THREE.RepeatWrapping;
  albedoMap.wrapT = THREE.RepeatWrapping;
  albedoMap.anisotropy = maxAnisotropy;
  albedoMap.needsUpdate = true;

  const bumpMap = new THREE.CanvasTexture(bumpCanvas);
  bumpMap.wrapS = THREE.RepeatWrapping;
  bumpMap.wrapT = THREE.RepeatWrapping;
  bumpMap.anisotropy = maxAnisotropy;
  bumpMap.needsUpdate = true;

  return {albedoMap, bumpMap};
}

/**
 * Generates a diamond-knurled anti-slip bump texture for rubberized gripper pads.
 */
function createKnurledRubberTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#505050';
  ctx.fillRect(0, 0, size, size);

  ctx.strokeStyle = '#d8d8d8';
  ctx.lineWidth = 3;
  const step = 16;
  ctx.beginPath();
  for (let i = -size; i < size * 2; i += step) {
    ctx.moveTo(i, 0);
    ctx.lineTo(i + size, size);
    ctx.moveTo(i + size, 0);
    ctx.lineTo(i, size);
  }
  ctx.stroke();

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(3, 3);
  texture.anisotropy = maxAnisotropy;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Generates a smooth radial contact shadow texture for crisp figure-ground grounding.
 */
function createContactShadowTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  const grad = ctx.createRadialGradient(
    size / 2,
    size / 2,
    size * 0.06,
    size / 2,
    size / 2,
    size * 0.5,
  );
  grad.addColorStop(0, 'rgba(0, 0, 0, 0.72)');
  grad.addColorStop(0.45, 'rgba(0, 0, 0, 0.42)');
  grad.addColorStop(0.78, 'rgba(0, 0, 0, 0.12)');
  grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

/**
 * Creates all shared PBR materials and procedural textures for the robotics lab.
 */
export function createLabMaterials(maxAnisotropy: number): LabMaterialLibrary {
  const gridMap = createWorkbenchGridTexture(maxAnisotropy);
  const brushedBump = createBrushedMetalTexture(maxAnisotropy);
  const mirrorChrome = createMirrorChromeTextures(maxAnisotropy);
  const knurlBump = createKnurledRubberTexture(maxAnisotropy);
  const shadowMap = createContactShadowTexture();

  const tableTop = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: gridMap,
    roughness: 0.78,
    metalness: 0.18,
  });

  const tableEdge = new THREE.MeshStandardMaterial({
    color: 0x222c3a,
    roughness: 0.44,
    metalness: 0.72,
  });

  const tableFrame = new THREE.MeshStandardMaterial({
    color: 0x161c26,
    roughness: 0.65,
    metalness: 0.55,
  });

  const padRing = new THREE.MeshStandardMaterial({
    color: 0x9aa8b8,
    roughness: 0.24,
    metalness: 0.88,
    bumpMap: brushedBump,
    bumpScale: 0.0012,
  });

  const padRecess = new THREE.MeshStandardMaterial({
    color: 0x11161f,
    roughness: 0.88,
    metalness: 0.12,
  });

  const labFloor = new THREE.MeshStandardMaterial({
    color: 0x0f141d,
    roughness: 0.86,
    metalness: 0.15,
  });

  const gunmetal = new THREE.MeshStandardMaterial({
    color: 0x2a323f,
    roughness: 0.52,
    metalness: 0.68,
    bumpMap: brushedBump,
    bumpScale: 0.001,
  });

  const darkAnodized = new THREE.MeshStandardMaterial({
    color: 0x171c24,
    roughness: 0.64,
    metalness: 0.52,
  });

  const brushedAluminum = new THREE.MeshPhysicalMaterial({
    color: 0xd0d8e2,
    roughness: 0.22,
    metalness: 0.92,
    anisotropy: 0.75,
    bumpMap: brushedBump,
    bumpScale: 0.0014,
  });

  const machinedSteel = new THREE.MeshStandardMaterial({
    color: 0x9aa7b8,
    roughness: 0.18,
    metalness: 0.94,
  });

  const rubberGrip = new THREE.MeshStandardMaterial({
    color: 0x14171c,
    roughness: 0.93,
    metalness: 0.04,
    bumpMap: knurlBump,
    bumpScale: 0.0028,
  });

  const cableSheath = new THREE.MeshStandardMaterial({
    color: 0x12151a,
    roughness: 0.84,
    metalness: 0.08,
  });

  const contactShadow = new THREE.MeshBasicMaterial({
    map: shadowMap,
    transparent: true,
    opacity: 0.52,
    depthWrite: false,
  });

  const cubeCore = new THREE.MeshStandardMaterial({
    color: 0x101318,
    roughness: 0.42,
    metalness: 0.08,
  });

  const makeTileMaterial = (hex: number) =>
    new THREE.MeshPhysicalMaterial({
      color: hex,
      roughness: 0.16,
      metalness: 0.02,
      clearcoat: 0.9,
      clearcoatRoughness: 0.1,
    });

  const cubeTiles = {
    white: makeTileMaterial(0xf4f6f9),
    yellow: makeTileMaterial(0xf5c518),
    red: makeTileMaterial(0xd92626),
    orange: makeTileMaterial(0xf96a16),
    blue: makeTileMaterial(0x1d5ed8),
    green: makeTileMaterial(0x149946),
  };

  const mirrorCubeCore = new THREE.MeshStandardMaterial({
    color: 0x0a0d12,
    roughness: 0.62,
    metalness: 0.16,
  });

  const makeMirrorTileMaterial = (
    tintHex: number,
    anisotropyRotation: number,
    roughness: number,
  ) =>
    new THREE.MeshPhysicalMaterial({
      color: tintHex,
      map: mirrorChrome.albedoMap,
      bumpMap: mirrorChrome.bumpMap,
      bumpScale: 0.0014,
      metalness: 0.94,
      roughness,
      anisotropy: 0.85,
      anisotropyRotation,
      clearcoat: 0.36,
      clearcoatRoughness: 0.14,
      envMapIntensity: 1.32,
    });

  // Subtle brushed-grain orientation & luminance nuance across orthogonal planes
  // so every asymmetric block catches key and rim studio lights dramatically.
  const mirrorCubeTiles = {
    xAxis: makeMirrorTileMaterial(0xe4ebf4, 0, 0.18),
    yAxis: makeMirrorTileMaterial(0xf0f4fa, Math.PI / 2, 0.16),
    zAxis: makeMirrorTileMaterial(0xdbe3ee, Math.PI / 4, 0.19),
  };

  // High-contrast 3x3x2 Domino-Lab palette: matte obsidian core with glossy Ivory White top,
  // Amber Yellow bottom, and crisp color-coded side bands around the 2-layer perimeter.
  const dominoCubeCore = new THREE.MeshStandardMaterial({
    color: 0x0a0d12,
    roughness: 0.48,
    metalness: 0.12,
  });

  const makeDominoTileMaterial = (hex: number) =>
    new THREE.MeshPhysicalMaterial({
      color: hex,
      roughness: 0.13,
      metalness: 0.03,
      clearcoat: 0.96,
      clearcoatRoughness: 0.08,
    });

  const dominoCubeTiles = {
    white: makeDominoTileMaterial(0xf8f6f0),
    yellow: makeDominoTileMaterial(0xf5b301),
    red: makeDominoTileMaterial(0xdc2626),
    orange: makeDominoTileMaterial(0xf97316),
    blue: makeDominoTileMaterial(0x2563eb),
    green: makeDominoTileMaterial(0x10b981),
  };

  const allMaterials: THREE.Material[] = [
    tableTop,
    tableEdge,
    tableFrame,
    padRing,
    padRecess,
    labFloor,
    gunmetal,
    darkAnodized,
    brushedAluminum,
    machinedSteel,
    rubberGrip,
    cableSheath,
    contactShadow,
    cubeCore,
    ...Object.values(cubeTiles),
    mirrorCubeCore,
    ...Object.values(mirrorCubeTiles),
    dominoCubeCore,
    ...Object.values(dominoCubeTiles),
  ];
  const allTextures: THREE.Texture[] = [
    gridMap,
    brushedBump,
    mirrorChrome.albedoMap,
    mirrorChrome.bumpMap,
    knurlBump,
    shadowMap,
  ];

  return {
    tableTop,
    tableEdge,
    tableFrame,
    padRing,
    padRecess,
    labFloor,
    gunmetal,
    darkAnodized,
    brushedAluminum,
    machinedSteel,
    rubberGrip,
    cableSheath,
    contactShadow,
    cubeCore,
    cubeTiles,
    mirrorCubeCore,
    mirrorCubeTiles,
    dominoCubeCore,
    dominoCubeTiles,
    dispose() {
      for (const mat of allMaterials) mat.dispose();
      for (const tex of allTextures) tex.dispose();
    },
  };
}
