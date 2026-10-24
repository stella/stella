import { readFileSync } from "node:fs";
import * as v from "valibot";

const changeScopedEntrySchema = v.object({
  path: v.string(),
  reason: v.pipe(v.string(), v.minLength(1)),
});

export const globalRuleInputsSchema = v.object({
  version: v.literal(1),
  globs: v.array(v.string()),
  changeScoped: v.array(changeScopedEntrySchema),
});

export type GlobalRuleInputs = v.InferOutput<typeof globalRuleInputsSchema>;

const GLOBAL_RULE_INPUTS_URL = new URL(
  "../.github/global-rule-inputs.json",
  import.meta.url,
);

export const loadGlobalRuleInputs = (
  file: string | URL = GLOBAL_RULE_INPUTS_URL,
): GlobalRuleInputs =>
  v.parse(globalRuleInputsSchema, JSON.parse(readFileSync(file, "utf-8")));

export const matchesGlobalRuleInput = (
  path: string,
  inputs: GlobalRuleInputs = loadGlobalRuleInputs(),
) => inputs.globs.some((glob) => new Bun.Glob(glob).match(path));
