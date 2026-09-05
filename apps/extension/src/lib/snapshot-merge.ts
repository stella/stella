import * as v from "valibot";

import {
  BROWSER_CONTROL_LIMITS,
  type BrowserControlElement,
  formatElementReference,
} from "@stll/api-contract/browser-control";

/** What the injected page script returns for one frame; refs are frame-local paths. */
export const frameSnapshotSchema = v.strictObject({
  elements: v.array(
    v.strictObject({
      href: v.optional(v.string()),
      name: v.string(),
      path: v.string(),
      role: v.string(),
      value: v.optional(v.string()),
    }),
  ),
  text: v.string(),
  title: v.string(),
  url: v.string(),
});

export type FrameSnapshot = v.InferOutput<typeof frameSnapshotSchema>;

export type MergedSnapshot = {
  elements: BrowserControlElement[];
  text: string;
  textOffset: number;
  textTotalChars: number;
  title: string;
  url: string;
};

type MergeFrameSnapshotsOptions = {
  frames: readonly { frameId: number; snapshot: FrameSnapshot }[];
  textOffset: number;
};

const TOP_FRAME_ID = 0;

/**
 * Combines per-frame snapshots into one page: the top frame first, then
 * subframes by frame id, with element refs qualified by frame and the page
 * text paged by `textOffset`. Returns null without a top frame.
 */
export const mergeFrameSnapshots = ({
  frames,
  textOffset,
}: MergeFrameSnapshotsOptions): MergedSnapshot | null => {
  const ordered = frames
    .toSorted((left, right) => left.frameId - right.frameId)
    .slice(0, BROWSER_CONTROL_LIMITS.frames);
  const top = ordered.find(({ frameId }) => frameId === TOP_FRAME_ID);
  if (!top) {
    return null;
  }

  const elements: BrowserControlElement[] = [];
  const textParts: string[] = [];
  for (const { frameId, snapshot } of ordered) {
    for (const element of snapshot.elements) {
      if (elements.length >= BROWSER_CONTROL_LIMITS.elements) {
        break;
      }
      elements.push({
        name: element.name,
        ref: formatElementReference({ frameId, path: element.path }),
        role: element.role,
        ...(element.href === undefined ? {} : { href: element.href }),
        ...(element.value === undefined ? {} : { value: element.value }),
      });
    }
    if (snapshot.text.length > 0) {
      textParts.push(snapshot.text);
    }
  }

  const fullText = textParts
    .join("\n\n")
    .slice(0, BROWSER_CONTROL_LIMITS.pageTextTotalChars);
  const offset = Math.min(textOffset, fullText.length);
  return {
    elements,
    text: fullText.slice(offset, offset + BROWSER_CONTROL_LIMITS.pageTextChars),
    textOffset: offset,
    textTotalChars: fullText.length,
    title: top.snapshot.title.slice(0, BROWSER_CONTROL_LIMITS.titleChars),
    url: top.snapshot.url.slice(0, BROWSER_CONTROL_LIMITS.urlChars),
  };
};
