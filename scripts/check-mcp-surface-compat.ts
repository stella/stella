import { panic } from "better-result";
import * as v from "valibot";

import {
  LEGACY_OUTPUT_ADDITIONS,
  outputRestrictions,
  schemaBreaks,
} from "./mcp-schema-compat";

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

type CompatibilityIssue = { kind: "failure" | "transition"; detail: string };

const compareTool = (old: Tool, next: Tool) => {
  const issues: CompatibilityIssue[] = [];
  if (next.feature !== undefined && old.feature !== next.feature) {
    issues.push({
      kind: "failure",
      detail: "/feature deployment-feature-required",
    });
  }
  for (const { path, rule } of schemaBreaks(
    "input",
    old.inputSchema,
    next.inputSchema,
  )) {
    issues.push({ kind: "failure", detail: `/inputSchema${path} ${rule}` });
  }
  if (old.outputSchema !== undefined) {
    if (next.outputSchema === undefined) {
      issues.push({
        kind: "failure",
        detail: "/outputSchema output-schema-removed",
      });
    } else {
      for (const { path, rule } of schemaBreaks(
        "output",
        old.outputSchema,
        next.outputSchema,
      )) {
        // Both rules require a restriction on this node in the released schema.
        const transition =
          rule === LEGACY_OUTPUT_ADDITIONS.closedObjectProperty ||
          rule === LEGACY_OUTPUT_ADDITIONS.enumValue;
        issues.push({
          kind: transition ? "transition" : "failure",
          detail: `/outputSchema${path} ${rule}`,
        });
      }
    }
  }
  return issues;
};

export const compareReleasedSurface = (previous: unknown, current: unknown) => {
  const old = parseSurface(previous);
  const next = parseSurface(current);
  const compared = new Map<string, CompatibilityIssue[]>();
  const diagnostics = {
    failure: new Map<string, string>(),
    transition: new Map<string, string>(),
  };
  const report = (
    issue: CompatibilityIssue,
    location: string,
    enabled: string[],
  ) => {
    const key = `${location} ${issue.detail}`;
    const group = diagnostics[issue.kind];
    if (!group.has(key)) {
      group.set(
        key,
        `${key} (enabled features: ${enabled.join(",") || "none"})`,
      );
    }
  };

  // After the first open release, also guard new tools, modes and properties.
  // They have no previously listed schema node for the pairwise diff to visit.
  if (
    old.tools.every(
      (tool) => outputRestrictions(tool.outputSchema).length === 0,
    )
  ) {
    const restrictions = next.tools.map((tool) =>
      outputRestrictions(tool.outputSchema),
    );
    for (const [mode, { lists }] of next.profiles) {
      for (const { enabled, byName } of lists) {
        for (const [name, index] of byName) {
          for (const { path, rule } of restrictions[index] ??
            panic("Missing tool variant")) {
            report(
              { kind: "failure", detail: `/outputSchema${path} ${rule}` },
              `${mode} ${name}`,
              enabled,
            );
          }
        }
      }
    }
  }

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
          let issues = compared.get(pair);
          if (!issues) {
            issues =
              nextIndex === undefined
                ? [{ kind: "failure", detail: "/ tool-removed" }]
                : compareTool(
                    old.tools[index] ?? panic("Missing released tool"),
                    next.tools[nextIndex] ?? panic("Missing current tool"),
                  );
            compared.set(pair, issues);
          }
          for (const issue of issues) {
            const enabled = [
              ...new Set([...source.enabled, ...(target?.enabled ?? [])]),
            ].toSorted();
            report(issue, `${mode} ${name}`, enabled);
          }
        }
      }
    }
  }
  return {
    failures: [...diagnostics.failure.values()].toSorted(),
    transitions: [...diagnostics.transition.values()].toSorted(),
  };
};

if (import.meta.main) {
  const [previous, current, baseline] = Bun.argv.slice(2);
  if (!previous || !current || !baseline) {
    panic(
      "Expected released and current MCP surface paths and the baseline release tag",
    );
  }
  const { failures, transitions } = compareReleasedSurface(
    await Bun.file(previous).json(),
    await Bun.file(current).json(),
  );
  for (const issue of transitions) {
    process.stderr.write(
      `${issue} — transition: breaks sessions listed from ${baseline}; clears when a release with open output schemas ships\n`,
    );
  }
  for (const failure of failures) {
    process.stderr.write(`${failure}\n`);
  }
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}
