import * as THREE from 'three';
import * as xb from 'xrblocks';

import {ControlHUD} from './ControlHUD';
import {WorkbenchScene} from './WorkbenchScene';

/**
 * Detects software WebGL rasterizers (SwiftShader, llvmpipe, WARP) from the
 * WebGL2 renderer string so rendering cost and frame pacing stay responsive
 * without altering any scene content, geometry, or logic.
 */
function detectSoftwareWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return false;
  }
}

/**
 * Paces software-WebGL frames using a WebGL2 fenceSync so the CPU rasterizer
 * finishes before queuing the next frame, keeping browser input and captures instant.
 */
function startSoftwarePacedLoop(renderer: THREE.WebGLRenderer): () => void {
  let stopped = false;
  let timerId = 0;
  let lastTime = performance.now();

  const afterDraw = (cb: () => void) => {
    const gl = renderer.getContext() as WebGL2RenderingContext;
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    const poll = () => {
      if (stopped) {
        if (sync) gl.deleteSync(sync);
        return;
      }
      const status = sync ? gl.getSyncParameter(sync, gl.SYNC_STATUS) : gl.SIGNALED;
      if (status === gl.UNSIGNALED) {
        timerId = window.setTimeout(poll, 5);
      } else {
        if (sync) gl.deleteSync(sync);
        timerId = window.setTimeout(cb, 24);
      }
    };
    timerId = window.setTimeout(poll, 5);
  };

  const tick = () => {
    if (stopped) return;
    const now = performance.now();
    const dtMs = Math.min(1000, Math.max(16, now - lastTime));
    lastTime = now;
    xb.core.stepFrame(dtMs);
    afterDraw(tick);
  };

  xb.core.pause();
  // Immediately render frame 0 so first paint is never blank
  xb.core.stepFrame(16);
  lastTime = performance.now();
  afterDraw(tick);

  return () => {
    stopped = true;
    window.clearTimeout(timerId);
  };
}

async function bootstrap(): Promise<void> {
  const isSoftwareGl = detectSoftwareWebGL();
  const hudRoot = document.getElementById('hud-root');

  let hud: ControlHUD | null = null;
  const workbenchScene = new WorkbenchScene({
    isSoftwareGl,
    onSnapshot: (snapshot) => {
      hud?.updateFromSnapshot(snapshot);
    },
    onXrVisibilityChange: (inXr) => {
      hud?.setVisible(!inXr);
    },
  });

  if (hudRoot) {
    hud = new ControlHUD(hudRoot, {
      onPrimaryAction: () => workbenchScene.triggerPrimaryAction(),
      onScramble: () => workbenchScene.toggleScramble(),
      onAutoSolve: () => workbenchScene.triggerAutoSolve(),
      onSelectPuzzle: (puzzle) => workbenchScene.requestPuzzleSwitch(puzzle),
      onSetSpeed: (speed) => workbenchScene.setSpeedMultiplier(speed),
      onResetCamera: () => workbenchScene.resetCameraView(),
      onToggleMute: () => workbenchScene.toggleMute(),
      isCubeSolved: () => workbenchScene.isCubeSolved(),
    });
  }

  const options = new xb.Options();
  options.enableVR();
  options.enableSimulator = false;
  options.antialias = !isSoftwareGl;
  options.setAppTitle('CubeBotics');
  options.setAppDescription(
    '3D Rubik’s Cube Robotics Lab with dual articulated industrial manipulator arms.',
  );

  xb.add(workbenchScene);
  await xb.init(options);

  // Sync HUD with initial STANDBY snapshot right after init
  hud?.updateFromSnapshot(
    workbenchScene.getAnimationController().getSnapshot(),
  );

  // On software WebGL (headless Chromium / VDI), pace XR Blocks frames with fenceSync
  if (isSoftwareGl && xb.core.renderer instanceof THREE.WebGLRenderer) {
    startSoftwarePacedLoop(xb.core.renderer);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  void bootstrap();
});
