// Security guard lint rules.
//
// Catches common security anti-patterns at lint time:
//   1. no-raw-filename-write  — raw user input in fileName properties
//   2. no-unsanitized-href    — dynamic href without sanitization
//   3. no-unscoped-user-query — user table import without member scoping
//   4. require-secure-document-response — direct raw document Response
//      construction outside the typed security boundary

import {
  eslintCompatPlugin,
  type ESTree,
  type Ranged,
  type Scope,
  type Variable,
} from "@oxlint/plugins";

import {
  getImportedName,
  getPropertyName,
  isAstNode,
  isCallTo,
  isIdentifier,
  unwrapExpression,
} from "./utils.ts";

// ── Rule 1: no-raw-filename-write ──────────────────────────────
//
// User-supplied filenames can contain path traversal segments
// (../../etc/passwd) or control characters. All values assigned
// to a `fileName` property must pass through `sanitizeFilename`
// before reaching storage or downstream logic. Stable local aliases and
// string composition remain tainted, so a temporary variable cannot launder
// `file.name` before the sink.
//
// Safe patterns (not flagged):
//   fileName: sanitizeFilename(file.name)
//   fileName: content.fileName           (DB read-back)
//   fileName: true                       (Drizzle column selector)
//   fileName: null / undefined
//   fileName: "literal.pdf"
//
// Flagged:
//   fileName: file.name       (raw File.name from upload)
//   const raw = file.name; { fileName: raw }
//   fileName: body.name       (raw request body)
//   fileName: body.fileName   (raw request body, camelCase)
//   fileName: part.filename   (raw multipart part)

// Objects whose .name / .filename property is raw user input
const RAW_INPUT_OBJECTS = new Set(["file", "body", "query", "part"]);

// Property names on those objects that carry raw filenames
const RAW_NAME_PROPS = new Set(["name", "filename", "fileName"]);

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

const isSanitizeHrefCall = (node): boolean => isCallTo(node, "sanitizeHref");

// ── Rule 3: no-unscoped-user-query ─────────────────────────────
//
// Importing the `user` table from auth-schema requires an organization-scoped
// membership relation in the same file. Merely importing `member` is not
// proof: the query must reference both member.userId and
// member.organizationId. Alternative authorized scopes require a narrow
// suppression with evidence.
//
// Only applies to handler files (configured via overrides).

const AUTH_SCHEMA_MODULE = "@/api/db/auth-schema";

// ── Rule 4: require-secure-document-response ──────────────────
//
// Production file handlers and attachment responses return privileged bytes
// through the global Response constructor. Null-body status responses carry no
// document data; every download must use the typed constructor that owns its
// security headers, MIME type, disposition, and sanitized filename.

const RAW_DOCUMENT_SECURITY_HEADERS = "RAW_DOCUMENT_RESPONSE_SECURITY_HEADERS";
const SECURITY_HEADERS_MODULE = "@/api/lib/security-headers";

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

const isFileHandler = (context): boolean =>
  (context.filename ?? context.getFilename?.() ?? "")
    .replaceAll("\\", "/")
    .includes("/apps/api/src/handlers/files/");

export default eslintCompatPlugin({
  meta: { name: "security-guards" },
  rules: {
    // ── no-raw-filename-write ──────────────────────────────────
    "no-raw-filename-write": {
      meta: {
        type: "problem",
        messages: {
          rawFilename:
            "Use sanitizeFilename() before assigning to " +
            "fileName. Raw strings may contain path " +
            "traversal segments.",
        },
      },
      createOnce(context) {
        const resolveVariable = (
          identifier: ESTree.IdentifierReference,
        ): Variable | null => {
          let scope: Scope | null = context.sourceCode.getScope(identifier);
          while (scope !== null) {
            const variable = scope.set.get(identifier.name);
            if (variable !== undefined) {
              return variable;
            }
            scope = scope.upper;
          }
          return null;
        };

        const isRawDestructuredFilename = (
          declaration: ESTree.VariableDeclarator,
          identifierName: string,
        ): boolean => {
          const init = unwrapExpression(declaration.init);
          if (
            !isIdentifier(init) ||
            !RAW_INPUT_OBJECTS.has(init.name) ||
            declaration.id.type !== "ObjectPattern"
          ) {
            return false;
          }

          return declaration.id.properties.some((property) => {
            if (property.type !== "Property") {
              return false;
            }
            const boundValue =
              property.value.type === "AssignmentPattern"
                ? property.value.left
                : property.value;
            return (
              RAW_NAME_PROPS.has(getPropertyName(property.key) ?? "") &&
              isIdentifier(boundValue, identifierName)
            );
          });
        };

        const isRawFilenameExpression = (
          node: unknown,
          seenVariables = new Set<Variable>(),
        ): boolean => {
          const expression = unwrapExpression(node);
          if (!isAstNode(expression)) {
            return false;
          }
          if (isCallTo(expression, "sanitizeFilename")) {
            return false;
          }
          if (
            expression.type === "MemberExpression" &&
            expression.computed === false &&
            isIdentifier(expression.object) &&
            isIdentifier(expression.property) &&
            RAW_INPUT_OBJECTS.has(expression.object.name) &&
            RAW_NAME_PROPS.has(expression.property.name)
          ) {
            return true;
          }
          if (
            expression.type === "TemplateLiteral" &&
            Array.isArray(expression.expressions)
          ) {
            return expression.expressions.some((part) =>
              isRawFilenameExpression(part, seenVariables),
            );
          }
          if (
            expression.type === "BinaryExpression" ||
            expression.type === "LogicalExpression"
          ) {
            return (
              isRawFilenameExpression(expression.left, seenVariables) ||
              isRawFilenameExpression(expression.right, seenVariables)
            );
          }
          if (expression.type === "ConditionalExpression") {
            return (
              isRawFilenameExpression(expression.consequent, seenVariables) ||
              isRawFilenameExpression(expression.alternate, seenVariables)
            );
          }
          if (!isIdentifier(expression)) {
            return false;
          }

          const variable = resolveVariable(expression);
          if (variable === null || seenVariables.has(variable)) {
            return false;
          }

          const nextSeenVariables = new Set(seenVariables);
          nextSeenVariables.add(variable);
          return variable.defs.some((definition) => {
            const declaration = definition.node;
            if (declaration.type !== "VariableDeclarator") {
              return false;
            }
            return (
              isRawDestructuredFilename(declaration, expression.name) ||
              isRawFilenameExpression(declaration.init, nextSeenVariables)
            );
          });
        };

        return {
          Property(node) {
            // Only check property assignments named "fileName"
            if (getPropertyName(node.key) !== "fileName") {
              return;
            }

            if (isRawFilenameExpression(node.value)) {
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

            // Allow sanitizeHref() calls
            if (isSanitizeHrefCall(expr)) {
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
            "Queries importing 'user' from auth-schema must reference both " +
            "member.userId and member.organizationId in the same file. " +
            "Join through organization membership, or suppress narrowly " +
            "with evidence for another authorized scope.",
        },
      },
      createOnce(context) {
        let userImportNode: Ranged | null = null;
        let memberLocalName: string | null = null;
        let memberImportVariable: Variable | null = null;
        let hasMemberUserIdReference = false;
        let hasMemberOrganizationIdReference = false;

        const resolveVariable = (
          identifier: ESTree.IdentifierReference,
        ): Variable | null => {
          let scope: Scope | null = context.sourceCode.getScope(identifier);
          while (scope !== null) {
            const variable = scope.set.get(identifier.name);
            if (variable !== undefined) {
              return variable;
            }
            scope = scope.upper;
          }
          return null;
        };

        return {
          before() {
            userImportNode = null;
            memberLocalName = null;
            memberImportVariable = null;
            hasMemberUserIdReference = false;
            hasMemberOrganizationIdReference = false;
          },
          ImportDeclaration(node) {
            if (node.source.value !== AUTH_SCHEMA_MODULE) {
              return;
            }

            for (const spec of node.specifiers) {
              const importedName = getImportedName(spec);
              if (importedName === null) {
                continue;
              }

              if (importedName === "user" && !userImportNode) {
                userImportNode = spec;
              }
              if (importedName === "member") {
                memberLocalName = spec.local.name;
                memberImportVariable =
                  context.sourceCode.getDeclaredVariables(spec).at(0) ?? null;
              }
            }
          },
          MemberExpression(node) {
            if (
              memberLocalName === null ||
              node.computed ||
              !isIdentifier(node.object, memberLocalName) ||
              !isIdentifier(node.property) ||
              resolveVariable(node.object) !== memberImportVariable
            ) {
              return;
            }

            if (node.property.name === "userId") {
              hasMemberUserIdReference = true;
            }
            if (node.property.name === "organizationId") {
              hasMemberOrganizationIdReference = true;
            }
          },

          "Program:exit"() {
            if (
              userImportNode &&
              (!hasMemberUserIdReference || !hasMemberOrganizationIdReference)
            ) {
              context.report({
                node: userImportNode,
                messageId: "unscopedUserQuery",
              });
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
            fileHandler = isFileHandler(context);
            downloadHeadersIdentifiers.clear();
          },
          ImportDeclaration(node) {
            if (node.source.value !== SECURITY_HEADERS_MODULE) {
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
