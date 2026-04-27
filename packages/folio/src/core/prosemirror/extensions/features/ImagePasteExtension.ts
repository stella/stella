/**
 * Image Paste Extension — handles image files pasted from the clipboard
 *
 * When an image file is present on the clipboard, this intercepts the paste,
 * reads the image data, and inserts an image node instead of a file icon.
 */

import { Plugin, TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

import { getClipboardImageFiles } from "../../../utils/clipboard";
import { isSafeImageFile } from "../../../utils/imageValidation";
import { createExtension } from "../create";
import type { ExtensionRuntime } from "../types";

const MAX_INLINE_IMAGE_WIDTH = 612; // ~6.375 inches at 96 DPI

async function readFileAsDataUrl(file: File): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    // SAFETY: readAsDataURL always produces a string result
    reader.addEventListener("load", () =>
      resolve(reader.result as unknown as string),
    );
    reader.addEventListener("error", () =>
      reject(reader.error ?? new Error("Failed to read image file")),
    );
    reader.readAsDataURL(file);
  });
}

async function loadImageSize(
  src: string,
): Promise<{ width: number; height: number }> {
  return await new Promise((resolve, reject) => {
    const img = new Image();
    img.addEventListener("load", () =>
      resolve({ width: img.naturalWidth || 1, height: img.naturalHeight || 1 }),
    );
    img.addEventListener("error", () =>
      reject(new Error("Failed to load pasted image")),
    );
    img.src = src;
  });
}

async function insertImageFiles(
  view: EditorView,
  files: File[],
): Promise<void> {
  const imageType = view.state.schema.nodes["image"];
  if (!imageType) {
    return;
  }

  let insertPos = view.state.selection.from;

  for (const file of files) {
    if (!(await isSafeImageFile(file))) {
      continue;
    }

    let dataUrl: string;
    try {
      dataUrl = await readFileAsDataUrl(file);
    } catch {
      continue;
    }

    let naturalWidth = 1;
    let naturalHeight = 1;
    try {
      ({ width: naturalWidth, height: naturalHeight } =
        await loadImageSize(dataUrl));
    } catch {
      // Fall back to a safe minimal size if the image can't be decoded
      naturalWidth = 1;
      naturalHeight = 1;
    }

    let width = naturalWidth;
    let height = naturalHeight;

    if (width > MAX_INLINE_IMAGE_WIDTH) {
      const scale = MAX_INLINE_IMAGE_WIDTH / width;
      width = MAX_INLINE_IMAGE_WIDTH;
      height = Math.max(1, Math.round(height * scale));
    }

    const imageNode = imageType.create({
      src: dataUrl,
      alt: file.name,
      width,
      height,
      rId: `rId_img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      wrapType: "inline",
      displayMode: "inline",
    });

    const tr = view.state.tr.insert(insertPos, imageNode);
    insertPos += imageNode.nodeSize;
    tr.setSelection(TextSelection.create(tr.doc, insertPos));
    view.dispatch(tr.scrollIntoView());
  }

  view.focus();
}

export const ImagePasteExtension = createExtension({
  name: "imagePaste",
  onSchemaReady(_ctx): ExtensionRuntime {
    const plugin = new Plugin({
      props: {
        handleDOMEvents: {
          paste(view, event) {
            const imageFiles = getClipboardImageFiles(event.clipboardData);

            if (imageFiles.length === 0) {
              return false;
            }

            if (!view.state.schema.nodes["image"]) {
              return false;
            }

            event.preventDefault();
            insertImageFiles(view, imageFiles).catch(() => {
              // Intentionally empty - image paste failures are non-critical
            });
            return true;
          },
        },
      },
    });

    return { plugins: [plugin] };
  },
});
