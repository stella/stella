// Security guard lint rules.
//
// Catches common security anti-patterns at lint time:
//   1. no-raw-filename-write  — raw user input in fileName properties
//   2. no-unsanitized-href    — dynamic href without sanitization
//   3. no-unscoped-user-query — user table import without member scoping

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

const isSanitizeHrefCall = (node): boolean =>
  node.type === "CallExpression" &&
  node.callee.type === "Identifier" &&
  node.callee.name === "sanitizeHref";

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

export default {
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
      create(context) {
        return {
          Property(node) {
            // Only check property assignments named "fileName"
            const keyName =
              node.key.type === "Identifier"
                ? node.key.name
                : node.key.type === "Literal" &&
                    typeof node.key.value === "string"
                  ? node.key.value
                  : null;

            if (keyName !== "fileName") {
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
            if (value.type === "Identifier" && value.name === "undefined") {
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
            if (
              value.type === "CallExpression" &&
              value.callee.type === "Identifier" &&
              value.callee.name === "sanitizeFilename"
            ) {
              return;
            }

            // Allow .value accessors (resolvedName.value, fileName.value)
            // These come from Result unwrapping after sanitization.
            if (
              value.type === "MemberExpression" &&
              !value.computed &&
              value.property.type === "Identifier" &&
              value.property.name === "value"
            ) {
              return;
            }

            // Allow variables whose name indicates prior sanitization
            if (
              value.type === "Identifier" &&
              /sanitize/i.test(value.name)
            ) {
              return;
            }

            // Now check for the dangerous patterns:
            // file.name, body.name, body.fileName, part.filename, query.name
            if (value.type !== "MemberExpression" || value.computed) {
              return;
            }

            const obj = value.object;
            const prop = value.property;

            if (
              obj.type !== "Identifier" ||
              prop.type !== "Identifier"
            ) {
              return;
            }

            if (
              RAW_INPUT_OBJECTS.has(obj.name) &&
              RAW_NAME_PROPS.has(prop.name)
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
      create(context) {
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
            if (
              !opening ||
              opening.type !== "JSXOpeningElement"
            ) {
              return;
            }

            const tag = opening.name;
            if (
              tag.type !== "JSXIdentifier" ||
              tag.name !== "a"
            ) {
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
      create(context) {
        let userImportNode = null;
        let hasMemberImport = false;

        return {
          ImportDeclaration(node) {
            if (node.source.value !== AUTH_SCHEMA_MODULE) {
              return;
            }

            for (const spec of node.specifiers) {
              if (spec.type !== "ImportSpecifier") {
                continue;
              }

              const importedName =
                spec.imported.type === "Identifier"
                  ? spec.imported.name
                  : spec.imported.value;

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
  },
};
