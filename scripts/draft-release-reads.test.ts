import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";

// A release is a draft until its channel publishes it, and GitHub shows a
// draft only to a token with push access: a `contents: read` token gets a
// 404 for it, the same answer as for a release that does not exist. Every
// job that reads a release therefore holds `contents: write` (its own token
// or a minted App token), unless the release it reads is published by
// construction; those jobs are listed here with the reason, so a new
// read-only reader fails until it is classified.
const PUBLISHED_ONLY_READERS: Readonly<Record<string, string>> = {
  "release.yml/publish-chrome-extension":
    "runs only for a stable release after publish-release succeeds",
  "release.yml/release-health-gate":
    "reads the previous stable release, published before this one is cut",
  "release.yml/release-complete":
    "asks whether the release is published; a hidden draft is the not-yet-published answer",
  "release-desktop.yml/resolve":
    "runs after production publication, or on manual recovery of a stable ref production already serves",
};

const ROOT = path.join(import.meta.dir, "..");
const WORKFLOWS = path.join(ROOT, ".github/workflows");
const RELEASE_READ = /\brelease\s+(?:download|view|edit|upload)\b/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const scriptReadsRelease = (name: string): boolean => {
  const file = path.join(ROOT, "scripts", name);
  return existsSync(file) && RELEASE_READ.test(readFileSync(file, "utf-8"));
};

// Inline commands, plus repository scripts a step runs (directly or after
// copying them to the runner's temp directory).
export const readsRelease = (run: string): boolean =>
  RELEASE_READ.test(run) ||
  [...run.matchAll(/[\w./$-]*?([\w-]+\.sh)\b/gu)].some(([, name]) =>
    name === undefined ? false : scriptReadsRelease(name),
  );

export const canSeeDrafts = (permissions: unknown): boolean =>
  permissions === "write-all" ||
  (isRecord(permissions) && permissions["contents"] === "write");

const mintsContentsWriteToken = (steps: unknown[]): boolean =>
  steps.some(
    (step) =>
      isRecord(step) &&
      typeof step["uses"] === "string" &&
      step["uses"].startsWith("actions/create-github-app-token@") &&
      isRecord(step["with"]) &&
      step["with"]["permission-contents"] === "write",
  );

// A release read that swaps in another token on its own line bypasses the
// job-level check above.
export const swapsTokenForRelease = (line: string): boolean =>
  RELEASE_READ.test(line) && /\bGH_TOKEN=/u.test(line);

const releaseReaders = () =>
  readdirSync(WORKFLOWS)
    .filter((file) => file.endsWith(".yml"))
    .flatMap((file) => {
      const parsed: unknown = Bun.YAML.parse(
        readFileSync(path.join(WORKFLOWS, file), "utf-8"),
      );
      if (!isRecord(parsed) || !isRecord(parsed["jobs"])) {
        return [];
      }
      const inherited = parsed["permissions"];
      return Object.entries(parsed["jobs"]).flatMap(([name, job]) => {
        if (!isRecord(job) || !Array.isArray(job["steps"])) {
          return [];
        }
        const reads = job["steps"].some(
          (step: unknown) =>
            isRecord(step) &&
            typeof step["run"] === "string" &&
            readsRelease(step["run"]),
        );
        if (!reads) {
          return [];
        }
        const permissions =
          "permissions" in job ? job["permissions"] : inherited;
        return [
          {
            id: `${file}/${name}`,
            drafts:
              canSeeDrafts(permissions) ||
              mintsContentsWriteToken(job["steps"]),
          },
        ];
      });
    });

describe("release reads", () => {
  const readers = releaseReaders();

  test("every job that reads a release can see a draft, or is classified", () => {
    const unclassified = readers
      .filter(({ id, drafts }) => !drafts && !(id in PUBLISHED_ONLY_READERS))
      .map(({ id }) => id);
    expect(unclassified).toEqual([]);
  });

  test("every published-only entry is still a read-only release reader", () => {
    const readOnly = new Set(
      readers.filter(({ drafts }) => !drafts).map(({ id }) => id),
    );
    expect(
      Object.keys(PUBLISHED_ONLY_READERS).filter((id) => !readOnly.has(id)),
    ).toEqual([]);
  });

  test("the candidate's staging proof reads its draft manifest", () => {
    const ids = new Set(
      readers.filter(({ drafts }) => drafts).map(({ id }) => id),
    );
    expect(ids.has("deploy-staging.yml/rc-manifest")).toBe(true);
    expect(ids.has("release.yml/prepare-web-image")).toBe(true);
    expect(ids.has("release.yml/prepare-production-web-image")).toBe(true);
    expect(ids.has("release-tag.yml/finalize")).toBe(true);
  });

  test("no release read swaps in another token inline", () => {
    const files = [
      ...readdirSync(WORKFLOWS)
        .filter((file) => file.endsWith(".yml"))
        .map((file) => path.join(WORKFLOWS, file)),
      ...readdirSync(path.join(ROOT, "scripts"))
        .filter((file) => file.endsWith(".sh"))
        .map((file) => path.join(ROOT, "scripts", file)),
    ];
    const swaps = files.flatMap((file) =>
      readFileSync(file, "utf-8")
        .split("\n")
        .flatMap((line, index) =>
          swapsTokenForRelease(line)
            ? [`${repoRelativePath(ROOT, file)}:${index + 1}`]
            : [],
        ),
    );
    expect(swaps).toEqual([]);
    expect(
      swapsTokenForRelease(
        'x=$(GH_TOKEN="$READ_TOKEN" bash "$gh_retry_script" release view "$rc")',
      ),
    ).toBe(true);
    expect(swapsTokenForRelease('bash "$gh" release view "$rc"')).toBe(false);
  });

  test("the scan sees reads inline and through repository scripts", () => {
    expect(readsRelease('gh release view "$TAG"')).toBe(true);
    expect(
      readsRelease('bash "$GH_RETRY_SCRIPT" release download "$REF" --dir d'),
    ).toBe(true);
    expect(readsRelease("bash scripts/build-updater-manifest.sh")).toBe(true);
    expect(
      readsRelease('bash "$RUNNER_TEMP/detect-desktop-release-changes.sh"'),
    ).toBe(true);
    expect(readsRelease("gh run view 1 && echo released")).toBe(false);
  });

  test("only a write token counts as seeing drafts", () => {
    expect(canSeeDrafts({ contents: "write" })).toBe(true);
    expect(canSeeDrafts("write-all")).toBe(true);
    expect(canSeeDrafts({ contents: "read", packages: "write" })).toBe(false);
    expect(canSeeDrafts("read-all")).toBe(false);
    expect(canSeeDrafts(undefined)).toBe(false);
  });
});
