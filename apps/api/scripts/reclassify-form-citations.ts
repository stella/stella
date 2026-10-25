/**
 * Regex-only repair of unreviewed citations labelled by a now-form rule.
 * Preview: --language cs --output /path/plan.json [--limit 1000] [--after UUID]
 * Apply the inspected preview: --apply /path/plan.json
 * No database is changed by the default mode. A changed text, label, rule or
 * review after the preview skips the row rather than rewriting a new state.
 */
import { panic, TaggedError } from "better-result";
import * as v from "valibot";

import {
  applyFormRepairs,
  formRepairPlanSchema,
  previewFormRepairs,
} from "@/api/handlers/case-law/polarity/form-repair";
import { loadRules } from "@/api/handlers/case-law/polarity/rule-engine";
import { enterCaseLawMaintenanceLane } from "@/api/lib/case-law/maintenance-lane";

class FormRepairArgumentError extends TaggedError("FormRepairArgumentError")<{
  message: string;
}> {}

const args = v.parse(
  v.variant("mode", [
    v.object({
      mode: v.literal("preview"),
      language: v.pipe(v.string(), v.minLength(1)),
      output: v.pipe(v.string(), v.minLength(1)),
      limit: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1000)),
      after: v.nullable(v.pipe(v.string(), v.uuid())),
    }),
    v.object({
      mode: v.literal("apply"),
      plan: v.pipe(v.string(), v.minLength(1)),
    }),
  ]),
  (() => {
    const values = new Map<string, string>();
    for (let index = 2; index < Bun.argv.length; index += 2) {
      const key = Bun.argv[index];
      const value = Bun.argv[index + 1];
      if (
        key === undefined ||
        value === undefined ||
        !["--language", "--output", "--limit", "--after", "--apply"].includes(
          key,
        ) ||
        values.has(key)
      ) {
        throw new FormRepairArgumentError({
          message:
            "Use --language LANGUAGE --output PLAN [--limit 1..1000] [--after UUID], or --apply PLAN",
        });
      }
      values.set(key, value);
    }
    const plan = values.get("--apply");
    if (plan !== undefined) {
      if (values.size !== 1) {
        throw new FormRepairArgumentError({
          message: "--apply takes only an inspected preview file",
        });
      }
      return { mode: "apply", plan };
    }
    return {
      mode: "preview",
      language: values.get("--language"),
      output: values.get("--output"),
      limit: Number(values.get("--limit") ?? 1000),
      after: values.get("--after") ?? null,
    };
  })(),
);

const main = async () => {
  const plan =
    args.mode === "apply"
      ? v.parse(formRepairPlanSchema, await Bun.file(args.plan).json())
      : null;
  const { ingestionDb: scopedDb, rootDb } = await enterCaseLawMaintenanceLane();
  switch (args.mode) {
    case "preview": {
      const rules = await loadRules(args.language, scopedDb);
      const preview = await previewFormRepairs({
        scopedDb,
        language: args.language,
        rules,
        limit: args.limit,
        after: args.after,
      });
      await Bun.write(args.output, `${JSON.stringify(preview, null, 2)}\n`);
      console.log(
        JSON.stringify(
          {
            mode: "preview",
            file: args.output,
            read: preview.read,
            noContext: preview.noContext,
            counts: preview.counts,
            after: preview.after,
          },
          null,
          2,
        ),
      );
      return;
    }
    case "apply": {
      if (plan === null) {
        panic("An apply run requires a validated preview");
      }
      const rules = await loadRules(plan.language, scopedDb);
      const result = await applyFormRepairs({
        transaction: rootDb.transaction,
        plan,
        rules,
      });
      console.log(JSON.stringify({ mode: "apply", ...result }, null, 2));
      return;
    }
    default: {
      args satisfies never;
      panic("Unhandled form repair command mode");
    }
  }
};

await main();
process.exit(0);
