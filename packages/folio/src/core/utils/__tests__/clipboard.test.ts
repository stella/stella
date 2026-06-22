import { describe, expect, test } from "bun:test";

import type { Run } from "../../types/document";
import {
  cleanWordHtml,
  getClipboardImageFiles,
  htmlToRuns,
  runsToClipboardContent,
} from "../clipboard";

const withDomParserStub = (run: () => void): void => {
  const originalParser = globalThis.DOMParser;
  Object.defineProperty(globalThis, "DOMParser", {
    configurable: true,
    value: class {
      parseFromString(html: string) {
        return {
          body: {
            innerHTML: html,
            querySelectorAll: () => [],
          },
        };
      }
    },
  });

  try {
    run();
  } finally {
    if (originalParser) {
      Object.defineProperty(globalThis, "DOMParser", {
        configurable: true,
        value: originalParser,
      });
    } else {
      Reflect.deleteProperty(globalThis, "DOMParser");
    }
  }
};

type FakeDomNode = FakeTextNode | FakeElementNode;

class FakeTextNode {
  readonly childNodes: FakeDomNode[] = [];
  nextSibling: FakeDomNode | null = null;
  readonly nodeType = 3;
  readonly textContent: string;

  constructor(textContent: string) {
    this.textContent = textContent;
  }
}

class FakeElementNode {
  readonly childNodes: FakeDomNode[];
  nextSibling: FakeDomNode | null = null;
  readonly nodeType = 1;
  readonly style = {
    backgroundColor: "",
    color: "",
    fontFamily: "",
    fontSize: "",
    fontStyle: "",
    fontWeight: "",
    textDecoration: "",
  };
  readonly tagName: string;

  constructor(tagName: string, childNodes: FakeDomNode[] = []) {
    this.tagName = tagName;
    this.childNodes = childNodes;

    for (let index = 0; index < childNodes.length; index++) {
      childNodes[index]!.nextSibling = childNodes.at(index + 1) ?? null;
    }
  }

  getAttribute(): string | null {
    return null;
  }
}

const withDomTree = (body: FakeElementNode, run: () => void): void => {
  const originalNode = globalThis.Node;
  const originalElement = globalThis.HTMLElement;
  const originalParser = globalThis.DOMParser;

  Object.defineProperty(globalThis, "Node", {
    configurable: true,
    value: { TEXT_NODE: 3 },
  });
  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    value: FakeElementNode,
  });
  Object.defineProperty(globalThis, "DOMParser", {
    configurable: true,
    value: class {
      parseFromString() {
        return { body };
      }
    },
  });

  try {
    run();
  } finally {
    restoreGlobal("Node", originalNode);
    restoreGlobal("HTMLElement", originalElement);
    restoreGlobal("DOMParser", originalParser);
  }
};

const restoreGlobal = <K extends "DOMParser" | "HTMLElement" | "Node">(
  key: K,
  value: (typeof globalThis)[K] | undefined,
): void => {
  if (value) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value,
    });
    return;
  }

  Reflect.deleteProperty(globalThis, key);
};

describe("getClipboardImageFiles", () => {
  test("returns image files from clipboardData.files", () => {
    const imageFile = new File([new Uint8Array([1, 2, 3])], "photo.png", {
      type: "image/png",
    });
    const textFile = new File([new Uint8Array([4])], "note.txt", {
      type: "text/plain",
    });

    const clipboardData = {
      files: [imageFile, textFile],
    } as unknown as DataTransfer;

    expect(getClipboardImageFiles(clipboardData)).toEqual([imageFile]);
  });

  test("returns image files from clipboardData.items", () => {
    const imageFile = new File([new Uint8Array([9])], "scan.jpg", {
      type: "image/jpeg",
    });
    const textFile = new File([new Uint8Array([5])], "readme.md", {
      type: "text/plain",
    });

    const imageItem = {
      kind: "file",
      type: "image/jpeg",
      getAsFile: () => imageFile,
    };
    const textItem = {
      kind: "file",
      type: "text/plain",
      getAsFile: () => textFile,
    };

    const clipboardData = {
      items: [imageItem, textItem],
    } as unknown as DataTransfer;

    expect(getClipboardImageFiles(clipboardData)).toEqual([imageFile]);
  });

  test("deduplicates images that appear in files and items", () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const fileFromFiles = new File([payload], "dup.png", {
      type: "image/png",
      lastModified: 123,
    });
    const fileFromItems = new File([payload], "dup.png", {
      type: "image/png",
      lastModified: 123,
    });

    const imageItem = {
      kind: "file",
      type: "image/png",
      getAsFile: () => fileFromItems,
    };

    const clipboardData = {
      files: [fileFromFiles],
      items: [imageItem],
    } as unknown as DataTransfer;

    const result = getClipboardImageFiles(clipboardData);
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("dup.png");
  });

  test("deduplicates multiple clipboard formats for the same image", () => {
    const payload = new Uint8Array([9, 8, 7, 6, 5]);
    const pngFile = new File([payload], "clipboard.png", {
      type: "image/png",
      lastModified: 111,
    });
    const bmpFile = new File([payload], "clipboard.bmp", {
      type: "image/bmp",
      lastModified: 222,
    });

    const pngItem = {
      kind: "file",
      type: "image/png",
      getAsFile: () => pngFile,
    };
    const bmpItem = {
      kind: "file",
      type: "image/bmp",
      getAsFile: () => bmpFile,
    };

    const clipboardData = {
      files: [pngFile, bmpFile],
      items: [pngItem, bmpItem],
    } as unknown as DataTransfer;

    const result = getClipboardImageFiles(clipboardData);
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe("image/png");
  });

  test("returns empty array when clipboardData is null", () => {
    expect(getClipboardImageFiles(null)).toEqual([]);
  });
});

describe("runsToClipboardContent", () => {
  test("escapes formatting fields before serializing clipboard HTML", () => {
    const scriptScheme = ["java", "script:"].join("");
    const run: Run = {
      type: "run",
      content: [{ type: "text", text: "Client <draft>" }],
      formatting: {
        fontSize: 24,
        fontFamily: {
          ascii: 'Bad";" onmouseover="alert(1)<img src=x>',
        },
        color: { rgb: `000000;background:url(${scriptScheme}alert(1))` },
        shading: { fill: { rgb: 'ffffff"><img src=x onerror=alert(1)>' } },
      },
    };

    const { html } = runsToClipboardContent([run]);

    expect(html).toContain("Client &lt;draft&gt;");
    expect(html).toContain("font-size: 12pt");
    expect(html).toContain("font-family:");
    expect(html).toContain("\\&quot;");
    expect(html).not.toContain('" onmouseover=');
    expect(html).not.toContain("<img");
    expect(html).not.toContain(scriptScheme);
    expect(html).not.toContain("color: #000000;background");
    expect(html).not.toContain("background-color:");
  });
});

describe("htmlToRuns", () => {
  test("preserves visible text inside pasted form controls", () => {
    const body = new FakeElementNode("body", [
      new FakeElementNode("p", [new FakeTextNode("Before")]),
      new FakeElementNode("form", [
        new FakeElementNode("textarea", [new FakeTextNode("Field value")]),
      ]),
      new FakeElementNode("p", [new FakeTextNode("After")]),
    ]);

    withDomTree(body, () => {
      const runs = htmlToRuns(
        "<p>Before</p><form><textarea>Field value</textarea></form><p>After</p>",
        "",
      );
      const text = runs
        .map((run) => run.content.map((part) => part.text).join(""))
        .join("");

      expect(text).toContain("Before");
      expect(text).toContain("Field value");
      expect(text).toContain("After");
    });
  });
});

describe("cleanWordHtml", () => {
  test("removes unterminated comments without leaving a stray opener", () => {
    withDomParserStub(() => {
      expect(cleanWordHtml("safe<!--dangling")).toBe("safe");
    });
  });

  test("strips many unterminated Office namespace openers in linear time", () => {
    withDomParserStub(() => {
      const evil = "<o:p>".repeat(100_000);
      const start = performance.now();
      cleanWordHtml(evil);
      expect(performance.now() - start).toBeLessThan(5000);
    });
  });

  test("removes self-closing namespace tags without stripping later content", () => {
    withDomParserStub(() => {
      expect(cleanWordHtml("a<o:p/>keep</o:p>tail")).toContain("keep");
    });
  });

  test("keeps original indices when stripping namespace tags after expanded lowercase characters", () => {
    withDomParserStub(() => {
      expect(cleanWordHtml("İ<o:p>junk</o:p>B")).toBe("İB");
    });
  });
});
