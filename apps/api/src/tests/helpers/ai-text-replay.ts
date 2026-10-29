import { panic, Result } from "better-result";
import { afterAll } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import * as ts from "tsrs/unstable/ast";
import type { Symbol as CompilerSymbol } from "tsrs/unstable/async";

import type { AIErrorKind } from "@stll/api-contract";
import { repoRelativePath } from "@stll/portable-path";
import { createProgram } from "@stll/scripts/src/typescript-program";

import { classifyAIError } from "@/api/lib/ai-error";
import type { TanStackTextFinishReason } from "@/api/lib/chat/tanstack-chat-runtime";
import {
  ModelOutputIncompleteError,
  ModelOutputModeratedError,
  ModelRunError,
  ModelRunUnfinishedError,
  ProviderCallError,
} from "@/api/lib/errors/provider-call-error";
import type * as generation from "@/api/lib/tanstack-ai-generate";
import type { TanStackTextFinishPolicy } from "@/api/lib/tanstack-ai-generate";
import { clearByokAdapterCache } from "@/api/lib/tanstack-ai-models";
import type {
  ProviderWireCassette,
  ProviderWireExpectation,
} from "@/api/tests/helpers/provider-wire-cassette";
import { registerProviderWireReplay } from "@/api/tests/helpers/provider-wire-replay";
import type { ProviderWireReplay } from "@/api/tests/helpers/provider-wire-replay";

// Replays the provider wire corpus (`provider-wire-cassette.ts`) through the
// code that reads a text generation's answer: the generation seam itself and
// each handler that calls it. Each cassette states what its provider's
// answer is (a finish and its text, or an error); a call site's finish policy
// decides what that answer must settle as. A settlement that is none of the
// typed outcomes below is an untyped throw, which no cassette expects.

/** What one text generation settled as, as its caller receives it. */
export type TextGenerationOutcome =
  /** The answer the caller uses. */
  | { type: "success"; text: string }
  /** Cut off at the output ceiling (`ModelOutputIncompleteError`). */
  | { type: "incomplete" }
  /** Filtered by the provider (`ModelOutputModeratedError`). */
  | { type: "refusal" }
  /** Ended without an answer, e.g. on a tool call the run did not offer
   *  (`ModelRunUnfinishedError`). */
  | { type: "unfinished" }
  /** A provider or run failure, by the kind it is classified as. */
  | { type: "failure"; kind: AIErrorKind }
  /** Anything else reached the caller. */
  | { type: "untyped"; error: string };

export const textGenerationOutcomeOf = (
  settled: Result<string, unknown>,
): TextGenerationOutcome =>
  Result.isOk(settled)
    ? { type: "success", text: settled.value }
    : textGenerationFailureOf(settled.error);

/** What a generation that threw `error` settled as. */
export const textGenerationFailureOf = (
  error: unknown,
): Exclude<TextGenerationOutcome, { type: "success" }> => {
  // Subclasses of `ModelRunError` first: each names a finish.
  if (error instanceof ModelOutputIncompleteError) {
    return { type: "incomplete" };
  }
  if (error instanceof ModelOutputModeratedError) {
    return { type: "refusal" };
  }
  if (error instanceof ModelRunUnfinishedError) {
    return { type: "unfinished" };
  }
  if (error instanceof ProviderCallError) {
    return { type: "failure", kind: error.kind };
  }
  if (error instanceof ModelRunError) {
    return { type: "failure", kind: classifyAIError(error) };
  }
  return { type: "untyped", error: Bun.inspect(error) };
};

type FinishedOutcomeType = Extract<
  TextGenerationOutcome["type"],
  "incomplete" | "refusal" | "success" | "unfinished"
>;

/**
 * What each finish policy makes of each finish a run reports, as
 * `TanStackTextFinishPolicy` documents it. A new policy or finish reason
 * fails typecheck here until it states its outcome.
 */
const FINISH_POLICY_OUTCOMES = {
  "require-complete": {
    stop: "success",
    length: "incomplete",
    content_filter: "refusal",
    tool_calls: "unfinished",
  },
  "allow-output-ceiling": {
    stop: "success",
    length: "success",
    content_filter: "refusal",
    tool_calls: "unfinished",
  },
  "allow-incomplete": {
    stop: "success",
    length: "success",
    content_filter: "success",
    tool_calls: "success",
  },
} as const satisfies Record<
  TanStackTextFinishPolicy,
  Record<NonNullable<TanStackTextFinishReason>, FinishedOutcomeType>
>;

/**
 * An outcome as a cassette pins it. A recording that cannot know its text
 * (an answer cut at the ceiling, a tool call) leaves it out, and a success
 * then pins only that it succeeded.
 */
export type PinnedTextOutcome =
  | Exclude<TextGenerationOutcome, { type: "success" | "untyped" }>
  | { type: "success"; text?: string };

/** What a call site with `finishPolicy` must settle `expected` as. */
export const expectedTextOutcome = (
  expected: ProviderWireExpectation,
  finishPolicy: TanStackTextFinishPolicy,
): PinnedTextOutcome => {
  switch (expected.outcome) {
    case "error":
      return { type: "failure", kind: expected.errorKind };
    case "finished": {
      const outcome =
        FINISH_POLICY_OUTCOMES[finishPolicy][expected.finishReason];
      switch (outcome) {
        case "success":
          return expected.text === undefined
            ? { type: outcome }
            : { type: outcome, text: expected.text };
        case "incomplete":
        case "refusal":
        case "unfinished":
          return { type: outcome };
        default:
          outcome satisfies never;
          return panic(`Unhandled finished outcome: ${String(outcome)}`);
      }
    }
    default:
      expected satisfies never;
      return panic("Unhandled cassette expectation");
  }
};

/** `outcome` compared as `expected` pins it. */
export const pinnedTextOutcome = (
  outcome: TextGenerationOutcome,
  expected: PinnedTextOutcome,
): PinnedTextOutcome | TextGenerationOutcome =>
  outcome.type === "success" &&
  expected.type === "success" &&
  expected.text === undefined
    ? { type: "success" }
    : outcome;

/**
 * Drives one call site's post-response path over the cassette the replay
 * serves: `got` is what the call site answered, `want` what it must answer.
 */
export type TextCallSiteDriver = {
  /** The path the driver reaches, for test titles. */
  name: string;
  finishPolicy: TanStackTextFinishPolicy;
  settle: (
    cassette: ProviderWireCassette,
  ) => Promise<{ got: unknown; want: unknown }>;
};

type TextCallSiteDriverOptions<TAnswer> = {
  name: string;
  finishPolicy: TanStackTextFinishPolicy;
  /** Runs the call site's handler against the replay. */
  run: (cassette: ProviderWireCassette) => Promise<TAnswer>;
  /** What the handler answers when its generation settles as `expected`. */
  answerFor: (expected: PinnedTextOutcome) => TAnswer;
};

export const textCallSiteDriver = <TAnswer>({
  answerFor,
  finishPolicy,
  name,
  run,
}: TextCallSiteDriverOptions<TAnswer>): TextCallSiteDriver => ({
  finishPolicy,
  name,
  settle: async (cassette) => ({
    got: await run(cassette),
    want: answerFor(expectedTextOutcome(cassette.expect, finishPolicy)),
  }),
});

type ReplayTestState = {
  beforeAll: (setup: () => void) => void;
  setConfig: (key: "USE_MOCK_AI", value: false) => void;
};

/**
 * Serves cassettes to the real adapters for the calling test file, and
 * returns how a driver settles one. Nothing reaches a provider: the replay
 * refuses any request no cassette answers, and reports it in `findings`.
 * Call in the test file's registration scope.
 */
export const installTextReplay = (testState: ReplayTestState) => {
  let replay: ProviderWireReplay | undefined;
  let previousBedrockEndpoint: string | undefined;
  registerProviderWireReplay({
    onInstall: (active) => {
      replay = active;
    },
    options: () => ({ retryAfterMs: 1 }),
  });
  testState.beforeAll(() => {
    // Real adapters, not the local mock model.
    testState.setConfig("USE_MOCK_AI", false);
    // Were a Bedrock request ever to bypass `fetch`, it would go to a host
    // that does not resolve rather than to AWS.
    previousBedrockEndpoint = process.env["AWS_ENDPOINT_URL_BEDROCK_RUNTIME"];
    process.env["AWS_ENDPOINT_URL_BEDROCK_RUNTIME"] =
      "https://bedrock-runtime.us-east-1.amazonaws.com.cassette.invalid";
  });
  afterAll(() => {
    if (previousBedrockEndpoint === undefined) {
      delete process.env["AWS_ENDPOINT_URL_BEDROCK_RUNTIME"];
    } else {
      process.env["AWS_ENDPOINT_URL_BEDROCK_RUNTIME"] = previousBedrockEndpoint;
    }
  });
  return async (driver: TextCallSiteDriver, cassette: ProviderWireCassette) => {
    const served = replay ?? panic("The replay installs before any test runs");
    // A fresh adapter per run, so no state carries between cassettes.
    clearByokAdapterCache();
    served.serve(cassette);
    const settled = await driver.settle(cassette);
    return { ...settled, findings: served.takeFindings() };
  };
};

// --- Which call sites exist -------------------------------------------------

/** What a caller of each generation seam export receives. */
type SeamExportRole =
  /** A text run's answer, graded by a finish policy or read by the caller:
   *  this harness's census. */
  | "text"
  /** A structured answer: `structured-output-role-contracts.test.ts`. */
  | "structured"
  /** No model answer of its own. */
  | "none";

/**
 * Every runtime export of the generation seam, by what its caller receives.
 * A new export fails typecheck here until it names the census that owns its
 * callers.
 */
const GENERATION_SEAM_EXPORTS = {
  generateTanStackTextForTask: "text",
  collectTanStackTextRun: "text",
  streamTanStackTextForTask: "text",
  streamTanStackChatRun: "text",
  // A caller dispatches a text run of its own through it.
  textAdapterWithNormalizedStops: "text",
  generateTanStackObjectForTask: "structured",
  streamTanStackObjectForTask: "structured",
  generateTanStackChatObject: "structured",
  resolveTanStackTextModel: "none",
  withGenerationDeadline: "none",
  withProviderRetryWait: "none",
  withRecoveredProviderStatus: "none",
  structuredOutputWireJsonSchema: "none",
  outputTokensWithinModelLimit: "none",
  abortControllerFromSignal: "none",
  systemPromptsPatch: "none",
  chatTurnOutputTokens: "none",
  mergeGenerationOptions: "none",
} as const satisfies Record<keyof typeof generation, SeamExportRole>;

export const seamExportsOf = (role: SeamExportRole): string[] =>
  Object.entries(GENERATION_SEAM_EXPORTS).flatMap(([name, owner]) =>
    owner === role ? [name] : [],
  );

const SOURCE_ROOT = path.resolve(import.meta.dir, "../..");
const GENERATION_SEAM_MODULE = "@/api/lib/tanstack-ai-generate";
const GENERATION_SEAM_PATH = path.join(SOURCE_ROOT, "lib/tanstack-ai-generate");

/** Code that is not a call site: the seam itself, local mocks, tests. */
const NOT_A_CALL_SITE = ["lib/tanstack-ai-generate.ts", "dev/", "tests/"];

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(full);
    }
    return /\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name)
      ? [full]
      : [];
  });

const childrenAsync = async (
  node: ts.Node,
  visit: (child: ts.Node) => Promise<void>,
): Promise<void> => {
  const children: ts.Node[] = [];
  node.forEachChild((child) => {
    children.push(child);
  });
  for (const child of children) {
    await visit(child);
  }
};

/** Whether `node` sits in an import, a re-export or a type. */
const isOutsideRuntimeCode = (node: ts.Node): boolean => {
  for (let current = node.parent; ; current = current.parent) {
    if (
      ts.isImportDeclaration(current) ||
      ts.isExportDeclaration(current) ||
      ts.isTypeNode(current)
    ) {
      return true;
    }
    if (ts.isSourceFile(current)) {
      return false;
    }
  }
};

/** How many runtime references `source` makes to imported exports in `names`. */
export const runtimeReferences = async (
  file: string,
  source: string,
  names: ReadonlySet<string>,
): Promise<number> => {
  const absolute = path.resolve(file);
  const opened = await createProgram({
    rootNames: [absolute],
    compilerOptions: { noLib: true, noResolve: true, types: [] },
    virtualFiles: new Map([[absolute, source]]),
  });
  try {
    const { checker, program } = opened;
    const sourceFile =
      (await program.getSourceFile(absolute)) ??
      panic(`Missing runtime reference source: ${file}`);
    const importedBindings = new Set<CompilerSymbol>();
    const namespaceBindings = new Set<CompilerSymbol>();

    // The seam by its path alias, or by a relative path from this file.
    const isSeamModule = (specifier: string) =>
      specifier === GENERATION_SEAM_MODULE ||
      (specifier.startsWith(".") &&
        path.resolve(path.dirname(file), specifier.replace(/\.tsx?$/u, "")) ===
          GENERATION_SEAM_PATH);
    for (const statement of sourceFile.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        !isSeamModule(statement.moduleSpecifier.text)
      ) {
        continue;
      }
      const bindings = statement.importClause?.namedBindings;
      if (bindings === undefined) {
        continue;
      }
      if (ts.isNamespaceImport(bindings)) {
        const symbol = await checker.getSymbolAtLocation(bindings.name);
        if (symbol !== undefined) {
          namespaceBindings.add(symbol);
        }
        continue;
      }
      for (const element of bindings.elements) {
        const importedName = element.propertyName?.text ?? element.name.text;
        if (!names.has(importedName)) {
          continue;
        }
        const symbol = await checker.getSymbolAtLocation(element.name);
        if (symbol !== undefined) {
          importedBindings.add(symbol);
        }
      }
    }

    let count = 0;
    const visit = async (node: ts.Node): Promise<void> => {
      if (ts.isIdentifier(node) && !isOutsideRuntimeCode(node)) {
        // `{ generate }` names its property; the value is the imported binding.
        const symbol =
          ts.isShorthandPropertyAssignment(node.parent) &&
          node.parent.name === node
            ? await checker.getShorthandAssignmentValueSymbol(node.parent)
            : await checker.getSymbolAtLocation(node);
        if (symbol !== undefined && importedBindings.has(symbol)) {
          count += 1;
        }
      }
      if (
        ts.isPropertyAccessExpression(node) &&
        names.has(node.name.text) &&
        !isOutsideRuntimeCode(node)
      ) {
        const symbol = await checker.getSymbolAtLocation(node.expression);
        if (symbol !== undefined && namespaceBindings.has(symbol)) {
          count += 1;
        }
      }
      await childrenAsync(node, visit);
    };
    await visit(sourceFile);
    return count;
  } finally {
    await opened.close();
  }
};

/**
 * Every production file that reaches a text export of the seam, with how
 * many runtime references it makes: a call, or a default an injectable
 * parameter takes.
 */
export const discoverTextCallSites = async (): Promise<Map<string, number>> => {
  const names = new Set(seamExportsOf("text"));
  const sites = new Map<string, number>();
  for (const file of sourceFiles(SOURCE_ROOT)) {
    const relative = repoRelativePath(SOURCE_ROOT, file);
    if (NOT_A_CALL_SITE.some((prefix) => relative.startsWith(prefix))) {
      continue;
    }
    const source = readFileSync(file, "utf-8");
    if (![...names].some((name) => source.includes(name))) {
      continue;
    }
    const references = await runtimeReferences(file, source, names);
    if (references > 0) {
      sites.set(relative, references);
    }
  }
  return sites;
};
