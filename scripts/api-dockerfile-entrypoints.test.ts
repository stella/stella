import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import runnerPackage from "../apps/legal-atlas-runner/package.json";

// Every operator entrypoint the builder stage bundles under /app must be
// copied into the runner stage by the same name, or the documented command
// override fails with module-not-found on the deployed image. The two lists
// live sixty lines apart in the same file, so they are bound here rather than
// by reading both on every change.
const dockerfile = readFileSync(
  nodePath.resolve(import.meta.dirname, "../apps/api/Dockerfile"),
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

test("every bundled /app entrypoint reaches the runner stage", () => {
  const built = [
    ...stage("builder").matchAll(/--outfile \/app\/([\w.-]+\.js)/gu),
  ]
    .map((match) => match[1] ?? "")
    .toSorted();
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

test("long-running API builds map frames to source", () => {
  for (const output of ["/app/server", "/app/document-processing-worker.js"]) {
    expect(buildForOutput(output), output).toContain("--sourcemap=inline");
  }
});

// The case-law runner is the third long-running bundle that reports errors
// through `captureError`, which keeps the top stack frame and folds it into
// the issue fingerprint. Without a source map those frames are offsets into
// the bundle: they name no source position, and they move whenever a rebuild
// shifts the layout, so one recurring failure splits across as many issues as
// it sees builds. Both image stages and the CI production smoke bundle the
// runner through its own package script, so the flag is asserted there rather
// than at each `bun --filter` call site.
test("the long-running case-law runner build maps frames to source", () => {
  expect(runnerPackage.scripts.build).toContain("--sourcemap=inline");
});

// Bun inlines direct `process.env.NODE_ENV` reads at bundle time, and inlines
// "development" when the variable is unset, so the builder must set it before
// its first bundle. The runner stage setting it too proves nothing here.
const BUNDLE_INSTRUCTION = /\bbun build\b|\bbun --filter \S+ build\b/u;
const RELEASE_DEFINE = "--define __STELLA_RELEASE__=true";

test("the builder stage sets NODE_ENV before its first bundle", () => {
  const instructions = logicalInstructions(stage("builder"));
  const nodeEnv = instructions.indexOf("ENV NODE_ENV=production");
  const firstBundle = instructions.findIndex(
    (instruction) =>
      instruction.startsWith("RUN ") && BUNDLE_INSTRUCTION.test(instruction),
  );
  expect(firstBundle).toBeGreaterThan(-1);
  expect(nodeEnv).toBeGreaterThan(-1);
  expect(nodeEnv).toBeLessThan(firstBundle);
});

// A published artifact refuses local development access at startup only if
// the release flag is compiled into it.
test("every builder bundle is a release build", () => {
  const bundles = logicalInstructions(stage("builder"))
    .filter((instruction) => instruction.startsWith("RUN "))
    .flatMap((instruction) =>
      instruction
        .split(/\bbun build\b/u)
        .slice(1)
        .map((invocation) => invocation.split("&&").at(0) ?? ""),
    );
  expect(bundles.length).toBeGreaterThan(0);
  expect(bundles.filter((bundle) => !bundle.includes(RELEASE_DEFINE))).toEqual(
    [],
  );
  expect(runnerPackage.scripts.build).toContain(RELEASE_DEFINE);
});
