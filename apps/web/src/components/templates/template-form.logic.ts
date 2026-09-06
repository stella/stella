import { Result } from "better-result";
import * as v from "valibot";

const aiFieldErrorPathsSchema = v.array(
  v.object({ fieldPath: v.pipe(v.string(), v.nonEmpty()) }),
);

/** Decode the download diagnostics without trusting the HTTP header shape. */
export const readAiFieldErrorPaths = (headers: Headers) =>
  Result.try(() => {
    const encoded = headers.get("X-Ai-Field-Errors");
    if (encoded === null) {
      return [];
    }
    const decoded: unknown = JSON.parse(decodeURIComponent(encoded));
    return v
      .parse(aiFieldErrorPathsSchema, decoded)
      .map(({ fieldPath }) => fieldPath);
  });

type SingleFlightState = {
  current: Promise<void> | null;
};

/**
 * Run one leading operation and share it with every concurrent caller.
 * A new operation may start only after the active promise settles.
 */
export const runLeadingSingleFlight = async (
  state: SingleFlightState,
  operation: () => Promise<void>,
): Promise<void> => {
  if (state.current !== null) {
    await state.current;
    return;
  }

  const current = operation().finally(() => {
    if (state.current === current) {
      state.current = null;
    }
  });
  state.current = current;
  await current;
};
