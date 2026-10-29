import { expect, test } from "bun:test";
import path from "node:path";

import { type Node, parseSource, walk } from "@stll/scripts/src/syntax-tree";

import createVerification from "@/api/handlers/lists/verifications/create";
import { CAPABILITY_DISPATCH } from "@/api/mcp/generated/capability-dispatch/lists.verifications.create";

const apiRoot = path.resolve(import.meta.dir, "../../../..");
const owner = "src/lib/lists/verification/start-run.ts";
const tableName = "legalListVerificationRuns";

const collectRunInserts = (source: string, file = "fixture.ts") => {
  const { program, sourceText } = parseSource(file, source);
  const aliases = new Set([tableName]);
  const namespaces = new Set<string>();
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration") {
      continue;
    }
    for (const binding of statement.specifiers) {
      if (
        binding.type === "ImportSpecifier" &&
        (binding.imported.type === "Identifier"
          ? binding.imported.name
          : binding.imported.value) === tableName
      ) {
        aliases.add(binding.local.name);
      }
      if (binding.type === "ImportNamespaceSpecifier") {
        namespaces.add(binding.local.name);
      }
    }
  }
  const isRunTable = (node: Node | null | undefined): boolean => {
    if (node?.type === "Identifier") {
      return aliases.has(node.name);
    }
    if (
      node?.type !== "MemberExpression" ||
      node.object.type !== "Identifier" ||
      !namespaces.has(node.object.name)
    ) {
      return false;
    }
    return node.computed
      ? node.property.type === "Literal" && node.property.value === tableName
      : node.property.type === "Identifier" && node.property.name === tableName;
  };
  const sites: string[] = [];
  walk(program, (node) => {
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      isRunTable(node.init)
    ) {
      aliases.add(node.id.name);
    }
    if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      !node.callee.computed &&
      node.callee.property.type === "Identifier" &&
      node.callee.property.name === "insert" &&
      isRunTable(node.arguments.at(0))
    ) {
      sites.push(sourceText.slice(node.start, node.end));
    }
    // A template literal is read up to its first substitution.
    let text: string | undefined;
    if (node.type === "Literal" && typeof node.value === "string") {
      text = node.value;
    } else if (node.type === "TemplateLiteral") {
      text = node.quasis.at(0)?.value.cooked ?? undefined;
    }
    if (
      text !== undefined &&
      /\bINSERT\s+INTO\s+(?:"?\w+"?\.)?"?legal_list_verification_runs\b/iu.test(
        text,
      )
    ) {
      sites.push(text);
    }
  });
  return sites;
};

test("every production verification insert is confined to the admission owner", async () => {
  const sites: string[] = [];
  for (const file of new Bun.Glob("src/**/*.ts").scanSync({ cwd: apiRoot })) {
    if (file.includes("/tests/") || /\.(?:test|type-test)\.ts$/u.test(file)) {
      continue;
    }
    const inserts = collectRunInserts(
      await Bun.file(path.join(apiRoot, file)).text(),
      file,
    );
    for (const _insert of inserts) {
      sites.push(file);
    }
  }
  expect(sites).toEqual([owner]);
});

test("the census detects named aliases, namespace aliases, local aliases and raw SQL", () => {
  for (const source of [
    'import { legalListVerificationRuns as runs } from "@/api/db/schema"; tx.insert(runs);',
    'import * as tables from "@/api/db/schema"; tx.insert(tables.legalListVerificationRuns);',
    'import * as tables from "@/api/db/schema"; tx.insert(tables["legalListVerificationRuns"]);',
    'import { legalListVerificationRuns } from "@/api/db/schema"; const rows = legalListVerificationRuns; tx.insert(rows);',
    "tx.execute(sql`INSERT INTO public.legal_list_verification_runs (id) VALUES (1)`);",
  ]) {
    expect(collectRunInserts(source)).toHaveLength(1);
  }
  expect(collectRunInserts("tx.insert(legalListClaims);")).toHaveLength(0);
});

test("REST and generated MCP, CLI and chat capability dispatch share the create handler", async () => {
  const capability =
    await CAPABILITY_DISPATCH["lists.verifications.create"].load();
  expect(capability.default).toBe(createVerification);
});
