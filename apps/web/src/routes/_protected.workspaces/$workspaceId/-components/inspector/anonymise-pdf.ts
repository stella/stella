import { create } from "zustand";

import { DEFAULT_ENTITY_LABELS, runPipeline } from "@stella/anonymize";
import type { PipelineConfig } from "@stella/anonymize";

import { PDF_MIME_TYPE } from "@/consts";
import type { CharSpan, PdfBBox } from "@/lib/anonymize/pdf-coords";
import { extractPdfText, getEntityBBoxes } from "@/lib/anonymize/pdf-coords";
import { api } from "@/lib/api";

const buildPipelineConfig = (workspaceId: string): PipelineConfig => ({
  threshold: 0.4,
  enableTriggerPhrases: true,
  enableRegex: true,
  enableNameCorpus: true,
  enableGazetteer: false,
  enableNer: false,
  enableConfidenceBoost: false,
  enableCoreference: true,
  labels: [...DEFAULT_ENTITY_LABELS],
  workspaceId,
});

// ── Types ────────────────────────────────────────────

export type EntityOverlay = {
  id: number;
  label: string;
  text: string;
  bboxes: PdfBBox[];
};

type FileAnonymisation = {
  /** Flat list of all entities (for the sidebar). */
  entities: EntityOverlay[];
  /** Per-page overlay groups (for rendering). */
  perPage: Map<number, EntityOverlay[]>;
  /** Extracted text (for adding new entities by search). */
  extractedText: string;
  /** Character spans (for bbox lookup). */
  spans: CharSpan[];
};

// ── Store ────────────────────────────────────────────

let nextEntityId = 1;

type AnonymiseOverlayState = {
  files: Map<string, FileAnonymisation>;
  /** Convenience: per-page overlays for rendering. */
  overlays: Map<string, Map<number, EntityOverlay[]>>;

  setFile: (fieldId: string, data: FileAnonymisation) => void;
  clearFile: (fieldId: string) => void;
  hasOverlays: (fieldId: string) => boolean;

  removeEntity: (fieldId: string, entityId: number) => void;
  relabelEntity: (fieldId: string, entityId: number, newLabel: string) => void;
  /** Returns the number of matches found. */
  addEntityByText: (fieldId: string, text: string, label: string) => number;
};

/** Rebuild the per-page map from the flat entity list. */
const buildPerPage = (
  entities: EntityOverlay[],
): Map<number, EntityOverlay[]> => {
  const perPage = new Map<number, EntityOverlay[]>();
  for (const entity of entities) {
    const seenPages = new Set<number>();
    for (const bbox of entity.bboxes) {
      if (seenPages.has(bbox.pageIndex)) {
        continue;
      }
      seenPages.add(bbox.pageIndex);
      const list = perPage.get(bbox.pageIndex) ?? [];
      list.push(entity);
      perPage.set(bbox.pageIndex, list);
    }
  }
  return perPage;
};

export const useAnonymiseOverlayStore = create<AnonymiseOverlayState>(
  (set, get) => ({
    files: new Map(),
    overlays: new Map(),

    setFile: (fieldId, data) =>
      set((state) => {
        const files = new Map(state.files);
        files.set(fieldId, data);
        const overlays = new Map(state.overlays);
        overlays.set(fieldId, data.perPage);
        return { files, overlays };
      }),

    clearFile: (fieldId) =>
      set((state) => {
        const files = new Map(state.files);
        files.delete(fieldId);
        const overlays = new Map(state.overlays);
        overlays.delete(fieldId);
        return { files, overlays };
      }),

    hasOverlays: (fieldId) => get().overlays.has(fieldId),

    removeEntity: (fieldId, entityId) =>
      set((state) => {
        const file = state.files.get(fieldId);
        if (!file) {
          return state;
        }
        const entities = file.entities.filter((e) => e.id !== entityId);
        const perPage = buildPerPage(entities);
        const updated: FileAnonymisation = {
          ...file,
          entities,
          perPage,
        };
        const files = new Map(state.files);
        files.set(fieldId, updated);
        const overlays = new Map(state.overlays);
        overlays.set(fieldId, perPage);
        return { files, overlays };
      }),

    relabelEntity: (fieldId, entityId, newLabel) =>
      set((state) => {
        const file = state.files.get(fieldId);
        if (!file) {
          return state;
        }
        const entities = file.entities.map((e) =>
          e.id === entityId ? { ...e, label: newLabel } : e,
        );
        const perPage = buildPerPage(entities);
        const updated: FileAnonymisation = {
          ...file,
          entities,
          perPage,
        };
        const files = new Map(state.files);
        files.set(fieldId, updated);
        const overlays = new Map(state.overlays);
        overlays.set(fieldId, perPage);
        return { files, overlays };
      }),

    addEntityByText: (fieldId, searchText, label) => {
      const file = get().files.get(fieldId);
      if (!file) {
        return 0;
      }

      // Find all occurrences of searchText in the
      // extracted text (case-insensitive). Use a regex on
      // the original string to avoid index shifts from
      // toLowerCase() changing string length for certain
      // Unicode characters (e.g. Turkish İ).
      const escaped = searchText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(escaped, "gi");
      const newEntities: EntityOverlay[] = [];
      let match: RegExpExecArray | null;

      while ((match = regex.exec(file.extractedText)) !== null) {
        const idx = match.index;
        const matchLen = match[0].length;

        const bboxes = getEntityBBoxes(file.spans, idx, idx + matchLen);
        if (bboxes.length > 0) {
          newEntities.push({
            id: nextEntityId++,
            label,
            text: file.extractedText.slice(idx, idx + matchLen),
            bboxes,
          });
        }
      }

      if (newEntities.length === 0) {
        return 0;
      }

      set((state) => {
        const currentFile = state.files.get(fieldId);
        if (!currentFile) {
          return state;
        }
        const entities = [...currentFile.entities, ...newEntities];
        const perPage = buildPerPage(entities);
        const updated: FileAnonymisation = {
          ...currentFile,
          entities,
          perPage,
        };
        const files = new Map(state.files);
        files.set(fieldId, updated);
        const overlays = new Map(state.overlays);
        overlays.set(fieldId, perPage);
        return { files, overlays };
      });

      return newEntities.length;
    },
  }),
);

// ── Pipeline runner ──────────────────────────────────

/**
 * Run the anonymisation pipeline on a file and store
 * the entity bounding boxes as overlays. The original
 * PDF stays untouched; coloured rectangles are drawn
 * on top via CSS.
 */
const cancelledFieldIds = new Set<string>();

export const anonymisePdf = async ({
  workspaceId,
  fieldId,
  mimeType,
}: {
  workspaceId: string;
  fieldId: string;
  mimeType: string | null;
}): Promise<void> => {
  cancelledFieldIds.delete(fieldId);
  const isPdf = mimeType === PDF_MIME_TYPE;

  const response = await api
    .files({ workspaceId })
    .url({ fieldId })
    .get({
      query: { purpose: isPdf ? "download" : "display" },
    });

  if (response.error) {
    throw new Error("Failed to get file URL");
  }

  const s3Response = await fetch(response.data.presignedUrl);
  if (!s3Response.ok) {
    throw new Error("Failed to fetch file from storage");
  }

  const buffer = await s3Response.arrayBuffer();
  const pdfBytes = new Uint8Array(buffer);

  // Extract text + spans
  const { getDocument, GlobalWorkerOptions } = await import("pdfjs-dist");
  if (!GlobalWorkerOptions.workerSrc) {
    GlobalWorkerOptions.workerSrc = import.meta.env.DEV
      ? "/pdf.worker.min.mjs"
      : (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  }

  const pdf = await getDocument({
    data: pdfBytes.slice(),
  }).promise;
  let text: string;
  let spans: CharSpan[];
  try {
    const result = await extractPdfText(pdf);
    text = result.text;
    spans = result.spans;
  } finally {
    await pdf.destroy();
  }

  // Run pipeline
  const entities = await runPipeline(
    text,
    buildPipelineConfig(workspaceId),
    [],
    null,
  );

  // Build entity overlays with IDs
  const overlayEntities: EntityOverlay[] = [];

  for (const entity of entities) {
    const bboxes = getEntityBBoxes(spans, entity.start, entity.end);
    if (bboxes.length === 0) {
      continue;
    }
    overlayEntities.push({
      id: nextEntityId++,
      label: entity.label,
      text: entity.text,
      bboxes,
    });
  }

  // If the tab was closed while the pipeline was running,
  // discard results to avoid orphaned store entries.
  if (cancelledFieldIds.has(fieldId)) {
    cancelledFieldIds.delete(fieldId);
    return;
  }

  const perPage = buildPerPage(overlayEntities);

  useAnonymiseOverlayStore.getState().setFile(fieldId, {
    entities: overlayEntities,
    perPage,
    extractedText: text,
    spans,
  });
};

/**
 * Clear anonymisation overlays for a file.
 */
export const clearAnonymisation = (fieldId: string): void => {
  cancelledFieldIds.add(fieldId);
  useAnonymiseOverlayStore.getState().clearFile(fieldId);
};
