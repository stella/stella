import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { guardEnforcesLine } from "./guard-rollouts";

const root = path.resolve(import.meta.dir, "..");
const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Expected workflow object");
  }
  return Object.fromEntries(Object.entries(value));
};
const readWorkflow = (file: string) =>
  record(Bun.YAML.parse(readFileSync(path.join(root, file), "utf-8")));

type EphemeralBuildxCleanupOptions = {
  steps: unknown;
  location: string;
  enforceNext?: () => boolean;
};

const assertEphemeralBuildxCleanup = ({
  steps,
  location,
  enforceNext = () => true,
}: EphemeralBuildxCleanupOptions) => {
  if (!Array.isArray(steps)) {
    return 0;
  }
  let count = 0;
  for (const rawStep of steps) {
    const step = record(rawStep);
    if (
      typeof step["uses"] !== "string" ||
      !step["uses"].startsWith("docker/setup-buildx-action@")
    ) {
      continue;
    }
    count += 1;
    if (!enforceNext()) {
      continue;
    }
    expect(step, `${location}: ${String(step["name"])}`).toHaveProperty(
      "with.cleanup",
      false,
    );
  }
  return count;
};

test("every hosted Buildx use leaves cleanup to the discarded runner", () => {
  let count = 0;
  const selfHostedExclusions = new Set<string>();
  const selfHostedJobs = new Set<string>();
  for (const file of new Bun.Glob(".github/**/*.{yml,yaml}").scanSync({
    cwd: root,
  })) {
    const source = readFileSync(path.join(root, file), "utf-8");
    const document = record(Bun.YAML.parse(source));
    const lines = source.split("\n");
    const scopes = lines.flatMap((line, index) => {
      if (!/^\s*(?:- )?uses: docker\/setup-buildx-action@/u.test(line)) {
        return [];
      }
      let start = index;
      while (start > 0 && !/^\s*- /u.test(lines[start] ?? "")) {
        start -= 1;
      }
      const indentation = /^\s*/u.exec(lines[start] ?? "")?.at(0)?.length ?? 0;
      let end = start + 1;
      while (end < lines.length) {
        const next = lines[end] ?? "";
        if (
          next.trim() !== "" &&
          !next.trimStart().startsWith("#") &&
          (/^\s*/u.exec(next)?.at(0)?.length ?? 0) <= indentation
        ) {
          break;
        }
        end += 1;
      }
      for (let at = start; at < end; at += 1) {
        if (
          guardEnforcesLine({
            guard: "hosted-buildx-cleanup",
            file,
            line: at + 1,
          })
        ) {
          return [true];
        }
      }
      return [false];
    });
    let scopeIndex = 0;
    const enforceNext = () => {
      const enforce = scopes.at(scopeIndex);
      scopeIndex += 1;
      if (enforce === undefined) {
        throw new TypeError(
          `${file}: Buildx source census differs from parsed steps`,
        );
      }
      return enforce;
    };
    if (document["jobs"] !== undefined) {
      for (const [id, rawJob] of Object.entries(record(document["jobs"]))) {
        const job = record(rawJob);
        const runner = job["runs-on"];
        const labels = Array.isArray(runner) ? runner : [runner];
        count += assertEphemeralBuildxCleanup({
          steps: job["steps"],
          location: `${file}: ${id}`,
          enforceNext: () => {
            const enforce = enforceNext();
            const identity = `${file}: ${id}`;
            if (labels.includes("self-hosted")) {
              selfHostedJobs.add(identity);
            }
            return !selfHostedExclusions.has(identity) && enforce;
          },
        });
      }
    }
    if (document["runs"] !== undefined) {
      // Composite actions have no runner of their own; keep their setup safe
      // for every hosted caller, including callers added after this census.
      count += assertEphemeralBuildxCleanup({
        steps: record(document["runs"])["steps"],
        location: file,
        enforceNext,
      });
    }
    expect(scopeIndex, file).toBe(scopes.length);
  }
  expect([...selfHostedJobs].toSorted()).toEqual(
    [...selfHostedExclusions].toSorted(),
  );
  expect(count).toBeGreaterThan(0);
});

test("the hosted Buildx guard rejects default cleanup", () => {
  const action = readWorkflow(".github/actions/build-web-image/action.yml");
  const steps = record(action["runs"])["steps"];
  if (!Array.isArray(steps)) {
    throw new TypeError("Expected composite action steps");
  }
  const mutation = steps.map((rawStep) => {
    const step = record(rawStep);
    if (
      typeof step["uses"] !== "string" ||
      !step["uses"].startsWith("docker/setup-buildx-action@")
    ) {
      return step;
    }
    return { ...step, with: {} };
  });
  expect(mutation).not.toEqual(steps);
  expect(() =>
    assertEphemeralBuildxCleanup({ steps: mutation, location: "composite" }),
  ).toThrow("with.cleanup");
});
