import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

import { captureDialogReturnFocus } from "./dialog-return-focus";

GlobalRegistrator.register();

afterEach(() => document.body.replaceChildren());
afterAll(async () => unregisterDomEnvironment());

test("captures the opening control before dialog focus moves", () => {
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  const returnFocus = captureDialogReturnFocus();
  const input = document.createElement("input");
  document.body.append(input);
  input.focus();
  expect(returnFocus.current).toBe(opener);
});

test("a menu action returns to its durable trigger after the menu unmounts", () => {
  const opener = document.createElement("button");
  opener.setAttribute("aria-controls", "another-popup menu-popup");
  const menu = document.createElement("div");
  menu.id = "menu-popup";
  menu.setAttribute("role", "menu");
  const action = document.createElement("button");
  action.setAttribute("role", "menuitem");
  menu.append(action);
  document.body.append(opener, menu);
  action.focus();
  expect(document.activeElement).toBe(action);
  const returnFocus = captureDialogReturnFocus();
  menu.remove();
  expect(action.isConnected).toBe(false);
  expect(returnFocus.current).toBe(opener);
  expect(returnFocus.current?.isConnected).toBe(true);
});

test("pointer openers are retained even when the browser leaves focus elsewhere", () => {
  const opener = document.createElement("button");
  document.body.append(opener);
  expect(document.activeElement).toBe(document.body);
  expect(captureDialogReturnFocus(opener).current).toBe(opener);
});
