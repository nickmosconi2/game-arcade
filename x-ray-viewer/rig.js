// Poses the anatomical arm from the 21 tracked hand points.
// Palm: best-fit rotation + scale to the wrist and knuckles. Fingers: each bone turned so it runs
// from the user's joint to the next one. Forearm: follows the palm, swung to the arm in the picture.
import * as THREE from './vendor/three.module.min.js';

// [segment index, from joint, to joint, parent segment]
export const FINGER_SEGS = [
  [2, 1, 2, 1], [3, 2, 3, 2], [4, 3, 4, 3],
  [5, 5, 6, 1], [6, 6, 7, 5], [7, 7, 8, 6],
  [8, 9, 10, 1], [9, 10, 11, 8], [10, 11, 12, 9],
  [11, 13, 14, 1], [12, 14, 15, 11], [13, 15, 16, 12],
  [14, 17, 18, 1], [15, 18, 19, 14], [16, 19, 20, 15],
];
const PALM = [0, 5, 9, 13, 17];   // wrist and knuckles: the rigid part of the hand

/** Rotation (Matrix4) that best maps centred src onto centred dst (Horn's quaternion method). */
function bestRotation(src, dst) {
  let Sxx = 0, Sxy = 0, Sxz = 0, Syx = 0, Syy = 0, Syz = 0, Szx = 0, Szy = 0, Szz = 0;
  for (let i = 0; i < src.length; i++) {
    const a = src[i], b = dst[i];
    Sxx += a.x * b.x; Sxy += a.x * b.y; Sxz += a.x * b.z;
    Syx += a.y * b.x; Syy += a.y * b.y; Syz += a.y * b.z;
    Szx += a.z * b.x; Szy += a.z * b.y; Szz += a.z * b.z;
  }
  const N = [
    [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
    [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
    [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
    [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz],
  ];
  // Largest eigenvector by shifted power iteration.
  let shift = 0; for (let i = 0; i < 4; i++) shift += Math.abs(N[i][0]) + Math.abs(N[i][1]) + Math.abs(N[i][2]) + Math.abs(N[i][3]);
  let q = [1, 0, 0, 0];
  for (let it = 0; it < 60; it++) {
    const r = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) r[i] += (N[i][j] + (i === j ? shift : 0)) * q[j];
    const l = Math.hypot(...r) || 1; q = r.map((v) => v / l);
  }
  return new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion(q[1], q[2], q[3], q[0]));
}
/** Orthonormal frame (as a rotation matrix) with X along `dir` and Z as close as possible to `ref`. */
function frame(dir, ref) {
  const x = dir.clone().normalize();
  const z = ref.clone().addScaledVector(x, -ref.dot(x));
  if (z.lengthSq() < 1e-8) z.set(0, 0, 1).addScaledVector(x, -x.z);
  z.normalize();
  const y = new THREE.Vector3().crossVectors(z, x);
  return new THREE.Matrix4().makeBasis(x, y, z);
}

/**
 * Screen-space 3D points of the 21 hand landmarks (px, centre origin, y up, z toward the viewer).
 * x and y come from the picture; depth comes from MediaPipe's metric world landmarks.
 */
export function handPoints(hand, toScreen) {
  const img = hand.image.map((p) => toScreen(p.x, p.y));
  let num = 0, den = 0;
  for (const [a, b] of [[0, 5], [0, 17], [5, 17], [0, 9], [5, 9], [9, 13], [13, 17]]) {
    num += Math.hypot(img[a][0] - img[b][0], img[a][1] - img[b][1]);
    den += Math.hypot(hand.world[a].x - hand.world[b].x, hand.world[a].y - hand.world[b].y);
  }
  const k = den > 1e-6 ? num / den : 1000;   // px per metre
  return { k, P: img.map((p, i) => new THREE.Vector3(p[0], p[1], -(hand.world[i].z - hand.world[0].z) * k)) };
}

/**
 * Solve every segment matrix (arm mm -> screen px). Returns {seg: Matrix4[17], palmScale}.
 * arm: from loadArm. P: smoothed screen points. forearmDir: THREE.Vector2 (screen, y up) or null.
 */
export function solveArm(arm, P, forearmDir, prevDelta = 0) {
  const R = arm.joints;
  const src = PALM.map((i) => R[i]), dst = PALM.map((i) => P[i]);
  const cs = new THREE.Vector3(), cd = new THREE.Vector3();
  src.forEach((v) => cs.add(v)); cs.divideScalar(src.length);
  dst.forEach((v) => cd.add(v)); cd.divideScalar(dst.length);
  const s0 = src.map((v) => v.clone().sub(cs)), d0 = dst.map((v) => v.clone().sub(cd));
  // Scale from the hand's outline in the picture (x, y), which is more reliable than estimated depth.
  let ns = 0, nd = 0;
  for (let i = 0; i < s0.length; i++) { ns += s0[i].lengthSq(); nd += d0[i].x * d0[i].x + d0[i].y * d0[i].y; }
  const rot = bestRotation(s0, d0);
  // Projected size of the model palm under this rotation vs the user's palm on screen.
  let np = 0; for (const v of s0) { const w = v.clone().applyMatrix4(rot); np += w.x * w.x + w.y * w.y; }
  const scale = Math.sqrt(nd / Math.max(np, 1e-6));
  const palm = new THREE.Matrix4().makeTranslation(cd.x, cd.y, cd.z)
    .multiply(rot).multiply(new THREE.Matrix4().makeScale(scale, scale, scale))
    .multiply(new THREE.Matrix4().makeTranslation(-cs.x, -cs.y, -cs.z));
  const seg = Array.from({ length: 17 }, () => new THREE.Matrix4());
  seg[1].copy(palm);

  // Forearm: swing about the wrist so the model's forearm runs along the arm seen in the picture.
  const w0 = R[0].clone().applyMatrix4(palm), e = arm.elbow.clone().applyMatrix4(palm).sub(w0);
  let delta = prevDelta;
  if (forearmDir && Math.hypot(e.x, e.y) > 1e-3) {
    delta = Math.atan2(e.x * forearmDir.y - e.y * forearmDir.x, e.x * forearmDir.x + e.y * forearmDir.y);
    delta = Math.max(-1.0, Math.min(1.0, delta));
  } else delta *= 0.9;
  seg[0].makeTranslation(w0.x, w0.y, w0.z).multiply(new THREE.Matrix4().makeRotationZ(delta))
    .multiply(new THREE.Matrix4().makeTranslation(-w0.x, -w0.y, -w0.z)).multiply(palm);

  // Fingers: every bone is laid exactly from the user's joint to the next one (no build-up of error).
  const n = new THREE.Vector3().crossVectors(R[5].clone().sub(R[0]), R[17].clone().sub(R[0])).normalize().transformDirection(palm);
  const across = R[17].clone().sub(R[5]).transformDirection(palm);
  const rotOnly = new THREE.Matrix4().extractRotation(palm);
  for (const [s, a, b, parent] of FINGER_SEGS) {
    const joint = P[a];
    const restDir = R[b].clone().sub(R[a]).transformDirection(rotOnly);
    const userDir = P[b].clone().sub(P[a]);
    const restLen = R[b].distanceTo(R[a]) * scale, userLen = userDir.length();
    if (userLen < 1e-3) { seg[s].copy(seg[parent]); continue; }
    const k = scale * Math.max(0.6, Math.min(1.6, userLen / Math.max(restLen, 1e-3)));
    // Twist reference: the palm's normal, or the line across the knuckles when a finger points along it.
    const u = userDir.clone().normalize();
    const ref = Math.abs(u.dot(n)) < 0.8 ? n : across;
    const Q = frame(userDir, ref).multiply(frame(restDir, ref).transpose());
    seg[s].makeTranslation(joint.x, joint.y, joint.z).multiply(Q).multiply(rotOnly)
      .multiply(new THREE.Matrix4().makeScale(k, k, k)).multiply(new THREE.Matrix4().makeTranslation(-R[a].x, -R[a].y, -R[a].z));
  }
  return { seg, scale, delta };
}

/** Screen position of each rest joint under the current segment matrices. */
export function posedJoints(arm, seg) {
  const of = [1, 2, 3, 4, 4, 1, 5, 6, 7, 1, 8, 9, 10, 1, 11, 12, 13, 1, 14, 15, 16];
  // joint 0 and the knuckles ride on the palm; every other joint on the bone that ends there
  const owner = [1, 2, 2, 3, 4, 1, 5, 6, 7, 1, 8, 9, 10, 1, 11, 12, 13, 1, 14, 15, 16];
  void of;
  return arm.joints.map((j, i) => j.clone().applyMatrix4(seg[owner[i]]));
}
