import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";

import { installNativeContextMenuPolicy } from "../src/shared/native-context-menu";

let remove: () => void = () => undefined;

beforeAll(() => {
  GlobalRegistrator.register();
  remove = installNativeContextMenuPolicy(document);
});

afterEach(() => {
  document.body.replaceChildren();
  document.getSelection()?.removeAllRanges();
});

afterAll(async () => {
  remove();
  await GlobalRegistrator.unregister();
});

const rightClick = (element: Element, init: MouseEventInit = {}) => {
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  element.dispatchEvent(event);
  return event;
};

const mount = (html: string) => {
  // safe-html: every caller passes a string literal written in this test file.
  document.body.innerHTML = html;
};

const byId = (id: string) => {
  const element = document.querySelector(`#${id}`);
  if (element === null) {
    throw new Error(`missing #${id}`);
  }
  return element;
};

describe("desktop webview context menu", () => {
  test("off-object areas show no browser menu, Shift included", () => {
    mount(
      '<main id="page"><p id="text">Plain text</p><a id="link" href="https://stll.app">stll.app</a></main>',
    );
    expect(rightClick(byId("page")).defaultPrevented).toBe(true);
    expect(rightClick(byId("text")).defaultPrevented).toBe(true);
    expect(rightClick(byId("link")).defaultPrevented).toBe(true);
    expect(rightClick(byId("text"), { shiftKey: true }).defaultPrevented).toBe(
      true,
    );
  });

  test("editable text keeps the webview's text menu", () => {
    mount(
      '<input id="input" /><textarea id="area"></textarea><div id="editor" contenteditable="true"><span id="inner">Draft</span></div>',
    );
    for (const id of ["input", "area", "editor", "inner"]) {
      expect(rightClick(byId(id)).defaultPrevented).toBe(false);
    }
  });

  test("a non-text control and a non-editable island show no menu", () => {
    mount(
      '<input id="check" type="checkbox" /><div contenteditable="true"><span id="chip" contenteditable="false">chip</span></div>',
    );
    expect(rightClick(byId("check")).defaultPrevented).toBe(true);
    expect(rightClick(byId("chip")).defaultPrevented).toBe(true);
  });

  test("selected text keeps the webview's text menu", () => {
    mount('<p id="text">A sentence the user selected</p>');
    const range = document.createRange();
    range.selectNodeContents(byId("text"));
    document.getSelection()?.addRange(range);
    expect(rightClick(byId("text")).defaultPrevented).toBe(false);
  });

  test("a right-click the page already handled stays handled", () => {
    mount('<div id="row">Row</div>');
    const row = byId("row");
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    event.preventDefault();
    row.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  test("the remover takes the policy away", () => {
    remove();
    mount('<p id="text">Plain text</p>');
    expect(rightClick(byId("text")).defaultPrevented).toBe(false);
    remove = installNativeContextMenuPolicy(document);
  });
});
