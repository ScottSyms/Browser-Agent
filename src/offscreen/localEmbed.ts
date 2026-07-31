// =============================================================================
// On-device embeddings — runs a small transformers.js feature-extraction model
// inside the offscreen document (which has the DOM/WASM context the service
// worker lacks). Inference is always local; the model weights are fetched once
// from the Hugging Face CDN and then served from the browser cache, OR loaded
// from bundled extension assets when present (see `preferBundledModels`). This
// keeps the local-RAG path off the configured /embeddings endpoint entirely.
// =============================================================================

import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { batchArray } from '../shared/repoChunk';
import { DEFAULT_LOCAL_EMBED_MODEL } from '../shared/types';

/** Default model: 384-d, ~23 MB int8, strong quality/size tradeoff for RAG. */
export const DEFAULT_LOCAL_MODEL = DEFAULT_LOCAL_EMBED_MODEL;

/**
 * Chunks embedded per inference call. The single-threaded WASM runtime holds the
 * whole batch's activation tensors in memory at once, so feeding a large document
 * (dozens/hundreds of chunks — common for PDFs and Markdown) in one call exhausts
 * memory and fails the ingest. Small batches keep each inference bounded;
 * background indexing isn't latency-sensitive, so the extra calls are fine.
 */
const EMBED_BATCH = 8;

// Model weights download once then browser-cache (inference always stays
// on-device); if files are bundled under web-accessible `models/`, those are
// preferred (fully offline). The ONNX Runtime wasm is always served from the
// extension-local `ort/` dir (bundled at build time) so it never hits a CDN.
function configureRuntime(): void {
  try {
    env.localModelPath = chrome.runtime.getURL('models/');
    env.allowLocalModels = true;
    const wasm = env.backends?.onnx?.wasm;
    if (wasm) {
      wasm.wasmPaths = chrome.runtime.getURL('ort/');
      // Stability over speed: a single-threaded, non-proxied CPU runtime. ORT's
      // threaded/proxy worker spin-up (and WebGPU init) inside the offscreen
      // document can trip a Chrome browser-process crash; this keeps embedding
      // on one synchronous wasm path. Folder indexing is a background batch, so
      // the slower throughput is acceptable.
      wasm.numThreads = 1;
      wasm.proxy = false;
    }
  } catch {
    // Not in an extension context (tests) — leave defaults.
  }
  env.allowRemoteModels = true; // fall back to the HF CDN for weights if not bundled
  env.useBrowserCache = true;
}

// The `pipeline` overload set is huge; narrow it to the one signature we use so
// TypeScript doesn't choke building the full task union (TS2590).
const featureExtraction = pipeline as unknown as (
  task: 'feature-extraction',
  model: string,
  options?: { device?: string },
) => Promise<FeatureExtractionPipeline>;

let pipePromise: Promise<FeatureExtractionPipeline> | null = null;
let pipeModel = '';

async function getPipeline(model: string): Promise<FeatureExtractionPipeline> {
  if (pipePromise && pipeModel === model) return pipePromise;
  configureRuntime();
  pipeModel = model;
  // device:'wasm' pins CPU execution — no WebGPU adapter init, another browser-
  // process crash vector avoided.
  const p = featureExtraction('feature-extraction', model, { device: 'wasm' });
  pipePromise = p;
  // Don't let a failed load poison the cache for the rest of the session: if the
  // model/runtime fails to initialize, clear the cached promise so the next call
  // rebuilds from scratch instead of re-awaiting the same rejected promise.
  p.catch(() => {
    if (pipePromise === p) {
      pipePromise = null;
      pipeModel = '';
    }
  });
  return p;
}

/**
 * Embed each input string into a mean-pooled, L2-normalized vector. Returns one
 * row per input, aligned by index. Throws on model/runtime failure so the caller
 * can surface a clear error (and optionally fall back to the external embedder).
 */
export async function embedTextsLocal(
  texts: string[],
  model: string = DEFAULT_LOCAL_MODEL,
): Promise<{ vectors: number[][]; model: string }> {
  if (texts.length === 0) return { vectors: [], model };
  const extractor = await getPipeline(model);
  const vectors: number[][] = [];
  for (const batch of batchArray(texts, EMBED_BATCH)) {
    // A tokenizer can't embed an empty string — swap in a single space so the
    // row count stays aligned with the input chunks.
    const safe = batch.map((t) => (t && t.trim() ? t : ' '));
    const out = await extractor(safe, { pooling: 'mean', normalize: true });
    // `out` is a 2-D Tensor [n, dim]; tolist() gives number[][].
    const rows = out.tolist() as number[][];
    if (rows.length !== safe.length) {
      throw new Error(`Local embedder returned ${rows.length} vectors for ${safe.length} inputs.`);
    }
    for (const r of rows) vectors.push(r);
  }
  if (vectors.length !== texts.length) {
    throw new Error(`Local embedder returned ${vectors.length} vectors for ${texts.length} inputs.`);
  }
  return { vectors, model };
}
