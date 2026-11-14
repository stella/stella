import { describe, expect, test } from "bun:test";

import {
  BROWSER_CONTROL_LIMITS,
  BROWSER_CONTROL_TARGET_METADATA,
  BROWSER_READER_CURSOR_PATTERN,
} from "@stll/api-contract/browser-control";

import type { FindRequest, ReadRequest } from "./page-script";
import {
  decodeCursor,
  findInPage,
  type FrameFound,
  type FrameOutcome,
  type FrameRead,
  readPageWindow,
} from "./page-window";

const ABSENT = { type: BROWSER_CONTROL_TARGET_METADATA.absent } as const;
const TOP = { documentId: "doc-top", frameId: 0 };
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

const pageRead = (window: Window | undefined, url = "https://example.com/") =>
  ({
    origin: new URL(url).origin,
    pageControls: [
      {
        context: ABSENT,
        href: ABSENT,
        name: "Search",
        path: "1.0.2",
        role: "searchbox",
        value: "",
      },
    ],
    pageControlsLeftOut: false,
    title: "Long document",
    url,
    ...(window === undefined ? {} : { window }),
  }) satisfies FrameRead;

/** Answers reads from `answers` in order and records what each asked. */
const frameReader = (answers: FrameOutcome<FrameRead>[]) => {
  const asked: { frame: number; read: ReadRequest | undefined }[] = [];
  return {
    asked,
    readFrame: async (
      frame: { frameId: number },
      request: { read?: ReadRequest },
    ): Promise<FrameOutcome<FrameRead>> => {
      asked.push({ frame: frame.frameId, read: request.read });
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

describe("a window's cursors", () => {
  test("a default read starts in view, and next and previous continue from its edges", async () => {
    const reader = frameReader([
      {
        result: pageRead(
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
        type: "read",
      },
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
    expect(decodeCursor(window.window.next ?? "")).toEqual({
      d: "doc-top",
      f: 0,
      k: "read",
      p: node("1.4"),
      w: "forward",
    });
    expect(decodeCursor(window.window.previous ?? "")).toMatchObject({
      p: node("1.3"),
      w: "backward",
    });
    expect(decodeCursor(window.window.cursor)).toMatchObject({
      p: node("1.3"),
      w: "forward",
    });
  });

  test("a cursor reads from where it points, in its own document", async () => {
    const reader = frameReader([
      { result: pageRead(windowOf({ text: "Rest" })), type: "read" },
    ]);
    const first = await windowFrom(
      readPageWindow({
        cursor: undefined,
        frames: [TOP],
        readFrame: frameReader([
          {
            result: pageRead(
              windowOf({
                end: node("1.9", 120),
                hasAfter: true,
                text: "Head",
              }),
            ),
            type: "read",
          },
        ]).readFrame,
      }),
    );
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
          {
            result: pageRead(
              windowOf({ end: node("1.9"), hasAfter: true, text: "Head" }),
            ),
            type: "read",
          },
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
});

describe("frames as one text", () => {
  test("a window that reaches the end of the top frame goes on in the next frame", async () => {
    const reader = frameReader([
      {
        result: pageRead(windowOf({ text: "Top text" })),
        type: "read",
      },
      {
        result: pageRead(
          windowOf({
            end: node("1.2"),
            hasAfter: true,
            links: [
              {
                context: ABSENT,
                href: {
                  type: BROWSER_CONTROL_TARGET_METADATA.present,
                  value: "https://example.com/b",
                },
                name: "Part B",
                number: 1,
                path: "1.1",
                role: "link",
              },
            ],
            text: "Frame text, see Part B [L1]",
          }),
          "https://example.com/frame",
        ),
        type: "read",
      },
    ]);
    const window = await windowFrom(
      readPageWindow({
        cursor: undefined,
        frames: [TOP, FRAME],
        readFrame: reader.readFrame,
      }),
    );
    expect(window.text).toBe("Top text\nFrame text, see Part B [L1]");
    expect(reader.asked.at(1)?.read).toMatchObject({
      firstLinkNumber: 1,
      maxChars: BROWSER_CONTROL_LIMITS.pageTextChars - "Top text".length - 1,
      position: { type: "start" },
    });
    expect(window.elements.map(({ id, ref }) => [id, ref])).toEqual([
      ["L1", "e:4:1.1"],
      ["E1", "e:0:1.0.2"],
    ]);
    expect(window.documents).toEqual({ "0": "doc-top", "4": "doc-frame" });
    expect(decodeCursor(window.window.next ?? "")).toMatchObject({
      d: "doc-frame",
      f: 4,
    });
  });

  test("a window from a frame's first block leads back to the end of the frame before", async () => {
    const forward = await windowFrom(
      readPageWindow({
        cursor: undefined,
        frames: [TOP, FRAME],
        readFrame: frameReader([
          { result: pageRead(windowOf({ text: "Top" })), type: "read" },
          {
            result: pageRead(
              windowOf({
                end: node("1.5"),
                hasAfter: true,
                start: { type: "start" },
                text: "Frame",
              }),
            ),
            type: "read",
          },
        ]).readFrame,
      }),
    );
    const next = await windowFrom(
      readPageWindow({
        cursor: forward.window.next,
        frames: [TOP, FRAME],
        readFrame: frameReader([
          { result: pageRead(undefined), type: "read" },
          {
            result: pageRead(windowOf({ start: node("1.5"), text: "More" })),
            type: "read",
          },
        ]).readFrame,
      }),
    );
    expect(next.text).toBe("More");
    // Its first block is the frame's first: what is before is the top frame.
    expect(decodeCursor(next.window.previous ?? "")).toEqual({
      d: "doc-top",
      f: 0,
      k: "read",
      p: { type: "end" },
      w: "backward",
    });
  });

  test("the element list is capped, links first, and says so", async () => {
    const links = Array.from(
      { length: BROWSER_CONTROL_LIMITS.elements },
      (_, index) => ({
        context: ABSENT,
        href: {
          type: BROWSER_CONTROL_TARGET_METADATA.present,
          value: `https://example.com/${String(index)}`,
        },
        name: `Link ${String(index)}`,
        number: index + 1,
        path: `1.${String(index)}`,
        role: "link",
      }),
    );
    const window = await windowFrom(
      readPageWindow({
        cursor: undefined,
        frames: [TOP],
        readFrame: frameReader([
          { result: pageRead(windowOf({ links, text: "x" })), type: "read" },
        ]).readFrame,
      }),
    );
    expect(window.elements).toHaveLength(BROWSER_CONTROL_LIMITS.elements);
    expect(window.elements.every(({ id }) => id.startsWith("L"))).toBe(true);
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

  test("counts every match and resumes after the last one returned", async () => {
    const asked: FindRequest[] = [];
    const answers = [
      frameFound({
        last: {
          fingerprint: "f",
          offset: 7,
          path: "1.2",
          text: 0,
          type: "node",
        },
        matches: [{ position: node("1.2"), snippet: "notice period" }],
        total: 3,
        totalCapped: false,
        type: "text",
      }),
      frameFound(
        {
          matches: [],
          total: 2,
          totalCapped: false,
          type: "text",
        },
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
    expect(decodeCursor(outcome.found.matches[0]?.cursor ?? "")).toMatchObject({
      k: "read",
      p: node("1.2"),
    });
    expect(decodeCursor(outcome.found.more ?? "")).toMatchObject({
      d: "doc-top",
      k: "scan",
      p: { offset: 7, path: "1.2" },
    });
    expect(asked.at(1)).toMatchObject({
      after: { type: "start" },
      countLimit: BROWSER_CONTROL_LIMITS.findCountLimit - 3,
    });
  });

  test("a read cursor is not a place to resume a find", async () => {
    const window = await windowFrom(
      readPageWindow({
        cursor: undefined,
        frames: [TOP],
        readFrame: frameReader([
          { result: pageRead(windowOf({ text: "x" })), type: "read" },
        ]).readFrame,
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
