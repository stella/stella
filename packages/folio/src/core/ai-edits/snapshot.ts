import type { Mark, Node as PMNode } from "prosemirror-model";

import { buildCleanBlockText } from "./clean-text";
import type {
  FolioAIBlock,
  FolioAIBlockAnchor,
  FolioAIBlockKind,
  FolioAIBlockPreviewRun,
  FolioAIEditSnapshot,
} from "./types";

export const normalizeFolioAIBlockText = (text: string): string =>
  text.replace(/\s+/gu, " ").trim();

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

    // Use the paragraph's Word `w14:paraId` (allocated by
    // `ParaIdAllocatorExtension` if the parsed DOCX didn't have one)
    // as the canonical block id everywhere: AI prompts, chip hrefs
    // (`#folio:<paraId>`), apply-tool blockIds, scrollToBlock. ParaIds
    // are stable across structural edits — no more "this chip points
    // at the wrong paragraph after an insertion-above" surprise.
    //
    // Pre-allocator fallback: a snapshot taken from a doc the
    // allocator never ran on (typical in tests, possible in headless
    // contexts) carries `paraId: null`. Fall back to a sequential
    // ordinal prefixed with `seq-` so the apply path can tell at a
    // glance which lookup strategy to use (paraId-direct vs.
    // hash+ordinal).
    blockIndex++;
    const paraIdAttr: unknown = node.attrs["paraId"];
    const id =
      typeof paraIdAttr === "string" && paraIdAttr.length > 0
        ? paraIdAttr
        : `seq-${String(blockIndex).padStart(4, "0")}`;
    const kind = getBlockKind(node);
    const displayLabel = getDisplayLabel(node);
    const previewRuns = getPreviewRuns(node);

    draftBlocks.push({
      block: {
        id,
        kind,
        text,
        ...(displayLabel !== undefined && { displayLabel }),
        ...(previewRuns !== undefined && { previewRuns }),
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
  if (typeof styleId === "string" && /^heading/iu.test(styleId)) {
    return styleId;
  }

  return undefined;
};

type PreviewRunStyle = Omit<FolioAIBlockPreviewRun, "text">;

const DELETION_MARK = "deletion";

const getPreviewRuns = (node: PMNode): FolioAIBlockPreviewRun[] | undefined => {
  const runs: FolioAIBlockPreviewRun[] = [];
  const defaultStyle = getDefaultPreviewRunStyle(node);

  node.descendants((child) => {
    if (!child.isText || child.text === undefined) {
      return true;
    }
    if (child.marks.some((mark) => mark.type.name === DELETION_MARK)) {
      return false;
    }

    const style = getPreviewRunStyle(child.marks, defaultStyle);
    const previous = runs.at(-1);
    if (previous && samePreviewRunStyle(previous, style)) {
      previous.text += child.text;
      return false;
    }

    runs.push({ text: child.text, ...style });
    return false;
  });

  if (runs.every(isUnstyledPreviewRun)) {
    return undefined;
  }

  return runs;
};

const getDefaultPreviewRunStyle = (node: PMNode): PreviewRunStyle => {
  const formatting: unknown = node.attrs["defaultTextFormatting"];
  if (typeof formatting !== "object" || formatting === null) {
    return {};
  }

  return {
    ...getBooleanTextFormatting(formatting),
    ...getFontSizeTextFormatting(formatting),
    ...getFontFamilyTextFormatting(formatting),
    ...getColorTextFormatting(formatting),
  };
};

const getPreviewRunStyle = (
  marks: readonly Mark[],
  defaultStyle: PreviewRunStyle,
): PreviewRunStyle => {
  const style: PreviewRunStyle = { ...defaultStyle };

  for (const mark of marks) {
    switch (mark.type.name) {
      case "bold":
        style.bold = true;
        break;
      case "italic":
        style.italic = true;
        break;
      case "underline":
        if (isUnderlineEnabled(mark.attrs["style"])) {
          style.underline = true;
        }
        break;
      case "strike":
        style.strike = true;
        break;
      case "fontSize": {
        const size = Number(mark.attrs["size"]);
        if (Number.isFinite(size) && size > 0) {
          style.fontSizePt = size / 2;
        }
        break;
      }
      case "fontFamily": {
        const fontFamily = getFontFamilyFromAttrs(mark.attrs);
        if (fontFamily !== undefined) {
          style.fontFamily = fontFamily;
        }
        break;
      }
      case "textColor": {
        const color = getColorFromAttrs(mark.attrs);
        if (color !== undefined) {
          style.color = color;
        }
        break;
      }
      default:
        break;
    }
  }

  return style;
};

const getBooleanTextFormatting = (formatting: object): PreviewRunStyle => ({
  ...(Reflect.get(formatting, "bold") === true && { bold: true }),
  ...(Reflect.get(formatting, "italic") === true && { italic: true }),
  ...(isUnderlineEnabled(Reflect.get(formatting, "underline")) && {
    underline: true,
  }),
  ...(Reflect.get(formatting, "strike") === true && { strike: true }),
});

const isUnderlineEnabled = (underline: unknown): boolean => {
  if (underline === undefined || underline === null || underline === false) {
    return false;
  }
  if (underline === true) {
    return true;
  }
  if (typeof underline === "string") {
    return underline !== "none";
  }
  if (typeof underline !== "object") {
    return false;
  }

  const style: unknown = Reflect.get(underline, "style");
  return style !== "none";
};

const getFontSizeTextFormatting = (formatting: object): PreviewRunStyle => {
  const fontSize = Number(Reflect.get(formatting, "fontSize"));
  if (!Number.isFinite(fontSize) || fontSize <= 0) {
    return {};
  }
  return { fontSizePt: fontSize / 2 };
};

const getFontFamilyTextFormatting = (formatting: object): PreviewRunStyle => {
  const fontFamilyValue: unknown = Reflect.get(formatting, "fontFamily");
  if (typeof fontFamilyValue !== "object" || fontFamilyValue === null) {
    return {};
  }

  const fontFamily = getFontFamilyFromAttrs(fontFamilyValue);
  return fontFamily === undefined ? {} : { fontFamily };
};

const getColorTextFormatting = (formatting: object): PreviewRunStyle => {
  const colorValue: unknown = Reflect.get(formatting, "color");
  if (typeof colorValue !== "object" || colorValue === null) {
    return {};
  }

  const color = getColorFromAttrs(colorValue);
  return color === undefined ? {} : { color };
};

const getFontFamilyFromAttrs = (attrs: object): string | undefined => {
  const ascii: unknown = Reflect.get(attrs, "ascii");
  if (typeof ascii === "string" && ascii.length > 0) {
    return ascii;
  }

  const hAnsi: unknown = Reflect.get(attrs, "hAnsi");
  if (typeof hAnsi === "string" && hAnsi.length > 0) {
    return hAnsi;
  }

  return undefined;
};

const getColorFromAttrs = (attrs: object): string | undefined => {
  const rgb: unknown = Reflect.get(attrs, "rgb") ?? Reflect.get(attrs, "val");
  if (typeof rgb !== "string" || !/^[0-9a-fA-F]{6}$/u.test(rgb)) {
    return undefined;
  }

  return `#${rgb}`;
};

const samePreviewRunStyle = (
  run: FolioAIBlockPreviewRun,
  style: PreviewRunStyle,
): boolean =>
  run.bold === style.bold &&
  run.italic === style.italic &&
  run.underline === style.underline &&
  run.strike === style.strike &&
  run.fontFamily === style.fontFamily &&
  run.fontSizePt === style.fontSizePt &&
  run.color === style.color;

const isUnstyledPreviewRun = ({
  bold,
  italic,
  underline,
  strike,
  fontFamily,
  fontSizePt,
  color,
}: FolioAIBlockPreviewRun): boolean =>
  bold === undefined &&
  italic === undefined &&
  underline === undefined &&
  strike === undefined &&
  fontFamily === undefined &&
  fontSizePt === undefined &&
  color === undefined;
