import { Result } from "better-result";
import type { Element, Root, RootContent } from "hast";

/**
 * The namespace answer ids live in. It matches the prefix remark-rehype gives
 * footnote ids, so the ids Streamdown generates are already inside it.
 */
export const ANSWER_ID_PREFIX = "user-content-";

const ID_PROPERTIES: readonly string[] = ["id", "name"];
const ID_REFERENCE_PROPERTIES: readonly string[] = [
  "ariaDescribedBy",
  "ariaLabelledBy",
];

const scoped = (value: string): string =>
  value.startsWith(ANSWER_ID_PREFIX) ? value : `${ANSWER_ID_PREFIX}${value}`;

const elementsOf = (tree: Root): Element[] => {
  const found: Element[] = [];
  const visit = (nodes: readonly RootContent[]) => {
    for (const node of nodes) {
      if (node.type === "element") {
        found.push(node);
        visit(node.children);
      }
    }
  };
  visit(tree.children);
  return found;
};

/**
 * Raw HTML in an answer can name elements (`<h2 id="root">`, `<a name="x">`).
 * Unscoped, those names collide with the page's own ids and become
 * `window.<name>` globals. Run after sanitization: every id and name moves into
 * the answer namespace, and the in-page references that pointed at them (a
 * `#fragment` link, an ARIA id reference) move with them, so footnotes and
 * anchors keep resolving. Fragments that name no element in the tree, such as
 * the app's `#folio:` citation links, are left as they are.
 *
 * A `function` declaration keeps a stable plugin name for Streamdown's
 * processor cache.
 */
export function rehypeScopeAnswerIds() {
  return (tree: Root) => {
    const elements = elementsOf(tree);
    const declared = new Set<string>();
    for (const element of elements) {
      for (const property of ID_PROPERTIES) {
        const value = element.properties[property];
        if (typeof value === "string" && value !== "") {
          declared.add(value);
          element.properties[property] = scoped(value);
        }
      }
    }
    for (const element of elements) {
      const href = element.properties.href;
      if (typeof href === "string" && href.startsWith("#")) {
        const raw = href.slice(1);
        // A malformed escape cannot name a declared answer id, so it stays raw.
        const fragment = Result.try(() => decodeURIComponent(raw)).unwrapOr(
          raw,
        );
        if (declared.has(fragment)) {
          element.properties.href = `#${encodeURIComponent(scoped(fragment))}`;
        }
      }
      for (const property of ID_REFERENCE_PROPERTIES) {
        const value = element.properties[property];
        if (Array.isArray(value)) {
          element.properties[property] = value.map((token) =>
            typeof token === "string" && declared.has(token)
              ? scoped(token)
              : token,
          );
        }
      }
    }
  };
}
