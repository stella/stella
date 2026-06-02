/**
 * StarterKit — bundles all extensions into a ready-to-use set
 *
 * Usage:
 *   const extensions = createStarterKit();
 *   const manager = new ExtensionManager(extensions);
 *   manager.buildSchema();
 *   manager.initializeRuntime();
 */

import type { SelectionChangeCallback } from "../plugins/selectionTracker";
// Core
import { DocExtension } from "./core/DocExtension";
import { HistoryExtension } from "./core/HistoryExtension";
import { ParagraphExtension } from "./core/ParagraphExtension";
import { TextExtension } from "./core/TextExtension";
import { BaseKeymapExtension } from "./features/BaseKeymapExtension";
// oxlint-disable-next-line import/no-cycle
import { BidiShortcutExtension } from "./features/BidiShortcutExtension";
import { ContentControlWidgetsExtension } from "./features/ContentControlWidgetsExtension";
import { DropCursorExtension } from "./features/DropCursorExtension";
import { EmptyParagraphFormatExtension } from "./features/EmptyParagraphFormatExtension";
import { ImageDragExtension } from "./features/ImageDragExtension";
import { ImagePasteExtension } from "./features/ImagePasteExtension";
// Features
import { ListExtension } from "./features/ListExtension";
import { ParagraphChangeTrackerExtension } from "./features/ParagraphChangeTrackerExtension";
import { ParaIdAllocatorExtension } from "./features/ParaIdAllocatorExtension";
import { PasteStyleInlinerExtension } from "./features/PasteStyleInlinerExtension";
import { SelectionTrackerExtension } from "./features/SelectionTrackerExtension";
import { AllCapsExtension } from "./marks/AllCapsExtension";
// Marks
import { BoldExtension } from "./marks/BoldExtension";
import { CharacterSpacingExtension } from "./marks/CharacterSpacingExtension";
import { CommentExtension } from "./marks/CommentExtension";
import { FontFamilyExtension } from "./marks/FontFamilyExtension";
import { FontSizeExtension } from "./marks/FontSizeExtension";
import { FootnoteRefExtension } from "./marks/FootnoteRefExtension";
import { HiddenTextExtension } from "./marks/HiddenTextExtension";
import { HighlightExtension } from "./marks/HighlightExtension";
import { HyperlinkExtension } from "./marks/HyperlinkExtension";
import { ItalicExtension } from "./marks/ItalicExtension";
import { RtlExtension } from "./marks/RtlExtension";
import { RunFormattingOverrideExtension } from "./marks/RunFormattingOverrideExtension";
import { SmallCapsExtension } from "./marks/SmallCapsExtension";
import { StrikeExtension } from "./marks/StrikeExtension";
import { SubscriptExtension } from "./marks/SubscriptExtension";
import { SuperscriptExtension } from "./marks/SuperscriptExtension";
import { TextColorExtension } from "./marks/TextColorExtension";
import { TextEffectExtension } from "./marks/TextEffectExtension";
import {
  EmbossExtension,
  ImprintExtension,
  TextShadowExtension,
  EmphasisMarkExtension,
  TextOutlineExtension,
} from "./marks/TextEffectsExtensions";
import {
  InsertionExtension,
  DeletionExtension,
} from "./marks/TrackedChangeExtensions";
import { UnderlineExtension } from "./marks/UnderlineExtension";
import { BlockSdtExtension } from "./nodes/BlockSdtExtension";
import { FieldExtension } from "./nodes/FieldExtension";
// Nodes
import { HardBreakExtension } from "./nodes/HardBreakExtension";
import { HorizontalRuleExtension } from "./nodes/HorizontalRuleExtension";
import { ImageExtension } from "./nodes/ImageExtension";
import { MathExtension } from "./nodes/MathExtension";
import { PageBreakExtension } from "./nodes/PageBreakExtension";
import { SdtExtension } from "./nodes/SdtExtension";
import { ShapeExtension } from "./nodes/ShapeExtension";
import { TabExtension } from "./nodes/TabExtension";
import { createTableExtensions } from "./nodes/TableExtension";
import { TextBoxExtension } from "./nodes/TextBoxExtension";
import type { AnyExtension } from "./types";

export type StarterKitOptions = {
  /** Extensions to disable by name */
  disable?: string[];
  /** History depth (default: 100) */
  historyDepth?: number;
  /** History new group delay (default: 500) */
  historyNewGroupDelay?: number;
  /** Selection change callback */
  onSelectionChange?: SelectionChangeCallback;
};

/**
 * Create the full set of extensions for the DOCX editor
 */
export function createStarterKit(
  options: StarterKitOptions = {},
): AnyExtension[] {
  const disabled = options.disable
    ? new Set(options.disable)
    : new Set<string>();

  const extensions: AnyExtension[] = [];

  function add(name: string, ext: AnyExtension): void {
    if (!disabled.has(name)) {
      extensions.push(ext);
    }
  }

  // Core (always included unless explicitly disabled)
  add("doc", DocExtension());
  add("text", TextExtension());
  add("paragraph", ParagraphExtension());
  add(
    "history",
    HistoryExtension({
      ...(options.historyDepth !== undefined
        ? { depth: options.historyDepth }
        : {}),
      ...(options.historyNewGroupDelay !== undefined
        ? { newGroupDelay: options.historyNewGroupDelay }
        : {}),
    }),
  );

  // Marks
  add("bold", BoldExtension());
  add("italic", ItalicExtension());
  add("underline", UnderlineExtension());
  add("strike", StrikeExtension());
  add("textColor", TextColorExtension());
  add("highlight", HighlightExtension());
  add("fontSize", FontSizeExtension());
  add("fontFamily", FontFamilyExtension());
  add("superscript", SuperscriptExtension());
  add("subscript", SubscriptExtension());
  add("hyperlink", HyperlinkExtension());
  add("allCaps", AllCapsExtension());
  add("smallCaps", SmallCapsExtension());
  add("footnoteRef", FootnoteRefExtension());
  add("characterSpacing", CharacterSpacingExtension());
  add("emboss", EmbossExtension());
  add("imprint", ImprintExtension());
  add("hidden", HiddenTextExtension());
  add("textShadow", TextShadowExtension());
  add("emphasisMark", EmphasisMarkExtension());
  add("textOutline", TextOutlineExtension());
  add("rtl", RtlExtension());
  add("textEffect", TextEffectExtension());
  add("runFormattingOverride", RunFormattingOverrideExtension());
  add("comment", CommentExtension());
  add("insertion", InsertionExtension());
  add("deletion", DeletionExtension());

  // Nodes
  add("hardBreak", HardBreakExtension());
  add("tab", TabExtension());
  add("image", ImageExtension());
  add("textBox", TextBoxExtension());
  add("shape", ShapeExtension());
  add("imageDrag", ImageDragExtension());
  add("imagePaste", ImagePasteExtension());
  add("dropCursor", DropCursorExtension());
  add("horizontalRule", HorizontalRuleExtension());
  add("pageBreak", PageBreakExtension());
  add("field", FieldExtension());
  add("sdt", SdtExtension());
  add("blockSdt", BlockSdtExtension());
  add("math", MathExtension());

  // Table (5 extensions grouped)
  if (!disabled.has("table")) {
    extensions.push(...createTableExtensions());
  }

  // Features
  add("pasteStyleInliner", PasteStyleInlinerExtension());
  add("list", ListExtension());
  add("baseKeymap", BaseKeymapExtension());
  add("emptyParagraphFormat", EmptyParagraphFormatExtension());
  add(
    "selectionTracker",
    options.onSelectionChange === undefined
      ? SelectionTrackerExtension()
      : SelectionTrackerExtension({
          onSelectionChange: options.onSelectionChange,
        }),
  );
  // Register the paraId allocator BEFORE the change tracker so any
  // freshly-allocated id is already on the paragraph when the tracker
  // records it as changed. The plugin sets `addToHistory: false` so
  // undo/redo doesn't trip on the allocation.
  add("paraIdAllocator", ParaIdAllocatorExtension());
  add("paragraphChangeTracker", ParagraphChangeTrackerExtension());
  add("bidiShortcut", BidiShortcutExtension());
  add("contentControlWidgets", ContentControlWidgetsExtension());

  return extensions;
}
