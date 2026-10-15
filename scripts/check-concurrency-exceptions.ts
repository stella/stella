import { execFileSync } from "node:child_process";
import * as v from "valibot";

import exceptions from "../.oxlint-plugins/no-hand-rolled-concurrency-exceptions.json" with { type: "json" };

type ConcurrencyException = (typeof exceptions)[number];
const identity = ({ path, source }: ConcurrencyException) =>
  JSON.stringify([path, source]);

/** Existing sites can disappear; an exemption cannot move or widen. */
export const concurrencyExceptionChanges = (
  current: readonly ConcurrencyException[],
  base: readonly ConcurrencyException[],
): string[] => {
  const allowed = new Set(base.map(identity));
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const entry of current) {
    const key = identity(entry);
    if (!allowed.has(key)) {
      errors.push(`New concurrency exception: ${entry.path}: ${entry.source}`);
    }
    if (seen.has(key)) {
      errors.push(
        `Duplicate concurrency exception: ${entry.path}: ${entry.source}`,
      );
    }
    if (entry.reason.trim().length === 0) {
      errors.push(`Missing concurrency exception reason: ${entry.path}`);
    }
    seen.add(key);
  }
  return errors;
};

if (import.meta.main) {
  const filename = ".oxlint-plugins/no-hand-rolled-concurrency-exceptions.json";
  const mergeBase = execFileSync("git", ["merge-base", "HEAD", "origin/main"], {
    encoding: "utf-8",
  }).trim();
  const exists =
    execFileSync("git", ["ls-tree", "--name-only", mergeBase, "--", filename], {
      encoding: "utf-8",
    }).trim().length > 0;
  // The introducing PR establishes the ledger. Subsequent PRs compare exact
  // identities to main, so replacing one exception with another also fails.
  const schema = v.array(
    v.object({ path: v.string(), source: v.string(), reason: v.string() }),
  );
  const parsed = exists
    ? v.parse(
        schema,
        JSON.parse(
          execFileSync("git", ["show", `${mergeBase}:${filename}`], {
            encoding: "utf-8",
          }),
        ),
      )
    : exceptions;
  const errors = concurrencyExceptionChanges(exceptions, parsed);
  if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exit(1);
  }
  console.log(`Concurrency exceptions OK (${exceptions.length} exact sites).`);
}
