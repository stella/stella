#!/usr/bin/env bun

// Instruction-enforcement guard.
//
// Every rule an agent reads should say what stops it from being broken. A rule
// item (a top-level `-`, `*` or `1.` list item) in an instruction source ends
// with exactly one enforcement tag:
//
//   [check: <target>, ...]       something a workflow runs: a root package
//                                script or repository path a pull-request or
//                                merge-queue job reaches, `ratchet:<metric-id>`,
//                                or a workflow file that runs on pull requests,
//                                the merge queue, or a schedule
//   [test: <path>, ...]          a test file or directory that exists; a
//                                root `scripts/` test must also be named by
//                                a CI command, since no package task runs it
//   [review]                     a reader is the only control
//
// A rule a lint enforces lives in the lint: its message names the fix and an
// agent meets it when it runs lint, so a `[lint: ...]` item is an error. Keep
// a `[check]` or `[test]` item only where the failure output cannot carry the
// guidance (a process, an authoring shape, a ratchet that reports a count).
//
// Sources are enumerated from their owners: the local AGENTS fragments that
// `.ai/manifest.json` names, the shared modules it selects, and every local
// skill under `.ai/local-skills/`. A new fragment or skill joins on its own.
// The ledger (scripts/instruction-enforcement-ledger.json) names the sources
// and sections that are not rule lists, each with a reason, and records the
// `[review]` count. An entry that excludes nothing fails as stale, and the
// count must match the tree; the `review-only-instruction-rules` ratchet
// metric gates it, so the count grows only with a reasoned allowance.
//
// Usage:
//   bun scripts/check-instruction-enforcement.ts --check

import { panic } from "better-result";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { flattenWorkflowSteps } from "./workflow-steps.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const stringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];

export const LEDGER_PATH = "scripts/instruction-enforcement-ledger.json";
const MANIFEST_PATH = ".ai/manifest.json";
const LOCAL_SKILLS_GLOB = ".ai/local-skills/*/SKILL.md";
const SHARED_MODULES_DIRECTORY = ".ai/shared/modules";
const RATCHET_SOURCE = "scripts/ratchet.ts";
const RATCHET_PREFIX = "ratchet:";

// Computed source enumeration consumes these repository Markdown inputs.
export const CI_MARKDOWN_READER_INPUTS = [
  ".ai/local/*.md",
  ".ai/local-skills/*/SKILL.md",
  ".ai/shared/modules/*.md",
];
export const CI_MARKDOWN_READER_COMMAND =
  "bun scripts/check-instruction-enforcement.ts --check";

// --- Parsing ----------------------------------------------------------------

export const TAG_KINDS = ["lint", "check", "test", "review"] as const;
export type TagKind = (typeof TAG_KINDS)[number];

export type Tag =
  | {
      readonly kind: Exclude<TagKind, "review">;
      readonly values: readonly string[];
    }
  | { readonly kind: "review" };

export type RuleItem = {
  readonly line: number;
  readonly heading: string;
  /** 1-based line of the heading the item sits under; 0 before any heading. */
  readonly headingLine: number;
  readonly text: string;
};

const TAG_TOKEN = /\[(?:(lint|check|test):([^\]]*)|review)\]/gu;
const ITEM_START = /^(?:[-*]|\d+\.)\s+\S/u;
const FENCE = /^\s*(`{3,}|~{3,})/u;

const headingText = (line: string): string | undefined => {
  const markerEnd = line.search(/[^#]/u);
  if (markerEnd < 1 || markerEnd > 6 || line[markerEnd] !== " ") {
    return undefined;
  }
  let heading = line.slice(markerEnd + 1).trim();
  while (heading.endsWith("#")) {
    heading = heading.slice(0, -1).trimEnd();
  }
  return heading;
};

/** Top-level list items, each with the heading it sits under. */
export const parseRuleItems = (source: string): RuleItem[] => {
  const lines = source.split("\n");
  let start = 0;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    start = end === -1 ? 0 : end + 1;
  }

  const items: RuleItem[] = [];
  let heading = "";
  let headingLine = 0;
  // The opening run of an open fence; only the same character, at least as
  // long, closes it (CommonMark), so a longer fence may show a shorter one.
  let openFence: string | undefined;
  let current:
    | { line: number; heading: string; headingLine: number; text: string[] }
    | undefined;
  let pendingBlank = false;

  const close = (): void => {
    if (current !== undefined) {
      items.push({
        line: current.line,
        heading: current.heading,
        headingLine: current.headingLine,
        text: current.text.join("\n").trim(),
      });
      current = undefined;
    }
    pendingBlank = false;
  };

  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fence = FENCE.exec(line)?.[1];
    const togglesFence =
      fence !== undefined &&
      (openFence === undefined ||
        (fence[0] === openFence[0] &&
          fence.length >= openFence.length &&
          line.trim() === fence));
    if (togglesFence) {
      openFence = openFence === undefined ? fence : undefined;
      if (current !== undefined && /^\s/u.test(line)) {
        continue;
      }
      close();
      continue;
    }
    if (openFence !== undefined) {
      continue;
    }
    const parsedHeading = headingText(line);
    if (parsedHeading !== undefined) {
      close();
      heading = parsedHeading;
      headingLine = index + 1;
      continue;
    }
    if (ITEM_START.test(line)) {
      close();
      current = { line: index + 1, heading, headingLine, text: [line] };
      continue;
    }
    if (line.trim() === "") {
      pendingBlank = current !== undefined;
      continue;
    }
    if (current !== undefined) {
      // A paragraph after a blank line belongs to the item only when indented.
      if (pendingBlank && !/^\s/u.test(line)) {
        close();
        continue;
      }
      pendingBlank = false;
      current.text.push(line);
    }
  }
  close();
  return items;
};

export type TagReading =
  | { readonly kind: "tagged"; readonly tag: Tag }
  | { readonly kind: "missing" }
  | { readonly kind: "multiple"; readonly count: number }
  | { readonly kind: "not-trailing" }
  | { readonly kind: "empty" };

/** The one enforcement tag an item ends with, or why it has none. */
export const readTag = (text: string): TagReading => {
  const matches = [...text.matchAll(TAG_TOKEN)];
  if (matches.length === 0) {
    return { kind: "missing" };
  }
  if (matches.length > 1) {
    return { kind: "multiple", count: matches.length };
  }
  const match = matches[0];
  if (match === undefined) {
    return { kind: "missing" };
  }
  if (match.index + match[0].length !== text.trimEnd().length) {
    return { kind: "not-trailing" };
  }
  const kind = match[1];
  if (kind === undefined) {
    return { kind: "tagged", tag: { kind: "review" } };
  }
  const values = (match[2] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0) {
    return { kind: "empty" };
  }
  switch (kind) {
    case "lint":
    case "check":
    case "test":
      return { kind: "tagged", tag: { kind, values } };
    default:
      return panic(`Unhandled tag kind ${kind}`);
  }
};

// --- Resolution -------------------------------------------------------------

export type CiInputs = {
  /** Every command a pull-request or merge-queue workflow runs. */
  readonly commands: readonly string[];
  /** Root package scripts. */
  readonly rootScripts: Readonly<Record<string, string>>;
  /** Each workspace's package scripts by its directory, for `turbo run <task>`. */
  readonly workspaceScripts: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
  readonly ratchetIds: ReadonlySet<string>;
  /** Workflows a pull request or the merge queue triggers. */
  readonly pullRequestWorkflows: ReadonlySet<string>;
  /** Workflows a schedule triggers, such as audits of repository settings. */
  readonly scheduledWorkflows: ReadonlySet<string>;
  readonly exists: (repoPath: string) => boolean;
  /** A repository shell script's text, so the commands it runs count too. */
  readonly readScript: (repoPath: string) => string | undefined;
};

export type CiReach = {
  readonly text: string;
  readonly scripts: ReadonlySet<string>;
  /** The `turbo run` tasks CI reaches in every workspace. */
  readonly tasks: ReadonlySet<string>;
};

/** The CI commands plus every package script they reach. */
export const ciReach = (inputs: CiInputs): CiReach => {
  const pending = [...inputs.commands];
  const scripts = new Set<string>();
  const tasks = new Set<string>();
  // A reached script's body joins `pending`, and the iterator visits it too.
  for (const command of pending) {
    for (const match of command.matchAll(
      /\bbun\s+(?:--bun\s+)?run\s+([\w:.-]+)/gu,
    )) {
      const name = match[1] ?? "";
      const body = inputs.rootScripts[name];
      if (!scripts.has(name) && body !== undefined) {
        scripts.add(name);
        pending.push(body);
      }
    }
    for (const match of command.matchAll(
      /\b(?:bash|sh)\s+((?:scripts|apps\/[\w-]+\/scripts)\/[\w./-]+\.sh)\b/gu,
    )) {
      const script = match[1] ?? "";
      const body = inputs.readScript(script);
      if (!scripts.has(script) && body !== undefined) {
        scripts.add(script);
        pending.push(body);
      }
    }
    for (const match of command.matchAll(/\bturbo\s+run\s+([\w:.-]+)/gu)) {
      const task = match[1] ?? "";
      if (tasks.has(task)) {
        continue;
      }
      tasks.add(task);
      for (const workspace of Object.values(inputs.workspaceScripts)) {
        const body = workspace[task];
        if (body !== undefined) {
          pending.push(body);
        }
      }
    }
  }
  return { text: pending.join("\n"), scripts, tasks };
};

const mentionsPath = (text: string, repoPath: string): boolean =>
  new RegExp(
    `(?:^|[\\s"'(=./])${repoPath.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?=$|[\\s"');&|:])`,
    "mu",
  ).test(text);

/** Why a check target is not something CI runs, if it is not. */
export const checkProblem = (
  inputs: CiInputs,
  reach: CiReach,
  target: string,
): string | undefined => {
  if (target.startsWith(RATCHET_PREFIX)) {
    const metric = target.slice(RATCHET_PREFIX.length);
    if (!inputs.ratchetIds.has(metric)) {
      return `no ratchet metric ${metric} in ${RATCHET_SOURCE}`;
    }
    return mentionsPath(reach.text, RATCHET_SOURCE)
      ? undefined
      : `${RATCHET_SOURCE} is not run by CI`;
  }
  if (target.startsWith(".github/workflows/")) {
    return inputs.pullRequestWorkflows.has(target) ||
      inputs.scheduledWorkflows.has(target)
      ? undefined
      : "not a pull-request, merge-queue or scheduled workflow";
  }
  if (target.includes("/")) {
    if (!inputs.exists(target)) {
      return "no such file";
    }
    return mentionsPath(reach.text, target) ? undefined : "not run by CI";
  }
  if (inputs.rootScripts[target] === undefined) {
    return "no such root package script";
  }
  return reach.scripts.has(target) ? undefined : "not run by CI";
};

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

const WORKSPACE_DIR = /^(?:apps|packages)\/[^/]+/u;

/**
 * Why a test path does not guard anything, if it does not. A workspace test
 * runs only when its workspace has a `test` script and CI reaches the `test`
 * task; any other test runs only when a CI command names it.
 */
export const testProblem = (
  inputs: Pick<CiInputs, "exists" | "workspaceScripts">,
  reach: CiReach,
  testPath: string,
  isDirectory: boolean,
): string | undefined => {
  if (!inputs.exists(testPath)) {
    return "no such file or directory";
  }
  if (!isDirectory && !TEST_FILE.test(testPath)) {
    return "not a test file";
  }
  const workspace = WORKSPACE_DIR.exec(testPath)?.[0];
  if (workspace === undefined) {
    if (mentionsPath(reach.text, testPath)) {
      return undefined;
    }
    return testPath.startsWith("scripts/")
      ? "root script test not run by CI"
      : "test outside a workspace not run by CI";
  }
  if (inputs.workspaceScripts[workspace]?.["test"] === undefined) {
    return `${workspace} has no test script`;
  }
  return reach.tasks.has("test") ? undefined : "workspace tests not run by CI";
};

// --- Sources and ledger -----------------------------------------------------

export type Source = { readonly file: string };

export type LedgerEntry = { readonly file: string; readonly reason: string };
export type SectionEntry = LedgerEntry & { readonly heading: string };

export type Ledger = {
  readonly reviewOnlyRules: number;
  readonly excludedSources: readonly LedgerEntry[];
  readonly excludedSections: readonly SectionEntry[];
};

const isLedgerEntry = (value: unknown): value is LedgerEntry =>
  isRecord(value) &&
  typeof value["file"] === "string" &&
  typeof value["reason"] === "string" &&
  value["reason"].trim().length > 0;

const isSectionEntry = (value: unknown): value is SectionEntry =>
  isRecord(value) &&
  typeof value["heading"] === "string" &&
  isLedgerEntry(value);

export const parseLedger = (raw: string): Ledger => {
  const parsed: unknown = JSON.parse(raw);
  if (
    !isRecord(parsed) ||
    typeof parsed["reviewOnlyRules"] !== "number" ||
    !Array.isArray(parsed["excludedSources"]) ||
    !parsed["excludedSources"].every(isLedgerEntry) ||
    !Array.isArray(parsed["excludedSections"]) ||
    !parsed["excludedSections"].every(isSectionEntry)
  ) {
    return panic(
      `${LEDGER_PATH} must hold reviewOnlyRules and reasoned excludedSources and excludedSections`,
    );
  }
  return {
    reviewOnlyRules: parsed["reviewOnlyRules"],
    excludedSources: parsed["excludedSources"],
    excludedSections: parsed["excludedSections"],
  };
};

export type Problem = {
  readonly file: string;
  readonly line: number;
  readonly message: string;
};

export type Census = Record<TagKind, number>;

export type Report = {
  readonly problems: Problem[];
  readonly census: Census;
  readonly checkedSources: number;
};

export type Resolvers = {
  readonly check: (target: string) => string | undefined;
  readonly test: (testPath: string) => string | undefined;
};

export const LINT_TAG_MESSAGE =
  "a lint enforces this rule, so the rule lives in the lint: delete the item, " +
  "and make the lint message name the fix if it only names the fault";

const resolverFor = (resolvers: Resolvers, tag: Tag) => {
  switch (tag.kind) {
    case "check":
      return resolvers.check;
    case "test":
      return resolvers.test;
    case "lint":
    case "review":
      return undefined;
    default:
      tag satisfies never;
      return panic("Unhandled tag kind");
  }
};

const READING_MESSAGES = {
  missing: "rule has no enforcement tag ([check: …], [test: …] or [review])",
  "not-trailing": "the enforcement tag must end the rule",
  empty: "the enforcement tag names nothing",
} as const;

/** Check every source against the tags it carries and the ledger. */
export const checkSources = (
  sources: readonly Source[],
  read: (file: string) => string,
  ledger: Ledger,
  resolvers: Resolvers,
): Report => {
  const problems: Problem[] = [];
  const tagged: TagKind[] = [];
  const sourceFiles = new Set(sources.map((source) => source.file));
  const excludedFiles = new Set(
    ledger.excludedSources.map((entry) => entry.file),
  );
  const usedSections = new Set<number>();
  // Heading lines each excluded section matched, so a repeated heading cannot
  // hide a second section's rules behind the first one's exclusion.
  const sectionHeadingLines = new Map<number, Set<number>>();
  let checkedSources = 0;

  for (const entry of ledger.excludedSources) {
    if (!sourceFiles.has(entry.file)) {
      problems.push({
        file: LEDGER_PATH,
        line: 0,
        message: `stale excluded source ${entry.file} (no longer an instruction source)`,
      });
    }
  }

  for (const source of sources) {
    if (excludedFiles.has(source.file)) {
      continue;
    }
    checkedSources += 1;
    for (const item of parseRuleItems(read(source.file))) {
      const sectionIndex = ledger.excludedSections.findIndex(
        (entry) => entry.file === source.file && entry.heading === item.heading,
      );
      if (sectionIndex !== -1) {
        usedSections.add(sectionIndex);
        const lines = sectionHeadingLines.get(sectionIndex) ?? new Set();
        lines.add(item.headingLine);
        sectionHeadingLines.set(sectionIndex, lines);
        continue;
      }
      const reading = readTag(item.text);
      if (reading.kind === "multiple") {
        problems.push({
          file: source.file,
          line: item.line,
          message: `rule carries ${String(reading.count)} enforcement tags; keep exactly one`,
        });
        continue;
      }
      if (reading.kind !== "tagged") {
        problems.push({
          file: source.file,
          line: item.line,
          message: READING_MESSAGES[reading.kind],
        });
        continue;
      }
      tagged.push(reading.tag.kind);
      if (reading.tag.kind === "lint") {
        problems.push({
          file: source.file,
          line: item.line,
          message: LINT_TAG_MESSAGE,
        });
        continue;
      }
      const resolve = resolverFor(resolvers, reading.tag);
      if (resolve === undefined || reading.tag.kind === "review") {
        continue;
      }
      for (const value of reading.tag.values) {
        const why = resolve(value);
        if (why !== undefined) {
          problems.push({
            file: source.file,
            line: item.line,
            message: `[${reading.tag.kind}: ${value}] ${why}`,
          });
        }
      }
    }
  }

  for (const [index, entry] of ledger.excludedSections.entries()) {
    if (!usedSections.has(index)) {
      problems.push({
        file: LEDGER_PATH,
        line: 0,
        message: `stale excluded section "${entry.heading}" in ${entry.file} (no list item sits under it)`,
      });
    }
    const headingLines = sectionHeadingLines.get(index)?.size ?? 0;
    if (headingLines > 1) {
      problems.push({
        file: LEDGER_PATH,
        line: 0,
        message: `excluded section "${entry.heading}" in ${entry.file} matches ${String(headingLines)} sections; give each section a distinct heading`,
      });
    }
  }

  const countOf = (kind: TagKind): number =>
    tagged.filter((each) => each === kind).length;
  const census: Census = {
    lint: countOf("lint"),
    check: countOf("check"),
    test: countOf("test"),
    review: countOf("review"),
  };
  if (census.review !== ledger.reviewOnlyRules) {
    problems.push({
      file: LEDGER_PATH,
      line: 0,
      message:
        census.review > ledger.reviewOnlyRules
          ? `${String(census.review)} [review] rules exceed reviewOnlyRules ${String(ledger.reviewOnlyRules)}: name the mechanism that enforces the new rule`
          : `[review] rules fell to ${String(census.review)}: lower reviewOnlyRules from ${String(ledger.reviewOnlyRules)} to ${String(census.review)}`,
    });
  }

  return { problems, census, checkedSources };
};

// --- Repository access ------------------------------------------------------

const readRepoFile = (repoPath: string): string =>
  readFileSync(path.join(repoRoot, repoPath), "utf-8");

const readJson = (repoPath: string): unknown =>
  JSON.parse(readRepoFile(repoPath));

const stringRecord = (value: unknown): Record<string, string> =>
  isRecord(value)
    ? Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : {};

/** The local fragments and shared modules the manifest selects, and local skills. */
export const enumerateSources = (
  manifest: unknown,
  localSkills: readonly string[],
): Source[] => {
  const agents = isRecord(manifest) ? manifest["agents"] : undefined;
  if (!isRecord(agents)) {
    return panic(`${MANIFEST_PATH} has no agents section`);
  }
  const files = new Set<string>();
  const addEntry = (entry: unknown): void => {
    if (!isRecord(entry)) {
      return;
    }
    for (const module of stringArray(entry["modules"])) {
      files.add(`${SHARED_MODULES_DIRECTORY}/${module}.md`);
    }
    if (typeof entry["local"] === "string") {
      files.add(entry["local"]);
    }
  };
  addEntry(agents);
  for (const scope of Array.isArray(agents["scopes"]) ? agents["scopes"] : []) {
    addEntry(scope);
  }
  for (const skill of localSkills) {
    files.add(skill);
  }
  return [...files]
    .toSorted((a, b) => (a < b ? -1 : 1))
    .map((file) => ({ file }));
};

const PULL_REQUEST_TRIGGERS = [
  "pull_request",
  "pull_request_target",
  "merge_group",
];

const workflowTriggers = (workflow: unknown): string[] => {
  const triggers = isRecord(workflow) ? workflow["on"] : undefined;
  if (typeof triggers === "string") {
    return [triggers];
  }
  if (Array.isArray(triggers)) {
    return stringArray(triggers);
  }
  return isRecord(triggers) ? Object.keys(triggers) : [];
};

const LOCAL_ACTION = /^\.\/\.github\/actions\/([\w.-]+)$/u;
const LOCAL_WORKFLOW = /^\.\/(\.github\/workflows\/[\w.-]+\.ya?ml)$/u;

const localActionSteps = (uses: string): unknown[] => {
  const name = LOCAL_ACTION.exec(uses)?.[1];
  const file = [
    `.github/actions/${String(name)}/action.yml`,
    `.github/actions/${String(name)}/action.yaml`,
  ].find((candidate) => existsSync(path.join(repoRoot, candidate)));
  if (name === undefined || file === undefined) {
    return [];
  }
  const action: unknown = Bun.YAML.parse(readRepoFile(file));
  const runs = isRecord(action) ? action["runs"] : undefined;
  return isRecord(runs) && Array.isArray(runs["steps"]) ? runs["steps"] : [];
};

/** The run text of each step, following local composite actions once each. */
const stepCommands = (step: unknown, seen: Set<string>): string[] => {
  if (!isRecord(step)) {
    return [];
  }
  const commands = typeof step["run"] === "string" ? [step["run"]] : [];
  const uses = step["uses"];
  if (typeof uses === "string" && !seen.has(uses)) {
    seen.add(uses);
    for (const nested of localActionSteps(uses)) {
      commands.push(...stepCommands(nested, seen));
    }
  }
  return commands;
};

const workflowCommands = (file: string, seen: Set<string>): string[] => {
  if (seen.has(file)) {
    return [];
  }
  seen.add(file);
  const workflow: unknown = Bun.YAML.parse(readRepoFile(file));
  const jobs = isRecord(workflow) ? workflow["jobs"] : undefined;
  if (!isRecord(jobs)) {
    return [];
  }
  return Object.values(jobs).flatMap((job) => {
    if (!isRecord(job)) {
      return [];
    }
    const called =
      typeof job["uses"] === "string"
        ? LOCAL_WORKFLOW.exec(job["uses"])?.[1]
        : undefined;
    if (called !== undefined) {
      return workflowCommands(called, seen);
    }
    return Array.isArray(job["steps"])
      ? flattenWorkflowSteps(job["steps"]).flatMap((step) =>
          stepCommands(step, seen),
        )
      : [];
  });
};

const triggeredWorkflows = (
  tracked: readonly string[],
): Map<string, string[]> =>
  new Map(
    tracked
      .filter((file) => /^\.github\/workflows\/[^/]+\.ya?ml$/u.test(file))
      .map((file) => [
        file,
        workflowTriggers(Bun.YAML.parse(readRepoFile(file))),
      ]),
  );

const ratchetMetricIds = (): Set<string> => {
  const source = readRepoFile(RATCHET_SOURCE);
  const start = source.indexOf("export const RATCHET_METRICS");
  if (start === -1) {
    return panic(`${RATCHET_SOURCE} has no RATCHET_METRICS registry`);
  }
  const ids = source
    .slice(start)
    .split("\n")
    .flatMap((line) => {
      const trimmed = line.trim();
      return line.length > trimmed.length &&
        trimmed.startsWith('id: "') &&
        trimmed.endsWith('",')
        ? [trimmed.slice(5, -2)]
        : [];
    });
  return new Set(ids);
};

const runCheck = (): number => {
  const exists = (repoPath: string): boolean =>
    existsSync(path.join(repoRoot, repoPath));

  const localSkills = [
    ...new Bun.Glob(LOCAL_SKILLS_GLOB).scanSync({ cwd: repoRoot }),
  ]
    .map((file) => file.split(path.sep).join("/"))
    .toSorted();
  const sources = enumerateSources(readJson(MANIFEST_PATH), localSkills);
  const ledger = parseLedger(readRepoFile(LEDGER_PATH));

  const rootPackage = readJson("package.json");
  const workflowFiles = [
    ...new Bun.Glob(".github/workflows/*.{yml,yaml}").scanSync({
      cwd: repoRoot,
    }),
  ];
  const triggers = triggeredWorkflows(workflowFiles);
  const workflowsOn = (names: readonly string[]): string[] =>
    [...triggers]
      .filter(([, on]) => on.some((name) => names.includes(name)))
      .map(([file]) => file);
  const workflows = workflowsOn(PULL_REQUEST_TRIGGERS);
  const seen = new Set<string>();
  const ciInputs: CiInputs = {
    commands: workflows.flatMap((file) => workflowCommands(file, seen)),
    pullRequestWorkflows: new Set(workflows),
    scheduledWorkflows: new Set(workflowsOn(["schedule"])),
    readScript: (repoPath) =>
      exists(repoPath) ? readRepoFile(repoPath) : undefined,
    rootScripts: stringRecord(
      isRecord(rootPackage) ? rootPackage["scripts"] : undefined,
    ),
    workspaceScripts: Object.fromEntries(
      [
        ...new Bun.Glob("{apps,packages}/*/package.json").scanSync({
          cwd: repoRoot,
        }),
      ].map((file) => {
        const manifest = readJson(file);
        return [
          path.posix.dirname(file),
          stringRecord(isRecord(manifest) ? manifest["scripts"] : undefined),
        ];
      }),
    ),
    ratchetIds: ratchetMetricIds(),
    exists,
  };
  const reach = ciReach(ciInputs);

  const report = checkSources(
    sources,
    (file) => (existsSync(path.join(repoRoot, file)) ? readRepoFile(file) : ""),
    ledger,
    {
      check: (target) => checkProblem(ciInputs, reach, target),
      test: (testPath) =>
        testProblem(
          ciInputs,
          reach,
          testPath,
          exists(testPath) && !path.posix.basename(testPath).includes("."),
        ),
    },
  );

  for (const problem of report.problems) {
    console.error(
      `${problem.file}:${String(problem.line)}: ${problem.message}`,
    );
  }
  const { census } = report;
  const summary = `check ${String(census.check)}, test ${String(census.test)}, review ${String(census.review)}`;
  if (report.problems.length > 0) {
    console.error(
      `\ncheck-instruction-enforcement: ${String(report.problems.length)} problem(s) (${summary}). ` +
        `End each rule with one tag naming what enforces it, or [review]; exclusions live in ${LEDGER_PATH} with a reason.`,
    );
    return 1;
  }
  console.log(
    `check-instruction-enforcement: OK. ${String(report.checkedSources)} source(s) checked: ${summary}.`,
  );
  return 0;
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] !== "--check") {
    panic(`Usage: bun scripts/check-instruction-enforcement.ts --check`);
  }
  // Set exitCode rather than process.exit() so stdout/stderr flush before exit.
  process.exitCode = runCheck();
}
