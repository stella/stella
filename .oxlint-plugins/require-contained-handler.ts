import { eslintCompatPlugin } from "@oxlint/plugins";

// Require event handlers on ref-tracked containers to be wrapped in a
// containment helper from `@stll/ui/hooks/use-contained-handler`.
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
// where the handler value is not a direct containment-helper call. Both
// helpers short-circuit when the event target is outside the element's DOM
// subtree; `containedEventHandler` uses `currentTarget` and needs no ref.
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

// `onBlur` is intentionally absent: blur's `target` is the element losing
// focus, not the new focus destination, so the DOM-containment check the
// helper performs cannot answer "did focus leave for a portaled child?".
// Authors needing that signal should test `event.relatedTarget` inline.
const WATCHED_HANDLERS = new Set([
  "onMouseDown",
  "onMouseUp",
  "onClick",
  "onContextMenu",
  "onPointerDown",
  "onPointerUp",
  "onFocus",
  "onTouchStart",
  "onTouchEnd",
]);

const PORTAL_POPUPS = new Set([
  "ComboboxPopup",
  "DialogContent",
  "DialogPopup",
  "MenuPopup",
  "PopoverContent",
  "PopoverPanel",
  "PopoverPopup",
  "TooltipPopup",
]);

const INTERACTIVE_ELEMENTS = new Set(["a", "button", "Button", "Link"]);

// Void/leaf form elements cannot have React-tree descendants, so a
// portaled popup can never bubble through them. Wrapping their handlers
// would be inert at best and obscure intent at worst. The rule treats
// them as out of scope even when they carry a ref (e.g. for autofocus).
const LEAF_ELEMENTS = new Set([
  "input",
  "textarea",
  "select",
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

const HELPER_NAMES = new Set(["containedEventHandler", "containedHandler"]);

const jsxAttrName = (attr) =>
  attr?.name?.type === "JSXIdentifier" && typeof attr.name.name === "string"
    ? attr.name.name
    : null;

const jsxElementName = (node) =>
  node?.type === "JSXIdentifier" && typeof node.name === "string"
    ? node.name
    : null;

const openingHasInteractiveHandler = (opening) =>
  (opening.attributes ?? []).some((attr) => {
    const attrName = jsxAttrName(attr);
    if (attrName === null || !WATCHED_HANDLERS.has(attrName)) {
      return false;
    }
    return !isSafeHandlerValue(expressionFromAttribute(attr));
  });

const interactiveAncestorName = (opening) => {
  let current = opening.parent?.parent;
  while (current && typeof current === "object") {
    if (current.type === "JSXElement") {
      const ancestorOpening = current.openingElement;
      const ancestorName = jsxElementName(ancestorOpening?.name);
      if (
        ancestorName !== null &&
        (INTERACTIVE_ELEMENTS.has(ancestorName) ||
          openingHasInteractiveHandler(ancestorOpening))
      ) {
        return ancestorName;
      }
    }
    current = current.parent;
  }
  return null;
};

const isPlainIdentifier = (node, name?: string) =>
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
// handler is structurally a recognized containment-helper call.
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
    return isPlainIdentifier(expr.callee) && HELPER_NAMES.has(expr.callee.name);
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

// Reconstruct a dotted path from a MemberExpression so reports can echo
// the actual ref expression (`refs.container`) rather than a placeholder.
// Falls back to `null` if any segment isn't a static identifier (e.g. a
// computed index like `refs[name]`).
const memberExpressionPath = (node) => {
  if (node?.type !== "MemberExpression" || node.computed === true) {
    return null;
  }
  if (node.property?.type !== "Identifier") {
    return null;
  }
  const head =
    node.object?.type === "Identifier"
      ? node.object.name
      : memberExpressionPath(node.object);
  return head === null ? null : `${head}.${node.property.name}`;
};

// Find the `ref={…}` attribute and return a display string for the ref
// expression. Returns `null` only when there is no ref attribute at all
// — every other shape (Identifier, MemberExpression, callback, merged
// refs) yields a string so the rule still enforces on the element.
const findRefDisplayName = (attributes) => {
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
    if (expr?.type === "MemberExpression") {
      return memberExpressionPath(expr) ?? "ref";
    }
    return "ref";
  }
  return null;
};

export default eslintCompatPlugin({
  meta: { name: "require-contained-handler" },
  rules: {
    "no-portal-under-interactive-ancestor": {
      meta: {
        type: "problem",
        messages: {
          portalUnderInteractive:
            "`<{{popup}}>` portals its events through the React tree but is " +
            "nested under interactive `<{{ancestor}}>`. Hoist the popup/root " +
            "outside that interactive subtree so popup events cannot trigger " +
            "navigation or parent actions.",
        },
      },
      createOnce(context) {
        return {
          JSXOpeningElement(opening) {
            const popupName = jsxElementName(opening.name);
            if (popupName === null || !PORTAL_POPUPS.has(popupName)) {
              return;
            }
            const ancestorName = interactiveAncestorName(opening);
            if (ancestorName === null) {
              return;
            }
            context.report({
              node: opening,
              messageId: "portalUnderInteractive",
              data: { ancestor: ancestorName, popup: popupName },
            });
          },
        };
      },
    },
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
      createOnce(context) {
        const checkOpening = (opening) => {
          const elementName =
            opening.name?.type === "JSXIdentifier" ? opening.name.name : null;
          if (
            typeof elementName === "string" &&
            LEAF_ELEMENTS.has(elementName)
          ) {
            return;
          }
          const refName = findRefDisplayName(opening.attributes);
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

        return {
          JSXOpeningElement: checkOpening,
        };
      },
    },
  },
});
