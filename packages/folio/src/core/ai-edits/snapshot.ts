import type { Node as PMNode } from "prosemirror-model";

import { buildCleanBlockText } from "./clean-text";
import type {
  FolioAIBlock,
  FolioAIBlockAnchor,
  FolioAIBlockKind,
  FolioAIEditSnapshot,
} from "./types";

export const normalizeFolioAIBlockText = (text: string): string =>
  text.replace(/\s+/g, " ").trim();

export const hashFolioAIBlockText = (text: string): string => {
  let hash = 5381;
  for (const character of text) {
    hash = (hash * 33 + (character.codePointAt(0) ?? 0)) % 2_147_483_647;
  }
  return `h${hash.toString(36)}`;
};

export const createFolioAIEditSnapshot = (doc: PMNode): FolioAIEditSnapshot => {
  const draftBlocks: {
    block: FolioAIBlock;
    anchor: Omit<FolioAIBlockAnchor, "hashOccurrenceCount">;
  }[] = [];
  const hashCounts = new Map<string, number>();

  let blockIndex = 0;
  doc.descendants((node, pos) => {
    if (!node.isTextblock) {
      return;
    }

    // Snapshot the AI-facing text in its post-tracked-changes
    // form: existing deletion-marked runs are skipped, existing
    // insertion-marked runs are included as plain text. The model
    // would otherwise see "shallmust" smashed together in a block
    // mid-edit and write find/replace operations against that
    // confused string. Apply uses the same clean view to resolve
    // operation positions, so the offsets stay consistent.
    const { text } = buildCleanBlockText(node, pos);
    const normalizedText = normalizeFolioAIBlockText(text);
    if (normalizedText.length === 0) {
      return;
    }

    const textHash = hashFolioAIBlockText(normalizedText);
    hashCounts.set(textHash, (hashCounts.get(textHash) ?? 0) + 1);

    const id = `b-${String(++blockIndex).padStart(4, "0")}`;
    const kind = getBlockKind(node);
    const displayLabel = getDisplayLabel(node);

    draftBlocks.push({
      block: {
        id,
        kind,
        text,
        ...(displayLabel !== undefined && { displayLabel }),
      },
      anchor: {
        id,
        from: pos,
        to: pos + node.nodeSize,
        text,
        normalizedText,
        textHash,
      },
    });
  });

  const blocks: FolioAIBlock[] = [];
  const anchors: Record<string, FolioAIBlockAnchor> = {};
  for (const draft of draftBlocks) {
    blocks.push(draft.block);
    anchors[draft.block.id] = {
      ...draft.anchor,
      hashOccurrenceCount: hashCounts.get(draft.anchor.textHash) ?? 0,
    };
  }

  return { blocks, anchors };
};

const getBlockKind = (node: PMNode): FolioAIBlockKind => {
  const listMarker: unknown = node.attrs["listMarker"];
  const numPr: unknown = node.attrs["numPr"];
  if (
    (typeof listMarker === "string" && listMarker.trim().length > 0) ||
    (numPr !== undefined && numPr !== null)
  ) {
    return "listItem";
  }

  const outlineLevel: unknown = node.attrs["outlineLevel"];
  if (typeof outlineLevel === "number" && outlineLevel >= 0) {
    return "heading";
  }

  return "paragraph";
};

const getDisplayLabel = (node: PMNode): string | undefined => {
  const listMarker: unknown = node.attrs["listMarker"];
  if (typeof listMarker === "string" && listMarker.trim().length > 0) {
    return listMarker.trim();
  }

  const styleId: unknown = node.attrs["styleId"];
  if (typeof styleId === "string" && /^heading/i.test(styleId)) {
    return styleId;
  }

  return undefined;
};
