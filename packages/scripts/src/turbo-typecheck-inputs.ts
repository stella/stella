import { readFileSync } from "node:fs";
import * as v from "valibot";

const turboTypecheckInputsSchema = v.object({
  tasks: v.record(
    v.string(),
    v.object({ inputs: v.optional(v.array(v.string())) }),
  ),
});

export const readTurboTypecheckInputs = (filename: string) =>
  v.parse(
    turboTypecheckInputsSchema,
    Bun.JSONC.parse(readFileSync(filename, "utf-8")),
  );
