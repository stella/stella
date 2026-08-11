// Security guard lint rules.
//
// Catches common security anti-patterns at lint time:
//   1. no-raw-filename-write  — raw user input in fileName properties
//   2. no-unsanitized-href    — dynamic href without sanitization
//   3. no-unscoped-user-query — user table import without member scoping
//   4. require-secure-document-response — direct raw document Response
//      construction outside the typed security boundary

import { eslintCompatPlugin, type Ranged } from "@oxlint/plugins";

import {
  getImportedName,
  getPropertyName,
  isCallTo,
  isIdentifier,
} from "./utils.ts";

// ── Rule 1: no-raw-filename-write ──────────────────────────────
//
// User-supplied filenames can contain path traversal segments
// (../../etc/passwd) or control characters. All values assigned
// to a `fileName` property must pass through `sanitizeFilename`
// before reaching storage or downstream logic.
//
// Safe patterns (not flagged):
//   fileName: sanitizeFilename(file.name)
//   fileName: sanitizedFileName          (variable from prior call)
//   fileName: resolvedName.value         (.value accessor)
//   fileName: content.fileName           (DB read-back)
//   fileName: true                       (Drizzle column selector)
//   fileName: null / undefined
//   fileName: "literal.pdf"
//
// Flagged:
//   fileName: file.name       (raw File.name from upload)
//   fileName: body.name       (raw request body)
//   fileName: body.fileName   (raw request body, camelCase)
//   fileName: part.filename   (raw multipart part)

// Objects whose .name / .filename property is raw user input
const RAW_INPUT_OBJECTS = new Set(["file", "body", "query", "part"]);

// Property names on those objects that carry raw filenames
const RAW_NAME_PROPS = new Set(["name", "filename", "fileName"]);

// ── Rule 2: no-unsanitized-href ────────────────────────────────
//
// Passing unsanitized dynamic values to <a href={...}> enables
// javascript: XSS. Flag MemberExpression values (e.g. node.href,
// data.url) that are not wrapped in sanitizeHref().
//
// Safe patterns (not flagged):
//   href="https://..."                  (string literal)
//   href={`/path/${id}`}                (template literal)
//   href={sanitizeHref(url)}            (sanitizer call)
//   href={localVariable}                (simple Identifier — props, computed)
//   href={condition ? a : b}            (ternary)
//   href={getUrl()}                     (function call)
//
// Flagged:
//   href={node.href}       (data object property access)
//   href={item.url}        (data object property access)

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
// Importing the `user` table from auth-schema without also
// importing `member` suggests the query may not be scoped
// by organization membership. While workspace-scoped handlers
// already filter by workspaceId, importing member is a safety
// net that ensures organization-level scoping is available.
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
        return {
          Property(node) {
            // Only check property assignments named "fileName"
            if (getPropertyName(node.key) !== "fileName") {
              return;
            }

            const value = node.value;

            // Allow shorthand { fileName } (key === value, just passing through)
            if (node.shorthand) {
              return;
            }

            // Allow boolean literals (Drizzle column selectors: { fileName: true })
            if (value.type === "Literal" && typeof value.value === "boolean") {
              return;
            }

            // Allow null / undefined
            if (value.type === "Literal" && value.value === null) {
              return;
            }
            if (isIdentifier(value, "undefined")) {
              return;
            }

            // Allow string literals ("report.pdf")
            if (value.type === "Literal" && typeof value.value === "string") {
              return;
            }

            // Allow template literals
            if (value.type === "TemplateLiteral") {
              return;
            }

            // Allow sanitizeFilename() calls
            if (isCallTo(value, "sanitizeFilename")) {
              return;
            }

            // Allow .value accessors (resolvedName.value, fileName.value)
            // These come from Result unwrapping after sanitization.
            if (
              value.type === "MemberExpression" &&
              !value.computed &&
              isIdentifier(value.property, "value")
            ) {
              return;
            }

            // Allow variables whose name indicates prior sanitization
            if (isIdentifier(value) && /sanitize/i.test(value.name)) {
              return;
            }

            // Now check for the dangerous patterns:
            // file.name, body.name, body.fileName, part.filename, query.name
            if (value.type !== "MemberExpression" || value.computed) {
              return;
            }

            if (!isIdentifier(value.object) || !isIdentifier(value.property)) {
              return;
            }

            if (
              RAW_INPUT_OBJECTS.has(value.object.name) &&
              RAW_NAME_PROPS.has(value.property.name)
            ) {
              context.report({
                node,
                messageId: "rawFilename",
              });
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
            "Sanitize dynamic href values with " +
            "sanitizeHref() to prevent javascript: XSS. " +
            "Static http(s) URLs and relative paths are " +
            "allowed.",
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
            if (!opening || opening.type !== "JSXOpeningElement") {
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

            // Allow simple Identifiers (props, locally computed vars).
            // These are typically safe because they come from
            // component props or local computation, not raw data.
            if (expr.type === "Identifier") {
              return;
            }

            // Allow ternary / logical expressions (computed values)
            if (
              expr.type === "ConditionalExpression" ||
              expr.type === "LogicalExpression"
            ) {
              return;
            }

            // Allow function/method calls (e.g. getUrl(), buildHref())
            if (expr.type === "CallExpression") {
              return;
            }

            // Flag MemberExpression (node.href, item.url, data.link)
            // These access properties on data objects and may carry
            // unsanitized user/external content.
            if (expr.type === "MemberExpression") {
              context.report({
                node,
                messageId: "unsanitizedHref",
              });
            }
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
            "Importing 'user' without 'member' from " +
            "auth-schema may allow cross-org data access. " +
            "Import 'member' and join on organizationId " +
            "to scope user queries.",
        },
      },
      createOnce(context) {
        let userImportNode: Ranged | null = null;
        let hasMemberImport = false;

        return {
          before() {
            userImportNode = null;
            hasMemberImport = false;
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
                hasMemberImport = true;
              }
            }
          },

          "Program:exit"() {
            if (userImportNode && !hasMemberImport) {
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
