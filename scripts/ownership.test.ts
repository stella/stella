import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { lintSingleRule } from "../.oxlint-plugins/__tests__/lint-single-rule.ts";
import {
  MEMBER_RUN_QUEUES,
  MEMBER_RUN_SCHEDULER_TASKS,
} from "../apps/api/src/lib/member-run-queues.ts";
import type { OwnershipEntry } from "./ownership";
import {
  OWNERSHIP,
  ROOT_CONNECTION_DOORS,
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

const RENEWAL_OWNER = "apps/api/src/lib/business-registries/desktop/renewal.ts";
const RENEWAL_SPECIFIER = "@/api/lib/business-registries/desktop/renewal";

const renewalDoor = () => {
  const door = ROOT_CONNECTION_DOORS.find(
    ({ id }) => id === "desktop-account-renewal",
  );
  if (!door || door.enforcement.kind !== "import") {
    throw new TypeError(
      "Desktop renewal must be an import-confined root connection door",
    );
  }
  return door;
};

const assertRenewalExports = (text: string) => {
  const source = ts.createSourceFile(
    RENEWAL_OWNER,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const names: string[] = [];
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement) || ts.isExportAssignment(statement)) {
      throw new TypeError(
        "Renewal cannot re-export a root handle or another module",
      );
    }
    if (
      !ts.canHaveModifiers(statement) ||
      !ts
        .getModifiers(statement)
        ?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)
    ) {
      continue;
    }
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      names.push(statement.name.text);
      continue;
    }
    if (!ts.isVariableStatement(statement)) {
      throw new TypeError("Renewal exports only its two bounded operations");
    }
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) {
        throw new TypeError(
          "Renewal exports must have explicit operation names",
        );
      }
      names.push(declaration.name.text);
    }
  }
  if (
    names.toSorted().join(",") !==
    "probeDesktopCredential,renewDesktopCredential"
  ) {
    throw new TypeError(
      "Renewal exports only probeDesktopCredential and renewDesktopCredential",
    );
  }
};

const assertRenewalDatabaseBoundary = (text: string) => {
  const source = ts.createSourceFile(
    RENEWAL_OWNER,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const tables = new Set<string>();
  let updates = 0;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const method = node.expression.name.text;
      const receiver = node.expression.expression;
      if (
        ts.isIdentifier(receiver) &&
        receiver.text === "tx" &&
        method !== "select" &&
        method !== "update"
      ) {
        throw new TypeError(
          "Renewal transactions only select or CAS-update credentials",
        );
      }
      if (method === "from" || method === "update") {
        const table = node.arguments.at(0);
        if (
          !table ||
          !ts.isIdentifier(table) ||
          (table.text !== "apikey" && table.text !== "member")
        ) {
          throw new TypeError(
            "Renewal database access is bounded to credential and membership rows",
          );
        }
        tables.add(table.text);
        if (method === "update") {
          if (table.text !== "apikey") {
            throw new TypeError("Renewal may only update the credential");
          }
          updates += 1;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (updates !== 1 || tables.size !== 2) {
    throw new TypeError(
      "Renewal must retain its membership read and single credential CAS",
    );
  }
};

describe("desktop renewal root connection door", () => {
  test("confines the exact owner and specifier to explicit authorized callers", () => {
    const door = renewalDoor();
    expect(door.owner).toEqual([RENEWAL_OWNER]);
    expect(door.enforcement.specifiers).toEqual([RENEWAL_SPECIFIER]);
    expect("names" in door.enforcement).toBe(false);
    expect(door.enforcement.allowed.map(({ path }) => path)).toEqual([
      "apps/api/src/lib/business-registries/desktop/auth.ts",
      "apps/api/src/handlers/desktop-registry/renew.ts",
      "apps/api/src/lib/business-registries/desktop/renewal.postgres.test.ts",
    ]);
    expect(OWNERSHIP.filter(({ id }) => id === door.id)).toEqual([door]);
  });

  test("the real confinement rule rejects sibling and wildcard escape routes", async () => {
    const door = renewalDoor();
    const source = [
      `import { renewDesktopCredential } from "${RENEWAL_SPECIFIER}";`,
      `import * as renewal from "${RENEWAL_SPECIFIER}";`,
      `export * from "${RENEWAL_SPECIFIER}";`,
      `const renewalModule = await import("${RENEWAL_SPECIFIER}");`,
      'import { probeDesktopCredential } from "./renewal";',
    ].join("\n");
    // The lint harness writes outside the repository. Include the fixture's
    // absolute owner module so relative imports resolve like repository files.
    const ruleOptionsForRoot = (root: string) => ({
      entries: [
        {
          ...door,
          enforcement: {
            ...door.enforcement,
            specifiers: [RENEWAL_SPECIFIER, `${root}/${RENEWAL_OWNER}`],
          },
        },
      ],
    });
    for (const sourcePath of [
      door.owner.at(0),
      ...door.enforcement.allowed.map(({ path }) => path),
    ]) {
      if (!sourcePath) {
        throw new TypeError("Renewal owner must exist");
      }
      expect(
        await lintSingleRule("confine-owner", source, {
          ruleOptionsForRoot,
          sourcePath,
        }),
      ).toEqual([]);
    }
    expect(
      await lintSingleRule("confine-owner", source, {
        ruleOptionsForRoot,
        sourcePath:
          "apps/api/src/lib/business-registries/desktop/unapproved-renewal.ts",
      }),
    ).toEqual([1, 2, 3, 4, 5]);
  }, 60_000);

  test("exposes bounded renewal and probe operations without exposing the root connection", () => {
    const source = readFileSync(
      new URL(RENEWAL_OWNER, new URL("../", import.meta.url)),
      "utf-8",
    );
    assertRenewalExports(source);
    assertRenewalDatabaseBoundary(source);
    for (const mutation of [
      source.replace(".update(apikey)", ".update(member)"),
      `${source}\nconst escaped = tx.execute("select 1");`,
      source.replace(".from(member)", ".from(user)"),
    ]) {
      expect(() => assertRenewalDatabaseBoundary(mutation)).toThrow(TypeError);
    }
    for (const mutation of [
      `${source}\nexport { rootDb };`,
      `${source}\nexport * from "@/api/db/root";`,
      `${source}\nexport const rootHandle = rootDb;`,
      `${source}\nexport const unrestrictedTransaction = () => rootDb;`,
    ]) {
      expect(() => assertRenewalExports(mutation)).toThrow(TypeError);
    }
  });
});

describe("desktop proof replay ownership", () => {
  const proofOwner =
    "apps/api/src/lib/business-registries/desktop/proof-store.ts";
  const proofSpecifier = "@/api/lib/business-registries/desktop/proof-store";
  const proofDoor = () => {
    const door = ROOT_CONNECTION_DOORS.find(
      ({ id }) => id === "desktop-device-proof-replay",
    );
    if (!door || door.enforcement.kind !== "import") {
      throw new TypeError(
        "Desktop replay receipts require an import-confined owner",
      );
    }
    return door;
  };
  test("only the request, rotation and real database test owners can consume proof authority", async () => {
    const door = proofDoor();
    expect(door.owner).toEqual([proofOwner]);
    expect(door.enforcement.specifiers).toEqual([proofSpecifier]);
    expect("names" in door.enforcement).toBe(false);
    expect(OWNERSHIP.filter(({ id }) => id === door.id)).toEqual([door]);
    const source = `import { ConsumedDesktopDeviceProof } from "${proofSpecifier}";\nexport * from "${proofSpecifier}";\nconst store = await import("${proofSpecifier}");`;
    const ruleOptionsForRoot = () => ({ entries: [door] });
    for (const sourcePath of [
      proofOwner,
      ...door.enforcement.allowed.map(({ path }) => path),
    ]) {
      expect(
        await lintSingleRule("confine-owner", source, {
          sourcePath,
          ruleOptionsForRoot,
        }),
      ).toEqual([]);
    }
    expect(
      await lintSingleRule("confine-owner", source, {
        sourcePath:
          "apps/api/src/handlers/desktop-registry/unapproved-proof-owner.ts",
        ruleOptionsForRoot,
      }),
    ).toEqual([1, 2, 3]);
  }, 60_000);
});
