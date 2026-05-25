import { useCallback, useState } from "react";

import type { EditorView } from "prosemirror-view";

import {
  expectImageAttrs,
  mergeImageAttrs,
} from "../../core/prosemirror/attrs";
import type {
  ImageAttrs,
  ImagePositionAttrs,
} from "../../core/prosemirror/schema/nodes";
import {
  IMAGE_HORIZONTAL_ALIGNMENT_VALUES,
  IMAGE_HORIZONTAL_RELATIVE_TO_VALUES,
  IMAGE_VERTICAL_ALIGNMENT_VALUES,
  IMAGE_VERTICAL_RELATIVE_TO_VALUES,
} from "../../core/types/documentEnumValues";
import { isSafeImageFile } from "../../core/utils/imageValidation";
import type { ImagePositionData } from "../dialogs/ImagePositionDialog";
import type { ImagePropertiesData } from "../dialogs/ImagePropertiesDialog";

// ============================================================================
// TYPES
// ============================================================================

export type ImageContext = {
  pos: number;
  wrapType: string;
  displayMode: string;
  cssFloat: string | null;
  transform: string | null;
  alt: string | null;
  borderWidth: number | null;
  borderColor: string | null;
  borderStyle: string | null;
};

export type UseImageHandlersDeps = {
  /** Returns the currently active ProseMirror editor view */
  getActiveEditorView: () => EditorView | null | undefined;
  /** Focuses the currently active editor */
  focusActiveEditor: () => void;
  /** Image context when cursor is on an image node */
  pmImageContext: ImageContext | null;
};

export type UseImageHandlersReturn = {
  /** Whether the image position dialog is open */
  imagePositionOpen: boolean;
  /** Set image position dialog open state */
  setImagePositionOpen: (open: boolean) => void;
  /** Whether the image properties dialog is open */
  imagePropsOpen: boolean;
  /** Set image properties dialog open state */
  setImagePropsOpen: (open: boolean) => void;
  /** Handle file input change for image insert */
  handleImageFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  /** Handle image wrap type change */
  handleImageWrapType: (wrapType: string) => void;
  /** Handle image transform (rotate/flip) */
  handleImageTransform: (
    action: "rotateCW" | "rotateCCW" | "flipH" | "flipV",
  ) => void;
  /** Apply image position changes */
  handleApplyImagePosition: (data: ImagePositionData) => void;
  /** Open image properties dialog */
  handleOpenImageProperties: () => void;
  /** Apply image properties (alt text + border) */
  handleApplyImageProperties: (data: ImagePropertiesData) => void;
};

// ============================================================================
// HOOK
// ============================================================================

export const useImageHandlers = ({
  getActiveEditorView,
  focusActiveEditor,
  pmImageContext,
}: UseImageHandlersDeps): UseImageHandlersReturn => {
  // Image position dialog state
  const [imagePositionOpen, setImagePositionOpen] = useState(false);
  // Image properties dialog state
  const [imagePropsOpen, setImagePropsOpen] = useState(false);

  // Handle file selection for image insert
  const handleImageFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) {
        return;
      }

      const view = getActiveEditorView();
      if (!view) {
        return;
      }

      void insertSelectedImage(file, view, focusActiveEditor).catch(() => {
        // Image decode/read failures should not escape as unhandled rejections.
      });

      // Reset the input so the same file can be selected again
      e.target.value = "";
    },
    [getActiveEditorView, focusActiveEditor],
  );

  // Handle image wrap type change
  const handleImageWrapType = useCallback(
    (wrapType: string) => {
      const view = getActiveEditorView();
      if (!view || !pmImageContext) {
        return;
      }

      const pos = pmImageContext.pos;
      const node = view.state.doc.nodeAt(pos);
      if (!node || node.type.name !== "image") {
        return;
      }

      let imgDisplayMode: ImageAttrs["displayMode"] = "inline";
      let cssFloat: ImageAttrs["cssFloat"];
      let resolvedWrapType: ImageAttrs["wrapType"];

      switch (wrapType) {
        case "inline":
          resolvedWrapType = "inline";
          imgDisplayMode = "inline";
          break;
        case "square":
        case "tight":
        case "through":
          resolvedWrapType = wrapType;
          imgDisplayMode = "float";
          cssFloat = "left";
          break;
        case "topAndBottom":
          resolvedWrapType = "topAndBottom";
          imgDisplayMode = "block";
          break;
        case "behind":
        case "inFront":
          resolvedWrapType = wrapType;
          imgDisplayMode = "float";
          cssFloat = "none";
          break;
        case "wrapLeft":
          imgDisplayMode = "float";
          cssFloat = "right";
          resolvedWrapType = "square";
          break;
        case "wrapRight":
          imgDisplayMode = "float";
          cssFloat = "left";
          resolvedWrapType = "square";
          break;
        default:
          return;
      }

      const tr = view.state.tr.setNodeMarkup(
        pos,
        undefined,
        mergeImageAttrs(node, {
          wrapType: resolvedWrapType,
          displayMode: imgDisplayMode,
          cssFloat,
        }),
      );
      view.dispatch(tr.scrollIntoView());
      focusActiveEditor();
    },
    [getActiveEditorView, focusActiveEditor, pmImageContext],
  );

  // Handle image transform (rotate/flip)
  const handleImageTransform = useCallback(
    (action: "rotateCW" | "rotateCCW" | "flipH" | "flipV") => {
      const view = getActiveEditorView();
      if (!view || !pmImageContext) {
        return;
      }

      const pos = pmImageContext.pos;
      const node = view.state.doc.nodeAt(pos);
      if (!node || node.type.name !== "image") {
        return;
      }

      const currentTransform = expectImageAttrs(node).transform ?? "";

      // Parse current rotation and flip state
      const rotateMatch = /rotate\((-?\d+(?:\.\d+)?)deg\)/u.exec(
        currentTransform,
      );
      // SAFETY: capture group [1] always present when regex matches
      let rotation = rotateMatch ? Number.parseFloat(rotateMatch[1]!) : 0;
      let hasFlipH = currentTransform.includes("scaleX(-1)");
      let hasFlipV = currentTransform.includes("scaleY(-1)");

      switch (action) {
        case "rotateCW":
          rotation = (rotation + 90) % 360;
          break;
        case "rotateCCW":
          rotation = (rotation - 90 + 360) % 360;
          break;
        case "flipH":
          hasFlipH = !hasFlipH;
          break;
        case "flipV":
          hasFlipV = !hasFlipV;
          break;
        default:
          break;
      }

      // Build new transform string
      const parts: string[] = [];
      if (rotation !== 0) {
        parts.push(`rotate(${rotation}deg)`);
      }
      if (hasFlipH) {
        parts.push("scaleX(-1)");
      }
      if (hasFlipV) {
        parts.push("scaleY(-1)");
      }
      const newTransform = parts.length > 0 ? parts.join(" ") : undefined;

      const tr = view.state.tr.setNodeMarkup(
        pos,
        undefined,
        mergeImageAttrs(node, { transform: newTransform }),
      );
      view.dispatch(tr.scrollIntoView());
      focusActiveEditor();
    },
    [getActiveEditorView, focusActiveEditor, pmImageContext],
  );

  // Apply image position changes
  const handleApplyImagePosition = useCallback(
    (data: ImagePositionData) => {
      const view = getActiveEditorView();
      if (!view || !pmImageContext) {
        return;
      }

      const pos = pmImageContext.pos;
      const node = view.state.doc.nodeAt(pos);
      if (!node || node.type.name !== "image") {
        return;
      }

      const attrs = expectImageAttrs(node);
      const horizontal = normalizeHorizontalPosition(data.horizontal);
      const vertical = normalizeVerticalPosition(data.vertical);
      const tr = view.state.tr.setNodeMarkup(
        pos,
        undefined,
        mergeImageAttrs(node, {
          position:
            horizontal || vertical
              ? {
                  ...(horizontal ? { horizontal } : {}),
                  ...(vertical ? { vertical } : {}),
                }
              : undefined,
          distTop: data.distTop ?? attrs.distTop,
          distBottom: data.distBottom ?? attrs.distBottom,
          distLeft: data.distLeft ?? attrs.distLeft,
          distRight: data.distRight ?? attrs.distRight,
        }),
      );
      view.dispatch(tr.scrollIntoView());
      focusActiveEditor();
    },
    [getActiveEditorView, focusActiveEditor, pmImageContext],
  );

  // Open image properties dialog
  const handleOpenImageProperties = useCallback(() => {
    setImagePropsOpen(true);
  }, []);

  // Apply image properties (alt text + border)
  const handleApplyImageProperties = useCallback(
    (data: ImagePropertiesData) => {
      const view = getActiveEditorView();
      if (!view || !pmImageContext) {
        return;
      }

      const pos = pmImageContext.pos;
      const node = view.state.doc.nodeAt(pos);
      if (!node || node.type.name !== "image") {
        return;
      }

      const tr = view.state.tr.setNodeMarkup(
        pos,
        undefined,
        mergeImageAttrs(node, {
          alt: data.alt,
          borderWidth: data.borderWidth,
          borderColor: data.borderColor,
          borderStyle: data.borderStyle,
        }),
      );
      view.dispatch(tr.scrollIntoView());
      focusActiveEditor();
    },
    [getActiveEditorView, focusActiveEditor, pmImageContext],
  );

  return {
    imagePositionOpen,
    setImagePositionOpen,
    imagePropsOpen,
    setImagePropsOpen,
    handleImageFileChange,
    handleImageWrapType,
    handleImageTransform,
    handleApplyImagePosition,
    handleOpenImageProperties,
    handleApplyImageProperties,
  };
};

const normalizeHorizontalPosition = (
  data: ImagePositionData["horizontal"],
): ImagePositionAttrs["horizontal"] | undefined => {
  if (!data) {
    return undefined;
  }
  if (!isOneOf(data.relativeTo, IMAGE_HORIZONTAL_RELATIVE_TO_VALUES)) {
    return undefined;
  }

  const align = isOneOf(data.align, IMAGE_HORIZONTAL_ALIGNMENT_VALUES)
    ? data.align
    : undefined;
  return {
    relativeTo: data.relativeTo,
    ...(typeof data.posOffset === "number"
      ? { posOffset: data.posOffset }
      : {}),
    ...(align ? { align } : {}),
  };
};

const normalizeVerticalPosition = (
  data: ImagePositionData["vertical"],
): ImagePositionAttrs["vertical"] | undefined => {
  if (!data) {
    return undefined;
  }
  if (!isOneOf(data.relativeTo, IMAGE_VERTICAL_RELATIVE_TO_VALUES)) {
    return undefined;
  }

  const align = isOneOf(data.align, IMAGE_VERTICAL_ALIGNMENT_VALUES)
    ? data.align
    : undefined;
  return {
    relativeTo: data.relativeTo,
    ...(typeof data.posOffset === "number"
      ? { posOffset: data.posOffset }
      : {}),
    ...(align ? { align } : {}),
  };
};

const isOneOf = <T extends string>(
  value: string | undefined,
  values: readonly T[],
): value is T =>
  value !== undefined && values.some((allowed) => allowed === value);

async function insertSelectedImage(
  file: File,
  view: EditorView,
  focusActiveEditor: () => void,
): Promise<void> {
  if (!(await isSafeImageFile(file))) {
    return;
  }

  const dataUrl = await readFileAsDataUrl(file);
  const { width, height } = await loadImageDimensions(dataUrl);
  const constrained = constrainImageSize(width, height);
  const imageType = view.state.schema.nodes["image"];
  if (!imageType) {
    return;
  }

  const imageNode = imageType.create({
    src: dataUrl,
    alt: file.name,
    width: constrained.width,
    height: constrained.height,
    rId: `rId_img_${Date.now()}`,
    wrapType: "inline",
    displayMode: "inline",
  });

  const { from } = view.state.selection;
  const tr = view.state.tr.insert(from, imageNode);
  view.dispatch(tr.scrollIntoView());
  focusActiveEditor();
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      resolve(typeof reader.result === "string" ? reader.result : "");
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Failed to read image file"));
    });
    reader.readAsDataURL(file);
  });
}

function loadImageDimensions(
  src: string,
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.addEventListener("load", () => {
      resolve({
        width: img.naturalWidth || 1,
        height: img.naturalHeight || 1,
      });
    });
    img.addEventListener("error", () => {
      reject(new Error("Failed to load image"));
    });
    img.src = src;
  });
}

function constrainImageSize(
  width: number,
  height: number,
): { width: number; height: number } {
  const maxWidth = 612; // ~6.375 inches
  if (width <= maxWidth) {
    return { width, height };
  }

  const scale = maxWidth / width;
  return {
    width: maxWidth,
    height: Math.max(1, Math.round(height * scale)),
  };
}
