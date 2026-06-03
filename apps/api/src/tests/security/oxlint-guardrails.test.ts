import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const readRootFixture = (relativePath: string) =>
  readFileSync(join(import.meta.dir, "../../../../..", relativePath), "utf-8");

describe("custom oxlint guardrails", () => {
  test("process.env rule treats only static computed keys as known names", () => {
    const pluginSource = readRootFixture(
      ".oxlint-plugins/forbid-process-env-outside-env-ts.ts",
    );

    expect(pluginSource).toContain("const staticMemberPropertyName");
    expect(pluginSource).toContain("isStringLiteral(node.property)");
    expect(pluginSource).toContain('return "process.env[...]"');
  });

  test("JSX literal rule remains scoped to files using translation markers", () => {
    const pluginSource = readRootFixture(
      ".oxlint-plugins/no-untranslated-jsx-literal.ts",
    );

    expect(pluginSource).toContain("options.requireTranslationUsage === true");
    expect(pluginSource).toContain("sourceText.includes(marker)");
    expect(pluginSource).toContain("useTranslations");
    expect(pluginSource).toContain("TranslationKey");
  });

  test("require-contained-handler excludes onBlur and resolves non-identifier refs", () => {
    const pluginSource = readRootFixture(
      ".oxlint-plugins/require-contained-handler.ts",
    );

    // `onBlur` would silently mis-fire because blur's target is the
    // element losing focus, not the new destination — must stay out
    // of the watched set.
    expect(pluginSource).not.toContain('"onBlur"');
    expect(pluginSource).toContain('"onMouseDown"');
    expect(pluginSource).toContain('"onFocus"');

    // Non-identifier ref expressions (MemberExpression, callback refs)
    // must still enforce the rule rather than silently skipping the
    // element — see the `findRefDisplayName` fallback branches.
    expect(pluginSource).toContain("memberExpressionPath");
    expect(pluginSource).toContain('return "ref"');

    // Void / leaf form elements cannot have a React subtree, so the
    // portal scenario cannot apply. They are excluded by name so a
    // `<input ref={…} onMouseDown={…} />` autofocus pattern is left
    // alone instead of acquiring a redundant wrap.
    expect(pluginSource).toContain("LEAF_ELEMENTS");
    expect(pluginSource).toContain('"input"');
    expect(pluginSource).toContain('"textarea"');
  });

  test("containedHandler helper uses Node, not Element, for containment", () => {
    const helperSource = readRootFixture(
      "packages/ui/src/hooks/use-contained-handler.ts",
    );

    // `Node.contains` accepts any Node; narrowing the target to
    // `Element` previously let Text-node click targets bypass the
    // containment filter.
    expect(helperSource).toContain("instanceof Node");
    expect(helperSource).not.toContain("instanceof Element");
  });

  test("prompt boundary cast rule protects chat prompt brands", () => {
    const pluginSource = readRootFixture(
      ".oxlint-plugins/no-prompt-boundary-casts.ts",
    );

    expect(pluginSource).toContain("ChatCacheStablePrefix");
    expect(pluginSource).toContain("ChatSafePrompt");
    expect(pluginSource).toContain("ChatUntrustedPromptSuffix");
    expect(pluginSource).toContain("apps/api/src/handlers/chat/chat-prompt.ts");
    expect(pluginSource).toContain("TSUnionType");
    expect(pluginSource).toContain("TSIntersectionType");
    expect(pluginSource).toContain("TSArrayType");
    expect(pluginSource).toContain("TSTupleType");
    expect(pluginSource).toContain("TSNamedTupleMember");
    expect(pluginSource).toContain("elementType");
    expect(pluginSource).toContain("TSIndexedAccessType");
    expect(pluginSource).toContain("TSLiteralType");
    expect(pluginSource).toContain("TSNumberKeyword");
    expect(pluginSource).toContain("Number.isInteger");
    expect(pluginSource).toContain("ReadonlyArray");
    expect(pluginSource).toContain("getPropertyName");
    expect(pluginSource).toContain("objectType");
    expect(pluginSource).toContain("indexType");
    expect(pluginSource).toContain("TSConditionalType");
    expect(pluginSource).toContain("conditionalExtendsResult");
    expect(pluginSource).toContain("trueType");
    expect(pluginSource).toContain("falseType");
    expect(pluginSource).toContain("TSMappedType");
    expect(pluginSource).toContain("TSTypeLiteral");
    expect(pluginSource).toContain("TSInterfaceDeclaration");
    expect(pluginSource).toContain("TSInterfaceBody");
    expect(pluginSource).toContain("TSFunctionType");
    expect(pluginSource).toContain("TSConstructorType");
    expect(pluginSource).toContain("TSMethodSignature");
    expect(pluginSource).toContain("TSCallSignatureDeclaration");
    expect(pluginSource).toContain("TSConstructSignatureDeclaration");
    expect(pluginSource).toContain("TSIndexSignature");
    expect(pluginSource).toContain("returnType");
    expect(pluginSource).toContain("params");
    expect(pluginSource).toContain("TSParenthesizedType");
    expect(pluginSource).toContain("TSTypeOperator");
    expect(pluginSource).toContain("ImportDeclaration");
    expect(pluginSource).toContain("TSTypeAliasDeclaration");
    expect(pluginSource).toContain("namedTypeAnnotations");
    expect(pluginSource).toContain("typeArgumentsByName");
    expect(pluginSource).toContain("typeParameters");
    expect(pluginSource).toContain("Program:exit");
    expect(pluginSource).toContain("TSImportType");
    expect(pluginSource).toContain("typeArguments");
    expect(pluginSource).toContain("TSTypeAssertion");
  });

  test("public law web modules cannot import protected route code", () => {
    const configSource = readRootFixture("oxlint.config.ts");

    expect(configSource).toContain("apps/web/src/routes/law/**/*.{ts,tsx}");
    expect(configSource).toContain(
      "apps/web/src/features/case-law/**/*.{ts,tsx}",
    );
    expect(configSource).toContain("@/routes/_protected.*/**");
    expect(configSource).toContain(
      "Public law routes and shared case-law modules must not import protected route code.",
    );
  });

  test("public API route files cannot import authenticated route capabilities", () => {
    const configSource = readRootFixture("oxlint.config.ts");

    expect(configSource).toContain("apps/api/src/handlers/**/public-routes.ts");
    expect(configSource).toContain(
      'importNames: ["createSafeHandler", "createSafeRootHandler"]',
    );
    expect(configSource).toContain('name: "@/api/lib/auth"');
    expect(configSource).toContain('name: "@/api/db/root"');
    expect(configSource).toContain(
      "Public route files must use createSafePublicHandler",
    );
  });

  test("public case-law data files cannot query private tables", () => {
    const configSource = readRootFixture("oxlint.config.ts");
    const pluginSource = readRootFixture(
      ".oxlint-plugins/public-case-law-db-boundary.ts",
    );

    expect(configSource).toContain(
      "public-case-law-db-boundary/public-case-law-db-boundary",
    );
    expect(configSource).toContain(
      "apps/api/src/handlers/case-law/decisions/read-by-id.ts",
    );
    expect(configSource).toContain(
      "apps/api/src/lib/case-law-public-read-db.ts",
    );
    expect(pluginSource).toContain("privateCaseLawImport");
    expect(pluginSource).toContain("privateTxQuery");
    expect(pluginSource).toContain("privateSqlText");
    expect(pluginSource).toContain("isCaseLawName");
    expect(pluginSource).toContain("tx.query");
    expect(pluginSource).toContain("workspace|workspaces");
    expect(pluginSource).toContain("organization|organizations");
    expect(pluginSource).toContain("matter|matters");
  });

  test("public law route SEO must use the central helper", () => {
    const configSource = readRootFixture("oxlint.config.ts");
    const pluginSource = readRootFixture(
      ".oxlint-plugins/no-raw-public-law-seo.ts",
    );

    expect(configSource).toContain("apps/web/src/routes/law/**/*.{ts,tsx}");
    expect(configSource).toContain(
      "no-raw-public-law-seo/no-raw-public-law-seo",
    );
    expect(pluginSource).toContain("createPublicLawHead");
    expect(pluginSource).toContain('value === "canonical"');
    expect(pluginSource).toContain('value === "robots"');
    expect(pluginSource).toContain('value.startsWith("og:")');
    expect(pluginSource).toContain('value.startsWith("twitter:")');
  });

  test("public law route files cannot import the Eden API client directly", () => {
    const configSource = readRootFixture("oxlint.config.ts");

    expect(configSource).toContain("apps/web/src/routes/law/**/*.{ts,tsx}");
    expect(configSource).toContain('name: "@/lib/api"');
    expect(configSource).toContain('importNames: ["api"]');
    expect(configSource).toContain(
      "Public law route files must use approved public case-law query modules",
    );
  });

  test("public law modules cannot reference browser globals directly", () => {
    const configSource = readRootFixture("oxlint.config.ts");
    const pluginSource = readRootFixture(
      ".oxlint-plugins/no-public-law-browser-globals.ts",
    );

    expect(configSource).toContain("apps/web/src/routes/law/**/*.{ts,tsx}");
    expect(configSource).toContain(
      "apps/web/src/features/case-law/**/*.{ts,tsx}",
    );
    expect(configSource).toContain(
      "no-public-law-browser-globals/no-public-law-browser-globals",
    );
    expect(pluginSource).toContain("Public law modules must be SSR-safe");
    expect(pluginSource).toContain('"window"');
    expect(pluginSource).toContain('"document"');
    expect(pluginSource).toContain('"localStorage"');
    expect(pluginSource).toContain('"sessionStorage"');
    expect(pluginSource).toContain('"matchMedia"');
  });

  test("public SEO endpoints cannot import auth or protected code", () => {
    const configSource = readRootFixture("oxlint.config.ts");

    expect(configSource).toContain("apps/web/src/routes/robots[.]txt.ts");
    expect(configSource).toContain("apps/web/src/routes/sitemap[.]xml.ts");
    expect(configSource).toContain(
      "apps/web/src/routes/sitemaps/**/*.{ts,tsx}",
    );
    expect(configSource).toContain("apps/web/src/lib/public-law-sitemap.ts");
    expect(configSource).toContain('name: "@/routes/-auth-context"');
    expect(configSource).toContain('name: "@/lib/auth"');
    expect(configSource).toContain(
      "Public SEO endpoints must not import protected route code.",
    );
    expect(configSource).toContain(
      "Public SEO endpoints must use the public case-law API response",
    );
  });
});
