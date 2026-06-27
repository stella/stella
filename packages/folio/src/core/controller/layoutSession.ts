import type { EditorState } from "prosemirror-state";

import type { FlowBlock, Measure } from "../layout-engine/types";
import type {
  TemplatePreviewEntry,
  TemplatePreviewValues,
} from "../prosemirror/plugins/templatePreviewValues";

export type LayoutArtifacts = {
  blocks: FlowBlock[];
  blockWidths: number[];
  measures: Measure[];
};

export type LayoutTemplatePreview = {
  entries: readonly TemplatePreviewEntry[];
  mode: TemplatePreviewValues["mode"];
};

// Controller-owned memory for the incremental layout loop: the previous run's
// artifacts and the inputs that produced them, so a relayout can decide whether
// it can reuse work or must recompute.
export type LayoutSession = {
  artifacts: LayoutArtifacts | null;
  lastEditorState: EditorState | null;
  lastPmDoc: EditorState["doc"] | null;
  usedLoadedFonts: boolean;
  lastTemplatePreview: LayoutTemplatePreview;
};

export const createLayoutSession = (): LayoutSession => ({
  artifacts: null,
  lastEditorState: null,
  lastPmDoc: null,
  usedLoadedFonts: false,
  lastTemplatePreview: { entries: [], mode: "plain" },
});
