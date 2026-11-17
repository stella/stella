import { describe, expect, test } from "bun:test";

import {
  BROWSER_CONTROL_LIMITS,
  BROWSER_CONTROL_TARGET_METADATA,
  BROWSER_READER_CURSOR_PATTERN,
} from "@stll/api-contract/browser-control";

import type { FindRequest, ReadRequest } from "./page-script";
import {
  decodeReaderCursor,
  findInPage,
  type FrameFound,
  type FrameOutcome,
  type FrameRead,
  readPageWindow,
} from "./page-window";

const ABSENT = { type: BROWSER_CONTROL_TARGET_METADATA.absent } as const;
const TOP = { documentId: "doc-top", frameId: 0 };
const AD = { documentId: "doc-ad", frameId: 2 };
const FRAME = { documentId: "doc-frame", frameId: 4 };

const node = (path: string, skip = 0) =>
  ({
    fingerprint: "abc",
    path,
    phase: "open",
    skip,
    text: -1,
    type: "node",
  }) as const;

type Window = NonNullable<FrameRead["window"]>;

const windowOf = (overrides: Partial<Window>): Window => ({
  controls: [],
  controlsLeftOut: false,
  end: { type: "end" },
  fromPercent: 0,
  hasAfter: false,
  hasBefore: false,
  links: [],
  linksLeftOut: false,
  start: { type: "start" },
  text: "",
  toPercent: 100,
  ...overrides,
});

const SEARCH_FIELD = {
  context: ABSENT,
  href: ABSENT,
  id: "E1",
  name: "Search",
  path: "1.0.2",
  role: "searchbox",
  value: "",
};

const pageRead = (window: Window | undefined, url = "https://example.com/") =>
  ({
    origin: new URL(url).origin,
    pageControls: [SEARCH_FIELD],
    pageControlsLeftOut: false,
    title: "Long document",
    url,
    ...(window === undefined ? {} : { window }),
  }) satisfies FrameRead;

const link = (number: number, prefix = "") => ({
  context: ABSENT,
  href: {
    type: BROWSER_CONTROL_TARGET_METADATA.present,
    value: `https://example.com/${String(number)}`,
  },
  id: `L${prefix}${String(number)}`,
  name: `Link ${String(number)}`,
  path: `1.${String(number)}`,
  role: "link",
});

type Asked = {
  frame: number;
  idPrefix: string;
  read: ReadRequest | undefined;
};

/** Answers reads from `answers` in order and records what each asked. */
const frameReader = (answers: FrameOutcome<FrameRead>[]) => {
  const asked: Asked[] = [];
  return {
    asked,
    readFrame: async (
      frame: { frameId: number },
      request: { idPrefix: string; read?: ReadRequest },
    ): Promise<FrameOutcome<FrameRead>> => {
      asked.push({
        frame: frame.frameId,
        idPrefix: request.idPrefix,
        read: request.read,
      });
      return answers.shift() ?? { type: "skipped" };
    },
  };
};

const windowFrom = async (outcome: ReturnType<typeof readPageWindow>) => {
  const read = await outcome;
  if (read.type !== "window") {
    throw new TypeError(`Expected a window, got ${read.type}`);
  }
  return read.window;
};

const readOf = (window: Window, url?: string): FrameOutcome<FrameRead> => ({
  result: pageRead(window, url),
  type: "read",
});

describe("a window's cursors", () => {
  test("a default read starts in view, and next and previous continue from its edges", async () => {
    const reader = frameReader([
      readOf(
        windowOf({
          end: node("1.4"),
          fromPercent: 40,
          hasAfter: true,
          hasBefore: true,
          start: node("1.3"),
          text: "## Scope\n12 The notice period runs from delivery.",
          toPercent: 45,
        }),
      ),
    ]);
    const window = await windowFrom(
      readPageWindow({
        cursor: undefined,
        frames: [TOP],
        readFrame: reader.readFrame,
      }),
    );
    expect(reader.asked.at(0)?.read?.position).toEqual({ type: "viewport" });
    expect(window.text).toBe(
      "## Scope\n12 The notice period runs from delivery.",
    );
    expect(window.window).toMatchObject({ fromPercent: 40, toPercent: 45 });
    for (const cursor of [
      window.window.cursor,
      window.window.next,
      window.window.previous,
    ]) {
      expect(cursor).toMatch(BROWSER_READER_CURSOR_PATTERN);
    }
    expect(decodeReaderCursor(window.window.next ?? "")).toEqual({
      d: "doc-top",
      f: 0,
      k: "read",
      p: node("1.4"),
      w: "forward",
    });
    expect(decodeReaderCursor(window.window.previous ?? "")).toMatchObject({
      p: node("1.3"),
      w: "backward",
    });
    expect(decodeReaderCursor(window.window.cursor)).toMatchObject({
      p: node("1.3"),
      w: "forward",
    });
  });

  test("a cursor reads from where it points, in its own document", async () => {
    const first = await windowFrom(
      readPageWindow({
        cursor: undefined,
        frames: [TOP],
        readFrame: frameReader([
          readOf(
            windowOf({ end: node("1.9", 120), hasAfter: true, text: "Head" }),
          ),
        ]).readFrame,
      }),
    );
    const reader = frameReader([readOf(windowOf({ text: "Rest" }))]);
    const next = await windowFrom(
      readPageWindow({
        cursor: first.window.next,
        frames: [TOP],
        readFrame: reader.readFrame,
      }),
    );
    expect(reader.asked.at(0)?.read).toMatchObject({
      direction: "forward",
      position: node("1.9", 120),
    });
    expect(next.text).toBe("Rest");
    expect(next.window.next).toBeUndefined();
  });

  test("a cursor from a document the tab no longer shows is stale", async () => {
    const first = await windowFrom(
      readPageWindow({
        cursor: undefined,
        frames: [TOP],
        readFrame: frameReader([
          readOf(windowOf({ end: node("1.9"), hasAfter: true, text: "Head" })),
        ]).readFrame,
      }),
    );
    const reader = frameReader([]);
    expect(
      await readPageWindow({
        cursor: first.window.next,
        frames: [{ documentId: "doc-reloaded", frameId: 0 }],
        readFrame: reader.readFrame,
      }),
    ).toEqual({ type: "stale-cursor" });
    expect(reader.asked).toEqual([]);
  });

  test("anything but an issued read cursor is refused unread", async () => {
    const reader = frameReader([]);
    for (const cursor of ["r1.bm90LWpzb24", "r1.e30", "e:0:1.2"]) {
      expect(
        await readPageWindow({
          cursor,
          frames: [TOP],
          readFrame: reader.readFrame,
        }),
      ).toEqual({ type: "invalid-cursor" });
    }
    expect(reader.asked).toEqual([]);
  });

  test("a page's own refusal ends the read", async () => {
    expect(
      await readPageWindow({
        cursor: undefined,
        frames: [TOP],
        readFrame: frameReader([{ reason: "sign-in", type: "refused" }])
          .readFrame,
      }),
    ).toEqual({ reason: "sign-in", type: "refused" });
  });

  test("a top document that answers with something else is not called a stale cursor", async () => {
    expect(
      await readPageWindow({
        cursor: undefined,
        frames: [TOP],
        readFrame: frameReader([{ type: "invalid" }]).readFrame,
      }),
    ).toEqual({ type: "unreadable-page" });
  });
});

describe("frames as one text", () => {
  test("a window that reaches the end of the top frame goes on in the next frame", async () => {
    const reader = frameReader([
      readOf(windowOf({ text: "Top text" })),
      readOf(
        windowOf({
          end: node("1.2"),
          hasAfter: true,
          links: [link(1, "4.")],
          text: "Frame text, see Link 1 [L4.1]",
        }),
        "https://example.com/frame",
      ),
    ]);
    const window = await windowFrom(
      readPageWindow({
        cursor: undefined,
        frames: [TOP, FRAME],
        readFrame: reader.readFrame,
      }),
    );
    expect(window.text).toBe("Top text\nFrame text, see Link 1 [L4.1]");
    expect(reader.asked.map(({ idPrefix }) => idPrefix)).toEqual(["", "4."]);
    expect(reader.asked.at(1)?.read).toMatchObject({
      maxChars: BROWSER_CONTROL_LIMITS.pageTextChars - "Top text".length - 1,
      position: { type: "start" },
    });
    expect(window.elements.map(({ id, ref }) => [id, ref])).toEqual([
      ["L4.1", "e:4:1.1"],
      ["E1", "e:0:1.0.2"],
    ]);
    expect(window.documents).toEqual({ "0": "doc-top", "4": "doc-frame" });
    expect(decodeReaderCursor(window.window.next ?? "")).toMatchObject({
      d: "doc-frame",
      f: 4,
    });
  });

  test("a frame that cannot be read at a frame edge is passed over, both ways", async () => {
    // The top frame's window ends with too little room for another frame:
    // its next cursor points at the start of the frame after it.
    const longText = "x".repeat(BROWSER_CONTROL_LIMITS.pageTextChars - 100);
    const first = await windowFrom(
      readPageWindow({
        cursor: undefined,
        frames: [TOP, AD, FRAME],
        readFrame: frameReader([readOf(windowOf({ text: longText }))])
          .readFrame,
      }),
    );
    expect(decodeReaderCursor(first.window.next ?? "")).toMatchObject({
      d: "doc-ad",
    });
    // That frame is an embed stella may not read: the read goes on in the
    // frame after it.
    const reader = frameReader([
      { type: "skipped" },
      readOf(windowOf({ text: "Content frame" }), "https://example.com/frame"),
      readOf(windowOf({})),
    ]);
    const next = await windowFrom(
      readPageWindow({
        cursor: first.window.next,
        frames: [TOP, AD, FRAME],
        readFrame: reader.readFrame,
      }),
    );
    expect(next.text).toBe("Content frame");
    expect(reader.asked.map(({ frame }) => frame)).toEqual([2, 4, 0]);

    // Back from the content frame's start: the end of the frame before it,
    // which is passed over for the top frame's end.
    const backReader = frameReader([
      { type: "skipped" },
      readOf(windowOf({ start: node("1.7"), text: "Top text end" })),
    ]);
    const back = await windowFrom(
      readPageWindow({
        cursor: next.window.previous,
        frames: [TOP, AD, FRAME],
        readFrame: backReader.readFrame,
      }),
    );
    expect(back.text).toBe("Top text end");
    expect(
      backReader.asked.map(({ frame, read }) => [frame, read?.position.type]),
    ).toEqual([
      [2, "end"],
      [0, "end"],
    ]);
  });

  test("a cursor inside a frame that cannot be read any more is stale", async () => {
    const window = await windowFrom(
      readPageWindow({
        cursor: undefined,
        frames: [TOP, FRAME],
        readFrame: frameReader([
          readOf(windowOf({ text: "Top" })),
          readOf(windowOf({ end: node("1.5"), hasAfter: true, text: "In" })),
        ]).readFrame,
      }),
    );
    expect(
      await readPageWindow({
        cursor: window.window.next,
        frames: [TOP, FRAME],
        readFrame: frameReader([{ type: "skipped" }]).readFrame,
      }),
    ).toEqual({ type: "stale-cursor" });
  });

  test("links fill the list only up to the slots kept for the page's own controls", async () => {
    const links = Array.from(
      { length: BROWSER_CONTROL_LIMITS.elements },
      (_, index) => link(index + 1),
    );
    const reader = frameReader([readOf(windowOf({ links, text: "x" }))]);
    const window = await windowFrom(
      readPageWindow({
        cursor: undefined,
        frames: [TOP],
        readFrame: reader.readFrame,
      }),
    );
    expect(reader.asked.at(0)?.read?.maxLinks).toBeLessThan(
      BROWSER_CONTROL_LIMITS.elements,
    );
    expect(window.elements).toHaveLength(BROWSER_CONTROL_LIMITS.elements);
    expect(window.elements.at(-1)).toMatchObject({ id: "E1", name: "Search" });
    expect(window.elementsLeftOut).toBe(true);
  });
});

describe("find across frames", () => {
  const frameFound = (
    found: FrameFound["found"],
    url = "https://example.com/",
  ): FrameOutcome<FrameFound> => ({
    result: { found, origin: new URL(url).origin, title: "Long document", url },
    type: "read",
  });

  const resumeAt = {
    fingerprint: "f",
    offset: 2,
    path: "1.2",
    text: -1,
    type: "node",
  } as const;

  test("counts every match and resumes after the last one returned", async () => {
    const asked: FindRequest[] = [];
    const answers = [
      frameFound({
        last: resumeAt,
        matches: [{ position: node("1.2"), snippet: "notice period" }],
        total: 3,
        totalCapped: false,
        type: "text",
      }),
      frameFound(
        { matches: [], total: 2, totalCapped: false, type: "text" },
        "https://example.com/frame",
      ),
    ];
    const outcome = await findInPage({
      after: undefined,
      findFrame: async (_frame, request) => {
        asked.push(request);
        return answers.shift() ?? { type: "skipped" };
      },
      frames: [TOP, FRAME],
      search: { query: "notice", type: "text" },
    });
    if (outcome.type !== "found" || outcome.found.type !== "text") {
      throw new TypeError("Expected text matches");
    }
    expect(outcome.found.total).toBe(5);
    expect(outcome.found.matches).toHaveLength(1);
    expect(
      decodeReaderCursor(outcome.found.matches[0]?.cursor ?? ""),
    ).toMatchObject({ k: "read", p: node("1.2") });
    expect(decodeReaderCursor(outcome.found.more ?? "")).toMatchObject({
      d: "doc-top",
      k: "scan",
      p: resumeAt,
    });
    expect(asked.at(1)).toMatchObject({
      after: { type: "start" },
      countLimit: BROWSER_CONTROL_LIMITS.findCountLimit - 3,
    });
  });

  test("a count full at a frame's end still says whether a later frame has more", async () => {
    const limit = BROWSER_CONTROL_LIMITS.findCountLimit;
    const asked: FindRequest[] = [];
    const answers = [
      frameFound({
        last: resumeAt,
        matches: [{ position: node("1.2"), snippet: "notice" }],
        total: limit,
        totalCapped: false,
        type: "text",
      }),
      frameFound({ matches: [], total: 1, totalCapped: false, type: "text" }),
    ];
    const outcome = await findInPage({
      after: undefined,
      findFrame: async (_frame, request) => {
        asked.push(request);
        return answers.shift() ?? { type: "skipped" };
      },
      frames: [TOP, FRAME],
      search: { query: "notice", type: "text" },
    });
    expect(asked.at(1)).toMatchObject({ countLimit: 1, maxResults: 0 });
    expect(outcome).toMatchObject({
      found: { total: limit, totalCapped: true },
    });
  });

  test("a frame that cannot be read is passed over, not taken for a stale cursor", async () => {
    const answers: FrameOutcome<FrameFound>[] = [
      frameFound({ headings: [], type: "headings" }),
      { type: "skipped" },
      frameFound(
        {
          headings: [{ level: 2, position: node("1.1"), text: "Scope" }],
          type: "headings",
        },
        "https://example.com/frame",
      ),
    ];
    const outcome = await findInPage({
      after: undefined,
      findFrame: async () => answers.shift() ?? { type: "skipped" },
      frames: [TOP, AD, FRAME],
      search: { type: "headings" },
    });
    expect(outcome).toMatchObject({
      found: { headings: [{ text: "Scope" }], type: "headings" },
    });
  });

  test("a read cursor is not a place to resume a find", async () => {
    const window = await windowFrom(
      readPageWindow({
        cursor: undefined,
        frames: [TOP],
        readFrame: frameReader([readOf(windowOf({ text: "x" }))]).readFrame,
      }),
    );
    expect(
      await findInPage({
        after: window.window.cursor,
        findFrame: async () => ({ type: "skipped" }),
        frames: [TOP],
        search: { type: "headings" },
      }),
    ).toEqual({ type: "invalid-cursor" });
  });
});
