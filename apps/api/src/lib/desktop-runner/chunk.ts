import { EventSchema } from "@ag-ui/core/schemas";

import type { DesktopRunnerChunk } from "@stll/api-contract/desktop-runner";

/**
 * Whether a chunk's fields match its AG-UI event, the protocol TanStack's
 * `StreamChunk` is. The wire contract checks only the chunk's type; the event
 * log stores only chunks a reader can fold, so a malformed one is refused
 * before it is acknowledged, while the desktop can still be fixed and resend.
 * Fields TanStack adds beyond AG-UI are kept and left to the folding reader.
 */
export const isFoldableChunk = (chunk: DesktopRunnerChunk): boolean =>
  EventSchema.safeParse(chunk).success;
