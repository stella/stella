// Require BidiText/UserText when rendering a user-provided identifier as an
// element's text, so it isn't bidi-reordered under an RTL UI.
//
// A Latin name with trailing neutral characters inside the RTL UI gets
// reordered — e.g. "Tatra Motor a.s." renders as ".Tatra Motor a.s" —
// unless the element resolves direction from its own content as an isolated run.
// The preferred fix is wrapping the value in <BidiText> / <UserText>.
//
// Flagged: an app JSX element whose only child is `{<expr>.<nameProp>}` (a
// known user-content identifier property) and which is not <BidiText> /
// <UserText>. Raw `dir` and raw <bdi>/<bdo> are intentionally flagged so app
// code converges on one typed wrapper.

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
  "email",
  "caseNumber",
  "citationText",
]);

const SELF_ISOLATING = new Set(["BidiText", "UserText"]);
const RAW_ISOLATING = new Set(["bdi", "bdo"]);

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
            'under RTL (e.g. ".Tatra Motor a.s"). Wrap the value in ' +
            "<BidiText> / <UserText>.",
          missingBidi:
            "User-provided name rendered alongside other content reorders " +
            "under RTL; wrap it in <BidiText> / <UserText> (dir on the " +
            "parent would also reorder its siblings).",
          preferComponent:
            "Use <BidiText> / <UserText> for rendered user-provided text. " +
            'Raw dir="auto" / <bdi> does not provide the app-level typed ' +
            "contract.",
        },
      },
      create(context) {
        return {
          JSXElement(node) {
            const opening = node.openingElement;
            if (opening.name.type !== "JSXIdentifier") {
              return;
            }
            if (
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
              if (
                (hasDirAttr(opening) ||
                  RAW_ISOLATING.has(opening.name.name))
              ) {
                context.report({ node: opening, messageId: "preferComponent" });
                return;
              }
              if (!hasDirAttr(opening)) {
                context.report({ node: opening, messageId: "missingDir" });
              }
              return;
            }
            // Mixed children: dir on the element would reorder the siblings too,
            // so the name itself must be wrapped in BidiText/UserText.
            for (const child of nameKids) {
              context.report({ node: child, messageId: "missingBidi" });
            }
          },
        };
      },
    },
  },
};
