import { panic, Result } from "better-result";
import ts from "typescript";

import { chunk as chunkItems } from "@stll/concurrency/chunk";

import { RECORDED_CONVERSATION_SUITES } from "../src/tests/helpers/recorded-conversation-suites";
import rssData from "./test-peak-rss.json";

/** The ordinary DB batch stays small without paying one process per file. */
export const DB_TEST_BATCH_SIZE = 3;

/**
 * Property runs multiply the work inside each file, so each PGlite-backed
 * file gets a fresh process. PGlite's WASM allocation is retained for the
 * process lifetime even after a test closes its client.
 */
export const PROPERTY_DB_TEST_BATCH_SIZE = 1;

export const dbTestBatchSize = (propertyOnly: boolean) =>
  propertyOnly ? PROPERTY_DB_TEST_BATCH_SIZE : DB_TEST_BATCH_SIZE;

/**
 * Recorded conversation suites match transcript generation's per-suite process
 * boundary (gen-chat-transcripts.ts). The memory-heavy files below are isolated
 * by hand until the measured table records them; remove each entry once its
 * measured peak makes the planner run it alone.
 */
export const SOLO_TEST_PATHS: ReadonlySet<string> = new Set([
  ...Object.values(RECORDED_CONVERSATION_SUITES),
  // Its 25,000-row plan fixture grows PGlite's retained WASM memory; closing
  // the client cannot reclaim it, and a three-file Linux batch peaked at 2816 MB.
  "src/lib/scheduler/tasks/legislation-expression-id-backfill-plan.db.test.ts",
  // Seeds 32,000 legislation versions; a three-file batch with it peaked at
  // 2909 MB on Linux.
  "src/handlers/legislation/work-names-plan.db.test.ts",
  // Sets the deployment's public address before the environment is read.
  "src/lib/oauth-cli-client-document.db.test.ts",
  // Owns the CIMD transport module and the AS JWKS fetch for the whole process.
  "src/lib/oauth-cimd-private-key-jwt.db.test.ts",
]);

/**
 * Move each solo file out of its composed batch into a batch of its own. The
 * files it leaves behind keep sharing their process, so no other batch
 * changes composition.
 */
export const splitSoloTests = (
  batches: readonly string[][],
  soloPaths: ReadonlySet<string>,
): string[][] =>
  batches.flatMap((batch) => {
    const shared = batch.filter((testPath) => !soloPaths.has(testPath));
    const solo = batch
      .filter((testPath) => soloPaths.has(testPath))
      .map((testPath) => [testPath]);
    return shared.length > 0 ? [shared, ...solo] : solo;
  });

// Shared batches reserve headroom for interaction between retained module graphs.
export const TEST_BATCH_RSS_HEADROOM_RATIO = 0.7;
export const UNMEASURED_TEST_RSS_RATIO = 0.4;
export const SOLO_TEST_RSS_RATIO = 0.6;

export type TestRssEnvironment = {
  os: string;
  arch: string;
  bunVersion: string;
  runnerImage: string;
};
export type TestRssSource = { runId: string; job: string };
export type TestRssFile = {
  peakMb: number;
  baselineMb: number;
  source: TestRssSource;
};
export type TestRssTable = {
  environment: TestRssEnvironment;
  /** When the run's last shard finished measuring, as an ISO 8601 instant. */
  measuredAt: string;
  baselineMb: number;
  files: Readonly<Record<string, TestRssFile>>;
};

const rssRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    panic(`Invalid ${label}`);
  }
  return Object.fromEntries(Object.entries(value));
};
const rssPositive = (value: unknown, label: string) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return panic(`Invalid ${label}`);
  }
  return value;
};
const rssString = (value: unknown, label: string) => {
  if (typeof value !== "string" || value.trim().length === 0) {
    return panic(`Invalid ${label}`);
  }
  return value;
};
export const readTestRssInstant = (value: unknown, label: string) => {
  if (
    typeof value !== "string" ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    return panic(`Invalid ${label}`);
  }
  return value;
};
export const readTestRssSource = (value: unknown): TestRssSource => {
  const raw = rssRecord(value, "RSS source");
  return {
    runId: rssString(raw["runId"], "run id"),
    job: rssString(raw["job"], "job"),
  };
};
export const readTestRssEnvironment = (value: unknown): TestRssEnvironment => {
  const raw = rssRecord(value, "RSS environment");
  return {
    os: rssString(raw["os"], "OS"),
    arch: rssString(raw["arch"], "architecture"),
    bunVersion: rssString(raw["bunVersion"], "Bun version"),
    runnerImage: rssString(raw["runnerImage"], "runner image"),
  };
};

export const readTestRssTable = (value: unknown): TestRssTable => {
  const raw = rssRecord(value, "RSS table");
  const files = rssRecord(raw["files"], "RSS files");
  const baselineMb = rssPositive(raw["baselineMb"], "RSS baseline");
  const measured = Object.fromEntries(
    Object.entries(files).map(([file, observation]): [string, TestRssFile] => {
      const row = rssRecord(observation, `RSS row ${file}`);
      const fileBaseline = rssPositive(
        row["baselineMb"],
        `RSS baseline for ${file}`,
      );
      if (fileBaseline > baselineMb) {
        panic(`Table baseline is below the measured baseline for ${file}`);
      }
      return [
        file,
        {
          peakMb: rssPositive(row["peakMb"], `peak RSS for ${file}`),
          baselineMb: fileBaseline,
          source: readTestRssSource(row["source"]),
        },
      ];
    }),
  );
  return {
    environment: readTestRssEnvironment(raw["environment"]),
    measuredAt: readTestRssInstant(raw["measuredAt"], "RSS measurement time"),
    baselineMb,
    files: measured,
  };
};

/** The committed table is consumed only through this planner boundary. */
export const measuredTestRssTable = () => readTestRssTable(rssData);
export const TEST_RSS_TABLE_MAX_AGE_DAYS = 14;
const DAY_MS = 86_400_000;

/**
 * The weekly measurement opens a refresh pull request; an annotation in every
 * API test run keeps an unmerged or failed refresh from going unnoticed. It
 * never fails the run: stale weights only cost batch packing, and the runtime
 * memory caps stay authoritative.
 */
export const staleTestRssTableAnnotation = (measuredAt: string, now: Date) => {
  const ageDays = Math.floor((now.getTime() - Date.parse(measuredAt)) / DAY_MS);
  if (ageDays <= TEST_RSS_TABLE_MAX_AGE_DAYS) {
    return undefined;
  }
  return (
    "::warning title=API test memory profile is stale::" +
    `apps/api/scripts/test-peak-rss.json was measured ${ageDays} days ago ` +
    `(${measuredAt}), more than ${TEST_RSS_TABLE_MAX_AGE_DAYS}; merge the open ` +
    "refresh pull request or rerun the API test memory workflow " +
    "(docs/test-memory.md)"
  );
};

export const unmeasuredTestPeakRss = (budgetMb: number) =>
  Math.ceil(
    budgetMb * TEST_BATCH_RSS_HEADROOM_RATIO * UNMEASURED_TEST_RSS_RATIO,
  );

const rssFileWeight = (file: string, table: TestRssTable, budgetMb: number) => {
  const observation = table.files[file];
  if (observation === undefined) {
    const incrementalMb = unmeasuredTestPeakRss(budgetMb);
    return {
      type: "unmeasured",
      peakMb: table.baselineMb + incrementalMb,
      incrementalMb,
    } as const;
  }
  return {
    type: "measured",
    peakMb: observation.peakMb,
    incrementalMb: Math.max(0, observation.peakMb - observation.baselineMb),
  } as const;
};

type BatchPeakRssOptions = {
  files: readonly string[];
  rssTable: TestRssTable;
  budgetMb: number;
};
export const batchPeakRss = ({
  files,
  rssTable,
  budgetMb,
}: BatchPeakRssOptions) => {
  let peakMb = rssTable.baselineMb;
  for (const file of files) {
    peakMb += rssFileWeight(file, rssTable, budgetMb).incrementalMb;
  }
  return peakMb;
};

type SplitMemoryBoundedBatchesOptions = {
  batches: readonly string[][];
  rssTable?: TestRssTable;
  /** Hard execution-class cap; shared composition additionally reserves headroom. */
  budgetMb: number;
};

/** Split existing batches without introducing new process neighbours. */
export const splitMemoryBoundedBatches = ({
  batches,
  rssTable = measuredTestRssTable(),
  budgetMb,
}: SplitMemoryBoundedBatchesOptions): string[][] => {
  if (!Number.isFinite(budgetMb) || budgetMb <= 0) {
    panic("test batch memory budget must be positive and finite");
  }
  const compositionBudgetMb = budgetMb * TEST_BATCH_RSS_HEADROOM_RATIO;
  const result: string[][] = [];
  for (const batch of batches) {
    let current: string[] = [];
    let totalMb = rssTable.baselineMb;
    for (const file of batch) {
      const weight = rssFileWeight(file, rssTable, budgetMb);
      if (
        !Number.isFinite(weight.peakMb) ||
        weight.peakMb <= 0 ||
        !Number.isFinite(weight.incrementalMb) ||
        weight.incrementalMb < 0
      ) {
        panic(`Invalid peak RSS for ${file}`);
      }
      const singletonPeak = rssTable.baselineMb + weight.incrementalMb;
      if (singletonPeak > budgetMb) {
        panic(
          `Cannot plan API test batch [${batch.join(", ")}]: ${file} requires ${singletonPeak} MB, class budget ${budgetMb} MB`,
        );
      }
      if (
        weight.type === "measured" &&
        singletonPeak >= budgetMb * SOLO_TEST_RSS_RATIO
      ) {
        if (current.length > 0) {
          result.push(current);
          current = [];
          totalMb = rssTable.baselineMb;
        }
        result.push([file]);
        continue;
      }
      if (
        current.length > 0 &&
        totalMb + weight.incrementalMb > compositionBudgetMb
      ) {
        result.push(current);
        current = [];
        totalMb = rssTable.baselineMb;
      }
      current.push(file);
      totalMb += weight.incrementalMb;
    }
    if (current.length > 0) {
      result.push(current);
    }
  }
  for (const batch of result) {
    const peak = batchPeakRss({ files: batch, rssTable, budgetMb });
    if (peak > budgetMb) {
      panic(
        `Cannot plan API test batch [${batch.join(", ")}]: requires ${peak} MB, class budget ${budgetMb} MB`,
      );
    }
  }
  return result;
};

export type TestRssMeasurement = {
  file: string;
  peakMb: number;
  exitCode: number;
};
export type TestRssShard = { index: number; count: number };
export const TEST_RSS_RECEIPT_VERSION = 3;
type TestRssArtifactOptions = {
  measurements: readonly TestRssMeasurement[];
  /** When the shard finished measuring; the refreshed table keeps the latest. */
  measuredAt: string;
  baselineMb: number;
  environment: TestRssEnvironment;
  source: TestRssSource;
  /** Shard and file count let a refresh prove the run measured every file it owned. */
  shard: TestRssShard;
  plannedFiles: number;
};
export const testRssArtifact = ({
  measurements,
  measuredAt,
  baselineMb,
  environment,
  source,
  shard,
  plannedFiles,
}: TestRssArtifactOptions) =>
  `${JSON.stringify({ version: TEST_RSS_RECEIPT_VERSION, environment, source, measuredAt, shard, plannedFiles, baselineMb, measurements }, null, 2)}\n`;

export const parseRssMeasurementArguments = (arguments_: readonly string[]) => {
  const index = arguments_.indexOf("--measure-rss");
  if (index === -1) {
    return { mode: "batched", arguments: [...arguments_] } as const;
  }
  const outputPath = arguments_.at(index + 1);
  if (
    outputPath === undefined ||
    outputPath.startsWith("-") ||
    outputPath.length === 0 ||
    arguments_.lastIndexOf("--measure-rss") !== index ||
    arguments_.includes("--property")
  ) {
    panic(
      "Usage: --measure-rss <artifact.json> (full per-file measurement; no --property)",
    );
  }
  const remaining = arguments_.filter(
    (_, position) => position !== index && position !== index + 1,
  );
  const takeOption = (flag: string, fallback: string) => {
    const position = remaining.indexOf(flag);
    if (position === -1) {
      return fallback;
    }
    const value = remaining.at(position + 1);
    if (
      value === undefined ||
      value.startsWith("-") ||
      remaining.lastIndexOf(flag) !== position
    ) {
      return panic(`Missing or repeated ${flag}`);
    }
    remaining.splice(position, 2);
    return value;
  };
  const runnerImage = rssString(
    takeOption("--measure-rss-image", "local"),
    "runner image",
  );
  const source = readTestRssSource(
    Result.try((): unknown =>
      JSON.parse(
        takeOption("--measure-rss-source", '{"runId":"local","job":"local"}'),
      ),
    ).unwrapOr(undefined) ??
      panic("--measure-rss-source must be a JSON object"),
  );
  return {
    mode: "measure-rss",
    outputPath,
    source,
    environment: {
      os: process.platform,
      arch: process.arch,
      bunVersion: Bun.version,
      runnerImage,
    },
    arguments: remaining,
  } as const;
};

export const TEST_BATCH_KIND = {
  db: "db",
  heavyLogic: "heavy-logic",
  heavyDb: "heavy-db",
  moduleMock: "module-mock",
  regular: "regular",
} as const;

export type TestBatchKind =
  (typeof TEST_BATCH_KIND)[keyof typeof TEST_BATCH_KIND];

type ClassifyTestBatchOptions = {
  dbBacked: boolean;
  heavyLogic: boolean;
  heavyDb: boolean;
  installsModuleMock: boolean;
  propertyOnly: boolean;
};

/**
 * Heavy DB markers require a DB-backed file and exclude heavy logic markers.
 * Heavy DB isolation takes precedence over mocks and property mode: a singleton
 * process satisfies all three constraints. Property DB isolation
 * takes precedence over module-mock batching because either class may retain
 * process-wide state, while a singleton process satisfies both constraints.
 */
export const classifyTestBatch = ({
  dbBacked,
  heavyDb,
  heavyLogic,
  installsModuleMock,
  propertyOnly,
}: ClassifyTestBatchOptions) => {
  if (heavyDb) {
    if (!dbBacked || heavyLogic) {
      panic("Heavy DB tests must be DB-backed and cannot also be heavy logic");
    }
    return TEST_BATCH_KIND.heavyDb;
  }
  if (propertyOnly && dbBacked) {
    return TEST_BATCH_KIND.db;
  }
  if (installsModuleMock) {
    return TEST_BATCH_KIND.moduleMock;
  }
  if (dbBacked) {
    return TEST_BATCH_KIND.db;
  }
  if (heavyLogic) {
    return TEST_BATCH_KIND.heavyLogic;
  }
  return TEST_BATCH_KIND.regular;
};

/** Split files exactly as the runner will execute them. */
export const composeTestBatches = (
  testFiles: readonly string[],
  batchSize: number,
): string[][] => {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    panic("test batch size must be a positive integer");
  }

  // Oversized integer widths still produce one batch, as before; array lengths
  // fit within the owner's safe-integer cursor contract.
  return chunkItems(testFiles, Math.min(batchSize, Number.MAX_SAFE_INTEGER));
};

const DB_TEST_MARKERS = [
  "tests/security/rls-helpers",
  "tests/security/rls-fixture",
  "tests/security/test-utils",
  "tests/pglite-schema",
  "@/api/db/root",
  "@/api/db/scoped",
  "pglite",
] as const;
const DB_TEST_PATH_RE = /\.(?:integration|db)\.test\.tsx?$/u;

const isProcessEnvExpression = (expression: ts.Expression): boolean =>
  ts.isPropertyAccessExpression(expression) &&
  ts.isIdentifier(expression.expression) &&
  expression.expression.text === "process" &&
  expression.name.text === "env";

const isProcessEnvMember = (expression: ts.Expression): boolean =>
  (ts.isElementAccessExpression(expression) ||
    ts.isPropertyAccessExpression(expression)) &&
  isProcessEnvExpression(expression.expression);

const isDeferredFunction = (node: ts.Node): boolean =>
  ts.isArrowFunction(node) ||
  ts.isConstructorDeclaration(node) ||
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isGetAccessorDeclaration(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isSetAccessorDeclaration(node);

const unwrapParentheses = (expression: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(expression)
    ? unwrapParentheses(expression.expression)
    : expression;

const immediatelyInvokedBody = (node: ts.Node): ts.ConciseBody | null => {
  if (!ts.isCallExpression(node)) {
    return null;
  }
  const callee = unwrapParentheses(node.expression);
  return ts.isArrowFunction(callee) || ts.isFunctionExpression(callee)
    ? callee.body
    : null;
};

const isAssignmentOperator = (kind: ts.SyntaxKind): boolean =>
  kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;

const hasEvaluatedProcessEnvMutation = (node: ts.Node): boolean => {
  const invokedBody = immediatelyInvokedBody(node);
  if (invokedBody !== null && hasEvaluatedProcessEnvMutation(invokedBody)) {
    return true;
  }
  if (isDeferredFunction(node)) {
    return false;
  }
  if (
    ts.isBinaryExpression(node) &&
    isAssignmentOperator(node.operatorToken.kind) &&
    isProcessEnvMember(node.left)
  ) {
    return true;
  }
  return (
    ts.forEachChild(node, (child) =>
      hasEvaluatedProcessEnvMutation(child) ? true : undefined,
    ) === true
  );
};

/**
 * Module-scope environment writes must run in a fresh process. Bun's module
 * cache survives between files in a shared batch, so setting an env value
 * after another file imported its reader cannot change the cached contract.
 */
export const hasModuleScopeProcessEnvMutation = (
  testPath: string,
  source: string,
): boolean => {
  const sourceFile = ts.createSourceFile(
    testPath,
    source,
    ts.ScriptTarget.Latest,
    false,
    testPath.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  return sourceFile.statements.some(hasEvaluatedProcessEnvMutation);
};

const isRuntimeImport = (statement: ts.ImportDeclaration) => {
  const { importClause } = statement;
  if (importClause === undefined) {
    return true;
  }
  if (importClause.phaseModifier === ts.SyntaxKind.TypeKeyword) {
    return false;
  }
  if (importClause.name !== undefined) {
    return true;
  }
  const { namedBindings } = importClause;
  if (namedBindings === undefined || ts.isNamespaceImport(namedBindings)) {
    return true;
  }
  return (
    namedBindings.elements.length === 0 ||
    namedBindings.elements.some((element) => !element.isTypeOnly)
  );
};

/** Detect tests that create or acquire the embedded PGlite database. */
export const isDbTest = (testPath: string, source: string) => {
  if (DB_TEST_PATH_RE.test(testPath)) {
    return true;
  }
  const sourceFile = ts.createSourceFile(
    testPath,
    source,
    ts.ScriptTarget.Latest,
    false,
    testPath.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  return sourceFile.statements.some((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !isRuntimeImport(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      return false;
    }
    const moduleSpecifier = statement.moduleSpecifier.text;
    return DB_TEST_MARKERS.some((marker) => moduleSpecifier.includes(marker));
  });
};
