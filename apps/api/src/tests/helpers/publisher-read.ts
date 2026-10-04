import { panic } from "better-result";

import {
  readAbsent,
  readOutcomeOfStatus,
  readPresent,
  readUnavailable,
  type ReadOutcome,
} from "@/api/lib/errors/read-outcome";

/** A stubbed response as `readPublisher` types it, by its status alone. */
export const readOfResponse = (response: Response): ReadOutcome<Response> => {
  const outcome = readOutcomeOfStatus(
    response.status,
    "document",
    response.headers.get("Retry-After"),
  );
  switch (outcome.type) {
    case "present":
      return readPresent(response);
    case "absent":
      return readAbsent(outcome.evidence);
    case "refused":
      return outcome;
    case "unavailable":
      return readUnavailable(outcome.cause);
    default:
      outcome satisfies never;
      return panic(`Unhandled read outcome: ${String(outcome)}`);
  }
};
