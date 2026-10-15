import * as v from "valibot";

export const SUBAGENT_TITLE_MAX_CHARS = 80;
const MAX_SUBAGENTS_PER_CALL = 8;

export const spawnSubagentsInputSchema = v.strictObject({
  subagents: v.pipe(
    v.array(
      v.strictObject({
        title: v.pipe(
          v.string(),
          v.trim(),
          v.minLength(1),
          v.maxLength(SUBAGENT_TITLE_MAX_CHARS),
          v.description(
            `User-facing subject in the user's language (1–${SUBAGENT_TITLE_MAX_CHARS} characters); no identifiers or instructions.`,
          ),
        ),
        task: v.pipe(
          v.string(),
          v.minLength(1),
          v.maxLength(4000),
          v.description("The subtask for this subagent to complete."),
        ),
        context: v.optional(
          v.pipe(
            v.string(),
            v.maxLength(4000),
            v.description("Optional background/context the subagent needs."),
          ),
        ),
        expectedOutput: v.optional(
          v.pipe(
            v.string(),
            v.maxLength(1000),
            v.description(
              "Optional description of the result shape you want back.",
            ),
          ),
        ),
        model: v.optional(
          v.pipe(
            v.string(),
            v.description(
              "Optional exact model id; omit to use the default fast tier.",
            ),
          ),
        ),
      }),
    ),
    v.minLength(1),
    v.maxLength(MAX_SUBAGENTS_PER_CALL),
    v.description(
      "One or more independent subtasks to run in parallel on cheap subagents.",
    ),
  ),
});

// Each result carries exactly one payload, selected by its status.
const spawnSubagentsResultSchema = v.variant("status", [
  v.strictObject({
    index: v.number(),
    status: v.literal("completed"),
    result: v.string(),
  }),
  v.strictObject({
    index: v.number(),
    status: v.literal("failed"),
    error: v.string(),
  }),
]);

export const spawnSubagentsOutputSchema = v.strictObject({
  results: v.array(spawnSubagentsResultSchema),
});

export type SpawnSubagentsInput = v.InferOutput<
  typeof spawnSubagentsInputSchema
>;
