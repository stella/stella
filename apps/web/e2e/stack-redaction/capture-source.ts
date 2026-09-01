import { captureRedactedException } from "../../src/lib/analytics/stack-redaction";

const PRIVATE_ERROR_MESSAGE = "Privileged matter client name";

type CapturedStack = {
  name: string;
  message: string;
  originalMessage: string;
  originalStack: string | undefined;
  redactedStack: string | undefined;
};

export const captureBrowserError = (): CapturedStack => {
  const error = new TypeError(PRIVATE_ERROR_MESSAGE);
  if (typeof error.stack === "string") {
    error.stack = error.stack.replace(
      /(?=:\d+:\d+(?:\n|$))/u,
      "?matter=private#client",
    );
  }
  let redacted: Error | undefined;
  captureRedactedException(error, (captured) => {
    redacted = captured;
  });

  return {
    name: redacted?.name ?? "",
    message: redacted?.message ?? "",
    originalMessage: error.message,
    originalStack: error.stack,
    redactedStack: redacted?.stack,
  };
};
