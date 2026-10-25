// Every writer of a file's `encrypted` attribute takes it from the detector.
//
// The writers below take a `FileEncryption`, which only
// `detect-file-encryption.ts` can make, so a caller cannot hand one a guess.
// This test closes the two ways around that:
//
// - a new call site of a writer must be classified here with the expression it
//   passes, so where each site's value comes from is reviewed, not assumed;
// - file content built outside the minted-content writer (an object literal
//   with the stored file shape) fails, so a new writer cannot write the
//   attribute by hand.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  type Node,
  type ParsedSource,
  parseSource,
  walk,
} from "@stll/scripts/src/syntax-tree";

import type { createEntityFromBuffer } from "@/api/lib/entities/create-from-buffer";
import type { createEntityVersionFromBuffer } from "@/api/lib/entity-versions/create-entity-version-from-buffer";
import type { writeFileVersion } from "@/api/lib/entity-versions/write-file-version";
import type { FileEncryption } from "@/api/lib/files/detect-file-encryption";
import type { fileContentWithMintedObject } from "@/api/lib/files/file-object-ids";

const API_ROOT = path.resolve(import.meta.dir, "../../..");
const DETECTOR_MODULE = "@/api/lib/files/detect-file-encryption";

/** The functions that write file content; each takes `encryption`. */
const WRITERS = new Set([
  "fileContentWithMintedObject",
  "writeFileVersion",
  "createEntityFromBuffer",
  "createEntityVersionFromBuffer",
]);

/**
 * Every call site of a writer (`file:writer:ordinal`, the writer named as the
 * site calls it) and the expression it passes as `encryption`. A detector
 * call states its basis; a name is a value detected or threaded through in
 * the same module, which the module-import check below backs.
 */
const EXPECTED_SITES: Record<string, string> = {
  "src/handlers/chat/tools/auto-apply-suggest-changes-tools.ts:createVersion:0":
    "serverBuiltFileEncryption()",
  "src/handlers/chat/tools/create-workspace-document-tools.ts:createEntity:0":
    "serverBuiltFileEncryption()",
  "src/handlers/documents/compare.ts:createEntityVersionFromBuffer:0":
    "serverBuiltFileEncryption()",
  "src/handlers/entities/bilingual/create.ts:createEntityFromBuffer:0":
    "serverBuiltFileEncryption()",
  "src/handlers/entities/copy-utils.ts:fileContentWithMintedObject:0":
    "storedFileEncryption(field.content)",
  "src/handlers/entities/create-blank-document-service.ts:createEntityFromBuffer:0":
    "serverBuiltFileEncryption()",
  "src/handlers/entities/finalize-desktop-edit-session.ts:fileContentWithMintedObject:0":
    "encryption",
  "src/handlers/entities/from-legal-source/create.ts:createEntityFromBuffer:0":
    "serverBuiltFileEncryption()",
  "src/lib/entity-versions/publish-folio-collab-checkpoint.ts:writeFileVersion:0":
    "PUBLISHED_FILE_ENCRYPTION",
  "src/handlers/entities/upload.ts:fileContentWithMintedObject:0": "encryption",
  "src/handlers/entities/versions/upload.ts:createEntityVersionFromBuffer:0":
    "encryption",
  "src/handlers/files/email-attachment/create.ts:createEntityFromBuffer:0":
    "encryption",
  "src/handlers/files/update-document-properties.ts:createEntityVersionFromBuffer:0":
    "serverBuiltFileEncryption()",
  "src/handlers/lists/sample-case/create.ts:createDocument:0":
    "serverBuiltFileEncryption()",
  "src/handlers/reports/report-export-queue.ts:createEntityFromBuffer:0":
    "serverBuiltFileEncryption()",
  "src/handlers/templates/fills/create.ts:createEntityFromBuffer:0":
    "serverBuiltFileEncryption()",
  "src/handlers/uploads/entity-version.ts:writeFileVersion:0": "encryption",
  "src/lib/bilingual/run-queue.ts:createEntityVersionFromBuffer:0":
    "serverBuiltFileEncryption()",
  "src/lib/document-translation/run-queue.ts:createEntityFromBuffer:0":
    "encryption",
  "src/lib/email/inbound/persistence.ts:createDocument:0": "encryption",
  "src/lib/entities/create-from-buffer.ts:fileContentWithMintedObject:0":
    "encryption",
  "src/lib/entity-versions/create-entity-version-from-buffer.ts:writeFileVersion:0":
    "encryption",
  "src/lib/entity-versions/write-file-version.ts:fileContentWithMintedObject:0":
    "encryption",
  "src/lib/files/pdf-signing/finalize.ts:createEntityVersionFromBuffer:0":
    "serverBuiltFileEncryption()",
  "src/lib/flows/flow-executor.ts:createEntity:0":
    "serverBuiltFileEncryption()",
  "src/lib/review-organization/seed.ts:createEntityFromBuffer:0":
    "serverBuiltFileEncryption()",
  "src/lib/uploads/entity-create.ts:fileContentWithMintedObject:0":
    "encryption",
  "src/mcp/template-tools.ts:persistFilledTemplateDocument:0":
    "serverBuiltFileEncryption()",
  "src/mcp/template-tools.ts:persistFilledTemplateVersion:0":
    "serverBuiltFileEncryption()",
};

/**
 * Writers that take `encryption` from their own caller and pass it on. Every
 * other module whose site passes a name must import the detector itself.
 */
const PASS_THROUGH_WRITERS = new Set([
  "src/lib/entities/create-from-buffer.ts",
  "src/lib/entity-versions/create-entity-version-from-buffer.ts",
  "src/lib/entity-versions/write-file-version.ts",
]);

const sourceFiles = (): string[] =>
  [...new Bun.Glob("src/**/*.ts").scanSync({ cwd: API_ROOT })]
    .filter(
      (file) =>
        !file.endsWith(".test.ts") &&
        !file.endsWith(".d.ts") &&
        !file.startsWith("src/tests/") &&
        !file.includes("/__tests__/") &&
        !file.includes("/generated/"),
    )
    .toSorted();

const parse = (file: string) =>
  parseSource(file, readFileSync(path.join(API_ROOT, file), "utf-8"));

const typeQueryName = (type: Node | null | undefined): string | null =>
  type?.type === "TSTypeAnnotation" &&
  type.typeAnnotation.type === "TSTypeQuery" &&
  type.typeAnnotation.exprName.type === "Identifier"
    ? type.typeAnnotation.exprName.name
    : null;

/** Names under which a module holds a writer: injected, defaulted, re-exported. */
const writerAliases = (source: ParsedSource): Map<string, boolean> => {
  const aliases = new Map<string, boolean>();
  walk(source.program, (node, ancestors) => {
    let alias: string | null = null;
    let target: string | null = null;
    const parent = ancestors.at(-1);
    if (
      node.type === "Identifier" &&
      parent !== undefined &&
      (parent.type === "FunctionDeclaration" ||
        parent.type === "FunctionExpression" ||
        parent.type === "ArrowFunctionExpression") &&
      parent.params.includes(node)
    ) {
      alias = node.name;
      target = typeQueryName(node.typeAnnotation);
    }
    if (
      node.type === "TSPropertySignature" ||
      node.type === "PropertyDefinition"
    ) {
      alias = node.key.type === "Identifier" ? node.key.name : null;
      target = typeQueryName(node.typeAnnotation);
    }
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier") {
      alias = node.id.name;
      target = typeQueryName(node.id.typeAnnotation);
      if (target === null && node.init?.type === "Identifier") {
        target = node.init.name;
      }
    }
    if (
      node.type === "AssignmentPattern" &&
      node.left.type === "Identifier" &&
      node.right.type === "Identifier"
    ) {
      alias = node.left.name;
      target = node.right.name;
    }
    if (alias !== null && target !== null && WRITERS.has(target)) {
      const exported =
        node.type === "VariableDeclarator" &&
        parent?.type === "VariableDeclaration" &&
        ancestors.at(-2)?.type === "ExportNamedDeclaration";
      aliases.set(alias, exported);
    }
  });
  return aliases;
};

/** The writer names a callee can stand for (`a ?? b`, `(x)`, `deps.w`). */
const calleeNames = (callee: Node): string[] => {
  if (
    callee.type === "ParenthesizedExpression" ||
    callee.type === "ChainExpression"
  ) {
    return calleeNames(callee.expression);
  }
  if (callee.type === "LogicalExpression" && callee.operator === "??") {
    return [...calleeNames(callee.left), ...calleeNames(callee.right)];
  }
  if (callee.type === "Identifier") {
    return [callee.name];
  }
  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier"
  ) {
    return [callee.property.name];
  }
  return [];
};

type WriterSite = { key: string; encryption: string | null };

const collect = () => {
  const files = sourceFiles();
  const parsed = new Map(files.map((file) => [file, parse(file)]));
  const exportedAliases = new Set<string>();
  const localAliases = new Map<string, Set<string>>();
  for (const [file, source] of parsed) {
    const aliases = writerAliases(source);
    localAliases.set(file, new Set(aliases.keys()));
    for (const [alias, exported] of aliases) {
      if (exported) {
        exportedAliases.add(alias);
      }
    }
  }

  const sites: WriterSite[] = [];
  const handBuiltContent: string[] = [];
  const importsDetector = new Set<string>();
  for (const [file, source] of parsed) {
    const names = new Set([
      ...WRITERS,
      ...exportedAliases,
      ...(localAliases.get(file) ?? []),
    ]);
    const ordinals = new Map<string, number>();
    walk(source.program, (node, ancestors) => {
      if (
        node.type === "ImportDeclaration" &&
        node.source.value === DETECTOR_MODULE
      ) {
        importsDetector.add(file);
      }
      if (node.type === "CallExpression") {
        const writer = calleeNames(node.callee).find((name) => names.has(name));
        const input = node.arguments.at(0);
        if (writer === undefined || input === undefined) {
          return;
        }
        const ordinal = ordinals.get(writer) ?? 0;
        ordinals.set(writer, ordinal + 1);
        const property =
          input.type === "ObjectExpression"
            ? input.properties.find(
                (element) =>
                  element.type === "Property" &&
                  !element.computed &&
                  element.key.type === "Identifier" &&
                  element.key.name === "encryption",
              )
            : undefined;
        let encryption: string | null = null;
        if (
          property?.type === "Property" &&
          property.kind === "init" &&
          !property.method
        ) {
          encryption =
            property.shorthand && property.key.type === "Identifier"
              ? property.key.name
              : source.sourceText.slice(
                  property.value.start,
                  property.value.end,
                );
        }
        sites.push({ key: `${file}:${writer}:${ordinal}`, encryption });
      }
      // The stored file shape written by hand: it must be the minted-content
      // writer's own input.
      if (node.type === "ObjectExpression") {
        const keys = new Set(
          node.properties.flatMap((element) =>
            element.type === "Property" &&
            !element.computed &&
            element.key.type === "Identifier"
              ? [element.key.name]
              : [],
          ),
        );
        const isFileType = node.properties.some(
          (element) =>
            element.type === "Property" &&
            element.kind === "init" &&
            !element.method &&
            !element.shorthand &&
            !element.computed &&
            element.key.type === "Identifier" &&
            element.key.name === "type" &&
            element.value.type === "Literal" &&
            element.value.value === "file",
        );
        const parent = ancestors.at(-1);
        const isMintedInput =
          parent?.type === "CallExpression" &&
          calleeNames(parent.callee).includes("fileContentWithMintedObject");
        if (
          isFileType &&
          keys.has("sha256Hex") &&
          keys.has("fileName") &&
          !isMintedInput
        ) {
          handBuiltContent.push(`${file}:${source.locate(node.start).line}`);
        }
      }
    });
  }
  return { handBuiltContent, importsDetector, sites };
};

const { handBuiltContent, importsDetector, sites } = collect();

describe("file encryption writers", () => {
  test("every writer call site is classified with the value it passes", () => {
    expect(
      Object.fromEntries(sites.map(({ encryption, key }) => [key, encryption])),
    ).toEqual(EXPECTED_SITES);
  });

  test("a site passing a name detects it in its own module or threads its caller's", () => {
    const unbacked = sites.flatMap(({ encryption, key }) => {
      const file = key.slice(0, key.indexOf(":"));
      const fromDetectorCall = encryption?.endsWith(")") === true;
      return fromDetectorCall ||
        importsDetector.has(file) ||
        PASS_THROUGH_WRITERS.has(file)
        ? []
        : [key];
    });
    expect(unbacked).toEqual([]);
  });

  test("no module builds stored file content outside the minted-content writer", () => {
    expect(handBuiltContent).toEqual([]);
  });

  test("the enumeration still sees the writers it guards", () => {
    // A parser or path change that found nothing would pass the checks above.
    expect(sites.length).toBeGreaterThanOrEqual(
      Object.keys(EXPECTED_SITES).length,
    );
    expect(sites.map(({ key }) => key.split(":")[1])).toContain(
      "writeFileVersion",
    );
  });
});

// Each writer's input requires a detector-made value; `encryption?:` or a
// boolean would make one of these `false` and fail typecheck.
type InputOf<Writer> = Writer extends (input: infer Input) => unknown
  ? Input
  : never;
type RequiresEncryption<Input> = Input extends { encryption: FileEncryption }
  ? Record<string, never> extends Pick<Input, "encryption">
    ? false
    : true
  : false;
const writerInputsRequireEncryption: {
  createEntityFromBuffer: RequiresEncryption<
    InputOf<typeof createEntityFromBuffer>
  >;
  createEntityVersionFromBuffer: RequiresEncryption<
    InputOf<typeof createEntityVersionFromBuffer>
  >;
  fileContentWithMintedObject: RequiresEncryption<
    InputOf<typeof fileContentWithMintedObject>
  >;
  writeFileVersion: RequiresEncryption<InputOf<typeof writeFileVersion>>;
} = {
  createEntityFromBuffer: true,
  createEntityVersionFromBuffer: true,
  fileContentWithMintedObject: true,
  writeFileVersion: true,
};

test("the writer table names every typed writer", () => {
  expect(Object.keys(writerInputsRequireEncryption).toSorted()).toEqual(
    [...WRITERS].toSorted(),
  );
});
