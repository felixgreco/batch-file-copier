/**
 * Public entry point for the batch-file-copier library.
 *
 * Re-exports the surface area so consumers import from a single path:
 *
 *   import { copyBatch, copyFile } from "batch-file-copier";
 */
export { copyBatch, copyFile } from "./core.js";
