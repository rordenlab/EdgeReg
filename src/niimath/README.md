# Vendored niimath (BSD-only, unreleased allineate build)

These are the built artifacts of a **BSD-2-only** WASM build of niimath, vendored
directly into the app (not an npm dependency) and imported from `src/main.ts` as
`import { Niimath } from './niimath'`.

Vendored because this build carries the current affine `-allineate` engine and 4D
input support, which are **newer than the npm release** (`@niivue/niimath@1.3.2`).
**Delete this directory and depend on `@niivue/niimath` from npm once `1.4.0` publishes.**

## Files

- `index.js` / `index.d.ts` — the `Niimath` wrapper (esbuild bundle). `index.js` spawns
  `new Worker(new URL('./worker.js', import.meta.url))`; Vite/Rollup emit `worker.js`
  and `niimath.wasm` as hashed assets from these `new URL(..., import.meta.url)` sites.
- `worker.js` — the WASM worker; `import Module from './niimath.js'`.
- `niimath.js` / `niimath.wasm` — the Emscripten glue + BSD WASM (`niimath.js` locates
  `niimath.wasm` via `new URL('niimath.wasm', import.meta.url)`).
- `core.d.ts` / `types.d.ts` / `worker.d.ts` / `workerImpl.d.ts` / `niimathOperators.json`
  — types + operator table pulled in by the above.

## Provenance

- **Source repo:** `rordenlab/niimath` (local: `/Users/chris/src/niimath`, branch `wasm`)
- **Built from commit:** `029f697ef295eecd0633a7ba639a8cf9b429413d` ("Add -allineate -fill and
  -weight; fix -dilate"), on top of `aeab04d` (64-bit image support; 4D `-allineate`
  registers the moving image's **first volume**, as a preceding `-crop 0 1`, with a warning).
- **`-weight <img>`** (present in this build's engine + wrapper, but **NOT used by EdgeReg**):
  a base-space region-weight image for `-allineate` (fast engine only) that focuses the fit on
  a region. The `allineate()` wrapper accepts it as an optional third `File` arg, but EdgeReg's
  mask-weighted registration was removed as too unstable, so nothing passes it. Harmless dead
  capability; left in the wrapper so a future rebuild stays faithful to the niimath source.
- **Wrapper source changes (now in `js/src/core.ts`, not a post-build hand-edit):**
  (1) `init()` rejects a structured `{type:'error'}` received before readiness and terminates
  the failed worker (so a pre-ready WASM error can't hang the app queue); (2) `allineate()`
  takes an optional third `weight` File (unused by EdgeReg, see above). Because these live in
  the source, `bun run build` reproduces them — **no manual re-application needed** (upstream
  them to `rordenlab/niimath` when convenient).
- **License:** BSD-2-Clause. The GPL `spm_coreg`/`spm_deface` module is **not** built or
  shipped (no `index-gpl`/`niimath-gpl`/`worker-gpl`/`./gpl`).

## Rebuild recipe

```sh
cd /Users/chris/src/niimath/js
bun run makeWasm                                                 # BSD wasm → src/niimath.{js,wasm}
bun run scripts/pre-build.ts -i src/niimath.js -o src/niimath.js
bun run build                                                    # esbuild → dist/
# then copy the BSD dist files here:
cp dist/{index.js,index.d.ts,core.d.ts,types.d.ts,worker.js,worker.d.ts,\
workerImpl.d.ts,niimath.js,niimath.wasm,niimathOperators.json} <EdgeReg>/src/niimath/
```

A JS-wrapper-only change (e.g. `js/src/core.ts`) needs just `bun run build` — the `.wasm`
is unchanged, so `makeWasm` can be skipped.
