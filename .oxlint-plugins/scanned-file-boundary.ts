// Parsers take a `ScannedFile`, and a `ScannedFile` can only be minted by
// scanning bytes or by reading them back from a `FileKey`. Types enforce the
// rest; this rule closes the two ways around them:
//
//   bytes as ScannedFile                   // forged proof of a scan
//   key as unknown as FileKey              // staging key passed off as stored
//   <FileKey>key                           // angle-bracket spelling of the same
//   v.parse(fileKeySchema, stagingKey)     // the brand's own schema, reused
//   Object.create(ScannedFile.prototype)   // instance without the constructor
//
// The type owners mint their brands (`lib/file-key.ts`,
// `lib/file-scan/scanned-file.ts`), and `tests/helpers/file-key.ts` is the one
// place fixtures may name a literal key. Everything else must obtain the proof
// from those modules, so a raw upload cannot reach a parser unscanned.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  filenameForContext,
  getImportedName,
  isAstNode,
  isIdentifier,
  isStringLiteral,
} from "./utils.ts";

const BRANDED_TYPES = new Set(["ScannedFile", "FileKey"]);

const OWNER_FILES = [
  "apps/api/src/lib/file-key.ts",
  "apps/api/src/lib/file-scan/scanned-file.ts",
  "apps/api/src/tests/helpers/file-key.ts",
];

const brandedTypeName = (typeAnnotation: unknown): string | null => {
  if (
    !isAstNode(typeAnnotation) ||
    typeAnnotation.type !== "TSTypeReference" ||
    !isIdentifier(typeAnnotation.typeName)
  ) {
    return null;
  }
  const { name } = typeAnnotation.typeName;
  return BRANDED_TYPES.has(name) ? name : null;
};

export default eslintCompatPlugin({
  meta: { name: "scanned-file-boundary" },
  rules: {
    "scanned-file-boundary": {
      meta: {
        type: "problem",
        messages: {
          forgedBrand:
            "Do not cast to {{name}}. Obtain a ScannedFile from scanUpload " +
            "or storedFile, and a FileKey from createFileKey or " +
            "createUserFileKey, so unscanned bytes cannot reach a parser.",
          schemaImport:
            "Do not import fileKeySchema; build keys with createFileKey or " +
            "createUserFileKey (tests: testFileKey).",
          prototypeAccess:
            "Do not build a ScannedFile from its prototype; use scanUpload " +
            "or storedFile.",
        },
      },
      createOnce(context) {
        return {
          before() {
            const filename = filenameForContext(context);
            return (
              (filename.includes("apps/api/src/") ||
                filename.endsWith(
                  ".oxlint-plugins/__fixtures__/scanned-file-boundary.fixture.ts",
                )) &&
              !OWNER_FILES.some((owner) => filename.endsWith(owner))
            );
          },
          ImportDeclaration(node) {
            if (
              !isStringLiteral(node.source) ||
              node.source.value !== "@/api/lib/file-key" ||
              !Array.isArray(node.specifiers)
            ) {
              return;
            }
            for (const specifier of node.specifiers) {
              if (getImportedName(specifier) === "fileKeySchema") {
                context.report({ node: specifier, messageId: "schemaImport" });
              }
            }
          },
          TSAsExpression(node) {
            const name = brandedTypeName(node.typeAnnotation);
            if (name !== null) {
              context.report({
                node,
                messageId: "forgedBrand",
                data: { name },
              });
            }
          },
          TSTypeAssertion(node) {
            const name = brandedTypeName(node.typeAnnotation);
            if (name !== null) {
              context.report({
                node,
                messageId: "forgedBrand",
                data: { name },
              });
            }
          },
          MemberExpression(node) {
            if (
              isIdentifier(node.object, "ScannedFile") &&
              isIdentifier(node.property, "prototype")
            ) {
              context.report({ node, messageId: "prototypeAccess" });
            }
          },
        };
      },
    },
  },
});
