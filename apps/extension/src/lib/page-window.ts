import { Result } from "better-result";
import * as v from "valibot";

import {
  BROWSER_CONTROL_LIMITS,
  BROWSER_FIND_TYPE,
  type BrowserControlElement,
  type BrowserControlFound,
  type BrowserControlSnapshot,
  browserControlTargetContextSchema,
  browserControlTargetHrefSchema,
  formatElementReference,
} from "@stll/api-contract/browser-control";

import type { FindRequest, ReadRequest } from "./page-script";

/**
 * The reading window's rules on the host side: cursors, paging across a
 * tab's frames, and the one page a read returns. The page script reads one
 * frame's document; this module decides which frames a window spans and
 * turns the positions the page reports into cursors bound to the document
 * they came from. Host-neutral: a host hands it the frames and a function
 * that runs the page script in one of them.
 *
 * Frames are read in a fixed order, the top frame first and then the rest
 * by frame id, as one text: a forward window that reaches the end of one
 * frame goes on in the next. A backward window stays in its frame.
 */

const PATH_PATTERN = /^\d+(?:\.(?:s\.)?\d+)*$/u;

const nodeAddressEntries = {
  fingerprint: v.pipe(v.string(), v.minLength(1), v.maxLength(16)),
  path: v.pipe(
    v.string(),
    v.maxLength(BROWSER_CONTROL_LIMITS.referenceChars),
    v.regex(PATH_PATTERN),
  ),
  text: v.pipe(v.number(), v.integer(), v.minValue(-1)),
};

const countSchema = v.pipe(v.number(), v.integer(), v.minValue(0));

const readerPositionSchema = v.variant("type", [
  v.strictObject({ type: v.literal("start") }),
  v.strictObject({ type: v.literal("end") }),
  v.strictObject({
    ...nodeAddressEntries,
    phase: v.picklist(["close", "open"]),
    skip: countSchema,
    type: v.literal("node"),
  }),
]);

const scanPositionSchema = v.variant("type", [
  v.strictObject({ type: v.literal("start") }),
  v.strictObject({
    ...nodeAddressEntries,
    offset: countSchema,
    type: v.literal("node"),
  }),
]);

type ReaderPositionOutput = v.InferOutput<typeof readerPositionSchema>;
type ScanPositionOutput = v.InferOutput<typeof scanPositionSchema>;

const documentEntries = {
  /** Chrome's id of the frame's document: a cursor reads only that document. */
  d: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(BROWSER_CONTROL_LIMITS.revisionIdChars),
  ),
  f: countSchema,
};

const cursorPayloadSchema = v.variant("k", [
  v.strictObject({
    ...documentEntries,
    k: v.literal("read"),
    p: readerPositionSchema,
    w: v.picklist(["backward", "forward"]),
  }),
  v.strictObject({
    ...documentEntries,
    k: v.literal("scan"),
    p: scanPositionSchema,
  }),
]);

type CursorPayload = v.InferOutput<typeof cursorPayloadSchema>;

const CURSOR_PREFIX = "r1.";

const encodeCursor = (payload: CursorPayload): string =>
  `${CURSOR_PREFIX}${btoa(JSON.stringify(payload))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")}`;

/** The cursor `encodeCursor` made, or null for anything else. */
export const decodeCursor = (cursor: string): CursorPayload | null => {
  if (
    !cursor.startsWith(CURSOR_PREFIX) ||
    cursor.length > BROWSER_CONTROL_LIMITS.cursorChars
  ) {
    return null;
  }
  const decoded = Result.try((): unknown =>
    JSON.parse(
      atob(
        cursor
          .slice(CURSOR_PREFIX.length)
          .replaceAll("-", "+")
          .replaceAll("_", "/"),
      ),
    ),
  );
  if (Result.isError(decoded)) {
    return null;
  }
  const parsed = v.safeParse(cursorPayloadSchema, decoded.value);
  return parsed.success ? parsed.output : null;
};

/** A frame a window may read: its id and the document it shows. */
export type ReaderFrame = { documentId: string; frameId: number };

const readCursor = (
  frame: ReaderFrame,
  direction: "backward" | "forward",
  position: ReaderPositionOutput,
) =>
  encodeCursor({
    d: frame.documentId,
    f: frame.frameId,
    k: "read",
    p: position,
    w: direction,
  });

const scanCursor = (frame: ReaderFrame, position: ScanPositionOutput) =>
  encodeCursor({
    d: frame.documentId,
    f: frame.frameId,
    k: "scan",
    p: position,
  });

// ---- What the page script returns ----------------------------------------

const pageElementEntries = {
  alternateName: v.optional(
    v.pipe(
      v.string(),
      v.maxLength(BROWSER_CONTROL_LIMITS.elementAlternateNameChars),
    ),
  ),
  context: browserControlTargetContextSchema,
  href: browserControlTargetHrefSchema,
  name: v.string(),
  path: v.pipe(v.string(), v.regex(PATH_PATTERN)),
  role: v.string(),
  value: v.optional(v.string()),
};

const pageElementSchema = v.strictObject(pageElementEntries);

type PageElement = v.InferOutput<typeof pageElementSchema>;

const percentSchema = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(0),
  v.maxValue(100),
);

const frameWindowSchema = v.strictObject({
  controls: v.array(pageElementSchema),
  controlsLeftOut: v.boolean(),
  /** Where the window after this one starts. */
  end: readerPositionSchema,
  fromPercent: percentSchema,
  hasAfter: v.boolean(),
  hasBefore: v.boolean(),
  links: v.array(
    v.strictObject({
      ...pageElementEntries,
      number: v.pipe(v.number(), v.integer(), v.minValue(1)),
    }),
  ),
  linksLeftOut: v.boolean(),
  /** Where this window's first block starts. */
  start: readerPositionSchema,
  text: v.string(),
  toPercent: percentSchema,
});

const pageEntries = {
  /** `window.origin` of the frame's document; opaque origins read `null`. */
  origin: v.string(),
  title: v.string(),
  url: v.string(),
};

/** What the page script returns for one frame's `snapshot`. */
export const frameReadSchema = v.strictObject({
  ...pageEntries,
  facts: v.optional(
    v.strictObject({
      canonicalUrl: v.optional(v.string()),
      language: v.optional(v.string()),
      meta: v.array(v.strictObject({ name: v.string(), value: v.string() })),
    }),
  ),
  pageControls: v.array(pageElementSchema),
  pageControlsLeftOut: v.boolean(),
  window: v.optional(frameWindowSchema),
});

export type FrameRead = v.InferOutput<typeof frameReadSchema>;

/** What the page script returns for one frame's `find`. */
export const frameFoundSchema = v.strictObject({
  ...pageEntries,
  found: v.variant("type", [
    v.strictObject({
      /** The last match returned, where a later `find` resumes. */
      last: v.optional(scanPositionSchema),
      matches: v.array(
        v.strictObject({ position: readerPositionSchema, snippet: v.string() }),
      ),
      total: countSchema,
      totalCapped: v.boolean(),
      type: v.literal(BROWSER_FIND_TYPE.text),
    }),
    v.strictObject({
      headings: v.array(
        v.strictObject({
          level: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(6)),
          position: readerPositionSchema,
          text: v.string(),
        }),
      ),
      more: v.optional(scanPositionSchema),
      type: v.literal(BROWSER_FIND_TYPE.headings),
    }),
  ]),
});

export type FrameFound = v.InferOutput<typeof frameFoundSchema>;

/** Why a frame read nothing. */
export type FrameRefusal = "sign-in" | "stale-cursor" | "top-origin";

export type FrameOutcome<T> =
  | { result: T; type: "read" }
  | { reason: FrameRefusal; type: "refused" }
  /** Outside the frames stella may read, or gone: passed over. */
  | { type: "skipped" };

// ---- A window -------------------------------------------------------------

/** Below this many characters left, a window does not open another frame. */
const MIN_FRAME_CHARS = 500;

type ReadFrame = (
  frame: ReaderFrame,
  request: { facts: boolean; pageControls: number; read?: ReadRequest },
) => Promise<FrameOutcome<FrameRead>>;

export type PageWindow = Pick<
  BrowserControlSnapshot,
  "elements" | "elementsLeftOut" | "facts" | "text" | "window"
> & {
  /** The documents the window's element refs point into, by frame id. */
  documents: Record<string, string>;
  /** The top frame's own read: its address, title and origin. */
  top: FrameRead;
};

export type PageWindowOutcome =
  | { type: "invalid-cursor" }
  | { reason: FrameRefusal; type: "refused" }
  | { type: "stale-cursor" }
  | { type: "window"; window: PageWindow };

type WindowRead = {
  frame: ReaderFrame;
  window: v.InferOutput<typeof frameWindowSchema>;
};

/**
 * The frame a cursor of kind `kind` addresses, by its document: `null`
 * index for no cursor, which starts at the top frame.
 */
const cursorFrame = <K extends CursorPayload["k"]>(
  cursor: string | undefined,
  kind: K,
  frames: readonly ReaderFrame[],
):
  | { decoded: Extract<CursorPayload, { k: K }> | null; index: number }
  | { type: "invalid-cursor" }
  | { type: "stale-cursor" } => {
  if (cursor === undefined) {
    return { decoded: null, index: 0 };
  }
  const payload = decodeCursor(cursor);
  const decoded = payload === null ? null : cursorOfKind(payload, kind);
  if (decoded === null) {
    return { type: "invalid-cursor" };
  }
  const index = frames.findIndex(
    ({ documentId, frameId }) =>
      documentId === decoded.d && frameId === decoded.f,
  );
  return index === -1 ? { type: "stale-cursor" } : { decoded, index };
};

const cursorOfKind = <K extends CursorPayload["k"]>(
  payload: CursorPayload,
  kind: K,
): Extract<CursorPayload, { k: K }> | null => {
  const matches = (
    candidate: CursorPayload,
  ): candidate is Extract<CursorPayload, { k: K }> => candidate.k === kind;
  return matches(payload) ? payload : null;
};

type FramePages = {
  /** What each frame read returned, its window or not. */
  pages: { frame: ReaderFrame; read: FrameRead }[];
  /** The frames whose text the window holds, in reading order. */
  reads: WindowRead[];
  /** The frame the next window starts in, when room ran out before it. */
  nextFrameIndex: number | null;
};

/**
 * Reads the window's text from `startIndex` on: a forward window goes on
 * into the next frames while it has room, a backward one stays put.
 */
const readFrames = async ({
  direction,
  frames,
  position,
  readFrame,
  startIndex,
}: {
  direction: "backward" | "forward";
  frames: readonly ReaderFrame[];
  position: ReadRequest["position"];
  readFrame: ReadFrame;
  startIndex: number;
}): Promise<FramePages | { reason: FrameRefusal; type: "refused" } | null> => {
  const pages: FramePages["pages"] = [];
  const reads: WindowRead[] = [];
  const room = {
    chars: BROWSER_CONTROL_LIMITS.pageTextChars,
    linkNumber: 1,
    links: BROWSER_CONTROL_LIMITS.elements,
  };
  for (let index = startIndex; index < frames.length; index += 1) {
    const frame = frames[index];
    if (frame === undefined) {
      break;
    }
    const first = index === startIndex;
    const outcome = await readFrame(frame, {
      facts: index === 0,
      pageControls: index === 0 ? BROWSER_CONTROL_LIMITS.elements : 0,
      read: {
        direction: first ? direction : "forward",
        firstLinkNumber: room.linkNumber,
        maxChars: room.chars,
        maxControls: BROWSER_CONTROL_LIMITS.elements,
        maxLinks: room.links,
        position: first ? position : { type: "start" },
      },
    });
    if (outcome.type === "refused") {
      return outcome;
    }
    if (outcome.type === "skipped") {
      // The cursor's own frame is not readable any more.
      if (first) {
        return null;
      }
      continue;
    }
    pages.push({ frame, read: outcome.result });
    const { window } = outcome.result;
    if (window === undefined) {
      continue;
    }
    reads.push({ frame, window });
    room.chars -= window.text.length + 1;
    room.linkNumber += window.links.length;
    room.links -= window.links.length;
    if (window.hasAfter || direction === "backward") {
      break;
    }
    if (room.chars < MIN_FRAME_CHARS) {
      return {
        nextFrameIndex: index + 1 < frames.length ? index + 1 : null,
        pages,
        reads,
      };
    }
  }
  return { nextFrameIndex: null, pages, reads };
};

/** The window's own cursor and the ones to the windows around it. */
const windowCursors = ({
  direction,
  firstRead,
  frames,
  lastRead,
  nextFrameIndex,
}: {
  direction: "backward" | "forward";
  firstRead: WindowRead;
  frames: readonly ReaderFrame[];
  lastRead: WindowRead;
  nextFrameIndex: number | null;
}): BrowserControlSnapshot["window"] => {
  const firstIndex = frames.indexOf(firstRead.frame);
  const lastIndex = frames.indexOf(lastRead.frame);
  // A forward window that ran out of room before the next frame, or a
  // backward one, goes on at the start of the frame after it.
  let frameAfter: ReaderFrame | undefined;
  if (direction === "backward") {
    frameAfter = frames.at(lastIndex + 1);
  } else if (nextFrameIndex !== null) {
    frameAfter = frames.at(nextFrameIndex);
  }
  let next: string | undefined;
  if (lastRead.window.hasAfter) {
    next = readCursor(lastRead.frame, "forward", lastRead.window.end);
  } else if (frameAfter !== undefined) {
    next = readCursor(frameAfter, "forward", { type: "start" });
  }
  const frameBefore = firstIndex > 0 ? frames.at(firstIndex - 1) : undefined;
  let previous: string | undefined;
  if (firstRead.window.hasBefore) {
    previous = readCursor(firstRead.frame, "backward", firstRead.window.start);
  } else if (frameBefore !== undefined) {
    previous = readCursor(frameBefore, "backward", { type: "end" });
  }
  return {
    cursor: readCursor(firstRead.frame, "forward", firstRead.window.start),
    fromPercent: firstRead.window.fromPercent,
    ...(next === undefined ? {} : { next }),
    ...(previous === undefined ? {} : { previous }),
    toPercent: lastRead.window.toPercent,
  };
};

/**
 * Reads one window: from `cursor`, or by default from the top frame's
 * first block in view. `frames` lists the tab's readable frames, the top
 * frame first.
 */
export const readPageWindow = async ({
  cursor,
  frames,
  readFrame,
}: {
  cursor: string | undefined;
  frames: readonly ReaderFrame[];
  readFrame: ReadFrame;
}): Promise<PageWindowOutcome> => {
  const start = cursorFrame(cursor, "read", frames);
  const topFrame = frames.at(0);
  if ("type" in start) {
    return start;
  }
  if (topFrame === undefined) {
    return { type: "stale-cursor" };
  }
  const direction = start.decoded?.w ?? "forward";
  const topPages: FramePages["pages"] = [];
  if (start.index > 0) {
    const top = await readFrame(topFrame, {
      facts: true,
      pageControls: BROWSER_CONTROL_LIMITS.elements,
    });
    if (top.type === "refused") {
      return top;
    }
    if (top.type === "read") {
      topPages.push({ frame: topFrame, read: top.result });
    }
  }
  const read = await readFrames({
    direction,
    frames,
    position: start.decoded?.p ?? { type: "viewport" },
    readFrame,
    startIndex: start.index,
  });
  if (read === null) {
    return { type: "stale-cursor" };
  }
  if ("type" in read) {
    return read;
  }
  const pages = [...topPages, ...read.pages];
  const top = pages.find(({ frame }) => frame.frameId === topFrame.frameId);
  const firstRead = read.reads.at(0);
  const lastRead = read.reads.at(-1);
  if (top === undefined || firstRead === undefined || lastRead === undefined) {
    return { type: "stale-cursor" };
  }
  return {
    type: "window",
    window: {
      documents: Object.fromEntries(
        pages.map(({ frame }) => [String(frame.frameId), frame.documentId]),
      ),
      ...windowElements(read.reads, top),
      facts: windowFacts(top.read),
      text: read.reads
        .map(({ window }) => window.text)
        .filter((text) => text !== "")
        .join("\n"),
      top: top.read,
      window: windowCursors({
        direction,
        firstRead,
        frames,
        lastRead,
        nextFrameIndex: read.nextFrameIndex,
      }),
    },
  };
};

const elementOf = (
  frame: ReaderFrame,
  element: PageElement,
  id: string,
): BrowserControlElement => ({
  ...(element.alternateName === undefined
    ? {}
    : { alternateName: element.alternateName }),
  context: element.context,
  href: element.href,
  id,
  name: element.name,
  ref: formatElementReference({ frameId: frame.frameId, path: element.path }),
  role: element.role,
  ...(element.value === undefined ? {} : { value: element.value }),
});

/**
 * The window's links, numbered as the text marks them; then its other
 * controls; then the top page's own controls: at most the element limit,
 * each ref once.
 */
const windowElements = (
  reads: readonly WindowRead[],
  top: { frame: ReaderFrame; read: FrameRead },
): Pick<PageWindow, "elements" | "elementsLeftOut"> => {
  const elements: BrowserControlElement[] = [];
  const refs = new Set<string>();
  let leftOut = top.read.pageControlsLeftOut;
  const add = (frame: ReaderFrame, element: PageElement, id: string) => {
    const listed = elementOf(frame, element, id);
    if (refs.has(listed.ref)) {
      return;
    }
    if (elements.length >= BROWSER_CONTROL_LIMITS.elements) {
      leftOut = true;
      return;
    }
    refs.add(listed.ref);
    elements.push(listed);
  };
  for (const { frame, window } of reads) {
    leftOut ||= window.linksLeftOut || window.controlsLeftOut;
    for (const link of window.links) {
      const { number, ...element } = link;
      add(frame, element, `L${String(number)}`);
    }
  }
  let controlNumber = 1;
  const addControl = (frame: ReaderFrame, element: PageElement) => {
    const before = elements.length;
    add(frame, element, `E${String(controlNumber)}`);
    if (elements.length > before) {
      controlNumber += 1;
    }
  };
  for (const { frame, window } of reads) {
    for (const control of window.controls) {
      addControl(frame, control);
    }
  }
  for (const control of top.read.pageControls) {
    addControl(top.frame, control);
  }
  return { elements, elementsLeftOut: leftOut };
};

const windowFacts = ({ facts }: FrameRead): BrowserControlSnapshot["facts"] => {
  if (facts === undefined) {
    return { meta: [] };
  }
  const { canonicalUrl, language, meta } = facts;
  return {
    ...(canonicalUrl === undefined ? {} : { canonicalUrl }),
    ...(language === undefined ? {} : { language }),
    meta,
  };
};

// ---- Find -------------------------------------------------------------------

type FindFrame = (
  frame: ReaderFrame,
  request: FindRequest,
) => Promise<FrameOutcome<FrameFound>>;

type FindSearch =
  | { query: string; type: typeof BROWSER_FIND_TYPE.text }
  | { query?: string | undefined; type: typeof BROWSER_FIND_TYPE.headings };

/** What `find` found, without the page it names; the host adds that. */
export type PageFound =
  | Omit<
      Extract<BrowserControlFound, { type: "headings" }>,
      "contentTrust" | "tabId" | "title" | "url"
    >
  | Omit<
      Extract<BrowserControlFound, { type: "text" }>,
      "contentTrust" | "tabId" | "title" | "url"
    >;

export type PageFindOutcome =
  | { found: PageFound; top: FrameFound | null; type: "found" }
  | { type: "invalid-cursor" }
  | { reason: FrameRefusal; type: "refused" }
  | { type: "stale-cursor" };

/**
 * What a find has gathered so far across frames. `resume` is where a later
 * find goes on after the last result returned.
 */
type FindProgress = {
  capped: boolean;
  headings: { cursor: string; level: number; text: string }[];
  matches: { cursor: string; snippet: string }[];
  resume: string | undefined;
  top: FrameFound | null;
  total: number;
};

/** Adds one frame's results; true when the search stops here. */
const addFound = (
  progress: FindProgress,
  frame: ReaderFrame,
  { found }: FrameFound,
  frameAfter: ReaderFrame | undefined,
): boolean => {
  if (found.type === BROWSER_FIND_TYPE.text) {
    for (const match of found.matches) {
      progress.matches.push({
        cursor: readCursor(frame, "forward", match.position),
        snippet: match.snippet,
      });
    }
    progress.total += found.total;
    if (found.last !== undefined) {
      progress.resume = scanCursor(frame, found.last);
    }
    progress.capped = found.totalCapped;
    return found.totalCapped;
  }
  for (const heading of found.headings) {
    progress.headings.push({
      cursor: readCursor(frame, "forward", heading.position),
      level: heading.level,
      text: heading.text,
    });
  }
  if (found.more !== undefined) {
    progress.resume = scanCursor(frame, found.more);
    return true;
  }
  if (
    progress.headings.length >= BROWSER_CONTROL_LIMITS.headings &&
    frameAfter !== undefined
  ) {
    progress.resume = scanCursor(frameAfter, { type: "start" });
    return true;
  }
  return false;
};

/** The request one frame gets, given what earlier frames found. */
const frameFindRequest = (
  search: FindSearch,
  after: FindRequest["after"],
  progress: FindProgress,
): FindRequest =>
  search.type === BROWSER_FIND_TYPE.text
    ? {
        after,
        countLimit: BROWSER_CONTROL_LIMITS.findCountLimit - progress.total,
        maxResults:
          BROWSER_CONTROL_LIMITS.findMatches - progress.matches.length,
        query: search.query,
        snippetChars: BROWSER_CONTROL_LIMITS.findSnippetChars,
        type: BROWSER_FIND_TYPE.text,
      }
    : {
        after,
        headingChars: BROWSER_CONTROL_LIMITS.headingChars,
        maxResults: BROWSER_CONTROL_LIMITS.headings - progress.headings.length,
        query: search.query ?? "",
        type: BROWSER_FIND_TYPE.headings,
      };

/**
 * Searches the frames in reading order, from the start or after a previous
 * `find`'s last result, until enough results are found; text matches are
 * counted to the end of the page, up to the count limit.
 */
export const findInPage = async ({
  after,
  findFrame,
  frames,
  search,
}: {
  after: string | undefined;
  findFrame: FindFrame;
  frames: readonly ReaderFrame[];
  search: FindSearch;
}): Promise<PageFindOutcome> => {
  const start = cursorFrame(after, "scan", frames);
  if ("type" in start) {
    return start;
  }
  const progress: FindProgress = {
    capped: false,
    headings: [],
    matches: [],
    resume: undefined,
    top: null,
    total: 0,
  };
  for (let index = start.index; index < frames.length; index += 1) {
    const frame = frames[index];
    if (frame === undefined) {
      break;
    }
    const resumed = index === start.index ? start.decoded : null;
    const outcome = await findFrame(
      frame,
      frameFindRequest(search, resumed?.p ?? { type: "start" }, progress),
    );
    if (outcome.type === "refused") {
      return outcome;
    }
    if (outcome.type === "skipped") {
      if (resumed !== null) {
        return { type: "stale-cursor" };
      }
      continue;
    }
    if (index === 0) {
      progress.top = outcome.result;
    }
    if (addFound(progress, frame, outcome.result, frames[index + 1])) {
      break;
    }
  }
  if (search.type === BROWSER_FIND_TYPE.text) {
    // More matches than were returned: go on after the last one.
    const more =
      progress.total > progress.matches.length || progress.capped
        ? progress.resume
        : undefined;
    return {
      found: {
        matches: progress.matches,
        ...(more === undefined ? {} : { more }),
        total: Math.min(progress.total, BROWSER_CONTROL_LIMITS.findCountLimit),
        totalCapped: progress.capped,
        type: BROWSER_FIND_TYPE.text,
      },
      top: progress.top,
      type: "found",
    };
  }
  return {
    found: {
      headings: progress.headings,
      ...(progress.resume === undefined ? {} : { more: progress.resume }),
      type: BROWSER_FIND_TYPE.headings,
    },
    top: progress.top,
    type: "found",
  };
};
