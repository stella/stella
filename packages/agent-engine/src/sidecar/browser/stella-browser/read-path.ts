import { panic, Result } from "better-result";
import * as v from "valibot";

import {
  BROWSER_CONTROL_CONTENT_TRUST,
  BROWSER_CONTROL_ERROR_CODE,
  BROWSER_CONTROL_LIMITS,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_CONTROL_TARGET_METADATA,
  type BrowserControlCommand,
  type BrowserControlResult,
  type BrowserControlTab,
  ELEMENT_REFERENCE_SHADOW_SEGMENT,
  parseBrowserControlResult,
} from "@stll/api-contract/browser-control";
import { browserControlError } from "@stll/browser-page/browser-control-result";
import type { OriginPolicy } from "@stll/browser-page/origin-policy";
import {
  type FindRequest,
  type PageOperation,
  pageScript,
  SNAPSHOT_PURPOSE,
} from "@stll/browser-page/page-script";
import {
  findInPage,
  frameFoundSchema,
  type FrameOutcome,
  frameReadSchema,
  type PageReadFailure,
  type ReaderFrame,
  readPageWindow,
} from "@stll/browser-page/page-window";
import {
  IDENTITY_PROVIDER_HOSTS,
  isIdentityProviderUrl,
  needsMember,
  SIGN_IN_POLICY,
} from "@stll/browser-page/sign-in-policy";

import type { CdpClient, CdpFailure, CdpFrameTree } from "./cdp-client";
import { frameNumberOf, type OwnedTab, TOP_FRAME_NUMBER } from "./targets";

/**
 * The stella browser's read path: open a page in a chat's tab, read it a
 * window at a time, find in it and list its headings. Each frame runs the
 * one page script the extension runs (`@stll/browser-page/page-script`),
 * in an isolated world the holder creates for that document: the page's
 * own scripts can neither see it nor reach its answers. The rules around
 * it (origin policy, sign-in handoff, document identity) are the
 * extension's, re-checked here on the document actually read.
 *
 * Interim: the extension's executor holds the same orchestration over
 * Chrome's APIs; both move onto one shared module in the next slice.
 */

/** The page script's source, as every frame receives it. */
const PAGE_SCRIPT_SOURCE = pageScript.toString();

const NAVIGATION_TIMEOUT_MS = 15_000;
const PAGE_SETTLE_MS = 250;
const WORLD_NAME = "stella";

const UNSUPPORTED_PAGE_MESSAGE =
  "Only public HTTPS pages can be read. Open one first.";
const STALE_CURSOR_MESSAGE =
  "The page changed since this cursor was issued. Call snapshot without a cursor, or find, to read it again.";

/** A frame's answer when it read nothing. */
const pageRefusalSchema = v.strictObject({
  refused: v.picklist(["sign-in", "stale-cursor", "top-origin"]),
});

const signInRefusalSchema = v.strictObject({ refused: v.literal("sign-in") });

/** One frame of a tab as the protocol knows it. */
type TabFrame = {
  cdpFrameId: string;
  loaderId: string;
  /** The session that owns the frame: the tab's, or an out-of-process frame's own. */
  sessionId: string;
  number: number;
};

export type ReadContext = {
  client: CdpClient;
  policy: OriginPolicy;
  signal: AbortSignal;
  tab: OwnedTab;
  /** The isolated world of each document, by session, frame and loader. */
  worlds: Map<string, number>;
  /** The chat's tabs, the one read first, for the snapshot's tab list. */
  chatTabs: () => OwnedTab[];
};

const failed = (message: string): BrowserControlResult =>
  browserControlError(BROWSER_CONTROL_ERROR_CODE.executionFailed, message);

const unsupportedPage = (): BrowserControlResult =>
  browserControlError(
    BROWSER_CONTROL_ERROR_CODE.unsupportedPage,
    UNSUPPORTED_PAGE_MESSAGE,
  );

/** The document id a cursor binds to: the frame and its loader, which a new document changes. */
const documentIdOf = ({ cdpFrameId, loaderId }: TabFrame) =>
  `${cdpFrameId}:${loaderId}`;

const worldKey = ({ cdpFrameId, loaderId, sessionId }: TabFrame) =>
  `${sessionId} ${cdpFrameId} ${loaderId}`;

/**
 * The tab's frames, the top frame first, then by number: those in the
 * tab's process from its frame tree, and each frame in another process
 * from its own session's tree.
 */
const listFrames = async ({
  client,
  signal,
  tab,
}: ReadContext): Promise<Result<TabFrame[], CdpFailure>> => {
  const frames: TabFrame[] = [];
  const walk = (node: CdpFrameTree, sessionId: string, root: string) => {
    const { id, loaderId } = node.frame;
    // A frame in another process is read through its own session.
    if (id !== root && tab.frameSessions.has(id)) {
      return;
    }
    frames.push({
      cdpFrameId: id,
      loaderId,
      number: frameNumberOf(tab, id),
      sessionId,
    });
    for (const child of node.childFrames ?? []) {
      walk(child, sessionId, root);
    }
  };
  const top = await client.send(
    "Page.getFrameTree",
    {},
    { sessionId: tab.sessionId, signal },
  );
  if (Result.isError(top)) {
    return top;
  }
  walk(top.value.frameTree, tab.sessionId, tab.targetId);
  for (const [frameId, sessionId] of tab.frameSessions) {
    const tree = await client.send(
      "Page.getFrameTree",
      {},
      { sessionId, signal },
    );
    // A frame that went away in between is passed over.
    if (Result.isOk(tree)) {
      walk(tree.value.frameTree, sessionId, frameId);
    }
  }
  return Result.ok(
    frames
      .toSorted((left, right) => left.number - right.number)
      .slice(0, BROWSER_CONTROL_LIMITS.frames),
  );
};

/** The isolated world for the frame's document, created once per document. */
const worldFor = async (
  { client, signal, worlds }: ReadContext,
  frame: TabFrame,
): Promise<Result<number, CdpFailure>> => {
  const key = worldKey(frame);
  const known = worlds.get(key);
  if (known !== undefined) {
    return Result.ok(known);
  }
  const created = await client.send(
    "Page.createIsolatedWorld",
    {
      frameId: frame.cdpFrameId,
      grantUniveralAccess: false,
      worldName: WORLD_NAME,
    },
    { sessionId: frame.sessionId, signal },
  );
  if (Result.isError(created)) {
    return created;
  }
  // The frame's earlier documents are gone; so are their worlds.
  for (const other of worlds.keys()) {
    if (other.startsWith(`${frame.sessionId} ${frame.cdpFrameId} `)) {
      worlds.delete(other);
    }
  }
  worlds.set(key, created.value.executionContextId);
  return Result.ok(created.value.executionContextId);
};

/**
 * What a frame answered the page script's run with, or that it could not
 * be reached (gone, or in a process that crashed) or the script failed
 * there: such a subframe is passed over, as the extension passes it.
 */
type FrameAnswer =
  { type: "answered"; value: unknown } | { type: "unreachable" };

const UNREACHABLE: FrameAnswer = { type: "unreachable" };

/**
 * Runs the page script with `operation` in the frame's document. A world
 * that went with its document is made again once.
 */
const runInFrame = async (
  context: ReadContext,
  frame: TabFrame,
  operation: PageOperation,
): Promise<FrameAnswer> => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const world = await worldFor(context, frame);
    if (Result.isError(world)) {
      return UNREACHABLE;
    }
    const called = await context.client.send(
      "Runtime.callFunctionOn",
      {
        arguments: [{ value: operation }],
        awaitPromise: true,
        executionContextId: world.value,
        functionDeclaration: PAGE_SCRIPT_SOURCE,
        returnByValue: true,
      },
      { sessionId: frame.sessionId, signal: context.signal },
    );
    if (Result.isOk(called)) {
      return called.value.exceptionDetails === undefined
        ? { type: "answered", value: called.value.result.value }
        : UNREACHABLE;
    }
    if (called.error.type !== "protocol") {
      return UNREACHABLE;
    }
    context.worlds.delete(worldKey(frame));
  }
  return UNREACHABLE;
};

/** What every read-only page operation carries. */
const readOperationBase = () => ({
  identityProviderHosts: IDENTITY_PROVIDER_HOSTS,
  limits: BROWSER_CONTROL_LIMITS,
  metadataType: BROWSER_CONTROL_TARGET_METADATA,
  shadowSegment: ELEMENT_REFERENCE_SHADOW_SEGMENT,
  signIn: SIGN_IN_POLICY.handToMember,
  signInPolicies: SIGN_IN_POLICY,
});

/**
 * A frame's answer, held to the origin policy: a subframe outside it is
 * passed over unread. The top frame's address is checked on the whole read.
 */
const frameOutcome = <T extends { origin: string; url: string }>(
  policy: OriginPolicy,
  frame: ReaderFrame,
  answer: FrameAnswer,
  schema: v.GenericSchema<unknown, T>,
): FrameOutcome<T> => {
  if (answer.type === "unreachable") {
    return { type: "skipped" };
  }
  const refusal = v.safeParse(pageRefusalSchema, answer.value);
  if (refusal.success) {
    return { reason: refusal.output.refused, type: "refused" };
  }
  const parsed = v.safeParse(schema, answer.value);
  if (!parsed.success) {
    return { type: "invalid" };
  }
  if (
    frame.frameId !== TOP_FRAME_NUMBER &&
    !policy.isControllableFrame({
      isTopFrame: false,
      origin: parsed.output.origin,
      url: parsed.output.url,
    })
  ) {
    return { type: "skipped" };
  }
  return { result: parsed.output, type: "read" };
};

/** A read that could not start, or a frame that refused it. */
const readRefusal = (outcome: PageReadFailure): BrowserControlResult => {
  switch (outcome.type) {
    case "invalid-cursor":
      return browserControlError(
        BROWSER_CONTROL_ERROR_CODE.invalidCommand,
        "This cursor is not one a read of this page issued. Use a cursor from the latest snapshot or find result.",
      );
    case "stale-cursor":
      return browserControlError(
        BROWSER_CONTROL_ERROR_CODE.staleSnapshot,
        STALE_CURSOR_MESSAGE,
      );
    case "unreadable-page":
      return failed("The page returned a read outside the protocol bounds.");
    case "refused":
      switch (outcome.reason) {
        case "sign-in":
          return needsMember();
        case "stale-cursor":
          return browserControlError(
            BROWSER_CONTROL_ERROR_CODE.staleSnapshot,
            STALE_CURSOR_MESSAGE,
          );
        case "top-origin":
          return unsupportedPage();
        default:
          outcome.reason satisfies never;
          return panic("Unhandled page refusal");
      }
    default:
      outcome satisfies never;
      return panic("Unhandled read failure");
  }
};

/**
 * Whether the document that was read may be returned: the address was
 * checked before the read, but the page may have navigated since. This is
 * what holds the stella browser to public pages until its network rules
 * match the extension's.
 */
const topDocumentRefusal = (
  policy: OriginPolicy,
  top: { origin: string; url: string },
): BrowserControlResult | null => {
  if (isIdentityProviderUrl(top.url)) {
    return needsMember();
  }
  return policy.isControllableFrame({
    isTopFrame: true,
    origin: top.origin,
    url: top.url,
  })
    ? null
    : unsupportedPage();
};

/** The tab's address now, from its frame tree; null when it cannot be read. */
const topFrameUrl = async ({
  client,
  signal,
  tab,
}: ReadContext): Promise<string | null> => {
  const tree = await client.send(
    "Page.getFrameTree",
    {},
    { sessionId: tab.sessionId, signal },
  );
  return Result.isOk(tree) ? tree.value.frameTree.frame.url : null;
};

/** Whether any frame of the tab asks for a sign-in now. */
const asksForSignIn = async (
  context: ReadContext,
  frames: readonly TabFrame[],
): Promise<boolean> => {
  for (const frame of frames) {
    const answer = await runInFrame(context, frame, {
      ...readOperationBase(),
      facts: false,
      idPrefix: "",
      kind: "snapshot",
      pageControls: 0,
      purpose: SNAPSHOT_PURPOSE.signInCheck,
      purposes: SNAPSHOT_PURPOSE,
    });
    if (answer.type === "answered" && v.is(signInRefusalSchema, answer.value)) {
      return true;
    }
  }
  return false;
};

type Preflight = {
  frames: ReaderFrame[];
  /** The protocol frame behind each reader frame, by its number. */
  located: Map<number, TabFrame>;
};

/**
 * Checks every read makes before it touches the page: a public address,
 * not an identity provider's, no frame asking for a sign-in, and a top
 * frame the protocol can name.
 */
const readPreflight = async (
  context: ReadContext,
): Promise<BrowserControlResult | Preflight> => {
  const url = await topFrameUrl(context);
  if (url === null || context.policy.parseControllableUrl(url) === null) {
    return unsupportedPage();
  }
  if (isIdentityProviderUrl(url)) {
    return needsMember();
  }
  const listed = await listFrames(context);
  if (
    Result.isError(listed) ||
    listed.value.at(0)?.number !== TOP_FRAME_NUMBER
  ) {
    return failed(
      "The browser could not say which document the tab shows. Take a snapshot again.",
    );
  }
  const frames = listed.value;
  if (await asksForSignIn(context, frames)) {
    return needsMember();
  }
  return {
    frames: frames.map((frame) => ({
      documentId: documentIdOf(frame),
      frameId: frame.number,
    })),
    located: new Map(frames.map((frame) => [frame.number, frame])),
  };
};

/** A tab's address as the tab list shows it: origin and path only. */
const listedTabUrl = (policy: OriginPolicy, rawUrl: string): string | null => {
  const url = policy.parseControllableUrl(rawUrl);
  return url === null
    ? null
    : `${url.origin}${url.pathname}`.slice(0, BROWSER_CONTROL_LIMITS.urlChars);
};

const listTabs = (
  { chatTabs, policy, tab }: ReadContext,
  activeUrl: string,
): BrowserControlTab[] =>
  chatTabs()
    .flatMap((owned): BrowserControlTab[] => {
      const url = listedTabUrl(policy, owned === tab ? activeUrl : owned.url);
      return url === null
        ? []
        : [{ active: owned === tab, tabId: owned.tabId, url }];
    })
    .slice(0, BROWSER_CONTROL_LIMITS.tabs);

/** Runs `operation` in the reader frame's document. */
const inReaderFrame = async (
  context: ReadContext,
  located: Map<number, TabFrame>,
  frame: ReaderFrame,
  operation: PageOperation,
): Promise<FrameAnswer> => {
  const tabFrame = located.get(frame.frameId);
  return tabFrame === undefined
    ? UNREACHABLE
    : await runInFrame(context, tabFrame, operation);
};

/** One window of the page the chat's tab shows, from `cursor` or the section in view. */
export const readSnapshot = async (
  context: ReadContext,
  cursor: string | undefined,
): Promise<BrowserControlResult> => {
  const preflight = await readPreflight(context);
  if ("status" in preflight) {
    return preflight;
  }
  const { frames, located } = preflight;
  const outcome = await readPageWindow({
    cursor,
    frames,
    readFrame: async (frame, request) =>
      frameOutcome(
        context.policy,
        frame,
        await inReaderFrame(context, located, frame, {
          ...readOperationBase(),
          facts: request.facts,
          idPrefix: request.idPrefix,
          kind: "snapshot",
          pageControls: request.pageControls,
          purpose: SNAPSHOT_PURPOSE.read,
          purposes: SNAPSHOT_PURPOSE,
          ...(request.read === undefined ? {} : { read: request.read }),
        }),
        frameReadSchema,
      ),
  });
  if (outcome.type !== "window") {
    return readRefusal(outcome);
  }
  const { window } = outcome;
  const refusal = topDocumentRefusal(context.policy, window.top);
  if (refusal !== null) {
    return refusal;
  }
  const url = window.top.url.slice(0, BROWSER_CONTROL_LIMITS.urlChars);
  const parsed = parseBrowserControlResult({
    protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
    snapshot: {
      contentTrust: BROWSER_CONTROL_CONTENT_TRUST.untrustedWebContent,
      elements: window.elements,
      elementsLeftOut: window.elementsLeftOut,
      facts: window.facts,
      revision: crypto.randomUUID(),
      tabId: context.tab.tabId,
      tabs: listTabs(context, url),
      text: window.text,
      title: window.top.title.slice(0, BROWSER_CONTROL_LIMITS.titleChars),
      url,
      window: window.window,
    },
    status: "success",
  } satisfies BrowserControlResult);
  return parsed?.status === "success"
    ? parsed
    : failed("The page returned a snapshot outside the protocol bounds.");
};

/** Finds text, or lists headings, in the page the chat's tab shows. */
export const findOnPage = async (
  context: ReadContext,
  command: Extract<BrowserControlCommand, { action: "find" }>,
): Promise<BrowserControlResult> => {
  const preflight = await readPreflight(context);
  if ("status" in preflight) {
    return preflight;
  }
  const { frames, located } = preflight;
  const outcome = await findInPage({
    after: command.after,
    findFrame: async (frame, request: FindRequest) =>
      frameOutcome(
        context.policy,
        frame,
        await inReaderFrame(context, located, frame, {
          ...readOperationBase(),
          find: request,
          kind: "find",
        }),
        frameFoundSchema,
      ),
    frames,
    search: command.search,
  });
  if (outcome.type !== "found") {
    return readRefusal(outcome);
  }
  // The top document's address and title, read without any of its text
  // when the find did not reach it.
  let read: { origin: string; title: string; url: string } | null = outcome.top;
  const topFrame = frames.at(0);
  if (read === null && topFrame !== undefined) {
    const page = frameOutcome(
      context.policy,
      topFrame,
      await inReaderFrame(context, located, topFrame, {
        ...readOperationBase(),
        facts: false,
        idPrefix: "",
        kind: "snapshot",
        pageControls: 0,
        purpose: SNAPSHOT_PURPOSE.read,
        purposes: SNAPSHOT_PURPOSE,
      }),
      frameReadSchema,
    );
    if (page.type === "refused") {
      return readRefusal(page);
    }
    read = page.type === "read" ? page.result : null;
  }
  if (read === null) {
    return failed("The page could not be read.");
  }
  const refusal = topDocumentRefusal(context.policy, read);
  if (refusal !== null) {
    return refusal;
  }
  const parsed = parseBrowserControlResult({
    found: {
      ...outcome.found,
      contentTrust: BROWSER_CONTROL_CONTENT_TRUST.untrustedWebContent,
      tabId: context.tab.tabId,
      title: read.title.slice(0, BROWSER_CONTROL_LIMITS.titleChars),
      url: read.url.slice(0, BROWSER_CONTROL_LIMITS.urlChars),
    },
    protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
    status: "found",
  } satisfies BrowserControlResult);
  return (
    parsed ??
    failed("The page returned find results outside the protocol bounds.")
  );
};

type Navigated =
  | { type: "loaded" }
  | { type: "failed"; reason: string }
  | { type: "timed-out" }
  | { type: "stopped" };

/** Points the tab at `url` and waits for its document to load. */
const navigate = async (
  { client, signal, tab }: ReadContext,
  url: string,
): Promise<Navigated> => {
  const loaded = Promise.withResolvers<boolean>();
  const stopListening = client.on(
    "Page.loadEventFired",
    (_event, sessionId) => {
      if (sessionId === tab.sessionId) {
        loaded.resolve(true);
      }
    },
  );
  const timer = setTimeout(() => {
    loaded.resolve(false);
  }, NAVIGATION_TIMEOUT_MS);
  const onAbort = () => {
    loaded.resolve(false);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const outcome = await (async (): Promise<Navigated> => {
    const started = await client.send(
      "Page.navigate",
      { url },
      { sessionId: tab.sessionId, signal },
    );
    if (Result.isError(started)) {
      return signal.aborted
        ? { type: "stopped" }
        : { reason: "the browser refused it", type: "failed" };
    }
    if (started.value.errorText !== undefined) {
      return { reason: started.value.errorText, type: "failed" };
    }
    // A move within the same document loads nothing.
    if (started.value.loaderId !== undefined && !(await loaded.promise)) {
      return signal.aborted ? { type: "stopped" } : { type: "timed-out" };
    }
    await Bun.sleep(PAGE_SETTLE_MS);
    return { type: "loaded" };
  })();
  clearTimeout(timer);
  signal.removeEventListener("abort", onAbort);
  stopListening();
  return outcome;
};

/**
 * Opens `requested` in the chat's tab and reads it. The address passed the
 * origin policy before this; the page is read only where it landed on the
 * same origin, as the extension does: a redirect elsewhere needs its own
 * snapshot.
 */
export const openPage = async (
  context: ReadContext,
  requested: URL,
): Promise<BrowserControlResult> => {
  const navigated = await navigate(context, requested.href);
  switch (navigated.type) {
    case "loaded":
      break;
    case "failed":
      return browserControlError(
        BROWSER_CONTROL_ERROR_CODE.navigationFailed,
        `The page did not load (${navigated.reason}).`,
      );
    case "timed-out":
      return browserControlError(
        BROWSER_CONTROL_ERROR_CODE.timedOut,
        "The page did not finish loading in time.",
      );
    case "stopped":
      return browserControlError(
        BROWSER_CONTROL_ERROR_CODE.cancelled,
        "The run stopped while the page was loading.",
      );
    default:
      navigated satisfies never;
      return panic("Unhandled navigation outcome");
  }
  const landed = await topFrameUrl(context);
  const landedUrl =
    landed === null ? null : context.policy.parseControllableUrl(landed);
  if (landedUrl !== null && isIdentityProviderUrl(landedUrl.href)) {
    return needsMember();
  }
  if (landedUrl === null || landedUrl.origin !== requested.origin) {
    return browserControlError(
      BROWSER_CONTROL_ERROR_CODE.redirected,
      `The page redirected away from ${requested.origin} to ${landedUrl?.origin ?? "an unsupported address"} and was not read. Use snapshot to read it after approval.`,
    );
  }
  return await readSnapshot(context, undefined);
};
