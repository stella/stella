import { panic, Result, TaggedError } from "better-result";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { sha256Hex } from "@stll/sha256/bun";

import { disarmRemoval, probeEntry } from "./dated-waiver-healing";
import { createProbeBudget, removeWaiver } from "./dated-waiver-probes";
import {
  githubRequest,
  listRemovalProposals,
  publishRemoval,
  retireRemoval,
  type PublishedRemoval,
  type RemovalProposal,
} from "./dated-waiver-publish";
import { trackedPolicyFiles } from "./dated-waiver-tracked-files";
import {
  dueWaivers,
  expiryInstant,
  loadWaivers,
  type DatedWaiver,
  waiverKey,
} from "./dated-waivers";

const root = path.resolve(import.meta.dir, "..");
export const OWNER_REASON_REQUIRED = "OWNER_REASON_REQUIRED";
export type RadarGroup = { key: string; entries: DatedWaiver[] };
export const radarGroups = (
  inventory: readonly DatedWaiver[],
): RadarGroup[] => {
  const groups = new Map<string, RadarGroup>();
  for (const entry of inventory) {
    const identity =
      entry.kind === "release-age-exclusion"
        ? JSON.stringify([entry.kind, entry.id, entry.expiresAt])
        : waiverKey(entry);
    const existing = groups.get(identity);
    if (existing) {
      existing.entries.push(entry);
    } else {
      groups.set(identity, {
        key:
          entry.kind === "release-age-exclusion"
            ? sha256Hex(identity).slice(0, 24)
            : waiverKey(entry),
        entries: [entry],
      });
    }
  }
  return [...groups.values()];
};

type RadarOrphansOptions = {
  inventory: readonly DatedWaiver[];
  proposals: readonly RemovalProposal[];
  readBody: (proposal: RemovalProposal) => Promise<string>;
};
export const orphanRadarRemovals = async ({
  inventory,
  proposals,
  readBody,
}: RadarOrphansOptions): Promise<RemovalProposal[]> => {
  const current = new Set(radarGroups(inventory).map(({ key }) => key));
  const orphans: RemovalProposal[] = [];
  for (const proposal of proposals) {
    if (current.has(proposal.key)) {
      continue;
    }
    const body = await readBody(proposal);
    // Extensions remain with their owner even when their original deadline
    // changes; only machine-owned removal proposals can be retired here.
    if (
      body.includes("<!-- dated-exception-radar:1 -->") &&
      /^dated-exception-action: removal$/mu.test(body) &&
      !/^dated-exception-action: extension$/mu.test(body)
    ) {
      orphans.push(proposal);
    }
  }
  return orphans;
};
const discoverRadarOrphans = async (inventory: readonly DatedWaiver[]) =>
  orphanRadarRemovals({
    inventory,
    proposals: await listRemovalProposals({
      repo: "stella/stella",
      request: githubRequest,
    }),
    readBody: async ({ branch }) => {
      const pulls = v.parse(
        v.array(v.object({ body: v.nullish(v.string(), "") })),
        await githubRequest([
          `repos/stella/stella/pulls?state=open&base=main&head=stella:${branch}`,
        ]),
      );
      if (pulls.length !== 1) {
        panic("Radar proposal changed during discovery");
      }
      return (
        pulls.at(0)?.body ?? panic("Radar proposal missing during discovery")
      );
    },
  });

export const radarWriteNeeded = (
  entries: number,
  orphans: readonly RemovalProposal[],
  discoveryFailed = false,
) => entries > 0 || orphans.length > 0 || discoveryFailed;
export type RadarStatus = "green" | "red" | "waiting";
export const radarAction = (
  group: RadarGroup,
  status: RadarStatus,
  now: Date,
) => {
  const entry = group.entries.at(0);
  if (!entry) {
    return panic("Empty dated-exception group");
  }
  if (entry.kind === "release-age-exclusion") {
    return {
      kind: "removal",
      arm: now.getTime() >= Date.parse(expiryInstant(entry.expiresAt)),
    } as const;
  }
  return status === "green"
    ? ({ kind: "removal", arm: true } as const)
    : ({ kind: "extension", arm: false } as const);
};
export const radarFiles = (
  group: RadarGroup,
  read: (source: string) => string,
) => {
  const files = new Map<string, string>();
  const baseFiles = new Map<string, string>();
  for (const entry of group.entries) {
    for (const change of removeWaiver(
      entry,
      (source) => files.get(source) ?? read(source),
    )) {
      if (!baseFiles.has(change.source)) {
        baseFiles.set(change.source, change.before);
      }
      files.set(change.source, change.after);
    }
  }
  return {
    files: Object.fromEntries(files),
    baseFiles: Object.fromEntries(baseFiles),
  };
};
export const extensionProposal = (group: RadarGroup) => ({
  schemaVersion: 1,
  kind: "extension",
  entries: group.entries.map(({ kind, source, id, expiresAt }) => ({
    kind,
    source,
    id,
    expiresAt,
  })),
  ownerReason: OWNER_REASON_REQUIRED,
});
export const radarBody = (
  group: RadarGroup,
  kind: "removal" | "extension",
  now: Date,
) =>
  [
    "<!-- dated-exception-radar:1 -->",
    `dated-exception-action: ${kind}`,
    `dated-exception-ready: ${kind === "removal" && radarAction(group, "green", now).arm}`,
    "",
    kind === "removal"
      ? "Remove a dated exception when its guard permits removal."
      : "Owner action required: resolve the exception or update its deadline with a concrete reason.",
    "",
    `owner-reason: ${kind === "extension" ? OWNER_REASON_REQUIRED : "Removal verified by the dated-exception radar."}`,
    "",
    ...group.entries.map(
      ({ kind: entryKind, source, id, expiresAt }) =>
        `- ${entryKind}: ${source}: ${id}; expiry ${expiresAt.slice(0, 10)}`,
    ),
  ].join("\n");

type PublishRadarOptions = {
  groups: readonly RadarGroup[];
  statuses: ReadonlyMap<string, RadarStatus>;
  now: Date;
  publish: (
    group: RadarGroup,
    kind: "removal" | "extension",
  ) => Promise<PublishedRemoval | undefined>;
  arm: (removal: PublishedRemoval) => Promise<void>;
};
export class RadarPublishFailure extends TaggedError("RadarPublishFailure")<{
  message: string;
  keys: string[];
}> {}
export const publishRadar = async ({
  groups,
  statuses,
  now,
  publish,
  arm,
}: PublishRadarOptions) => {
  const failed: string[] = [];
  for (const group of groups) {
    const result = await Result.tryPromise(async () => {
      const status = statuses.get(group.key);
      if (!status) {
        panic("Missing dated-exception probe evidence");
      }
      const action = radarAction(group, status, now);
      const proposal = await publish(group, action.kind);
      if (proposal && action.arm) {
        await arm(proposal);
      }
    });
    if (Result.isError(result)) {
      failed.push(group.key);
    }
  }
  if (failed.length > 0) {
    throw new RadarPublishFailure({
      message: "Dated-exception proposals require attention",
      keys: failed,
    });
  }
};

export const validateRadarRemoval = ({
  inventory,
  branch,
  files,
  read,
  now,
}: {
  inventory: readonly DatedWaiver[];
  branch: string;
  files: Readonly<Record<string, string>>;
  read: (source: string) => string;
  now: Date;
}): void => {
  const group = radarGroups(dueWaivers(inventory, now, 3)).find(
    ({ key }) => branch === `chore/dated-waiver-${key}`,
  );
  if (!group) {
    panic("Removal does not match a due owner entry");
  }
  if (
    group.entries.some(
      (entry) =>
        entry.kind === "release-age-exclusion" &&
        now.getTime() < Date.parse(expiryInstant(entry.expiresAt)),
    )
  ) {
    panic("Release-age removal is not eligible before expiry");
  }
  const expected = radarFiles(group, read).files;
  const names = Object.keys(expected).toSorted();
  if (
    JSON.stringify(Object.keys(files).toSorted()) !== JSON.stringify(names) ||
    names.some((name) => files[name] !== expected[name])
  ) {
    panic("Removal differs from the complete owner-derived edit");
  }
};
const validateRemoteRemoval = async (
  inventory: readonly DatedWaiver[],
  now: Date,
) => {
  const number = process.argv.at(process.argv.indexOf("--number") + 1);
  const head = process.argv.at(process.argv.indexOf("--expected-head") + 1);
  if (
    !number ||
    !/^[1-9][0-9]*$/u.test(number) ||
    !head ||
    !/^[a-f0-9]{40}$/u.test(head)
  ) {
    panic("Removal validation requires exact PR and head");
  }
  const pull = v.parse(
    v.object({ head: v.object({ ref: v.string(), sha: v.string() }) }),
    await githubRequest([`repos/stella/stella/pulls/${number}`]),
  );
  if (pull.head.sha !== head) {
    panic("Removal head changed");
  }
  const files = new Map<string, string>();
  for (let page = 1; ; page++) {
    const changes = v.parse(
      v.array(v.object({ filename: v.string(), status: v.string() })),
      await githubRequest([
        `repos/stella/stella/pulls/${number}/files?per_page=100&page=${page}`,
      ]),
    );
    for (const change of changes) {
      if (change.status !== "modified") {
        panic("Removal must only modify owner files");
      }
      const content = v.parse(
        v.object({ content: v.string(), encoding: v.literal("base64") }),
        await githubRequest([
          `repos/stella/stella/contents/${change.filename}?ref=${head}`,
        ]),
      );
      files.set(
        change.filename,
        Buffer.from(content.content, "base64").toString("utf-8"),
      );
    }
    if (changes.length < 100) {
      break;
    }
  }
  validateRadarRemoval({
    inventory,
    branch: pull.head.ref,
    files: Object.fromEntries(files),
    read: (source) => readFileSync(path.join(root, source), "utf-8"),
    now,
  });
  const latest = v.parse(
    v.object({
      state: v.string(),
      draft: v.boolean(),
      head: v.object({ sha: v.string() }),
    }),
    await githubRequest([`repos/stella/stella/pulls/${number}`]),
  );
  if (latest.state !== "open" || latest.draft || latest.head.sha !== head) {
    panic("Removal changed during validation");
  }
};

type ExistingRadarOptions = {
  key: string;
  kind: "removal" | "extension";
  body: string;
  baseSha: string;
  files: Readonly<Record<string, string>>;
  request: typeof githubRequest;
};
// `owner` is an open extension request: it belongs to its owner whatever the
// radar would publish now, so it is never replaced, refreshed or armed.
export type ExistingRadarProposal =
  | { state: "owner"; proposal: PublishedRemoval }
  | { state: "current"; proposal: PublishedRemoval };
export const existingRadarProposal = async ({
  key,
  kind,
  body,
  baseSha,
  files,
  request,
}: ExistingRadarOptions): Promise<ExistingRadarProposal | undefined> => {
  const pulls = v.parse(
    v.array(
      v.object({
        number: v.number(),
        body: v.nullish(v.string(), ""),
        head: v.object({ sha: v.string() }),
        base: v.object({ sha: v.string() }),
      }),
    ),
    await request([
      `repos/stella/stella/pulls?state=open&base=main&head=stella:chore/dated-waiver-${key}`,
    ]),
  );
  if (pulls.length > 1) {
    panic("Multiple radar proposals for reserved branch");
  }
  const pull = pulls.at(0);
  if (!pull) {
    return undefined;
  }
  const proposal = { number: pull.number, headSha: pull.head.sha };
  // Extension proposals belong to their owner after creation; no later run,
  // including a green probe that selects removal, may overwrite a human's
  // reason or proposed source deadline.
  if (
    pull.body.includes("<!-- dated-exception-radar:1 -->") &&
    /^dated-exception-action: extension$/mu.test(pull.body) &&
    !/^dated-exception-action: removal$/mu.test(pull.body)
  ) {
    return { state: "owner", proposal };
  }
  if (kind === "extension") {
    return undefined;
  }
  if (pull.base.sha !== baseSha || pull.body !== body) {
    return undefined;
  }
  const changes: string[] = [];
  for (let page = 1; ; page++) {
    const batch = v.parse(
      v.array(v.object({ filename: v.string(), status: v.string() })),
      await request([
        `repos/stella/stella/pulls/${pull.number}/files?per_page=100&page=${page}`,
      ]),
    );
    if (batch.some(({ status }) => status !== "modified")) {
      return undefined;
    }
    changes.push(...batch.map(({ filename }) => filename));
    if (batch.length < 100) {
      break;
    }
  }
  if (
    JSON.stringify(changes.toSorted()) !==
    JSON.stringify(Object.keys(files).toSorted())
  ) {
    return undefined;
  }
  for (const [file, expected] of Object.entries(files)) {
    const content = v.parse(
      v.object({ content: v.string(), encoding: v.literal("base64") }),
      await request([
        `repos/stella/stella/contents/${file}?ref=${pull.head.sha}`,
      ]),
    );
    if (Buffer.from(content.content, "base64").toString("utf-8") !== expected) {
      return undefined;
    }
  }
  return { state: "current", proposal };
};

// What a run does with the open proposal on the reserved branch: reuse the
// radar's current one, leave an owner's request untouched (never armed), or
// publish a fresh one.
export const radarReuse = (
  existing: ExistingRadarProposal | undefined,
  kind: "removal" | "extension",
):
  | { publish: true }
  | { publish: false; proposal: PublishedRemoval | undefined } => {
  if (existing === undefined) {
    return { publish: true };
  }
  if (existing.state === "owner") {
    return {
      publish: false,
      proposal: kind === "extension" ? existing.proposal : undefined,
    };
  }
  return { publish: false, proposal: existing.proposal };
};

const gitSha = () => {
  const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root });
  if (result.exitCode !== 0) {
    panic("Cannot read radar checkout SHA");
  }
  return result.stdout.toString().trim();
};
const reportSchema = v.object({
  sha: v.string(),
  now: v.pipe(v.string(), v.isoTimestamp()),
  entries: v.array(
    v.object({
      key: v.string(),
      status: v.picklist(["green", "red", "waiting"]),
    }),
  ),
});
const main = async () => {
  if (process.argv.includes("--validate-removal")) {
    return validateRemoteRemoval(loadWaivers(trackedPolicyFiles()), new Date());
  }
  const evidence = process.argv.at(process.argv.indexOf("--evidence") + 1);
  if (!process.argv.includes("--evidence") || !evidence) {
    panic("Radar evidence path required");
  }
  const inventory = loadWaivers(trackedPolicyFiles());
  if (process.argv.includes("--probe")) {
    const now = new Date();
    const groups = radarGroups(dueWaivers(inventory, now, 3));
    const budget = createProbeBudget({
      attempts: groups.reduce(
        (total, group) =>
          total +
          group.entries.reduce(
            (count, entry) => count + entry.probe.attempts,
            0,
          ),
        0,
      ),
    });
    const entries = [];
    for (const group of groups) {
      let status: RadarStatus = "green";
      for (const entry of group.entries) {
        if (entry.kind === "release-age-exclusion") {
          status = "waiting";
          continue;
        }
        const probe = await Result.tryPromise(async () =>
          probeEntry({ entry, sha: gitSha(), budget }),
        );
        if (Result.isError(probe) || probe.value.status !== "green") {
          status = "red";
        }
      }
      entries.push({ key: group.key, status });
    }
    writeFileSync(
      evidence,
      JSON.stringify({ sha: gitSha(), now: now.toISOString(), entries }),
      {
        mode: 0o600,
      },
    );
    const orphans = await Result.tryPromise(async () =>
      discoverRadarOrphans(inventory),
    );
    if (process.env["GITHUB_OUTPUT"]) {
      appendFileSync(
        process.env["GITHUB_OUTPUT"],
        `write_needed=${radarWriteNeeded(entries.length, Result.isOk(orphans) ? orphans.value : [], Result.isError(orphans))}\n`,
      );
    }
    return;
  }
  if (
    !process.argv.includes("--publish") ||
    process.env["GITHUB_REPOSITORY"] !== "stella/stella"
  ) {
    panic("Radar publishing requires repository workflow");
  }
  const report = v.parse(
    reportSchema,
    JSON.parse(readFileSync(evidence, "utf-8")),
  );
  if (report.sha !== gitSha()) {
    panic("Radar evidence checkout mismatch");
  }
  // Publish on the probe's clock: a waiver that turns due between the two
  // steps has no probe evidence yet and waits for the next run.
  const now = new Date(report.now);
  const groups = radarGroups(dueWaivers(inventory, now, 3));
  const statuses = new Map(
    report.entries.map(({ key, status }) => [key, status]),
  );
  const orphanFailures: string[] = [];
  const discovered = await Result.tryPromise(async () =>
    discoverRadarOrphans(inventory),
  );
  if (Result.isError(discovered)) {
    orphanFailures.push("discovery");
  }
  for (const proposal of Result.isOk(discovered) ? discovered.value : []) {
    const retired = await Result.tryPromise(async () =>
      retireRemoval({
        branch: proposal.branch,
        repo: "stella/stella",
        request: githubRequest,
        disarm: disarmRemoval,
      }),
    );
    if (Result.isError(retired)) {
      orphanFailures.push(proposal.key);
    }
  }
  await publishRadar({
    groups,
    statuses,
    now,
    publish: async (group, kind) => {
      const file = `.github/dated-exception-proposals/${group.key}.json`;
      const changes =
        kind === "removal"
          ? radarFiles(group, (source) =>
              readFileSync(path.join(root, source), "utf-8"),
            )
          : {
              files: {
                [file]: `${JSON.stringify(extensionProposal(group), null, 2)}\n`,
              },
              baseFiles: {},
            };
      const body = radarBody(group, kind, now);
      const existing = await existingRadarProposal({
        key: group.key,
        kind,
        body,
        baseSha: report.sha,
        files: changes.files,
        request: githubRequest,
      });
      const reuse = radarReuse(existing, kind);
      if (!reuse.publish) {
        return reuse.proposal;
      }
      return publishRemoval({
        branch: `chore/dated-waiver-${group.key}`,
        baseSha: report.sha,
        ...changes,
        ...(kind === "extension"
          ? { title: "chore: request dated exception owner review" }
          : {}),
        body,
        repo: process.env["GITHUB_REPOSITORY"],
        request: githubRequest,
        disarmExisting: disarmRemoval,
      });
    },
    arm: async ({ number, headSha }) => {
      if (process.env["MERGE_HOLD"]) {
        return;
      }
      await githubRequest(
        [
          "repos/stella/stella/actions/workflows/bot-refresh-auto-merge.yml/dispatches",
          "--method",
          "POST",
          "--input",
          "-",
        ],
        {
          ref: "main",
          inputs: { number: String(number), expectedHead: headSha },
        },
      );
    },
  });
  if (orphanFailures.length > 0) {
    throw new RadarPublishFailure({
      message: "Orphan removal proposals require attention",
      keys: orphanFailures,
    });
  }
};
if (import.meta.main) {
  const result = await Result.tryPromise(main);
  if (Result.isError(result)) {
    console.error(
      "Dated-exception radar failed; inspect repository policy and evidence.",
    );
    process.exitCode = 1;
  }
}
