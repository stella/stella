import { describe, expect, test } from "bun:test";
import path from "node:path";
import ts from "typescript";

const apiRoot = path.resolve(import.meta.dir, "../../..");
const siblingOwner = "@/api/lib/entities/sibling-name:resolveSiblingName";
const uploadOwner =
  "@/api/lib/uploads/entity-create:resolveEntityCreateFileName";
const resolverPattern = /^resolve\w*(?:FileName|EntityName)$/u;

type ResolverSite = {
  name: string;
  calls: string[];
};

const inspectNaming = (source: string) => {
  if (!/resolve\w*(?:FileName|EntityName)/u.test(source)) {
    return { resolvers: [], calls: [] };
  }
  const ast = ts.createSourceFile(
    "source.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const imports = new Map<string, string>();
  for (const statement of ast.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) {
      continue;
    }
    for (const binding of bindings.elements) {
      imports.set(
        binding.name.text,
        `${statement.moduleSpecifier.text}:${binding.propertyName?.text ?? binding.name.text}`,
      );
    }
  }
  const callsIn = (node: ts.Node) => {
    const calls: string[] = [];
    const visit = (candidate: ts.Node) => {
      if (
        ts.isCallExpression(candidate) &&
        ts.isIdentifier(candidate.expression)
      ) {
        calls.push(
          imports.get(candidate.expression.text) ?? candidate.expression.text,
        );
      }
      ts.forEachChild(candidate, visit);
    };
    visit(node);
    return calls;
  };
  const resolvers: ResolverSite[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name &&
      node.body &&
      resolverPattern.test(node.name.text)
    ) {
      resolvers.push({ name: node.name.text, calls: callsIn(node.body) });
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      resolverPattern.test(node.name.text)
    ) {
      resolvers.push({
        name: node.name.text,
        calls: callsIn(node.initializer),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return { resolvers, calls: callsIn(ast) };
};

describe("sibling naming has one collision-resolution owner", () => {
  test("detects a count-based resolver and follows imported aliases", () => {
    const oldResolver = inspectNaming(
      "const resolveFileName = async () => { const count = await tx.count(); return 'contract_' + (count + 1) + '.docx'; };",
    );
    expect(oldResolver.resolvers).toHaveLength(1);
    expect(oldResolver.resolvers.at(0)?.calls).not.toContain(siblingOwner);

    const delegated = inspectNaming(
      'import { resolveSiblingName as choose } from "@/api/lib/entities/sibling-name"; const resolveEntityName = () => choose({ name, siblingNames });',
    );
    expect(delegated.resolvers.at(0)?.calls).toContain(siblingOwner);
    const upload = inspectNaming(
      'import { resolveEntityCreateFileName as choose } from "@/api/lib/uploads/entity-create"; const upload = () => choose({ tx, name });',
    );
    expect(upload.calls).toContain(uploadOwner);
    const unrelated = inspectNaming(
      'import { resolveSiblingName } from "other-owner"; const resolveFileName = () => resolveSiblingName({ name });',
    );
    expect(unrelated.resolvers.at(0)?.calls).not.toContain(siblingOwner);
  });

  test("every sibling resolver delegates and multipart uses the creation resolver", async () => {
    const files = [
      ...new Bun.Glob("src/**/*.ts").scanSync({ cwd: apiRoot }),
    ].filter(
      (file) => !file.endsWith(".test.ts") && !file.endsWith(".spec.ts"),
    );
    const sources = await Promise.all(
      files.map(async (file) => ({
        file,
        naming: inspectNaming(await Bun.file(path.join(apiRoot, file)).text()),
      })),
    );
    const exemptions: string[] = [];
    const violations: string[] = [];
    const resolverNames: string[] = [];
    for (const { file, naming } of sources) {
      for (const resolver of naming.resolvers) {
        const id = `${file}:${resolver.name}`;
        // This helper only selects the requested/template name and extension;
        // collision resolution happens later in the entity-creation owner.
        if (
          id ===
          "src/handlers/templates/fills/create.ts:resolveDocumentFileName"
        ) {
          exemptions.push(id);
          continue;
        }
        resolverNames.push(resolver.name);
        if (!resolver.calls.includes(siblingOwner)) {
          violations.push(id);
        }
      }
    }
    expect(
      sources.find(({ file }) => file === "src/handlers/entities/upload.ts")
        ?.naming.calls,
    ).toContain(uploadOwner);
    expect(exemptions).toEqual([
      "src/handlers/templates/fills/create.ts:resolveDocumentFileName",
    ]);
    expect(resolverNames).toContain("resolveEntityName");
    expect(resolverNames).toContain("resolveEntityCreateFileName");
    expect(violations).toEqual([]);
  });
});
