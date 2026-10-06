import { panic, Panic, TaggedError, UnhandledException } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  applicationErrorMessage,
  type ApplicationMessageError,
} from "@/api/lib/errors/application-error-message";
import { FlowStepError, HandlerError } from "@/api/lib/errors/tagged-errors";

class ForeignTaggedError extends TaggedError("ForeignTaggedError")<{
  message: string;
}> {}
class ForeignHandlerError extends TaggedError("HandlerError")<{
  message: string;
}> {}

const FALLBACK = "Step failed";
const MARKER = "SENTINEL_FOREIGN_TEXT";

const approvedErrors = {
  HandlerError: new HandlerError({ status: 400, message: "Request refused" }),
  FlowStepError: new FlowStepError({ message: "Template removed" }),
} satisfies Record<ApplicationMessageError["_tag"], ApplicationMessageError>;

describe("application messages", () => {
  for (const error of Object.values(approvedErrors)) {
    test(`keeps the approved ${error._tag} message`, () => {
      expect(applicationErrorMessage(error, FALLBACK)).toBe(error.message);
    });
  }

  const unapprovedErrors = {
    Panic: new Panic({ message: MARKER }),
    UnhandledException: new UnhandledException({ cause: new Error(MARKER) }),
    tagged: new ForeignTaggedError({ message: MARKER }),
    matchingTag: new ForeignHandlerError({ message: MARKER }),
    library: new Error(MARKER),
    type: new TypeError(MARKER),
    string: MARKER,
    record: { message: MARKER },
    null: null,
    proxy: new Proxy({}, { get: () => panic("revoked") }),
  };
  for (const [label, error] of Object.entries(unapprovedErrors)) {
    test(`replaces ${label} with the fallback`, () => {
      if (error instanceof Panic || error instanceof UnhandledException) {
        expect(error.message).toContain(MARKER);
      }
      expect(applicationErrorMessage(error, FALLBACK)).toBe(FALLBACK);
    });
  }
});
