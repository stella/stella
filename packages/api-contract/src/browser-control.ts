import { panic } from "better-result";
import * as v from "valibot";

export const BROWSER_CONTROL_PROTOCOL_VERSION = 7 as const;
export const BROWSER_CONTROL_TOOL_NAME = "use-browser" as const;

/**
 * The hosted stella origins the store build bridges: every extension build
 * but `staging` trusts exactly these unless `WXT_STELLA_ORIGINS` names
 * others, so the store listing only helps users on one of them.
 */
export const PRODUCTION_STELLA_ORIGINS = [
  "https://app.stll.app",
  "https://my.stll.app",
] as const;

/** The Chrome Web Store id of the stella extension. */
export const BROWSER_EXTENSION_ID = "hdjfdkknlahegaifklbelmafmpooakmi" as const;

export const BROWSER_EXTENSION_STORE_URL =
  `https://chromewebstore.google.com/detail/${BROWSER_EXTENSION_ID}` as const;

/**
 * The name Chrome knows stella desktop's native messaging host by. The
 * extension reaches a coding agent on the member's computer through it; what
 * passes there never goes through stella's servers.
 */
export const STELLA_DESKTOP_NATIVE_HOST = "app.stll.browser" as const;

export const BROWSER_CONTROL_CONTENT_TRUST = {
  untrustedWebContent: "untrusted-web-content",
} as const;

export const BROWSER_CONTROL_ACTION = {
  click: "click",
  fill: "fill",
  /** Searches the page's visible text, or lists its headings; changes nothing. */
  find: "find",
  goBack: "go-back",
  open: "open",
  pressKey: "press-key",
  select: "select",
  snapshot: "snapshot",
  switchTab: "switch-tab",
} as const;

export const BROWSER_CONTROL_TARGET_METADATA = {
  absent: "absent",
  present: "present",
} as const;

export const BROWSER_CONTROL_KEYS = [
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "Backspace",
  "Enter",
  "Escape",
  "Space",
  "Tab",
] as const;

type BrowserControlKey = (typeof BROWSER_CONTROL_KEYS)[number];

/**
 * The keys a coding agent on the member's computer may press: submitting or
 * leaving a field and moving through a suggestion list. The extension
 * refuses any other key from stella desktop.
 */
export const BROWSER_DESKTOP_KEYS = [
  "Enter",
  "Escape",
  "Tab",
  "ArrowDown",
  "ArrowUp",
] as const satisfies readonly BrowserControlKey[];

export const BROWSER_CONTROL_LIMITS = {
  /** Text of the row, list item or form an element sits in; disambiguates identical controls. */
  contextChars: 200,
  /** An opaque reading position the extension issues (`snapshot` and `find`). */
  cursorChars: 1024,
  /** A link's aria-label or title kept beside its visible text. */
  elementAlternateNameChars: 120,
  elementNameChars: 500,
  elements: 300,
  errorMessageChars: 1000,
  executionReceipts: 32,
  /** Matches counted per `find`; `totalCapped` says when there are more. */
  findCountLimit: 1000,
  /** Matches returned per `find`, each with a cursor to read from. */
  findMatches: 10,
  findQueryChars: 200,
  findSnippetChars: 240,
  /** Frames one read pages through, top frame first. */
  frames: 16,
  headingChars: 300,
  /** Headings returned per `find` of headings. */
  headings: 50,
  /** Standard `<meta>` entries a snapshot reports for citing. */
  pageMetaEntries: 24,
  pageMetaNameChars: 100,
  pageMetaValueChars: 500,
  /**
   * Characters of page text one read returns: a window of whole blocks.
   * Any part of a page is reached through the window's cursors.
   */
  pageTextChars: 48_000,
  referenceChars: 256,
  revisionIdChars: 128,
  requestIdChars: 128,
  selectValueChars: 2000,
  /**
   * Tabs chat keeps at once, the controlled one included, and the most a
   * snapshot lists. A page-opened tab beyond it is closed, and `open` with
   * `newTab` is refused.
   */
  tabs: 8,
  /** Commands other than `snapshot` one extension connection may run. */
  sessionActions: 400,
  /** `open` and `go-back` commands one extension connection may run. */
  sessionNavigations: 150,
  titleChars: 1000,
  /** Commands other than `snapshot` one chat turn may run. */
  turnActions: 40,
  /** `open` and `go-back` commands one chat turn may run. */
  turnNavigations: 15,
  urlChars: 4096,
  valueChars: 10_000,
  /**
   * The largest file a stella desktop chat's tab may download. The
   * extension stops a larger one it can see coming; stella desktop
   * refuses whatever is larger once it is saved.
   */
  downloadBytes: 100 * 1024 * 1024,
  /** The file name a page suggests for a download, as reported. */
  downloadNameChars: 255,
  /** Where Chrome saved a download, as reported. */
  downloadPathChars: 4096,
} as const;

const boundedIdSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(BROWSER_CONTROL_LIMITS.requestIdChars),
);

const tabIdSchema = v.pipe(v.number(), v.integer(), v.minValue(0));

const revisionSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(BROWSER_CONTROL_LIMITS.revisionIdChars),
);

/**
 * An element reference is `e:<frameId>:<path>`. The path walks from the
 * frame's document element by child index; the segment `s` steps into the
 * current element's open shadow root. Frame 0 is the top frame.
 */
export type ElementReference = {
  frameId: number;
  path: string;
};

export const ELEMENT_REFERENCE_SHADOW_SEGMENT = "s" as const;

/**
 * `e:<frameId>:<path>`: path segments are child indexes joined by `.`, and a
 * single `s` segment between two indexes steps into an open shadow root.
 */
const ELEMENT_REFERENCE_PATTERN = new RegExp(
  `^e:(\\d+):(\\d+(?:\\.(?:${ELEMENT_REFERENCE_SHADOW_SEGMENT}\\.)?\\d+)*)$`,
  "u",
);

export const parseElementReference = (
  value: string,
): ElementReference | null => {
  if (value.length > BROWSER_CONTROL_LIMITS.referenceChars) {
    return null;
  }
  const match = ELEMENT_REFERENCE_PATTERN.exec(value);
  const frame = match?.[1];
  const path = match?.[2];
  if (frame === undefined || path === undefined) {
    return null;
  }
  return { frameId: Number(frame), path };
};

export const formatElementReference = ({
  frameId,
  path,
}: ElementReference): string => `e:${frameId}:${path}`;

const referenceSchema = v.pipe(
  v.string(),
  v.maxLength(BROWSER_CONTROL_LIMITS.referenceChars),
  v.regex(
    ELEMENT_REFERENCE_PATTERN,
    "Expected an element ref from the latest snapshot.",
  ),
);

const urlSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(BROWSER_CONTROL_LIMITS.urlChars),
);

const pageSchema = v.strictObject({
  revision: revisionSchema,
  url: urlSchema,
});

/**
 * A reading position the extension issued: opaque to everything but the
 * extension, and bound to the document it was read from. A cursor from a
 * document the tab no longer shows is refused as `stale-snapshot`.
 */
export const BROWSER_READER_CURSOR_PATTERN = /^r1\.[\w-]+$/u;

const cursorSchema = v.pipe(
  v.string(),
  v.maxLength(BROWSER_CONTROL_LIMITS.cursorChars),
  v.regex(
    BROWSER_READER_CURSOR_PATTERN,
    "Expected a cursor from a snapshot or find result.",
  ),
);

const contextSchema = v.pipe(
  v.string(),
  v.maxLength(BROWSER_CONTROL_LIMITS.contextChars),
);

export const browserControlTargetContextSchema = v.variant("type", [
  v.strictObject({
    type: v.literal(BROWSER_CONTROL_TARGET_METADATA.absent),
  }),
  v.strictObject({
    type: v.literal(BROWSER_CONTROL_TARGET_METADATA.present),
    value: contextSchema,
  }),
]);

export const browserControlTargetHrefSchema = v.variant("type", [
  v.strictObject({
    type: v.literal(BROWSER_CONTROL_TARGET_METADATA.absent),
  }),
  v.strictObject({
    type: v.literal(BROWSER_CONTROL_TARGET_METADATA.present),
    value: urlSchema,
  }),
]);

export type BrowserControlTargetMetadata = v.InferOutput<
  typeof browserControlTargetContextSchema
>;

const targetSchema = v.strictObject({
  /** Exact presence and value of enclosing row or form text copied from the snapshot. */
  context: browserControlTargetContextSchema,
  /** Exact presence and value of the link destination copied from the snapshot. */
  href: browserControlTargetHrefSchema,
  name: v.pipe(
    v.string(),
    v.maxLength(BROWSER_CONTROL_LIMITS.elementNameChars),
  ),
  ref: referenceSchema,
  role: v.pipe(v.string(), v.maxLength(100)),
});

const openActionSchema = v.strictObject({
  action: v.literal(BROWSER_CONTROL_ACTION.open),
  /** Open the page in a new tab chat controls from now on; the current one stays chat's. */
  newTab: v.optional(v.boolean()),
  url: urlSchema,
});

const snapshotActionSchema = v.strictObject({
  action: v.literal(BROWSER_CONTROL_ACTION.snapshot),
  /**
   * Where the window starts: a cursor from an earlier read or find. Omitted,
   * it starts at the first block in view when the page is scrolled or shows
   * a section anchor, and at the start of the document otherwise.
   */
  cursor: v.optional(cursorSchema),
});

const findQuerySchema = v.pipe(
  v.string(),
  v.maxLength(BROWSER_CONTROL_LIMITS.findQueryChars),
);

export const BROWSER_FIND_TYPE = {
  /** The document's headings, by the rule the reader marks them with. */
  headings: "headings",
  text: "text",
} as const;

const findActionSchema = v.strictObject({
  action: v.literal(BROWSER_CONTROL_ACTION.find),
  /** Continues after what a previous `find` returned (its `more`). */
  after: v.optional(cursorSchema),
  search: v.variant("type", [
    /**
     * Plain text, matched ignoring case and diacritics, any run of spaces
     * matching any run of spaces. Never a pattern.
     */
    v.strictObject({
      query: v.pipe(findQuerySchema, v.minLength(1)),
      type: v.literal(BROWSER_FIND_TYPE.text),
    }),
    /** Narrowed to headings containing `query`, matched the same way. */
    v.strictObject({
      query: v.optional(findQuerySchema),
      type: v.literal(BROWSER_FIND_TYPE.headings),
    }),
  ]),
});

const clickActionSchema = v.strictObject({
  action: v.literal(BROWSER_CONTROL_ACTION.click),
  page: pageSchema,
  target: targetSchema,
});

const fillActionSchema = v.strictObject({
  action: v.literal(BROWSER_CONTROL_ACTION.fill),
  page: pageSchema,
  target: targetSchema,
  value: v.pipe(v.string(), v.maxLength(BROWSER_CONTROL_LIMITS.valueChars)),
});

const selectActionSchema = v.strictObject({
  action: v.literal(BROWSER_CONTROL_ACTION.select),
  page: pageSchema,
  target: targetSchema,
  value: v.pipe(
    v.string(),
    v.maxLength(BROWSER_CONTROL_LIMITS.selectValueChars),
  ),
});

const pressKeyActionSchema = v.strictObject({
  action: v.literal(BROWSER_CONTROL_ACTION.pressKey),
  key: v.picklist(BROWSER_CONTROL_KEYS),
  page: pageSchema,
  target: targetSchema,
});

const goBackActionSchema = v.strictObject({
  action: v.literal(BROWSER_CONTROL_ACTION.goBack),
});

/**
 * Makes another of chat's tabs the controlled tab: one chat controlled
 * before, or one a page in chat's tabs opened, that the user has not
 * navigated themselves since. Snapshots list them under `tabs`. `url` is the
 * address chat knows the tab by; the tab must still be on its origin.
 */
const switchTabActionSchema = v.strictObject({
  action: v.literal(BROWSER_CONTROL_ACTION.switchTab),
  tabId: tabIdSchema,
  url: urlSchema,
});

export const browserControlCommandSchema = v.variant("action", [
  openActionSchema,
  snapshotActionSchema,
  findActionSchema,
  clickActionSchema,
  fillActionSchema,
  selectActionSchema,
  pressKeyActionSchema,
  goBackActionSchema,
  switchTabActionSchema,
]);

export type BrowserControlCommand = v.InferOutput<
  typeof browserControlCommandSchema
>;

export type BrowserControlElementCommand = Extract<
  BrowserControlCommand,
  { target: unknown }
>;

/**
 * An element's short id: `L<n>` for a link, which the window's text marks
 * as `[L<n>]` right after the link's words, and `E<n>` for any other
 * control; an element in a subframe carries the frame's id, `L4.12`. An
 * element keeps its id for as long as its document stays loaded, whatever
 * window lists it.
 */
export const BROWSER_ELEMENT_ID_PATTERN = /^[EL](?:\d{1,10}\.)?[1-9]\d{0,6}$/u;

const browserControlElementSchema = v.strictObject({
  /** A link's aria-label or title, kept when its visible text names it and they differ. */
  alternateName: v.optional(
    v.pipe(
      v.string(),
      v.maxLength(BROWSER_CONTROL_LIMITS.elementAlternateNameChars),
    ),
  ),
  context: browserControlTargetContextSchema,
  href: browserControlTargetHrefSchema,
  id: v.pipe(v.string(), v.regex(BROWSER_ELEMENT_ID_PATTERN)),
  name: v.pipe(
    v.string(),
    v.maxLength(BROWSER_CONTROL_LIMITS.elementNameChars),
  ),
  ref: referenceSchema,
  role: v.pipe(v.string(), v.maxLength(100)),
  value: v.optional(
    v.pipe(v.string(), v.maxLength(BROWSER_CONTROL_LIMITS.valueChars)),
  ),
});

export type BrowserControlElement = v.InferOutput<
  typeof browserControlElementSchema
>;

/**
 * One of chat's tabs; `active` marks the one the snapshot was read from.
 * No title: Chrome reports other tabs' titles without the page's redaction
 * of secret values, and the URL tells the tabs apart.
 */
const browserControlTabSchema = v.strictObject({
  active: v.boolean(),
  tabId: tabIdSchema,
  url: v.pipe(v.string(), v.maxLength(BROWSER_CONTROL_LIMITS.urlChars)),
});

export type BrowserControlTab = v.InferOutput<typeof browserControlTabSchema>;

const percentSchema = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(0),
  v.maxValue(100),
);

/** Where a window sits in the page, and how to move on from it. */
const browserControlWindowSchema = v.strictObject({
  /** Reads this window again, from its first block. */
  cursor: cursorSchema,
  /** How far down its document the window starts, by height: approximate. */
  fromPercent: percentSchema,
  /** Reads the blocks right after this window; absent at the end of the page. */
  next: v.optional(cursorSchema),
  /** Reads the blocks right before this window; absent at the start of the page. */
  previous: v.optional(cursorSchema),
  /** How far down its document the window ends, by height: approximate. */
  toPercent: percentSchema,
});

/**
 * What the page states about itself in standard markup, for citing: its
 * canonical link, its language and the `<meta>` entries that identify a
 * work (citation and Dublin Core fields, author, publisher, dates, Open
 * Graph title, site name and address). Untrusted like its text.
 */
const browserControlPageFactsSchema = v.strictObject({
  canonicalUrl: v.optional(urlSchema),
  language: v.optional(v.pipe(v.string(), v.maxLength(35))),
  meta: v.pipe(
    v.array(
      v.strictObject({
        name: v.pipe(
          v.string(),
          v.maxLength(BROWSER_CONTROL_LIMITS.pageMetaNameChars),
        ),
        value: v.pipe(
          v.string(),
          v.maxLength(BROWSER_CONTROL_LIMITS.pageMetaValueChars),
        ),
      }),
    ),
    v.maxLength(BROWSER_CONTROL_LIMITS.pageMetaEntries),
  ),
});

const browserControlSnapshotSchema = v.strictObject({
  contentTrust: v.literal(BROWSER_CONTROL_CONTENT_TRUST.untrustedWebContent),
  /**
   * The window's links, then its other controls, in reading order; then the
   * page's own controls outside the window (search fields, buttons).
   */
  elements: v.pipe(
    v.array(browserControlElementSchema),
    v.maxLength(BROWSER_CONTROL_LIMITS.elements),
  ),
  /** Some links or controls were left out of `elements`, and their links of the text's markers. */
  elementsLeftOut: v.boolean(),
  facts: browserControlPageFactsSchema,
  revision: revisionSchema,
  /**
   * The window's visible text, one block per line. A heading's line starts
   * with one `#` per level; a link's words are followed by `[L<n>]`.
   */
  text: v.pipe(v.string(), v.maxLength(BROWSER_CONTROL_LIMITS.pageTextChars)),
  window: browserControlWindowSchema,
  /** The Chrome tab the snapshot was read from. */
  tabId: tabIdSchema,
  /** Chat's tabs, the active one first; `switch-tab` moves control to another. */
  tabs: v.pipe(
    v.array(browserControlTabSchema),
    v.maxLength(BROWSER_CONTROL_LIMITS.tabs),
  ),
  title: v.pipe(v.string(), v.maxLength(BROWSER_CONTROL_LIMITS.titleChars)),
  url: v.pipe(v.string(), v.maxLength(BROWSER_CONTROL_LIMITS.urlChars)),
});

export type BrowserControlSnapshot = v.InferOutput<
  typeof browserControlSnapshotSchema
>;

/** The page a `find` searched, as a snapshot names it. */
const foundPageEntries = {
  contentTrust: v.literal(BROWSER_CONTROL_CONTENT_TRUST.untrustedWebContent),
  /** Continues after these results with `find` and `after`; absent when there are no more. */
  more: v.optional(cursorSchema),
  tabId: tabIdSchema,
  title: v.pipe(v.string(), v.maxLength(BROWSER_CONTROL_LIMITS.titleChars)),
  url: v.pipe(v.string(), v.maxLength(BROWSER_CONTROL_LIMITS.urlChars)),
};

/**
 * What a `find` found in the text the reader returns, block by block, in
 * document order: hidden text never matches, and text a page draws only
 * with CSS (a list number, a symbol) matches together with words of the
 * page's own text. Each cursor reads from the start of the block a match
 * or heading is in.
 */
const browserControlFoundSchema = v.variant("type", [
  v.strictObject({
    ...foundPageEntries,
    matches: v.pipe(
      v.array(
        v.strictObject({
          cursor: cursorSchema,
          snippet: v.pipe(
            v.string(),
            v.maxLength(BROWSER_CONTROL_LIMITS.findSnippetChars),
          ),
        }),
      ),
      v.maxLength(BROWSER_CONTROL_LIMITS.findMatches),
    ),
    /** Matches from where this search started to the end of the page. */
    total: v.pipe(
      v.number(),
      v.integer(),
      v.minValue(0),
      v.maxValue(BROWSER_CONTROL_LIMITS.findCountLimit),
    ),
    /** More matches exist than `total` counts. */
    totalCapped: v.boolean(),
    type: v.literal(BROWSER_FIND_TYPE.text),
  }),
  v.strictObject({
    ...foundPageEntries,
    headings: v.pipe(
      v.array(
        v.strictObject({
          cursor: cursorSchema,
          level: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(6)),
          text: v.pipe(
            v.string(),
            v.maxLength(BROWSER_CONTROL_LIMITS.headingChars),
          ),
        }),
      ),
      v.maxLength(BROWSER_CONTROL_LIMITS.headings),
    ),
    type: v.literal(BROWSER_FIND_TYPE.headings),
  }),
]);

export type BrowserControlFound = v.InferOutput<
  typeof browserControlFoundSchema
>;

export const BROWSER_CONTROL_ERROR_CODE = {
  /** The chat turn or the extension connection used up its action or navigation budget. */
  budgetExceeded: "budget-exceeded",
  /** Stopped from chat or the extension before the command reached the page. */
  cancelled: "cancelled",
  controllerBusy: "controller-busy",
  disconnected: "disconnected",
  elementNotFound: "element-not-found",
  executionFailed: "execution-failed",
  invalidCommand: "invalid-command",
  navigationFailed: "navigation-failed",
  /**
   * The page asks for a sign-in (a password or one-time-code field, or an
   * identity provider's page). The member signs in themselves; nothing on
   * that page was read, typed or clicked. After a click or fill it names
   * the page the action led to: the action itself ran. Only commands from
   * stella desktop get it so far; a web connection reads such a page with
   * its secret fields withheld.
   */
  needsMember: "needs-member",
  noControlledTab: "no-controlled-tab",
  /**
   * The command reached the page but its outcome was not observed (timeout,
   * lost connection, or the page failed after the action ran). It may have
   * taken effect: read the page before retrying a mutating command.
   */
  outcomeUnknown: "outcome-unknown",
  permissionDenied: "permission-denied",
  /** `open` landed on another origin than approved; the page was not read. */
  redirected: "redirected",
  replayStateUnknown: "replay-state-unknown",
  sensitiveField: "sensitive-field",
  staleController: "stale-controller",
  staleSnapshot: "stale-snapshot",
  /** The controlled tab changed since the page was last read; take a snapshot first. */
  tabChanged: "tab-changed",
  tabClosed: "tab-closed",
  /** `open` with `newTab` while chat already has the most tabs it may keep. */
  tabLimitReached: "tab-limit-reached",
  timedOut: "timed-out",
  unsupportedPage: "unsupported-page",
} as const;

export type BrowserControlErrorCode =
  (typeof BROWSER_CONTROL_ERROR_CODE)[keyof typeof BROWSER_CONTROL_ERROR_CODE];

const browserControlSuccessSchema = v.strictObject({
  protocolVersion: v.literal(BROWSER_CONTROL_PROTOCOL_VERSION),
  snapshot: browserControlSnapshotSchema,
  status: v.literal("success"),
});

/** A `find` ran: it read the page but changed nothing, not even the snapshot click and fill address. */
const browserControlFoundResultSchema = v.strictObject({
  found: browserControlFoundSchema,
  protocolVersion: v.literal(BROWSER_CONTROL_PROTOCOL_VERSION),
  status: v.literal("found"),
});

const browserControlErrorSchema = v.strictObject({
  code: v.picklist(Object.values(BROWSER_CONTROL_ERROR_CODE)),
  message: v.pipe(
    v.string(),
    v.maxLength(BROWSER_CONTROL_LIMITS.errorMessageChars),
  ),
  protocolVersion: v.literal(BROWSER_CONTROL_PROTOCOL_VERSION),
  status: v.literal("error"),
});

export const browserControlResultSchema = v.variant("status", [
  browserControlSuccessSchema,
  browserControlFoundResultSchema,
  browserControlErrorSchema,
]);

export type BrowserControlResult = v.InferOutput<
  typeof browserControlResultSchema
>;

/**
 * Read in place of a page snapshot a later one replaced: the snapshot's text
 * and refs are gone and its refs are stale.
 */
export const SUPERSEDED_BROWSER_SNAPSHOT_NOTE =
  "Superseded by a later page read: this page's text and element refs are no longer in context and its refs are stale. Call `snapshot` (on its tab) to read it again.";

/**
 * A successful result whose page snapshot a later result replaced, as chat
 * keeps it: the page it was on, without its text or elements. Chat stores,
 * streams and shows the model this in place of every page but the newest
 * (see `chat-tool-result-retention`).
 */
const browserControlSupersededSchema = v.strictObject({
  note: v.pipe(v.string(), v.maxLength(1000)),
  page: v.strictObject({
    contentTrust: v.literal(BROWSER_CONTROL_CONTENT_TRUST.untrustedWebContent),
    /** Reads the superseded window again while its document is still shown. */
    cursor: v.optional(cursorSchema),
    /** For a superseded `find`: its results after those it returned. */
    more: v.optional(cursorSchema),
    tabId: tabIdSchema,
    title: v.pipe(v.string(), v.maxLength(BROWSER_CONTROL_LIMITS.titleChars)),
    url: v.pipe(v.string(), v.maxLength(BROWSER_CONTROL_LIMITS.urlChars)),
  }),
  protocolVersion: v.literal(BROWSER_CONTROL_PROTOCOL_VERSION),
  status: v.literal("superseded"),
});

/** Read in place of `find` results a later page read or find replaced. */
export const SUPERSEDED_BROWSER_FIND_NOTE =
  "Superseded by a later page read: these find results are no longer in context. Call `find` again, or pass `more` as `after` for the results after them.";

/**
 * Every output chat keeps for a `use-browser` call: what the extension
 * returned, or its superseded projection. The extension never returns the
 * projection; `parseBrowserControlResult` rejects it.
 */
export const browserControlRetainedResultSchema = v.variant("status", [
  browserControlSuccessSchema,
  browserControlFoundResultSchema,
  browserControlErrorSchema,
  browserControlSupersededSchema,
]);

export type BrowserControlRetainedResult = v.InferOutput<
  typeof browserControlRetainedResultSchema
>;

/**
 * The projection of a result a later page read replaced, or `null` for one
 * that carries no page (an error, or a result already projected).
 */
export const supersedeBrowserControlResult = (
  output: unknown,
): BrowserControlRetainedResult | null => {
  const found = v.safeParse(browserControlFoundResultSchema, output);
  if (found.success) {
    const { contentTrust, more, tabId, title, url } = found.output.found;
    return {
      note: SUPERSEDED_BROWSER_FIND_NOTE,
      page: {
        contentTrust,
        ...(more === undefined ? {} : { more }),
        tabId,
        title,
        url,
      },
      protocolVersion: found.output.protocolVersion,
      status: "superseded",
    };
  }
  const result = v.safeParse(browserControlSuccessSchema, output);
  if (!result.success) {
    return null;
  }
  const { snapshot } = result.output;
  return {
    note: SUPERSEDED_BROWSER_SNAPSHOT_NOTE,
    page: {
      contentTrust: snapshot.contentTrust,
      cursor: snapshot.window.cursor,
      tabId: snapshot.tabId,
      title: snapshot.title,
      url: snapshot.url,
    },
    protocolVersion: result.output.protocolVersion,
    status: "superseded",
  };
};

export const BROWSER_EXTENSION_MESSAGE_SOURCE = {
  /** stella desktop, through the native messaging host. */
  desktop: "stella-desktop",
  extension: "stella-browser-extension",
  web: "stella-web",
} as const;

const requestIdSchema = boundedIdSchema;
const controllerIdSchema = boundedIdSchema;
const toolCallIdSchema = boundedIdSchema;

const browserExtensionPingRequestSchema = v.strictObject({
  protocolVersion: v.literal(BROWSER_CONTROL_PROTOCOL_VERSION),
  requestId: requestIdSchema,
  source: v.literal(BROWSER_EXTENSION_MESSAGE_SOURCE.web),
  type: v.literal("ping"),
});

/**
 * The tab and snapshot the web client last saw a result for. The extension
 * refuses a navigation or action when the controlled tab or its latest
 * snapshot is no longer this one.
 */
const observedTabSchema = v.strictObject({
  revision: revisionSchema,
  tabId: tabIdSchema,
});

export type BrowserObservedTab = v.InferOutput<typeof observedTabSchema>;

const browserExtensionCommandRequestSchema = v.strictObject({
  command: browserControlCommandSchema,
  controllerId: controllerIdSchema,
  observedTab: v.nullable(observedTabSchema),
  protocolVersion: v.literal(BROWSER_CONTROL_PROTOCOL_VERSION),
  requestId: requestIdSchema,
  source: v.literal(BROWSER_EXTENSION_MESSAGE_SOURCE.web),
  toolCallId: toolCallIdSchema,
  /** The chat turn the command belongs to; per-turn budgets count by it. */
  turnId: boundedIdSchema,
  type: v.literal("command"),
});

/**
 * Stops the controller's queued or running command of one chat turn; a
 * command of a later turn is never touched. Nothing is answered.
 */
const browserExtensionCancelRequestSchema = v.strictObject({
  controllerId: controllerIdSchema,
  protocolVersion: v.literal(BROWSER_CONTROL_PROTOCOL_VERSION),
  requestId: requestIdSchema,
  source: v.literal(BROWSER_EXTENSION_MESSAGE_SOURCE.web),
  turnId: boundedIdSchema,
  type: v.literal("cancel"),
});

export const browserExtensionRequestSchema = v.variant("type", [
  browserExtensionPingRequestSchema,
  browserExtensionCommandRequestSchema,
  browserExtensionCancelRequestSchema,
]);

export type BrowserExtensionRequest = v.InferOutput<
  typeof browserExtensionRequestSchema
>;

const browserExtensionPongResponseSchema = v.strictObject({
  allSitesGranted: v.boolean(),
  /** The tab chat currently operates, or null when none is controlled. */
  controlledTabId: v.nullable(tabIdSchema),
  controllerId: v.nullable(controllerIdSchema),
  protocolVersion: v.literal(BROWSER_CONTROL_PROTOCOL_VERSION),
  requestId: requestIdSchema,
  source: v.literal(BROWSER_EXTENSION_MESSAGE_SOURCE.extension),
  type: v.literal("pong"),
});

const browserExtensionCommandResponseSchema = v.strictObject({
  protocolVersion: v.literal(BROWSER_CONTROL_PROTOCOL_VERSION),
  requestId: requestIdSchema,
  result: browserControlResultSchema,
  source: v.literal(BROWSER_EXTENSION_MESSAGE_SOURCE.extension),
  type: v.literal("command-result"),
});

export const browserExtensionResponseSchema = v.variant("type", [
  browserExtensionPongResponseSchema,
  browserExtensionCommandResponseSchema,
]);

export type BrowserExtensionResponse = v.InferOutput<
  typeof browserExtensionResponseSchema
>;

export const BROWSER_EXTENSION_STATUS = {
  checking: "checking",
  connected: "connected",
  needsSiteAccess: "needs-site-access",
  notInstalled: "not-installed",
  notPaired: "not-paired",
  /** The installed extension speaks an older protocol; Chrome updates it from the store. */
  extensionOutdated: "extension-outdated",
  /** The installed extension speaks a newer protocol than this stella tab; a reload catches up. */
  stellaOutdated: "stella-outdated",
  /** A computer whose browser cannot run the extension (Safari, Firefox). */
  unsupportedBrowser: "unsupported-browser",
  /** A phone or tablet, or a client that is not a browser at all. */
  unsupportedDevice: "unsupported-device",
} as const;

export type BrowserExtensionStatus =
  (typeof BROWSER_EXTENSION_STATUS)[keyof typeof BROWSER_EXTENSION_STATUS];

export type BrowserExtensionCapability = {
  [Status in BrowserExtensionStatus]: {
    protocolVersion: number;
    status: Status;
  };
}[BrowserExtensionStatus];

export const isReadOnlyBrowserCommand = (
  command: BrowserControlCommand,
): boolean => {
  switch (command.action) {
    case BROWSER_CONTROL_ACTION.snapshot:
    case BROWSER_CONTROL_ACTION.find:
      return true;
    // History can hold pages the user never approved, and `popstate`
    // handlers can change page state, so going back is a navigation.
    // Switching tabs moves chat to a page the user approves first.
    case BROWSER_CONTROL_ACTION.goBack:
    case BROWSER_CONTROL_ACTION.switchTab:
    case BROWSER_CONTROL_ACTION.click:
    case BROWSER_CONTROL_ACTION.fill:
    case BROWSER_CONTROL_ACTION.open:
    case BROWSER_CONTROL_ACTION.pressKey:
    case BROWSER_CONTROL_ACTION.select:
      return false;
    default:
      command satisfies never;
      return panic("Unhandled browser command action");
  }
};

export const parseBrowserControlCommand = (input: unknown) => {
  const result = v.safeParse(browserControlCommandSchema, input);
  return result.success ? result.output : null;
};

export const parseBrowserControlResult = (input: unknown) => {
  const result = v.safeParse(browserControlResultSchema, input);
  if (!result.success) {
    return null;
  }
  if (
    result.output.status === "success" &&
    (result.output.snapshot.elements.some(
      ({ ref }) => parseElementReference(ref) === null,
    ) ||
      new Set(result.output.snapshot.elements.map(({ id }) => id)).size !==
        result.output.snapshot.elements.length)
  ) {
    return null;
  }
  return result.output;
};

export const parseBrowserExtensionRequest = (input: unknown) => {
  const result = v.safeParse(browserExtensionRequestSchema, input);
  if (!result.success) {
    return null;
  }
  if (
    result.output.type === "command" &&
    parseBrowserControlCommand(result.output.command) === null
  ) {
    return null;
  }
  return result.output;
};

/**
 * Only the source and version of an extension message, for one whose full
 * shape belongs to another protocol version: every version keeps these two
 * fields, so an extension on either side of an upgrade is still recognised.
 */
const browserExtensionPeerSchema = v.object({
  protocolVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
  source: v.literal(BROWSER_EXTENSION_MESSAGE_SOURCE.extension),
});

/** The protocol version an extension message names, whatever its shape. */
export const parseBrowserExtensionPeerVersion = (
  input: unknown,
): number | null => {
  const result = v.safeParse(browserExtensionPeerSchema, input);
  return result.success ? result.output.protocolVersion : null;
};

export const parseBrowserExtensionResponse = (input: unknown) => {
  const result = v.safeParse(browserExtensionResponseSchema, input);
  if (!result.success) {
    return null;
  }
  if (
    result.output.type === "command-result" &&
    parseBrowserControlResult(result.output.result) === null
  ) {
    return null;
  }
  return result.output;
};

/**
 * A command from a coding agent on the member's computer, relayed by stella
 * desktop's native messaging host. `controllerId` names the chat the agent
 * runs in; the extension keeps it apart from every web connection's id.
 */
const desktopCommandRequestSchema = v.strictObject({
  command: browserControlCommandSchema,
  controllerId: controllerIdSchema,
  observedTab: v.nullable(observedTabSchema),
  protocolVersion: v.literal(BROWSER_CONTROL_PROTOCOL_VERSION),
  requestId: requestIdSchema,
  source: v.literal(BROWSER_EXTENSION_MESSAGE_SOURCE.desktop),
  toolCallId: toolCallIdSchema,
  /** The agent's run; per-turn budgets count by it. */
  turnId: boundedIdSchema,
  type: v.literal("command"),
});

/** Stops the queued or running command of one run, as a web cancel does. */
const desktopCancelRequestSchema = v.strictObject({
  controllerId: controllerIdSchema,
  protocolVersion: v.literal(BROWSER_CONTROL_PROTOCOL_VERSION),
  source: v.literal(BROWSER_EXTENSION_MESSAGE_SOURCE.desktop),
  turnId: boundedIdSchema,
  type: v.literal("cancel"),
});

/**
 * stella desktop's first message once it reaches the extension; the
 * extension answers with its own `hello`. Either side may speak another
 * protocol version, so the version is read whatever it is.
 */
const desktopHelloRequestSchema = v.strictObject({
  protocolVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
  source: v.literal(BROWSER_EXTENSION_MESSAGE_SOURCE.desktop),
  type: v.literal("hello"),
});

const browserDesktopRequestSchema = v.variant("type", [
  desktopHelloRequestSchema,
  desktopCommandRequestSchema,
  desktopCancelRequestSchema,
]);

export type BrowserDesktopRequest = v.InferOutput<
  typeof browserDesktopRequestSchema
>;

export const parseBrowserDesktopRequest = (
  input: unknown,
): BrowserDesktopRequest | null => {
  const result = v.safeParse(browserDesktopRequestSchema, input);
  return result.success ? result.output : null;
};

/**
 * The extension's answer to stella desktop's `hello`: the protocol it
 * speaks, so stella desktop can tell an outdated extension apart from one
 * that never answers.
 */
const desktopHelloResponseSchema = v.strictObject({
  protocolVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
  source: v.literal(BROWSER_EXTENSION_MESSAGE_SOURCE.extension),
  type: v.literal("hello"),
});

/**
 * The folder, inside Chrome's download folder, where the extension has
 * Chrome save a PDF a stella desktop chat's tab downloads. stella desktop
 * moves it from there into the chat's folder.
 */
export const BROWSER_DOWNLOAD_STAGING_FOLDER = "stella-downloads" as const;

/** A staged file's name: a fresh UUID, so no page chooses it and none collides. */
export const BROWSER_DOWNLOAD_STAGED_NAME_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$/u;

/** The path, relative to Chrome's download folder, Chrome saves a staged file at. */
export const browserDownloadStagedPath = (uuid: string): string =>
  `${BROWSER_DOWNLOAD_STAGING_FOLDER}/${uuid}.pdf`;

/** Why the extension stopped a download a stella desktop chat's tab started. */
export const BROWSER_DOWNLOAD_STOP_REASON = {
  /** Neither its type nor its name says PDF. */
  notPdf: "not-pdf",
  /** Chrome said it is larger than `BROWSER_CONTROL_LIMITS.downloadBytes`. */
  tooLarge: "too-large",
  /** Too many of the chat's downloads were still running. */
  tooMany: "too-many",
  /** Chrome could not finish it. */
  interrupted: "interrupted",
} as const;

type DownloadStopReasons = typeof BROWSER_DOWNLOAD_STOP_REASON;

export type BrowserDownloadStopReason =
  DownloadStopReasons[keyof DownloadStopReasons];

const downloadNameSchema = v.pipe(
  v.string(),
  v.maxLength(BROWSER_CONTROL_LIMITS.downloadNameChars),
);

/** The address a download came from; clipped, so a long `data:` URL still reports. */
const downloadSourceUrlSchema = v.pipe(
  v.string(),
  v.maxLength(BROWSER_CONTROL_LIMITS.urlChars),
);

const browserDownloadSchema = v.variant("outcome", [
  v.strictObject({
    outcome: v.literal("saved"),
    /** Bytes Chrome wrote; stella desktop checks the file itself. */
    bytes: v.pipe(v.number(), v.integer(), v.minValue(0)),
    mime: v.pipe(v.string(), v.maxLength(255)),
    /** Where Chrome saved the file, as Chrome reports it. */
    path: v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(BROWSER_CONTROL_LIMITS.downloadPathChars),
    ),
    sourceUrl: downloadSourceUrlSchema,
    /** The file name the page or server suggested. */
    suggestedName: downloadNameSchema,
  }),
  v.strictObject({
    outcome: v.literal("stopped"),
    reason: v.picklist(Object.values(BROWSER_DOWNLOAD_STOP_REASON)),
    sourceUrl: downloadSourceUrlSchema,
    suggestedName: downloadNameSchema,
  }),
]);

export type BrowserDownload = v.InferOutput<typeof browserDownloadSchema>;

/**
 * A download a stella desktop chat's tab started, once Chrome finished or
 * the extension stopped it. Sent unasked; `controllerId` is the chat's id
 * as stella desktop sent it with the chat's commands.
 */
const desktopDownloadResponseSchema = v.strictObject({
  controllerId: controllerIdSchema,
  download: browserDownloadSchema,
  protocolVersion: v.literal(BROWSER_CONTROL_PROTOCOL_VERSION),
  source: v.literal(BROWSER_EXTENSION_MESSAGE_SOURCE.extension),
  type: v.literal("download"),
});

export type BrowserDesktopDownload = v.InferOutput<
  typeof desktopDownloadResponseSchema
>;

const browserDesktopResponseSchema = v.variant("type", [
  desktopHelloResponseSchema,
  browserExtensionCommandResponseSchema,
  desktopDownloadResponseSchema,
]);

export type BrowserDesktopResponse = v.InferOutput<
  typeof browserDesktopResponseSchema
>;

export const parseBrowserDesktopResponse = (
  input: unknown,
): BrowserDesktopResponse | null => {
  const result = v.safeParse(browserDesktopResponseSchema, input);
  if (!result.success) {
    return null;
  }
  if (
    result.output.type === "command-result" &&
    parseBrowserControlResult(result.output.result) === null
  ) {
    return null;
  }
  return result.output;
};
