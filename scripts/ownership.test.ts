import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

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

describe("stored-reader ownership coverage", () => {
  for (const id of ["stored-file-read", "stored-tenant-file-read"]) {
    test(`${id} covers every exported stored-reader primitive`, () => {
      const row = OWNERSHIP.find((candidate) => candidate.id === id);
      if (row === undefined || row.enforcement.kind !== "import") {
        throw new TypeError("Stored-reader ownership must confine imports.");
      }
      const specifier = row.enforcement.specifiers.at(0);
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
      expect(row.enforcement.names?.toSorted()).toEqual(
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
