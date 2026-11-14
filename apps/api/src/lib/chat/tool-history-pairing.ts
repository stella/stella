import { panic } from "better-result";

import { isRecord } from "@/api/lib/type-guards";

type ToolResultCallIdsOptions = {
  callIds: ReadonlySet<string>;
  resultCallIds: Iterable<string>;
};

export const assertToolResultCallIdsKnown = ({
  callIds,
  resultCallIds,
}: ToolResultCallIdsOptions): void => {
  for (const id of resultCallIds) {
    if (!callIds.has(id)) {
      panic("Tool result has no matching call");
    }
  }
};

/** Check the full available batch before selecting a summary prefix. */
export const assertToolResultsHaveCalls = (
  messageParts: readonly (readonly unknown[])[],
): void => {
  const callIds = new Set<string>();
  const resultCallIds = new Set<string>();
  for (const parts of messageParts) {
    for (const part of parts) {
      if (!isRecord(part)) {
        continue;
      }
      switch (part["type"]) {
        case "tool-call":
          if (typeof part["id"] !== "string") {
            panic("Tool call lacks a call id");
          }
          callIds.add(part["id"]);
          break;
        case "tool-result":
          if (typeof part["toolCallId"] !== "string") {
            panic("Tool result lacks a call id");
          }
          resultCallIds.add(part["toolCallId"]);
          break;
        default:
          break;
      }
    }
  }
  assertToolResultCallIdsKnown({ callIds, resultCallIds });
};
