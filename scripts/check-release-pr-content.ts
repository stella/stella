#!/usr/bin/env bun

import { TaggedError } from "better-result";
import { isDeepStrictEqual } from "node:util";
import * as v from "valibot";

import { syncLockfileWorkspaceVersions } from "./lockfile-workspace-versions";

class ReleaseContentError extends TaggedError("ReleaseContentError")<{
  message: string;
}> {}

const refuse: (message: string) => never = (message) => {
  throw new ReleaseContentError({ message });
};
const MANIFEST = /^(?:package\.json|(?:apps|packages)\/[^/]+\/package\.json)$/u;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const CLI_VERSION = "packages/cli/src/generated/cli-version.ts";
const DEPENDENCIES = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;
const objectSchema = v.record(v.string(), v.unknown());
const parseObject = (text: string) => v.parse(objectSchema, JSON.parse(text));

type ReleaseFile = { filename: string; status: string };
type ReleaseContentOptions = {
  files: readonly ReleaseFile[];
  read: (side: "base" | "head", filename: string) => string;
};

const readReleaseManifests = ({ files, read }: ReleaseContentOptions) => {
  const manifests = new Map<
    string,
    { before: Record<string, unknown>; after: Record<string, unknown> }
  >();
  const versions = new Map<string, string>();
  for (const { filename, status } of files) {
    if (!MANIFEST.test(filename)) {
      continue;
    }
    if (status !== "modified") {
      refuse(`${filename}: versioning cannot add or remove a package`);
    }
    const before = parseObject(read("base", filename));
    const after = parseObject(read("head", filename));
    if (
      typeof before["version"] !== "string" ||
      typeof after["version"] !== "string" ||
      !SEMVER.test(before["version"]) ||
      !SEMVER.test(after["version"])
    ) {
      refuse(`${filename}: expected existing package version fields`);
    }
    if (
      before["version"] !== after["version"] &&
      typeof after["name"] === "string"
    ) {
      versions.set(after["name"], after["version"]);
    }
    manifests.set(filename, { before, after });
  }
  for (const [filename, manifest] of manifests) {
    const before = Object.fromEntries(
      Object.entries(manifest.before).filter(([key]) => key !== "version"),
    );
    const after = Object.fromEntries(
      Object.entries(manifest.after)
        .filter(([key]) => key !== "version")
        .map(([section, value]) => {
          if (
            !DEPENDENCIES.some(
              (dependencySection) => dependencySection === section,
            )
          ) {
            return [section, value];
          }
          const oldDependencies = v.parse(objectSchema, before[section]);
          const dependencies = Object.fromEntries(
            Object.entries(v.parse(objectSchema, value)).map(
              ([name, newValue]) => {
                const oldValue = oldDependencies[name];
                const version = versions.get(name);
                if (
                  oldValue === newValue ||
                  typeof oldValue !== "string" ||
                  version === undefined
                ) {
                  return [name, newValue];
                }
                const prefix =
                  /^((?:workspace:)?[~^]?)\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u
                    .exec(oldValue)
                    ?.at(1);
                return [
                  name,
                  prefix !== undefined && newValue === `${prefix}${version}`
                    ? oldValue
                    : newValue,
                ];
              },
            ),
          );
          return [section, dependencies];
        }),
    );
    if (!isDeepStrictEqual(before, after)) {
      refuse(
        `${filename}: only package versions and versioned internal dependencies may change`,
      );
    }
  }
  return manifests;
};

export const validateReleaseContent = ({
  files,
  read,
}: ReleaseContentOptions): void => {
  const manifests = readReleaseManifests({ files, read });
  for (const { filename, status } of files) {
    if (status === "renamed") {
      refuse(`${filename}: versioning cannot rename files`);
    }
    if (manifests.has(filename)) {
      continue;
    }
    if (filename === "bun.lock" && status === "modified") {
      const workspaceVersions = Object.fromEntries(
        [...manifests].flatMap(([name, { before, after }]) =>
          name !== "package.json" &&
          before["version"] !== after["version"] &&
          typeof after["version"] === "string"
            ? [[name.slice(0, -"/package.json".length), after["version"]]]
            : [],
        ),
      );
      if (
        syncLockfileWorkspaceVersions(
          read("base", filename),
          workspaceVersions,
        ) !== read("head", filename)
      ) {
        refuse(`${filename}: only generated workspace versions may change`);
      }
      continue;
    }
    if (filename === CLI_VERSION && status === "modified") {
      const cli = manifests.get("packages/cli/package.json");
      if (cli === undefined || cli.before["version"] === cli.after["version"]) {
        refuse(
          `${filename}: generated CLI version has no matching package version`,
        );
      }
      const before = read("base", filename);
      const expected = before.replace(
        `export const CLI_VERSION = ${JSON.stringify(cli.before["version"])};`,
        () =>
          `export const CLI_VERSION = ${JSON.stringify(cli.after["version"])};`,
      );
      if (before === expected || expected !== read("head", filename)) {
        refuse(`${filename}: only the generated CLI version may change`);
      }
      continue;
    }
    if (
      /^\.changeset\/[^/]+\.md$/u.test(filename) &&
      filename !== ".changeset/README.md" &&
      status === "removed"
    ) {
      continue;
    }
    if (
      filename === "VERSION" &&
      status === "modified" &&
      SEMVER.test(read("head", filename).replace(/\n$/u, ""))
    ) {
      continue;
    }
    if (
      /^(?:(?:(?:apps|packages)\/[^/]+\/)?CHANGELOG\.md|docs\/changelog\/[^/]+\.md)$/u.test(
        filename,
      ) &&
      ["added", "modified"].includes(status)
    ) {
      continue;
    }
    if (
      filename === "apps/landing/src/data/changelog-release-dates.json" &&
      status === "modified"
    ) {
      v.parse(
        v.record(v.string(), v.nullable(v.string())),
        JSON.parse(read("head", filename)),
      );
      continue;
    }
    refuse(`${filename}: not a versioning output (${status})`);
  }
};

const pullSchema = v.object({
  draft: v.boolean(),
  title: v.string(),
  changed_files: v.number(),
  base: v.object({ sha: v.string(), ref: v.string() }),
  head: v.object({
    sha: v.string(),
    repo: v.object({ full_name: v.string() }),
  }),
});
const filesSchema = v.array(
  v.array(v.object({ filename: v.string(), status: v.string() })),
);
type GithubApi = (endpoint: string, options?: readonly string[]) => unknown;

type CheckReleasePullRequestOptions = {
  repo: string;
  number: number;
  api: GithubApi;
};
export const checkReleasePullRequest = ({
  repo,
  number,
  api,
}: CheckReleasePullRequestOptions): void => {
  const endpoint = `repos/${repo}/pulls/${number}`;
  const pull = v.parse(pullSchema, api(endpoint));
  if (
    pull.draft ||
    pull.base.ref !== "main" ||
    pull.head.repo.full_name !== repo ||
    !pull.title.startsWith("chore: release v")
  ) {
    refuse("release identity changed during recognition");
  }
  const comparison = v.parse(
    v.object({ merge_base_commit: v.object({ sha: v.string() }) }),
    api(`repos/${repo}/compare/${pull.base.sha}...${pull.head.sha}`),
  );
  const revisions = {
    base: comparison.merge_base_commit.sha,
    head: pull.head.sha,
  };
  const files = v
    .parse(
      filesSchema,
      api(`${endpoint}/files?per_page=100`, ["--paginate", "--slurp"]),
    )
    .flat();
  if (files.length !== pull.changed_files) {
    refuse("incomplete release file listing");
  }
  const requests = files
    .filter(
      ({ filename }) =>
        MANIFEST.test(filename) ||
        [
          "VERSION",
          "bun.lock",
          CLI_VERSION,
          "apps/landing/src/data/changelog-release-dates.json",
        ].includes(filename),
    )
    .flatMap(({ filename }) =>
      ["base", "head"].map((side) => ({
        filename,
        revision: side === "base" ? revisions.base : revisions.head,
        side,
      })),
    );
  const contents = new Map<string, string>();
  const [owner, name] = repo.split("/");
  for (let start = 0; start < requests.length; start += 40) {
    const batch = requests.slice(start, start + 40);
    const fields = batch
      .map(
        ({ filename, revision }, index) =>
          `blob${index}: object(expression: ${JSON.stringify(`${revision}:${filename}`)}) { ... on Blob { text } }`,
      )
      .join(" ");
    const query = `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${fields} } }`;
    const response = v.parse(
      v.object({
        errors: v.optional(v.unknown()),
        data: v.optional(v.object({ repository: objectSchema })),
      }),
      api("graphql", ["-f", `query=${query}`]),
    );
    if (response.errors !== undefined || response.data === undefined) {
      refuse("failed to read immutable release file contents");
    }
    for (const [index, { filename, side }] of batch.entries()) {
      const blob = v.safeParse(
        v.object({ text: v.string() }),
        response.data.repository[`blob${index}`],
      );
      if (!blob.success) {
        refuse(`${filename}: unavailable file contents`);
      }
      contents.set(`${side}:${filename}`, blob.output.text);
    }
  }
  validateReleaseContent({
    files,
    read: (side, filename) =>
      contents.get(`${side}:${filename}`) ??
      refuse(`${filename}: unavailable file contents`),
  });
  const current = v.parse(pullSchema, api(endpoint));
  if (!isDeepStrictEqual(current, pull)) {
    refuse(
      "release PR changed during content validation; retry at the new head",
    );
  }
};

type CheckReleaseMergeGroupOptions = {
  repo: string;
  group: { base_sha: string; head_sha: string; head_ref: string };
  numbers: readonly number[];
  api: GithubApi;
};
export const checkReleaseMergeGroup = ({
  repo,
  group,
  numbers,
  api,
}: CheckReleaseMergeGroupOptions): void => {
  if (numbers.length === 0) {
    return;
  }
  const comparison = v.parse(
    v.object({
      total_commits: v.number(),
      commits: v.array(v.object({ sha: v.string() })),
    }),
    api(`repos/${repo}/compare/${group.base_sha}...${group.head_sha}`),
  );
  if (comparison.total_commits !== comparison.commits.length) {
    refuse("incomplete merge group commit listing");
  }
  const entry =
    /\/pr-([0-9]+)-[0-9a-f]+$/u.exec(group.head_ref)?.at(1) ??
    refuse("invalid merge group ref");
  const included = new Set([Number(entry)]);
  // Queue commits can be squashed: PR-head ancestry is not a membership test.
  for (const { sha } of comparison.commits) {
    const pulls = v
      .parse(
        v.array(v.array(v.object({ number: v.number() }))),
        api(`repos/${repo}/commits/${sha}/pulls?per_page=100`, [
          "--paginate",
          "--slurp",
        ]),
      )
      .flat();
    for (const { number } of pulls) {
      included.add(number);
    }
  }
  for (const number of numbers) {
    if (included.has(number)) {
      checkReleasePullRequest({ repo, number, api });
    }
  }
};

const command = (args: readonly string[]): string => {
  const result = Bun.spawnSync([...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    refuse(result.stderr.toString());
  }
  return result.stdout.toString();
};

if (import.meta.main) {
  const repo =
    process.env["GITHUB_REPOSITORY"] ?? refuse("GITHUB_REPOSITORY is required");
  const eventPath =
    process.env["GITHUB_EVENT_PATH"] ?? refuse("GITHUB_EVENT_PATH is required");
  const api: GithubApi = (endpoint, options = []) =>
    JSON.parse(
      command([
        "bash",
        `${import.meta.dir}/gh-retry.sh`,
        "api",
        endpoint,
        ...options,
      ]),
    );
  const event = v.parse(
    v.object({
      number: v.optional(v.number()),
      merge_group: v.optional(
        v.object({
          base_sha: v.string(),
          head_sha: v.string(),
          head_ref: v.string(),
        }),
      ),
    }),
    await Bun.file(eventPath).json(),
  );
  const recognition = command([
    "bash",
    `${import.meta.dir}/release-pull-requests.sh`,
    "--repo",
    repo,
    ...(event.number === undefined ? [] : ["--number", String(event.number)]),
  ]);
  if (process.env["GITHUB_EVENT_NAME"] === "pull_request") {
    if (recognition.includes("current_is_release=true")) {
      checkReleasePullRequest({
        repo,
        number: event.number ?? refuse("missing pull request number"),
        api,
      });
    }
  } else if (process.env["GITHUB_EVENT_NAME"] === "merge_group") {
    const group = event.merge_group ?? refuse("missing merge group");
    const numbers =
      recognition
        .split("\n")
        .find((line) => line.startsWith("release_numbers="))
        ?.slice("release_numbers=".length) ??
      refuse("missing release recognition listing");
    checkReleaseMergeGroup({
      repo,
      group,
      numbers: numbers.split(" ").filter(Boolean).map(Number),
      api,
    });
  }
}
