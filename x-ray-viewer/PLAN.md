# X-ray Viewer: plan

Goal: point a phone camera at your arm and see the bones and muscle from your own
scan drawn in place, as if the phone had X-ray vision. The picture always comes from
a DICOM file (CT, MRI or X-ray); the camera only tells the app where your arm is.

## What is possible and what is not

- **CT and MRI are 3D.** They can be turned into surfaces (bone, muscle, skin) and
  drawn from any angle, so they can follow the arm as it turns.
- **A plain X-ray is one flat picture.** It can be laid over the arm like a film and
  follows position, angle and size, but it cannot show a different view when the arm
  rotates.
- **The overlay is the scan, not live anatomy.** It shows the pose the arm had in the
  scanner. A bent wrist or a rotated forearm will not bend the bones on screen.
- **Accuracy is "looks right", not clinical.** Expect a centimetre or so of error on a
  phone. This is a viewer for curiosity and education, never for diagnosis or treatment.

## Phase 0: browser MVP (built, in `web/`)

Opens to the normal camera. Tap **X-RAY**: a window appears, and wherever your arm passes behind
it the skin is "cut open" to show what is inside: bones, muscles and tendons, arteries and veins,
each named. Everything is posed from your own tracked hand, bone by bone, so the finger bones bend
and spread with your fingers.

| Piece | State |
| --- | --- |
| Anatomy: BodyParts3D 4.0 (DBCLS, CC BY 4.0), left and right arm, 149 structures each: 30 bones, muscles with tendons, arteries, veins | Done |
| Rig: 21 hand joints computed on the model's skeleton; every vertex bound to forearm, palm or one of 15 finger bones | Done |
| Posing: palm fitted to the user's wrist and knuckles (rotation + size), each finger bone aimed along the user's finger, forearm swung to the arm seen in the picture | Tested on photos |
| Opening clipped to the arm's own outline, with a cut skin/fat rim, dark cavity and inner shadow; muscle thins toward the middle so vessels and bone show | Done |
| Layers (all / vessels + bone / bone), anatomy or X-ray-film look, labels and a caption for the bone in the middle | Done |
| Stays locked when the phone is close and the hand is out of view (optical flow) | Tested on simulated close-ups |
| Left/right arm picked from hand detection, with a manual switch | Done |
| 3D model view with layer toggles | Done |
| CT/DICOM viewing (real Visible Human arm CT, slices, volume rendering) | Built earlier; parked, to be merged back in |

Known gaps:

1. Not yet tuned on a live iPhone camera.
2. The forearm follows the hand's turn but not a separate forearm twist when the hand is out of view.
3. Muscles move with the nearest bone; they do not bulge or slide like real muscle.
4. Peripheral nerves are not in BodyParts3D; adding them needs another source (for example Z-Anatomy).
5. It is a reference body, not the user's anatomy.

## Phase 1: make the browser version solid (about 1 to 2 weeks)

1. Test Follow my arm on a real iPhone; tune smoothing, scale and default twist.
2. Add WebAssembly decoders for JPEG-LS, JPEG 2000 and JPEG lossless; add RLE.
3. Track the forearm itself: add body-pose landmarks (elbow + wrist) so the overlay
   follows the arm when the wrist bends or the hand leaves the frame.
4. One-time calibration: remember twist / slide / size per scan.
5. Move loading and surface building to a background worker; keep full-resolution slices.
6. Get a real arm CT or MRI to test with (your own scan disc, or a public archive).
7. True volume rendering (ray-marched, GPU) as an alternative to surfaces, which gives
   the classic translucent "X-ray" look and works for MRI.

## Phase 2: native iOS app (about 3 to 6 weeks)

The browser cannot measure depth, so the web overlay is a flat estimate. A native app
can do much better on an iPhone with LiDAR (Pro models):

| Area | Approach |
| --- | --- |
| UI | SwiftUI; same three modes (Slices, 3D, X-ray vision) |
| DICOM | Port the reader to Swift; DCMTK or GDCM for compressed formats |
| Rendering | RealityKit for surfaces, Metal ray-marching for volumes |
| Tracking | ARKit world tracking + Vision hand and body pose, placed in true 3D using LiDAR depth (Safari cannot read the LiDAR sensor, so this needs the native app) |
| Registration | Fit the scan's skin surface to the LiDAR surface of the arm (ICP) for automatic alignment; optional printed marker for extra stability |
| Occlusion | Use LiDAR depth so the anatomy appears inside the arm rather than floating on top |
| Files | Open from Files, AirDrop, and "Open in" from mail; everything stays on device |

Code that carries over: file-format logic, series sorting, surface extraction, and the
pose math, all of which are plain algorithms in `web/dicom.js`, `web/volume.js` and
`web/app.js`.

Needed for this phase: a Mac that runs current Xcode (or a cloud Mac / CI build), an
Apple Developer account for installing on a phone and for TestFlight.

## Phase 3: release

1. Clear "not a medical device, not for diagnosis" wording in the app and store listing.
2. Privacy: no uploads, no analytics on scan content, strip patient names from the UI.
3. TestFlight beta with a few real scans from different scanners.
4. App Store review (expect questions about medical claims; keep it positioned as a viewer).

## Decisions to make later

- Surfaces versus volume rendering as the default look.
- Whether to support marker-based alignment (most stable) alongside markerless.
- Android: the browser version already covers it; a native app only if demand shows.
