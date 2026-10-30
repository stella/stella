import { Result } from "better-result";
import { afterEach, expect, test } from "bun:test";

import { copyRichToClipboard, copyToClipboard } from "./index";

// `navigator` is a real global here and `navigator.clipboard` is absent, which
// is also the shape an insecure browsing context has. Each test installs the
// clipboard it needs and the teardown puts the original descriptor back, so no
// test inherits another's stub.
const ORIGINAL_CLIPBOARD = Object.getOwnPropertyDescriptor(
  navigator,
  "clipboard",
);
const ORIGINAL_CLIPBOARD_ITEM = Object.getOwnPropertyDescriptor(
  globalThis,
  "ClipboardItem",
);

const stubClipboard = (clipboard: unknown): void => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: clipboard,
    writable: true,
  });
};

afterEach(() => {
  if (ORIGINAL_CLIPBOARD === undefined) {
    Reflect.deleteProperty(navigator, "clipboard");
  } else {
    Object.defineProperty(navigator, "clipboard", ORIGINAL_CLIPBOARD);
  }
  if (ORIGINAL_CLIPBOARD_ITEM === undefined) {
    Reflect.deleteProperty(globalThis, "ClipboardItem");
  } else {
    Object.defineProperty(globalThis, "ClipboardItem", ORIGINAL_CLIPBOARD_ITEM);
  }
});

const stubClipboardItem = (): void => {
  class FakeClipboardItem {
    readonly data: Record<string, Blob>;
    readonly types: string[];

    constructor(data: Record<string, Blob>) {
      this.data = data;
      this.types = Object.keys(data);
    }
  }
  Object.defineProperty(globalThis, "ClipboardItem", {
    configurable: true,
    value: FakeClipboardItem,
  });
};

test("a successful write passes the text through and resolves ok", async () => {
  const written: string[] = [];
  stubClipboard({
    writeText: async (text: string) => {
      written.push(text);
    },
  });

  const result = await copyToClipboard("§ 42 odst. 1");

  expect(Result.isOk(result)).toBe(true);
  expect(written).toEqual(["§ 42 odst. 1"]);
});

test("a denied permission resolves to an error carrying the cause", async () => {
  const denied = new Error("Write permission denied.");
  stubClipboard({
    writeText: async () => {
      throw denied;
    },
  });

  const result = await copyToClipboard("text");

  expect(Result.isError(result)).toBe(true);
  if (Result.isError(result)) {
    expect(result.error.cause).toBe(denied);
  }
});

// An insecure context has no `navigator.clipboard` at all, so the property
// access throws before any promise exists. The wrapper owes the caller an error
// Result there too: every call site branches on the Result and none of them
// carries a try/catch.
test("a missing clipboard API is an error Result, not a throw", async () => {
  stubClipboard(undefined);

  const result = await copyToClipboard("text");

  expect(Result.isError(result)).toBe(true);
});

test("rich copy writes both HTML and plain text", async () => {
  const written: ClipboardItem[][] = [];
  stubClipboardItem();
  class FakeClipboard {
    async write(items: ClipboardItem[]) {
      written.push(items);
    }

    async writeText() {
      throw new Error("plain fallback must not run");
    }
  }
  const clipboard = new FakeClipboard();
  stubClipboard(clipboard);

  expect(Object.hasOwn(clipboard, "write")).toBe(false);

  const result = await copyRichToClipboard({
    html: "<em>quoted</em>",
    plain: "quoted",
  });

  expect(Result.isOk(result)).toBe(true);
  expect(written).toHaveLength(1);
  expect(written[0]?.[0]?.types.toSorted()).toEqual([
    "text/html",
    "text/plain",
  ]);
});

test.each(["missing ClipboardItem", "missing write", "rejected write"])(
  "rich copy falls back to plain text when write is %s",
  async (condition) => {
    const plainWrites: string[] = [];
    if (condition === "missing ClipboardItem") {
      Reflect.deleteProperty(globalThis, "ClipboardItem");
    } else {
      stubClipboardItem();
    }
    stubClipboard({
      ...(condition === "rejected write"
        ? {
            write: async () => {
              throw new Error("denied");
            },
          }
        : {}),
      writeText: async (text: string) => plainWrites.push(text),
    });

    const result = await copyRichToClipboard({
      html: "<em>quoted</em>",
      plain: "quoted",
    });

    expect(Result.isOk(result)).toBe(true);
    expect(plainWrites).toEqual(["quoted"]);
  },
);
