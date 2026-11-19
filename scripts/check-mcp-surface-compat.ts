import { panic } from "better-result";
import * as v from "valibot";

import { schemaBreaks } from "./mcp-schema-compat";

const schema = v.record(v.string(), v.unknown());
const toolSchema = v.object({
  name: v.pipe(v.string(), v.nonEmpty()),
  inputSchema: schema,
  outputSchema: v.optional(schema),
  feature: v.optional(v.string()),
});
const surfaceSchema = v.object({
  tools: v.pipe(v.array(toolSchema), v.nonEmpty()),
  modes: v.record(v.string(), v.record(v.string(), v.array(v.number()))),
});

type Tool = v.InferOutput<typeof toolSchema>;

const parseSurface = (value: unknown) => {
  const { tools, modes } = v.parse(surfaceSchema, value);
  if (Object.keys(modes).length === 0) {
    panic("MCP surface has no modes");
  }
  const profiles = new Map(
    Object.entries(modes).map(([mode, entries]) => {
      const features = new Set(
        Object.keys(entries).flatMap((key) => key.split(",").filter(Boolean)),
      );
      // The exporter enumerates every subset once, including the empty set.
      if (Object.keys(entries).length !== 2 ** features.size) {
        panic(`Incomplete profiles for ${mode}`);
      }
      const lists = Object.entries(entries).map(([key, indexes]) => {
        const enabled = key === "" ? [] : key.split(",");
        if (
          [...new Set(enabled)].toSorted().join(",") !== key ||
          enabled.includes("")
        ) {
          panic(`Invalid feature profile '${key}' for ${mode}`);
        }
        const byName = new Map<string, number>();
        for (const index of indexes) {
          const tool =
            tools[index] ?? panic(`Unknown tool variant ${index} in ${mode}`);
          if (byName.has(tool.name)) {
            panic(`Duplicate tool ${tool.name} in ${mode}`);
          }
          byName.set(tool.name, index);
        }
        return { enabled, byName };
      });
      return [mode, { features, lists }] as const;
    }),
  );
  return { tools, profiles };
};

const compareTool = (old: Tool, next: Tool) => {
  const failures: string[] = [];
  if (next.feature !== undefined && old.feature !== next.feature) {
    failures.push("/feature deployment-feature-required");
  }
  for (const issue of schemaBreaks(
    "input",
    old.inputSchema,
    next.inputSchema,
  )) {
    failures.push(`/inputSchema${issue.path} ${issue.rule}`);
  }
  if (old.outputSchema !== undefined) {
    if (next.outputSchema === undefined) {
      failures.push("/outputSchema output-schema-removed");
    } else {
      for (const issue of schemaBreaks(
        "output",
        old.outputSchema,
        next.outputSchema,
      )) {
        failures.push(`/outputSchema${issue.path} ${issue.rule}`);
      }
    }
  }
  return failures;
};

export const releasedSurfaceBreaks = (previous: unknown, current: unknown) => {
  const old = parseSurface(previous);
  const next = parseSurface(current);
  const compared = new Map<string, string[]>();
  const diagnostics = new Map<string, string>();
  for (const [mode, profiles] of old.profiles) {
    const targets = next.profiles.get(mode);
    // Releases can introduce or retire a feature flag. Compare every pair
    // whose assignments agree on the flags both releases understand.
    const candidates = Map.groupBy(targets?.lists ?? [], (target) =>
      target.enabled.filter((id) => profiles.features.has(id)).join(","),
    );
    for (const source of profiles.lists) {
      const shared = source.enabled
        .filter((id) => targets?.features.has(id))
        .join(",");
      for (const target of candidates.get(shared) ?? [undefined]) {
        for (const [name, index] of source.byName) {
          const nextIndex = target?.byName.get(name);
          const pair = `${index}/${nextIndex ?? "removed"}`;
          let failures = compared.get(pair);
          if (!failures) {
            failures =
              nextIndex === undefined
                ? ["/ tool-removed"]
                : compareTool(
                    old.tools[index] ?? panic("Missing released tool"),
                    next.tools[nextIndex] ?? panic("Missing current tool"),
                  );
            compared.set(pair, failures);
          }
          for (const failure of failures) {
            const key = `${mode} ${name} ${failure}`;
            if (!diagnostics.has(key)) {
              const enabled = [
                ...new Set([...source.enabled, ...(target?.enabled ?? [])]),
              ].toSorted();
              diagnostics.set(
                key,
                `${key} (enabled features: ${enabled.join(",") || "none"})`,
              );
            }
          }
        }
      }
    }
  }
  return [...diagnostics.values()].toSorted();
};

if (import.meta.main) {
  const [previous, current] = Bun.argv.slice(2);
  if (!previous || !current) {
    panic("Expected released and current MCP surface paths");
  }
  const failures = releasedSurfaceBreaks(
    await Bun.file(previous).json(),
    await Bun.file(current).json(),
  );
  for (const failure of failures) {
    process.stderr.write(`${failure}\n`);
  }
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}
