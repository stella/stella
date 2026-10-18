import { readFileSync, writeFileSync } from "node:fs";

// This generator also runs before dependencies are installed.
class CiPlanVariablesError extends Error {
  override name = "CiPlanVariablesError";
  readonly _tag = "CiPlanVariablesError";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const record = (value: unknown) => {
  if (!isRecord(value)) {
    throw new CiPlanVariablesError("Expected a workflow mapping");
  }
  return value;
};

export const predicateVariables = (predicate: string): string[] => {
  // Quoted literals are tokens so text such as 'vars.EXAMPLE' is ignored.
  const tokens =
    predicate.match(/'(?:[^']|'')*'|[A-Za-z_][\w-]*|[^\s]/gu) ?? [];
  const names: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.toLowerCase() !== "vars") {
      continue;
    }
    const accessor = tokens[index + 1];
    const name = tokens[index + 2];
    if (accessor === "." && name && /^[A-Za-z_][\w]*$/u.test(name)) {
      names.push(name.toUpperCase());
      index += 2;
      continue;
    }
    if (
      accessor === "[" &&
      name &&
      /^'[A-Za-z_][\w]*'$/u.test(name) &&
      tokens[index + 3] === "]"
    ) {
      names.push(name.slice(1, -1).toUpperCase());
      index += 3;
      continue;
    }
    throw new CiPlanVariablesError(
      `Use a static vars name in job predicates: ${predicate}`,
    );
  }
  return names;
};

export const planVariablesExpression = (
  readWorkflow: (file: string) => unknown,
): string => {
  const names = new Set<string>();
  const visited = new Set<string>();
  const visit = (file: string) => {
    if (visited.has(file)) {
      return;
    }
    visited.add(file);
    const workflow = record(readWorkflow(file));
    // Include all reachable job predicates, a conservative superset of plan gates.
    for (const value of Object.values(record(workflow["jobs"]))) {
      const job = record(value);
      if (typeof job["if"] === "string") {
        for (const name of predicateVariables(job["if"])) {
          names.add(name);
        }
      }
      const uses = job["uses"];
      if (typeof uses === "string" && uses.startsWith("./.github/workflows/")) {
        visit(uses.slice(2));
      }
    }
  };
  visit(".github/workflows/ci.yml");
  const ordered = [...names].toSorted();
  if (ordered.length === 0) {
    return `\${{ '{}' }}`;
  }
  const fields = ordered.map((name, index) => `"${name}":{${index}}`).join(",");
  const values = ordered.map((name) => `toJSON(vars.${name})`).join(", ");
  return `\${{ format('{{${fields}}}', ${values}) }}`;
};

const PLAN_VARIABLES_OUTPUT = /^ {6}variables: .*$/gmu;

/** The workflow with the ci-plan `variables` output set to `expression`. */
export const withPlanVariablesOutput = (
  source: string,
  expression: string,
): string => {
  const matches = source.match(PLAN_VARIABLES_OUTPUT) ?? [];
  if (matches.length !== 1) {
    throw new CiPlanVariablesError(
      `Expected exactly one ci-plan variables output line, found ${matches.length}`,
    );
  }
  return source.replace(
    PLAN_VARIABLES_OUTPUT,
    () => `      variables: ${expression}`,
  );
};

if (import.meta.main) {
  const file = ".github/workflows/ci.yml";
  const expression = planVariablesExpression((path) =>
    Bun.YAML.parse(readFileSync(path, "utf-8")),
  );
  const source = readFileSync(file, "utf-8");
  if (process.argv.at(2) !== "--write") {
    throw new CiPlanVariablesError(
      "Usage: bun scripts/ci-plan-variables.ts --write",
    );
  }
  writeFileSync(file, withPlanVariablesOutput(source, expression));
}
