This file provides guidance to AI agents when working with code in this repository.

## What this is

Browser-only MRI **registration**. Load a *moving* NIfTI (or a DICOM folder) and a *stationary* template, register the moving image to the template (affine `-allineate`), and view the resliced moving image in template space. **No data leaves the machine** — everything runs in WebAssembly + WebGPU.

EdgeReg is a sibling of **deface** (browser facial anonymization). They share the niimath + NiiVue + dcm2niix foundation but are separate tools with separate missions: deface *back-projects a face mask onto the moving image*; EdgeReg *reslices the moving image into template space*. Do not reintroduce defacing/brain-extraction (mindgrab) code here.

## The core operation

Registration is one niimath chain, equivalent to the command line:

```
niimath moving [-robustfov] -allineate template -gz 0 resliced
```

The moving image is the primary input; the stationary/template image is the `-allineate` base; the output is the moving image resliced onto the template grid. In code: `niimath.image(movingFile).gz(0).allineate(stationaryFile).run('reg.nii')`. The optional `-robustfov` (the **Robust FOV** toolbar checkbox, `#robustfovCheck`, off by default) is chained BEFORE `-allineate` (`base.robustfov()`) to crop the moving image's neck/inferior slices so a large non-brain FOV doesn't pull the fit off.

## Commands

```bash
npm run dev        # vite dev server on http://localhost:8091
npm run build      # tsc --noEmit (typecheck) + vite build to dist/
npm run typecheck  # tsc --noEmit only
npm run preview    # serve the production build (port 4173)
npm run test:e2e   # builds first, then headless-Chromium smoke
```

No unit-test runner, no linter beyond `tsc` — "validate before commit" = typecheck + build + smoke. `test:e2e` builds first (so it can't pass against a stale `dist`), boots `vite preview` (failing fast on a port clash), and drives the real app in system Chrome with software WebGPU (`--use-gl=angle --enable-unsafe-swiftshader`). It waits for the default registration to complete (the resliced panel populates) and **fails on any `console.error`/page error** — keep that gate meaningful (handle expected capability absences with `console.warn`, not `error`).

## Architecture

Single-page app, no framework. [src/main.ts](src/main.ts) is the whole UI controller. It drives **three NiiVue instances**, one per column:

- **`nvMoving`** (`#glMoving`) — the moving image, native space. A preset dropdown (`#movingSelect`) + drop target.
- **`nvStationary`** (`#glStationary`) — the stationary template. Preset dropdown (`#stationarySelect`) + drop target.
- **`nvResliced`** (`#glResliced`) — the registration output. Not user-editable (drops are refused).

Subsystems:

- **NiiVue** (`@niivue/niivue`, WebGPU) — renders the three panels. Constructed eagerly, but `attachTo()` is deferred to `init()` behind the `navigator.gpu` guard (in `attachAll()`), so every WebGPU-unavailable path shows a friendly message instead of an unhandled rejection. `configureNv()` sets a fixed X-ray on each instance — `nv.is3DCrosshairVisible = true; nv.meshXRay = 0.08` — so the 3D crosshair is drawn *through* the opaque volume render and the focus point stays visible inside the head (0.08 reveals it without washing out the surface); it also `destroyNv()`s an instance whose `attachTo()` resolved only *after* `isCleanedUp` (an HMR race). Each instance gets an extension context whose `locationChange` updates the footer crosshair readout (`#location`, white) — the **world location in mm** (`d.mm`, rounded to the nearest mm via `fmtMm`; 0×0×0 ≈ the anterior commissure on the MNI templates) plus intensities, distinct from the permanent drag-drop hint (`.drophint`, accent). Because the template + resliced panels are yoked and share a voxel grid, a crosshair move on either fires two `locationChange` events (direct + broadcast); each carries only its own instance's value, so `onTemplateLoc`/`onReslicedLoc` each store their value and `renderYoked()` shows BOTH intensities (moving on either → both). The moving panel (native, independent) shows only its own via `onMovingLoc`.
- **niimath** (the **BSD** build, vendored as local source in [src/niimath/](src/niimath/)) — runs the `-allineate` registration in a WASM worker. See "niimath (the BSD build)".
- **dcm2niix** ([src/dcm2niix/](src/dcm2niix/)) — converts dropped DICOM folders to NIfTI; drop traversal uses `webkitGetAsEntry()` and stamps `_webkitRelativePath` so dcm2niix groups by series. `runDcm2niix()` bounds worker init with a ~30 s timeout (`DCM_INIT_TIMEOUT_MS`) — the `@niivue/dcm2niix` package ignores structured pre-ready worker errors, so without it a failed init hangs — and always terminates the worker in `finally` (the timeout rejection still reaches it and releases the WASM heap).

### Sync (the two right panels)
`nvStationary.broadcastTo([nvResliced])` and `nvResliced.broadcastTo([nvStationary])` set up **bidirectional** crosshair/orientation sync — the resliced image lives on the template grid, so their world frames coincide. The moving panel is in native space and is deliberately **not** synced. The **View** dropdown (`#sliceType`) sets `sliceType` on all three instances at once.

### Registration flow (`register()` in main.ts)
`loadSlot(slot, file)` first `clearResliced()`s — the shared helper (clears `reslicedReady` + `yResliced`/`#location`, then `nvResliced.removeAllVolumes()`) that blanks the stale output up front so a bad source or failed registration can't leave a stale result visible or saveable beside the new/blank input — then loads the file, records it as the pristine `movingFile`/`stationaryFile`, and calls `register()`. `register()` no-ops until BOTH images exist, then runs the `-allineate` chain (prefixed with `.robustfov()` when `#robustfovCheck` is checked) and loads the result into `nvResliced`. It always registers the pristine source files (never the previous resliced output), so repeated changes don't compound. Toggling **Robust FOV** enqueues `reregister()`, which — unlike a bare `register()` — `clearResliced()`s first, so the stale output is visibly blanked while the crop reprocesses (smoke-asserted). Fail-closed: if a slot's `loadVolume` throws, `loadSlot()` clears that slot's `movingFile`/`stationaryFile` so a later re-register can't target a stale source that diverges from the now-blank panel — `register()` then early-returns until a good image reloads.

### Readiness & lifecycle gates
- **`appReady`** — `init()` flips it true only *after* `attachAll()` (WebGPU attach) succeeds, and `setControlsBusy()` disables every image control while `!appReady` (`imageControlsDisabled = busy || !appReady`); panel drops also early-return on `!appReady`. So on a no-WebGPU / failed-attach path the whole UI stays inert (the smoke asserts this).
- **`if (isCleanedUp) return` after every `await`** — each async step (attach, load, register, save) re-checks the flag before touching NiiVue/worker state, so a teardown mid-flight can't use a destroyed viewer.
- **`pagehide` bfcache guard** — the teardown listener early-returns on `e.persisted` (a bfcache freeze, not a real unload), so a back/forward-cached page isn't wrongly torn down; only a genuine unload (or HMR dispose) runs `cleanup()`.

### Concurrency — single-flight (gotcha)
Loads, drops, preset changes, and registration must not overlap: everything is serialized through one promise chain (`enqueue`/`pending`). Required because the niimath wrapper reassigns the worker's one `onmessage` handler per `run()`, so two overlapping `run()`s on the same `Niimath` instance cross-wire each other's results. One run at a time per instance.

### Worker recovery (gotcha)
A failed/OOM niimath run (WASM allocators bail via longjmp) can corrupt the worker heap + MEMFS. `register()` catches → `resetNiimathWorker()` (terminates the worker via `terminateNiimathWorker()` — one consolidated helper that casts to the wrapper's private `worker` field, since it exposes no public `terminate`; `cleanup()` reuses the same helper) → rethrows; the next registration spins up a fresh worker.

**`cleanup()` terminates the worker FIRST, then does NOT await `pending`.** A niimath `run()` is a single uninterruptible WASM call, so awaiting the queue on HMR/tab-close would stall teardown. `cleanup()` sets `isCleanedUp`, terminates the worker (killing the in-flight run — whose promise then never resolves, hence no await), then calls `disposeViewers()` — the one consolidated teardown that disposes each extension context and `destroyNv()`s (best-effort `nv.destroy()`) all three NiiVue instances; `init()`'s catch runs the same `disposeViewers()` on a failed WebGPU attach. Any run that *did* resolve hits `if (isCleanedUp) return` before touching NiiVue state.

### Presets & drops
Each panel's dropdown is populated from `MOVING_PRESETS` / `STATIONARY_PRESETS`, plus a hidden `(dropped)` entry that appears when a user supplies a file. `STATIONARY_PRESETS` is entirely local bundled templates (MNI152 1 mm default, SPM avg152 2 mm, MNI152_T1_ext). `MOVING_PRESETS` starts with the bundled `t1_crop` default and then streams sample images from the `niivue-demo-images` repo via `raw.githubusercontent.com` (CORS-enabled) using the `demo(path)` helper, whose label hides the repo's internal `register/` folder and the `.nii.gz` extension. Several demo images are 4D (pcasl/fmri/dwi/…); the vendored niimath auto-registers their first volume. `availableSelection` tracks the last choice whose bytes exist locally (a bundled/fetched preset or a dropped File); when a remote fetch fails before producing a File, the `<select>` reverts to that choice because the displayed input was never replaced. Drops are wired **per panel** (`wirePanelDrop`): the drop target determines the slot. A single obvious volume file loads straight into the slot; otherwise dcm2niix converts, and a multi-series result populates `#dicomPick` bound (`dcmSlot`) to the slot it was dropped on. `clearDcmSelection(slot)` centralizes tearing that picker down, but leaves it alone when only the *other* slot is replaced (so a still-relevant multi-series picker survives). The **ⓘ** button per panel shows `nv.volumes[0].hdr.toFormattedString()` (with a minimal fallback) in `#infoDialog`.

## niimath (the BSD build)

Registration runs a **BSD-2** build of niimath, so the whole app is BSD-2. EdgeReg uses the BSD `-allineate` and optional `-robustfov` operations.

**Vendored as local source, not an npm dependency.** The built BSD artifacts live in [src/niimath/](src/niimath/) and `main.ts` imports `{ Niimath } from './niimath'` — **there is no `@niivue/niimath` dependency** in `package.json`. `src/niimath/` holds the esbuild wrapper (`index.js`), the WASM worker (`worker.js`), and the Emscripten glue + binary (`niimath.js` + `niimath.wasm`), plus `.d.ts`/`niimathOperators.json`. Built from `rordenlab/niimath` commit `029f697` (branch `wasm`; "Add -allineate -fill and -weight; fix -dilate"), on top of `aeab04d` ("64-bit image support") — which adds 4D `-allineate` support in `src/coreFLT.c` (a 4D moving image registers its **first volume**, as an implicit `-crop 0 1`, with a warning). Provenance + rebuild recipe: [src/niimath/README.md](src/niimath/README.md).

**Wrapper source changes now live in `js/src/core.ts` (upstream niimath), NOT a post-build hand-edit — a rebuild reproduces them.** Two load-bearing tweaks: (1) `init()` rejects **and terminates** the worker on a structured `{type:'error'}` message received before `{type:'ready'}` instead of hanging forever (upstream previously only rejected on `worker.onerror`) — without it a pre-ready WASM fetch/instantiate failure would leave `ensureNiimath()` pending and the UI stuck busy; (2) `allineate()` takes an optional third `weight` File — an unused base-space region-weight capability EdgeReg does **not** pass (mask-weighted registration was removed as too unstable), kept only so a rebuild stays faithful to the niimath source. Because both live in `js/src/core.ts`, `bun run build` regenerates `index.js` with them — **no manual re-application needed** (see [src/niimath/README.md](src/niimath/README.md)).

**Delete `src/niimath/` and depend on `@niivue/niimath` once a release with the current `-allineate` build (`1.4.0`) publishes** — and only after confirming that release rejects pre-ready worker errors.

Because niimath is plain app source (not a node_module), Vite/Rollup emit its `new Worker(new URL('./worker.js', import.meta.url))` worker + `new URL('niimath.wasm', import.meta.url)` binary as hashed assets in both dev and build — so it needs **no `optimizeDeps.exclude`** entry (`@niivue/dcm2niix` still needs one).

**Package API (used in [src/main.ts](src/main.ts)):**
- **Primary-input staging is the wrapper's job.** Call `niimath.image(file)` directly. This BSD build's `run()` renames the primary input to `__nimi_<name>` in MEMFS so a source can't collide with a fixed output path.
- **File-operand ops.** `allineate(base, opts)` is the registration op (base = stationary/template); it takes trailing argv opts if needed.

## Deploy

Push to `main` builds + deploys to `gh-pages` (`.github/workflows/ghpages.yml`), served at the custom domain **https://www.edgereg.org/**. The domain is set by [public/CNAME](public/CNAME) (`www.edgereg.org`), which Vite copies into `dist/` so every force-pushed deploy re-asserts it; DNS is apex A-records → GitHub IPs plus a `www` CNAME → `rordenlab.github.io`. Because it serves at the domain **root**, `base: '/'` in [vite.config.ts](vite.config.ts) — still reference bundled assets through `import.meta.env.BASE_URL` (now `/`) so a future base change stays in one place. `@niivue/dcm2niix` is in `optimizeDeps.exclude` because Vite's prebundler breaks its dynamic-import WASM worker; don't remove that.

## Bundled assets

Static assets under `public/`, served, not bundled: [public/t1_crop.nii.gz](public/t1_crop.nii.gz) (default moving), and the three bundled templates [public/MNI152_T1_1mm.nii.gz](public/MNI152_T1_1mm.nii.gz) (default), [public/avg152T1.nii.gz](public/avg152T1.nii.gz) (SPM 2 mm), and `public/MNI152_T1_ext.nii.gz` (ICBM 152 extended).

## Save

The **Save** button above the resliced panel calls `nvResliced.saveVolume({ filename: 'resliced.nii.gz', volumeByIndex: 0 })` (NiiVue re-gzips; niimath ran `-gz 0`). The click handler runs `runSave` **through `enqueue()`**, so a Save is serialized against loads/registration on the one promise chain and can't race an input replacement that blanks `nvResliced` mid-serialize. The button is gated on `reslicedReady` (set only after a completed registration loads, cleared by `clearResliced()` before reprocessing) and `!busy` via `setControlsBusy()`; `runSave()` repeats only the readiness/cleanup guard at runtime. Together these keep a stale/partial output from ever downloading.

## Open issues & notes

- **Demo-image presets need the network.** The non-bundled presets stream from `raw.githubusercontent.com/niivue/niivue-demo-images`; they fail (status shows `Failed: fetch … failed`) offline. The two bundled defaults (t1_crop, MNI152_T1_1mm) are local. The smoke only exercises the bundled defaults, so it stays network-independent.
- **Smoke scope (deliberately wiring-only).** The smoke drives the default registration to completion and asserts the resliced panel populates + no `console.error`; it does not assert registration *quality* — that is niimath's to validate in its own regression data.
- **niimath worker init errors are handled in the wrapper source** — `js/src/core.ts` rejects
  structured `{type:'error'}` messages received before `{type:'ready'}` and terminates the
  failed worker. It is source-level (reproduced by `bun run build`), not a post-build patch, so
  refreshing the artifacts preserves it automatically; upstream it to `rordenlab/niimath` when convenient.
