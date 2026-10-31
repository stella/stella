import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

GlobalRegistrator.register();
const { isEditableContextMenuTarget } = await import("./native-context-menu");

afterEach(() => {
  document.body.replaceChildren();
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

/**
 * Builds nested elements, outermost first, each with the given
 * `contenteditable` value (null leaves the attribute off), and returns the
 * innermost one.
 */
const nested = (values: readonly (string | null)[]): Element => {
  let parent: Element = document.body;
  for (const value of values) {
    const child = document.createElement("div");
    if (value !== null) {
      child.setAttribute("contenteditable", value);
    }
    parent.append(child);
    parent = child;
  }
  return parent;
};

describe("contenteditable follows the HTML standard", () => {
  const cases: readonly {
    chain: readonly (string | null)[];
    editable: boolean;
    name: string;
  }[] = [
    { name: "no attribute anywhere", chain: [null], editable: false },
    { name: "true", chain: ["true"], editable: true },
    { name: "TRUE, any case", chain: ["TRUE"], editable: true },
    { name: "the empty string", chain: [""], editable: true },
    { name: "plaintext-only", chain: ["plaintext-only"], editable: true },
    {
      name: "Plaintext-Only, any case",
      chain: ["Plaintext-Only"],
      editable: true,
    },
    { name: "false", chain: ["false"], editable: false },
    { name: "FALSE, any case", chain: ["FALSE"], editable: false },
    { name: "an invalid value alone", chain: ["yes"], editable: false },
    {
      name: "an invalid value inherits an editable parent",
      chain: ["true", "bogus"],
      editable: true,
    },
    {
      name: "an invalid value inherits a non-editable parent",
      chain: ["false", "bogus"],
      editable: false,
    },
    {
      name: "a false island inside an editor",
      chain: ["true", "false", null],
      editable: false,
    },
    {
      name: "an editable island inside a false region",
      chain: ["false", "TRUE", null],
      editable: true,
    },
    {
      name: "a child without the attribute inherits",
      chain: ["", null, null],
      editable: true,
    },
  ];

  for (const { chain, editable, name } of cases) {
    test(name, () => {
      expect(isEditableContextMenuTarget(nested(chain))).toBe(editable);
    });
  }
});

describe("text fields", () => {
  const cases: readonly { editable: boolean; type: string | null }[] = [
    { type: null, editable: true },
    { type: "search", editable: true },
    { type: "EMAIL", editable: true },
    { type: "checkbox", editable: false },
    { type: "Radio", editable: false },
    { type: "button", editable: false },
  ];

  for (const { editable, type } of cases) {
    test(`input type ${type ?? "(none)"}`, () => {
      const input = document.createElement("input");
      if (type !== null) {
        input.setAttribute("type", type);
      }
      document.body.append(input);
      expect(isEditableContextMenuTarget(input)).toBe(editable);
    });
  }

  test("a textarea", () => {
    const area = document.createElement("textarea");
    document.body.append(area);
    expect(isEditableContextMenuTarget(area)).toBe(true);
  });
});
