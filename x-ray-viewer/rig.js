// Poses the whole-body anatomy from tracking:
//   body pose (33 points): torso, head, upper arms, forearms, thighs, lower legs, feet, hands (coarse)
//   hand (21 points):      palm and every finger bone of that hand, laid exactly on the joints
// All matrices map model millimetres to screen pixels (centre origin, y up, z toward the viewer).
import * as THREE from './vendor/three.module.min.js';

export const SEG = { torso: 0, head: 1, upperArm: [2, 3], forearm: [4, 5], hand: [6, 7], thigh: [8, 9], shin: [10, 11], foot: [12, 13], fingers: [14, 29] };
export const SEG_COUNT = 44;
// [local finger segment, from joint, to joint]
export const FINGER_SEGS = [
  [0, 1, 2], [1, 2, 3], [2, 3, 4],
  [3, 5, 6], [4, 6, 7], [5, 7, 8],
  [6, 9, 10], [7, 10, 11], [8, 11, 12],
  [9, 13, 14], [10, 14, 15], [11, 15, 16],
  [12, 17, 18], [13, 18, 19], [14, 19, 20],
];
const PALM = [0, 5, 9, 13, 17];
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
const side2i = (side) => (side === 'left' ? 0 : 1);

/** Rotation (Matrix4) that best maps centred src onto centred dst (Horn's quaternion method). */
function bestRotation(src, dst) {
  let Sxx = 0, Sxy = 0, Sxz = 0, Syx = 0, Syy = 0, Syz = 0, Szx = 0, Szy = 0, Szz = 0;
  for (let i = 0; i < src.length; i++) {
    const a = src[i], b = dst[i];
    Sxx += a.x * b.x; Sxy += a.x * b.y; Sxz += a.x * b.z; Syx += a.y * b.x; Syy += a.y * b.y; Syz += a.y * b.z; Szx += a.z * b.x; Szy += a.z * b.y; Szz += a.z * b.z;
  }
  const N = [
    [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx], [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
    [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy], [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz],
  ];
  let shift = 0; for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) shift += Math.abs(N[i][j]);
  let q = [1, 0, 0, 0];
  for (let it = 0; it < 60; it++) {
    const r = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) r[i] += (N[i][j] + (i === j ? shift : 0)) * q[j];
    const l = Math.hypot(...r) || 1; q = r.map((v) => v / l);
  }
  return new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion(q[1], q[2], q[3], q[0]));
}
/** Best-fit rotation + (picture-plane) scale + translation from model points to screen points. */
function fitRigid(src, dst) {
  const cs = new THREE.Vector3(), cd = new THREE.Vector3();
  src.forEach((v) => cs.add(v)); cs.divideScalar(src.length);
  dst.forEach((v) => cd.add(v)); cd.divideScalar(dst.length);
  const s0 = src.map((v) => v.clone().sub(cs)), d0 = dst.map((v) => v.clone().sub(cd));
  const rot = bestRotation(s0, d0);
  let np = 0, nd = 0;
  for (let i = 0; i < s0.length; i++) { const w = s0[i].clone().applyMatrix4(rot); np += w.x * w.x + w.y * w.y; nd += d0[i].x * d0[i].x + d0[i].y * d0[i].y; }
  const scale = Math.sqrt(nd / Math.max(np, 1e-6));
  const M = new THREE.Matrix4().makeTranslation(cd.x, cd.y, cd.z).multiply(rot)
    .multiply(new THREE.Matrix4().makeScale(scale, scale, scale)).multiply(new THREE.Matrix4().makeTranslation(-cs.x, -cs.y, -cs.z));
  return { M, rot, scale };
}
function frame(dir, ref) {
  const x = dir.clone().normalize();
  const z = ref.clone().addScaledVector(x, -ref.dot(x));
  if (z.lengthSq() < 1e-8) z.set(0, 0, 1).addScaledVector(x, -x.z);
  z.normalize();
  return new THREE.Matrix4().makeBasis(x, new THREE.Vector3().crossVectors(z, x), z);
}
/** Lay a model bone (restA -> restB) from screen point A toward screen point B. */
function laySegment(restA, restB, A, B, baseRot, ref, scale, minK = 0.6, maxK = 1.6) {
  const restDir = restB.clone().sub(restA).transformDirection(baseRot);
  const userDir = B.clone().sub(A), userLen = userDir.length(), restLen = restB.distanceTo(restA) * scale;
  if (userLen < 1e-3) return null;
  const k = scale * Math.max(minK, Math.min(maxK, userLen / Math.max(restLen, 1e-3)));
  const Q = frame(userDir, ref).multiply(frame(restDir, ref).transpose());
  return new THREE.Matrix4().makeTranslation(A.x, A.y, A.z).multiply(Q).multiply(baseRot)
    .multiply(new THREE.Matrix4().makeScale(k, k, k)).multiply(new THREE.Matrix4().makeTranslation(-restA.x, -restA.y, -restA.z));
}

/** Screen points from a MediaPipe result: x, y from the picture; depth from the metric world points. */
export function screenPoints(image, world, toScreen, pairs) {
  const img = image.map((p) => toScreen(p.x, p.y));
  let num = 0, den = 0;
  for (const [a, b] of pairs) {
    num += Math.hypot(img[a][0] - img[b][0], img[a][1] - img[b][1]);
    den += Math.hypot(world[a].x - world[b].x, world[a].y - world[b].y);
  }
  const k = den > 1e-6 ? num / den : 1000;
  const z0 = world[0].z;
  return img.map((p, i) => new THREE.Vector3(p[0], p[1], -(world[i].z - z0) * k));
}
export const HAND_PAIRS = [[0, 5], [0, 17], [5, 17], [0, 9], [5, 9], [9, 13], [13, 17]];
export const POSE_PAIRS = [[11, 12], [23, 24], [11, 23], [12, 24], [11, 13], [12, 14]];

/**
 * Hand: palm fitted to the wrist and knuckles; finger bones laid joint to joint.
 * If `withForearm`, also places the forearm (and upper arm) from the palm, swung toward forearmDir.
 */
export function solveHand(model, side, P, seg, { withForearm = false, forearmDir = null, prevDelta = 0 } = {}) {
  const i = side2i(side), R = model.hands[side];
  const { M: palm, scale } = fitRigid(PALM.map((j) => R[j]), PALM.map((j) => P[j]));
  seg[SEG.hand[i]].copy(palm);
  const rotOnly = new THREE.Matrix4().extractRotation(palm);
  const n = new THREE.Vector3().crossVectors(R[5].clone().sub(R[0]), R[17].clone().sub(R[0])).normalize().transformDirection(rotOnly);
  const across = R[17].clone().sub(R[5]).transformDirection(rotOnly);
  for (const [f, a, b] of FINGER_SEGS) {
    const u = P[b].clone().sub(P[a]).normalize();
    const M = laySegment(R[a], R[b], P[a], P[b], rotOnly, Math.abs(u.dot(n)) < 0.8 ? n : across, scale);
    seg[SEG.fingers[i] + f].copy(M || palm);
  }
  let delta = prevDelta;
  if (withForearm) {
    const elbowRest = model.pose[i === 0 ? 13 : 14];
    const w0 = R[0].clone().applyMatrix4(palm), e = elbowRest.clone().applyMatrix4(palm).sub(w0);
    if (forearmDir && Math.hypot(e.x, e.y) > 1e-3) {
      delta = Math.atan2(e.x * forearmDir.y - e.y * forearmDir.x, e.x * forearmDir.x + e.y * forearmDir.y);
      delta = Math.max(-1, Math.min(1, delta));
    } else delta *= 0.9;
    const F = new THREE.Matrix4().makeTranslation(w0.x, w0.y, w0.z).multiply(new THREE.Matrix4().makeRotationZ(delta))
      .multiply(new THREE.Matrix4().makeTranslation(-w0.x, -w0.y, -w0.z)).multiply(palm);
    seg[SEG.forearm[i]].copy(F); seg[SEG.upperArm[i]].copy(F);
  }
  return { scale, delta };
}

/**
 * Body: torso fitted to shoulders and hips, head to the face points, each limb bone laid from one
 * tracked joint to the next. Segments whose joints are not visible are hidden.
 * handsTracked: {left: bool, right: bool}: hands driven by the hand tracker are left alone.
 */
export function solveBody(model, P, vis, seg, handsTracked = {}) {
  const J = model.pose, ok = (i) => P[i] && (vis[i] ?? 1) > 0.35;
  for (let s = 0; s < SEG_COUNT; s++) {
    const isHand = (s === SEG.hand[0] || (s >= SEG.fingers[0] && s < SEG.fingers[0] + 15)) ? 'left'
      : (s === SEG.hand[1] || (s >= SEG.fingers[1] && s < SEG.fingers[1] + 15)) ? 'right' : null;
    if (!isHand || !handsTracked[isHand]) seg[s].copy(HIDDEN);
  }
  const T = [11, 12, 23, 24];
  if (!ok(11) && !ok(12)) return null;
  const { M: torso, scale } = fitRigid(T.map((j) => J[j]), T.map((j) => P[j]));
  seg[SEG.torso].copy(torso);
  const rotOnly = new THREE.Matrix4().extractRotation(torso);
  const fwd = new THREE.Vector3(0, 0, model.info.front || 1).transformDirection(rotOnly);
  const upv = new THREE.Vector3(0, 1, 0).transformDirection(rotOnly);
  const Hd = [0, 2, 5, 7, 8].filter(ok);
  if (Hd.length >= 3) seg[SEG.head].copy(fitRigid(Hd.map((j) => J[j]), Hd.map((j) => P[j])).M);
  else if (ok(0)) seg[SEG.head].copy(torso);
  const lay = (s, a, b, ref) => { if (ok(a) && ok(b)) { const M = laySegment(J[a], J[b], P[a], P[b], rotOnly, ref, scale, 0.65, 1.5); if (M) seg[s].copy(M); } };
  for (const i of [0, 1]) {
    lay(SEG.upperArm[i], 11 + i, 13 + i, fwd);
    lay(SEG.forearm[i], 13 + i, 15 + i, fwd);
    lay(SEG.thigh[i], 23 + i, 25 + i, fwd);
    lay(SEG.shin[i], 25 + i, 27 + i, fwd);
    lay(SEG.foot[i], 27 + i, 31 + i, upv);
    const side = i === 0 ? 'left' : 'right';
    if (!handsTracked[side] && ok(15 + i) && ok(17 + i) && ok(19 + i)) {
      // coarse hand from the wrist, index and little-finger knuckles
      const R = model.hands[side];
      const restMid = R[5].clone().add(R[17]).multiplyScalar(0.5), userMid = P[17 + i].clone().add(P[19 + i]).multiplyScalar(0.5);
      const M = laySegment(R[0], restMid, P[15 + i], userMid, rotOnly, fwd, scale, 0.6, 1.6);
      if (M) { seg[SEG.hand[i]].copy(M); for (let f = 0; f < 15; f++) seg[SEG.fingers[i] + f].copy(M); }
    }
  }
  return { scale };
}

/** Hide everything (used before a hand-only solve). */
export function hideAll(seg) { for (const m of seg) m.copy(HIDDEN); }

/**
 * Limbs only (no shoulders in view, e.g. a leg seen from above): each limb bone is laid from one
 * joint to the next in the picture plane, sized from its own length. P: 33 points, z ignored.
 */
export function solveLimbs(model, P, vis, seg, handsTracked = {}) {
  const J = model.pose, ok = (i) => P[i] && (vis[i] ?? 0) > 0.3;
  for (let s = 0; s < SEG_COUNT; s++) {
    const isHand = (s === SEG.hand[0] || (s >= SEG.fingers[0] && s < SEG.fingers[0] + 15)) ? 'left'
      : (s === SEG.hand[1] || (s >= SEG.fingers[1] && s < SEG.fingers[1] + 15)) ? 'right' : null;
    if (!isHand || !handsTracked[isHand]) seg[s].copy(HIDDEN);
  }
  const I = new THREE.Matrix4(), toward = new THREE.Vector3(0, 0, 1);
  const flat = (i) => new THREE.Vector3(P[i].x, P[i].y, 0);
  let n = 0, sum = 0;
  const lay = (s, a, b) => {
    if (!ok(a) || !ok(b)) return null;
    const A = flat(a), B = flat(b), k = A.distanceTo(B) / Math.max(J[a].distanceTo(J[b]), 1);
    if (k < 0.05) return null;
    const M = laySegment(J[a], J[b], A, B, I, toward, k, 1, 1);
    if (M) { seg[s].copy(M); n++; sum += k; }
    return M ? k : null;
  };
  for (const i of [0, 1]) {
    lay(SEG.upperArm[i], 11 + i, 13 + i);
    const kf = lay(SEG.forearm[i], 13 + i, 15 + i);
    lay(SEG.thigh[i], 23 + i, 25 + i);
    const ks = lay(SEG.shin[i], 25 + i, 27 + i);
    // No toe point: the foot stays at its rest angle to the shin (pointing toward the camera).
    if (ks && ok(27 + i)) seg[SEG.foot[i]].copy(seg[SEG.shin[i]]);
    const side = i === 0 ? 'left' : 'right';
    if (kf && !handsTracked[side] && ok(15 + i)) {
      // hand continues the forearm
      const A = flat(15 + i), d = A.clone().sub(flat(13 + i)).normalize(), R = model.hands[side];
      const mid = R[5].clone().add(R[17]).multiplyScalar(0.5), len = R[0].distanceTo(mid) * kf;
      const M = laySegment(R[0], mid, A, A.clone().addScaledVector(d, len), I, toward, kf, 1, 1);
      if (M) { seg[SEG.hand[i]].copy(M); for (let f = 0; f < 15; f++) seg[SEG.fingers[i] + f].copy(M); }
    }
  }
  return n ? { scale: sum / n } : null;
}
