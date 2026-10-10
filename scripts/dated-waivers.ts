// Add each new dated exception at its owner, then register its adapter here.
// The census covers policy/config expiry keys; prose-only review promises need
// an explicit adapter (see docs/maintenance/dated-waivers.md).
import { panic } from "better-result";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { compareCodeUnit } from "@stll/collation";

import {
  DOC_SOURCE_EXCLUSIONS,
  type NoLlmsTxtExclusion,
} from "../.claude/mcp/doc-sources";
import {
  readReleaseAgeExceptions,
  readTemporaryExcludes,
  RELEASE_AGE_EXCEPTION_SOURCES,
} from "./check-stll-quarantine-excludes";
import { readBaseline } from "./dependency-audit";
import type { AcceptanceTerms } from "./dependency-audit-acceptance";
import { parseLedger } from "./suppression-waivers";

export const DAY_MS = 86_400_000;
export const WARNING_DAYS = 5;
// Network checks get three independent samples; test/rule probes get twenty
// to catch intermittent failures before removing their quarantine.
export const NETWORK_ATTEMPTS = 3;
export const TEST_ATTEMPTS = 20;
export type WaiverProbe = { command: readonly string[]; attempts: number };
export const DOC_SOURCE_FILE = ".claude/mcp/doc-sources.ts";

export const RECHECK_INSTRUCTIONS = {
  "no-llms-txt": "Check canonical llms.txt and register an available source.",
  "release-age-exclusion":
    "Verify the pinned release passes the normal release-age gate, then remove the temporary exclusion.",
  "release-age-exception":
    "Recheck the release-age policy and remove the annotated exception.",
  "dependency-audit":
    "Re-run the dependency audit, check patched releases and dependency reachability; remove the acceptance.",
  "quarantined-test": "Run the quarantined test without its skip.",
  "suppression-waiver":
    "Recheck the suppression invariant and evidence; remove the suppression.",
} as const;

export type DatedWaiver = {
  source: string;
  line: number;
  id: string;
  kind: keyof typeof RECHECK_INSTRUCTIONS;
  // Preserve the owner-written deadline; normalize only for evaluation.
  expiresAt: string;
  probe: WaiverProbe;
  checkedAt?: string;
};

// Date-only owners accept through the entire UTC day. Preserve that boundary.
export const expiryInstant = (date: string): string => {
  const instant = date.length === 10 ? `${date}T00:00:00.000Z` : date;
  const ms = Date.parse(instant);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== instant) {
    panic(`Invalid dated waiver expiry: ${date}`);
  }
  return date.length === 10 ? new Date(ms + DAY_MS).toISOString() : instant;
};

const sourceLine = (content: string, id: string): number => {
  const line = content
    .split("\n")
    .findIndex((value) => value.includes(JSON.stringify(id)));
  if (line === -1) {
    panic(`Dated waiver source anchor missing: ${id}`);
  }
  return line + 1;
};

type CollectWaiversOptions = {
  read: (file: string) => string;
  docs: readonly NoLlmsTxtExclusion[];
  audit: readonly AcceptanceTerms[];
  bunfigs: readonly string[];
  releaseAgeSources: Readonly<Record<string, string>>;
  quarantineSources?: Readonly<Record<string, string>>;
};

export const collectWaivers = ({
  read,
  docs,
  audit,
  bunfigs,
  releaseAgeSources,
  quarantineSources = {},
}: CollectWaiversOptions): DatedWaiver[] => {
  const entries: DatedWaiver[] = docs.map((entry) => ({
    source: DOC_SOURCE_FILE,
    line: sourceLine(read(DOC_SOURCE_FILE), entry.dependency),
    id: entry.dependency,
    kind: "no-llms-txt",
    expiresAt: entry.expiresAt,
    checkedAt: entry.checkedAt,
    probe: {
      command: [
        "bun",
        "scripts/dated-waiver-probes.ts",
        "--doc-url",
        /https:\/\/[^\s()]+\/llms\.txt\b/u.exec(entry.explanation)?.at(0) ?? "",
      ],
      attempts: NETWORK_ATTEMPTS,
    },
  }));
  for (const source of bunfigs) {
    const contents = read(source);
    const parsed = readTemporaryExcludes(contents);
    if (parsed.errors.length > 0) {
      panic(parsed.errors.join("\n"));
    }
    for (const entry of parsed.entries) {
      entries.push({
        source,
        line: sourceLine(contents, entry.name),
        id: entry.name,
        kind: "release-age-exclusion",
        probe: {
          command: [
            "bun",
            "scripts/check-lockfile-release-ages.ts",
            "--all",
            "--package",
            entry.name,
          ],
          attempts: NETWORK_ATTEMPTS,
        },
        expiresAt: entry.expiresAt,
      });
    }
  }
  const auditSource = "scripts/dependency-audit-baseline.json";
  for (const entry of audit) {
    if (entry.expiresOn === undefined) {
      continue;
    }
    entries.push({
      source: auditSource,
      line: sourceLine(read(auditSource), entry.id),
      id: entry.id,
      kind: "dependency-audit",
      probe: {
        command: ["bun", "run", "security:audit"],
        attempts: NETWORK_ATTEMPTS,
      },
      expiresAt: entry.expiresOn,
    });
  }
  const suppressionSource = "scripts/suppression-waivers.json";
  const ledger = parseLedger(JSON.parse(read(suppressionSource)));
  if (ledger.status === "invalid") {
    panic(ledger.errors.join("\n"));
  }
  for (const entry of ledger.ledger.waivers) {
    if (entry.kind === "permanent") {
      continue;
    }
    entries.push({
      source: suppressionSource,
      line: sourceLine(read(suppressionSource), entry.id),
      id: entry.id,
      kind: "suppression-waiver",
      probe: {
        command: [
          "bun",
          "--bun",
          "oxlint",
          "-c",
          "oxlint.config.ts",
          "--report-unused-disable-directives-severity=error",
          "--type-aware",
          entry.file,
        ],
        attempts: TEST_ATTEMPTS,
      },
      expiresAt: entry.expires,
    });
  }
  const exceptions = readReleaseAgeExceptions(releaseAgeSources);
  if (exceptions.errors.length > 0) {
    panic(exceptions.errors.join("\n"));
  }
  for (const entry of exceptions.entries) {
    entries.push({
      ...entry,
      id: `${entry.source}:${entry.line}`,
      kind: "release-age-exception",
      probe: {
        command: ["bun", "scripts/check-lockfile-release-ages.ts", "--all"],
        attempts: NETWORK_ATTEMPTS,
      },
    });
  }
  entries.push(...readTestQuarantines(quarantineSources));
  const identities = new Set<string>();
  for (const entry of entries) {
    expiryInstant(entry.expiresAt);
    const identity = JSON.stringify([entry.kind, entry.source, entry.id]);
    if (identities.has(identity)) {
      panic(`Duplicate dated waiver identity: ${entry.source}:${entry.id}`);
    }
    identities.add(identity);
  }
  return entries.toSorted(
    (a, b) =>
      compareCodeUnit(expiryInstant(a.expiresAt), expiryInstant(b.expiresAt)) ||
      compareCodeUnit(`${a.source}:${a.id}`, `${b.source}:${b.id}`),
  );
};

export const dueWaivers = (
  entries: readonly DatedWaiver[],
  now: Date,
  days = WARNING_DAYS,
): DatedWaiver[] =>
  entries.filter(
    (entry) =>
      Date.parse(expiryInstant(entry.expiresAt)) <=
      now.getTime() + days * DAY_MS,
  );

const escapeCommand = (value: string): string =>
  value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
export const waiverWarnings = (
  entries: readonly DatedWaiver[],
  now: Date,
): string[] =>
  dueWaivers(entries, now).map(
    (entry) =>
      `::warning file=${escapeCommand(entry.source).replaceAll(",", "%2C").replaceAll(":", "%3A")},line=${entry.line}::${escapeCommand(`${entry.id} (${entry.kind}) expires at ${entry.expiresAt}; ${RECHECK_INSTRUCTIONS[entry.kind]}`)}`,
  );

// A dated test quarantine is an adjacent comment on a literal test.skip/it.skip
// call. The inventory guard blocks at expiry even while the source still skips.
export const readTestQuarantines = (
  sources: Readonly<Record<string, string>>,
): DatedWaiver[] => {
  const entries: DatedWaiver[] = [];
  for (const [source, contents] of Object.entries(sources)) {
    const ast = ts.createSourceFile(
      source,
      contents,
      ts.ScriptTarget.Latest,
      true,
    );
    const consumed = new Set<number>();
    const scanner = ts.createScanner(
      ts.ScriptTarget.Latest,
      false,
      ts.LanguageVariant.Standard,
      contents,
    );
    const markers = new Map<number, string>();
    let token = scanner.scan();
    while (token !== ts.SyntaxKind.EndOfFileToken) {
      if (
        token === ts.SyntaxKind.SingleLineCommentTrivia ||
        token === ts.SyntaxKind.MultiLineCommentTrivia
      ) {
        const match = /test-quarantine-expires:\s*(\S+)/u.exec(
          scanner.getTokenText(),
        );
        if (match) {
          markers.set(scanner.getTokenPos(), match.at(1) ?? "");
        }
      }
      token = scanner.scan();
    }
    if (markers.size === 0) {
      continue;
    }
    const diagnostics =
      ts.transpileModule(contents, {
        fileName: source,
        reportDiagnostics: true,
      }).diagnostics ?? [];
    if (
      diagnostics.some(
        ({ category }) => category === ts.DiagnosticCategory.Error,
      )
    ) {
      panic(`Test quarantine owner does not parse: ${source}`);
    }
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "skip" &&
        ["test", "it"].includes(node.expression.expression.getText(ast))
      ) {
        const markersHere = [...markers].filter(
          ([offset]) =>
            offset >= node.getFullStart() && offset < node.getStart(ast),
        );
        if (markersHere.length > 0) {
          const marker = markersHere.at(0);
          const title = node.arguments.at(0);
          if (
            markersHere.length !== 1 ||
            !marker ||
            !title ||
            !ts.isStringLiteral(title)
          ) {
            panic(
              `Test quarantine needs one literal test title and expiry: ${source}`,
            );
          }
          const [offset, expiresAt] = marker;
          expiryInstant(expiresAt);
          consumed.add(offset);
          const owner = /^(?:apps|packages)\/[^/]+/u.exec(source)?.at(0);
          const pattern = title.text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
          const relative = owner ? source.slice(owner.length + 1) : source;
          entries.push({
            source,
            line:
              ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
            id: title.text,
            kind: "quarantined-test",
            expiresAt,
            probe: {
              command: owner
                ? [
                    "bun",
                    `--cwd=${owner}`,
                    "run",
                    "test",
                    "--",
                    relative,
                    "-t",
                    pattern,
                  ]
                : ["bun", "test", source, "-t", pattern],
              attempts: TEST_ATTEMPTS,
            },
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    if (consumed.size !== markers.size) {
      panic(`Unowned dated test quarantine marker: ${source}`);
    }
  }
  return entries;
};

// Only expiry-bearing declarations in policy/config files enter the census.
// Ordinary timestamps, historical dates and runtime credential TTLs do not.
export const uncoveredExpirySources = (
  sources: Readonly<Record<string, string>>,
  covered: ReadonlySet<string>,
): string[] =>
  Object.entries(sources)
    .filter(
      ([file, content]) =>
        !covered.has(file) &&
        /(?:["']?(?:expiresAt|expiresOn|expires|expires_at|expires_on|expires-at|reviewBy|review-by|until|EXPIRES_AT)["']?\s*[:=]\s*["']?\d{4}-\d{2}-\d{2}|(?:quarantine-expires|release-age-quarantine-exception):\s*\d{4}-\d{2}-\d{2})/u.test(
          content,
        ),
    )
    .map(([file]) => file);

export const trackedPolicyFiles = (): string[] => {
  const proc = Bun.spawnSync(["git", "ls-files", "-z"], {
    cwd: path.resolve(import.meta.dir, ".."),
  });
  if (proc.exitCode !== 0) {
    panic("Cannot enumerate tracked policy files");
  }
  return proc.stdout.toString().split("\0").filter(Boolean);
};

export const loadWaivers = async (): Promise<DatedWaiver[]> => {
  const root = path.resolve(import.meta.dir, "..");
  const read = (file: string): string =>
    readFileSync(path.join(root, file), "utf-8");
  const tracked = trackedPolicyFiles();
  const files = tracked.filter(
    (file) => file === "bunfig.toml" || file.endsWith("/bunfig.toml"),
  );
  const policyFiles = tracked.filter(
    (file) =>
      /(?:^(?:scripts\/|\.claude\/mcp\/|\.oxlint-plugins\/|\.github\/)|config|baseline|waivers|allowances|bunfig\.toml$)/u.test(
        file,
      ) &&
      /\.(?:ts|json|toml|ya?ml)$/u.test(file) &&
      !/(?:\.test\.|\.spec\.|fixtures\/|__fixtures__\/)/u.test(file),
  );
  const uncovered = uncoveredExpirySources(
    Object.fromEntries(policyFiles.map((file) => [file, read(file)])),
    new Set([
      DOC_SOURCE_FILE,
      "scripts/suppression-waivers.ts",
      "scripts/suppression-waivers.json",
      "scripts/dependency-audit-baseline.json",
      ...RELEASE_AGE_EXCEPTION_SOURCES,
      ...files,
    ]),
  );
  if (uncovered.length > 0) {
    panic(`Unregistered dated waiver owners: ${uncovered.join(", ")}`);
  }
  const configSources = Object.fromEntries(
    RELEASE_AGE_EXCEPTION_SOURCES.map((file) => [file, read(file)]),
  );
  return collectWaivers({
    read,
    docs: DOC_SOURCE_EXCLUSIONS,
    audit: (await readBaseline()).accepted,
    bunfigs: files,
    releaseAgeSources: configSources,
    quarantineSources: Object.fromEntries(
      tracked
        .filter((file) => /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file))
        .map((file) => [file, read(file)] as const)
        .filter(([, content]) => content.includes("test-quarantine-expires:")),
    ),
  });
};

if (import.meta.main) {
  const entries = await loadWaivers();
  if (process.argv.includes("--check")) {
    const expired = entries.filter(
      (entry) => Date.parse(expiryInstant(entry.expiresAt)) <= Date.now(),
    );
    if (expired.length > 0) {
      console.error(
        expired
          .map(
            (entry) =>
              `${entry.source}:${entry.line} dated waiver expired: ${entry.id}`,
          )
          .join("\n"),
      );
      process.exitCode = 1;
    }
  } else if (process.argv.includes("--due")) {
    console.log(dueWaivers(entries, new Date()).length > 0);
  } else if (process.argv.includes("--warn")) {
    for (const warning of waiverWarnings(entries, new Date())) {
      console.log(warning);
    }
  } else {
    console.log(JSON.stringify(entries, null, 2));
  }
}
