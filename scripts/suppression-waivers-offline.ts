import { panic } from "better-result";
import { readFileSync } from "node:fs";
import * as v from "valibot";

import { runCheck } from "./suppression-waivers";

const scopeSchema = v.variant("type", [
  v.object({ type: v.literal("all") }),
  v.object({
    type: v.literal("changes"),
    changedFiles: v.array(v.string()),
    baseSha: v.pipe(v.string(), v.regex(/^[a-f\d]{40}$/u)),
  }),
]);
const optionValue = (name: string) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv.at(index + 1);
};

// Git preparation runs separately so the preload can deny all subprocesses.
const scopeFile = optionValue("--scope") ?? panic("--scope is required");
const scope = v.parse(
  scopeSchema,
  JSON.parse(readFileSync(scopeFile, "utf-8")),
);
process.exit(
  runCheck(
    scope.type === "all"
      ? scope
      : {
          type: "changes",
          changedFiles: new Set(scope.changedFiles),
          baseSha: scope.baseSha,
        },
    optionValue("--ledger"),
  ),
);
