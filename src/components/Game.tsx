import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import characterAsset from "@/assets/character.vrm.asset.json";

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

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
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
  opts: { speed: number; maxSpeed: number; attackTimer: number; dead: boolean }
) {
  const { speed, attackTimer, dead } = opts;

  // Locomotion blending
  const walkThreshold = 0.4;
  const runThreshold = 6.5;
  const isMoving = speed > walkThreshold;
  const targetWalk = isMoving ? 1 : 0;
  const targetRun = speed > runThreshold ? Math.min(1, (speed - runThreshold) / 2.5) : 0;
  animState.walkBlend = lerp(animState.walkBlend, targetWalk, Math.min(1, dt * 6));
  animState.runBlend = lerp(animState.runBlend, targetRun, Math.min(1, dt * 6));

  // Stride-matched cadence so feet don't slide.
  // legLen ~0.85, stride per step ≈ 2*legLen*sin(stepAmp) → cadence (steps/s) = speed/stride.
  // One half-cycle of sin = one step, so angular freq = cadence * π.
  const stepAmpTarget = 0.55 + animState.runBlend * 0.45; // bigger stride when running
  const legLen = 0.85;
  const stridePerStep = Math.max(0.35, 2 * legLen * Math.sin(stepAmpTarget));
  const cadence = isMoving ? speed / stridePerStep : 0;     // steps per second
  const stepFreq = cadence * Math.PI;                       // rad/s for sin(t)
  // Always advance time a bit so idle breath/sway keep flowing
  animState.t += dt * (stepFreq > 0 ? stepFreq : 1.2);
  const t = animState.t;

  const walk = animState.walkBlend;
  const run = animState.runBlend;
  const idle = Math.max(0, 1 - walk);

  // --- Breathing & idle sway ---
  const breath = Math.sin(t * 0.9) * 0.04 * idle;       // chest up/down
  const idleSway = Math.sin(t * 0.6) * 0.03 * idle;     // hip sway
  const idleArm = Math.sin(t * 0.8) * 0.05 * idle;      // arm subtle motion
  const headBob = Math.sin(t * 0.7) * 0.03 * idle;

  // --- Walk/Run cycle ---
  // Legs drive the cycle; arms lag slightly behind (more human).
  const legPhase = t;
  const armLag = 0.18;                       // ~10°, natural delay
  const armPhase = t - armLag;

  const legCycle = Math.sin(legPhase);
  const armCycle = Math.sin(armPhase);
  const cosCycle = Math.cos(legPhase);

  const stepAmp = stepAmpTarget;
  const armSwing = (0.55 + run * 0.7) * walk;     // arms move only when walking
  const torsoLean = -(0.10 + run * 0.16) * walk;  // forward lean
  // Vertical bob: 2 peaks per stride cycle (one per foot contact)
  const vertical = (Math.abs(cosCycle) - 0.5) * 0.05 * walk;
  // Lateral hip sway: weight shifts to support leg (1 cycle per stride pair = freq/2)
  const hipSwayLateral = Math.sin(legPhase * 0.5) * 0.12 * walk;

  // Hips
  setBone(vrm, "hips",
    torsoLean + breath * 0.3,
    // counter-rotate hips opposite to shoulders (~hip twist)
    idleSway * 0.5 + legCycle * 0.18 * walk,
    // lateral sway tilts the pelvis
    Math.sin(t * 0.5) * 0.02 * idle + hipSwayLateral
  );

  // Spine / chest — breathing + shoulder counter-rotation
  setBone(vrm, "spine",
    0.04 + breath + 0.02 * walk,
    -legCycle * 0.10 * walk,
    idleSway * 0.4
  );
  setBone(vrm, "chest",
    0.02 + breath * 1.2,
    -legCycle * 0.18 * walk,   // shoulders rotate opposite to hips
    -hipSwayLateral * 0.4      // small counter-tilt
  );
  setBone(vrm, "upperChest",
    breath * 0.8,
    -legCycle * 0.10 * walk,
    0
  );

  // Neck / head — slight bob
  setBone(vrm, "neck",
    -breath * 0.5 + headBob,
    legCycle * 0.06 * walk,
    -hipSwayLateral * 0.2
  );
  setBone(vrm, "head",
    headBob * 0.6,
    Math.sin(t * 0.3) * 0.04 * idle,
    hipSwayLateral * 0.2
  );

  // --- Arms ---
  // Rest pose: arms down along body
  const armRest = 1.25;
  const attackPose = attackTimer > 0 ? -1.5 : 0;
  // Constant slight elbow bend; add gentle extra bend on forward swing only.
  // Arms swing OPPOSITE to legs of the same side, i.e. armCycle for right arm is
  // negative legCycle (right arm forward when right leg back).
  const rArmSwing = -armCycle * armSwing;
  const lArmSwing = armCycle * armSwing;

  // Right arm
  setBone(vrm, "rightUpperArm",
    rArmSwing + attackPose,
    rArmSwing * 0.15,                          // slight inward/outward twist
    -armRest + idleArm * 0.4
  );
  setBone(vrm, "rightLowerArm",
    // base soft bend + smooth extra bend on forward swing (no Math.max kink)
    -0.35 - (0.18 + 0.18 * run) * Math.max(0, rArmSwing) - (attackTimer > 0 ? 0.6 : 0),
    0,
    -0.12
  );
  setBone(vrm, "rightHand",
    0,
    0,
    -0.1 - rArmSwing * 0.1
  );

  // Left arm (opposite phase to right)
  setBone(vrm, "leftUpperArm",
    lArmSwing,
    lArmSwing * 0.15,
    armRest - idleArm * 0.4
  );
  setBone(vrm, "leftLowerArm",
    -0.35 - (0.18 + 0.18 * run) * Math.max(0, lArmSwing),
    0,
    0.12
  );
  setBone(vrm, "leftHand",
    0,
    0,
    0.1 + lArmSwing * 0.1
  );

  // --- Legs ---
  // Right leg: forward when legCycle > 0
  const rLegSwing = legCycle * stepAmp * walk;
  const lLegSwing = -legCycle * stepAmp * walk;

  // Knee bend peaks just after foot lifts (in swing phase). Smooth via sin².
  const rSwingPhase = Math.max(0, legCycle);          // 0..1
  const lSwingPhase = Math.max(0, -legCycle);
  const kneeBase = 0.05;                              // soft natural bend

  setBone(vrm, "rightUpperLeg",
    rLegSwing,
    0,
    -hipSwayLateral * 0.3                            // pelvis tilt compensation
  );
  setBone(vrm, "rightLowerLeg",
    kneeBase + rSwingPhase * rSwingPhase * (1.0 + 0.4 * run) * walk,
    0,
    0
  );
  setBone(vrm, "rightFoot",
    -rLegSwing * 0.35 + rSwingPhase * 0.25 * walk,   // toe lifts during swing
    0,
    0
  );

  setBone(vrm, "leftUpperLeg",
    lLegSwing,
    0,
    -hipSwayLateral * 0.3
  );
  setBone(vrm, "leftLowerLeg",
    kneeBase + lSwingPhase * lSwingPhase * (1.0 + 0.4 * run) * walk,
    0,
    0
  );
  setBone(vrm, "leftFoot",
    -lLegSwing * 0.35 + lSwingPhase * 0.25 * walk,
    0,
    0
  );

  // Vertical bob on root (gentle)
  if (vrm.scene) {
    const base = vrm.scene.userData._baseY ?? vrm.scene.position.y;
    vrm.scene.userData._baseY = base;
    vrm.scene.position.y = base + vertical;
  }

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
    mount.appendChild(renderer.domElement);

    // Lights
    const hemi = new THREE.HemisphereLight(0xffffff, 0x444466, 0.9);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 1.1);
    sun.position.set(40, 60, 20);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -80;
    sun.shadow.camera.right = 80;
    sun.shadow.camera.top = 80;
    sun.shadow.camera.bottom = -80;
    scene.add(sun);

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
        updateCharacterAnimation(vrm, dt, {
          speed: Math.hypot(playerState.vel.x, playerState.vel.z),
          maxSpeed: 9,
          attackTimer,
          dead: playerState.dead,
        });
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