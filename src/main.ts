/**
 * EdgeReg — rigid/affine MRI registration, entirely in the browser. No data
 * leaves the machine.
 *
 * Three NiiVue panels, left to right: the MOVING image, the STATIONARY template,
 * and the RESLICED moving image. Registration is automatic — whenever the moving
 * or stationary image changes, niimath's affine `-allineate` engine computes the
 * moving→stationary transform and reslices the moving image into template space,
 * equivalent to the command line:
 *
 *     niimath moving -allineate template -gz 0 resliced
 *
 * The middle (stationary) and right (resliced) panels are synced bidirectionally
 * so moving the crosshair in one moves it in the other. The left (moving) panel is
 * in native space and is not synced. All niimath I/O is uncompressed (`-gz 0`) for
 * speed. Related sibling tool: `deface` (facial anonymization) lives separately.
 */

import NiiVueGPU, {
  type ImageFromUrlOptions,
  MULTIPLANAR_TYPE,
  SHOW_RENDER,
  SLICE_TYPE,
} from '@niivue/niivue'
import { runDcm2niix, traverseDataTransferItems } from './dcm2niix/index'
import { Niimath } from './niimath'

const BASE = import.meta.env.BASE_URL

// Predefined images offered in each panel's dropdown. The first entry of each is a
// bundled local default; the rest are streamed from the niivue-demo-images repo.
type Preset = { value: string; label: string; url: string; name: string }

// Remote demo images (niivue-demo-images, CORS-enabled via raw.githubusercontent).
// The label hides the internal `register/` folder + the .nii.gz extension; `name`
// keeps the basename (with extension) for niimath's MEMFS + the panel title. Several
// of these are 4D (pcasl, fmri, fmri_pitch, dwi) — the vendored niimath registers
// their first volume automatically (see src/niimath/README.md).
const DEMO_BASE = 'https://raw.githubusercontent.com/niivue/niivue-demo-images/main/'
function demo(path: string): Preset {
  const name = path.split('/').pop()!
  return { value: `demo:${path}`, label: name.replace(/\.nii(\.gz)?$/i, ''), url: DEMO_BASE + path, name }
}

const MOVING_PRESETS: Preset[] = [
  { value: 't1_crop', label: 'T1 crop (default)', url: `${BASE}t1_crop.nii.gz`, name: 't1_crop.nii.gz' },
  ...[
    'CT_Philips.nii.gz',
    'fmri_pitch.nii.gz',
    'pcasl.nii.gz',
    // (no chris_t1 — it is the same scan as the bundled t1_crop default)
    'chris_t2.nii.gz',
    'chris_PD.nii.gz',
    'register/T1_head.nii.gz',
    'register/fmri.nii.gz',
    'register/T1_head_ext.nii.gz',
    'register/T2w.nii.gz',
    'register/FLAIR_2D.nii.gz',
    'register/T1_ds000031.nii.gz',
    'register/dwi.nii.gz',
  ].map(demo),
]
const STATIONARY_PRESETS: Preset[] = [
  { value: 'mni1mm', label: 'MNI152 T1 1mm (default)', url: `${BASE}MNI152_T1_1mm.nii.gz`, name: 'MNI152_T1_1mm.nii.gz' },
  { value: 'avg152', label: 'SPM avg152 T1 2mm', url: `${BASE}avg152T1.nii.gz`, name: 'avg152T1.nii.gz' },
  { value: 'mni_ext', label: 'MNI152 T1 ext (ICBM 152 extended)', url: `${BASE}MNI152_T1_ext.nii.gz`, name: 'MNI152_T1_ext.nii.gz' },
]

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`Element #${id} not found`)
  return el as T
}

// --- DOM handles ---
const locationEl = $('location')
const loadingCircle = $('loadingCircle')
const statusMsg = $<HTMLLabelElement>('statusMsg')
const sliceTypeSelect = $<HTMLSelectElement>('sliceType')
const robustfovCheck = $<HTMLInputElement>('robustfovCheck')
const movingSelect = $<HTMLSelectElement>('movingSelect')
const stationarySelect = $<HTMLSelectElement>('stationarySelect')
const aboutBtn = $<HTMLButtonElement>('aboutBtn')
const saveBtn = $<HTMLButtonElement>('saveBtn')
const aboutDialog = $<HTMLDialogElement>('aboutDialog')
const infoDialog = $<HTMLDialogElement>('infoDialog')
const infoTitle = $('infoTitle')
const infoText = $('infoText')
const dicomPick = $<HTMLSelectElement>('dicomPick')

// --- NiiVue setup ---
// One NiiVue instance per panel. The constructor is GPU-free; attachTo() acquires
// the WebGPU device and throws on a browser without it — so construct here but
// defer attach to init(), AFTER the navigator.gpu guard, or a no-WebGPU browser
// gets an unhandled top-level rejection instead of a friendly message.
type Nv = InstanceType<typeof NiiVueGPU>
type ExtCtx = ReturnType<Nv['createExtensionContext']>
function makeNv(): Nv {
  return new NiiVueGPU({ isDragDropEnabled: false, backgroundColor: [0, 0, 0, 1] })
}
const nvMoving = makeNv()
const nvStationary = makeNv()
const nvResliced = makeNv()
const contexts: ExtCtx[] = []

function destroyNv(nv: Nv): void {
  try {
    nv.destroy()
  } catch {
    // best-effort cleanup
  }
}

function disposeViewers(): void {
  for (const ctx of contexts.splice(0)) {
    try {
      ctx.dispose()
    } catch {
      // best-effort cleanup
    }
  }
  for (const nv of [nvMoving, nvStationary, nvResliced]) destroyNv(nv)
}

// The subset of NiiVue's locationChange detail this app reads. Structurally
// compatible with NiiVueLocation (extra fields ignored); `values[i].value` is the
// intensity of that instance's i-th volume at the crosshair (one volume per panel).
type LocInfo = { mm: number[]; values: { value: number }[] }

async function configureNv(nv: Nv, canvasId: string, onLoc: (d: LocInfo) => void): Promise<void> {
  await nv.attachTo(canvasId)
  if (isCleanedUp) {
    // attachTo() may finish after HMR cleanup destroyed its partially built view.
    destroyNv(nv)
    return
  }
  nv.multiplanarType = MULTIPLANAR_TYPE.GRID
  nv.sliceType = SLICE_TYPE.MULTIPLANAR
  nv.showRender = SHOW_RENDER.ALWAYS
  nv.crosshairGap = 5
  nv.isLegendVisible = false
  // A small fixed X-ray makes the 3D crosshair show THROUGH the opaque volume
  // render, so the focus point is visible inside the head (cf. tract.trk example's
  // meshXRay slider). 0.08 reveals the crosshair without washing out the surface.
  // is3DCrosshairVisible guarantees the crosshair is drawn in 3D.
  nv.is3DCrosshairVisible = true
  nv.meshXRay = 0.08
  const ctx = nv.createExtensionContext()
  ctx.on('locationChange', (e) => onLoc(e.detail))
  contexts.push(ctx)
}

// --- Crosshair readout (white text, right of the permanent drag hint) ---
function fmtIntensity(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return Number.isInteger(v) ? String(v) : v.toPrecision(4)
}

// World location: mm from the image origin, rounded to the nearest mm. This app is
// tuned for human brains, so integer mm is plenty — on the MNI templates 0×0×0 is
// ~the anterior commissure.
function fmtMm(mm: number[]): string {
  return mm.map((v) => Math.round(v)).join('×')
}

// The moving panel is in native space and independent — show only its intensity.
function onMovingLoc(d: LocInfo): void {
  locationEl.textContent = `${fmtMm(d.mm)} mm  Moving ${fmtIntensity(d.values[0]?.value ?? null)}`
}

// Template + resliced are yoked and share the template voxel grid (the moving image
// is resliced onto it). A crosshair move on EITHER fires two locationChange events —
// the direct one and the broadcast one — each carrying only its own instance's value,
// so relying on a single event shows the OTHER image's intensity. Instead, each panel
// stores its own value and both are rendered together, so moving on either shows both.
let yTemplate: number | null = null
let yResliced: number | null = null
let yMm: number[] = []
function renderYoked(): void {
  locationEl.textContent = `${fmtMm(yMm)} mm  Template ${fmtIntensity(yTemplate)}  ·  Resliced ${fmtIntensity(yResliced)}`
}
function onTemplateLoc(d: LocInfo): void {
  yTemplate = d.values[0]?.value ?? null
  yMm = d.mm
  renderYoked()
}
function onReslicedLoc(d: LocInfo): void {
  yResliced = d.values[0]?.value ?? null
  yMm = d.mm
  renderYoked()
}

async function attachAll(): Promise<void> {
  // Sequential attach (each acquires a WebGPU device); parallel occasionally races
  // device creation on some drivers, and this runs once at startup.
  await configureNv(nvMoving, 'glMoving', onMovingLoc)
  if (isCleanedUp) return
  await configureNv(nvStationary, 'glStationary', onTemplateLoc)
  if (isCleanedUp) return
  await configureNv(nvResliced, 'glResliced', onReslicedLoc)
  if (isCleanedUp) return
  // Bidirectional crosshair/orientation sync between the stationary template and the
  // resliced output — they share a world frame (the moving image is resliced onto the
  // template grid), so a crosshair in one is anatomically meaningful in the other. The
  // moving panel is in native space and stays independent.
  nvStationary.broadcastTo([nvResliced])
  nvResliced.broadcastTo([nvStationary])
}

// --- App state ---
let isCleanedUp = false
let appReady = false
let movingFile: File | null = null
let stationaryFile: File | null = null
// True once the resliced panel holds a completed registration. Save is gated on this
// (plus a runtime guard in runSave): cleared while re-registering so a stale/partial
// result can't be saved. Set only after the fresh resliced volume loads.
let reslicedReady = false

const niimath = new Niimath()
let niimathReady: Promise<void> | null = null
niimath.setOutputDataType('input') // preserve source datatype in the resliced output

const listeners = new AbortController()
const ac = { signal: listeners.signal }

// --- Status helpers ---
function setStatus(msg: string): void {
  statusMsg.textContent = msg
  statusMsg.title = msg
  statusMsg.classList.toggle('hidden', msg === '')
}
function spin(on: boolean): void {
  // Toggle visibility (not display) so the spinner's box stays reserved and the
  // status bar height never changes — see .loading-circle in style.css.
  loadingCircle.style.visibility = on ? 'visible' : 'hidden'
}

// --- Serial task queue (loads / drops / registration must not overlap) ---
// Required because the niimath wrapper reassigns its worker's single onmessage
// handler per run(), so two overlapping runs cross-wire each other's results.
let pending: Promise<unknown> = Promise.resolve()
let inFlightCount = 0
function isBusy(): boolean {
  return inFlightCount > 0
}
function setControlsBusy(busy: boolean): void {
  const imageControlsDisabled = busy || !appReady
  movingSelect.disabled = imageControlsDisabled
  stationarySelect.disabled = imageControlsDisabled
  sliceTypeSelect.disabled = imageControlsDisabled
  robustfovCheck.disabled = imageControlsDisabled
  dicomPick.disabled = imageControlsDisabled
  // Save is enabled only when idle AND a completed registration is displayed.
  saveBtn.disabled = busy || !reslicedReady
}
function enqueue(fn: () => Promise<unknown>): void {
  if (isCleanedUp) return
  inFlightCount++
  setControlsBusy(true)
  pending = pending
    .then(() => (isCleanedUp ? undefined : fn()))
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      setStatus(`Failed: ${msg}`)
      console.error('EdgeReg task failed', err)
    })
    .finally(() => {
      inFlightCount--
      if (!isBusy()) setControlsBusy(false)
    })
}

async function ensureNiimath(): Promise<void> {
  if (!niimathReady) niimathReady = niimath.init().then(() => undefined)
  await niimathReady
}

// The vendored wrapper exposes no public terminate; reach the private `worker` field.
// Confined to one place so a dep bump has a single cast to re-verify (see AGENTS.md).
function terminateNiimathWorker(): void {
  try {
    const w = niimath as unknown as { worker: Worker | null }
    w.worker?.terminate()
    w.worker = null
  } catch {
    // worker may already be gone
  }
}

// After a failed/aborted niimath run (incl. OOM, which the WASM allocators bail on
// via longjmp), the worker's WASM heap and MEMFS may be corrupt. Tear it down and
// clear niimathReady so the next run spins up a fresh worker.
function resetNiimathWorker(): void {
  terminateNiimathWorker()
  niimathReady = null
}

async function fetchFile(url: string, name: string): Promise<File> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch ${name} failed: ${res.status}`)
  return new File([await res.blob()], name)
}

// --- Load a slot's image + re-register ---
type Slot = 'moving' | 'stationary'

// Confine the awkward `as ImageFromUrlOptions` cast (a File is a valid `url`) to one spot.
const loadVolume = (nv: Nv, f: File) =>
  nv.loadVolumes([{ url: f, name: f.name } as ImageFromUrlOptions])

async function clearResliced(): Promise<void> {
  reslicedReady = false
  yResliced = null
  locationEl.textContent = ''
  await nvResliced.removeAllVolumes()
}

// Last selection whose bytes are available locally (bundled/fetched or dropped).
// Used only to undo a remote preset choice when its fetch never produced a File.
const availableSelection: Record<Slot, string> = {
  moving: MOVING_PRESETS[0].value,
  stationary: STATIONARY_PRESETS[0].value,
}

async function loadSlot(slot: Slot, file: File): Promise<void> {
  if (isCleanedUp) return
  // Once a replacement is requested, the old output no longer describes the UI.
  // Clear it up front so a bad source or failed registration cannot leave a stale
  // result visible or saveable alongside the new/blank input panel.
  await clearResliced()
  if (isCleanedUp) return
  const nv = slot === 'moving' ? nvMoving : nvStationary
  try {
    await loadVolume(nv, file)
  } catch (err) {
    // The load failed → the panel is blank/partial. Drop this slot's pristine source so a
    // later re-register (e.g. a Robust FOV toggle) can't target a stale source that diverges
    // from the now-blank display. register() then early-returns until a good image reloads.
    if (slot === 'moving') movingFile = null
    else stationaryFile = null
    throw err
  }
  if (isCleanedUp) return
  if (slot === 'moving') movingFile = file
  else stationaryFile = file
  await register()
}

// Re-registering without replacing a source (currently Robust FOV) invalidates
// the displayed output just like a source change does.
async function reregister(): Promise<void> {
  await clearResliced()
  if (isCleanedUp) return
  await register()
}

// --- Registration ---
// niimath moving [-robustfov] -allineate stationary -gz 0 reg → the moving image
// resliced into the stationary/template grid. Always runs on the pristine source files.
// The optional -robustfov crops the moving image's neck/inferior slices first (chained
// BEFORE -allineate) so the fit isn't pulled off by a large non-brain field of view.
async function register(): Promise<void> {
  if (isCleanedUp || !movingFile || !stationaryFile) return
  const useRobustfov = robustfovCheck.checked
  spin(true)
  setStatus(`Registering (allineate${useRobustfov ? ', robustfov' : ''})…`)
  const t0 = performance.now()
  try {
    await ensureNiimath()
    if (isCleanedUp) return
    const base = niimath.image(movingFile).gz(0)
    const chain = useRobustfov ? base.robustfov() : base
    const blob = await chain.allineate(stationaryFile).run('reg.nii')
    if (isCleanedUp) return
    await loadVolume(nvResliced, new File([blob], 'reg.nii'))
    if (isCleanedUp) return
    reslicedReady = true
    setStatus(`Registered (${Math.round(performance.now() - t0)} ms) — moving resliced into template space`)
  } catch (err) {
    // A failed/OOM run can corrupt the worker heap + MEMFS; recreate it so the next
    // registration starts clean. Rethrow so enqueue() still reports "Failed: …".
    resetNiimathWorker()
    throw err
  } finally {
    spin(false)
  }
}

// --- Save the resliced output ---
// Runs THROUGH enqueue() (see wiring) so it is serialized against loads/registrations —
// a Save can't race an input replacement that blanks nvResliced mid-serialize.
async function runSave(): Promise<void> {
  // Runtime guard, not just the disabled button: never save a stale/absent result, and
  // bail if teardown began. NiiVue re-gzips on Save (niimath ran -gz 0).
  if (isCleanedUp || !reslicedReady) return
  try {
    await nvResliced.saveVolume({ filename: 'resliced.nii.gz', volumeByIndex: 0 })
  } catch (err) {
    setStatus(`Save failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// --- DICOM / file drag-drop ---
// Each multi-series conversion is bound to the slot it was dropped on.
let dcmConverted: File[] = []
let dcmSlot: Slot = 'moving'
const DIRECT_VOLUME_RE = /\.(nii|nii\.gz|mgh|mgz|nrrd|mha|mhd|nhdr|head|v)$/i

function clearDcmSelection(slot?: Slot): void {
  // A picker for the other panel remains valid when only one slot is replaced.
  if (slot && dcmConverted.length > 0 && dcmSlot !== slot) return
  dcmConverted = []
  dicomPick.replaceChildren()
  dicomPick.classList.add('hidden')
}

async function handleDrop(slot: Slot, filesPromise: Promise<File[]>): Promise<void> {
  if (isCleanedUp) return
  spin(true)
  try {
    setStatus(`Reading dropped files (${slot})…`)
    const files = await filesPromise
    if (isCleanedUp) return
    clearDcmSelection(slot)
    if (files.length === 0) {
      setStatus('Drop contained no readable files.')
      return
    }
    // Fast-path a single obvious volume file straight to the slot.
    if (files.length === 1 && DIRECT_VOLUME_RE.test(files[0].name)) {
      markCustom(slot, files[0].name)
      setStatus(`Loading ${files[0].name} → ${slot}…`)
      await loadSlot(slot, files[0])
      return
    }
    setStatus(`Converting ${files.length} file(s) with dcm2niix…`)
    const t0 = performance.now()
    const niftiFiles = await runDcm2niix(files)
    if (isCleanedUp) return
    const ms = Math.round(performance.now() - t0)
    if (niftiFiles.length === 0) {
      setStatus('No NIfTI output produced. Are these DICOM images?')
      return
    }
    if (niftiFiles.length > 1) {
      dcmConverted = niftiFiles
      dcmSlot = slot
      dicomPick.replaceChildren()
      niftiFiles.forEach((f, i) => {
        const opt = document.createElement('option')
        opt.value = String(i)
        opt.text = f.name
        dicomPick.appendChild(opt)
      })
      dicomPick.value = '0'
      dicomPick.classList.remove('hidden')
      setStatus(`dcm2niix: ${niftiFiles.length} NIfTI in ${ms} ms — pick one for ${slot}.`)
    } else {
      setStatus(`dcm2niix: 1 NIfTI in ${ms} ms — loading → ${slot}…`)
    }
    markCustom(slot, niftiFiles[0].name)
    await loadSlot(slot, niftiFiles[0])
  } finally {
    spin(false)
  }
}

// --- Preset dropdowns ---
const CUSTOM_VALUE = '__custom'

function populateSelect(sel: HTMLSelectElement, presets: Preset[]): void {
  sel.replaceChildren()
  for (const p of presets) {
    const opt = document.createElement('option')
    opt.value = p.value
    opt.text = p.label
    sel.appendChild(opt)
  }
  // Hidden entry shown only after a file is dropped (so the picker reflects it).
  const custom = document.createElement('option')
  custom.value = CUSTOM_VALUE
  custom.hidden = true
  sel.appendChild(custom)
}

// Point a slot's dropdown at the "(dropped)" entry when a user-supplied file loads.
function markCustom(slot: Slot, name: string): void {
  const sel = slot === 'moving' ? movingSelect : stationarySelect
  const custom = sel.querySelector<HTMLOptionElement>(`option[value="${CUSTOM_VALUE}"]`)
  if (custom) custom.text = `(dropped) ${name}`
  sel.value = CUSTOM_VALUE
  availableSelection[slot] = CUSTOM_VALUE
}

async function onPresetChange(slot: Slot): Promise<void> {
  const sel = slot === 'moving' ? movingSelect : stationarySelect
  const presets = slot === 'moving' ? MOVING_PRESETS : STATIONARY_PRESETS
  const preset = presets.find((p) => p.value === sel.value)
  if (!preset) return // placeholder or custom — nothing to load
  spin(true) // parity with handleDrop: keep the spinner up across the remote fetch
  try {
    setStatus(`Loading ${preset.label} → ${slot}…`)
    let file: File
    try {
      file = await fetchFile(preset.url, preset.name)
    } catch (err) {
      // The displayed source is unchanged when fetching fails; keep its picker label.
      sel.value = availableSelection[slot]
      throw err
    }
    // Once fetch succeeds this is the selected local File, even if parsing or
    // registration later reports that the file is unusable.
    clearDcmSelection(slot)
    availableSelection[slot] = preset.value
    await loadSlot(slot, file)
  } finally {
    spin(false)
  }
}

// --- Header info dialog ---
function headerText(nv: Nv): string {
  const img = nv.volumes[0]
  if (!img) return '(no image loaded)'
  const hdr = img.hdr as unknown as { toFormattedString?: () => string }
  try {
    if (typeof hdr.toFormattedString === 'function') return `${img.name}\n\n${hdr.toFormattedString()}`
  } catch {
    // fall through to the minimal summary below
  }
  const dims = img.dims ? img.dims.join(' × ') : '?'
  const pix = img.pixDimsRAS ? img.pixDimsRAS.map((d) => d.toFixed(3)).join(' × ') : '?'
  return `${img.name}\n\ndims: ${dims}\npixdims (RAS, mm): ${pix}\nintensity: ${img.globalMin} … ${img.globalMax}`
}

function showHeader(nv: Nv, title: string): void {
  infoTitle.textContent = `${title} — header`
  infoText.textContent = headerText(nv)
  infoDialog.showModal()
}

// --- Per-panel drag-drop wiring ---
function wirePanelDrop(slot: Slot): void {
  const panel = document.querySelector<HTMLElement>(`.panel[data-slot="${slot}"]`)
  if (!panel) return
  panel.addEventListener('dragover', (e) => {
    e.preventDefault()
    panel.classList.add('dragover')
  }, ac)
  panel.addEventListener('dragleave', () => panel.classList.remove('dragover'), ac)
  panel.addEventListener('drop', (e) => {
    e.preventDefault()
    panel.classList.remove('dragover')
    if (!appReady) return
    const items = e.dataTransfer?.items
    if (!items || items.length === 0) return
    // A DataTransferItemList is only valid during this event; start traversal now.
    const filesPromise = traverseDataTransferItems(items)
    filesPromise.catch(() => {})
    enqueue(() => handleDrop(slot, filesPromise))
  }, ac)
}

// The resliced panel is output-only: swallow drops (don't let the page navigate).
function wireReslicedNoDrop(): void {
  const panel = document.querySelector<HTMLElement>('.panel[data-slot="resliced"]')
  if (!panel) return
  panel.addEventListener('dragover', (e) => e.preventDefault(), ac)
  panel.addEventListener('drop', (e) => {
    e.preventDefault()
    if (!appReady) return
    setStatus('The resliced panel is the registration output — drop onto Moving or Template.')
  }, ac)
}

// --- Init ---
async function init(): Promise<void> {
  const noWebGpu =
    'This browser/GPU can’t initialize WebGPU — EdgeReg needs a recent desktop Chrome, Edge, or Safari.'
  if (!navigator.gpu) {
    setStatus(noWebGpu)
    return
  }
  try {
    await attachAll()
  } catch (err) {
    disposeViewers()
    console.warn('EdgeReg: WebGPU init failed', err)
    setStatus(noWebGpu)
    return
  }
  if (isCleanedUp) return
  appReady = true
  setStatus('Loading default moving + template images…')
  const [moving, stationary] = await Promise.all([
    fetchFile(MOVING_PRESETS[0].url, MOVING_PRESETS[0].name),
    fetchFile(STATIONARY_PRESETS[0].url, STATIONARY_PRESETS[0].name),
  ])
  if (isCleanedUp) return
  // Load both slots; register() runs only once both are set — loadSlot('moving')
  // early-returns from register() with no template yet, so this registers exactly once.
  await loadSlot('moving', moving)
  if (isCleanedUp) return
  await loadSlot('stationary', stationary)
}

// --- Wiring ---
sliceTypeSelect.addEventListener('change', () => {
  const t = parseInt(sliceTypeSelect.value, 10)
  nvMoving.sliceType = t
  nvStationary.sliceType = t
  nvResliced.sliceType = t
}, ac)
movingSelect.addEventListener('change', () => enqueue(() => onPresetChange('moving')), ac)
stationarySelect.addEventListener('change', () => enqueue(() => onPresetChange('stationary')), ac)
// Toggling robustfov re-registers the pristine sources with/without the crop.
robustfovCheck.addEventListener('change', () => enqueue(reregister), ac)
dicomPick.addEventListener('change', () => {
  const file = dcmConverted[Number(dicomPick.value)]
  const slot = dcmSlot
  if (file) {
    markCustom(slot, file.name)
    enqueue(() => loadSlot(slot, file))
  }
}, ac)
aboutBtn.addEventListener('click', () => aboutDialog.showModal(), ac)
saveBtn.addEventListener('click', () => enqueue(runSave), ac)
$<HTMLButtonElement>('infoMoving').addEventListener('click', () => showHeader(nvMoving, 'Moving'), ac)
$<HTMLButtonElement>('infoStationary').addEventListener('click', () => showHeader(nvStationary, 'Template'), ac)
$<HTMLButtonElement>('infoResliced').addEventListener('click', () => showHeader(nvResliced, 'Resliced'), ac)
wirePanelDrop('moving')
wirePanelDrop('stationary')
wireReslicedNoDrop()

// --- Cleanup (HMR / tab close) ---
async function cleanup(): Promise<void> {
  if (isCleanedUp) return
  isCleanedUp = true
  appReady = false
  listeners.abort()
  clearDcmSelection()
  // Terminate the niimath worker FIRST (don't await `pending`): an in-flight run is
  // one uninterruptible WASM call. The terminated run never resolves, so we drop the
  // await; any run that already resolved hits `if (isCleanedUp) return` before use.
  terminateNiimathWorker()
  disposeViewers()
}
window.addEventListener('pagehide', (e) => {
  if (e.persisted) return
  void cleanup()
}, { signal: listeners.signal })
if (import.meta.hot) import.meta.hot.dispose(cleanup)

populateSelect(movingSelect, MOVING_PRESETS)
populateSelect(stationarySelect, STATIONARY_PRESETS)
enqueue(init)
