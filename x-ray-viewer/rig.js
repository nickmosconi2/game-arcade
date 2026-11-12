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
/**
 * Lay a model bone (restA -> restB) from screen point A to screen point B. Its length is stretched
 * to reach B exactly; its thickness follows `scale` (px per mm of the hand or body), so a bone seen
 * end-on gets shorter but not thinner.
 */
function laySegment(restA, restB, A, B, baseRot, ref, scale, minK = 0.5, maxK = 2.5) {
  const restVec = restB.clone().sub(restA), restLen = restVec.length();
  const restDir = restVec.clone().transformDirection(baseRot);
  const userDir = B.clone().sub(A), userLen = userDir.length();
  if (userLen < 1e-3 || restLen < 1e-3) return null;
  const kLen = Math.max(minK * scale * 0.3, Math.min(maxK * scale, userLen / restLen));
  const kThick = scale * Math.max(0.8, Math.min(1.25, kLen / scale));
  const d = restVec.clone().divideScalar(restLen);
  // scale kThick everywhere plus extra along the bone's own axis (rest space)
  const e = kLen - kThick, S = new THREE.Matrix4().set(
    kThick + e * d.x * d.x, e * d.x * d.y, e * d.x * d.z, 0,
    e * d.y * d.x, kThick + e * d.y * d.y, e * d.y * d.z, 0,
    e * d.z * d.x, e * d.z * d.y, kThick + e * d.z * d.z, 0,
    0, 0, 0, 1);
  const Q = frame(userDir, ref).multiply(frame(restDir, ref).transpose());
  return new THREE.Matrix4().makeTranslation(A.x, A.y, A.z).multiply(Q).multiply(baseRot)
    .multiply(S).multiply(new THREE.Matrix4().makeTranslation(-restA.x, -restA.y, -restA.z));
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

// Segments owned by each solver (the forearm/upper arm can come from either).
export const HAND_SEGS = (i) => [SEG.hand[i], ...Array.from({ length: 15 }, (_, f) => SEG.fingers[i] + f)];
export const BODY_SEGS = [0, 1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 13];

/**
 * Hand: palm fitted to the wrist and knuckles; finger bones laid joint to joint. Writes target
 * matrices into tgt and marks them in want. The forearm is placed only when asked (hand-only view)
 * and only along a forearm actually seen in the picture.
 */
export function solveHand(model, side, P, tgt, want, { withForearm = false, forearmDir = null } = {}) {
  const i = side2i(side), R = model.hands[side];
  const { M: palm, scale } = fitRigid(PALM.map((j) => R[j]), PALM.map((j) => P[j]));
  tgt[SEG.hand[i]].copy(palm); want[SEG.hand[i]] = true;
  const rotOnly = new THREE.Matrix4().extractRotation(palm);
  const n = new THREE.Vector3().crossVectors(R[5].clone().sub(R[0]), R[17].clone().sub(R[0])).normalize().transformDirection(rotOnly);
  const across = R[17].clone().sub(R[5]).transformDirection(rotOnly);
  for (const [f, a, b] of FINGER_SEGS) {
    const u = P[b].clone().sub(P[a]).normalize();
    const M = laySegment(R[a], R[b], P[a], P[b], rotOnly, Math.abs(u.dot(n)) < 0.8 ? n : across, scale);
    tgt[SEG.fingers[i] + f].copy(M || palm); want[SEG.fingers[i] + f] = true;
  }
  if (withForearm && forearmDir) {
    const elbowRest = model.pose[i === 0 ? 13 : 14];
    const w0 = R[0].clone().applyMatrix4(palm), e = elbowRest.clone().applyMatrix4(palm).sub(w0);
    if (Math.hypot(e.x, e.y) > 1e-3) {
      let delta = Math.atan2(e.x * forearmDir.y - e.y * forearmDir.x, e.x * forearmDir.x + e.y * forearmDir.y);
      delta = Math.max(-1, Math.min(1, delta));
      const F = new THREE.Matrix4().makeTranslation(w0.x, w0.y, w0.z).multiply(new THREE.Matrix4().makeRotationZ(delta))
        .multiply(new THREE.Matrix4().makeTranslation(-w0.x, -w0.y, -w0.z)).multiply(palm);
      tgt[SEG.forearm[i]].copy(F); want[SEG.forearm[i]] = true;
    }
  }
  return { scale };
}

/**
 * Body from the 33 body points. Strict: a bone is placed only when both of its joints are clearly
 * seen inside the picture (no guessed limbs). The torso needs both shoulders plus either the hips
 * or the face; the skull needs three face points.
 */
export function solveBody(model, P, vis, tgt, want, { minVis = 0.65, loose = vis } = {}) {
  // ok: seen inside the picture (limbs). okT: may be a little outside it (torso and head fits).
  const J = model.pose, ok = (i) => P[i] && (vis[i] ?? 0) > minVis, okT = (i) => P[i] && (loose[i] ?? 0) > minVis;
  for (const s of BODY_SEGS) want[s] = false;
  if (!okT(11) || !okT(12) || (!ok(11) && !ok(12))) return null;
  const T = [11, 12, ...[23, 24].filter(okT)];
  const face = [0, 7, 8].filter(okT);
  if (T.length < 4 && face.length < 2) return null;
  const pts = T.length >= 4 ? T : [...T, ...face];
  const { M: torso, scale } = fitRigid(pts.map((j) => J[j]), pts.map((j) => P[j]));
  tgt[SEG.torso].copy(torso); want[SEG.torso] = true;
  const rotOnly = new THREE.Matrix4().extractRotation(torso);
  const fwd = new THREE.Vector3(0, 0, model.info.front || 1).transformDirection(rotOnly);
  const upv = new THREE.Vector3(0, 1, 0).transformDirection(rotOnly);
  const Hd = [0, 2, 5, 7, 8].filter(okT);
  if (Hd.length >= 3) { tgt[SEG.head].copy(fitRigid(Hd.map((j) => J[j]), Hd.map((j) => P[j])).M); want[SEG.head] = true; }
  const lay = (s, a, b, ref) => {
    if (!ok(a) || !ok(b)) return;
    const M = laySegment(J[a], J[b], P[a], P[b], rotOnly, ref, scale);
    if (M) { tgt[s].copy(M); want[s] = true; }
  };
  for (const i of [0, 1]) {
    lay(SEG.upperArm[i], 11 + i, 13 + i, fwd);
    lay(SEG.forearm[i], 13 + i, 15 + i, fwd);
    lay(SEG.thigh[i], 23 + i, 25 + i, fwd);
    lay(SEG.shin[i], 25 + i, 27 + i, fwd);
    lay(SEG.foot[i], 27 + i, 31 + i, upv);
  }
  return { scale };
}

/** Hide everything (used before a hand-only solve). */
export function hideAll(seg) { for (const m of seg) m.copy(HIDDEN); }

