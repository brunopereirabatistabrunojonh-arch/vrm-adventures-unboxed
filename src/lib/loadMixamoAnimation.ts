import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import type { VRM } from "@pixiv/three-vrm";

// Mixamo → VRM humanoid bone map
const mixamoVRMRigMap: Record<string, string> = {
  mixamorigHips: "hips",
  mixamorigSpine: "spine",
  mixamorigSpine1: "chest",
  mixamorigSpine2: "upperChest",
  mixamorigNeck: "neck",
  mixamorigHead: "head",
  mixamorigLeftShoulder: "leftShoulder",
  mixamorigLeftArm: "leftUpperArm",
  mixamorigLeftForeArm: "leftLowerArm",
  mixamorigLeftHand: "leftHand",
  mixamorigLeftHandThumb1: "leftThumbMetacarpal",
  mixamorigLeftHandThumb2: "leftThumbProximal",
  mixamorigLeftHandThumb3: "leftThumbDistal",
  mixamorigLeftHandIndex1: "leftIndexProximal",
  mixamorigLeftHandIndex2: "leftIndexIntermediate",
  mixamorigLeftHandIndex3: "leftIndexDistal",
  mixamorigLeftHandMiddle1: "leftMiddleProximal",
  mixamorigLeftHandMiddle2: "leftMiddleIntermediate",
  mixamorigLeftHandMiddle3: "leftMiddleDistal",
  mixamorigLeftHandRing1: "leftRingProximal",
  mixamorigLeftHandRing2: "leftRingIntermediate",
  mixamorigLeftHandRing3: "leftRingDistal",
  mixamorigLeftHandPinky1: "leftLittleProximal",
  mixamorigLeftHandPinky2: "leftLittleIntermediate",
  mixamorigLeftHandPinky3: "leftLittleDistal",
  mixamorigRightShoulder: "rightShoulder",
  mixamorigRightArm: "rightUpperArm",
  mixamorigRightForeArm: "rightLowerArm",
  mixamorigRightHand: "rightHand",
  mixamorigRightHandPinky1: "rightLittleProximal",
  mixamorigRightHandPinky2: "rightLittleIntermediate",
  mixamorigRightHandPinky3: "rightLittleDistal",
  mixamorigRightHandRing1: "rightRingProximal",
  mixamorigRightHandRing2: "rightRingIntermediate",
  mixamorigRightHandRing3: "rightRingDistal",
  mixamorigRightHandMiddle1: "rightMiddleProximal",
  mixamorigRightHandMiddle2: "rightMiddleIntermediate",
  mixamorigRightHandMiddle3: "rightMiddleDistal",
  mixamorigRightHandIndex1: "rightIndexProximal",
  mixamorigRightHandIndex2: "rightIndexIntermediate",
  mixamorigRightHandIndex3: "rightIndexDistal",
  mixamorigRightHandThumb1: "rightThumbMetacarpal",
  mixamorigRightHandThumb2: "rightThumbProximal",
  mixamorigRightHandThumb3: "rightThumbDistal",
  mixamorigLeftUpLeg: "leftUpperLeg",
  mixamorigLeftLeg: "leftLowerLeg",
  mixamorigLeftFoot: "leftFoot",
  mixamorigLeftToeBase: "leftToes",
  mixamorigRightUpLeg: "rightUpperLeg",
  mixamorigRightLeg: "rightLowerLeg",
  mixamorigRightFoot: "rightFoot",
  mixamorigRightToeBase: "rightToes",
};

/**
 * Load a Mixamo .fbx animation and retarget its tracks to a VRM humanoid.
 * Based on the official @pixiv/three-vrm example.
 * Returns an AnimationClip whose track names target the VRM's normalized
 * bone node names, ready to play on an AnimationMixer rooted at vrm.scene.
 * Horizontal hips translation is stripped so the game keeps controlling
 * world movement; vertical bounce is preserved.
 */
export async function loadMixamoAnimation(url: string, vrm: VRM): Promise<THREE.AnimationClip> {
  const loader = new FBXLoader();
  const asset = await loader.loadAsync(url);
  const clip =
    THREE.AnimationClip.findByName(asset.animations, "mixamo.com") ??
    asset.animations[0];
  if (!clip) throw new Error("No animation in FBX");

  const tracks: THREE.KeyframeTrack[] = [];
  const restRotationInverse = new THREE.Quaternion();
  const parentRestWorldRotation = new THREE.Quaternion();
  const _quatA = new THREE.Quaternion();
  const _vec3 = new THREE.Vector3();

  const hipsBone = asset.getObjectByName("mixamorigHips");
  const motionHipsHeight = hipsBone ? hipsBone.position.y : 100;
  const vrmHipsNode = vrm.humanoid?.getNormalizedBoneNode("hips");
  const vrmHipsY = vrmHipsNode ? vrmHipsNode.getWorldPosition(_vec3).y : 1;
  const vrmRootY = vrm.scene.getWorldPosition(_vec3).y;
  const vrmHipsHeight = Math.abs(vrmHipsY - vrmRootY);
  const hipsPositionScale = motionHipsHeight > 0 ? vrmHipsHeight / motionHipsHeight : 0.01;

  const isVRM0 = (vrm.meta as { metaVersion?: string } | undefined)?.metaVersion === "0";

  clip.tracks.forEach((track) => {
    const [mixamoRigName, propertyName] = track.name.split(".");
    const vrmBoneName = mixamoVRMRigMap[mixamoRigName];
    const vrmNode = vrmBoneName
      ? vrm.humanoid?.getNormalizedBoneNode(vrmBoneName as Parameters<NonNullable<VRM["humanoid"]>["getNormalizedBoneNode"]>[0])
      : null;
    if (!vrmNode) return;
    const mixamoRigNode = asset.getObjectByName(mixamoRigName);
    if (!mixamoRigNode || !mixamoRigNode.parent) return;

    mixamoRigNode.getWorldQuaternion(restRotationInverse).invert();
    mixamoRigNode.parent.getWorldQuaternion(parentRestWorldRotation);

    if (track instanceof THREE.QuaternionKeyframeTrack) {
      const values = track.values.slice();
      for (let i = 0; i < values.length; i += 4) {
        _quatA.fromArray(values, i);
        _quatA.premultiply(parentRestWorldRotation).multiply(restRotationInverse);
        _quatA.toArray(values, i);
        if (isVRM0) {
          values[i] = -values[i];
          values[i + 2] = -values[i + 2];
        }
      }
      tracks.push(new THREE.QuaternionKeyframeTrack(`${vrmNode.name}.${propertyName}`, track.times.slice(), values));
    }
    // Hips translation tracks are intentionally dropped:
    //  - horizontal: the game owns world movement
    //  - vertical: the rest-pose hip height already plants the feet at y=0;
    //    re-adding the FBX bounce makes feet clip through the floor.
  });

  return new THREE.AnimationClip("vrmRun", clip.duration, tracks);
}