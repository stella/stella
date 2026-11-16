import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  DOC_SOURCE_EXCLUSIONS,
  type NoLlmsTxtExclusion,
} from "../.claude/mcp/doc-sources";
import type { FixEvidence } from "./dated-waiver-fix-task";
import {
  applyHealing,
  discoverPendingProposals,
  type HealingActions,
  type HealingEntry,
  healingWriteNeeded,
  RENEWAL_FAILURE_KEY,
  renewalRecords,
} from "./dated-waiver-healing";
import { removeWaiver, runWaiverProbe } from "./dated-waiver-probes";
import {
  type PublishedRemoval,
  RENEWAL_BRANCH,
  RENEWAL_TITLE,
  retireRemoval,
} from "./dated-waiver-publish";
import {
  planDocRenewal,
  renderRenewalEvidence,
  RENEWAL_DAYS,
  renewalDates,
  type RenewalRecord,
} from "./dated-waiver-renewal";
import {
  type DatedWaiver,
  DAY_MS,
  DOC_SOURCE_FILE,
  docProbeUrl,
  dueWaivers,
  NETWORK_ATTEMPTS,
} from "./dated-waivers";

const NOW = new Date("2026-10-26T04:41:00.000Z");
const RENEWED = {
  checkedAt: "2026-10-26T00:00:00.000Z",
  expiresAt: "2026-11-25T00:00:00.000Z",
};

const docWaiver = (
  id: string,
  dates: { checkedAt: string; expiresAt: string },
  url = `https://${id}.example/llms.txt`,
): DatedWaiver => ({
  source: DOC_SOURCE_FILE,
  line: 1,
  id,
  kind: "no-llms-txt",
  ...dates,
  probe: {
    command: ["bun", "scripts/dated-waiver-probes.ts", "--doc-url", url],
    attempts: NETWORK_ATTEMPTS,
  },
});
const SOON = {
  checkedAt: "2026-09-30T00:00:00.000Z",
  expiresAt: "2026-10-30T00:00:00.000Z",
};
const LATER = {
  checkedAt: "2026-10-20T00:00:00.000Z",
  expiresAt: "2026-11-19T00:00:00.000Z",
};

// Every declaration shape the owner uses: inline objects, a mapped name list
// with literal dates, and a mapped tuple list whose dates are shared constants.
const OWNER = `export const DOC_SOURCES = {
  Zod: { dependencies: ["zod"], url: "https://zod.dev/llms.txt" },
} as const;

const GROUP_CHECKED_AT = "${SOON.checkedAt}";
const GROUP_EXPIRES_AT = "${SOON.expiresAt}";
const GROUP = [
  ["grouped-a", ["https://grouped-a.example/llms.txt"]],
  ["grouped-b", ["https://grouped-b.example/llms.txt"]],
] as const;
const fromGroup = ([dependency, urls]: readonly [string, readonly string[]]) => ({
  checkedAt: GROUP_CHECKED_AT,
  dependency,
  explanation: \`\${urls.join(" and ")} returns no llms.txt.\`,
  expiresAt: GROUP_EXPIRES_AT,
  reason: "no-llms-txt",
});

export const DOC_SOURCE_EXCLUSIONS = GROUP.map(fromGroup).concat(
  ...["listed-a", "listed-b"].map(
    (dependency) =>
      ({
        checkedAt: "${SOON.checkedAt}",
        dependency,
        explanation: "https://listed.example/llms.txt returns 404.",
        expiresAt: "${SOON.expiresAt}",
        reason: "no-llms-txt",
      }) satisfies object,
  ),
  {
    checkedAt: "${SOON.checkedAt}",
    dependency: "soon",
    explanation: "https://soon.example/llms.txt returns 404.",
    expiresAt: "${SOON.expiresAt}",
    reason: "no-llms-txt",
  },
  {
    checkedAt: "${LATER.checkedAt}",
    dependency: "later",
    explanation: "https://later.example/llms.txt returns 404.",
    expiresAt: "${LATER.expiresAt}",
    reason: "no-llms-txt",
  },
);
`;

const importOwner = async (
  source: string,
): Promise<readonly NoLlmsTxtExclusion[]> => {
  const directory = mkdtempSync(path.join(tmpdir(), "doc-renewal-"));
  try {
    const file = path.join(directory, "doc-sources.ts");
    writeFileSync(file, source);
    const module: unknown = await import(file);
    return v.parse(
      v.object({
        DOC_SOURCE_EXCLUSIONS: v.array(
          v.object({
            checkedAt: v.string(),
            dependency: v.string(),
            explanation: v.string(),
            expiresAt: v.string(),
            reason: v.literal("no-llms-txt"),
          }),
        ),
      }),
      module,
    ).DOC_SOURCE_EXCLUSIONS;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};
const datesOf = (exclusions: readonly NoLlmsTxtExclusion[]) =>
  Object.fromEntries(
    exclusions.map(({ dependency, checkedAt, expiresAt }) => [
      dependency,
      { checkedAt, expiresAt },
    ]),
  );

test("renewal records the check at its UTC day and stays inside the owner's 31-day policy", () => {
  expect(renewalDates(NOW)).toEqual(RENEWED);
  expect(RENEWAL_DAYS * DAY_MS).toBeLessThanOrEqual(31 * DAY_MS);
});

test("only waivers inside the healing window are probed, so later ones are untouched", () => {
  const due = dueWaivers(
    [docWaiver("soon", SOON), docWaiver("later", LATER)],
    NOW,
  );
  expect(due.map(({ id }) => id)).toEqual(["soon"]);
});

test("a confirmed-absent waiver renews in place and every other entry keeps its dates", async () => {
  const plan = planDocRenewal({
    source: OWNER,
    absent: [docWaiver("soon", SOON)],
    now: NOW,
  });
  expect(plan.renewed.map(({ id }) => id)).toEqual(["soon"]);
  expect(plan.held).toEqual([]);
  expect(Object.keys(plan.files)).toEqual([DOC_SOURCE_FILE]);
  expect(plan.baseFiles[DOC_SOURCE_FILE]).toBe(OWNER);
  const after = datesOf(await importOwner(plan.files[DOC_SOURCE_FILE] ?? ""));
  expect(after).toEqual({
    "grouped-a": SOON,
    "grouped-b": SOON,
    "listed-a": SOON,
    "listed-b": SOON,
    soon: RENEWED,
    later: LATER,
  });
});

test("shared dates renew only when every entry sharing them is confirmed absent", async () => {
  const partial = planDocRenewal({
    source: OWNER,
    absent: [docWaiver("grouped-a", SOON), docWaiver("listed-a", SOON)],
    now: NOW,
  });
  expect(partial.renewed).toEqual([]);
  expect(partial.held.map(({ id }) => id)).toEqual(["grouped-a", "listed-a"]);
  expect(partial.files).toEqual({});

  const whole = planDocRenewal({
    source: OWNER,
    absent: ["grouped-a", "grouped-b", "listed-a", "listed-b"].map((id) =>
      docWaiver(id, SOON),
    ),
    now: NOW,
  });
  expect(whole.held).toEqual([]);
  const after = whole.files[DOC_SOURCE_FILE] ?? "";
  expect(after).toContain(`const GROUP_EXPIRES_AT = "${RENEWED.expiresAt}"`);
  expect(datesOf(await importOwner(after))).toEqual({
    "grouped-a": RENEWED,
    "grouped-b": RENEWED,
    "listed-a": RENEWED,
    "listed-b": RENEWED,
    soon: SOON,
    later: LATER,
  });
});

test("shared date declarations renew as one connected group", () => {
  const source = `export const DOC_SOURCES = {};
const CHECKED_AT = "${SOON.checkedAt}";
const EXPIRES_AT = "${SOON.expiresAt}";
export const DOC_SOURCE_EXCLUSIONS = [
  { dependency: "a", checkedAt: CHECKED_AT, expiresAt: "${SOON.expiresAt}" },
  { dependency: "b", checkedAt: CHECKED_AT, expiresAt: EXPIRES_AT },
  { dependency: "c", checkedAt: "${SOON.checkedAt}", expiresAt: EXPIRES_AT },
];`;
  const entries = ["a", "b", "c"].map((id) => docWaiver(id, SOON));
  for (let subset = 0; subset < 2 ** entries.length; subset += 1) {
    const absent = entries.filter(
      (_entry, index) => Math.floor(subset / 2 ** index) % 2 === 1,
    );
    const plan = planDocRenewal({ source, absent, now: NOW });
    if (absent.length === entries.length) {
      expect(plan.renewed).toEqual(entries);
      expect(plan.held).toEqual([]);
      continue;
    }
    expect(plan.renewed).toEqual([]);
    expect(plan.held).toEqual(absent);
    expect(plan.files).toEqual({});
  }
  const plan = planDocRenewal({
    source,
    absent: entries.map((entry) =>
      entry.id === "a" ? { ...entry, checkedAt: LATER.checkedAt } : entry,
    ),
    now: NOW,
  });
  expect(plan.renewed).toEqual([]);
  expect(plan.files).toEqual({});
});

test("stale, lapsed or foreign evidence is held instead of renewed", () => {
  const plan = planDocRenewal({
    source: OWNER,
    absent: [
      docWaiver("soon", { ...SOON, expiresAt: "2026-10-29T00:00:00.000Z" }),
      docWaiver("missing", SOON),
      { ...docWaiver("later", LATER), kind: "dependency-audit" },
    ],
    now: NOW,
  });
  expect(plan.renewed).toEqual([]);
  expect(plan.held.map(({ id }) => id)).toEqual(["soon", "missing", "later"]);
  expect(
    planDocRenewal({
      source: OWNER,
      absent: [docWaiver("soon", SOON)],
      now: new Date(SOON.expiresAt),
    }).renewed,
  ).toEqual([]);
});

const sample = async (outputs: readonly (string | Error)[]) => {
  let index = 0;
  return runWaiverProbe(docWaiver("soon", SOON), {
    run: async () => {
      const output = outputs[index++ % outputs.length];
      if (output instanceof Error) {
        throw output;
      }
      return {
        passed: output?.includes("HTTP 200.") ?? false,
        output: output ?? "",
      };
    },
  });
};

test("only an absence receipt on every sample classifies a documentation waiver as absent", async () => {
  const receipt = (status: number) =>
    `Documentation endpoint returned HTTP ${status}.\n\n`;
  expect((await sample([receipt(404)])).status).toBe("absent");
  expect((await sample([receipt(410)])).status).toBe("absent");
  expect((await sample([receipt(200)])).status).toBe("green");
  for (const outputs of [
    [receipt(404), receipt(404), receipt(503)],
    [receipt(429)],
    ["Documentation endpoint request failed."],
    [`Probe attempt timed out.\n${receipt(404)}`],
    [new TypeError("spawn failed")],
    [receipt(404), receipt(200), receipt(404)],
  ]) {
    expect((await sample(outputs)).status).toBe("red");
  }
  // Absence never reclassifies another kind's failing probe.
  const audit = await runWaiverProbe(
    { ...docWaiver("soon", SOON), kind: "dependency-audit" },
    { run: async () => ({ passed: false, output: receipt(404) }) },
  );
  expect(audit.status).toBe("red");
});

const evidence = (passed: number): FixEvidence => ({
  attempts: NETWORK_ATTEMPTS,
  passed,
  command: docWaiver("x", SOON).probe.command,
  output: "private",
  runner: "Linux",
  sha: "base",
  sourceFingerprint: "fingerprint",
  observedAt: NOW.toISOString(),
  run: "run-link",
});
const outcome = (
  status: "green" | "red" | "absent",
  passed: number,
): HealingEntry["outcome"] => ({
  status,
  evidence: evidence(passed),
  files: {},
  baseFiles: {},
});

const healingScenario = () => {
  const effects: string[] = [];
  const actions: HealingActions = {
    retireRemoval: async (entry) => {
      effects.push(`retire:${entry.id}`);
    },
    assessRemoval: async () => ({ status: "eligible" as const }),
    resolveFixTask: async () => {},
    openRemoval: async ({ entry }) => {
      effects.push(`remove:${entry.id}`);
      return undefined;
    },
    armRemoval: async ({ number }: PublishedRemoval) => {
      effects.push(`arm:${number}`);
    },
    openFixTask: async (entry) => {
      effects.push(`fix:${entry.id}`);
      return { number: 7, state: "open" as const };
    },
    findTask: async () => undefined,
    alertExpiry: async () => {},
  };
  return { actions, effects };
};

test("one run renews every absent waiver in one armed proposal and reports the rest", async () => {
  const { actions, effects } = healingScenario();
  const published: string[][] = [];
  await applyHealing({
    now: NOW,
    actions,
    report: {
      sha: "base",
      observedAt: NOW.toISOString(),
      failures: [],
      entries: [
        { entry: docWaiver("absent-a", SOON), outcome: outcome("absent", 0) },
        { entry: docWaiver("absent-b", SOON), outcome: outcome("absent", 0) },
        { entry: docWaiver("available", SOON), outcome: outcome("green", 3) },
        { entry: docWaiver("offline", SOON), outcome: outcome("red", 0) },
      ],
    },
    renewal: {
      publish: async (records) => {
        published.push(records.map(({ entry }) => entry.id));
        return { number: 99, headSha: "a".repeat(40) };
      },
      retire: async () => {
        effects.push("retire-renewal");
      },
    },
  });
  expect(published).toEqual([["absent-a", "absent-b"]]);
  // The network failure reports through its private task and never renews.
  expect(effects).toContain("fix:offline");
  expect(effects).toContain("remove:available");
  expect(effects).toContain("arm:99");
  expect(effects).not.toContain("fix:absent-a");
  expect(effects).not.toContain("retire-renewal");
});

test("a run with nothing to renew retires the previous renewal proposal", async () => {
  const { actions, effects } = healingScenario();
  await applyHealing({
    now: NOW,
    actions,
    report: {
      sha: "base",
      observedAt: NOW.toISOString(),
      failures: [],
      entries: [
        { entry: docWaiver("offline", SOON), outcome: outcome("red", 0) },
      ],
    },
    renewal: {
      publish: async () => {
        throw new TypeError("nothing should publish");
      },
      retire: async () => {
        effects.push("retire-renewal");
      },
    },
  });
  expect(effects).toEqual(["fix:offline", "retire:offline", "retire-renewal"]);
});

// A GitHub fake holding one open renewal proposal on the reserved branch,
// visible to both the full proposal listing and the branch-filtered one.
const renewalGithub = () => {
  const pr = {
    number: 77,
    title: RENEWAL_TITLE,
    body: "Renew documentation waivers.",
    state: "open" as "open" | "closed",
    head: { ref: RENEWAL_BRANCH, repo: { full_name: "stella/stella" } },
    base: { ref: "main" },
  };
  const disarmed: number[] = [];
  const request = async (
    args: readonly string[],
    input?: unknown,
  ): Promise<unknown> => {
    const endpoint = args.at(0);
    if (endpoint === "repos/stella/stella/pulls" && args.includes("GET")) {
      const head = args.find((arg) => arg.startsWith("head="));
      const open = pr.state === "open" ? [{ ...pr }] : [];
      return head === undefined || head === `head=stella:${RENEWAL_BRANCH}`
        ? open
        : [];
    }
    if (endpoint === `repos/stella/stella/pulls/${pr.number}`) {
      const closed = v.parse(
        v.object({ state: v.literal("closed"), body: v.string() }),
        input,
      );
      pr.state = closed.state;
      pr.body = closed.body;
      return {};
    }
    throw new TypeError(`Unexpected GitHub call: ${String(endpoint)}`);
  };
  return { pr, disarmed, request };
};

test("an open renewal proposal with nothing due is discovered and closed", async () => {
  const github = renewalGithub();
  const empty = {
    sha: "base",
    observedAt: NOW.toISOString(),
    entries: [],
    failures: [],
  };
  const pending = await discoverPendingProposals([], github.request);
  expect(pending).toEqual({ orphans: [], renewalOpen: true });
  // Both write-needed checks (workflow output and publisher) see it.
  expect(healingWriteNeeded(empty, pending)).toBe(true);
  await applyHealing({
    report: empty,
    actions: healingScenario().actions,
    now: NOW,
    renewal: {
      publish: async () => {
        throw new TypeError("nothing should publish");
      },
      retire: async () =>
        retireRemoval({
          branch: RENEWAL_BRANCH,
          repo: "stella/stella",
          request: github.request,
          disarm: async (number) => {
            github.disarmed.push(number);
          },
        }),
    },
  });
  expect(github.disarmed).toEqual([77]);
  expect(github.pr.state).toBe("closed");
  const after = await discoverPendingProposals([], github.request);
  expect(after).toEqual({ orphans: [], renewalOpen: false });
  expect(healingWriteNeeded(empty, after)).toBe(false);
});

test("renewal publication failures fail the run under one opaque key", async () => {
  const { actions } = healingScenario();
  const error = await rejectionOf(
    applyHealing({
      now: NOW,
      actions,
      report: {
        sha: "base",
        observedAt: NOW.toISOString(),
        failures: [],
        entries: [
          { entry: docWaiver("absent-a", SOON), outcome: outcome("absent", 0) },
        ],
      },
      renewal: {
        publish: async () => {
          throw new TypeError("main advanced");
        },
        retire: async () => {},
      },
    }),
  );
  expect(error).toMatchObject({
    failures: [{ key: RENEWAL_FAILURE_KEY, stage: "renewal" }],
  });
});

test("absent evidence that lapsed, passed a sample or belongs to another kind is not renewable", () => {
  const lapsed = new Date(SOON.expiresAt);
  expect(
    renewalRecords(
      [
        { entry: docWaiver("ok", SOON), outcome: outcome("absent", 0) },
        { entry: docWaiver("partial", SOON), outcome: outcome("absent", 1) },
        {
          entry: { ...docWaiver("audit", SOON), kind: "dependency-audit" },
          outcome: outcome("absent", 0),
        },
      ],
      NOW,
    ).map(({ entry }) => entry.id),
  ).toEqual(["ok"]);
  expect(
    renewalRecords(
      [{ entry: docWaiver("ok", SOON), outcome: outcome("absent", 0) }],
      lapsed,
    ),
  ).toEqual([]);
});

test("the public renewal body lists probed URLs and provenance, never probe output", () => {
  const records: RenewalRecord[] = [
    { entry: docWaiver("soon", SOON), evidence: evidence(0) },
  ];
  const body = renderRenewalEvidence(records, RENEWED);
  expect(body).toContain("soon: https://x.example/llms.txt absent on 3/3");
  expect(body).toContain(`Expires: ${RENEWED.expiresAt}.`);
  expect(body).toContain("Evidence: run-link.");
  expect(body).not.toContain("private");
});

// The real owner: every waiver resolves to one removable site, and renewing
// all of them changes exactly the dates the module exports.
test("every real documentation waiver can be removed or renewed through the owner AST", async () => {
  const source = readFileSync(
    new URL(`../${DOC_SOURCE_FILE}`, import.meta.url),
    "utf-8",
  );
  const entries = DOC_SOURCE_EXCLUSIONS.map((exclusion) =>
    docWaiver(
      exclusion.dependency,
      exclusion,
      docProbeUrl(exclusion.explanation),
    ),
  );
  for (const entry of entries) {
    const [change] = removeWaiver(entry, () => source);
    expect(change?.after).toContain(
      `${JSON.stringify(entry.id)}: { dependencies: [${JSON.stringify(entry.id)}]`,
    );
  }
  const now = new Date(
    Math.min(...entries.map(({ checkedAt }) => Date.parse(checkedAt ?? ""))),
  );
  const plan = planDocRenewal({ source, absent: entries, now });
  expect(plan.held).toEqual([]);
  const renewed = datesOf(await importOwner(plan.files[DOC_SOURCE_FILE] ?? ""));
  expect(renewed).toEqual(
    Object.fromEntries(entries.map(({ id }) => [id, renewalDates(now)])),
  );
});
