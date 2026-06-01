// Require event handlers on ref-tracked containers to be wrapped in
// `containedHandler` from `@stll/ui/hooks/use-contained-handler`.
//
// React forwards synthetic events through the parent React tree even when
// descendants are rendered via createPortal. A handler attached to a
// container element therefore receives events from any portaled popup
// (Dialog, Combobox, Tooltip) the container is a React ancestor of —
// usually unintentionally. The historical Folio bug here was a toolbar
// that called `e.preventDefault()` on every non-INPUT mousedown to keep
// editor focus; the moment a Combobox dropdown was rendered inside the
// toolbar's React subtree, its item clicks were silently swallowed.
//
// This rule flags any JSX element that has both:
//   - a `ref={<Identifier>}` attribute
//   - one or more event-handler attributes from WATCHED_HANDLERS
// where the handler value is not a direct `containedHandler(refIdent, …)`
// call. The containedHandler helper short-circuits when the event target
// is outside the ref's DOM subtree.
//
// Flagged:
//   <div ref={barRef} onMouseDown={handleBarMouseDown}>...</div>
//   <div ref={barRef} onMouseDown={(e) => { e.preventDefault(); }}>...</div>
//
// Allowed:
//   <div
//     ref={barRef}
//     onMouseDown={containedHandler(barRef, handleBarMouseDown)}
//   >
//   <div ref={barRef} onMouseDown={undefined}>...</div>
//   <div ref={barRef}>...</div>                     // no watched handler
//   <div onMouseDown={handleX}>...</div>            // no ref
//
// To intentionally receive bubbled events from portaled descendants,
// suppress per-line with `// oxlint-disable-next-line require-contained-handler`
// and explain why.

// Implementation note: oxlint's custom-plugin runtime does not deliver
// JSX-specific visitor keys (JSXOpeningElement, JSXAttribute, …) to
// `create()` return objects. We therefore walk the file from `Program`
// and recurse manually. JSX attribute names use `JSXIdentifier`, not
// the plain `Identifier` that shared utilities recognise; we read
// `attr.name.name` directly.

const WATCHED_HANDLERS = new Set([
  "onMouseDown",
  "onMouseUp",
  "onClick",
  "onPointerDown",
  "onPointerUp",
  "onFocus",
  "onBlur",
  "onTouchStart",
  "onTouchEnd",
]);

const HELPER_NAME = "containedHandler";

const jsxAttrName = (attr) =>
  attr?.name?.type === "JSXIdentifier" && typeof attr.name.name === "string"
    ? attr.name.name
    : null;

const isPlainIdentifier = (node, name) =>
  node?.type === "Identifier" &&
  typeof node.name === "string" &&
  (name === undefined || node.name === name);

const expressionFromAttribute = (attr) => {
  if (!attr || !attr.value) {
    return null;
  }
  if (attr.value.type === "JSXExpressionContainer") {
    return attr.value.expression;
  }
  return null;
};

// Note: we deliberately do not assert that `containedHandler(refIdent, …)`
// receives the same identifier used in the JSX `ref={…}` attribute.
// Callback refs (`ref={setRowRef}` where `setRowRef` forwards to a real
// useRef) are common in this codebase, and the wrapping should be tied
// to the underlying useRef, not the callback. The check still ensures the
// handler is structurally a containedHandler call.
const isSafeHandlerValue = (expr) => {
  if (!expr) {
    return true;
  }
  if (isPlainIdentifier(expr, "undefined")) {
    return true;
  }
  if (expr.type === "Literal" && expr.value === null) {
    return true;
  }
  if (expr.type === "CallExpression") {
    return isPlainIdentifier(expr.callee, HELPER_NAME);
  }
  if (expr.type === "ConditionalExpression") {
    return (
      isSafeHandlerValue(expr.consequent) && isSafeHandlerValue(expr.alternate)
    );
  }
  if (expr.type === "LogicalExpression") {
    return isSafeHandlerValue(expr.left) && isSafeHandlerValue(expr.right);
  }
  return false;
};

const findRefIdentifierAmongAttributes = (attributes) => {
  if (!Array.isArray(attributes)) {
    return null;
  }
  for (const attr of attributes) {
    if (jsxAttrName(attr) !== "ref") {
      continue;
    }
    const expr = expressionFromAttribute(attr);
    if (expr?.type === "Identifier" && typeof expr.name === "string") {
      return expr.name;
    }
    return null;
  }
  return null;
};

export default {
  meta: { name: "require-contained-handler" },
  rules: {
    "require-contained-handler": {
      meta: {
        type: "problem",
        messages: {
          requireContainedHandler:
            "`{{handler}}` on a ref-tracked element must be wrapped with " +
            "`containedHandler({{ref}}, …)` from " +
            "`@stll/ui/hooks/use-contained-handler`. Otherwise, events " +
            "bubbled in from portaled descendants (Dialog, Combobox, etc.) " +
            "will trigger this handler.",
        },
      },
      create(context) {
        const checkOpening = (opening) => {
          const refName = findRefIdentifierAmongAttributes(opening.attributes);
          if (refName === null) {
            return;
          }
          for (const attr of opening.attributes ?? []) {
            const attrName = jsxAttrName(attr);
            if (attrName === null || !WATCHED_HANDLERS.has(attrName)) {
              continue;
            }
            const handlerExpr = expressionFromAttribute(attr);
            if (handlerExpr === null) {
              continue;
            }
            if (isSafeHandlerValue(handlerExpr)) {
              continue;
            }
            context.report({
              node: attr,
              messageId: "requireContainedHandler",
              data: { handler: attrName, ref: refName },
            });
          }
        };

        const walk = (node) => {
          if (node === null || typeof node !== "object") {
            return;
          }
          if (Array.isArray(node)) {
            for (const child of node) {
              walk(child);
            }
            return;
          }
          if (typeof node.type !== "string") {
            return;
          }
          if (node.type === "JSXOpeningElement") {
            checkOpening(node);
          }
          for (const key of Object.keys(node)) {
            if (key === "parent" || key === "loc" || key === "range") {
              continue;
            }
            walk(node[key]);
          }
        };

        return {
          Program(node) {
            walk(node);
          },
        };
      },
    },
  },
};
