import { panic } from "better-result";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import {
  API_ALL_RULES,
  buildImportGraph,
} from "../../../../scripts/api-test-impact";
import { isRecord } from "./enumerate-safe-handlers";

type FixtureSources = {
  sources: readonly string[];
  sharedSources: readonly string[];
};
type SelectAffectedOptions = {
  root: string;
  changed: readonly string[] | undefined;
};

/** PRs reuse the API import graph; scheduled and manual runs keep every row. */
export const selectAffectedRouteAccessFixtures = <T extends FixtureSources>(
  fixtures: readonly T[],
  { root, changed }: SelectAffectedOptions,
) => {
  if (
    changed === undefined ||
    changed.some((file) =>
      Object.values(API_ALL_RULES).some((rule) => rule.test(file)),
    )
  ) {
    return [...fixtures];
  }
  if (changed.length === 0) {
    return [];
  }
  const graph = buildImportGraph(
    root,
    fixtures.flatMap(({ sources }) => [...sources]),
  );
  return fixtures.filter(
    ({ sources, sharedSources }) =>
      sharedSources.some((source) => changed.includes(source)) ||
      sources.some((source) => {
        const closure = graph.closure(source);
        if (
          [...closure].some(
            (file) =>
              graph.failed.has(file) ||
              graph.computedImports.has(file) ||
              graph.readers.has(file) ||
              graph.scanners.has(file),
          )
        ) {
          return true;
        }
        return changed.some((file) => closure.has(file));
      }),
  );
};

/** GitHub supplies the immutable PR base; absence must not select zero rows. */
export const readRouteAccessChangedSources = (root: string) => {
  if (process.env["GITHUB_EVENT_NAME"] !== "pull_request") {
    return undefined;
  }
  const eventPath = process.env["GITHUB_EVENT_PATH"];
  if (!eventPath) {
    return panic(
      "Route access selection requires the pull-request event payload.",
    );
  }
  const event: unknown = JSON.parse(readFileSync(eventPath, "utf-8"));
  const pr = isRecord(event) ? event["pull_request"] : undefined;
  const base = isRecord(pr) ? pr["base"] : undefined;
  const sha = isRecord(base) ? base["sha"] : undefined;
  if (typeof sha !== "string" || !/^[a-f0-9]{40}$/u.test(sha)) {
    return panic(
      "Route access selection requires an immutable pull-request base SHA.",
    );
  }
  return execFileSync("git", ["diff", "--name-only", "-z", `${sha}...HEAD`], {
    cwd: root,
    encoding: "utf-8",
  })
    .split("\0")
    .filter(Boolean);
};
