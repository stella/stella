// Require `dir` when rendering a user-provided NAME as an element's text,
// so it isn't bidi-reordered under an RTL UI.
//
// A Latin name with trailing neutral characters inside the RTL UI gets
// reordered — e.g. "Tatra Motor a.s." renders as ".Tatra Motor a.s" —
// unless the element resolves direction from its own content. The fix is
// `dir="auto"` on the element (or wrapping the value in <bdi>).
//
// Flagged: an element whose only child is `{<expr>.<nameProp>}` (a known
// user-content name property) and which has no `dir` attribute.
// Allowed: a `dir` attribute is present, the element is <bdi>/<bdo>, or the
// value is anything other than a bare member access to a name property.

const NAME_PROPS = new Set([
  "displayName",
  "fullName",
  "firstName",
  "lastName",
  "clientName",
  "contactName",
  "organizationName",
  "partyName",
  "authorName",
  "workspaceName",
  "matterName",
  "entityName",
  "fileName",
  "folderName",
]);

const SELF_ISOLATING = new Set(["bdi", "bdo"]);

const hasDirAttr = (opening) =>
  opening.attributes.some(
    (attr) =>
      attr.type === "JSXAttribute" &&
      attr.name?.type === "JSXIdentifier" &&
      attr.name.name === "dir",
  );

const meaningfulChildren = (children) =>
  children.filter(
    (child) => !(child.type === "JSXText" && child.value.trim().length === 0),
  );

const isNameExpr = (expr) =>
  (expr.type === "MemberExpression" ||
    expr.type === "OptionalMemberExpression") &&
  expr.property.type === "Identifier" &&
  NAME_PROPS.has(expr.property.name);

export default {
  meta: { name: "require-dir-on-rendered-name" },
  rules: {
    "require-dir-on-rendered-name": {
      meta: {
        type: "problem",
        messages: {
          missingDir:
            "User-provided name rendered without bidi isolation reorders " +
            'under RTL (e.g. ".Tatra Motor a.s"). Add dir="auto" to the ' +
            "element (or wrap the value in <bdi>).",
          missingBidi:
            "User-provided name rendered alongside other content reorders " +
            "under RTL; wrap it in <bdi> (dir on the parent would also " +
            "reorder its siblings).",
        },
      },
      create(context) {
        return {
          JSXElement(node) {
            const opening = node.openingElement;
            if (
              opening.name.type === "JSXIdentifier" &&
              SELF_ISOLATING.has(opening.name.name)
            ) {
              return;
            }
            const kids = meaningfulChildren(node.children);
            const nameKids = kids.filter(
              (child) =>
                child.type === "JSXExpressionContainer" &&
                isNameExpr(child.expression),
            );
            if (nameKids.length === 0) {
              return;
            }
            // Sole child: dir="auto" on the element isolates it.
            if (kids.length === 1) {
              if (!hasDirAttr(opening)) {
                context.report({ node: opening, messageId: "missingDir" });
              }
              return;
            }
            // Mixed children: dir on the element would reorder the siblings too,
            // so the name itself must be wrapped in <bdi>.
            for (const child of nameKids) {
              context.report({ node: child, messageId: "missingBidi" });
            }
          },
        };
      },
    },
  },
};
