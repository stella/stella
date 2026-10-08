import { describe, expect, test } from "bun:test";
import path from "node:path";
import ts from "typescript";

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
  "scripts/seed-dev.ts": 2,
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

const invokedName = (
  node: ts.CallExpression | ts.NewExpression,
  imports: ReadonlyMap<string, string>,
) => {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) {
    return imports.get(callee.text) ?? callee.text;
  }
  if (ts.isPropertyAccessExpression(callee)) {
    if (callee.name.text === "write") {
      const receiver = callee.expression;
      if (
        (ts.isCallExpression(receiver) &&
          ts.isIdentifier(receiver.expression) &&
          (imports.get(receiver.expression.text) ??
            receiver.expression.text) === "getS3") ||
        (ts.isIdentifier(receiver) && imports.get(receiver.text) === "getS3")
      ) {
        return "getS3.write";
      }
    }
    return callee.name.text;
  }
  return null;
};

// The one gating form: the flag read through its owner. Compared with
// whitespace and the formatter's trailing comma removed.
const FILE_USAGE_LIMITS_ENABLED =
  'isDeploymentFeatureEnabled("FEATURE_FILE_USAGE_LIMITS")';
const FILE_USAGE_LIMITS_DISABLED = `!${FILE_USAGE_LIMITS_ENABLED}`;

const normalizedCondition = (condition: ts.Expression): string =>
  condition.getText().replaceAll(/\s/gu, "").replaceAll(",)", ")");

const isFlagOff = (node: ts.Node): boolean => {
  let child = node;
  let current = node.parent;
  while (!ts.isSourceFile(current)) {
    if (ts.isIfStatement(current)) {
      const condition = normalizedCondition(current.expression);
      if (
        (condition === FILE_USAGE_LIMITS_DISABLED &&
          child === current.thenStatement) ||
        (condition === FILE_USAGE_LIMITS_ENABLED &&
          child === current.elseStatement)
      ) {
        return true;
      }
    }
    if (ts.isConditionalExpression(current)) {
      const condition = normalizedCondition(current.condition);
      if (
        (condition === FILE_USAGE_LIMITS_DISABLED &&
          child === current.whenTrue) ||
        (condition === FILE_USAGE_LIMITS_ENABLED && child === current.whenFalse)
      ) {
        return true;
      }
    }
    child = current;
    current = current.parent;
  }
  return false;
};

// Follow only values supplied to ledger inputs. A nearby ledger call cannot
// account for an unrelated callback, collection, or shadowed declaration.
type StorageCallback =
  | ts.ArrowFunction
  | ts.FunctionExpression
  | ts.FunctionDeclaration;

const collectCallbackFlow = (ast: ts.SourceFile) => {
  const bindings: (
    | ts.VariableDeclaration
    | ts.ParameterDeclaration
    | ts.FunctionDeclaration
  )[] = [];
  const calls: ts.CallExpression[] = [];
  const collect = (candidate: ts.Node) => {
    if (
      ts.isVariableDeclaration(candidate) ||
      ts.isParameter(candidate) ||
      ts.isFunctionDeclaration(candidate)
    ) {
      bindings.push(candidate);
    }
    if (ts.isCallExpression(candidate)) {
      calls.push(candidate);
    }
    ts.forEachChild(candidate, collect);
  };
  collect(ast);
  const scopeOf = (binding: (typeof bindings)[number]) => {
    let scope = binding.parent;
    while (
      !ts.isBlock(scope) &&
      !ts.isSourceFile(scope) &&
      !(ts.isParameter(binding) && ts.isFunctionLike(scope))
    ) {
      scope = scope.parent;
    }
    return scope;
  };
  const resolve = (identifier: ts.Identifier) => {
    let scope = identifier.parent;
    for (;;) {
      const currentScope = scope;
      const found = bindings.find(
        (binding) =>
          binding.name !== undefined &&
          ts.isIdentifier(binding.name) &&
          binding.name.text === identifier.text &&
          scopeOf(binding) === currentScope,
      );
      if (found) {
        return found;
      }
      if (ts.isSourceFile(scope)) {
        return undefined;
      }
      scope = scope.parent;
    }
  };
  return { calls, resolve };
};

const returnedValues = (
  fn: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration,
) => {
  const values: ts.Expression[] = [];
  if (!fn.body) {
    return values;
  }
  if (!ts.isBlock(fn.body)) {
    return [fn.body];
  }
  const visit = (candidate: ts.Node) => {
    if (ts.isReturnStatement(candidate) && candidate.expression) {
      values.push(candidate.expression);
      return;
    }
    if (ts.isFunctionLike(candidate)) {
      return;
    }
    ts.forEachChild(candidate, visit);
  };
  visit(fn.body);
  return values;
};

type CallbackTraceOptions = {
  ast: ts.SourceFile;
  flow: ReturnType<typeof collectCallbackFlow>;
  target: StorageCallback;
};

const createCallbackMatcher = ({
  flow: { resolve },
  target,
}: CallbackTraceOptions) => {
  const referencesFunction = (value: ts.Node): boolean => {
    if (value === target) {
      return true;
    }
    if (ts.isIdentifier(value)) {
      const binding = resolve(value);
      return (
        binding === target ||
        (binding !== undefined &&
          ts.isVariableDeclaration(binding) &&
          binding.initializer === target)
      );
    }
    return false;
  };
  const callbackUsesTarget = (value: ts.Node): boolean => {
    if (referencesFunction(value)) {
      return true;
    }
    if (!ts.isArrowFunction(value) && !ts.isFunctionExpression(value)) {
      return false;
    }
    let used = false;
    const visit = (candidate: ts.Node) => {
      if (
        ts.isCallExpression(candidate) &&
        referencesFunction(candidate.expression)
      ) {
        used = true;
      }
      if (ts.isFunctionLike(candidate)) {
        return;
      }
      ts.forEachChild(candidate, visit);
    };
    visit(value.body);
    return used;
  };
  return callbackUsesTarget;
};

const traceLedgerInputs = (options: CallbackTraceOptions) => {
  const {
    ast,
    flow: { calls, resolve },
  } = options;
  const visited = new Set<ts.Node>();
  const callbackUsesTarget = createCallbackMatcher(options);
  const propertyCarriesCallback = (property: ts.ObjectLiteralElementLike) => {
    if (ts.isShorthandPropertyAssignment(property)) {
      if (property.name.text === "inputs") {
        return carriesCallback(property.name);
      }
      return (
        (property.name.text === "copy" ||
          property.name.text === "write" ||
          property.name.text === "writePdf") &&
        callbackUsesTarget(property.name)
      );
    }
    if (!ts.isPropertyAssignment(property)) {
      return false;
    }
    const name = property.name.getText(ast);
    if (name === "copy" || name === "write" || name === "writePdf") {
      return callbackUsesTarget(property.initializer);
    }
    return name === "inputs" && carriesCallback(property.initializer);
  };
  const carriesCallback = (value: ts.Node): boolean => {
    if (visited.has(value)) {
      return false;
    }
    visited.add(value);
    if (
      ts.isParenthesizedExpression(value) ||
      ts.isAwaitExpression(value) ||
      ts.isSpreadElement(value)
    ) {
      return carriesCallback(value.expression);
    }
    if (ts.isIdentifier(value)) {
      const binding = resolve(value);
      if (!binding) {
        return false;
      }
      if (ts.isFunctionDeclaration(binding)) {
        return returnedValues(binding).some(carriesCallback);
      }
      if (
        ts.isVariableDeclaration(binding) &&
        binding.initializer &&
        carriesCallback(binding.initializer)
      ) {
        return true;
      }
      return calls.some(
        (call) =>
          ts.isPropertyAccessExpression(call.expression) &&
          call.expression.name.text === "push" &&
          ts.isIdentifier(call.expression.expression) &&
          resolve(call.expression.expression) === binding &&
          call.arguments.some(carriesCallback),
      );
    }
    if (ts.isPropertyAccessExpression(value)) {
      return value.name.text === "value" && carriesCallback(value.expression);
    }
    if (ts.isArrayLiteralExpression(value)) {
      return value.elements.some(carriesCallback);
    }
    if (ts.isObjectLiteralExpression(value)) {
      return value.properties.some(propertyCarriesCallback);
    }
    if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
      return returnedValues(value).some(carriesCallback);
    }
    if (
      !ts.isCallExpression(value) ||
      !ts.isPropertyAccessExpression(value.expression)
    ) {
      return false;
    }
    const { expression: receiver, name } = value.expression;
    if (name.text === "map" || name.text === "flatMap") {
      const callback = value.arguments.at(0);
      return callback !== undefined && carriesCallback(callback);
    }
    if (
      ts.isIdentifier(receiver) &&
      ((receiver.text === "Result" &&
        (name.text === "ok" || name.text === "all")) ||
        (receiver.text === "Promise" && name.text === "all"))
    ) {
      const input = value.arguments.at(0);
      return input !== undefined && carriesCallback(input);
    }
    return false;
  };
  return carriesCallback;
};

type LedgerCallbackContext = {
  ast: ts.SourceFile;
  imports: ReadonlyMap<string, string>;
  flow: ReturnType<typeof collectCallbackFlow>;
};

const ledgerCallback = (
  node: ts.Node,
  { ast, imports, flow }: LedgerCallbackContext,
): boolean => {
  let ancestor = node.parent;
  while (!ts.isSourceFile(ancestor)) {
    if (
      ts.isArrowFunction(ancestor) ||
      ts.isFunctionExpression(ancestor) ||
      ts.isFunctionDeclaration(ancestor)
    ) {
      const target = ancestor;
      if (
        flow.calls.some(
          (call) =>
            ledgerCalls.has(invokedName(call, imports) ?? "") &&
            call.arguments.some(
              (argument, index) =>
                index === 0 &&
                traceLedgerInputs({ ast, flow, target })(argument),
            ),
        )
      ) {
        return true;
      }
    }
    ancestor = ancestor.parent;
  }
  return false;
};

const scan = (file: string, source: string): WriteSite[] => {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const imports = new Map<string, string>();
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    const named = statement.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) {
      continue;
    }
    for (const element of named.elements) {
      imports.set(
        element.name.text,
        element.propertyName?.text ?? element.name.text,
      );
    }
  }
  const visitAliases = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const initializer = node.initializer;
      if (initializer && ts.isIdentifier(initializer)) {
        const target = imports.get(initializer.text) ?? initializer.text;
        if (writeHelpers.has(target) || target === "getS3") {
          imports.set(node.name.text, target);
        }
      }
      if (
        initializer &&
        ts.isCallExpression(initializer) &&
        ts.isIdentifier(initializer.expression) &&
        (imports.get(initializer.expression.text) ??
          initializer.expression.text) === "getS3"
      ) {
        imports.set(node.name.text, "getS3");
      }
      if (
        initializer &&
        ts.isPropertyAccessExpression(initializer) &&
        initializer.name.text === "write" &&
        ts.isCallExpression(initializer.expression) &&
        ts.isIdentifier(initializer.expression.expression) &&
        (imports.get(initializer.expression.expression.text) ??
          initializer.expression.expression.text) === "getS3"
      ) {
        imports.set(node.name.text, "getS3.write");
      }
    }
    ts.forEachChild(node, visitAliases);
  };
  visitAliases(ast);
  const flow = collectCallbackFlow(ast);
  const ordinals = new Map<string, number>();
  const sites: WriteSite[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const name = invokedName(node, imports);
      if (
        name &&
        (writeHelpers.has(name) ||
          writeCommands.has(name) ||
          name === "getS3.write")
      ) {
        const ordinal = ordinals.get(name) ?? 0;
        ordinals.set(name, ordinal + 1);
        sites.push({
          file,
          name,
          ordinal,
          operation: node.getText(ast).replace(/\s+/gu, " "),
          ledgerBound: ledgerCallback(node, { ast, imports, flow }),
          flagOff: isFlagOff(node),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return sites;
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
          expect(source).toContain("reserveOrganizationFileBytes(");
          expect(source).toContain("commitOrganizationFileBytes(");
          break;
        }
      }
    }
  });
});
