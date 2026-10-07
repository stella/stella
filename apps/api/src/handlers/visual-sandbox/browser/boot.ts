import { Result, TaggedError } from "better-result";
import * as v from "valibot";

class VisualBootError extends TaggedError("VisualBootError")<{
  message: string;
}> {}

const outerConfigSchema = v.strictObject({
  origins: v.array(v.string()),
  policy: v.string(),
});

export const parseVisualOuterConfig = (text: string) => {
  const decoded = Result.try((): unknown => JSON.parse(text));
  if (decoded.isErr()) {
    return Result.err(
      new VisualBootError({
        message: "The visual frame configuration is not JSON",
      }),
    );
  }
  const parsed = v.safeParse(outerConfigSchema, decoded.value);
  if (!parsed.success) {
    return Result.err(
      new VisualBootError({
        message: "The visual frame configuration is invalid",
      }),
    );
  }
  return Result.ok(parsed.output);
};

export const whenVisualDocumentReady = (
  document: Pick<Document, "readyState" | "addEventListener">,
  start: () => void,
) => {
  if (document.readyState !== "loading") {
    start();
    return;
  }
  document.addEventListener("DOMContentLoaded", start, { once: true });
};
