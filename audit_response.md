# Audit response — EdgeReg (2026-07-15, round 4)

Responds to the external `audit_temp.md` (round 4). That review found no defect and changed
no application code; this developer-side pass independently re-verified the current tree and
concurs. **Deployable.** No code changes this round.

## Verification this round

A fresh independent verification agent + `npm run test:e2e` + `npm run typecheck`/`build`
confirmed the round-3 simplifications hold with no regression:
- **`register()` redundant `reslicedReady=false` removed** — PASS. Both callers (`loadSlot`,
  `reregister`) run `clearResliced()` first; `init` reaches `register` only via `loadSlot`, so
  `reslicedReady` is always false on entry and true only after the resliced load succeeds.
  Save-privacy invariant intact.
- **`runSave` guard reduced to `isCleanedUp || !reslicedReady`** — PASS. `reslicedReady===true`
  cannot coexist with an empty `nvResliced` inside the serial queue; the dropped
  `volumes.length===0` was redundant.
- **`loadedSelection`→`availableSelection`** — PASS. Label-only; restores the `<select>` solely
  when a remote fetch produces no File. A local drop/DICOM keeps its attempted label on a load
  failure (deliberate — the file is local and the failure status explains it). The fail-closed
  `movingFile`/`stationaryFile` nulling on load failure is independent and still holds.

Fresh-eyes pass: no memory/resource leak, unhandled rejection, missing await, use-after-destroy,
or privacy hole. Only network egress remains the local `BASE` assets + the deliberate
`raw.githubusercontent.com` demo fetches; Save is a local `saveVolume` download.

## Withdrawn from the prior round

- **Cold-start fetch overlap (my round-2 perf suggestion) — dropped.** The round-4 review
  correctly noted that starting the two default-image fetches before `await attachAll()` would
  pull ~14 MB (bundled 1 mm template + default moving) before a possible WebGPU-attach failure,
  on exactly the low-capability browsers most likely to fail attach. The current order (attach,
  then fetch) is the right trade. No change.

## Disposition of round-4 residual points

| # | Point | Disposition |
|---|---|---|
| 1 | `HEAD` contains only `LICENSE`; whole app untracked — confirm before first commit | **Accept.** User to stage the intended tree before the first real commit. |
| 2 | Multi-series DICOM is a manual browser check on dcm2niix upgrades; smoke doesn't synthesize a DICOM dir | **Accept.** Deliberate scope; the init-timeout covers the known hang mode. |
| 3 | Mirror the corrected `index.d.ts` BSD/allineate banner into the external niimath source before next rebuild | **Accept.** Noted for the niimath repo (`js/src/core.ts`). |
| 4 | ~1.046 MB NiiVue/WebGPU entry bundle | **Accept / ignore.** No dynamic-import/manualChunks without a measured startup problem. |
| 5 | Remote moving demos need `raw.githubusercontent.com`; bundled defaults + smoke stay local | **Accept.** |
| 6 | GitHub Pages builds but doesn't run the WebGPU smoke | **Accept / ignore.** Keep running `npm run test:e2e` locally before release. |

Round-4 "deliberately unchanged" items (no speculative fetch overlap, no dynamic imports, no
extra state/harness/split, harmless direct `gl-matrix` dep) — all concurred.

## Persistent notes for the next session

- **niimath** is vendored & rebuilt from `029f697` (branch `wasm`, on top of aeab04d's 64-bit /
  4D-first-volume `-allineate`). Wrapper source changes (structured-init-error reject; an unused
  optional `allineate()` weight param — the weighted-mask feature was removed as unstable) live in
  `js/src/core.ts`, reproduced by rebuild (see `src/niimath/README.md`).
- **Validate before commit:** `npm run typecheck && npm run build && npm run test:e2e`
  (system Chrome + software WebGPU). GitHub Pages builds but does **not** run the smoke.
- **Repo:** initial commit predates the EdgeReg pivot; stage the whole tree before the first real
  commit. App repo is `github.com/rordenlab/EdgeReg`.

_Validated: `npm run typecheck`, `npm run build`, `npm run test:e2e` all pass — three panels
attach, default + replacement registration, Robust FOV invalidate/refresh, Save download, view
switching, header dialog, yoked mm readout, unsupported-WebGPU-inert all green, no console/page
errors._
