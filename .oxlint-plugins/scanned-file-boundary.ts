// Parsers take a `ScannedFile`, and a `ScannedFile` can only be minted by
// scanning bytes or by reading them back from a `FileKey`. Types enforce the
// rest (the template and style-set parsers, `discoverTemplate` and
// `fillTemplate` among them, take a `ScannedFile` too); this rule closes the
// ways around them:
//
//   bytes as ScannedFile                   // forged proof of a scan
//   key as unknown as FileKey              // staging key passed off as stored
//   <FileKey>key                           // angle-bracket spelling of the same
//   bytes as ParserFile                    // import alias of ScannedFile
//   bytes as scanned.ScannedFile           // namespace import
//   bytes as LocalAlias                    // `type LocalAlias = ScannedFile`
//   v.parse(fileKeySchema, stagingKey)     // the brand's own schema, reused
//   mintScannedFile({ ... })               // the mint, reused
//   storedObject({ key, scanState })       // a row's scan state, trusted
//   Object.create(ScannedFile.prototype)   // instance without the constructor
//   import { parseDocx } from "@stll/folio-core/server"  // parser on raw bytes
//   FolioDocxReviewer.fromBuffer(bytes)    // the same, through the reviewer
//
// folio-core parses raw bytes, so its DOCX entry points are reached through
// `lib/file-scan/document-parsers.ts`, which takes a `ScannedFile`. The other
// owners are the extraction worker (it receives scanned bytes over stdin) and
// `document-translation/docx-review.ts` (its exports take a `ScannedFile`;
// its other parses re-read its own serializer output). Tests are exempt.
//
// Neither brand needs a cast: `FileKey` is a valibot brand and `ScannedFile` a
// class with a private constructor, so casts are banned everywhere. The mint,
// the key schema, the derived-file wrapper, and the stored-row reader may only
// be imported by the modules listed below.
//
// `derivedScannedFile` owners rewrite a `ScannedFile` and hand the result on
// (folio re-serialization, template fill, field configuration, AI adaptation
// and preparation); `storedObject` owners are the modules whose rows record
// a stored file's scan state (templates, style sets).
//
// Casts are matched against local bindings: the canonical names, their import
// aliases, namespace imports of the owning modules, and same-file type aliases
// of any of those (declared before or after the cast). An alias re-exported
// from a third module is not resolved; `typescript/no-unsafe-type-assertion`
// still reports that cast.

import { eslintCompatPlugin, type Node } from "@oxlint/plugins";

import {
  filenameForContext,
  getImportedName,
  getImportLocalName,
  isAstNode,
  isIdentifier,
  isStringLiteral,
} from "./utils.ts";

const BRANDED_TYPES = new Set(["ScannedFile", "FileKey"]);

const BRAND_MODULES = new Set([
  "@/api/lib/file-key",
  "@/api/lib/file-scan/scanned-file",
]);

const FOLIO_SOURCES = new Set(["@stll/folio-core", "@stll/folio-core/server"]);

const FOLIO_BYTE_PARSERS = new Set([
  "applyDocxXmlPatchProposal",
  "applyFolioAIEditsToBuffer",
  "compareDocx",
  "compareDocxVersions",
  "createBilingualDocx",
  "docxToMarkdown",
  "extractDocumentStyleSetFromDocx",
  "extractDocxText",
  "inspectDocxPackage",
  "materializeYjsDocx",
  "parseDocx",
  "readBilingualDocx",
]);

const FOLIO_OWNERS = [
  "apps/api/src/lib/file-scan/document-parsers.ts",
  "apps/api/src/lib/search/extraction-worker.ts",
  "apps/api/src/lib/document-translation/docx-review.ts",
];

const isApiTestFile = (filename: string): boolean =>
  filename.endsWith(".test.ts") || filename.includes("apps/api/src/tests/");

// Minting exports and the modules allowed to import them (path fragments). The
// mint lives apart from the scanner so stored-file readers do not bundle it.
const RESTRICTED_IMPORTS = new Map([
  [
    "@/api/lib/file-key",
    {
      name: "fileKeySchema",
      messageId: "schemaImport",
      owners: [
        "apps/api/src/lib/file-scan/stored-object.ts",
        "apps/api/src/tests/helpers/file-key.ts",
      ],
    },
  ],
  [
    "@/api/lib/file-scan/scanned-file",
    {
      name: "mintScannedFile",
      messageId: "mintImport",
      owners: [
        "apps/api/src/lib/file-scan/scan-upload.ts",
        "apps/api/src/lib/file-scan/stored-file.ts",
        "apps/api/src/lib/file-scan/publisher-document.ts",
        "apps/api/src/lib/file-scan/document-parsers.ts",
        "apps/api/src/tests/helpers/scanned-file.ts",
      ],
    },
  ],
  [
    "@/api/lib/file-scan/document-parsers",
    {
      name: "derivedScannedFile",
      messageId: "derivedImport",
      owners: [
        "apps/api/src/lib/document-translation/docx-review.ts",
        "apps/api/src/lib/docx/adapt-ai-fields.ts",
        "apps/api/src/lib/docx/patch-template.ts",
        "apps/api/src/lib/docx/write-field-filters.ts",
        "apps/api/src/handlers/templates/prepare-template.ts",
      ],
    },
  ],
  [
    "@/api/lib/file-scan/publisher-document",
    {
      name: "publisherDocument",
      messageId: "publisherImport",
      owners: ["apps/api/src/handlers/case-law/ingestion/adapters/"],
    },
  ],
  [
    "@/api/lib/file-scan/stored-object",
    {
      name: "storedObject",
      messageId: "storedObjectImport",
      owners: [
        "apps/api/src/lib/templates/stored-template-file.ts",
        "apps/api/src/lib/style-sets.ts",
      ],
    },
  ],
]);

type PendingCast = { node: Node; typeAnnotation: unknown };

export default eslintCompatPlugin({
  meta: { name: "scanned-file-boundary" },
  rules: {
    "scanned-file-boundary": {
      meta: {
        type: "problem",
        messages: {
          forgedBrand:
            "Do not cast to {{name}}. Obtain a ScannedFile from scanUpload " +
            "or readStoredFile, and a FileKey from createFileKey or " +
            "createUserFileKey, so unscanned bytes cannot reach a parser.",
          mintImport:
            "Do not import mintScannedFile; use scanUpload or readStoredFile.",
          derivedImport:
            "Do not import derivedScannedFile; folio output comes back as a " +
            "ScannedFile from the document-parsers wrappers, and template " +
            "rewrites from the template parsers.",
          storedObjectImport:
            "Do not import storedObject; read stored templates with " +
            "readStoredTemplateFile and style sets with readStyleSetPackage.",
          publisherImport:
            "publisherDocument is for case-law adapters' publisher downloads; " +
            "scan other bytes with scanUpload.",
          folioParserImport:
            "Do not import {{name}} from folio-core; use the ScannedFile " +
            "wrapper in @/api/lib/file-scan/document-parsers.",
          folioReviewerFromBuffer:
            "Do not call FolioDocxReviewer.fromBuffer on raw bytes; use " +
            "openScannedDocxReviewer from @/api/lib/file-scan/document-parsers.",
          schemaImport:
            "Do not import fileKeySchema; build keys with createFileKey or " +
            "createUserFileKey (tests: testFileKey).",
          prototypeAccess:
            "Do not build a ScannedFile from its prototype; use scanUpload " +
            "or readStoredFile.",
        },
      },
      createOnce(context) {
        const brandedLocals = new Map<string, string>();
        const brandNamespaces = new Set<string>();
        const typeAliases = new Map<string, unknown>();
        const pendingCasts: PendingCast[] = [];
        const reviewerLocals = new Set<string>();
        const folioNamespaces = new Set<string>();

        const filenameMatchesAny = (fragments: readonly string[]): boolean => {
          const filename = filenameForContext(context);
          return fragments.some((fragment) => filename.includes(fragment));
        };
        const folioExempt = (): boolean =>
          isApiTestFile(filenameForContext(context)) ||
          filenameMatchesAny(FOLIO_OWNERS);

        // The brand a type annotation names, following same-file aliases.
        const brandOf = (
          typeAnnotation: unknown,
          seen: Set<string>,
        ): string | null => {
          if (
            !isAstNode(typeAnnotation) ||
            typeAnnotation.type !== "TSTypeReference"
          ) {
            return null;
          }
          const { typeName } = typeAnnotation;
          if (
            isAstNode(typeName) &&
            typeName.type === "TSQualifiedName" &&
            isIdentifier(typeName.left) &&
            brandNamespaces.has(typeName.left.name) &&
            isIdentifier(typeName.right) &&
            BRANDED_TYPES.has(typeName.right.name)
          ) {
            return typeName.right.name;
          }
          if (!isIdentifier(typeName)) {
            return null;
          }
          const brand = brandedLocals.get(typeName.name);
          if (brand !== undefined) {
            return brand;
          }
          const aliased = typeAliases.get(typeName.name);
          if (aliased === undefined || seen.has(typeName.name)) {
            return null;
          }
          seen.add(typeName.name);
          return brandOf(aliased, seen);
        };

        return {
          before() {
            brandedLocals.clear();
            for (const name of BRANDED_TYPES) {
              brandedLocals.set(name, name);
            }
            brandNamespaces.clear();
            typeAliases.clear();
            pendingCasts.length = 0;
            reviewerLocals.clear();
            folioNamespaces.clear();
            const filename = filenameForContext(context);
            return (
              filename.includes("apps/api/src/") ||
              filename.endsWith(
                ".oxlint-plugins/__fixtures__/scanned-file-boundary.fixture.ts",
              )
            );
          },
          ImportDeclaration(node) {
            if (
              !isStringLiteral(node.source) ||
              !Array.isArray(node.specifiers)
            ) {
              return;
            }
            const source = node.source.value;
            if (FOLIO_SOURCES.has(source) && node.importKind !== "type") {
              for (const specifier of node.specifiers) {
                if (
                  isAstNode(specifier) &&
                  specifier.type === "ImportNamespaceSpecifier" &&
                  isIdentifier(specifier.local)
                ) {
                  folioNamespaces.add(specifier.local.name);
                  continue;
                }
                const imported = getImportedName(specifier);
                if (
                  imported === null ||
                  (isAstNode(specifier) && specifier.importKind === "type")
                ) {
                  continue;
                }
                if (imported === "FolioDocxReviewer") {
                  const local = getImportLocalName(specifier);
                  if (local !== null) {
                    reviewerLocals.add(local);
                  }
                  continue;
                }
                if (FOLIO_BYTE_PARSERS.has(imported) && !folioExempt()) {
                  context.report({
                    node: specifier,
                    messageId: "folioParserImport",
                    data: { name: imported },
                  });
                }
              }
            }
            if (BRAND_MODULES.has(source)) {
              for (const specifier of node.specifiers) {
                if (
                  isAstNode(specifier) &&
                  specifier.type === "ImportNamespaceSpecifier" &&
                  isIdentifier(specifier.local)
                ) {
                  brandNamespaces.add(specifier.local.name);
                  continue;
                }
                const imported = getImportedName(specifier);
                const local = getImportLocalName(specifier);
                if (
                  imported !== null &&
                  local !== null &&
                  BRANDED_TYPES.has(imported)
                ) {
                  brandedLocals.set(local, imported);
                }
              }
            }
            const restricted = RESTRICTED_IMPORTS.get(source);
            if (
              restricted === undefined ||
              filenameMatchesAny(restricted.owners)
            ) {
              return;
            }
            for (const specifier of node.specifiers) {
              if (getImportedName(specifier) === restricted.name) {
                context.report({
                  node: specifier,
                  messageId: restricted.messageId,
                });
              }
            }
          },
          TSTypeAliasDeclaration(node) {
            if (isIdentifier(node.id)) {
              typeAliases.set(node.id.name, node.typeAnnotation);
            }
          },
          // Aliases may be declared after the cast, so casts are resolved
          // once the whole file has been read.
          TSAsExpression(node) {
            pendingCasts.push({ node, typeAnnotation: node.typeAnnotation });
          },
          TSTypeAssertion(node) {
            pendingCasts.push({ node, typeAnnotation: node.typeAnnotation });
          },
          CallExpression(node) {
            const { callee } = node;
            if (
              !isAstNode(callee) ||
              callee.type !== "MemberExpression" ||
              folioExempt()
            ) {
              return;
            }
            // `folio.parseDocx(bytes)` through a namespace import.
            if (
              isIdentifier(callee.object) &&
              folioNamespaces.has(callee.object.name) &&
              isIdentifier(callee.property) &&
              FOLIO_BYTE_PARSERS.has(callee.property.name)
            ) {
              context.report({
                node,
                messageId: "folioParserImport",
                data: { name: callee.property.name },
              });
              return;
            }
            if (!isIdentifier(callee.property, "fromBuffer")) {
              return;
            }
            // `FolioDocxReviewer.fromBuffer` or `folio.FolioDocxReviewer.fromBuffer`.
            const reviewer = callee.object;
            const isReviewer =
              (isIdentifier(reviewer) && reviewerLocals.has(reviewer.name)) ||
              (isAstNode(reviewer) &&
                reviewer.type === "MemberExpression" &&
                isIdentifier(reviewer.object) &&
                folioNamespaces.has(reviewer.object.name) &&
                isIdentifier(reviewer.property, "FolioDocxReviewer"));
            if (isReviewer) {
              context.report({ node, messageId: "folioReviewerFromBuffer" });
            }
          },
          MemberExpression(node) {
            if (
              isIdentifier(node.property, "prototype") &&
              isIdentifier(node.object) &&
              brandedLocals.get(node.object.name) === "ScannedFile"
            ) {
              context.report({ node, messageId: "prototypeAccess" });
            }
          },
          "Program:exit"() {
            for (const { node, typeAnnotation } of pendingCasts) {
              const name = brandOf(typeAnnotation, new Set());
              if (name !== null) {
                context.report({
                  node,
                  messageId: "forgedBrand",
                  data: { name },
                });
              }
            }
          },
        };
      },
    },
  },
});
