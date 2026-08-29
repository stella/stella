import { eslintCompatPlugin } from "@oxlint/plugins";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  filenameForContext,
  getImportedName,
  getImportLocalName,
  getPropertyName,
  isAstNode,
  isIdentifier,
  isStringLiteral,
} from "./utils.ts";

// Forbid `mock.module(...)` against a workspace module.
//
// A module mock replaces the whole dependency graph beneath the test with a
// fabrication: the test then proves that the code under test calls a function
// of that name with those arguments, not that the real module still honors
// the contract. A renamed export, a changed return shape, or a new required
// argument in the mocked module leaves the mock, and the test, green. Bun's
// mock registry is also process-wide, so a mock installed in one file reaches
// every other file sharing the process; the api test runner has to batch
// files around that (apps/api/scripts/run-tests.ts).
//
// Flagged: `mock.module(<specifier>, ...)` where `mock` is bound from
// `bun:test` (a named import, an aliased import, or a namespace member) and
// `<specifier>` names a workspace module: a relative path, an absolute path,
// or a workspace alias (`@/`, `@stll/`). A non-literal specifier is
// flagged too, because it cannot be classified.
//
// Accepted: mocks of npm packages and of `bun:*`/`node:*` builtins. Those
// isolate an external boundary (object storage, a browser, a network SDK);
// the drift hazard above is bounded by that package's own release contract.
//
// Migration: give the dependency to the code under test instead of the code
// finding it. A handler reads its collaborators from its context; a library
// function takes them as an options parameter; a plain fake stands in for
// them in the test. When the real module wraps an external boundary, mock
// the npm package it calls, or expose a test seam on the wrapper.
//
// Grandfathering: `scripts/internal-module-mock-ledger.json` lists every
// `<file>::<specifier>` pair that mocked a workspace module when the rule
// landed. A listed pair is not reported; a pair in the ledger with no
// matching mock in its file is reported as stale, so the only sanctioned
// ledger edit is deleting a line the rule has already named. The ratchet
// (`scripts/ratchet.ts`, `internal-module-mock-ledger-entries`) fails when
// the ledger grows.

const RULE_NAME = "no-internal-module-mock";
const MOCK_SOURCE = "bun:test";
const MOCK_BINDING = "mock";
const MODULE_METHOD = "module";
const LEDGER_RELATIVE_PATH = "../scripts/internal-module-mock-ledger.json";
const LEDGER_DISPLAY_PATH = "scripts/internal-module-mock-ledger.json";
const PAIR_SEPARATOR = "::";

// Specifier prefixes that resolve inside this repository. `@stll/` is the
// workspace scope (AGENTS.md: every `apps/*` and `packages/*` child is
// `@stll/<directory>`); `@/` is the tsconfig source alias of every app.
const WORKSPACE_PREFIXES = ["./", "../", "/", "@/", "@stll/"] as const;

export const isWorkspaceSpecifier = (specifier: string): boolean =>
  specifier === "." ||
  specifier === ".." ||
  WORKSPACE_PREFIXES.some((prefix) => specifier.startsWith(prefix));

// Ledger entries grouped by the file they belong to, read once per process.
// The ledger holds repo-relative POSIX paths; the linted filename is absolute,
// so entries are matched by path suffix.
let ledgerByFile: ReadonlyMap<string, ReadonlySet<string>> | null = null;

const readLedger = (): ReadonlyMap<string, ReadonlySet<string>> => {
  if (ledgerByFile !== null) {
    return ledgerByFile;
  }
  const ledgerPath = path.join(import.meta.dirname, LEDGER_RELATIVE_PATH);
  const parsed: unknown = JSON.parse(readFileSync(ledgerPath, "utf-8"));
  if (
    !Array.isArray(parsed) ||
    !parsed.every((entry) => typeof entry === "string")
  ) {
    throw new TypeError(
      `${LEDGER_DISPLAY_PATH} must be a JSON array of strings`,
    );
  }
  // Sorted and duplicate-free, so a line cannot hide in the list and a merge
  // conflict on the ledger resolves by position.
  for (const [index, entry] of parsed.entries()) {
    const previous = parsed[index - 1];
    if (typeof previous === "string" && previous >= entry) {
      throw new TypeError(
        `${LEDGER_DISPLAY_PATH} must be sorted and duplicate-free: "${entry}" follows "${previous}"`,
      );
    }
  }
  const grouped = new Map<string, Set<string>>();
  for (const entry of parsed) {
    const separator = entry.indexOf(PAIR_SEPARATOR);
    if (separator === -1) {
      throw new TypeError(
        `${LEDGER_DISPLAY_PATH}: "${entry}" is not a "<file>::<specifier>" pair`,
      );
    }
    const file = entry.slice(0, separator);
    const specifier = entry.slice(separator + PAIR_SEPARATOR.length);
    const specifiers = grouped.get(file) ?? new Set<string>();
    specifiers.add(specifier);
    grouped.set(file, specifiers);
  }
  ledgerByFile = grouped;
  return grouped;
};

type LedgerFile = { file: string; specifiers: ReadonlySet<string> };

const ledgerFileFor = (filename: string): LedgerFile | null => {
  for (const [file, specifiers] of readLedger()) {
    if (filename === file || filename.endsWith(`/${file}`)) {
      return { file, specifiers };
    }
  }
  return null;
};

type MockBinding =
  | { kind: "direct"; local: string }
  | { kind: "namespace"; local: string };

// Every binding of `bun:test`'s `mock` this import declaration introduces:
// the plain and aliased named imports, and the namespace import. All of them
// are tracked so a rename cannot dodge the rule.
const readMockBindings = (declaration: unknown): MockBinding[] => {
  if (
    !isAstNode(declaration) ||
    declaration.type !== "ImportDeclaration" ||
    !isStringLiteral(declaration.source) ||
    declaration.source.value !== MOCK_SOURCE ||
    !Array.isArray(declaration.specifiers)
  ) {
    return [];
  }
  const bindings: MockBinding[] = [];
  for (const specifier of declaration.specifiers) {
    if (!isAstNode(specifier)) {
      continue;
    }
    if (
      specifier.type === "ImportNamespaceSpecifier" &&
      isIdentifier(specifier.local)
    ) {
      bindings.push({ kind: "namespace", local: specifier.local.name });
      continue;
    }
    if (getImportedName(specifier) !== MOCK_BINDING) {
      continue;
    }
    const local = getImportLocalName(specifier);
    if (local !== null) {
      bindings.push({ kind: "direct", local });
    }
  }
  return bindings;
};

// `mock.module` for a direct binding, `ns.mock.module` for a namespace one.
const isModuleMockCallee = (
  callee: unknown,
  bindings: readonly MockBinding[],
): boolean => {
  if (
    !isAstNode(callee) ||
    callee.type !== "MemberExpression" ||
    callee.computed !== false ||
    getPropertyName(callee.property) !== MODULE_METHOD
  ) {
    return false;
  }
  const receiver = callee.object;
  return bindings.some((binding) =>
    binding.kind === "direct"
      ? isIdentifier(receiver, binding.local)
      : isAstNode(receiver) &&
        receiver.type === "MemberExpression" &&
        receiver.computed === false &&
        getPropertyName(receiver.property) === MOCK_BINDING &&
        isIdentifier(receiver.object, binding.local),
  );
};

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "problem",
        messages: {
          workspaceMock:
            '`mock.module("{{specifier}}")` replaces a workspace module with ' +
            "a fabrication, so the test keeps passing when the real module's " +
            "contract changes. Inject the dependency (handler context or an " +
            "options parameter) and pass a plain fake, or mock the external " +
            "package the module wraps. Only pairs already listed in " +
            `${LEDGER_DISPLAY_PATH} are grandfathered, and that list only shrinks.`,
          unresolvableSpecifier:
            "`mock.module(...)` must name its target with a string literal so " +
            "the rule can tell a workspace module from an external boundary.",
          staleLedgerEntry:
            `${LEDGER_DISPLAY_PATH} lists "{{pair}}" but this file no longer ` +
            "mocks that module. Delete the line in the same change.",
        },
      },
      createOnce(context) {
        let ledgerFile: LedgerFile | null = null;
        let seen = new Set<string>();
        let bindings: MockBinding[] = [];

        return {
          before() {
            ledgerFile = ledgerFileFor(filenameForContext(context));
            seen = new Set();
            bindings = [];
          },
          // Imports are hoisted, so a call written above its import still
          // binds to it; collect every binding before any call is visited.
          Program(node) {
            if (!Array.isArray(node.body)) {
              return;
            }
            for (const statement of node.body) {
              bindings.push(...readMockBindings(statement));
            }
          },
          CallExpression(node) {
            if (!isModuleMockCallee(node.callee, bindings)) {
              return;
            }
            const target = node.arguments.at(0);
            if (!isStringLiteral(target)) {
              context.report({ node, messageId: "unresolvableSpecifier" });
              return;
            }
            const specifier = target.value;
            if (!isWorkspaceSpecifier(specifier)) {
              return;
            }
            seen.add(specifier);
            if (ledgerFile?.specifiers.has(specifier) === true) {
              return;
            }
            context.report({
              node,
              messageId: "workspaceMock",
              data: { specifier },
            });
          },
          "Program:exit"(node) {
            if (ledgerFile === null) {
              return;
            }
            for (const specifier of ledgerFile.specifiers) {
              if (seen.has(specifier)) {
                continue;
              }
              context.report({
                node,
                messageId: "staleLedgerEntry",
                data: {
                  pair: `${ledgerFile.file}${PAIR_SEPARATOR}${specifier}`,
                },
              });
            }
          },
        };
      },
    },
  },
});
