import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import characterAsset from "@/assets/character.vrm.asset.json";
import joggingAsset from "@/assets/Jogging.fbx.asset.json";
import { loadMixamoAnimation } from "@/lib/loadMixamoAnimation";

type Enemy = {
  mesh: THREE.Mesh;
  hp: number;
  maxHp: number;
  alive: boolean;
  hitCooldown: number;
  respawnIn: number;
  spawn: THREE.Vector3;
  state: "idle" | "chase";
  patrolDir: number;
  patrolTimer: number;
};

const WORLD_SIZE = 200;
const PLAYER_MAX_HP = 100;
const ENEMY_MAX_HP = 40;
const ATTACK_DAMAGE = 25;
const ATTACK_RANGE = 3.2;
const ENEMY_DAMAGE = 8;
const AGRO_RANGE = 8;
const MELEE_RANGE = 1.6;

// ---- Procedural VRM animation ----
const animState = {
  t: 0,
  walkBlend: 0, // 0..1
  runBlend: 0,  // 0..1
  // smoothed bone rotations for soft transitions
  smoothed: new Map<string, { x: number; y: number; z: number }>(),
};

// Cached secondary bones (hair, ears, tail-like) discovered once per VRM.
const secondaryCache = new WeakMap<
  object,
  { hair: THREE.Object3D[]; ears: THREE.Object3D[]; breasts: THREE.Object3D[] }
>();

function getSecondaryBones(vrm: VRM) {
  const key = vrm as unknown as object;
  const cached = secondaryCache.get(key);
  if (cached) return cached;
  const hair: THREE.Object3D[] = [];
  const ears: THREE.Object3D[] = [];
  const breasts: THREE.Object3D[] = [];
  vrm.scene?.traverse((o) => {
    const n = (o.name || "").toLowerCase();
    if (!n) return;
    if (n.includes("hair")) hair.push(o);
    if (n.includes("ear") || n.includes("bunny") || n.includes("usagi")) ears.push(o);
    if (
      n.includes("breast") ||
      n.includes("bust") ||
      n.includes("mune") ||
      n.includes("oppai") ||
      n.includes("chichi") ||
      n.includes("boob")
    ) breasts.push(o);
  });
  // Store base rotations so we add on top, not overwrite.
  [...hair, ...ears, ...breasts].forEach((o) => {
    o.userData._baseRot = o.userData._baseRot ?? {
      x: o.rotation.x,
      y: o.rotation.y,
      z: o.rotation.z,
    };
    o.userData._jiggle = o.userData._jiggle ?? { x: 0, vx: 0, y: 0, vy: 0, z: 0, vz: 0 };
  });
  const entry = { hair, ears, breasts };
  secondaryCache.set(key, entry);
  return entry;
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function quatTuple(x: number, y: number, z: number): [number, number, number, number] {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, "XYZ"));
  return [q.x, q.y, q.z, q.w];
}

function setBone(
  vrm: VRM,
  name: Parameters<NonNullable<VRM["humanoid"]>["getNormalizedBoneNode"]>[0],
  x: number,
  y: number,
  z: number,
  smooth = 0.25
) {
  const node = vrm.humanoid?.getNormalizedBoneNode(name);
  if (!node) return;
  const key = name as string;
  const prev = animState.smoothed.get(key) ?? { x: 0, y: 0, z: 0 };
  const nx = lerp(prev.x, x, smooth);
  const ny = lerp(prev.y, y, smooth);
  const nz = lerp(prev.z, z, smooth);
  animState.smoothed.set(key, { x: nx, y: ny, z: nz });
  node.rotation.set(nx, ny, nz);
}

function updateCharacterAnimation(
  vrm: VRM,
  dt: number,
  opts: { speed: number; maxSpeed: number; attackTimer: number; dead: boolean; runActive?: boolean }
) {
  const { speed, attackTimer, dead, runActive } = opts;

  // --- Attack pose progression (windup → strike → recovery) ---
  const attackDur = 0.35;
  const ap = attackTimer > 0 ? 1 - Math.min(1, attackTimer / attackDur) : -1;
  let attackArmX = 0;
  let attackElbow = 0;
  let attackTorso = 0;
  if (ap >= 0) {
    if (ap < 0.35) {
      const k = ap / 0.35;
      attackArmX = 0.9 * k;
      attackElbow = 1.4 * k;
      attackTorso = -0.05 * k;
    } else if (ap < 0.7) {
      const k = (ap - 0.35) / 0.35;
      attackArmX = lerp(0.9, -1.8, k);
      attackElbow = lerp(1.4, 0.2, k);
      attackTorso = lerp(-0.05, 0.18, k);
    } else {
      const k = (ap - 0.7) / 0.3;
      attackArmX = lerp(-1.8, 0, k);
      attackElbow = lerp(0.2, 0, k);
      attackTorso = lerp(0.18, 0, k);
    }
  }
  const attackMix = ap >= 0 ? 1 : 0;

  // Locomotion blending — responsive enough for sprint, still soft on idle↔move.
  const walkThreshold = 0.4;
  const runThreshold = 6.5;
  const isMoving = speed > walkThreshold;
  const targetWalk = isMoving ? 1 : 0;
  const targetRun = speed > runThreshold ? Math.min(1, (speed - runThreshold) / 2.5) : 0;
  animState.walkBlend = lerp(animState.walkBlend, targetWalk, Math.min(1, dt * 6));
  animState.runBlend = lerp(animState.runBlend, targetRun, Math.min(1, dt * 8));

  // Stride-matched cadence so the body does not look like it is sliding.
  // The sprint cadence is capped so the smoothing does not flatten the legs.
  const moveRatio = opts.maxSpeed > 0 ? Math.min(1, speed / opts.maxSpeed) : 0;
  const stepAmpTarget = 0.55 + animState.runBlend * 0.55; // long, readable sprint stride
  const legLen = 0.85;
  const stridePerStep = Math.max(0.35, 2 * legLen * Math.sin(stepAmpTarget));
  const cadence = isMoving ? Math.min(5.0, Math.max(1.8, speed / stridePerStep)) : 0;
  const stepFreq = cadence * Math.PI;
  // Always advance time a bit so idle breath/sway keep flowing
  animState.t += dt * (stepFreq > 0 ? stepFreq : 1.2);
  const t = animState.t;

  const walk = animState.walkBlend;
  const run = animState.runBlend;
  const walkOnly = walk * (1 - run);
  const sprint = walk * run;
  const idle = Math.max(0, 1 - walk);

  // When the FBX run clip drives the rig, skip every body bone the mixer owns
  // so we don't fight it. Hair / ears / vertical bounce still run.
  if (runActive) {
    animState.t += dt * 2.4;
    const t2 = animState.t;
    const { hair, ears, breasts } = getSecondaryBones(vrm);
    const hasSprings = !!(vrm as unknown as { springBoneManager?: { joints?: { size?: number } } })
      .springBoneManager?.joints?.size;
    const swayAmp = 0.22;
    const sideAmp = 0.14;
    if (!hasSprings) {
      hair.forEach((h, i) => {
        const b = h.userData._baseRot;
        const phase = i * 0.25;
        h.rotation.x = b.x + Math.sin(t2 * 1.6 + phase) * swayAmp;
        h.rotation.z = b.z + Math.sin(t2 * 1.1 + phase) * sideAmp;
      });
    }
    ears.forEach((e, i) => {
      const b = e.userData._baseRot;
      const sign = i % 2 === 0 ? 1 : -1;
      e.rotation.x = b.x + Math.sin(t2 * 1.8) * 0.18;
      e.rotation.z = b.z + sign * Math.sin(t2 * 1.3) * 0.1;
    });
    // Bust jiggle while sprinting — driven by vertical bounce frequency.
    updateBustJiggle(breasts, dt, {
      driveY: Math.sin(t2 * 2.0) * 0.35,
      driveX: Math.sin(t2 * 1.0) * 0.18,
      stiffness: 38,
      damping: 5.2,
    });
    return;
  }

  // --- Breathing & idle sway ---
  const breath = Math.sin(t * 0.9) * 0.04 * idle;       // chest up/down
  const idleSway = Math.sin(t * 0.6) * 0.03 * idle;     // hip sway
  const idleArm = Math.sin(t * 0.8) * 0.05 * idle;      // arm subtle motion
  const headBob = Math.sin(t * 0.7) * 0.03 * idle;

  // --- Walk/Run cycle ---
  // Legs drive the cycle; arms lag slightly behind (more human and less robotic).
  const legPhase = t;
  const armLag = 0.18 + sprint * 0.08;
  const armPhase = t - armLag;

  const legCycle = Math.sin(legPhase);
  const armCycle = Math.sin(armPhase);
  const cosCycle = Math.cos(legPhase);

  const stepAmp = stepAmpTarget;
  const armSwing = (0.42 * walkOnly + 1.15 * sprint) * (0.85 + moveRatio * 0.15);
  // Upright walk, athletic sprint lean.
  const torsoLean = -(0.02 * walkOnly + 0.24 * sprint);
  // Run has a springy flight/contact bounce: two impacts per full stride.
  const runImpact = Math.pow(Math.max(0, Math.abs(cosCycle)), 1.7);
  const vertical = (Math.abs(cosCycle) - 0.5) * 0.06 * walkOnly + (runImpact - 0.55) * 0.12 * sprint;
  // Feminine, energetic hip sway without Y-axis twist, keeping knees aligned.
  const hipSwayLateral = Math.sin(legPhase * 0.5) * 0.15 * walkOnly + Math.sin(legPhase) * 0.11 * sprint;
  const hipRoll = Math.sin(legPhase) * 0.035 * sprint;
  const bodyDrive = Math.sin(legPhase + 0.4) * 0.03 * sprint;
  const limbSmooth = 0.32 + sprint * 0.35;
  // Legs need a snappier response so the knee bend actually registers on each
  // step instead of being smoothed into a near-straight line.
  const legSmooth = 0.55 + sprint * 0.25;
  const coreSmooth = 0.22 + sprint * 0.16;

  // Hips — only lateral tilt (no Y twist, which would rotate the legs and
  // make knees point inward). Sprint drive stays on X/Z axes.
  setBone(vrm, "hips",
    torsoLean + breath * 0.3 + hipRoll,
    idleSway * 0.5,
    Math.sin(t * 0.5) * 0.02 * idle + hipSwayLateral
    , coreSmooth
  );

  // Spine / chest — NO Y twist. Counter-tilt gives force without spinning.
  setBone(vrm, "spine",
    -0.02 + breath + attackTorso + bodyDrive,
    0,
    -hipSwayLateral * 0.28,
    coreSmooth
  );
  setBone(vrm, "chest",
    -0.02 + breath * 1.2 + bodyDrive * 0.6,
    0,
    -hipSwayLateral * 0.36,
    coreSmooth
  );
  setBone(vrm, "upperChest",
    -0.01 + breath * 0.8 + bodyDrive * 0.4,
    0,
    -hipSwayLateral * 0.18,
    coreSmooth
  );

  // Neck / head — kept level, no twist.
  setBone(vrm, "neck",
    -breath * 0.5 + headBob - vertical * 0.35,
    0,
    -hipSwayLateral * 0.12,
    coreSmooth
  );
  setBone(vrm, "head",
    headBob * 0.6 - 0.02 * walk - vertical * 0.18,
    Math.sin(t * 0.3) * 0.04 * idle,
    hipSwayLateral * 0.16,
    coreSmooth
  );

  // --- Arms ---
  // Rest pose: arms down along body (slightly relaxed shoulders).
  const armRest = 1.22;
  // Arms swing OPPOSITE to same-side leg (right arm forward when right leg back).
  // Suppress walk swing on the attacking (right) arm during attack.
  const rArmSwing = -armCycle * armSwing * (1 - attackMix);
  const lArmSwing = armCycle * armSwing;

  // Running drives elbows and shoulders strongly; no side twist that fights the rig.
  const armForwardBias = 0.04 * walkOnly + 0.02 * sprint;
  const rElbowDrive = 0.55 + 0.35 * sprint + Math.max(0, rArmSwing) * 0.35;
  const lElbowDrive = 0.55 + 0.35 * sprint + Math.max(0, lArmSwing) * 0.35;
  setBone(vrm, "rightUpperArm",
    rArmSwing + attackArmX + armForwardBias,
    rArmSwing * 0.06,
    -armRest + idleArm * 0.4 - 0.06 * walk + 0.12 * sprint,
    limbSmooth
  );
  setBone(vrm, "rightLowerArm",
    -rElbowDrive - attackElbow,
    -0.03 * walk,
    -0.08,
    limbSmooth
  );
  setBone(vrm, "rightHand",
    0,
    0,
    -0.08 - rArmSwing * 0.08,
    limbSmooth
  );

  setBone(vrm, "leftUpperArm",
    lArmSwing + armForwardBias,
    lArmSwing * 0.06,
    armRest - idleArm * 0.4 + 0.06 * walk - 0.12 * sprint,
    limbSmooth
  );
  setBone(vrm, "leftLowerArm",
    -lElbowDrive,
    0.03 * walk,
    0.08,
    limbSmooth
  );
  setBone(vrm, "leftHand",
    0,
    0,
    0.08 + lArmSwing * 0.08,
    limbSmooth
  );

  // --- Legs ---
  // Full sprint cycle: thigh drive, knee lift, contact compression and toe-off.
  // Only X rotations on legs/feet to prevent inward knee/ankle twisting.
  const walkHipAmp = stepAmp * walkOnly;
  const runHipAmp = 1.18 * sprint;
  const rSwing = Math.max(0, legCycle);
  const lSwing = Math.max(0, -legCycle);
  const rBack = Math.max(0, -legCycle);
  const lBack = Math.max(0, legCycle);
  const rLift = Math.max(0, cosCycle);
  const lLift = Math.max(0, -cosCycle);
  const rGround = Math.max(0, -cosCycle);
  const lGround = Math.max(0, cosCycle);
  // Knee flexion — VRM lower-leg bones must bend opposite the thigh swing.
  // Using a visible negative X fold makes the knee articulate instead of the
  // whole leg rotating like one stiff piece.
  const kneeBase = 0.24 * walk;
  const walkKneeSwing = 1.25 * walkOnly;   // clear bend while the foot is lifted
  const walkKneeContact = 0.72 * walkOnly; // stance compression / push-off bend
  const runKneePower = 2.05 * sprint;
  const runContactBend = 0.5 * sprint;

  const rLegSwing = legCycle * walkHipAmp + (rSwing * 0.92 - rBack * 0.68) * runHipAmp;
  const lLegSwing = -legCycle * walkHipAmp + (lSwing * 0.92 - lBack * 0.68) * runHipAmp;
  const rKneeBend =
    kneeBase +
    rSwing * rSwing * (walkKneeSwing + runKneePower) +
    rGround * (walkKneeContact + runContactBend);
  const lKneeBend =
    kneeBase +
    lSwing * lSwing * (walkKneeSwing + runKneePower) +
    lGround * (walkKneeContact + runContactBend);
  const rKnee = -rKneeBend;
  const lKnee = -lKneeBend;
  const rFoot = -rLegSwing * 0.42 + rKneeBend * 0.22 + rSwing * 0.2 * walkOnly + rLift * 0.42 * sprint - rGround * 0.18 * sprint;
  const lFoot = -lLegSwing * 0.42 + lKneeBend * 0.22 + lSwing * 0.2 * walkOnly + lLift * 0.42 * sprint - lGround * 0.18 * sprint;

  setBone(vrm, "rightUpperLeg", rLegSwing, 0, 0, legSmooth);
  setBone(vrm, "rightLowerLeg", rKnee, 0, 0, 1);
  setBone(vrm, "rightFoot", rFoot, 0, 0, legSmooth);

  setBone(vrm, "leftUpperLeg", lLegSwing, 0, 0, legSmooth);
  setBone(vrm, "leftLowerLeg", lKnee, 0, 0, 1);
  setBone(vrm, "leftFoot", lFoot, 0, 0, legSmooth);

  // Apply the same leg pose through the VRM humanoid API as well. This is the
  // rig-correct path and prevents vrm.update() from flattening/overriding knees.
  vrm.humanoid?.setNormalizedPose({
    rightUpperLeg: { rotation: quatTuple(rLegSwing, 0, 0) },
    rightLowerLeg: { rotation: quatTuple(rKnee, 0, 0) },
    rightFoot: { rotation: quatTuple(rFoot, 0, 0) },
    leftUpperLeg: { rotation: quatTuple(lLegSwing, 0, 0) },
    leftLowerLeg: { rotation: quatTuple(lKnee, 0, 0) },
    leftFoot: { rotation: quatTuple(lFoot, 0, 0) },
  });

  // Vertical bounce on root.
  if (vrm.scene) {
    const base = vrm.scene.userData._baseY ?? vrm.scene.position.y;
    vrm.scene.userData._baseY = base;
    vrm.scene.position.y = base + vertical;
  }

  // --- Secondary motion: hair + bunny ears (procedural follow) ---
  // Real VRM spring bones (if present) animate via vrm.update(); this layer
  // adds a guaranteed gentle sway even when no spring rig is authored.
  const { hair, ears, breasts } = getSecondaryBones(vrm);
  const hasSprings = !!(vrm as unknown as { springBoneManager?: { joints?: { size?: number } } })
    .springBoneManager?.joints?.size;
  const swayAmp = 0.05 + walkOnly * 0.08 + sprint * 0.2;
  const hairWave = Math.sin(t * 0.9 - 0.4) * swayAmp + vertical * 0.8;
  const hairSide = Math.sin(legPhase * 0.5 - 0.6) * (0.04 + walkOnly * 0.05 + sprint * 0.12);
  if (!hasSprings) {
    hair.forEach((h, i) => {
      const b = h.userData._baseRot;
      const phase = i * 0.25;
      h.rotation.x = b.x + Math.sin(t * 0.9 + phase) * swayAmp * 0.65 + hairWave * 0.45;
      h.rotation.z = b.z + hairSide + Math.sin(t * 0.7 + phase) * (0.02 + sprint * 0.04);
    });
  }
  const earWobble = Math.sin(t * 1.4) * (0.03 + walkOnly * 0.04 + sprint * 0.12) + vertical * (0.6 + sprint * 0.7);
  ears.forEach((e, i) => {
    const b = e.userData._baseRot;
    const sign = i % 2 === 0 ? 1 : -1;
    e.rotation.x = b.x + earWobble;
    e.rotation.z = b.z + sign * Math.sin(t * 1.1) * (0.02 + sprint * 0.08);
  });

  // --- Bust jiggle (spring-damper) — reacts to vertical bounce + breathing ---
  // Drive grows with locomotion intensity; breathing keeps subtle motion on idle.
  const bustDriveY = vertical * (1.6 + sprint * 1.4) + breath * 0.5;
  const bustDriveX = hipSwayLateral * 0.35;
  updateBustJiggle(breasts, dt, {
    driveY: bustDriveY,
    driveX: bustDriveX,
    stiffness: 32 + sprint * 14,
    damping: 5.5,
  });

  if (dead) {
    // Collapse: tilt forward
    setBone(vrm, "hips", 1.4, 0, 0, 0.15);
  }
}

// Critically-damped-ish spring solver for bust bones. Applied as small Euler
// offsets on top of the rest pose so it never breaks the rig orientation.
function updateBustJiggle(
  bones: THREE.Object3D[],
  dt: number,
  opts: { driveY: number; driveX: number; stiffness: number; damping: number }
) {
  if (!bones.length) return;
  const { driveY, driveX, stiffness, damping } = opts;
  // Sub-step for stability when framerate dips.
  const sub = 2;
  const h = Math.min(dt, 0.033) / sub;
  for (const b of bones) {
    const base = b.userData._baseRot as { x: number; y: number; z: number };
    const s = b.userData._jiggle as { x: number; vx: number; y: number; vy: number; z: number; vz: number };
    const tx = driveY;       // bounce → pitch (X)
    const tz = driveX;       // sway → roll (Z)
    for (let i = 0; i < sub; i++) {
      const ax = -stiffness * (s.x - tx) - damping * s.vx;
      const az = -stiffness * (s.z - tz) - damping * s.vz;
      s.vx += ax * h; s.x += s.vx * h;
      s.vz += az * h; s.z += s.vz * h;
    }
    // Clamp so it never deforms into the body.
    const cx = Math.max(-0.35, Math.min(0.35, s.x));
    const cz = Math.max(-0.25, Math.min(0.25, s.z));
    b.rotation.x = base.x + cx;
    b.rotation.z = base.z + cz;
  }
}

export default function Game() {
  const mountRef = useRef<HTMLDivElement>(null);
  const [hp, setHp] = useState(PLAYER_MAX_HP);
  const [loading, setLoading] = useState(true);
  const [score, setScore] = useState(0);
  const [dead, setDead] = useState(false);

  // Mobile input bridges (read by the game loop)
  const moveRef = useRef({ x: 0, y: 0 }); // joystick vector, -1..1, y forward
  const runRef = useRef(false);
  const jumpRef = useRef(false); // edge-triggered
  const attackRef = useRef(false); // edge-triggered
  const lookDeltaRef = useRef({ x: 0, y: 0 }); // accumulated touch look delta
  const isTouch =
    typeof window !== "undefined" &&
    ("ontouchstart" in window || (navigator as any).maxTouchPoints > 0);

  useEffect(() => {
    const mount = mountRef.current!;
    const isMobileDevice =
      typeof navigator !== "undefined" &&
      (/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
        (typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches));
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x9bc4e8);
    scene.fog = new THREE.Fog(0xbcd9ef, 70, 200);

    const camera = new THREE.PerspectiveCamera(
      60,
      mount.clientWidth / mount.clientHeight,
      0.1,
      500
    );

    const renderer = new THREE.WebGLRenderer({
      antialias: !isMobileDevice,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobileDevice ? 1.5 : 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = isMobileDevice ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    mount.appendChild(renderer.domElement);

    // Image-based lighting via a tiny procedural room — gives soft, realistic
    // PBR ambient on metals/skin without downloading an HDRI.
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTex;

    // Three-point-ish lighting: warm sun key + cool sky fill + rim back light.
    const hemi = new THREE.HemisphereLight(0xb8d8ff, 0x4a5a3a, 0.55);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff1d6, 2.2);
    sun.position.set(40, 70, 25);
    sun.castShadow = true;
    const shMap = isMobileDevice ? 1024 : 2048;
    sun.shadow.mapSize.set(shMap, shMap);
    // Tighter shadow camera = sharper, less aliased shadows around the player.
    const shR = isMobileDevice ? 30 : 60;
    sun.shadow.camera.left = -shR;
    sun.shadow.camera.right = shR;
    sun.shadow.camera.top = shR;
    sun.shadow.camera.bottom = -shR;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 200;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.04;
    sun.shadow.radius = isMobileDevice ? 1 : 3;
    scene.add(sun);
    const rim = new THREE.DirectionalLight(0xa8c8ff, 0.6);
    rim.position.set(-30, 30, -40);
    scene.add(rim);

    // Ground
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, 32, 32),
      new THREE.MeshStandardMaterial({ color: 0x4a8f3a })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    // Boundary walls (visual)
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x8b6b4a });
    const wallH = 4;
    const walls: THREE.Mesh[] = [];
    const wallDefs = [
      { x: 0, z: -WORLD_SIZE / 2, w: WORLD_SIZE, d: 1 },
      { x: 0, z: WORLD_SIZE / 2, w: WORLD_SIZE, d: 1 },
      { x: -WORLD_SIZE / 2, z: 0, w: 1, d: WORLD_SIZE },
      { x: WORLD_SIZE / 2, z: 0, w: 1, d: WORLD_SIZE },
    ];
    wallDefs.forEach((w) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w.w, wallH, w.d), wallMat);
      m.position.set(w.x, wallH / 2, w.z);
      m.castShadow = true;
      m.receiveShadow = true;
      scene.add(m);
      walls.push(m);
    });

    // Decorative obstacles (rocks/trees) — also collidable
    type Obstacle = { pos: THREE.Vector3; radius: number };
    const obstacles: Obstacle[] = [];
    const rng = (min: number, max: number) => Math.random() * (max - min) + min;
    for (let i = 0; i < 40; i++) {
      const isTree = Math.random() > 0.4;
      const x = rng(-WORLD_SIZE / 2 + 5, WORLD_SIZE / 2 - 5);
      const z = rng(-WORLD_SIZE / 2 + 5, WORLD_SIZE / 2 - 5);
      if (Math.hypot(x, z) < 8) continue;
      if (isTree) {
        const trunk = new THREE.Mesh(
          new THREE.CylinderGeometry(0.5, 0.7, 4, 8),
          new THREE.MeshStandardMaterial({ color: 0x5a3a22 })
        );
        trunk.position.set(x, 2, z);
        trunk.castShadow = true;
        const leaves = new THREE.Mesh(
          new THREE.ConeGeometry(2.5, 5, 8),
          new THREE.MeshStandardMaterial({ color: 0x2f6b2a })
        );
        leaves.position.set(x, 6, z);
        leaves.castShadow = true;
        scene.add(trunk, leaves);
        obstacles.push({ pos: new THREE.Vector3(x, 0, z), radius: 1.2 });
      } else {
        const r = rng(1, 2.4);
        const rock = new THREE.Mesh(
          new THREE.DodecahedronGeometry(r, 0),
          new THREE.MeshStandardMaterial({ color: 0x888880, flatShading: true })
        );
        rock.position.set(x, r * 0.6, z);
        rock.castShadow = true;
        rock.receiveShadow = true;
        scene.add(rock);
        obstacles.push({ pos: new THREE.Vector3(x, 0, z), radius: r });
      }
    }

    // Player container — VRM is loaded async
    const player = new THREE.Group();
    player.position.set(0, 0, 0);
    scene.add(player);

    // Placeholder until VRM loads
    const placeholder = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.4, 1.0, 4, 8),
      new THREE.MeshStandardMaterial({ color: 0x3366ff })
    );
    placeholder.position.y = 0.9;
    placeholder.castShadow = true;
    player.add(placeholder);

    let vrm: VRM | null = null;
    let mixer: THREE.AnimationMixer | null = null;
    let runAction: THREE.AnimationAction | null = null;
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    loader.load(
      characterAsset.url,
      (gltf) => {
        const loadedVrm = gltf.userData.vrm as VRM | undefined;
        console.log("[Game] GLTF loaded", { hasVrm: !!loadedVrm, scene: gltf.scene });
        const sceneRoot = loadedVrm ? loadedVrm.scene : gltf.scene;
        try {
          VRMUtils.removeUnnecessaryVertices(gltf.scene);
          VRMUtils.combineSkeletons(gltf.scene);
        } catch (e) {
          console.warn("[Game] VRMUtils failed", e);
        }
        sceneRoot.traverse((o) => {
          o.castShadow = true;
          o.frustumCulled = false;
        });
        // Texture quality pass — anisotropy + correct color space on base maps.
        const maxAniso = renderer.capabilities.getMaxAnisotropy?.() ?? 1;
        const targetAniso = Math.min(maxAniso, isMobileDevice ? 4 : 8);
        sceneRoot.traverse((o) => {
          const m = (o as THREE.Mesh).material as
            | THREE.Material
            | THREE.Material[]
            | undefined;
          if (!m) return;
          const mats = Array.isArray(m) ? m : [m];
          for (const mat of mats) {
            const anyMat = mat as unknown as Record<string, THREE.Texture | undefined>;
            for (const slot of ["map", "emissiveMap", "matcapTexture", "shadeMultiplyTexture"] as const) {
              const tex = anyMat[slot];
              if (tex && (tex as THREE.Texture).isTexture) {
                tex.anisotropy = targetAniso;
                tex.colorSpace = THREE.SRGBColorSpace;
                tex.needsUpdate = true;
              }
            }
            for (const slot of ["normalMap", "roughnessMap", "metalnessMap", "aoMap"] as const) {
              const tex = anyMat[slot];
              if (tex && (tex as THREE.Texture).isTexture) {
                tex.anisotropy = targetAniso;
              }
            }
          }
        });
        // Compute bounding box to auto-scale & ground the model
        const box = new THREE.Box3().setFromObject(sceneRoot);
        const size = new THREE.Vector3();
        box.getSize(size);
        console.log("[Game] model size", size);
        const targetHeight = 1.7;
        if (size.y > 0.01) {
          const s = targetHeight / size.y;
          sceneRoot.scale.setScalar(s);
        }
        // Re-measure & lift so feet sit on y=0
        const box2 = new THREE.Box3().setFromObject(sceneRoot);
        sceneRoot.position.y -= box2.min.y;
        sceneRoot.rotation.y = Math.PI;
        player.remove(placeholder);
        player.add(sceneRoot);
        if (loadedVrm) vrm = loadedVrm;
        if (loadedVrm) {
          loadMixamoAnimation(joggingAsset.url, loadedVrm)
            .then((clip) => {
              mixer = new THREE.AnimationMixer(loadedVrm.scene);
              runAction = mixer.clipAction(clip);
              runAction.play();
              runAction.setEffectiveWeight(0);
              console.log("[Game] Jogging clip ready", clip.duration);
            })
            .catch((err) => console.error("[Game] Jogging load failed", err));
        }
        setLoading(false);
      },
      (xhr) => {
        if (xhr.lengthComputable) {
          console.log(`[Game] VRM ${(xhr.loaded / xhr.total * 100).toFixed(0)}%`);
        }
      },
      (err) => {
        console.error("VRM load failed", err);
        setLoading(false);
      }
    );

    // Enemies
    const enemies: Enemy[] = [];
    const enemyMat = new THREE.MeshStandardMaterial({ color: 0xc83232 });
    function spawnEnemy(pos?: THREE.Vector3) {
      const p =
        pos ??
        new THREE.Vector3(
          rng(-WORLD_SIZE / 2 + 10, WORLD_SIZE / 2 - 10),
          0,
          rng(-WORLD_SIZE / 2 + 10, WORLD_SIZE / 2 - 10)
        );
      const mesh = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.5, 1.2, 4, 8),
        enemyMat.clone()
      );
      mesh.position.copy(p);
      mesh.position.y = 1.1;
      mesh.castShadow = true;
      scene.add(mesh);
      enemies.push({
        mesh,
        hp: ENEMY_MAX_HP,
        maxHp: ENEMY_MAX_HP,
        alive: true,
        hitCooldown: 0,
        respawnIn: 0,
        spawn: p.clone(),
        state: "idle",
        patrolDir: Math.random() * Math.PI * 2,
        patrolTimer: Math.random() * 2,
      });
    }
    for (let i = 0; i < 8; i++) spawnEnemy();

    // Input
    const keys: Record<string, boolean> = {};
    const onKeyDown = (e: KeyboardEvent) => {
      keys[e.code] = true;
      if (e.code === "Space") e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      keys[e.code] = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    // Mouse look (pointer lock)
    let yaw = 0;
    let pitch = -0.2;
    const onMouseMove = (e: MouseEvent) => {
      if (document.pointerLockElement !== renderer.domElement) return;
      yaw -= e.movementX * 0.0025;
      pitch -= e.movementY * 0.0025;
      pitch = Math.max(-1.0, Math.min(0.6, pitch));
    };
    const onClick = () => {
      if (isTouch) return;
      if (document.pointerLockElement !== renderer.domElement) {
        renderer.domElement.requestPointerLock();
      }
    };
    renderer.domElement.addEventListener("click", onClick);
    window.addEventListener("mousemove", onMouseMove);

    // Touch camera look — drag anywhere on the canvas
    const activeTouches = new Map<number, { x: number; y: number }>();
    const onTouchStart = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        activeTouches.set(t.identifier, { x: t.clientX, y: t.clientY });
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        const prev = activeTouches.get(t.identifier);
        if (!prev) continue;
        const dx = t.clientX - prev.x;
        const dy = t.clientY - prev.y;
        lookDeltaRef.current.x += dx;
        lookDeltaRef.current.y += dy;
        activeTouches.set(t.identifier, { x: t.clientX, y: t.clientY });
      }
      e.preventDefault();
    };
    const onTouchEnd = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        activeTouches.delete(t.identifier);
      }
    };
    renderer.domElement.addEventListener("touchstart", onTouchStart, { passive: true });
    renderer.domElement.addEventListener("touchmove", onTouchMove, { passive: false });
    renderer.domElement.addEventListener("touchend", onTouchEnd, { passive: true });
    renderer.domElement.addEventListener("touchcancel", onTouchEnd, { passive: true });

    // Attack
    let attackTimer = 0;
    let attackCooldown = 0;
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      if (document.pointerLockElement !== renderer.domElement) return;
      tryAttack();
    };
    window.addEventListener("mousedown", onMouseDown);
    const tryAttack = () => {
      if (attackCooldown > 0 || playerState.dead) return;
      attackTimer = 0.35;
      attackCooldown = 0.5;
      const forward = new THREE.Vector3(
        Math.sin(player.rotation.y),
        0,
        Math.cos(player.rotation.y)
      );
      const attackPos = player.position
        .clone()
        .add(forward.multiplyScalar(1.2));
      enemies.forEach((en) => {
        if (!en.alive) return;
        const d = en.mesh.position.distanceTo(attackPos);
        if (d < ATTACK_RANGE) {
          en.hp -= ATTACK_DAMAGE;
          en.hitCooldown = 0.2;
          (en.mesh.material as THREE.MeshStandardMaterial).color.set(0xffffff);
          if (en.hp <= 0) {
            en.alive = false;
            en.respawnIn = 5;
            en.mesh.visible = false;
            playerState.score += 1;
            setScore(playerState.score);
          }
        }
      });
    };

    // Player state
    const playerState = {
      vel: new THREE.Vector3(),
      onGround: true,
      hp: PLAYER_MAX_HP,
      dead: false,
      respawn: 0,
      score: 0,
      damageCooldown: 0,
    };

    function resolveCollision(pos: THREE.Vector3, radius: number) {
      // Walls (world bounds)
      const lim = WORLD_SIZE / 2 - radius - 0.6;
      pos.x = Math.max(-lim, Math.min(lim, pos.x));
      pos.z = Math.max(-lim, Math.min(lim, pos.z));
      // Obstacles
      for (const o of obstacles) {
        const dx = pos.x - o.pos.x;
        const dz = pos.z - o.pos.z;
        const dist = Math.hypot(dx, dz);
        const min = radius + o.radius;
        if (dist < min && dist > 0.0001) {
          const push = (min - dist) / dist;
          pos.x += dx * push;
          pos.z += dz * push;
        }
      }
    }

    function doRespawn() {
      playerState.hp = PLAYER_MAX_HP;
      playerState.dead = false;
      player.position.set(0, 0, 0);
      playerState.vel.set(0, 0, 0);
      setHp(PLAYER_MAX_HP);
      setDead(false);
    }

    const clock = new THREE.Clock();
    let raf = 0;

    const animate = () => {
      raf = requestAnimationFrame(animate);
      const dt = Math.min(clock.getDelta(), 0.05);

      // Apply touch look
      if (lookDeltaRef.current.x !== 0 || lookDeltaRef.current.y !== 0) {
        yaw -= lookDeltaRef.current.x * 0.006;
        pitch -= lookDeltaRef.current.y * 0.006;
        pitch = Math.max(-1.0, Math.min(0.6, pitch));
        lookDeltaRef.current.x = 0;
        lookDeltaRef.current.y = 0;
      }

      // Camera-relative input
      const forward = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
      const right = new THREE.Vector3(Math.sin(yaw + Math.PI / 2), 0, Math.cos(yaw + Math.PI / 2));
      const move = new THREE.Vector3();
      if (!playerState.dead) {
        if (keys["KeyW"] || keys["ArrowUp"]) move.add(forward);
        if (keys["KeyS"] || keys["ArrowDown"]) move.sub(forward);
        if (keys["KeyA"] || keys["ArrowLeft"]) move.sub(right);
        if (keys["KeyD"] || keys["ArrowRight"]) move.add(right);
        // Joystick (mobile)
        const jx = moveRef.current.x;
        const jy = moveRef.current.y;
        if (jx * jx + jy * jy > 0.01) {
          move.add(forward.clone().multiplyScalar(jy));
          move.add(right.clone().multiplyScalar(jx));
        }
      }
      const running = keys["ShiftLeft"] || keys["ShiftRight"] || runRef.current;
      const speed = running ? 9 : 5;
      if (move.lengthSq() > 0) {
        move.normalize().multiplyScalar(speed);
        // Rotate player to face move direction
        const targetYaw = Math.atan2(move.x, move.z);
        const cur = player.rotation.y;
        let diff = targetYaw - cur;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        player.rotation.y += diff * Math.min(1, dt * 12);
      }

      playerState.vel.x = move.x;
      playerState.vel.z = move.z;

      // Jump
      if ((keys["Space"] || jumpRef.current) && playerState.onGround && !playerState.dead) {
        playerState.vel.y = 8;
        playerState.onGround = false;
      }
      jumpRef.current = false;
      if (attackRef.current) {
        attackRef.current = false;
        tryAttack();
      }
      playerState.vel.y -= 22 * dt;

      player.position.x += playerState.vel.x * dt;
      player.position.y += playerState.vel.y * dt;
      player.position.z += playerState.vel.z * dt;

      if (player.position.y <= 0) {
        player.position.y = 0;
        playerState.vel.y = 0;
        playerState.onGround = true;
      }

      resolveCollision(player.position, 0.6);

      // Attack timers
      if (attackTimer > 0) attackTimer -= dt;
      if (attackCooldown > 0) attackCooldown -= dt;
      if (playerState.damageCooldown > 0) playerState.damageCooldown -= dt;

      // Enemies
      enemies.forEach((en) => {
        if (!en.alive) {
          en.respawnIn -= dt;
          if (en.respawnIn <= 0) {
            en.alive = true;
            en.hp = en.maxHp;
            en.mesh.visible = true;
            const angle = Math.random() * Math.PI * 2;
            const r = rng(20, WORLD_SIZE / 2 - 10);
            en.mesh.position.set(Math.cos(angle) * r, 1.1, Math.sin(angle) * r);
            (en.mesh.material as THREE.MeshStandardMaterial).color.set(0xc83232);
            en.state = "idle";
          }
          return;
        }
        // Restore color
        if (en.hitCooldown > 0) {
          en.hitCooldown -= dt;
          if (en.hitCooldown <= 0)
            (en.mesh.material as THREE.MeshStandardMaterial).color.set(0xc83232);
        }

        const to = new THREE.Vector3().subVectors(player.position, en.mesh.position);
        to.y = 0;
        const dist = to.length();

        // State machine
        if (!playerState.dead && dist <= AGRO_RANGE) {
          en.state = "chase";
        } else if (dist > AGRO_RANGE + 2) {
          en.state = "idle";
        }

        if (en.state === "chase" && dist > 0.001 && !playerState.dead) {
          to.normalize();
          const espeed = 3.2;
          en.mesh.position.x += to.x * espeed * dt;
          en.mesh.position.z += to.z * espeed * dt;
          en.mesh.lookAt(player.position.x, en.mesh.position.y, player.position.z);
        } else if (en.state === "idle") {
          // Light patrol
          en.patrolTimer -= dt;
          if (en.patrolTimer <= 0) {
            en.patrolDir = Math.random() * Math.PI * 2;
            en.patrolTimer = 2 + Math.random() * 2;
          }
          const pspeed = 1.2;
          en.mesh.position.x += Math.cos(en.patrolDir) * pspeed * dt;
          en.mesh.position.z += Math.sin(en.patrolDir) * pspeed * dt;
          en.mesh.rotation.y = en.patrolDir + Math.PI;
          const lim = WORLD_SIZE / 2 - 2;
          if (en.mesh.position.x < -lim || en.mesh.position.x > lim || en.mesh.position.z < -lim || en.mesh.position.z > lim) {
            en.patrolDir += Math.PI;
            en.mesh.position.x = Math.max(-lim, Math.min(lim, en.mesh.position.x));
            en.mesh.position.z = Math.max(-lim, Math.min(lim, en.mesh.position.z));
          }
        }

        // Melee attack only when close
        if (en.state === "chase" && dist < MELEE_RANGE && playerState.damageCooldown <= 0 && !playerState.dead) {
          playerState.hp -= ENEMY_DAMAGE;
          playerState.damageCooldown = 0.8;
          setHp(Math.max(0, playerState.hp));
          if (playerState.hp <= 0) {
            playerState.dead = true;
            setDead(true);
            playerState.respawn = 2.5;
          }
        }
      });

      // Respawn
      if (playerState.dead) {
        playerState.respawn -= dt;
        if (playerState.respawn <= 0) doRespawn();
      }

      // Camera follow (third person)
      const camDist = 5;
      const camHeight = 2.2;
      const camOffset = new THREE.Vector3(
        -Math.sin(yaw) * camDist,
        camHeight - pitch * camDist,
        -Math.cos(yaw) * camDist
      );
      const targetCamPos = player.position.clone().add(new THREE.Vector3(0, 1.2, 0)).add(camOffset);
      camera.position.lerp(targetCamPos, Math.min(1, dt * 10));
      const lookAt = player.position.clone().add(new THREE.Vector3(0, 1.3, 0));
      camera.lookAt(lookAt);

      // VRM update
      if (vrm) {
        // Decide how strongly the FBX run animation drives the rig.
        const speedNow = Math.hypot(playerState.vel.x, playerState.vel.z);
        const runTarget = speedNow > 6.5 ? Math.min(1, (speedNow - 6.5) / 2.0) : 0;
        if (runAction) {
          const cur = runAction.getEffectiveWeight();
          const next = lerp(cur, runTarget, Math.min(1, dt * 8));
          runAction.setEffectiveWeight(next);
        }
        const runActive = !!runAction && runAction.getEffectiveWeight() > 0.85;
        updateCharacterAnimation(vrm, dt, {
          speed: speedNow,
          maxSpeed: 9,
          attackTimer,
          dead: playerState.dead,
          runActive,
        });
        if (mixer) mixer.update(dt);
        vrm.update(dt);
      }

      renderer.render(scene, camera);
    };
    animate();

    const onResize = () => {
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("resize", onResize);
      renderer.domElement.removeEventListener("click", onClick);
      renderer.domElement.removeEventListener("touchstart", onTouchStart);
      renderer.domElement.removeEventListener("touchmove", onTouchMove);
      renderer.domElement.removeEventListener("touchend", onTouchEnd);
      renderer.domElement.removeEventListener("touchcancel", onTouchEnd);
      renderer.dispose();
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
    };
  }, []);

  const hpPct = Math.max(0, Math.min(100, (hp / PLAYER_MAX_HP) * 100));

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-black">
      <div ref={mountRef} className="absolute inset-0" />

      {loading && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/70 text-white">
          <div className="text-center">
            <div className="text-2xl font-semibold">Loading hero…</div>
            <div className="mt-2 text-sm opacity-70">Preparing the world</div>
          </div>
        </div>
      )}

      {/* HUD */}
      <div className="pointer-events-none absolute left-4 top-4 z-10 w-64 space-y-2">
        <div className="rounded-md bg-black/50 p-2 backdrop-blur">
          <div className="mb-1 flex items-center justify-between text-xs font-semibold text-white">
            <span>HP</span>
            <span>{Math.max(0, Math.round(hp))}/{PLAYER_MAX_HP}</span>
          </div>
          <div className="h-3 w-full overflow-hidden rounded bg-white/20">
            <div
              className="h-full bg-red-500 transition-all"
              style={{ width: `${hpPct}%` }}
            />
          </div>
        </div>
        <div className="rounded-md bg-black/50 px-3 py-2 text-sm font-semibold text-white backdrop-blur">
          Kills: {score}
        </div>
      </div>

      <div className="pointer-events-none absolute right-4 top-4 z-10 hidden max-w-xs rounded-md bg-black/50 p-3 text-xs text-white backdrop-blur md:block">
        <div className="mb-1 font-bold">Controls</div>
        <div>Click to lock mouse</div>
        <div>WASD — Move</div>
        <div>Shift — Run</div>
        <div>Space — Jump</div>
        <div>Left Click — Attack</div>
        <div>Mouse — Camera</div>
        <div>Esc — Release mouse</div>
      </div>

      {/* Mobile controls */}
      <MobileControls
        moveRef={moveRef}
        runRef={runRef}
        jumpRef={jumpRef}
        attackRef={attackRef}
      />

      {dead && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-red-900/40">
          <div className="rounded-lg bg-black/70 px-8 py-6 text-center text-white">
            <div className="text-3xl font-bold">You died</div>
            <div className="mt-2 text-sm opacity-80">Respawning…</div>
          </div>
        </div>
      )}

      {/* Crosshair */}
      <div className="pointer-events-none absolute left-1/2 top-1/2 z-10 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/80" />
    </div>
  );
}

function MobileControls({
  moveRef,
  runRef,
  jumpRef,
  attackRef,
}: {
  moveRef: React.MutableRefObject<{ x: number; y: number }>;
  runRef: React.MutableRefObject<boolean>;
  jumpRef: React.MutableRefObject<boolean>;
  attackRef: React.MutableRefObject<boolean>;
}) {
  const padRef = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState({ x: 0, y: 0, active: false });
  const touchIdRef = useRef<number | null>(null);
  const [runActive, setRunActive] = useState(false);

  const startStick = (clientX: number, clientY: number) => {
    const el = padRef.current;
    if (!el) return;
    updateStick(clientX, clientY);
  };
  const updateStick = (clientX: number, clientY: number) => {
    const el = padRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const maxR = r.width / 2;
    let dx = clientX - cx;
    let dy = clientY - cy;
    const d = Math.hypot(dx, dy);
    if (d > maxR) {
      dx = (dx / d) * maxR;
      dy = (dy / d) * maxR;
    }
    const nx = dx / maxR;
    const ny = dy / maxR;
    moveRef.current = { x: nx, y: -ny }; // up = forward
    setStick({ x: dx, y: dy, active: true });
  };
  const endStick = () => {
    moveRef.current = { x: 0, y: 0 };
    touchIdRef.current = null;
    setStick({ x: 0, y: 0, active: false });
  };

  const onPadTouchStart = (e: React.TouchEvent) => {
    const t = e.changedTouches[0];
    touchIdRef.current = t.identifier;
    startStick(t.clientX, t.clientY);
  };
  const onPadTouchMove = (e: React.TouchEvent) => {
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === touchIdRef.current) {
        updateStick(t.clientX, t.clientY);
        e.preventDefault();
        break;
      }
    }
  };
  const onPadTouchEnd = (e: React.TouchEvent) => {
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === touchIdRef.current) {
        endStick();
        break;
      }
    }
  };

  const btnBase =
    "select-none touch-none flex items-center justify-center rounded-full font-bold text-white shadow-lg active:scale-95 transition-transform";

  return (
    <div className="pointer-events-none absolute inset-0 z-20 md:hidden">
      {/* Joystick */}
      <div
        ref={padRef}
        onTouchStart={onPadTouchStart}
        onTouchMove={onPadTouchMove}
        onTouchEnd={onPadTouchEnd}
        onTouchCancel={onPadTouchEnd}
        className="pointer-events-auto absolute bottom-6 left-6 h-36 w-36 touch-none rounded-full border-2 border-white/40 bg-white/10 backdrop-blur"
      >
        <div
          className="absolute h-16 w-16 rounded-full bg-white/70 shadow"
          style={{
            left: "50%",
            top: "50%",
            transform: `translate(calc(-50% + ${stick.x}px), calc(-50% + ${stick.y}px))`,
            transition: stick.active ? "none" : "transform 0.15s",
          }}
        />
      </div>

      {/* Action buttons */}
      <div className="pointer-events-auto absolute bottom-8 right-6 flex flex-col items-end gap-3">
        <button
          className={`${btnBase} h-20 w-20 bg-red-500/80 text-lg`}
          onTouchStart={(e) => {
            e.preventDefault();
            attackRef.current = true;
          }}
        >
          ATK
        </button>
        <div className="flex gap-3">
          <button
            className={`${btnBase} h-16 w-16 text-sm ${
              runActive ? "bg-yellow-400/90 text-black" : "bg-yellow-500/80"
            }`}
            onTouchStart={(e) => {
              e.preventDefault();
              runRef.current = true;
              setRunActive(true);
            }}
            onTouchEnd={(e) => {
              e.preventDefault();
              runRef.current = false;
              setRunActive(false);
            }}
            onTouchCancel={() => {
              runRef.current = false;
              setRunActive(false);
            }}
          >
            RUN
          </button>
          <button
            className={`${btnBase} h-16 w-16 bg-blue-500/80 text-sm`}
            onTouchStart={(e) => {
              e.preventDefault();
              jumpRef.current = true;
            }}
          >
            JUMP
          </button>
        </div>
      </div>

      {/* Mobile hint */}
      <div className="pointer-events-none absolute right-2 top-2 max-w-[60%] rounded bg-black/50 p-2 text-[10px] leading-tight text-white backdrop-blur">
        Arraste a tela: girar câmera • Joystick: mover • RUN/JUMP/ATK
      </div>
    </div>
  );
}