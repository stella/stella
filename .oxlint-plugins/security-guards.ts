// Security guard lint rules.
//
// Catches common security anti-patterns at lint time:
//   1. no-raw-filename-write  — request-supplied filenames written without
//      sanitizeFilename()
//   2. no-unsanitized-href    — dynamic href without sanitization
//   3. no-unscoped-user-query — user-table query without membership scoping
//   4. require-secure-document-response — direct raw document Response
//      construction outside the typed security boundary

import { eslintCompatPlugin, type Variable } from "@oxlint/plugins";

import {
  canonicalModuleId,
  everyNode,
  getImportedName,
  getPropertyName,
  invokedCallee,
  isAstNode,
  isCallTo,
  isIdentifier,
  isIdentifierReference,
  isFileIn,
  isStringLiteral,
  memberPropertyName,
  repoRelativeFilename,
  resolveImport,
  resolveVariable,
  stableInitializer,
  unwrapExpression,
  type AstNode,
} from "./utils.ts";

// ── Rule 1: no-raw-filename-write ──────────────────────────────
//
// User-supplied filenames can contain path traversal segments
// (../../etc/passwd) or control characters. Every value written to a
// `fileName` / `filename` key or member must pass through the
// `sanitizeFilename` exported by the module that owns it before reaching
// storage or downstream logic.
//
// A value is request-derived when it comes from a handler's `body`, `query`
// or `params` (including `ctx.body` and destructured parameters), from an
// upload `file` / multipart `part`, or from a member, element or method
// result of one of those. Its `.name` / `.filename` / `.fileName` is a raw
// filename, and so is anything built from one: a stable alias, a
// destructured binding, string methods (`.trim()`), templates and
// concatenation.
//
// Safe patterns (not flagged):
//   fileName: sanitizeFilename(file.name)
//   fileName: content.fileName           (DB read-back)
//   fileName: true                       (Drizzle column selector)
//   fileName: "literal.pdf"
//
// Flagged:
//   fileName: file.name
//   fileName: body.upload.name.trim()
//   filename: part.filename
//   row.fileName = params.fileName

// Names that hold request input or an uploaded file wherever they appear.
const REQUEST_INPUT_NAMES: ReadonlySet<string> = new Set([
  "body",
  "file",
  "files",
  "params",
  "part",
  "parts",
  "query",
  "upload",
]);

// Members of a request context that carry request input (`ctx.body`).
// `query` is left out: as a member it is Drizzle's relational API
// (`tx.query.templates`), and handlers receive the request query destructured.
const REQUEST_INPUT_PROPERTIES: ReadonlySet<string> = new Set([
  "body",
  "params",
]);

// Properties of request input that carry a client-chosen filename.
const RAW_NAME_PROPS: ReadonlySet<string> = new Set([
  "fileName",
  "filename",
  "name",
]);

// Keys and members a filename is written to.
const FILENAME_SINK_KEYS: ReadonlySet<string> = new Set([
  "fileName",
  "filename",
]);

const SANITIZE_FILENAME_MODULE = "apps/api/src/lib/sanitize-filename";
const SANITIZE_FILENAME_EXPORTS: ReadonlySet<string> = new Set([
  "sanitizeFilename",
  "sanitizeFilenamePreservingExtension",
]);

type Taint = "request" | "filename";

type BindingPath = { keys: (string | null)[]; root: AstNode };

// The keys a destructured binding reads, outermost first, and the pattern
// root they start from: `{ body: { file: upload } }` gives ["body", "file"]
// for `upload`. An array element or rest step reads a null key.
const bindingPatternPath = (binding: AstNode): BindingPath => {
  const keys: (string | null)[] = [];
  let current = binding;
  while (true) {
    const parent = current.parent;
    if (!isAstNode(parent)) {
      break;
    }
    if (parent.type === "AssignmentPattern" && parent.left === current) {
      current = parent;
      continue;
    }
    if (parent.type === "RestElement") {
      keys.unshift(null);
      current = parent;
      continue;
    }
    if (parent.type === "ArrayPattern") {
      keys.unshift(null);
      current = parent;
      continue;
    }
    if (
      parent.type === "Property" &&
      parent.value === current &&
      isAstNode(parent.parent) &&
      parent.parent.type === "ObjectPattern"
    ) {
      keys.unshift(
        parent.computed === true && !isStringLiteral(parent.key)
          ? null
          : getPropertyName(parent.key),
      );
      current = parent.parent;
      continue;
    }
    break;
  }
  return { keys, root: current };
};

// The taint a destructured binding takes from the value it destructures.
const destructuredTaint = (
  base: Taint | null,
  keys: readonly (string | null)[],
): Taint | null => {
  const requestAt = keys.findIndex(
    (key) => key !== null && REQUEST_INPUT_PROPERTIES.has(key),
  );
  const fromRequest = base === "request" || requestAt !== -1;
  if (!fromRequest) {
    return null;
  }
  const last = keys.at(-1);
  const readsName =
    last !== undefined &&
    last !== null &&
    RAW_NAME_PROPS.has(last) &&
    (base === "request" || requestAt < keys.length - 1);
  return readsName ? "filename" : "request";
};

// ── Rule 2: no-unsanitized-href ────────────────────────────────
//
// Passing unsanitized dynamic values to <a href={...}> enables javascript:
// XSS. Dynamic destinations must be sanitized at the sink; a local variable
// or arbitrary URL-building function does not prove a safe protocol.
//
// Safe patterns (not flagged):
//   href="https://..."                  (string literal)
//   href={`/path/${id}`}                (template literal)
//   href={sanitizeHref(url)}            (sanitizer call)
//   href={readerHref(url, policy)}      (sanitizer call; it calls sanitizeHref
//                                        and then withholds a host the
//                                        document may not link to)
// Flagged:
//   href={node.href}       (data object property access)
//   href={item.url}        (data object property access)
//   href={url}             (origin is not proven at the sink)
//   href={buildUrl()}      (arbitrary calls are not sanitizers)

const SAFE_HREF_PREFIXES = ["http", "/", "#", "mailto:"];

const isSafeStringLiteral = (node): boolean => {
  if (node.type === "Literal" && typeof node.value === "string") {
    return SAFE_HREF_PREFIXES.some((prefix) => node.value.startsWith(prefix));
  }
  return false;
};

const isSafeTemplateLiteral = (node): boolean => {
  if (node.type !== "TemplateLiteral") {
    return false;
  }
  const firstQuasi = node.quasis[0];
  if (!firstQuasi) {
    return false;
  }
  return SAFE_HREF_PREFIXES.some((prefix) =>
    firstQuasi.value.raw.startsWith(prefix),
  );
};

// The sanitizers a sink may be fed from, keyed by export name, each with the
// module that owns it. `readerHref` is the legal reader's own gate: it returns
// `sanitizeHref`'s answer and then withholds any host outside the document's
// publisher, so it is never weaker than `sanitizeHref`. A helper only earns a
// place here by calling one of these itself.
const HREF_SANITIZERS: ReadonlyMap<string, string> = new Map([
  ["sanitizeHref", "apps/web/src/lib/sanitize-href"],
  ["readerHref", "apps/web/src/components/legal-reader/source-link-policy"],
]);

// ── Rule 3: no-unscoped-user-query ─────────────────────────────
//
// A query chain that reads the `user` table exported by the auth schema must
// scope it through organization membership in the same chain: it references
// both `member.userId` and `member.organizationId` of the auth schema's
// `member` table. Both tables are recognised by what they are bound to, so an
// aliased import, a namespace member, or a local alias still counts.
// Historical correspondence actors instead follow the stored filer/approval
// relationship, with organization, matter and correspondence predicates.
//
// A plain insert creates a row and reads none, so `insert(user)` is judged
// only when it hands rows back (`returning`) or rewrites an existing one
// (`onConflictDoUpdate`).
//
// Modules whose every user-table query answers to another scope (the caller's
// own account, an instance-wide operator view) are listed in the rule's
// `allowedFiles` option, each with the reason that scope holds. Anything else
// needs a narrow suppression with evidence.

const AUTH_SCHEMA_MODULE = "apps/api/src/db/auth-schema";
const USER_TABLE_EXPORT = "user";
const MEMBER_TABLE_EXPORT = "member";

// Chain calls that make an insert read or overwrite an existing row.
const ROW_READING_INSERT_CALLS: ReadonlySet<string> = new Set([
  "onConflictDoUpdate",
  "returning",
]);

const allowedUnscopedFiles = (options: unknown): string[] => {
  const configured: unknown = Array.isArray(options) ? options.at(0) : null;
  if (
    typeof configured !== "object" ||
    configured === null ||
    !("allowedFiles" in configured) ||
    !Array.isArray(configured.allowedFiles)
  ) {
    return [];
  }
  return configured.allowedFiles.flatMap((entry: unknown) =>
    typeof entry === "object" &&
    entry !== null &&
    "file" in entry &&
    "reason" in entry &&
    typeof entry.file === "string" &&
    typeof entry.reason === "string" &&
    entry.reason.trim() !== ""
      ? [entry.file]
      : [],
  );
};

// `db.insert(user)`: the table is the argument of an `insert` call.
const isInsertTarget = (node: AstNode): boolean => {
  const call = node.parent;
  if (
    !isAstNode(call) ||
    call.type !== "CallExpression" ||
    !Array.isArray(call.arguments) ||
    call.arguments.at(0) !== node
  ) {
    return false;
  }
  const callee = unwrapExpression(call.callee);
  return (
    callee?.type === "MemberExpression" &&
    memberPropertyName(callee) === "insert"
  );
};

const readsInsertedRows = (chain: AstNode): boolean =>
  everyNode(chain).some((node) => {
    if (node.type !== "MemberExpression") {
      return false;
    }
    const property = memberPropertyName(node);
    return property !== null && ROW_READING_INSERT_CALLS.has(property);
  });

// Where one query expression ends: a statement, a declaration, or a function
// (a callback is its own query). Walking up from a table reference to the
// last node below one of these reaches the whole query, including its select
// map, join conditions and `sql` fragments.
const isQueryChainBoundary = (node: AstNode): boolean =>
  node.type === "Program" ||
  node.type === "VariableDeclarator" ||
  node.type === "PropertyDefinition" ||
  node.type === "ArrowFunctionExpression" ||
  node.type === "FunctionExpression" ||
  node.type.endsWith("Statement") ||
  node.type.endsWith("Declaration");

const queryChainRoot = (node: AstNode): AstNode => {
  let current = node;
  while (isAstNode(current.parent) && !isQueryChainBoundary(current.parent)) {
    current = current.parent;
  }
  return current;
};

// Type positions (`typeof user.$inferSelect`) name the table without
// querying it.
const isInTypePosition = (node: AstNode): boolean => {
  let current: unknown = node.parent;
  while (isAstNode(current)) {
    if (
      current.type.startsWith("TS") &&
      current.type !== "TSAsExpression" &&
      current.type !== "TSSatisfiesExpression" &&
      current.type !== "TSNonNullExpression" &&
      current.type !== "TSTypeAssertion" &&
      current.type !== "TSInstantiationExpression"
    ) {
      return true;
    }
    if (current.type.endsWith("Statement") || current.type === "Program") {
      return false;
    }
    current = current.parent;
  }
  return false;
};

// ── Rule 4: require-secure-document-response ──────────────────
//
// Production file handlers and attachment responses return privileged bytes
// through the global Response constructor. Null-body status responses carry no
// document data; every download must use the typed constructor that owns its
// security headers, MIME type, disposition, and sanitized filename.

const RAW_DOCUMENT_SECURITY_HEADERS = "RAW_DOCUMENT_RESPONSE_SECURITY_HEADERS";
const SECURITY_HEADERS_MODULE = "apps/api/src/lib/security-headers";

const getHeadersObject = (node) => {
  if (node.type !== "ObjectExpression") {
    return null;
  }

  const headersProperty = node.properties.find(
    (property) =>
      property.type === "Property" &&
      getPropertyName(property.key) === "headers",
  );
  if (!headersProperty || headersProperty.type !== "Property") {
    return null;
  }

  return headersProperty.value;
};

const hasAttachmentDisposition = (node): boolean => {
  if (node.type !== "ObjectExpression") {
    return false;
  }

  const disposition = node.properties.find(
    (property) =>
      property.type === "Property" &&
      getPropertyName(property.key)?.toLowerCase() === "content-disposition",
  );
  if (!disposition || disposition.type !== "Property") {
    return false;
  }

  if (
    disposition.value.type === "Literal" &&
    typeof disposition.value.value === "string"
  ) {
    return disposition.value.value.toLowerCase().startsWith("attachment;");
  }

  return isCallTo(disposition.value, "contentDisposition");
};

const FILE_HANDLER_DIRECTORY = "apps/api/src/handlers/files/";

const hasEquality = (
  pairs: [AstNode, AstNode][],
  leftMatches: (node: AstNode) => boolean,
  rightMatches: (node: AstNode) => boolean,
): boolean =>
  pairs.some(
    ([left, right]) =>
      (leftMatches(left) && rightMatches(right)) ||
      (leftMatches(right) && rightMatches(left)),
  );

const fluentQueryContaining = (reference: AstNode): AstNode | null => {
  let current = reference;
  while (isAstNode(current.parent) && !isQueryChainBoundary(current.parent)) {
    current = current.parent;
    if (current.type !== "CallExpression") {
      continue;
    }
    const callee = unwrapExpression(current.callee);
    if (callee?.type !== "MemberExpression") {
      continue;
    }
    if (
      !["select", "from", "leftJoin", "innerJoin", "where"].includes(
        memberPropertyName(callee) ?? "",
      )
    ) {
      continue;
    }
    while (
      isAstNode(current.parent) &&
      current.parent.type === "MemberExpression" &&
      current.parent.object === current &&
      isAstNode(current.parent.parent) &&
      current.parent.parent.type === "CallExpression" &&
      current.parent.parent.callee === current.parent
    ) {
      current = current.parent.parent;
    }
    return current;
  }
  return null;
};

const createHistoricalRelationshipScopeChecker = (
  context: Parameters<typeof resolveImport>[0],
) => {
  type UserTableIdentity = Variable | typeof USER_TABLE_EXPORT;
  const userTableIdentity = (
    node: unknown,
    seen = new Set<Variable>(),
  ): UserTableIdentity | null => {
    const expression = unwrapExpression(node);
    if (!isAstNode(expression)) {
      return null;
    }
    const imported = resolveImport(context, expression);
    if (
      imported?.moduleId === AUTH_SCHEMA_MODULE &&
      imported.imported === USER_TABLE_EXPORT
    ) {
      return USER_TABLE_EXPORT;
    }
    if (!isIdentifierReference(expression)) {
      return null;
    }
    const variable = resolveVariable(context, expression);
    if (variable === null || seen.has(variable)) {
      return null;
    }
    seen.add(variable);
    const initializer = stableInitializer(variable);
    if (initializer === null) {
      return null;
    }
    if (initializer.type === "CallExpression") {
      const called = resolveImport(context, invokedCallee(initializer));
      if (
        called?.moduleId === "drizzle-orm/pg-core" &&
        called.imported === "alias" &&
        Array.isArray(initializer.arguments) &&
        userTableIdentity(initializer.arguments.at(0), seen) !== null
      ) {
        return variable;
      }
      return null;
    }
    return userTableIdentity(initializer, seen);
  };

  const correspondenceTable = (node: unknown, exported: string): boolean => {
    const resolved = resolveImport(context, node);
    return (
      resolved?.imported === exported &&
      (resolved.moduleId === "apps/api/src/db/schema" ||
        resolved.moduleId === "apps/api/src/db/schema/correspondence")
    );
  };
  const correspondenceColumn = (
    node: AstNode,
    table: string,
    column: string,
  ): boolean =>
    node.type === "MemberExpression" &&
    memberPropertyName(node) === column &&
    correspondenceTable(node.object, table);
  const userIdColumn = (node: AstNode, identity: UserTableIdentity): boolean =>
    node.type === "MemberExpression" &&
    memberPropertyName(node) === "id" &&
    userTableIdentity(node.object) === identity;

  // An equality inside OR, a callback, or a similarly named local helper
  // does not establish a mandatory predicate for this query.
  const conjunctiveEqualities = (node: unknown): [AstNode, AstNode][] => {
    const expression = unwrapExpression(node);
    if (
      expression?.type !== "CallExpression" ||
      !Array.isArray(expression.arguments)
    ) {
      return [];
    }
    const called = resolveImport(context, invokedCallee(expression));
    if (called?.moduleId !== "drizzle-orm") {
      return [];
    }
    if (called.imported === "and") {
      return expression.arguments.flatMap(conjunctiveEqualities);
    }
    const left = unwrapExpression(expression.arguments.at(0));
    const right = unwrapExpression(expression.arguments.at(1));
    return called.imported === "eq" && isAstNode(left) && isAstNode(right)
      ? [[left, right]]
      : [];
  };
  const hasHistoricalRelationship = (
    query: AstNode,
    identity: UserTableIdentity,
  ): boolean => {
    const calls: { method: string; args: unknown[] }[] = [];
    let current: AstNode | null = query;
    while (current?.type === "CallExpression") {
      const callee = unwrapExpression(current.callee);
      if (
        callee?.type !== "MemberExpression" ||
        !Array.isArray(current.arguments)
      ) {
        break;
      }
      const method = memberPropertyName(callee);
      if (method !== null) {
        calls.push({ method, args: current.arguments });
      }
      current = unwrapExpression(callee.object);
    }
    if (
      !calls.some(
        ({ method, args }) =>
          method === "from" &&
          correspondenceTable(args.at(0), "correspondenceFilers"),
      )
    ) {
      return false;
    }
    const whereCalls = calls.filter(({ method }) => method === "where");
    // Dynamic builders can replace an earlier WHERE. Do not combine
    // predicates from separate calls into an authorization proof.
    if (whereCalls.length !== 1) {
      return false;
    }
    const predicates = whereCalls.flatMap(({ args }) =>
      conjunctiveEqualities(args.at(0)),
    );
    if (
      !["organizationId", "workspaceId", "correspondenceId"].every((column) =>
        hasEquality(
          predicates,
          (node) => correspondenceColumn(node, "correspondenceFilers", column),
          (node) =>
            node.type !== "MemberExpression" ||
            resolveImport(context, node.object) === null,
        ),
      )
    ) {
      return false;
    }

    const joins = calls.filter(
      ({ method }) => method === "leftJoin" || method === "innerJoin",
    );
    const joinsActor = (table: string, column: string): boolean =>
      joins.some(
        ({ args }) =>
          userTableIdentity(args.at(0)) === identity &&
          hasEquality(
            conjunctiveEqualities(args.at(1)),
            (node) => correspondenceColumn(node, table, column),
            (node) => userIdColumn(node, identity),
          ),
      );
    if (joinsActor("correspondenceFilers", "filedByUserId")) {
      return true;
    }
    return (
      joinsActor("correspondenceAllowedSenders", "approvedBy") &&
      joins.some(
        ({ args }) =>
          correspondenceTable(args.at(0), "correspondenceAllowedSenders") &&
          hasEquality(
            conjunctiveEqualities(args.at(1)),
            (node) =>
              correspondenceColumn(
                node,
                "correspondenceFilers",
                "filedByAllowedSenderId",
              ),
            (node) =>
              correspondenceColumn(node, "correspondenceAllowedSenders", "id"),
          ),
      )
    );
  };

  const historicalRelationshipScoped = (chain: AstNode): boolean => {
    let foundUser = false;
    for (const node of everyNode(chain)) {
      const identity = userTableIdentity(node);
      if (identity === null) {
        continue;
      }
      foundUser = true;
      const query = fluentQueryContaining(node);
      if (query === null || !hasHistoricalRelationship(query, identity)) {
        return false;
      }
    }
    return foundUser;
  };

  return historicalRelationshipScoped;
};

export default eslintCompatPlugin({
  meta: { name: "security-guards" },
  rules: {
    // ── no-raw-filename-write ──────────────────────────────────
    "no-raw-filename-write": {
      meta: {
        type: "problem",
        messages: {
          rawFilename:
            "Use sanitizeFilename() before writing a request-supplied " +
            "filename. Raw strings may contain path traversal segments.",
        },
      },
      createOnce(context) {
        const isSanitizeFilenameCall = (call: AstNode): boolean => {
          const resolved = resolveImport(context, invokedCallee(call));
          return (
            resolved !== null &&
            SANITIZE_FILENAME_EXPORTS.has(resolved.imported) &&
            resolved.moduleId === SANITIZE_FILENAME_MODULE
          );
        };

        // The taint of the value a variable holds, from its declaration.
        const variableTaint = (
          variable: Variable,
          seen: Set<Variable>,
        ): Taint | null => {
          const nextSeen = new Set(seen);
          nextSeen.add(variable);
          for (const definition of variable.defs) {
            if (!isAstNode(definition.name)) {
              continue;
            }
            const { keys, root } = bindingPatternPath(definition.name);
            if (definition.type === "Parameter") {
              const taint =
                keys.length === 0
                  ? REQUEST_INPUT_NAMES.has(variable.name)
                    ? "request"
                    : null
                  : destructuredTaint(null, keys);
              if (taint !== null) {
                return taint;
              }
              continue;
            }
            const declarator = definition.node;
            const declaredPattern: unknown = isAstNode(declarator)
              ? declarator.id
              : null;
            if (
              definition.type !== "Variable" ||
              !isAstNode(declarator) ||
              declarator.type !== "VariableDeclarator" ||
              declaredPattern !== root
            ) {
              continue;
            }
            // `for (const part of body.parts)` binds each element of the
            // iterated value.
            const declaration = declarator.parent;
            const loop = isAstNode(declaration) ? declaration.parent : null;
            const iterated =
              isAstNode(loop) &&
              loop.type === "ForOfStatement" &&
              loop.left === declaration
                ? taintOf(loop.right, nextSeen) === "request"
                  ? "request"
                  : null
                : null;
            const base = iterated ?? taintOf(declarator.init, nextSeen);
            const taint =
              keys.length === 0 ? base : destructuredTaint(base, keys);
            if (taint !== null) {
              return taint;
            }
          }
          return null;
        };

        const taintOf = (
          node: unknown,
          seen = new Set<Variable>(),
        ): Taint | null => {
          const expression = unwrapExpression(node);
          if (!isAstNode(expression)) {
            return null;
          }
          switch (expression.type) {
            case "AwaitExpression":
              return taintOf(expression.argument, seen);
            case "MemberExpression": {
              const property = memberPropertyName(expression);
              const objectTaint = taintOf(expression.object, seen);
              if (objectTaint === "request") {
                return property !== null && RAW_NAME_PROPS.has(property)
                  ? "filename"
                  : "request";
              }
              if (
                objectTaint === null &&
                property !== null &&
                REQUEST_INPUT_PROPERTIES.has(property)
              ) {
                return "request";
              }
              return null;
            }
            case "CallExpression": {
              if (isSanitizeFilenameCall(expression)) {
                return null;
              }
              // A method of request input or of a raw filename keeps the
              // taint: `body.files.at(0)`, `file.name.trim()`. Any other
              // function handed a raw filename returns something built from
              // it; only the sanitizer's result is clean.
              const callee = unwrapExpression(expression.callee);
              const receiverTaint =
                callee?.type === "MemberExpression"
                  ? taintOf(callee.object, seen)
                  : null;
              if (receiverTaint !== null) {
                return receiverTaint;
              }
              return Array.isArray(expression.arguments) &&
                expression.arguments.some(
                  (argument) => taintOf(argument, seen) === "filename",
                )
                ? "filename"
                : null;
            }
            case "TemplateLiteral":
              return Array.isArray(expression.expressions) &&
                expression.expressions.some(
                  (part) => taintOf(part, seen) === "filename",
                )
                ? "filename"
                : null;
            case "BinaryExpression":
            case "LogicalExpression":
              return taintOf(expression.left, seen) === "filename" ||
                taintOf(expression.right, seen) === "filename"
                ? "filename"
                : null;
            case "ConditionalExpression":
              return taintOf(expression.consequent, seen) === "filename" ||
                taintOf(expression.alternate, seen) === "filename"
                ? "filename"
                : null;
            default:
              break;
          }
          if (!isIdentifierReference(expression)) {
            return null;
          }
          const variable = resolveVariable(context, expression);
          if (variable === null) {
            return REQUEST_INPUT_NAMES.has(expression.name) ? "request" : null;
          }
          if (seen.has(variable)) {
            return null;
          }
          const resolved = variableTaint(variable, seen);
          if (resolved !== null) {
            return resolved;
          }
          // An upload handed in under a conventional name (`file: File`)
          // stays request input even where its origin is out of view.
          return REQUEST_INPUT_NAMES.has(expression.name) ? "request" : null;
        };

        return {
          Property(node) {
            if (
              !isAstNode(node.parent) ||
              node.parent.type !== "ObjectExpression" ||
              (node.computed && !isStringLiteral(node.key))
            ) {
              return;
            }
            const key = getPropertyName(node.key);
            if (key === null || !FILENAME_SINK_KEYS.has(key)) {
              return;
            }
            if (taintOf(node.value) === "filename") {
              context.report({ node, messageId: "rawFilename" });
            }
          },
          AssignmentExpression(node) {
            const target = unwrapExpression(node.left);
            if (target?.type !== "MemberExpression") {
              return;
            }
            const key = memberPropertyName(target);
            if (key === null || !FILENAME_SINK_KEYS.has(key)) {
              return;
            }
            if (taintOf(node.right) === "filename") {
              context.report({ node, messageId: "rawFilename" });
            }
          },
        };
      },
    },

    // ── no-unsanitized-href ────────────────────────────────────
    "no-unsanitized-href": {
      meta: {
        type: "problem",
        messages: {
          unsanitizedHref:
            "Sanitize dynamic href values with sanitizeHref() at the anchor " +
            "sink to prevent javascript: XSS. Static http(s), mailto, " +
            "fragment, and relative literals are allowed.",
        },
      },
      createOnce(context) {
        // A sanitizer call, resolved through its binding rather than its
        // spelling: a local `const sanitizeHref = (url) => url` satisfies a
        // name check and renders whatever it was handed, so the callee must
        // resolve to the export of the module that owns the sanitizer.
        const isSanitizeHrefCall = (node: unknown): boolean => {
          if (!isAstNode(node) || node.type !== "CallExpression") {
            return false;
          }
          const resolved = resolveImport(context, invokedCallee(node));
          return (
            resolved !== null &&
            HREF_SANITIZERS.get(resolved.imported) === resolved.moduleId
          );
        };

        return {
          JSXAttribute(node) {
            // Only check href attributes
            if (
              node.name.type !== "JSXIdentifier" ||
              node.name.name !== "href"
            ) {
              return;
            }

            // Verify this is on an <a> element
            const opening = node.parent;
            if (opening.type !== "JSXOpeningElement") {
              return;
            }

            const tag = opening.name;
            if (tag.type !== "JSXIdentifier" || tag.name !== "a") {
              return;
            }

            // No value (href without assignment) — skip
            if (!node.value) {
              return;
            }

            // String literal: href="https://..." — check prefix
            if (node.value.type === "Literal") {
              if (isSafeStringLiteral(node.value)) {
                return;
              }
              // Non-safe static string (rare but suspicious)
              context.report({
                node,
                messageId: "unsanitizedHref",
              });
              return;
            }

            // JSX expression container: href={...}
            if (node.value.type !== "JSXExpressionContainer") {
              return;
            }

            const expr = node.value.expression;

            // Allow string literals inside expressions
            if (isSafeStringLiteral(expr)) {
              return;
            }

            // Allow template literals with safe prefixes
            if (isSafeTemplateLiteral(expr)) {
              return;
            }

            if (isSanitizeHrefCall(unwrapExpression(expr))) {
              return;
            }

            if (isIdentifier(expr, "undefined")) {
              return;
            }

            if (expr.type === "Literal" && expr.value === null) {
              return;
            }

            context.report({ node, messageId: "unsanitizedHref" });
          },
        };
      },
    },

    // ── no-unscoped-user-query ─────────────────────────────────
    "no-unscoped-user-query": {
      meta: {
        type: "problem",
        messages: {
          unscopedUserQuery:
            "A query reading the auth-schema 'user' table must reference " +
            "both member.userId and member.organizationId in the same query " +
            "chain, or join historical correspondence actors through a filer " +
            "relationship scoped to organization, matter and record. Use one " +
            "of those authorized relationships, or suppress " +
            "narrowly with evidence for another authorized scope.",
        },
        schema: [
          {
            type: "object",
            properties: {
              allowedFiles: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    file: { type: "string" },
                    reason: { type: "string", minLength: 1 },
                  },
                  required: ["file", "reason"],
                  additionalProperties: false,
                },
              },
            },
            additionalProperties: false,
          },
        ],
      },
      createOnce(context) {
        const reportedChains = new Set<AstNode>();
        let importsAuthSchema = false;

        const authSchemaExport = (node: AstNode): string | null => {
          const resolved = resolveImport(context, node);
          return resolved?.moduleId === AUTH_SCHEMA_MODULE
            ? resolved.imported
            : null;
        };

        const historicalRelationshipScoped =
          createHistoricalRelationshipScopeChecker(context);

        // The membership predicates a query chain carries, including those of
        // local constants it reads: a membership subquery built in the
        // statement above (`const members = tx.select().from(member)...`)
        // scopes the chain that joins it.
        const membershipPredicates = (
          chain: AstNode,
          scoped: Set<string>,
          seen: Set<Variable>,
        ): void => {
          for (const node of everyNode(chain)) {
            if (isIdentifierReference(node)) {
              const variable = resolveVariable(context, node);
              const initializer =
                variable === null || seen.has(variable)
                  ? null
                  : stableInitializer(variable);
              if (variable !== null && initializer !== null) {
                seen.add(variable);
                membershipPredicates(initializer, scoped, seen);
              }
              continue;
            }
            if (node.type !== "MemberExpression") {
              continue;
            }
            const property = memberPropertyName(node);
            if (
              (property === "userId" || property === "organizationId") &&
              isAstNode(node.object) &&
              authSchemaExport(node.object) === MEMBER_TABLE_EXPORT
            ) {
              scoped.add(property);
            }
          }
        };

        // A chain held by a local constant (a select map, an aliased table)
        // is judged by the queries that read the constant: it is scoped when
        // every one of them is.
        const isScopedChain = (
          chain: AstNode,
          seen: Set<Variable>,
        ): boolean => {
          const scoped = new Set<string>();
          membershipPredicates(chain, scoped, new Set());
          if (scoped.size === 2) {
            return true;
          }
          if (historicalRelationshipScoped(chain)) {
            return true;
          }
          const holder = chain.parent;
          if (
            !isAstNode(holder) ||
            holder.type !== "VariableDeclarator" ||
            holder.init !== chain ||
            !isIdentifierReference(holder.id)
          ) {
            return false;
          }
          const variable = resolveVariable(context, holder.id);
          if (
            variable === null ||
            seen.has(variable) ||
            stableInitializer(variable) === null
          ) {
            return false;
          }
          seen.add(variable);
          const readers = variable.references
            .filter((reference) => !reference.init)
            .map((reference): unknown => reference.identifier);
          return (
            readers.length > 0 &&
            readers.every(
              (reader) =>
                isAstNode(reader) &&
                isScopedChain(queryChainRoot(reader), seen),
            )
          );
        };

        const checkTableReference = (node: unknown): void => {
          if (
            !isAstNode(node) ||
            isInTypePosition(node) ||
            authSchemaExport(node) !== USER_TABLE_EXPORT
          ) {
            return;
          }
          const chain = queryChainRoot(node);
          if (isInsertTarget(node) && !readsInsertedRows(chain)) {
            return;
          }
          // `const users = user` only renames the table; its uses are the
          // queries.
          const holder = chain.parent;
          if (
            chain === node &&
            isAstNode(holder) &&
            holder.type === "VariableDeclarator" &&
            holder.init === node
          ) {
            return;
          }
          if (reportedChains.has(chain) || isScopedChain(chain, new Set())) {
            return;
          }
          reportedChains.add(chain);
          // The whole query is the unit a waiver covers, so the report sits
          // where the query starts.
          context.report({ node: chain, messageId: "unscopedUserQuery" });
        };

        return {
          before() {
            importsAuthSchema = false;
            reportedChains.clear();
            return !isFileIn(context, allowedUnscopedFiles(context.options));
          },
          // Static imports precede every use, so files that never load the
          // auth schema skip binding resolution entirely.
          ImportDeclaration(node) {
            if (
              canonicalModuleId(
                node.source.value,
                repoRelativeFilename(context),
              ) === AUTH_SCHEMA_MODULE
            ) {
              importsAuthSchema = true;
            }
          },
          Identifier(node) {
            if (!importsAuthSchema) {
              return;
            }
            const parent = node.parent;
            // The object of a member access is judged as part of it, so
            // `ns.user` resolves once through its MemberExpression.
            if (
              !isAstNode(parent) ||
              (parent.type === "MemberExpression" && parent.property === node)
            ) {
              return;
            }
            if (
              parent.type.startsWith("Import") ||
              parent.type.startsWith("Export") ||
              (parent.type === "VariableDeclarator" && parent.id === node) ||
              (parent.type === "Property" && parent.key === node)
            ) {
              return;
            }
            checkTableReference(node);
          },
          MemberExpression(node) {
            if (importsAuthSchema) {
              checkTableReference(node);
            }
          },
        };
      },
    },

    // ── require-secure-document-response ──────────────────────
    "require-secure-document-response": {
      meta: {
        type: "problem",
        messages: {
          directResponse:
            "Use secureDocumentResponse() for raw document bytes so the " +
            "security policy, MIME type, and disposition are applied by construction.",
          manualHeaders:
            "Handler modules must not assemble raw document security headers " +
            "manually. Use secureDocumentResponse().",
        },
      },
      createOnce(context) {
        let fileHandler = false;
        const downloadHeadersIdentifiers = new Set<string>();

        return {
          before() {
            fileHandler = repoRelativeFilename(context).includes(
              FILE_HANDLER_DIRECTORY,
            );
            downloadHeadersIdentifiers.clear();
          },
          ImportDeclaration(node) {
            if (
              canonicalModuleId(
                node.source.value,
                repoRelativeFilename(context),
              ) !== SECURITY_HEADERS_MODULE
            ) {
              return;
            }

            const manualSecurityHeadersImport = node.specifiers.find(
              (specifier) =>
                getImportedName(specifier) === RAW_DOCUMENT_SECURITY_HEADERS,
            );
            if (manualSecurityHeadersImport) {
              context.report({
                node: manualSecurityHeadersImport,
                messageId: "manualHeaders",
              });
            }
          },
          VariableDeclarator(node) {
            if (
              !isIdentifier(node.id) ||
              node.init?.type !== "NewExpression" ||
              !isIdentifier(node.init.callee, "Headers")
            ) {
              return;
            }

            const init = node.init.arguments.at(0);
            if (!init || init.type !== "ObjectExpression") {
              return;
            }
            if (hasAttachmentDisposition(init)) {
              downloadHeadersIdentifiers.add(node.id.name);
            }
          },
          NewExpression(node) {
            if (!isIdentifier(node.callee, "Response")) {
              return;
            }

            const body = node.arguments.at(0);
            if (!body || (body.type === "Literal" && body.value === null)) {
              return;
            }

            const init = node.arguments.at(1);
            const headers = init ? getHeadersObject(init) : null;
            const isDownloadResponse =
              fileHandler ||
              (headers?.type === "ObjectExpression" &&
                hasAttachmentDisposition(headers)) ||
              (headers?.type === "Identifier" &&
                downloadHeadersIdentifiers.has(headers.name));
            if (!isDownloadResponse) {
              return;
            }

            context.report({ node, messageId: "directResponse" });
          },
        };
      },
    },
  },
});
