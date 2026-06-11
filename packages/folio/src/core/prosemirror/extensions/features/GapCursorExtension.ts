/**
 * GapCursor Extension — provides a caret slot before / between / after
 * isolating block nodes (notably `blockSdt`).
 *
 * Without gapcursor, a user cannot place the caret before a doc-starting
 * SDT, between two adjacent SDTs, or after a doc-final SDT — the
 * `isolating` boundary makes regular text selections refuse those
 * positions. The prosemirror-gapcursor plugin paints a thin "gap" caret
 * at those slots so the document stays fully navigable.
 *
 * The plugin also exposes `Backspace` / `Delete` handlers that join the
 * gap into the neighbour when sensible.
 */

import { gapCursor } from "prosemirror-gapcursor";

import { createExtension } from "../create";
import type { ExtensionContext, ExtensionRuntime } from "../types";

export const GapCursorExtension = createExtension({
  name: "gapCursor",
  onSchemaReady(_ctx: ExtensionContext): ExtensionRuntime {
    return {
      plugins: [gapCursor()],
    };
  },
});
