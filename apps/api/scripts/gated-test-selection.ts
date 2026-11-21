import * as v from "valibot";

const GatedTestSelectionSchema = v.variant("mode", [
  v.strictObject({ mode: v.literal("all") }),
  v.strictObject({ mode: v.literal("none") }),
  v.strictObject({
    mode: v.literal("selected"),
    files: v.pipe(v.array(v.string()), v.minLength(1)),
  }),
]);

export type GatedTestSelection = v.InferOutput<typeof GatedTestSelectionSchema>;

/** Missing, malformed, or stale CI plans retain every discovered suite. */
export const parseGatedTestSelection = (
  output: string | undefined,
  discovered: readonly string[],
): GatedTestSelection => {
  if (output === undefined || output === "") {
    return { mode: "all" };
  }
  const json = v.safeParse(v.pipe(v.string(), v.parseJson()), output);
  const selection = v.safeParse(GatedTestSelectionSchema, json.output);
  if (!json.success || !selection.success) {
    console.warn("Invalid gated-test selection; running the full suite.");
    return { mode: "all" };
  }
  if (discovered.length === 0) {
    console.warn("Empty gated-test discovery; retaining full-suite execution.");
    return { mode: "all" };
  }
  if (selection.output.mode !== "selected") {
    return selection.output;
  }
  const known = new Set(discovered);
  if (
    new Set(selection.output.files).size !== selection.output.files.length ||
    selection.output.files.some((file) => !known.has(file))
  ) {
    console.warn("Unknown gated-test files; running the full suite.");
    return { mode: "all" };
  }
  return selection.output;
};
