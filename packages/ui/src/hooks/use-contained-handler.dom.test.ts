import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, describe, expect, test } from "bun:test";

import { ownsContextMenuTarget } from "./use-contained-handler";

GlobalRegistrator.register();
afterAll(async () => GlobalRegistrator.unregister());

describe("context actions belong to the nearest marked row", () => {
  for (const depth of [1, 2, 5, 10]) {
    test(`nested targets cannot invoke any of their ${depth} ancestor menus`, () => {
      const root = document.createElement("ul");
      let parent = document.createElement("li");
      root.append(parent);
      const owners = [];
      for (let index = 0; index <= depth; index += 1) {
        const row = document.createElement("li");
        row.dataset["contextMenuTarget"] = `row-${index}`;
        const list = document.createElement("ul");
        parent.append(list);
        list.append(row);
        owners.push(row);
        parent = row;
      }
      const button = document.createElement("button");
      const icon = document.createElement("svg");
      const text = document.createTextNode("Child name");
      button.append(icon, text);
      parent.append(button);

      for (const target of [button, icon, text]) {
        for (const owner of owners) {
          expect(ownsContextMenuTarget({ currentTarget: owner, target })).toBe(
            owner === parent,
          );
        }
        expect(ownsContextMenuTarget({ currentTarget: button, target })).toBe(
          true,
        );
      }
    });
  }

  test("unmarked targets work while portaled descendants cannot invoke their React ancestor", () => {
    const row = document.createElement("div");
    const button = document.createElement("button");
    row.append(button);
    expect(ownsContextMenuTarget({ currentTarget: row, target: button })).toBe(
      true,
    );
    expect(
      ownsContextMenuTarget({
        currentTarget: row,
        target: document.createElement("button"),
      }),
    ).toBe(false);
    expect(ownsContextMenuTarget({ currentTarget: null, target: null })).toBe(
      false,
    );
  });
});
