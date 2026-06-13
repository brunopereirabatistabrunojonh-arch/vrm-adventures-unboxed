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

export default function Game() {
  const mountRef = useRef<HTMLDivElement>(null);
  const [hp, setHp] = useState(PLAYER_MAX_HP);
  const [loading, setLoading] = useState(true);
  const [score, setScore] = useState(0);
  const [dead, setDead] = useState(false);

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
      if (document.pointerLockElement !== renderer.domElement) {
        renderer.domElement.requestPointerLock();
      }
    };
    renderer.domElement.addEventListener("click", onClick);
    window.addEventListener("mousemove", onMouseMove);

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

      // Camera-relative input
      const forward = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
      const right = new THREE.Vector3(Math.sin(yaw + Math.PI / 2), 0, Math.cos(yaw + Math.PI / 2));
      const move = new THREE.Vector3();
      if (!playerState.dead) {
        if (keys["KeyW"] || keys["ArrowUp"]) move.add(forward);
        if (keys["KeyS"] || keys["ArrowDown"]) move.sub(forward);
        if (keys["KeyA"] || keys["ArrowLeft"]) move.sub(right);
        if (keys["KeyD"] || keys["ArrowRight"]) move.add(right);
      }
      const running = keys["ShiftLeft"] || keys["ShiftRight"];
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
      if ((keys["Space"]) && playerState.onGround && !playerState.dead) {
        playerState.vel.y = 8;
        playerState.onGround = false;
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
          }
          return;
        }
        // Restore color
        if (en.hitCooldown > 0) {
          en.hitCooldown -= dt;
          if (en.hitCooldown <= 0)
            (en.mesh.material as THREE.MeshStandardMaterial).color.set(0xc83232);
        }
        // Chase
        const to = new THREE.Vector3().subVectors(player.position, en.mesh.position);
        to.y = 0;
        const dist = to.length();
        if (dist > 0.001 && !playerState.dead) {
          to.normalize();
          const espeed = 3.2;
          en.mesh.position.x += to.x * espeed * dt;
          en.mesh.position.z += to.z * espeed * dt;
          en.mesh.lookAt(player.position.x, en.mesh.position.y, player.position.z);
        }
        // Attack player
        if (dist < 1.6 && playerState.damageCooldown <= 0 && !playerState.dead) {
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
        // Simple attack pose using arm bones
        const rArm = vrm.humanoid?.getNormalizedBoneNode("rightUpperArm");
        const lArm = vrm.humanoid?.getNormalizedBoneNode("leftUpperArm");
        if (rArm && lArm) {
          const armRest = 1.2;
          const attackPose = attackTimer > 0 ? -1.4 : 0;
          rArm.rotation.z = -armRest;
          lArm.rotation.z = armRest;
          rArm.rotation.x = attackPose;
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
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("resize", onResize);
      renderer.domElement.removeEventListener("click", onClick);
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

      <div className="pointer-events-none absolute right-4 top-4 z-10 max-w-xs rounded-md bg-black/50 p-3 text-xs text-white backdrop-blur">
        <div className="mb-1 font-bold">Controls</div>
        <div>Click to lock mouse</div>
        <div>WASD — Move</div>
        <div>Shift — Run</div>
        <div>Space — Jump</div>
        <div>Left Click — Attack</div>
        <div>Mouse — Camera</div>
        <div>Esc — Release mouse</div>
      </div>

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