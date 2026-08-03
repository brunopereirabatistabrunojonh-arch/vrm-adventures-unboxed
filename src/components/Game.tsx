import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import characterAsset from "@/assets/character.vrm.asset.json";
import galaxiaAsset from "@/assets/galaxia.vrm.asset.json";
import joggingAsset from "@/assets/Jogging.fbx.asset.json";
import walkingAsset from "@/assets/Walking.fbx.asset.json";
import kickAsset from "@/assets/Roundhouse_Kick.fbx.asset.json";
import tokyoMapAsset from "@/assets/LittlestTokyo.glb.asset.json";
import { loadMixamoAnimation } from "@/lib/loadMixamoAnimation";
import BunnyMenu from "@/components/BunnyMenu";

// ---- Fake VRM humanoid wrapper -------------------------------------------
// Some character GLBs (e.g. VRoid exports converted to plain glTF) use the
// standard J_Bip_* bone names but ship without the VRM extension, so
// VRMLoaderPlugin returns nothing. To keep the same animation pipeline
// (Mixamo retarget + procedural pose) working, we synthesize a minimal
// object with the same shape our code expects from VRM.
const J_BIP_TO_VRM: Record<string, string> = {
  hips: "C_Hips",
  spine: "C_Spine",
  chest: "C_Chest",
  upperChest: "C_UpperChest",
  neck: "C_Neck",
  head: "C_Head",
  leftShoulder: "L_Shoulder",
  leftUpperArm: "L_UpperArm",
  leftLowerArm: "L_LowerArm",
  leftHand: "L_Hand",
  rightShoulder: "R_Shoulder",
  rightUpperArm: "R_UpperArm",
  rightLowerArm: "R_LowerArm",
  rightHand: "R_Hand",
  leftUpperLeg: "L_UpperLeg",
  leftLowerLeg: "L_LowerLeg",
  leftFoot: "L_Foot",
  leftToes: "L_ToeBase",
  rightUpperLeg: "R_UpperLeg",
  rightLowerLeg: "R_LowerLeg",
  rightFoot: "R_Foot",
  rightToes: "R_ToeBase",
};

function buildFakeVrmFromJBip(scene: THREE.Object3D): VRM | null {
  const boneMap = new Map<string, THREE.Object3D>();
  // Index by suffix "C_Hips" from names like "J_Bip_C_Hips_031"
  scene.traverse((o) => {
    const n = o.name || "";
    const m = n.match(/^J_Bip_([LRC]_[A-Za-z]+)/);
    if (m) {
      const key = m[1];
      if (!boneMap.has(key)) boneMap.set(key, o);
    }
  });
  if (!boneMap.has("C_Hips")) return null;
  const nodeFor: Record<string, THREE.Object3D | undefined> = {};
  for (const [vrmName, jbip] of Object.entries(J_BIP_TO_VRM)) {
    const b = boneMap.get(jbip);
    if (b) nodeFor[vrmName] = b;
  }
  const humanoid = {
    getNormalizedBoneNode(name: string) {
      return nodeFor[name] ?? null;
    },
    setNormalizedPose(pose: Record<string, { rotation?: [number, number, number, number] }>) {
      for (const [name, data] of Object.entries(pose)) {
        const node = nodeFor[name];
        if (node && data.rotation) node.quaternion.fromArray(data.rotation);
      }
    },
  };
  const fake = {
    scene,
    humanoid,
    meta: { metaVersion: "0" },
    update: (_dt: number) => {},
  };
  return fake as unknown as VRM;
}

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
  { hair: THREE.Object3D[]; ears: THREE.Object3D[] }
>();

function getSecondaryBones(vrm: VRM) {
  const key = vrm as unknown as object;
  const cached = secondaryCache.get(key);
  if (cached) return cached;
  const hair: THREE.Object3D[] = [];
  const ears: THREE.Object3D[] = [];
  vrm.scene?.traverse((o) => {
    const n = (o.name || "").toLowerCase();
    if (!n) return;
    if (n.includes("hair")) hair.push(o);
    if (n.includes("ear") || n.includes("bunny") || n.includes("usagi")) ears.push(o);
  });
  // Store base rotations so we add on top, not overwrite.
  [...hair, ...ears].forEach((o) => {
    o.userData._baseRot = o.userData._baseRot ?? {
      x: o.rotation.x,
      y: o.rotation.y,
      z: o.rotation.z,
    };
  });
  const entry = { hair, ears };
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
    const { hair, ears } = getSecondaryBones(vrm);
    const swayAmp = 0.22;
    const sideAmp = 0.14;
    hair.forEach((h, i) => {
      const b = h.userData._baseRot;
      const phase = i * 0.25;
      h.rotation.x = b.x + Math.sin(t2 * 1.6 + phase) * swayAmp;
      h.rotation.z = b.z + Math.sin(t2 * 1.1 + phase) * sideAmp;
    });
    ears.forEach((e, i) => {
      const b = e.userData._baseRot;
      const sign = i % 2 === 0 ? 1 : -1;
      e.rotation.x = b.x + Math.sin(t2 * 1.8) * 0.18;
      e.rotation.z = b.z + sign * Math.sin(t2 * 1.3) * 0.1;
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
  const { hair, ears } = getSecondaryBones(vrm);
  const swayAmp = 0.05 + walkOnly * 0.08 + sprint * 0.2;
  const hairWave = Math.sin(t * 0.9 - 0.4) * swayAmp + vertical * 0.8;
  const hairSide = Math.sin(legPhase * 0.5 - 0.6) * (0.04 + walkOnly * 0.05 + sprint * 0.12);
  hair.forEach((h, i) => {
    const b = h.userData._baseRot;
    const phase = i * 0.25;
    h.rotation.x = b.x + Math.sin(t * 0.9 + phase) * swayAmp * 0.65 + hairWave * 0.45;
    h.rotation.z = b.z + hairSide + Math.sin(t * 0.7 + phase) * (0.02 + sprint * 0.04);
  });
  const earWobble = Math.sin(t * 1.4) * (0.03 + walkOnly * 0.04 + sprint * 0.12) + vertical * (0.6 + sprint * 0.7);
  ears.forEach((e, i) => {
    const b = e.userData._baseRot;
    const sign = i % 2 === 0 ? 1 : -1;
    e.rotation.x = b.x + earWobble;
    e.rotation.z = b.z + sign * Math.sin(t * 1.1) * (0.02 + sprint * 0.08);
  });

  if (dead) {
    // Collapse: tilt forward
    setBone(vrm, "hips", 1.4, 0, 0, 0.15);
  }
}

export default function Game() {
  const mountRef = useRef<HTMLDivElement>(null);
  const [hp, setHp] = useState(PLAYER_MAX_HP);
  const [loading, setLoading] = useState(true);
  const [score, setScore] = useState(0);
  const [dead, setDead] = useState(false);
  const [menuOpen, setMenuOpen] = useState(true);
  const [isPortrait, setIsPortrait] = useState(false);
  const [isMobileDevice, setIsMobileDevice] = useState(false);
  const [orientationDismissed, setOrientationDismissed] = useState(false);

  // Track portrait/landscape on mobile so we can force a landscape UI.
  // Uses matchMedia (most reliable across Android Chrome / WebView / iOS Safari)
  // with resize + orientationchange as fallbacks.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const ua = navigator.userAgent || "";
    const touch = "ontouchstart" in window || (navigator as any).maxTouchPoints > 0;
    const uaMobile = /Android|iPhone|iPod|IEMobile|BlackBerry|Opera Mini/i.test(ua);
    const smallScreen = Math.min(window.innerWidth, window.innerHeight) < 900;
    setIsMobileDevice(uaMobile || (touch && smallScreen));

    const mql = window.matchMedia("(orientation: portrait)");
    const check = () => {
      // Prefer screen.orientation.type when available (most accurate on Android).
      const so: any = (screen as any).orientation;
      let portrait: boolean;
      if (so && typeof so.type === "string") {
        portrait = so.type.startsWith("portrait");
      } else if (typeof mql.matches === "boolean") {
        portrait = mql.matches;
      } else {
        portrait = window.innerHeight > window.innerWidth;
      }
      setIsPortrait(portrait);
    };
    check();

    const onMql = () => check();
    if (mql.addEventListener) mql.addEventListener("change", onMql);
    else if ((mql as any).addListener) (mql as any).addListener(onMql);

    window.addEventListener("resize", check);
    window.addEventListener("orientationchange", check);
    const so: any = (screen as any).orientation;
    if (so && typeof so.addEventListener === "function") {
      so.addEventListener("change", check);
    }
    // A short delayed re-check catches Android Chrome cases where innerWidth
    // hasn't updated yet on the initial orientationchange fire.
    const t = window.setTimeout(check, 300);

    return () => {
      window.clearTimeout(t);
      if (mql.removeEventListener) mql.removeEventListener("change", onMql);
      else if ((mql as any).removeListener) (mql as any).removeListener(onMql);
      window.removeEventListener("resize", check);
      window.removeEventListener("orientationchange", check);
      if (so && typeof so.removeEventListener === "function") {
        so.removeEventListener("change", check);
      }
    };
  }, []);

  // Best-effort request for fullscreen + landscape lock (browsers require a
  // user gesture — this runs when the player taps JOGAR / dismisses menu).
  const requestLandscape = () => {
    const tryLock = () => {
      try {
        const so: any = (screen as any).orientation;
        if (so && typeof so.lock === "function") {
          return so.lock("landscape").catch(() => {});
        }
        // Legacy vendor-prefixed APIs (older Android WebViews).
        const legacy =
          (screen as any).lockOrientation ||
          (screen as any).mozLockOrientation ||
          (screen as any).msLockOrientation;
        if (typeof legacy === "function") {
          try { legacy.call(screen, "landscape"); } catch { /* noop */ }
        }
      } catch { /* noop */ }
      return Promise.resolve();
    };
    try {
      const el = document.documentElement as any;
      const req = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen;
      const p = req ? req.call(el) : null;
      if (p && typeof p.then === "function") {
        p.then(tryLock).catch(tryLock);
      } else {
        tryLock();
      }
    } catch {
      tryLock();
    }
    // Allow the game to run regardless of whether the lock succeeded.
    setOrientationDismissed(true);
  };

  // Mobile input bridges (read by the game loop)
  const moveRef = useRef({ x: 0, y: 0 }); // joystick vector, -1..1, y forward
  const runRef = useRef(false);
  const jumpRef = useRef(false); // edge-triggered
  const attackRef = useRef(false); // edge-triggered
  const kickRef = useRef(false); // edge-triggered
  const zoomRef = useRef(0); // accumulated zoom delta (world units)
  const lookDeltaRef = useRef({ x: 0, y: 0 }); // accumulated touch look delta
  const pausedRef = useRef(true); // game frozen while the menu is open
  const isTouch =
    typeof window !== "undefined" &&
    ("ontouchstart" in window || (navigator as any).maxTouchPoints > 0);

  useEffect(() => {
    const mount = mountRef.current!;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x87ceeb);
    scene.fog = new THREE.Fog(0x87ceeb, 60, 180);

    const camera = new THREE.PerspectiveCamera(
      60,
      mount.clientWidth / mount.clientHeight,
      0.1,
      500
    );

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Neutral output so the GLB's authored textures/materials look exactly
    // as exported (no re-grading of the original art).
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);

    // Lights
    const hemi = new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.1);
    scene.add(hemi);
    scene.add(new THREE.AmbientLight(0xffffff, 0.45));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(40, 60, 20);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -80;
    sun.shadow.camera.right = 80;
    sun.shadow.camera.top = 80;
    sun.shadow.camera.bottom = -80;
    scene.add(sun);

    // Invisible safety floor (physics fallback at y=0)
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE),
      new THREE.MeshStandardMaterial({ color: 0x4a8f3a })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    ground.visible = false;
    scene.add(ground);

    // Littlest Tokyo — main map (GLB)
    type Obstacle = { pos: THREE.Vector3; radius: number };
    const obstacles: Obstacle[] = [];
    const rng = (min: number, max: number) => Math.random() * (max - min) + min;
    // Mutable half-extent for the walkable area; updated once the arena bbox is known.
    const arenaBounds = { half: WORLD_SIZE / 2 };
    // Spawn resolved after the map loads (used by initial placement + respawn).
    const spawnPoint = new THREE.Vector3(0, 5, 0);

    {
      // The GLB ships with embedded PBR textures — materials are used as-is.
      const mapLoader = new GLTFLoader();
      mapLoader.load(tokyoMapAsset.url, (gltf) => {
        const stage = gltf.scene;
        // Auto-fit to a target footprint so the map fills the play area.
        const bbox = new THREE.Box3().setFromObject(stage);
        const size = new THREE.Vector3();
        bbox.getSize(size);
        const target = 200; // desired map footprint (units) — human-scale streets
        const maxDim = Math.max(size.x, size.z) || 1;
        const scale = target / maxDim;
        stage.scale.setScalar(scale);

        // Re-measure and center horizontally.
        const bbox2 = new THREE.Box3().setFromObject(stage);
        const center = new THREE.Vector3();
        bbox2.getCenter(center);
        stage.position.x -= center.x;
        stage.position.z -= center.z;
        stage.position.y -= bbox2.min.y; // floor of bbox sits on y=0 baseline

        stage.traverse((obj) => {
          const m = obj as THREE.Mesh;
          if ((m as any).isMesh) {
            m.castShadow = true;
            m.receiveShadow = true;
            // Materials, textures and UVs are left exactly as authored.
          }
        });

        scene.add(stage);
        stage.updateMatrixWorld(true);

        // Update walk clamp to the visible map footprint.
        const after = new THREE.Box3().setFromObject(stage);
        const halfX = (after.max.x - after.min.x) / 2;
        const halfZ = (after.max.z - after.min.z) / 2;
        arenaBounds.half = Math.min(halfX, halfZ) - 1.5;

        // Publish the loaded map root so the physics loop can collide
        // against every mesh (floor, platforms, walls, props).
        stageColliderRef.mesh = stage;
        // Cache per-mesh world bounds so per-frame raycasts only test the
        // handful of meshes near the player instead of all 70+ (perf).
        colliderMeshes.length = 0;
        stage.traverse((obj) => {
          const m = obj as THREE.Mesh;
          if ((m as any).isMesh && m.geometry) {
            m.geometry.computeBoundingBox?.();
            colliderMeshes.push({
              mesh: m,
              box: new THREE.Box3().setFromObject(m),
            });
          }
        });

        // ---- Spawn search: find the dominant street level of the diorama ----
        // Sample a grid over the central area, bucket the top-surface heights
        // and treat the most common height as "street" (open roads dominate).
        const down = new THREE.Vector3(0, -1, 0);
        const up = new THREE.Vector3(0, 1, 0);
        const probe = new THREE.Raycaster();
        const R = arenaBounds.half * 0.7;
        const samples: { x: number; z: number; y: number }[] = [];
        const buckets = new Map<number, number>();
        const STEPS = 26;
        for (let i = 0; i < STEPS; i++) {
          for (let j = 0; j < STEPS; j++) {
            const x = -R + (2 * R * i) / (STEPS - 1);
            const z = -R + (2 * R * j) / (STEPS - 1);
            probe.set(new THREE.Vector3(x, after.max.y + 5, z), down);
            probe.far = after.max.y - after.min.y + 20;
            const h = probe.intersectObject(stage, true);
            if (!h.length) continue;
            const y = h[0].point.y;
            // Skip spots without headroom for the character.
            // Must be open to the sky (outdoor street, not inside a building).
            probe.set(new THREE.Vector3(x, y + 0.25, z), up);
            probe.far = (after.max.y - y) + 5;
            if (probe.intersectObject(stage, true).length) continue;
            samples.push({ x, z, y });
            const b = Math.round(y * 2) / 2;
            buckets.set(b, (buckets.get(b) ?? 0) + 1);
          }
        }
        // Rooftops can out-vote the roads, so keep every well-supported level
        // and take the LOWEST one — the ground street of the diorama.
        let maxCount = 0;
        buckets.forEach((count) => {
          if (count > maxCount) maxCount = count;
        });
        let streetY = after.min.y;
        let found = false;
        buckets.forEach((count, b) => {
          if (count < Math.max(4, maxCount * 0.25)) return;
          if (!found || b < streetY) {
            streetY = b;
            found = true;
          }
        });
        // Pick the sample at street level closest to the map center.
        let spawn = { x: 0, z: 0, y: streetY };
        let bestD = Infinity;
        for (const s of samples) {
          if (Math.abs(s.y - streetY) > 0.6) continue;
          const d = s.x * s.x + s.z * s.z;
          if (d < bestD) {
            bestD = d;
            spawn = s;
          }
        }
        spawnPoint.set(spawn.x, spawn.y + 0.4, spawn.z);
        player.position.copy(spawnPoint);
        playerState.vel.set(0, 0, 0);
        console.log("[Map] bbox", after.min.toArray(), after.max.toArray());
        console.log("[Map] hist", JSON.stringify([...buckets.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10)));
        console.log("[Map] spawn", spawn, "streetY", streetY, "samples", samples.length);
      }, undefined, (err) => {
        console.error("[Map] Failed to load LittlestTokyo.glb", err);
      });
    }

    // ---- Collision / physics against the arena mesh --------------------
    // The arena is authored as a single FBX, so we treat every triangle as a
    // static collider and query it with raycasts each frame. This gives us
    // ground detection (ramps, stairs, platforms) and horizontal pushback
    // (walls, obstacles) without hand-authored primitives.
    const stageColliderRef: { mesh: THREE.Object3D | null } = { mesh: null };
    // Broadphase: cached world-space bounds per map mesh.
    const colliderMeshes: { mesh: THREE.Mesh; box: THREE.Box3 }[] = [];
    const queryBox = new THREE.Box3();
    const nearbyMeshes = (x: number, y: number, z: number, r: number) => {
      queryBox.min.set(x - r, y - r, z - r);
      queryBox.max.set(x + r, y + r, z + r);
      const out: THREE.Mesh[] = [];
      for (const c of colliderMeshes) if (c.box.intersectsBox(queryBox)) out.push(c.mesh);
      return out;
    };
    const groundRay = new THREE.Raycaster();
    const wallRay = new THREE.Raycaster();
    const CAPSULE_RADIUS = 0.35;
    const CAPSULE_HEIGHT = 1.7; // total; feet at 0, head at CAPSULE_HEIGHT
    const STEP_HEIGHT = 0.45;    // stairs/ramps we can walk up

    // Sample the floor height beneath a world-space position. Returns the
    // walkable Y or null if nothing is below (out of arena).
    const sampleGround = (x: number, z: number, fromY: number): number | null => {
      if (!stageColliderRef.mesh) return 0;
      groundRay.set(new THREE.Vector3(x, fromY, z), new THREE.Vector3(0, -1, 0));
      groundRay.far = fromY + 50;
      const targets = nearbyMeshes(x, fromY - 25, z, 26);
      const hits = groundRay.intersectObjects(targets, false);
      return hits.length > 0 ? hits[0].point.y : null;
    };

    // Push the position out of any wall it entered along 8 compass directions.
    const pushOutWalls = (pos: THREE.Vector3) => {
      if (!stageColliderRef.mesh) return;
      const origin = new THREE.Vector3(pos.x, pos.y + CAPSULE_HEIGHT * 0.5, pos.z);
      const targets = nearbyMeshes(origin.x, origin.y, origin.z, CAPSULE_RADIUS + 1.5);
      if (!targets.length) return;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
        wallRay.set(origin, dir);
        wallRay.far = CAPSULE_RADIUS + 0.05;
        const hits = wallRay.intersectObjects(targets, false);
        if (hits.length > 0) {
          const h = hits[0];
          // Ignore near-horizontal surfaces (that's the floor/ramp, not a wall).
          const n = h.face?.normal;
          if (n) {
            const worldN = n.clone().transformDirection(h.object.matrixWorld).normalize();
            if (Math.abs(worldN.y) > 0.6) continue;
          }
          const overlap = CAPSULE_RADIUS - h.distance;
          if (overlap > 0) {
            pos.x -= dir.x * overlap;
            pos.z -= dir.z * overlap;
          }
        }
      }
    };
    // Expose to closures below via captured references.
    (window as any).__arenaCollider = stageColliderRef;

    // Player container — VRM is loaded async
    const player = new THREE.Group();
    player.position.set(0, 5, 0); // drop-in; ground snap resolves the exact Y
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
    let walkAction: THREE.AnimationAction | null = null;
    let kickAction: THREE.AnimationAction | null = null;
    let kickDuration = 1.2;
    let kickTimer = 0;
    let kickCooldown = 0;
    let currentCharacterRoot: THREE.Object3D | null = null;
    let isRealVrm = false;
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    const loadCharacter = (url: string) => {
      loader.load(
        url,
        (gltf) => {
        const realVrm = gltf.userData.vrm as VRM | undefined;
        let loadedVrm = realVrm;
        // Fallback: many J_Bip_* GLBs ship without the VRM extension. Build a
        // minimal humanoid wrapper so we can still measure scale via the head
        // bone. We DO NOT retarget Mixamo animations onto this rig — the
        // rest-pose transforms don't match and produce a distorted, twisted
        // pose. Fake-VRM models render in their bind pose instead.
        if (!loadedVrm) {
          const fake = buildFakeVrmFromJBip(gltf.scene);
          if (fake) loadedVrm = fake;
        }
        const realVrmLoaded = !!realVrm;
        console.log("[Game] GLTF loaded", { hasVrm: realVrmLoaded, hasFakeVrm: !!loadedVrm && !realVrmLoaded });
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
        // Auto-scale: prefer measuring the head bone height (robust for
        // skinned meshes where Box3.setFromObject can return inflated sizes
        // from the bind pose). Fall back to bounding box otherwise.
        sceneRoot.scale.setScalar(1);
        sceneRoot.position.set(0, 0, 0);
        sceneRoot.updateMatrixWorld(true);
        const targetHeight = 2.6;
        // Only trust the head bone measurement for real VRM rigs. On fake
        // rigs it can sit far from the visual top of the mesh, producing a
        // gigantic scale. Use the bounding box in that case.
        const headBone = realVrmLoaded
          ? loadedVrm?.humanoid?.getNormalizedBoneNode("head")
          : null;
        const tmp = new THREE.Vector3();
        let measured = 0;
        if (headBone) {
          measured = headBone.getWorldPosition(tmp).y - sceneRoot.getWorldPosition(new THREE.Vector3()).y;
          measured = Math.abs(measured) * 1.10; // head bone sits ~10% below top of skull
        }
        if (!measured || measured < 0.1) {
          const box = new THREE.Box3().setFromObject(sceneRoot);
          const size = new THREE.Vector3();
          box.getSize(size);
          measured = size.y;
        }
        console.log("[Game] measured height", measured);
        if (measured > 0.01) {
          sceneRoot.scale.setScalar(targetHeight / measured);
        }
        sceneRoot.updateMatrixWorld(true);
        // Re-measure & lift so feet sit on y=0
        const box2 = new THREE.Box3().setFromObject(sceneRoot);
        sceneRoot.position.y -= box2.min.y;
        sceneRoot.rotation.y = Math.PI;
        if (placeholder.parent) player.remove(placeholder);
        if (currentCharacterRoot) {
          player.remove(currentCharacterRoot);
          currentCharacterRoot.traverse((o) => {
            const m = o as THREE.Mesh;
            if (m.geometry) m.geometry.dispose?.();
            const mat = m.material as THREE.Material | THREE.Material[] | undefined;
            if (Array.isArray(mat)) mat.forEach((x) => x.dispose?.());
            else if (mat) mat.dispose?.();
          });
        }
        player.add(sceneRoot);
        currentCharacterRoot = sceneRoot;
        vrm = loadedVrm ?? null;
        isRealVrm = realVrmLoaded;
        // Reset previous mixer/actions since bones/rig changed.
        mixer = null;
        runAction = null;
        walkAction = null;
        kickAction = null;
        animState.smoothed.clear();
        if (loadedVrm && realVrmLoaded) {
          // Single shared mixer — created up front to avoid a race where the
          // walk and run callbacks each construct one and orphan the other.
          mixer = new THREE.AnimationMixer(loadedVrm.scene);
          loadMixamoAnimation(joggingAsset.url, loadedVrm)
            .then((clip) => {
              clip.name = "vrmJog";
              runAction = mixer!.clipAction(clip);
              runAction.setLoop(THREE.LoopRepeat, Infinity);
              runAction.clampWhenFinished = false;
              runAction.enabled = true;
              runAction.setEffectiveWeight(0);
              runAction.play();
              console.log("[Game] Jogging clip ready", clip.duration);
            })
            .catch((err) => console.error("[Game] Jogging load failed", err));
          loadMixamoAnimation(walkingAsset.url, loadedVrm)
            .then((clip) => {
              clip.name = "vrmWalk";
              walkAction = mixer!.clipAction(clip);
              walkAction.setLoop(THREE.LoopRepeat, Infinity);
              walkAction.clampWhenFinished = false;
              walkAction.enabled = true;
              walkAction.setEffectiveWeight(0);
              walkAction.play();
              console.log("[Game] Walking clip ready", clip.duration);
            })
            .catch((err) => console.error("[Game] Walking load failed", err));
          loadMixamoAnimation(kickAsset.url, loadedVrm)
            .then((clip) => {
              clip.name = "vrmKick";
              kickAction = mixer!.clipAction(clip);
              kickAction.setLoop(THREE.LoopOnce, 1);
              kickAction.clampWhenFinished = true;
              kickAction.enabled = true;
              kickAction.setEffectiveWeight(0);
              kickDuration = clip.duration;
              console.log("[Game] Kick clip ready", clip.duration);
            })
            .catch((err) => console.error("[Game] Kick load failed", err));
        }
        setLoading(false);
        },
        (xhr) => {
        if (xhr.lengthComputable) {
          console.log(`[Game] character ${(xhr.loaded / xhr.total * 100).toFixed(0)}%`);
        }
        },
        (err) => {
        console.error("Character load failed", err);
        setLoading(false);
        }
      );
    };

    // Initial character = user-equipped selection (persisted by BunnyMenu),
    // falling back to the default VRM.
    const savedUrl = (() => {
      try { return localStorage.getItem("bunny.characterUrl"); } catch { return null; }
    })();
    loadCharacter(savedUrl || characterAsset.url);

    const onCharacterChange = (e: Event) => {
      const url = (e as CustomEvent<{ url?: string }>).detail?.url || characterAsset.url;
      setLoading(true);
      loadCharacter(url);
    };
    window.addEventListener("bunny:character", onCharacterChange);

    // Enemies
    const enemies: Enemy[] = [];
    const enemyMat = new THREE.MeshStandardMaterial({ color: 0xc83232 });
    function spawnEnemy(pos?: THREE.Vector3) {
      const p =
        pos ??
        new THREE.Vector3(
          rng(-arenaBounds.half + 4, arenaBounds.half - 4),
          0,
          rng(-arenaBounds.half + 4, arenaBounds.half - 4)
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
      if (e.code === "KeyK" || e.code === "KeyF") kickRef.current = true;
    };
    const onKeyUp = (e: KeyboardEvent) => {
      keys[e.code] = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    // Zoom — mouse wheel on desktop
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1);
      zoomRef.current += dy * 0.004;
    };
    renderer.domElement.addEventListener("wheel", onWheel, { passive: false });

    // Mouse look (pointer lock)
    let yaw = 0;
    let pitch = -0.2;
    let camDistCur = 5;
    let camDistTarget = 5;
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
      // Two fingers = pinch zoom (no camera rotation)
      if (activeTouches.size >= 2) {
        const prevPts = Array.from(activeTouches.values());
        for (const t of Array.from(e.changedTouches)) {
          if (activeTouches.has(t.identifier)) {
            activeTouches.set(t.identifier, { x: t.clientX, y: t.clientY });
          }
        }
        const nextPts = Array.from(activeTouches.values());
        if (prevPts.length >= 2 && nextPts.length >= 2) {
          const prevD = Math.hypot(prevPts[0].x - prevPts[1].x, prevPts[0].y - prevPts[1].y);
          const nextD = Math.hypot(nextPts[0].x - nextPts[1].x, nextPts[0].y - nextPts[1].y);
          zoomRef.current -= (nextD - prevD) * 0.02;
        }
        e.preventDefault();
        return;
      }
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

    // Roundhouse kick — plays the Mixamo clip and deals damage mid-animation.
    const tryKick = () => {
      if (kickCooldown > 0 || playerState.dead) return;
      kickTimer = kickDuration;
      kickCooldown = kickDuration + 0.15;
      if (kickAction) {
        kickAction.reset();
        kickAction.enabled = true;
        kickAction.paused = false;
        kickAction.setEffectiveWeight(1);
        kickAction.play();
      }
      const forward = new THREE.Vector3(
        Math.sin(player.rotation.y),
        0,
        Math.cos(player.rotation.y)
      );
      const kickPos = player.position.clone().add(forward.multiplyScalar(1.4));
      enemies.forEach((en) => {
        if (!en.alive) return;
        if (en.mesh.position.distanceTo(kickPos) < ATTACK_RANGE + 0.6) {
          en.hp -= ATTACK_DAMAGE * 1.5;
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
      // Legacy arena-bounds clamp (used only as a safety net while the FBX
      // collider is still loading — arena bounds get updated after load).
      const lim = arenaBounds.half - radius - 0.6;
      pos.x = Math.max(-lim, Math.min(lim, pos.x));
      pos.z = Math.max(-lim, Math.min(lim, pos.z));
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
      // Push out of arena geometry (walls, props, pillars).
      pushOutWalls(pos);
    }

    function doRespawn() {
      playerState.hp = PLAYER_MAX_HP;
      playerState.dead = false;
      player.position.copy(spawnPoint);
      playerState.vel.set(0, 0, 0);
      setHp(PLAYER_MAX_HP);
      setDead(false);
    }

    const clock = new THREE.Clock();
    let raf = 0;

    const animate = () => {
      raf = requestAnimationFrame(animate);
      const dt = Math.min(clock.getDelta(), 0.05);

      // Paused (menu open): keep rendering the scene but freeze gameplay so
      // enemies can't kill the player behind the menu.
      if (pausedRef.current) {
        moveRef.current.x = 0;
        moveRef.current.y = 0;
        jumpRef.current = false;
        attackRef.current = false;
        kickRef.current = false;
        lookDeltaRef.current.x = 0;
        lookDeltaRef.current.y = 0;
        renderer.render(scene, camera);
        return;
      }

      // Apply touch look
      if (lookDeltaRef.current.x !== 0 || lookDeltaRef.current.y !== 0) {
        const sens =
          ((window as unknown as { __bunnySettings?: { sensitivity: number } })
            .__bunnySettings?.sensitivity ?? 50) / 50;
        // Drag right -> camera pans right; drag up -> look up.
        yaw -= lookDeltaRef.current.x * 0.009 * sens;
        pitch -= lookDeltaRef.current.y * 0.008 * sens;
        pitch = Math.max(-1.2, Math.min(0.9, pitch));
        lookDeltaRef.current.x = 0;
        lookDeltaRef.current.y = 0;
      }

      // Camera-relative input
      const forward = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
      // Screen-right in this camera setup is yaw - 90deg (was inverted).
      const right = new THREE.Vector3(Math.sin(yaw - Math.PI / 2), 0, Math.cos(yaw - Math.PI / 2));
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
      if (kickRef.current) {
        kickRef.current = false;
        tryKick();
      }
      if (kickTimer > 0) kickTimer -= dt;
      if (kickCooldown > 0) kickCooldown -= dt;
      // Gravity
      playerState.vel.y -= 22 * dt;

      // Integrate XZ then resolve walls, then integrate Y with ground snap.
      const prevY = player.position.y;
      player.position.x += playerState.vel.x * dt;
      player.position.z += playerState.vel.z * dt;
      resolveCollision(player.position, CAPSULE_RADIUS);

      player.position.y += playerState.vel.y * dt;

      // Ground detection via downward raycast against the arena mesh.
      const groundY = sampleGround(
        player.position.x,
        player.position.z,
        player.position.y + CAPSULE_HEIGHT + 0.5,
      );
      if (groundY !== null) {
        // Snap to floor if we're at/under it, or step up for small ledges.
        const stepUpMax = prevY + STEP_HEIGHT;
        if (playerState.vel.y <= 0 && player.position.y <= groundY + 0.02) {
          player.position.y = groundY;
          playerState.vel.y = 0;
          playerState.onGround = true;
        } else if (
          playerState.vel.y <= 0 &&
          groundY > prevY &&
          groundY <= stepUpMax
        ) {
          // Auto-step onto stairs/ramps.
          player.position.y = groundY;
          playerState.vel.y = 0;
          playerState.onGround = true;
        } else {
          playerState.onGround = false;
        }
      } else {
        // Off the map — fall to base plane and reset.
        if (player.position.y < -20) {
          player.position.set(0, 5, 0);
          playerState.vel.set(0, 0, 0);
        }
        playerState.onGround = false;
      }

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
            const r = rng(6, Math.max(8, arenaBounds.half - 4));
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
          const lim = arenaBounds.half - 2;
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

      // Camera follow (third person) with wall occlusion raycast so the
      // camera never clips through arena geometry.
      // Zoom (wheel / pinch), clamped
      if (zoomRef.current !== 0) {
        camDistTarget = Math.max(1.0, Math.min(16, camDistTarget + zoomRef.current));
        zoomRef.current = 0;
      }
      camDistCur += (camDistTarget - camDistCur) * Math.min(1, dt * 10);
      const camDist = camDistCur;
      const camHeight = 2.2;
      const camOffset = new THREE.Vector3(
        -Math.sin(yaw) * camDist,
        camHeight - pitch * camDist,
        -Math.cos(yaw) * camDist,
      );
      const camAnchor = player.position.clone().add(new THREE.Vector3(0, 1.4, 0));
      let targetCamPos = camAnchor.clone().add(camOffset);
      if (stageColliderRef.mesh) {
        const dir = targetCamPos.clone().sub(camAnchor);
        const len = dir.length();
        dir.normalize();
        wallRay.set(camAnchor, dir);
        wallRay.far = len;
        const hits = wallRay.intersectObjects(
          nearbyMeshes(camAnchor.x, camAnchor.y, camAnchor.z, len + 1),
          false,
        );
        if (hits.length > 0) {
          const safe = Math.max(0.6, hits[0].distance - 0.2);
          targetCamPos = camAnchor.clone().add(dir.multiplyScalar(safe));
        }
      }
      camera.position.lerp(targetCamPos, Math.min(1, dt * 12));
      camera.lookAt(camAnchor);

      // VRM update
      if (vrm) {
        // Decide how strongly the FBX run animation drives the rig.
        const speedNow = Math.hypot(playerState.vel.x, playerState.vel.z);
        // Binary targets crossfaded fast — prevents partial blends with the
        // procedural fallback that caused stuttering ("travando").
        const moving = speedNow > 0.4;
        const sprinting = speedNow > 6.5;
        const kicking = kickTimer > 0;
        const runTarget = kicking ? 0 : sprinting ? 1 : 0;
        const walkTarget = kicking ? 0 : moving && !sprinting ? 1 : 0;
        const blendK = Math.min(1, dt * 12);
        if (runAction) {
          runAction.enabled = true;
          runAction.paused = false;
          runAction.timeScale = 1;
          runAction.weight = lerp(runAction.weight, runTarget, blendK);
        }
        if (walkAction) {
          walkAction.enabled = true;
          walkAction.paused = false;
          walkAction.timeScale = 1;
          walkAction.weight = lerp(walkAction.weight, walkTarget, blendK);
        }
        // Hand the body bones to the clip as soon as the player moves so the
        // procedural fallback doesn't fight the blend-in and cause stutter.
        // Only run the procedural pose + Mixamo mixer on real VRM rigs.
        // Non-VRM GLBs use a synthesized humanoid whose rest pose doesn't
        // match Mixamo's, so retargeting distorts the model. Render them in
        // their bind pose instead.
        if (isRealVrm) {
          const runActive = moving || (runAction?.weight ?? 0) > 0.05 || (walkAction?.weight ?? 0) > 0.05;
          if (kickAction) {
            kickAction.weight = lerp(kickAction.weight, kicking ? 1 : 0, Math.min(1, dt * 14));
            if (!kicking && kickAction.weight < 0.02) kickAction.stop();
          }
          if (!kicking) updateCharacterAnimation(vrm, dt, {
            speed: speedNow,
            maxSpeed: 9,
            attackTimer,
            dead: playerState.dead,
            runActive,
          });
          if (mixer) mixer.update(dt);
        }
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
      window.removeEventListener("bunny:character", onCharacterChange);
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

  // Freeze gameplay whenever the menu is open.
  useEffect(() => {
    pausedRef.current = menuOpen;
  }, [menuOpen]);

  // Esc opens the menu (pauses the game).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
      <div className="pointer-events-none absolute left-2 top-2 z-10 w-44 space-y-1.5 sm:left-4 sm:top-4 sm:w-64 sm:space-y-2">
        <div className="rounded-md bg-black/50 p-1.5 backdrop-blur sm:p-2">
          <div className="mb-1 flex items-center justify-between text-[10px] font-semibold text-white sm:text-xs">
            <span>HP</span>
            <span>{Math.max(0, Math.round(hp))}/{PLAYER_MAX_HP}</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded bg-white/20 sm:h-3">
            <div
              className="h-full bg-red-500 transition-all"
              style={{ width: `${hpPct}%` }}
            />
          </div>
        </div>
        <div className="rounded-md bg-black/50 px-2 py-1 text-xs font-semibold text-white backdrop-blur sm:px-3 sm:py-2 sm:text-sm">
          Kills: {score}
        </div>
      </div>

      <div className={`pointer-events-none absolute right-4 top-4 z-10 hidden max-w-xs rounded-md bg-black/50 p-3 text-xs text-white backdrop-blur ${isMobileDevice ? "" : "md:block"}`}>
        <div className="mb-1 font-bold">Controls</div>
        <div>Click to lock mouse</div>
        <div>WASD — Move</div>
        <div>Shift — Run</div>
        <div>Space — Jump</div>
        <div>Left Click — Attack</div>
        <div>K / F — Chute (Roundhouse)</div>
        <div>Scroll — Zoom</div>
        <div>Mouse — Camera</div>
        <div>Esc — Release mouse</div>
      </div>

      {/* Mobile controls */}
      <MobileControls
        moveRef={moveRef}
        runRef={runRef}
        jumpRef={jumpRef}
        attackRef={attackRef}
        kickRef={kickRef}
        zoomRef={zoomRef}
        visible={isMobileDevice && !menuOpen && !loading}
      />

      {dead && !menuOpen && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-red-900/40">
          <div className="rounded-lg bg-black/70 px-8 py-6 text-center text-white">
            <div className="text-3xl font-bold">You died</div>
            <div className="mt-2 text-sm opacity-80">Respawning…</div>
          </div>
        </div>
      )}

      {/* Crosshair */}
      {!menuOpen && (
        <div className="pointer-events-none absolute left-1/2 top-1/2 z-10 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/80" />
      )}

      {/* Pause / open menu */}
      {!menuOpen && (
        <button
          onClick={() => setMenuOpen(true)}
          aria-label="Abrir menu"
          className="absolute right-4 top-4 z-20 flex h-11 w-11 items-center justify-center rounded-full border border-white/30 bg-black/60 text-white shadow-lg backdrop-blur hover:bg-black/80"
        >
          <span className="flex flex-col gap-1">
            <span className="block h-0.5 w-5 bg-white" />
            <span className="block h-0.5 w-5 bg-white" />
            <span className="block h-0.5 w-5 bg-white" />
          </span>
        </button>
      )}

      <BunnyMenu
        open={menuOpen}
        currentKills={score}
        onPlay={() => {
          if (isMobileDevice) requestLandscape();
          setMenuOpen(false);
        }}
      />

      {/* Force landscape on mobile — rotate device overlay.
          Only shows when actually in portrait; user can bypass if lock
          isn't supported on their browser. */}
      {isMobileDevice && isPortrait && !orientationDismissed && (
        <div className="absolute inset-0 z-[100] flex flex-col items-center justify-center gap-4 bg-black text-white">
          <div className="animate-pulse text-6xl">📱↻</div>
          <div className="text-lg font-bold tracking-wider">Gire seu dispositivo</div>
          <div className="text-sm opacity-80">Este jogo funciona apenas no modo paisagem</div>
          <button
            onClick={requestLandscape}
            className="mt-4 rounded-full border border-white/30 bg-white/10 px-6 py-2 text-sm font-semibold backdrop-blur active:scale-95"
          >
            Ativar modo paisagem
          </button>
          <button
            onClick={() => setOrientationDismissed(true)}
            className="rounded-full px-4 py-1 text-xs opacity-70 underline"
          >
            Continuar mesmo assim
          </button>
        </div>
      )}
    </div>
  );
}

function MobileControls({
  moveRef,
  runRef,
  jumpRef,
  attackRef,
  kickRef,
  zoomRef,
  visible,
}: {
  moveRef: React.MutableRefObject<{ x: number; y: number }>;
  runRef: React.MutableRefObject<boolean>;
  jumpRef: React.MutableRefObject<boolean>;
  attackRef: React.MutableRefObject<boolean>;
  kickRef: React.MutableRefObject<boolean>;
  zoomRef: React.MutableRefObject<number>;
  visible?: boolean;
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
    <div className={`pointer-events-none absolute inset-0 z-20 ${visible ? "" : "hidden"}`} style={{ paddingLeft: "env(safe-area-inset-left)", paddingRight: "env(safe-area-inset-right)" }}>
      {/* Joystick */}
      <div
        ref={padRef}
        onTouchStart={onPadTouchStart}
        onTouchMove={onPadTouchMove}
        onTouchEnd={onPadTouchEnd}
        onTouchCancel={onPadTouchEnd}
        className="pointer-events-auto absolute bottom-4 left-4 h-32 w-32 touch-none rounded-full border-2 border-white/40 bg-white/10 backdrop-blur sm:bottom-6 sm:left-6 sm:h-36 sm:w-36"
      >
        <div
          className="absolute h-14 w-14 rounded-full bg-white/70 shadow sm:h-16 sm:w-16"
          style={{
            left: "50%",
            top: "50%",
            transform: `translate(calc(-50% + ${stick.x}px), calc(-50% + ${stick.y}px))`,
            transition: stick.active ? "none" : "transform 0.15s",
          }}
        />
      </div>

      {/* Action buttons */}
      <div className="pointer-events-auto absolute bottom-4 right-4 flex flex-col items-end gap-2 sm:bottom-8 sm:right-6 sm:gap-3">
        <div className="flex gap-2 sm:gap-3">
          <button
            className={`${btnBase} h-11 w-11 bg-white/25 text-lg sm:h-12 sm:w-12`}
            onTouchStart={(e) => {
              e.preventDefault();
              zoomRef.current -= 0.8;
            }}
            aria-label="Zoom in"
          >
            +
          </button>
          <button
            className={`${btnBase} h-11 w-11 bg-white/25 text-lg sm:h-12 sm:w-12`}
            onTouchStart={(e) => {
              e.preventDefault();
              zoomRef.current += 0.8;
            }}
            aria-label="Zoom out"
          >
            −
          </button>
          <button
            className={`${btnBase} h-14 w-14 bg-fuchsia-500/85 text-xs sm:h-16 sm:w-16 sm:text-sm`}
            onTouchStart={(e) => {
              e.preventDefault();
              kickRef.current = true;
            }}
          >
            KICK
          </button>
        </div>
        <button
          className={`${btnBase} h-16 w-16 bg-red-500/80 text-base sm:h-20 sm:w-20 sm:text-lg`}
          onTouchStart={(e) => {
            e.preventDefault();
            attackRef.current = true;
          }}
        >
          ATK
        </button>
        <div className="flex gap-2 sm:gap-3">
          <button
            className={`${btnBase} h-14 w-14 text-xs sm:h-16 sm:w-16 sm:text-sm ${
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
            className={`${btnBase} h-14 w-14 bg-blue-500/80 text-xs sm:h-16 sm:w-16 sm:text-sm`}
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
      <div className="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 rounded bg-black/40 px-2 py-1 text-[9px] leading-tight text-white/80 backdrop-blur">
        Arraste a tela para girar a câmera
      </div>
    </div>
  );
}