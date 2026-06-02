/**
 * Headless API for working with block-level content controls.
 *
 * Pure functions over the `Document` model. Use these directly for
 * automation, AI-driven template filling, or to read the document outside
 * a mounted editor. The ProseMirror editor-ref methods (commit 8) wrap
 * these helpers with transactions so writes are undoable.
 */

export { ContentControlLockedError, ContentControlTypeError } from "./errors";
export type {
  ContentControlFilter,
  ContentControlMatch,
} from "./findContentControls";
export {
  findContentControl,
  findContentControls,
  getContentControlText,
} from "./findContentControls";
export type {
  SetContentControlContentInput,
  SetContentControlValueInput,
} from "./mutateContentControls";
export {
  removeContentControl,
  setContentControlContent,
  setContentControlValue,
} from "./mutateContentControls";
