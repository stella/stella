import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

// Every operator entrypoint the builder stage bundles under /app must be
// copied into the runner stage by the same name, or the documented command
// override fails with module-not-found on the deployed image. The two lists
// live sixty lines apart in the same file, so they are bound here rather than
// by reading both on every change.
const dockerfile = readFileSync(
  nodePath.resolve(import.meta.dirname, "../apps/api/Dockerfile"),
  "utf-8",
);
const workflow = readFileSync(
  nodePath.resolve(import.meta.dirname, "../.github/workflows/ci.yml"),
  "utf-8",
);

const stage = (name: string): string => {
  const start = dockerfile.search(new RegExp(`^FROM .* AS ${name}$`, "mu"));
  expect(start, name).toBeGreaterThan(-1);
  const rest = dockerfile.slice(start + 1);
  const next = rest.search(/^FROM /mu);
  return next === -1 ? rest : rest.slice(0, next);
};

const logicalInstructions = (body: string): string[] => {
  const instructions: string[] = [];
  let current = "";
  for (const line of body.split("\n")) {
    current += `${current ? " " : ""}${line.trim()}`;
    if (current.endsWith("\\")) {
      current = current.slice(0, -1).trimEnd();
      continue;
    }
    if (current) {
      instructions.push(current);
    }
    current = "";
  }
  return instructions;
};

const buildForOutput = (output: string): string | undefined =>
  logicalInstructions(stage("builder")).find(
    (instruction) =>
      instruction.startsWith("RUN bun build ") &&
      instruction.includes(`--outfile ${output} `),
  );

const smokeBuildForOutput = (output: string): string | undefined =>
  logicalInstructions(workflow).find(
    (instruction) =>
      instruction.startsWith("bun build ") &&
      instruction.includes(`--outfile ${output} `),
  );

test("every bundled /app entrypoint reaches the runner stage", () => {
  const built = [
    ...stage("builder").matchAll(/--outfile \/app\/([\w.-]+\.js)/gu),
  ]
    .map((match) => match[1] ?? "")
    .sort();
  expect(built.length).toBeGreaterThan(0);
  const copied = new Set(
    [
      ...stage("runner").matchAll(
        /--from=builder \/app\/([\w.-]+\.js) \/app\/\1/gu,
      ),
    ].map((match) => match[1] ?? ""),
  );
  expect(built.filter((name) => !copied.has(name))).toEqual([]);
});

test("long-running API builds and their CI smoke map frames to source", () => {
  for (const output of ["/app/server", "/app/document-processing-worker.js"]) {
    expect(buildForOutput(output), output).toContain("--sourcemap=inline");
  }
  for (const output of ["/tmp/server", "/tmp/document-processing-worker.js"]) {
    expect(smokeBuildForOutput(output), output).toContain("--sourcemap=inline");
  }
});
