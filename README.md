# EdgeReg

Rigid/affine MRI registration, **entirely in your browser** — no upload, no server. Register a *moving* image to a *stationary* template and inspect the resliced result side by side. Everything runs in WebAssembly + WebGPU on your machine, so your images are never shared with the cloud.

Live demo: [www.edgereg.org](https://www.edgereg.org/) (GitHub Pages, custom domain).

> EdgeReg is a sibling of [**deface**](https://github.com/niivue/deface) (browser facial anonymization); the two share the same niimath + NiiVue foundations but are separate tools.

## What you see

Three NiiVue panels, left to right:

1. **Moving** — the image being registered, in its native resolution. Pick a predefined image from the dropdown above it, or drag in your own (NIfTI or a DICOM folder).
2. **Template (stationary)** — the fixed reference the moving image is registered to. Also a dropdown + drop target.
3. **Resliced** — the moving image after registration, resampled into template space. This panel is the output and can't be edited directly.

Registration is **automatic**: whenever the moving or stationary image changes (on load, on a preset change, or on a drop), EdgeReg recomputes the transform and refreshes the resliced panel.

The **Template** and **Resliced** panels share crosshairs (bidirectional sync) — because the resliced image lives on the template grid, a click in one is anatomically meaningful in the other. The **Moving** panel is in native space and stays independent.

In the 3D render, the crosshair is drawn *through* the volume (a faint X-ray of the surface), so the focus point stays visible inside the head instead of being hidden behind the opaque render.

## How it works

- **[niimath](https://github.com/rordenlab/niimath)** computes the moving→stationary affine transform and reslices the moving image into template space with its [3dAllineate](https://afni.nimh.nih.gov/)-style (RW Cox / AFNI) `-allineate` engine. The core operation is a single niimath chain:

  ```
  niimath moving [-robustfov] -allineate template -gz 0 resliced
  ```

  (`-robustfov` is chained in only when the toolbar checkbox is on.) All niimath I/O is uncompressed (`-gz 0`) for speed.
- **[NiiVue](https://niivue.com/)** renders all three panels and handles crosshair sync.
- **[dcm2niix](https://github.com/rordenlab/dcm2niix)** converts dropped DICOM folders to NIfTI.

### Controls

- **View** (toolbar) — the slice layout (Axial / Coronal / Sagittal / Render / A+C+S+R), applied to all three panels at once.
- **Robust FOV** (toolbar checkbox, off by default) — remove excess neck from an image of the brain (niimath `-robustfov` crops the moving image's inferior slices) before registration, so a large non-brain field of view doesn't pull the fit off. Toggling it re-registers.
- **About** (toolbar) — what EdgeReg is and the niimath command it runs.
- The **ⓘ** button above each panel shows that image's NIfTI header.
- **Save** (above the Resliced panel) downloads the resliced moving image as `resliced.nii.gz`; enabled once a registration has completed.
- The status bar shows the crosshair's **world location in mm** (rounded to the nearest mm — on the MNI templates 0×0×0 is roughly the anterior commissure) and the intensity under it (both the template and resliced values when you move the crosshair in either synced panel).

The Template dropdown offers three bundled templates: `MNI152_T1_1mm.nii.gz` (default), the lower-resolution SPM `avg152T1` 2 mm, and the extended `MNI152_T1_ext`. The Moving dropdown also lists sample images streamed on demand from the [niivue-demo-images](https://github.com/niivue/niivue-demo-images) repository — including several 4D scans (the vendored niimath registers their first volume automatically).

## License

**BSD-2-Clause.** Registration uses the BSD-2 build of niimath (the `-allineate` engine — no GPL SPM code), so the whole app is BSD-2-Clause. (The build is currently newer than the npm release, so the vendored artifacts live under [src/niimath/](src/niimath/); this goes away once niimath republishes to npm.)

The MNI152_T1_ext template is the [Asymmetric ICBM 152 extended nonlinear atlas](https://nist.mni.mcgill.ca/icbm-152-extended-nonlinear-atlases-2020/)

## Develop

```bash
npm install      # or: bun install
npm run dev      # vite dev server (http://localhost:8091)
npm run build    # typecheck + production build to dist/
npm run preview  # serve the production build
npm run test:e2e # build, then headless-Chromium smoke (registration + sync)
```

Requires a browser with WebGPU (recent desktop Chrome, Edge, or Safari).
