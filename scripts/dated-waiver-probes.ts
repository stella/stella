import { panic, Result } from "better-result";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import * as v from "valibot";

import {
  type CallExpression,
  type Node,
  type ObjectExpression,
  type ParsedSource,
  parseSource,
  type VariableDeclarator,
  walk,
} from "../packages/scripts/src/syntax-tree";
import {
  type DatedWaiver,
  DOC_SOURCE_FILE,
  type ProbeKind,
  ZERO_AGE_OVERRIDE,
} from "./dated-waivers";
import {
  parseRegistry,
  serializeRegistry,
  splitTestId,
} from "./flaky-test-quarantine";
import {
  collectLintDirectives,
  resolveDirectiveAnchors,
  suppressesRule,
} from "./lint-suppressions";
import { parseLedger } from "./suppression-waivers";

export type RemovalChange = { source: string; before: string; after: string };

export const AUTOMATIC_REMOVAL_ALLOWED = {
  "guard-rollout": true,
  "no-llms-txt": true,
  "release-age-exclusion": true,
  "release-age-exception": true,
  "dependency-audit": true,
  "quarantined-test": true,
  "flaky-test-quarantine": true,
  "suppression-waiver": true,
  "pending-contract-migration": false,
} as const satisfies Record<ProbeKind, boolean>;

// Offsets must come from a parseable owner, never from regex over source text.
const parseOwner = (source: string, file: string) => parseSource(file, source);

const nextTokenOffset = (ast: ParsedSource, offset: number): number => {
  let next = offset;
  for (;;) {
    while (
      /\s/u.test(ast.sourceText.charAt(next)) &&
      next < ast.sourceText.length
    ) {
      next += 1;
    }
    const commentStart = next;
    const comment = ast.comments.find(
      (candidate) => candidate.start === commentStart,
    );
    if (!comment) {
      return next;
    }
    next = comment.end;
  }
};

const removeNode = (source: string, ast: ParsedSource, node: Node): string => {
  const next = nextTokenOffset(ast, node.end);
  const end = source.charAt(next) === "," ? next + 1 : node.end;
  return source.slice(0, node.start) + source.slice(end);
};

const removeDocumentation = (source: string, entry: DatedWaiver): string => {
  const ast = parseOwner(source, DOC_SOURCE_FILE);
  let owner: VariableDeclarator | undefined;
  let registry: ObjectExpression | undefined;
  walk(ast.program, (node) => {
    if (node.type !== "VariableDeclarator" || node.id.type !== "Identifier") {
      return;
    }
    if (node.id.name === "DOC_SOURCE_EXCLUSIONS") {
      owner = node;
    }
    if (node.id.name === "DOC_SOURCES" && node.init) {
      let value = node.init;
      while (
        value.type === "TSSatisfiesExpression" ||
        value.type === "TSAsExpression"
      ) {
        value = value.expression;
      }
      if (value.type === "ObjectExpression") {
        registry = value;
      }
    }
  });
  if (!owner || !registry) {
    panic("Documentation waiver owner missing");
  }
  const matches: Node[] = [];
  walk(owner, (node) => {
    if (
      node.type === "ObjectExpression" &&
      node.properties.some(
        (property) =>
          property.type === "Property" &&
          !property.method &&
          !property.shorthand &&
          source.slice(property.key.start, property.key.end) === "dependency" &&
          property.value.type === "Literal" &&
          property.value.value === entry.id,
      )
    ) {
      matches.push(node);
      return "skip-children";
    }
    if (node.type === "ArrayExpression") {
      for (const element of node.elements) {
        if (element?.type === "Literal" && element.value === entry.id) {
          matches.push(element);
        }
      }
    }
    return undefined;
  });
  const target = matches.at(0);
  if (matches.length !== 1 || !target) {
    panic(`Documentation waiver anchor is not unique: ${entry.id}`);
  }
  const url = entry.probe.command.at(3);
  if (!url || !url.startsWith("https://")) {
    panic(`Documentation waiver has no canonical llms.txt URL: ${entry.id}`);
  }
  const lastProperty = registry.properties.at(-1);
  const next = nextTokenOffset(ast, lastProperty?.end ?? registry.start + 1);
  const trailingComma = source.charAt(next) === ",";
  const insertion = trailingComma
    ? next + 1
    : (lastProperty?.end ?? registry.start + 1);
  const separator = registry.properties.length > 0 && !trailingComma ? "," : "";
  // Insert first: registry precedes exclusions, so original removal offsets hold.
  const removed = removeNode(source, ast, target);
  const updated = `${removed.slice(0, insertion)}${separator}\n  ${JSON.stringify(entry.id)}: { dependencies: [${JSON.stringify(entry.id)}], url: ${JSON.stringify(url)} },\n${removed.slice(insertion)}`;
  parseOwner(updated, DOC_SOURCE_FILE);
  return updated;
};

const baselineSchema = v.looseObject({
  accepted: v.array(v.looseObject({ id: v.string() })),
});
const removeAcceptance = (source: string, entry: DatedWaiver): string => {
  const baseline = v.parse(baselineSchema, JSON.parse(source));
  if (baseline.accepted.filter(({ id }) => id === entry.id).length !== 1) {
    panic(`Audit acceptance anchor is not unique: ${entry.id}`);
  }
  return `${JSON.stringify({ ...baseline, accepted: baseline.accepted.filter(({ id }) => id !== entry.id) }, null, 2)}\n`;
};

const removeReleaseAgeException = (
  before: string,
  entry: DatedWaiver,
): string => {
  const lines = before.split("\n");
  if (
    !Number.isSafeInteger(entry.line) ||
    entry.line < 2 ||
    entry.line > lines.length
  ) {
    panic(`Release-age exception anchor missing: ${entry.id}`);
  }
  const line = lines.at(entry.line - 1);
  if (
    line === undefined ||
    !line.includes(`release-age-quarantine-exception: ${entry.expiresAt}`)
  ) {
    panic(`Release-age exception anchor missing: ${entry.id}`);
  }
  // Only the documented zero-age override is removable automatically.
  const previous = lines.at(entry.line - 2);
  if (!previous || !ZERO_AGE_OVERRIDE.test(previous)) {
    panic(
      `Release-age exception has no removable zero-age override: ${entry.id}`,
    );
  }
  if (previous.trim() !== entry.id) {
    panic(`Release-age exception anchor missing: ${entry.id}`);
  }
  const withoutOverride = previous.replace(ZERO_AGE_OVERRIDE, "");
  if (ZERO_AGE_OVERRIDE.test(withoutOverride)) {
    panic(
      `Release-age exception has more than one zero-age override: ${entry.id}`,
    );
  }
  lines[entry.line - 2] = withoutOverride;
  lines.splice(entry.line - 1, 1);
  return lines.join("\n");
};

const leadingComments = (ast: ParsedSource, node: Node) =>
  ast.comments.filter(
    (comment) =>
      comment.end <= node.start &&
      /^(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$))*$/u.test(
        ast.sourceText.slice(comment.end, node.start),
      ),
  );

const removeGuardRollout = (source: string, entry: DatedWaiver): string => {
  const ast = parseOwner(source, entry.source);
  const matches: ObjectExpression[] = [];
  walk(ast.program, (node) => {
    if (
      node.type === "ObjectExpression" &&
      node.properties.some(
        (property) =>
          property.type === "Property" &&
          !property.method &&
          !property.shorthand &&
          source.slice(property.key.start, property.key.end) === "id" &&
          property.value.type === "Literal" &&
          property.value.value === entry.id,
      )
    ) {
      matches.push(node);
    }
  });
  const target = matches.at(0);
  if (matches.length !== 1 || !target) {
    panic(`Guard rollout anchor is not unique: ${entry.id}`);
  }
  const scope = target.properties.find(
    (property) =>
      property.type === "Property" &&
      !property.method &&
      !property.shorthand &&
      source.slice(property.key.start, property.key.end) === "type",
  );
  const expiry = target.properties.find(
    (property) =>
      property.type === "Property" &&
      !property.method &&
      !property.shorthand &&
      source.slice(property.key.start, property.key.end) === "expiresAt",
  );
  if (
    scope?.type !== "Property" ||
    scope.method ||
    scope.shorthand ||
    scope.value.type !== "Literal" ||
    scope.value.value !== "changed-lines" ||
    expiry?.type !== "Property" ||
    expiry.method ||
    expiry.shorthand ||
    expiry.value.type !== "Literal" ||
    expiry.value.value !== entry.expiresAt
  ) {
    panic(`Guard rollout scope or expiry changed: ${entry.id}`);
  }
  // Apply rightmost edits first so each offset still refers to the owner AST.
  let updated = source;
  for (const node of [scope.value, expiry].toSorted(
    (a, b) => b.start - a.start,
  )) {
    updated =
      node === expiry
        ? removeNode(updated, ast, node)
        : `${updated.slice(0, node.start)}"full"${updated.slice(node.end)}`;
  }
  parseOwner(updated, entry.source);
  return updated;
};

export const removeWaiver = (
  entry: DatedWaiver,
  read: (file: string) => string,
): RemovalChange[] => {
  if (!AUTOMATIC_REMOVAL_ALLOWED[entry.kind]) {
    return panic(`Automatic removal is disabled for ${entry.kind}`);
  }
  const before = read(entry.source);
  let after: string;
  switch (entry.kind) {
    case "guard-rollout":
      after = removeGuardRollout(before, entry);
      break;
    case "no-llms-txt":
      after = removeDocumentation(before, entry);
      break;
    case "quarantined-test": {
      const ast = parseOwner(before, entry.source);
      const matches: CallExpression[] = [];
      walk(ast.program, (node) => {
        if (
          node.type !== "CallExpression" ||
          node.callee.type !== "MemberExpression" ||
          node.callee.computed ||
          node.callee.property.type !== "Identifier" ||
          node.callee.property.name !== "skip" ||
          !["test", "it"].includes(
            before.slice(node.callee.object.start, node.callee.object.end),
          )
        ) {
          return;
        }
        const title = node.arguments.at(0);
        if (
          title?.type === "Literal" &&
          title.value === entry.id &&
          leadingComments(ast, node).some((comment) =>
            comment.value.includes(
              `test-quarantine-expires: ${entry.expiresAt}`,
            ),
          )
        ) {
          matches.push(node);
        }
      });
      const call = matches.at(0);
      if (
        matches.length !== 1 ||
        !call ||
        call.callee.type !== "MemberExpression"
      ) {
        panic(`Test quarantine anchor is not unique: ${entry.id}`);
      }
      after =
        before.slice(0, call.callee.object.end) + before.slice(call.callee.end);
      const marker = leadingComments(ast, call).find((comment) =>
        comment.value.includes(`test-quarantine-expires: ${entry.expiresAt}`),
      );
      if (!marker) {
        panic(`Test quarantine comment anchor missing: ${entry.id}`);
      }
      // The marker precedes the edited call, so its original offsets still hold.
      after = after.slice(0, marker.start) + after.slice(marker.end);
      parseOwner(after, entry.source);
      break;
    }
    case "dependency-audit":
      after = removeAcceptance(before, entry);
      break;
    case "release-age-exclusion": {
      const lines = before.split("\n");
      const matches = lines.flatMap((line, index) =>
        line.includes(JSON.stringify(entry.id)) &&
        line.includes(`quarantine-expires: ${entry.expiresAt}`)
          ? [index]
          : [],
      );
      const index = matches.at(0);
      if (matches.length !== 1 || index === undefined) {
        panic(`Release-age waiver anchor is not unique: ${entry.id}`);
      }
      lines.splice(index, 1);
      after = lines.join("\n");
      break;
    }
    case "release-age-exception":
      after = removeReleaseAgeException(before, entry);
      break;
    case "suppression-waiver": {
      const parsed = parseLedger(JSON.parse(before));
      if (parsed.status === "invalid") {
        panic(parsed.errors.join("\n"));
      }
      const waiver = parsed.ledger.waivers.find(({ id }) => id === entry.id);
      if (!waiver) {
        panic(`Suppression waiver anchor missing: ${entry.id}`);
      }
      switch (waiver.kind) {
        case "permanent":
          return panic(`Suppression waiver anchor missing: ${entry.id}`);
        case "temporary":
          break;
        default:
          waiver satisfies never;
          return panic("Unhandled suppression waiver kind");
      }
      if (waiver.expires !== entry.expiresAt) {
        panic(`Suppression waiver anchor missing: ${entry.id}`);
      }
      const normalized = path.posix.normalize(waiver.file);
      if (
        path.posix.isAbsolute(waiver.file) ||
        normalized === ".." ||
        normalized.startsWith("../") ||
        waiver.file.includes("\\") ||
        waiver.file.startsWith("-")
      ) {
        panic(`Suppression waiver file escapes repository: ${entry.id}`);
      }
      const content = read(waiver.file);
      parseOwner(content, waiver.file);
      const directives = collectLintDirectives(content, waiver.file);
      const anchors = resolveDirectiveAnchors(content, waiver.file, directives);
      const matches = directives.filter(
        (directive, index) =>
          anchors.at(index) === waiver.symbol &&
          suppressesRule(directive, waiver.rule),
      );
      if (matches.length !== waiver.count) {
        panic(`Suppression waiver directive count changed: ${entry.id}`);
      }
      let updated = content;
      for (const directive of matches.toSorted(
        (left, right) => right.pos - left.pos,
      )) {
        if (directive.rules.length === 0) {
          panic(`Cannot remove one rule from a bare suppression: ${entry.id}`);
        }
        const remaining = directive.rules.filter(
          (rule) => rule !== waiver.rule,
        );
        const prefix =
          /^(?:\/\/|\/\*)\s*(?:eslint|oxlint)-disable(?:-next-line|-line)?\b/u
            .exec(directive.text)
            ?.at(0);
        if (!prefix) {
          panic(`Suppression directive prefix missing: ${entry.id}`);
        }
        const reason = directive.text.indexOf("--");
        let suffix = "";
        if (reason !== -1) {
          suffix = ` ${directive.text.slice(reason)}`;
        } else if (directive.text.endsWith("*/")) {
          suffix = " */";
        }
        const replacement =
          remaining.length > 0
            ? `${prefix} ${remaining.join(", ")}${suffix}`
            : "";
        updated =
          updated.slice(0, directive.pos) +
          replacement +
          updated.slice(directive.end);
      }
      parseOwner(updated, waiver.file);
      return [
        {
          source: entry.source,
          before,
          after: `${JSON.stringify({ waivers: parsed.ledger.waivers.filter(({ id }) => id !== entry.id) }, null, 2)}\n`,
        },
        { source: waiver.file, before: content, after: updated },
      ];
    }
    case "flaky-test-quarantine": {
      const parsed = parseRegistry(JSON.parse(before));
      if (parsed.status === "invalid") {
        return panic(parsed.errors.join("\n"));
      }
      const { entries } = parsed.registry;
      if (
        entries.filter(
          ({ id, expires }) => id === entry.id && expires === entry.expiresAt,
        ).length !== 1
      ) {
        panic(`Flaky-test quarantine anchor missing: ${entry.id}`);
      }
      after = serializeRegistry({
        entries: entries.filter(({ id }) => id !== entry.id),
      });
      break;
    }
    case "pending-contract-migration":
      return panic(`Automatic removal is disabled for ${entry.kind}`);
    default:
      entry.kind satisfies never;
      return panic("Unhandled dated waiver kind");
  }
  return [{ source: entry.source, before, after }];
};

export type ProbeResult = { passed: boolean; output: string };

export const PROBE_PHASE_BUDGET_MS = 45 * 60_000;
export const PROBE_TIMEOUT_MS = 10 * 60_000;
const BUDGET_EXHAUSTED_OUTPUT =
  "Probe phase budget exhausted; no command was launched.";
type ExecuteProbeOptions = { command: readonly string[]; timeoutMs: number };
type CreateProbeBudgetOptions = { attempts: number; now?: () => number };

export const createProbeBudget = ({
  attempts,
  now = () => performance.now(),
}: CreateProbeBudgetOptions) => {
  if (!Number.isSafeInteger(attempts) || attempts < 0) {
    panic("Probe budget requires a nonnegative integer attempt count");
  }
  // One monotonic deadline includes preparation and every entry's probes.
  const deadline = now() + PROBE_PHASE_BUDGET_MS;
  let remainingAttempts = attempts;
  return {
    run: async (
      command: readonly string[],
      execute: (options: ExecuteProbeOptions) => Promise<ProbeResult>,
    ): Promise<ProbeResult> => {
      const started = now();
      const remaining = deadline - started;
      const availableAttempts = remainingAttempts;
      remainingAttempts = Math.max(0, remainingAttempts - 1);
      const timeoutMs =
        availableAttempts > 0
          ? Math.min(
              PROBE_TIMEOUT_MS,
              Math.floor(remaining / availableAttempts),
            )
          : 0;
      if (timeoutMs <= 0) {
        return { passed: false, output: BUDGET_EXHAUSTED_OUTPUT };
      }
      const result = await execute({ command, timeoutMs });
      if (now() >= Math.min(deadline, started + timeoutMs)) {
        return {
          passed: false,
          output: `Probe timed out after ${timeoutMs}ms.\n${result.output}`,
        };
      }
      return result;
    },
  };
};

// Which printed Bun result names the probed test, for kinds whose probe runs
// a single test.
const receiptSelector = (
  entry: DatedWaiver,
): ((name: string) => boolean) | undefined => {
  switch (entry.kind) {
    case "quarantined-test":
      return (name) => name === entry.id || name.endsWith(` > ${entry.id}`);
    case "flaky-test-quarantine": {
      const expected =
        splitTestId(entry.id)?.name ??
        panic(`Invalid flaky-test quarantine id: ${entry.id}`);
      return (name) => name === expected;
    }
    case "guard-rollout":
    case "no-llms-txt":
    case "release-age-exclusion":
    case "release-age-exception":
    case "dependency-audit":
    case "suppression-waiver":
    case "pending-contract-migration":
      return undefined;
    default:
      entry.kind satisfies never;
      return panic("Unhandled dated waiver kind");
  }
};

type RunProbeOptions = {
  run: (command: readonly string[]) => Promise<ProbeResult>;
};
export const runWaiverProbe = async (
  entry: DatedWaiver,
  { run }: RunProbeOptions,
) => {
  const results: ProbeResult[] = [];
  for (let attempt = 0; attempt < entry.probe.attempts; attempt += 1) {
    const result = await Result.tryPromise(async () =>
      run(entry.probe.command),
    );
    if (Result.isError(result)) {
      results.push({
        passed: false,
        output: "Failed to execute probe command.",
      });
      continue;
    }
    const receipt = result.value;
    let executedTest = true;
    const selects = receiptSelector(entry);
    if (selects !== undefined) {
      // Filtered Bun runs may include skipped declarations other than the
      // selected test. Only its named receipt establishes recovery.
      const output = stripVTControlCharacters(receipt.output);
      const selected = output.split(/\r?\n/u).flatMap((line) => {
        const match = /^\((pass|fail|skip|todo)\) (.+)$/u.exec(line);
        const status = match?.at(1);
        const name = match?.at(2)?.replace(/ \[\d+(?:\.\d+)?(?:ms|s)\]$/u, "");
        if (!status || !name || !selects(name)) {
          return [];
        }
        return [status];
      });
      // Duplicate selected names and outer describe.skip remain fail-closed.
      executedTest =
        selected.length === 1 &&
        selected.at(0) === "pass" &&
        /^ *[1-9]\d* pass *$/mu.test(output);
    }
    results.push({
      passed: receipt.passed && executedTest,
      output: receipt.output,
    });
  }
  const passed = results.filter((result) => result.passed).length;
  return {
    status:
      passed === entry.probe.attempts ? ("green" as const) : ("red" as const),
    attempts: entry.probe.attempts,
    passed,
    command: entry.probe.command,
    // Captured output is private evidence; publishers must never place it in PRs.
    output: results
      .filter((result) => !result.passed)
      .map(({ output }, index) => `Sample ${index + 1}:\n${output}`)
      .join("\n")
      .slice(0, 32_000),
  };
};

export const probeDocUrl = async (
  url: string,
  fetchUrl: (url: string) => Promise<Response>,
): Promise<ProbeResult> => {
  if (!url.startsWith("https://") || !url.endsWith("/llms.txt")) {
    return {
      passed: false,
      output: "No canonical HTTPS llms.txt URL recorded.",
    };
  }
  const result = await Result.tryPromise(async () => fetchUrl(url));
  if (Result.isError(result)) {
    return { passed: false, output: "Documentation endpoint request failed." };
  }
  await result.value.body?.cancel();
  return {
    passed: result.value.status === 200,
    output: `Documentation endpoint returned HTTP ${result.value.status}.`,
  };
};

if (import.meta.main && Bun.argv.at(2) === "--doc-url") {
  const result = await probeDocUrl(Bun.argv.at(3) ?? "", async (url) =>
    fetch(url, { signal: AbortSignal.timeout(30_000), redirect: "error" }),
  );
  console.log(result.output);
  process.exitCode = result.passed ? 0 : 1;
}
