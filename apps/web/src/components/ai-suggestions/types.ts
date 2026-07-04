/**
 * File-anchored AI chat — shared status type.
 *
 * The docked composer's derived status (idle / generating / applying)
 * is the only piece of the former file-chat host that still crosses a
 * module boundary: `PromptBar` types its `status` prop against it, and
 * each surface feeds the value in. It aliases folio's `AIBarStatus` so
 * the two never drift.
 */

import type { AIBarStatus } from "@stll/folio-react";

export type FileAIChatStatus = AIBarStatus;
