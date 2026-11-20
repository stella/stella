"use client";

import { BidiText } from "@stll/ui/bidi-text";
import { TruncatedText } from "@stll/ui/truncated-text";

import { WORKSPACE_VIEW_TAB_NAME_CLASS } from "./view-strip";

export {
  WorkspaceViewStrip,
  WorkspaceViewSwitcherFace,
  WorkspaceViewTabFace,
} from "./view-strip";
export type {
  WorkspaceViewStripProps,
  WorkspaceViewSwitcherFaceProps,
  WorkspaceViewSwitcherItem,
  WorkspaceViewTabFaceProps,
} from "./view-strip";

/** A view's name on its tab, cut short at a fixed width; a name that is cut
 *  shows whole on hover, focus or tap. */
export const WorkspaceViewTabName = ({ name }: { name: string }) => (
  <TruncatedText
    className={WORKSPACE_VIEW_TAB_NAME_CLASS}
    render={<BidiText as="span" />}
  >
    {name}
  </TruncatedText>
);
