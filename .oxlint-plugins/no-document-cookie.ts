// Forbid assignment to `document.cookie`.
//
// AGENTS.md: "No direct `document.cookie` assignment." Writing the cookie
// jar directly bypasses attribute defaults (`Secure`, `SameSite`, `Path`)
// and is easy to get subtly wrong (e.g. clobbering unrelated cookies by
// omitting `path`/`domain` on delete). Route cookie writes through a
// sanctioned cookie utility instead.
//
// Flags:
//   document.cookie = "theme=dark";
//   document.cookie += "; foo=bar";
//   globalThis.document.cookie = value;
//   window.document.cookie = value;
//
// Allows:
//   const raw = document.cookie;               // reads are fine
//   const has = document.cookie.includes("x");  // reads are fine
//   cookieStore.set("theme", "dark");           // different API entirely

import { isIdentifier } from "./utils.ts";

const DOCUMENT_HOSTS = new Set(["document", "globalThis", "window", "self"]);

// Match `document.cookie` or `globalThis.document.cookie` /
// `window.document.cookie` / `self.document.cookie`.
const isDocumentCookieAccess = (node: unknown): boolean => {
  if (
    typeof node !== "object" ||
    node === null ||
    (node as { type?: unknown }).type !== "MemberExpression"
  ) {
    return false;
  }

  const member = node as {
    computed?: unknown;
    object?: unknown;
    property?: unknown;
  };

  if (member.computed !== false || !isIdentifier(member.property, "cookie")) {
    return false;
  }

  const object = member.object;
  if (isIdentifier(object, "document")) {
    return true;
  }

  // globalThis.document.cookie / window.document.cookie / self.document.cookie
  if (
    typeof object !== "object" ||
    object === null ||
    (object as { type?: unknown }).type !== "MemberExpression"
  ) {
    return false;
  }
  const outer = object as {
    computed?: unknown;
    object?: unknown;
    property?: unknown;
  };
  return (
    outer.computed === false &&
    isIdentifier(outer.property, "document") &&
    isIdentifier(outer.object) &&
    DOCUMENT_HOSTS.has((outer.object as { name: string }).name)
  );
};

export default {
  meta: { name: "no-document-cookie" },
  rules: {
    "no-document-cookie": {
      meta: {
        type: "problem",
        messages: {
          noDocumentCookieAssignment:
            "Do not assign to `document.cookie` directly; it bypasses " +
            "Secure/SameSite/Path defaults and can clobber unrelated " +
            "cookies. Route cookie writes through a sanctioned cookie " +
            "utility instead.",
        },
      },
      create(context) {
        return {
          AssignmentExpression(node) {
            if (!isDocumentCookieAccess(node.left)) {
              return;
            }
            context.report({
              node,
              messageId: "noDocumentCookieAssignment",
            });
          },
        };
      },
    },
  },
};
