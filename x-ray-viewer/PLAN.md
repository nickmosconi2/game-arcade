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

Runs in Safari, Chrome or any modern browser. No install, files never leave the device.
The user loads a scan and points the camera at the arm. Nothing else to set.

| Piece | State |
| --- | --- |
| DICOM reader (implicit/explicit little endian, uncompressed, baseline JPEG, multi-frame, zip) | Working |
| Automatic scan analysis: finds the hand, wrist, forearm direction and thumb side from the bones | Working on the demo arm CT; needs real arm scans |
| X-ray vision: full-screen camera, anatomy drawn inside the arm's own outline, fading into real skin at the edges | Working with real hand tracking on test photos; **needs an on-phone test** |
| Follows a bent wrist by finding the forearm in the camera picture | Working on test photos |
| 3D view (bone / muscle / skin) and slice view (pinch, zoom, presets) | Working |

How it lines up with no user input: the hand tracker finds the wrist, the hand's direction
and its real size (an adult hand is about 92 mm from wrist to middle knuckle). The scan's
wrist, forearm direction and thumb side are worked out from its bones when it loads. The
forearm direction in the camera picture comes from the skin-coloured area behind the wrist.

Known gaps:

1. Only hand / wrist / forearm scans get X-ray vision; other body parts open in 3D or Slices.
2. Compressed scans (JPEG-LS, JPEG 2000, JPEG lossless, RLE) are not decoded yet. Many
   hospital discs use these.
3. A flat X-ray assumes the fingers point toward the top of the picture.
4. Twisting the forearm moves the overlay with the hand, but the bones on screen keep the scan's pose.

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
| Tracking | ARKit world tracking + Vision hand and body pose, placed in true 3D using LiDAR depth |
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
