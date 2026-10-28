import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { Element, Root } from "hast";

import { assertProperty } from "@stll/property-testing";

import {
  ANSWER_ID_PREFIX,
  rehypeScopeAnswerIds,
} from "@/components/chat/rehype-scope-answer-ids";

const element = (
  tagName: string,
  properties: Element["properties"],
  children: Element["children"] = [],
): Element => ({ type: "element", tagName, properties, children });

const answerName = fc.constantFrom(
  "terms",
  "České právo",
  "القانون المدني",
  "民法 条文",
);

describe("answer id scoping", () => {
  test("hash links that name no answer element keep their app meaning", () => {
    // Citation links share the hash syntax but address the app, not the page.
    const tree: Root = {
      type: "root",
      children: [
        element("a", { href: "#folio:seq-0007" }),
        element("a", { href: "#stella-entity=abc" }),
        element("a", { href: "#malformed%ZZ" }),
        element("span", { id: "folio:other" }),
      ],
    };
    const before = structuredClone(tree);
    rehypeScopeAnswerIds()(tree);
    expect(tree.children.slice(0, 3)).toEqual(before.children.slice(0, 3));
    expect(tree.children.at(3)).toEqual(
      element("span", { id: `${ANSWER_ID_PREFIX}folio:other` }),
    );
  });

  test("encoded hash links resolve to every declared answer name", () => {
    assertProperty(
      "encoded hash links resolve to every declared answer name",
      fc.property(answerName, (name) => {
        const tree: Root = {
          type: "root",
          children: [
            element("h2", { id: name }),
            element("a", { href: `#${encodeURIComponent(name)}` }),
          ],
        };

        rehypeScopeAnswerIds()(tree);

        expect(tree.children).toEqual([
          element("h2", { id: `${ANSWER_ID_PREFIX}${name}` }),
          element("a", {
            href: `#${encodeURIComponent(`${ANSWER_ID_PREFIX}${name}`)}`,
          }),
        ]);
      }),
    );
  });

  test("names, their links and ARIA references move together, once", () => {
    const tree: Root = {
      type: "root",
      children: [
        element("h2", { id: "terms" }),
        element("a", { href: "#terms", ariaDescribedBy: ["terms", "page"] }),
        element("li", { id: `${ANSWER_ID_PREFIX}fn-1` }),
        element("a", { href: `#${ANSWER_ID_PREFIX}fn-1` }),
      ],
    };
    rehypeScopeAnswerIds()(tree);
    const scopedOnce = structuredClone(tree);
    expect(tree.children).toEqual([
      element("h2", { id: `${ANSWER_ID_PREFIX}terms` }),
      element("a", {
        href: `#${ANSWER_ID_PREFIX}terms`,
        ariaDescribedBy: [`${ANSWER_ID_PREFIX}terms`, "page"],
      }),
      element("li", { id: `${ANSWER_ID_PREFIX}fn-1` }),
      element("a", { href: `#${ANSWER_ID_PREFIX}fn-1` }),
    ]);
    rehypeScopeAnswerIds()(tree);
    expect(tree).toEqual(scopedOnce);
  });
});
