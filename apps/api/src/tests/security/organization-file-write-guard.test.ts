import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  type ArrowFunctionExpression,
  type CallExpression,
  type Function as SyntaxFunction,
  type NewExpression,
  type Node,
  parseSource,
  type Program,
  walk,
} from "@stll/scripts/src/syntax-tree";

const root = path.resolve(import.meta.dir, "../../../../..");
const writeHelpers = new Set([
  "writeTenantS3Object",
  "writeS3ObjectWithRetry",
  "writeScannedObject",
  "putS3ObjectWithSignal",
  "putS3Object",
  "copyObject",
  "putPresignedUpload",
  "createS3ObjectIfAbsent",
  "createMultipartUpload",
  "uploadPart",
  "completeMultipartUpload",
]);
const writeCommands = new Set([
  "PutObjectCommand",
  "CopyObjectCommand",
  "CreateMultipartUploadCommand",
  "UploadPartCommand",
  "CompleteMultipartUploadCommand",
  "Upload",
]);
const ledgerCalls = new Set([
  "writeOrganizationFile",
  "copyOrganizationFile",
  "copyOrganizationFiles",
  "writeOrganizationFiles",
  "storeOcrSearchablePdfDerivative",
]);

type WriteSite = {
  file: string;
  name: string;
  ordinal: number;
  operation: string;
  ledgerBound: boolean;
  flagOff: boolean;
};

// These writes never create metered organization file objects. A changed call
// shape or an additional call must be reviewed here before it reaches CI.
const exemptions = {
  "src/handlers/reports/report-export-queue.ts:writeS3ObjectWithRetry:0":
    "export",
  "src/handlers/chat/export/create.ts:writeS3ObjectWithRetry:0": "export",
  "src/lib/legal-search/raw-source-storage.ts:createS3ObjectIfAbsent:0":
    "public_corpus",
  "src/lib/legal-search/raw-source-storage.ts:createS3ObjectIfAbsent:1":
    "public_corpus",
  "src/lib/legal-search/raw-source-storage.ts:createS3ObjectIfAbsent:2":
    "public_corpus",
  "src/lib/legal-search/raw-source-storage.ts:writeS3ObjectWithRetry:0":
    "public_corpus",
  "src/lib/legal-search/raw-source-storage.ts:copyObject:0": "public_corpus",
  "src/mcp/file-comparison-links-tool.ts:putPresignedUpload:0": "temporary",
  "src/mcp/document-file-upload.ts:putPresignedUpload:0": "temporary",
  "scripts/seed-email-viewer-demo.ts:writeS3ObjectWithRetry:0": "fixture",
  "scripts/seed-templates.ts:writeScannedObject:0": "fixture",
  "scripts/seed-templates.ts:writeScannedObject:1": "fixture",
  "scripts/seed-dev.ts:writeS3ObjectWithRetry:0": "fixture",
  "scripts/seed-dev.ts:writeS3ObjectWithRetry:1": "fixture",
  // The marketing agent thread's generated view: a fixed fixture page under
  // the seed user's chat-file key, rewritten on every seed.
  "scripts/seed-dev.ts:writeS3ObjectWithRetry:2": "fixture",
  "src/lib/uploads/promote-tmp-object.ts:copyObject:0": "reservation_flow",
  "src/lib/uploads/promote-tmp-object.ts:writeS3ObjectWithRetry:0":
    "reservation_flow",
} as const satisfies Record<
  string,
  "export" | "public_corpus" | "temporary" | "fixture" | "reservation_flow"
>;

// Exact per-file counts close the gap where a new direct write lands in a
// function that already calls the ledger. Updating a count requires review of
// that file's new write site and key classification.
const expectedWriteCounts = {
  "scripts/backfill-image-thumbnails.ts": 1,
  "scripts/seed-dev.ts": 3,
  "scripts/seed-email-viewer-demo.ts": 1,
  "scripts/seed-templates.ts": 2,
  "src/handlers/chat/export/create.ts": 1,
  "src/handlers/chat/fork/create.ts": 1,
  "src/handlers/chat/upload-files.ts": 2,
  "src/handlers/entities/checkpoint-desktop-edit-session.ts": 2,
  "src/handlers/entities/checkpoint-folio-collab-room.ts": 2,
  "src/handlers/entities/copy-utils.ts": 1,
  "src/handlers/entities/finalize-desktop-edit-session.ts": 2,
  "src/handlers/entities/publish-folio-collab-version.ts": 2,
  "src/handlers/entities/upload.ts": 2,
  "src/handlers/reports/report-export-queue.ts": 1,
  "src/handlers/style-sets/storage.ts": 2,
  "src/handlers/workspaces/duplicate.ts": 1,
  "src/lib/document-processing-queue.ts": 1,
  "src/lib/entities/create-from-buffer.ts": 2,
  "src/lib/entity-versions/create-entity-version-from-buffer.ts": 2,
  "src/lib/file-derivative-queue.ts": 4,
  "src/lib/folio-collab-rooms.ts": 2,
  "src/lib/legal-search/raw-source-storage.ts": 5,
  "src/lib/templates/create-template.ts": 1,
  "src/lib/templates/write-template.ts": 1,
  "src/lib/uploads/promote-tmp-object.ts": 2,
  "src/mcp/document-file-upload.ts": 1,
  "src/mcp/file-comparison-links-tool.ts": 1,
} as const satisfies Record<string, number>;

type SourceTree = {
  readonly program: Program;
  readonly text: (node: Node) => string;
  readonly parents: ReadonlyMap<Node, Node>;
};

const memberName = (callee: Node) => {
  if (callee.type !== "MemberExpression" || callee.computed) {
    return null;
  }
  return callee.property.type === "PrivateIdentifier"
    ? `#${callee.property.name}`
    : callee.property.name;
};

const invokedName = (
  node: CallExpression | NewExpression,
  imports: ReadonlyMap<string, string>,
) => {
  const callee = node.callee;
  if (callee.type === "Identifier") {
    return imports.get(callee.name) ?? callee.name;
  }
  const name = memberName(callee);
  if (name === "write" && callee.type === "MemberExpression") {
    const receiver = callee.object;
    if (
      (receiver.type === "CallExpression" &&
        receiver.callee.type === "Identifier" &&
        (imports.get(receiver.callee.name) ?? receiver.callee.name) ===
          "getS3") ||
      (receiver.type === "Identifier" && imports.get(receiver.name) === "getS3")
    ) {
      return "getS3.write";
    }
  }
  return name;
};

// The one gating form: the flag read through its owner. Compared with
// whitespace and the formatter's trailing comma removed.
const FILE_USAGE_LIMITS_ENABLED =
  'isDeploymentFeatureEnabled("FEATURE_FILE_USAGE_LIMITS")';
const FILE_USAGE_LIMITS_DISABLED = `!${FILE_USAGE_LIMITS_ENABLED}`;

const normalizedCondition = (tree: SourceTree, condition: Node): string =>
  tree.text(condition).replaceAll(/\s/gu, "").replaceAll(",)", ")");

const isFlagOff = (tree: SourceTree, node: Node): boolean => {
  let child = node;
  let current = tree.parents.get(node);
  while (current !== undefined && current.type !== "Program") {
    if (current.type === "IfStatement") {
      const condition = normalizedCondition(tree, current.test);
      if (
        (condition === FILE_USAGE_LIMITS_DISABLED &&
          child === current.consequent) ||
        (condition === FILE_USAGE_LIMITS_ENABLED && child === current.alternate)
      ) {
        return true;
      }
    }
    if (current.type === "ConditionalExpression") {
      const condition = normalizedCondition(tree, current.test);
      if (
        (condition === FILE_USAGE_LIMITS_DISABLED &&
          child === current.consequent) ||
        (condition === FILE_USAGE_LIMITS_ENABLED && child === current.alternate)
      ) {
        return true;
      }
    }
    child = current;
    current = tree.parents.get(current);
  }
  return false;
};

type FunctionNode = ArrowFunctionExpression | SyntaxFunction;

const isFunctionNode = (node: Node): node is FunctionNode =>
  node.type === "ArrowFunctionExpression" ||
  node.type === "FunctionDeclaration" ||
  node.type === "FunctionExpression" ||
  node.type === "TSDeclareFunction" ||
  node.type === "TSEmptyBodyFunctionExpression";

// A method's function value belongs to the method, which is not a callback.
const isMethodValue = (node: Node, parent: Node | undefined) =>
  node.type === "FunctionExpression" &&
  (parent?.type === "MethodDefinition" ||
    parent?.type === "TSAbstractMethodDefinition" ||
    (parent?.type === "Property" && (parent.method || parent.kind !== "init")));

// Follow only values supplied to ledger inputs. A nearby ledger call cannot
// account for an unrelated callback, collection, or shadowed declaration.
type StorageCallback = FunctionNode;

type Identifier = Extract<Node, { type: "Identifier" }>;

type Binding = {
  readonly kind: "variable" | "parameter" | "function";
  readonly node: Node;
  readonly name: string;
  readonly scope: Node | undefined;
  readonly initializer?: Node | null;
};

const bindingName = (pattern: Node): string | undefined => {
  if (pattern.type === "Identifier") {
    return pattern.name;
  }
  if (pattern.type === "AssignmentPattern") {
    return bindingName(pattern.left);
  }
  if (pattern.type === "RestElement") {
    return bindingName(pattern.argument);
  }
  return pattern.type === "TSParameterProperty"
    ? bindingName(pattern.parameter)
    : undefined;
};

const collectCallbackFlow = (tree: SourceTree) => {
  const bindings: Binding[] = [];
  const calls: CallExpression[] = [];
  const blockOf = (ancestors: readonly Node[]) =>
    ancestors.findLast(
      (ancestor) =>
        ancestor.type === "BlockStatement" || ancestor.type === "Program",
    );
  walk(tree.program, (candidate, ancestors) => {
    const parent = ancestors.at(-1);
    if (
      candidate.type === "VariableDeclarator" &&
      candidate.id.type === "Identifier"
    ) {
      bindings.push({
        kind: "variable",
        node: candidate,
        name: candidate.id.name,
        scope: blockOf(ancestors),
        initializer: candidate.init,
      });
    }
    // A caught error is declared like a variable without an initializer.
    if (
      candidate.type === "Identifier" &&
      parent?.type === "CatchClause" &&
      parent.param === candidate
    ) {
      bindings.push({
        kind: "variable",
        node: candidate,
        name: candidate.name,
        scope: blockOf(ancestors),
        initializer: null,
      });
    }
    if (
      parent !== undefined &&
      "params" in parent &&
      parent.type !== "TSTypeParameterDeclaration" &&
      parent.params.some((parameter: Node) => parameter === candidate)
    ) {
      const name = bindingName(candidate);
      if (name !== undefined) {
        bindings.push({
          kind: "parameter",
          node: candidate,
          name,
          scope: parent,
        });
      }
    }
    if (
      (candidate.type === "FunctionDeclaration" ||
        candidate.type === "TSDeclareFunction") &&
      candidate.id
    ) {
      bindings.push({
        kind: "function",
        node: candidate,
        name: candidate.id.name,
        scope: blockOf(ancestors),
      });
    }
    if (candidate.type === "CallExpression") {
      calls.push(candidate);
    }
  });
  const resolve = (identifier: Identifier) => {
    let scope = tree.parents.get(identifier);
    while (scope !== undefined) {
      const currentScope = scope;
      const found = bindings.find(
        (binding) =>
          binding.name === identifier.name && binding.scope === currentScope,
      );
      if (found) {
        return found;
      }
      if (scope.type === "Program") {
        return undefined;
      }
      scope = tree.parents.get(scope);
    }
    return undefined;
  };
  return { calls, resolve };
};

const returnedValues = (fn: FunctionNode) => {
  const values: Node[] = [];
  if (!fn.body) {
    return values;
  }
  if (fn.body.type !== "BlockStatement") {
    return [fn.body];
  }
  walk(fn.body, (candidate) => {
    if (candidate.type === "ReturnStatement" && candidate.argument) {
      values.push(candidate.argument);
      return "skip-children";
    }
    return isFunctionNode(candidate) ? "skip-children" : undefined;
  });
  return values;
};

type CallbackTraceOptions = {
  tree: SourceTree;
  flow: ReturnType<typeof collectCallbackFlow>;
  target: StorageCallback;
};

const createCallbackMatcher = ({
  flow: { resolve },
  target,
}: CallbackTraceOptions) => {
  const referencesFunction = (value: Node): boolean => {
    if (value === target) {
      return true;
    }
    if (value.type === "Identifier") {
      const binding = resolve(value);
      return (
        binding?.node === target ||
        (binding?.kind === "variable" && binding.initializer === target)
      );
    }
    return false;
  };
  const callbackUsesTarget = (value: Node): boolean => {
    if (referencesFunction(value)) {
      return true;
    }
    if (
      value.type !== "ArrowFunctionExpression" &&
      value.type !== "FunctionExpression"
    ) {
      return false;
    }
    let used = false;
    if (value.body) {
      walk(value.body, (candidate) => {
        if (
          candidate.type === "CallExpression" &&
          referencesFunction(candidate.callee)
        ) {
          used = true;
        }
        return isFunctionNode(candidate) ? "skip-children" : undefined;
      });
    }
    return used;
  };
  return callbackUsesTarget;
};

const CALLBACK_NAMES = new Set(["copy", "write", "writePdf"]);

const traceLedgerInputs = (options: CallbackTraceOptions) => {
  const {
    tree,
    flow: { calls, resolve },
  } = options;
  const visited = new Set<Node>();
  const callbackUsesTarget = createCallbackMatcher(options);
  const propertyCarriesCallback = (property: Node) => {
    if (
      property.type !== "Property" ||
      property.kind !== "init" ||
      property.method
    ) {
      return false;
    }
    if (property.shorthand) {
      if (property.value.type !== "Identifier") {
        return false;
      }
      if (property.value.name === "inputs") {
        return carriesCallback(property.value);
      }
      return (
        CALLBACK_NAMES.has(property.value.name) &&
        callbackUsesTarget(property.value)
      );
    }
    if (property.computed) {
      return false;
    }
    const name = tree.text(property.key);
    if (CALLBACK_NAMES.has(name)) {
      return callbackUsesTarget(property.value);
    }
    return name === "inputs" && carriesCallback(property.value);
  };
  const carriesCallback = (value: Node): boolean => {
    if (visited.has(value)) {
      return false;
    }
    visited.add(value);
    if (
      value.type === "ParenthesizedExpression" ||
      value.type === "ChainExpression"
    ) {
      return carriesCallback(value.expression);
    }
    if (value.type === "AwaitExpression" || value.type === "SpreadElement") {
      return carriesCallback(value.argument);
    }
    if (value.type === "Identifier") {
      const binding = resolve(value);
      if (!binding) {
        return false;
      }
      if (binding.kind === "function" && isFunctionNode(binding.node)) {
        return returnedValues(binding.node).some(carriesCallback);
      }
      if (
        binding.kind === "variable" &&
        binding.initializer &&
        carriesCallback(binding.initializer)
      ) {
        return true;
      }
      return calls.some(
        (call) =>
          call.callee.type === "MemberExpression" &&
          memberName(call.callee) === "push" &&
          call.callee.object.type === "Identifier" &&
          resolve(call.callee.object) === binding &&
          call.arguments.some(carriesCallback),
      );
    }
    if (value.type === "MemberExpression") {
      return memberName(value) === "value" && carriesCallback(value.object);
    }
    if (value.type === "ArrayExpression") {
      return value.elements.some(
        (element) => element !== null && carriesCallback(element),
      );
    }
    if (value.type === "ObjectExpression") {
      return value.properties.some(propertyCarriesCallback);
    }
    if (
      value.type === "ArrowFunctionExpression" ||
      value.type === "FunctionExpression"
    ) {
      return returnedValues(value).some(carriesCallback);
    }
    if (
      value.type !== "CallExpression" ||
      value.callee.type !== "MemberExpression"
    ) {
      return false;
    }
    const receiver = value.callee.object;
    const name = memberName(value.callee);
    if (name === "map" || name === "flatMap") {
      const callback = value.arguments.at(0);
      return callback !== undefined && carriesCallback(callback);
    }
    if (
      receiver.type === "Identifier" &&
      ((receiver.name === "Result" && (name === "ok" || name === "all")) ||
        (receiver.name === "Promise" && name === "all"))
    ) {
      const input = value.arguments.at(0);
      return input !== undefined && carriesCallback(input);
    }
    return false;
  };
  return carriesCallback;
};

type LedgerCallbackContext = {
  tree: SourceTree;
  imports: ReadonlyMap<string, string>;
  flow: ReturnType<typeof collectCallbackFlow>;
};

const ledgerCallback = (
  node: Node,
  { tree, imports, flow }: LedgerCallbackContext,
): boolean => {
  let ancestor = tree.parents.get(node);
  while (ancestor !== undefined && ancestor.type !== "Program") {
    const parent = tree.parents.get(ancestor);
    if (
      (ancestor.type === "ArrowFunctionExpression" ||
        ancestor.type === "FunctionExpression" ||
        ancestor.type === "FunctionDeclaration") &&
      !isMethodValue(ancestor, parent)
    ) {
      const target = ancestor;
      if (
        flow.calls.some(
          (call) =>
            ledgerCalls.has(invokedName(call, imports) ?? "") &&
            call.arguments.some(
              (argument, index) =>
                index === 0 &&
                traceLedgerInputs({ tree, flow, target })(argument),
            ),
        )
      ) {
        return true;
      }
    }
    ancestor = parent;
  }
  return false;
};

const scan = (file: string, source: string): WriteSite[] => {
  const { program } = parseSource(file, source);
  const imports = new Map<string, string>();
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration") {
      continue;
    }
    for (const element of statement.specifiers) {
      if (element.type === "ImportSpecifier") {
        imports.set(
          element.local.name,
          element.imported.type === "Identifier"
            ? element.imported.name
            : element.imported.value,
        );
      }
    }
  }
  walk(program, (node) => {
    if (node.type !== "VariableDeclarator" || node.id.type !== "Identifier") {
      return;
    }
    const initializer = node.init;
    if (initializer?.type === "Identifier") {
      const target = imports.get(initializer.name) ?? initializer.name;
      if (writeHelpers.has(target) || target === "getS3") {
        imports.set(node.id.name, target);
      }
    }
    if (
      initializer?.type === "CallExpression" &&
      initializer.callee.type === "Identifier" &&
      (imports.get(initializer.callee.name) ?? initializer.callee.name) ===
        "getS3"
    ) {
      imports.set(node.id.name, "getS3");
    }
    if (
      initializer?.type === "MemberExpression" &&
      memberName(initializer) === "write" &&
      initializer.object.type === "CallExpression" &&
      initializer.object.callee.type === "Identifier" &&
      (imports.get(initializer.object.callee.name) ??
        initializer.object.callee.name) === "getS3"
    ) {
      imports.set(node.id.name, "getS3.write");
    }
  });
  const writes: { node: CallExpression | NewExpression; name: string }[] = [];
  walk(program, (node) => {
    if (node.type !== "CallExpression" && node.type !== "NewExpression") {
      return;
    }
    const name = invokedName(node, imports);
    if (
      name &&
      (writeHelpers.has(name) ||
        writeCommands.has(name) ||
        name === "getS3.write")
    ) {
      writes.push({ node, name });
    }
  });
  if (writes.length === 0) {
    return [];
  }
  // Parent links and bindings serve only the files that write.
  const parents = new Map<Node, Node>();
  walk(program, (node, ancestors) => {
    const parent = ancestors.at(-1);
    if (parent !== undefined) {
      parents.set(node, parent);
    }
  });
  const tree: SourceTree = {
    program,
    parents,
    text: (node) => source.slice(node.start, node.end),
  };
  const flow = collectCallbackFlow(tree);
  const ordinals = new Map<string, number>();
  return writes.map(({ node, name }) => {
    const ordinal = ordinals.get(name) ?? 0;
    ordinals.set(name, ordinal + 1);
    return {
      file,
      name,
      ordinal,
      operation: tree.text(node).replace(/\s+/gu, " "),
      ledgerBound: ledgerCallback(node, { tree, imports, flow }),
      flagOff: isFlagOff(tree, node),
    };
  });
};

describe("durable organization file writes", () => {
  test("rejects a new direct write and recognizes a ledger write callback", () => {
    const direct = scan(
      "src/example.ts",
      "const save = async () => await writeS3ObjectWithRetry({ key, data });",
    );
    expect(direct).toMatchObject([{ ledgerBound: false }]);

    const reserved = scan(
      "src/example.ts",
      "const save = async () => await writeOrganizationFile({ objectKey, organizationId, sizeBytes, write: async () => await writeS3ObjectWithRetry({ key, data }) });",
    );
    expect(reserved).toMatchObject([{ ledgerBound: true }]);

    expect(
      scan(
        "src/example.ts",
        "const save = async () => await writeScannedObject({ file, key }); await writeOrganizationFile({ objectKey, organizationId, sizeBytes, write: save });",
      ),
    ).toMatchObject([{ ledgerBound: true }]);

    const native = scan(
      "src/example.ts",
      "const save = async () => await client.send(new PutObjectCommand({ Key: key }));",
    );
    expect(native).toMatchObject([
      { ledgerBound: false, name: "PutObjectCommand" },
    ]);

    const aliased = scan(
      "src/example.ts",
      'import { writeS3ObjectWithRetry as saveObject } from "@/api/lib/s3"; const save = async () => await saveObject({ key, data });',
    );
    expect(aliased).toMatchObject([
      { ledgerBound: false, name: "writeS3ObjectWithRetry" },
    ]);

    const sibling = scan(
      "src/example.ts",
      "const save = async () => { await writeOrganizationFile({ write: async () => await writeS3ObjectWithRetry({ key }) }); await writeS3ObjectWithRetry({ key }); };",
    );
    expect(sibling).toMatchObject([
      { ledgerBound: true },
      { ledgerBound: false },
    ]);

    const sameNameInAnotherScope = scan(
      "src/example.ts",
      "const first = () => { const persist = async () => await writeS3ObjectWithRetry({ key }); }; const second = () => { const persist = async () => await writeS3ObjectWithRetry({ key }); return writeOrganizationFile({ write: persist }); };",
    );
    expect(sameNameInAnotherScope).toMatchObject([
      { ledgerBound: false },
      { ledgerBound: true },
    ]);

    expect(
      scan("src/example.ts", "await getS3().write(key, data)"),
    ).toMatchObject([{ ledgerBound: false, name: "getS3.write" }]);
    expect(
      scan(
        "src/example.ts",
        "const client = getS3(); const save = writeS3ObjectWithRetry; const rawWrite = getS3().write; await client.write(key, data); await save({ key, data }); await rawWrite(key, data);",
      ),
    ).toMatchObject([
      { ledgerBound: false, name: "getS3.write" },
      { ledgerBound: false, name: "writeS3ObjectWithRetry" },
      { ledgerBound: false, name: "getS3.write" },
    ]);
  });

  test("recognizes returned copy callbacks flowing through prepared batches", () => {
    const source = `
      const prepareFile = async (file) => Result.ok({
        copy: async () => await copyObject(file.source, file.target),
      });
      const prepared = [];
      for (const batch of chunk(files, 4)) {
        prepared.push(...(await Promise.all(batch.map(prepareFile))));
      }
      const inputs = Result.all(prepared);
      await copyOrganizationFiles({ inputs: inputs.value });
    `;
    expect(scan("src/example.ts", source)).toMatchObject([
      { ledgerBound: true },
    ]);
    expect(
      scan(
        "src/example.ts",
        source.replace("inputs: inputs.value", "inputs: unrelated"),
      ),
    ).toMatchObject([{ ledgerBound: false }]);
  });

  test("recognizes returned mapped copy inputs and rejects producer-side writes", () => {
    const source = `
      const inputs = ready.value.flatMap((file) => {
        const objects = [file];
        return objects.map((object) => {
          copyObject(object.source, object.unaccounted);
          return { copy: async () => await copyObject(object.source, object.target) };
        });
      });
      await copyOrganizationFiles({ inputs });
    `;
    expect(scan("src/example.ts", source)).toMatchObject([
      { ledgerBound: false },
      { ledgerBound: true },
    ]);
  });

  test("recognizes a shared callback inside mapped writes and its flag-off path", () => {
    const source = `
      const write = async (file) => await writeS3ObjectWithRetry({ key: file.key });
      if (isDeploymentFeatureEnabled("FEATURE_FILE_USAGE_LIMITS")) {
        await writeOrganizationFiles(files.map((file) => ({ write: async () => await write(file) })));
      } else {
        for (const file of files) { await write(file); }
      }
      await writeS3ObjectWithRetry({ key: unrelated });
    `;
    expect(scan("src/example.ts", source)).toMatchObject([
      { ledgerBound: true },
      { ledgerBound: false },
    ]);
    expect(
      scan(
        "src/example.ts",
        source.replace("await write(file) })))", "await unrelated(file) })))"),
      ),
    ).toMatchObject([{ ledgerBound: false }, { ledgerBound: false }]);
  });

  test("rejects shadowed producers and unrelated same-scope collections", () => {
    const source = `
      const prepareFile = async () => Result.ok({ copy: async () => await copyObject(source, target) });
      const detached = [];
      detached.push(...(await Promise.all(files.map(prepareFile))));
      const prepared = [];
      {
        const prepareFile = async () => Result.ok({ copy: async () => await copyObject(source, otherTarget) });
        prepared.push(...(await Promise.all(files.map(prepareFile))));
      }
      await copyOrganizationFiles({ inputs: Result.all(prepared).value });
    `;
    expect(scan("src/example.ts", source)).toMatchObject([
      { ledgerBound: false },
      { ledgerBound: true },
    ]);
  });

  test("rejects a nested callback that is never invoked by the ledger writer", () => {
    const source = `
      const write = async () => await writeS3ObjectWithRetry({ key });
      await writeOrganizationFiles(files.map(() => ({ write: async () => {
        const unused = async () => await write();
        return unrelated();
      } })));
    `;
    expect(scan("src/example.ts", source)).toMatchObject([
      { ledgerBound: false },
    ]);
  });

  test("rejects writes carried by metadata and shadowed callback parameters", () => {
    const source = `
      const write = async () => await writeS3ObjectWithRetry({ key: detached });
      await writeOrganizationFiles(files.map((write) => ({ write: async () => await write() })));
      await copyOrganizationFiles({ inputs: [{
        copy: async () => await copyObject(source, target),
        metadata: async () => await copyObject(source, unaccounted),
      }] });
      await copyOrganizationFiles({ inputs: copyObject(source, eager) });
      await copyOrganizationFiles({ inputs: files.map(() => unrelated, {
        copy: async () => await copyObject(source, unusedThisArg),
      }) });
      await copyOrganizationFiles({ inputs: unrelated }, {
        copy: async () => await copyObject(source, unusedSecondArgument),
      });
    `;
    expect(scan("src/example.ts", source)).toMatchObject([
      { ledgerBound: false },
      { ledgerBound: true },
      { ledgerBound: false },
      { ledgerBound: false },
      { ledgerBound: false },
      { ledgerBound: false },
    ]);
  });

  test("all direct storage writes have a ledger boundary or an explicit exemption", async () => {
    const files = [
      ...new Bun.Glob("src/**/*.ts").scanSync({
        cwd: path.join(root, "apps/api"),
      }),
      ...new Bun.Glob("scripts/**/*.ts").scanSync({
        cwd: path.join(root, "apps/api"),
      }),
    ].filter(
      (file) =>
        !file.endsWith(".test.ts") &&
        !file.endsWith(".spec.ts") &&
        file !== "src/lib/s3.ts" &&
        file !== "src/lib/s3-presign.ts",
    );
    const sites = await Promise.all(
      files.map(async (file) =>
        scan(file, await Bun.file(path.join(root, "apps/api", file)).text()),
      ),
    );
    const allSites = sites.flat();
    const counts = Object.fromEntries(
      [...new Set(allSites.map((site) => site.file))]
        .toSorted()
        .map((file) => [
          file,
          allSites.filter((site) => site.file === file).length,
        ]),
    );
    expect(counts).toEqual(expectedWriteCounts);
    const unbound = allSites.filter(
      (site) => !site.ledgerBound && !site.flagOff,
    );
    const exemptionIds = unbound.map(
      (site) => `${site.file}:${site.name}:${site.ordinal}`,
    );
    const unaccounted = unbound.filter(
      (site) => !(`${site.file}:${site.name}:${site.ordinal}` in exemptions),
    );
    expect(unaccounted).toEqual([]);
    expect(exemptionIds.toSorted()).toEqual(Object.keys(exemptions).toSorted());
    const exemptionById = new Map(Object.entries(exemptions));
    for (const site of unbound) {
      const category = exemptionById.get(
        `${site.file}:${site.name}:${site.ordinal}`,
      );
      if (category === undefined) {
        throw new Error("Unaccounted storage write exemption");
      }
      switch (category) {
        case "export": {
          const source = await Bun.file(
            path.join(root, "apps/api", site.file),
          ).text();
          expect(source).toContain("exports/");
          break;
        }
        case "public_corpus": {
          const source = await Bun.file(
            path.join(root, "apps/api", site.file),
          ).text();
          expect(source).toContain("formatCorpusLocation");
          break;
        }
        case "temporary":
          expect(site.operation).toContain("url: reservation.url");
          break;
        case "fixture":
          expect(site.file.startsWith("scripts/seed-")).toBe(true);
          break;
        case "reservation_flow": {
          const source = await Bun.file(
            path.join(root, "apps/api", site.file),
          ).text();
          expect(source).toContain("authorizeOrganizationFileWrite(");
          expect(source).toContain("commitOrganizationFileBytes(");
          break;
        }
      }
    }
  });
});
