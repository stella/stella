import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import {
  MEMBER_RUN_QUEUES,
  MEMBER_RUN_SCHEDULER_TASKS,
} from "../apps/api/src/lib/member-run-queues.ts";
import type { OwnershipEntry } from "./ownership";
import {
  OWNERSHIP,
  renderOwnershipDocument,
  validateOwnership,
} from "./ownership";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const entry = (overrides: Partial<OwnershipEntry>): OwnershipEntry => ({
  id: "example",
  capability: "An example capability",
  owner: ["scripts/ownership.ts"],
  summary: "One owner so the behavior is decided once.",
  enforcement: { kind: "none" },
  ...overrides,
});

describe("renderOwnershipDocument", () => {
  test("renders the same bytes for the same table", () => {
    expect(renderOwnershipDocument(OWNERSHIP)).toBe(
      renderOwnershipDocument(OWNERSHIP),
    );
  });

  test("renders a global-member row as its full member chain", () => {
    expect(
      renderOwnershipDocument([
        entry({
          enforcement: {
            kind: "global-member",
            object: "navigator",
            path: ["clipboard", "writeText"],
            allowed: [],
          },
        }),
      ]),
    ).toContain("global `navigator.clipboard.writeText`");
  });

  test("renders a member-call row with its scope", () => {
    expect(
      renderOwnershipDocument([
        entry({
          enforcement: {
            kind: "member-call",
            method: "getState",
            within: ["apps/api/src/"],
            allowed: [],
          },
        }),
      ]),
    ).toContain("call `.getState()` in `apps/api/src/`");
  });

  test("renders a function-call row with its scope", () => {
    expect(
      renderOwnershipDocument([
        entry({
          enforcement: {
            kind: "function-call",
            name: "extractId",
            within: [
              "apps/api/src/lib/legal-search/",
              "apps/api/src/handlers/",
            ],
            allowed: [],
          },
        }),
      ]),
    ).toContain(
      "call `extractId()` in `apps/api/src/lib/legal-search/`, `apps/api/src/handlers/`",
    );
  });

  test("renders a table-column row with each owned column and implicit selections", () => {
    expect(
      renderOwnershipDocument([
        entry({
          enforcement: {
            kind: "table-column-read",
            specifiers: ["@/api/db/schema"],
            table: "auditLogs",
            columns: ["changes", "metadata"],
            allowed: [],
          },
        }),
      ]),
    ).toContain(
      "read `auditLogs.changes`, `auditLogs.metadata`, including implicit full-row selections",
    );
  });

  test("renders one row per entry, keyed by id", () => {
    const rendered = renderOwnershipDocument(OWNERSHIP);
    for (const { id } of OWNERSHIP) {
      expect(rendered).toContain(`| \`${id}\` — `);
    }
  });
});

describe("validateOwnership", () => {
  test("accepts the committed table", () => {
    expect(validateOwnership(OWNERSHIP, repoRoot)).toEqual([]);
  });

  test("rejects an owner path that does not exist", () => {
    expect(
      validateOwnership(
        [entry({ owner: ["scripts/not-a-module.ts"] })],
        repoRoot,
      ),
    ).toEqual(["example: owner path does not exist: scripts/not-a-module.ts"]);
  });

  test("rejects an allowed path that does not exist", () => {
    const problems = validateOwnership(
      [
        entry({
          enforcement: {
            kind: "import",
            specifiers: ["@/api/lib/redis-client"],
            allowed: [{ path: "scripts/not-a-caller.ts", reason: "example" }],
          },
        }),
      ],
      repoRoot,
    );
    expect(problems).toEqual([
      "example: allowed path does not exist: scripts/not-a-caller.ts",
    ]);
  });

  test("rejects a duplicate id", () => {
    expect(validateOwnership([entry({}), entry({})], repoRoot)).toEqual([
      "duplicate ownership id: example",
    ]);
  });
});

test("the run actor allowlist names exactly the member-run modules", () => {
  const row = OWNERSHIP.find(({ id }) => id === "member-run-actor");
  const allowed =
    row?.enforcement.kind === "import"
      ? row.enforcement.allowed.map(({ path }) => path)
      : [];
  // One module can host several queues (workflow and workflow-flex).
  const memberRunModules: string[] = [
    ...new Set(
      [...MEMBER_RUN_QUEUES, ...MEMBER_RUN_SCHEDULER_TASKS].map(
        ({ module }) => module,
      ),
    ),
  ];
  expect(allowed).toEqual(memberRunModules);
});

describe("stored-reader ownership coverage", () => {
  for (const id of ["stored-file-read", "stored-tenant-file-read"]) {
    test(`${id} covers every exported stored-reader primitive`, () => {
      const enforcement = OWNERSHIP.find(
        (candidate) => candidate.id === id,
      )?.enforcement;
      if (enforcement?.kind !== "import") {
        throw new TypeError("Stored-reader ownership must confine imports.");
      }
      const names: readonly string[] | undefined =
        "names" in enforcement ? enforcement.names : undefined;
      const specifier = enforcement.specifiers.at(0);
      if (specifier === undefined) {
        throw new TypeError(
          "Stored-reader ownership must name its source module.",
        );
      }
      const filename = `${specifier.replace("@/api/", "apps/api/src/")}.ts`;
      const source = ts.createSourceFile(
        filename,
        readFileSync(
          new URL(filename, new URL("../", import.meta.url)),
          "utf-8",
        ),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      const exportedNames: string[] = [];
      for (const statement of source.statements) {
        if (
          ts.isExportDeclaration(statement) &&
          statement.exportClause !== undefined &&
          ts.isNamedExports(statement.exportClause)
        ) {
          exportedNames.push(
            ...statement.exportClause.elements.map(({ name }) => name.text),
          );
          continue;
        }
        if (
          !ts.canHaveModifiers(statement) ||
          !ts
            .getModifiers(statement)
            ?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)
        ) {
          continue;
        }
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name)) {
              exportedNames.push(declaration.name.text);
            }
          }
          continue;
        }
        if (
          ts.isFunctionDeclaration(statement) &&
          statement.name !== undefined
        ) {
          exportedNames.push(statement.name.text);
        }
      }
      expect(names?.toSorted()).toEqual(
        exportedNames
          .filter((name) =>
            /^(?:readTenantS3ArrayBuffer|getS3ObjectWithSignal|readS3Object\w*|readS3ArrayBuffer)$/u.test(
              name,
            ),
          )
          .toSorted(),
      );
    });
  }
});

// Every export of the chat runtime that starts a `chat()` run, found from the
// source: a new raw run form joins the confined names or this fails.
const chatRunExports = (sourceText: string): string[] => {
  const source = ts.createSourceFile(
    "tanstack-chat-runtime.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const callsChat = (node: ts.Node): boolean =>
    (ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "chat") ||
    (ts.forEachChild(node, (child) => (callsChat(child) ? true : undefined)) ??
      false);
  const names: string[] = [];
  for (const statement of source.statements) {
    if (
      !ts.isVariableStatement(statement) ||
      !ts
        .getModifiers(statement)
        ?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)
    ) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.initializer !== undefined &&
        callsChat(declaration.initializer)
      ) {
        names.push(declaration.name.text);
      }
    }
  }
  return names.toSorted();
};

describe("model-run-failure-projection coverage", () => {
  const enforcement = OWNERSHIP.find(
    (candidate) => candidate.id === "model-run-failure-projection",
  )?.enforcement;

  test("confines every chat runtime export that starts a run", () => {
    if (enforcement?.kind !== "import") {
      throw new TypeError("Raw model runs must be confined by import.");
    }
    const names: readonly string[] | undefined =
      "names" in enforcement ? enforcement.names : undefined;
    expect(names?.toSorted()).toEqual(
      chatRunExports(
        readFileSync(
          new URL(
            "apps/api/src/lib/chat/tanstack-chat-runtime.ts",
            new URL("../", import.meta.url),
          ),
          "utf-8",
        ),
      ),
    );
  });

  test("finds a new run form, so an unconfined one fails the check above", () => {
    expect(
      chatRunExports(
        [
          'import { chat } from "@tanstack/ai";',
          "export const runA = (options) => chat(options);",
          "export const runB = async (options) => await chat({ ...options, stream: true });",
          "export const readerOnly = (chunk) => chunk.type;",
          "const internalRun = (options) => chat(options);",
        ].join("\n"),
      ),
    ).toEqual(["runA", "runB"]);
  });
});
