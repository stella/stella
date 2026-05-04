/**
 * Server-only entry for `@stll/folio`.
 *
 * Pure TYPE re-exports so server callers (the AI extraction
 * workflow, batch jobs) can share the chat editor's data shape
 * without importing the editor's DOM-dependent code. Runtime
 * exports stay on the main `@stll/folio` entry, which carries the
 * editor components' DOM globals through the type checker.
 *
 * If a server caller needs to PRODUCE folio blocks from raw bytes,
 * implement that against the same types here — don't reach into
 * the editor entry from a Node/Bun process.
 */
export type {
  FolioAIBlock,
  FolioAIBlockAnchor,
  FolioAIBlockKind,
  FolioAIBlockPreviewRun,
  FolioAIEditSnapshot,
} from "./core/ai-edits/types";
