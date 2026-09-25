import { panic } from "better-result";
import * as v from "valibot";

export const BROWSER_CONTROL_PROTOCOL_VERSION = 4 as const;
export const BROWSER_CONTROL_TOOL_NAME = "use-browser" as const;

export const BROWSER_CONTROL_CONTENT_TRUST = {
  untrustedWebContent: "untrusted-web-content",
} as const;

export const BROWSER_CONTROL_ACTION = {
  click: "click",
  fill: "fill",
  goBack: "go-back",
  open: "open",
  pressKey: "press-key",
  select: "select",
  snapshot: "snapshot",
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

export const BROWSER_CONTROL_LIMITS = {
  /** Text of the row, list item or form an element sits in; disambiguates identical controls. */
  contextChars: 200,
  elementNameChars: 500,
  elements: 300,
  errorMessageChars: 1000,
  executionReceipts: 32,
  /** Frames read per snapshot, top frame first. */
  frames: 16,
  /** Characters of page text returned per snapshot; longer pages are paged with `textOffset`. */
  pageTextChars: 48_000,
  /** Characters of page text the extension collects across frames before paging. */
  pageTextTotalChars: 400_000,
  referenceChars: 256,
  revisionIdChars: 128,
  requestIdChars: 128,
  selectValueChars: 2000,
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

const contextSchema = v.pipe(
  v.string(),
  v.maxLength(BROWSER_CONTROL_LIMITS.contextChars),
);

const targetSchema = v.strictObject({
  /** Enclosing row or form text copied from the snapshot; rejected when the element now sits in a different row. */
  context: v.optional(contextSchema),
  /** Link destination copied from the snapshot; the extension rejects a target whose href changed. */
  href: v.optional(urlSchema),
  name: v.pipe(
    v.string(),
    v.maxLength(BROWSER_CONTROL_LIMITS.elementNameChars),
  ),
  ref: referenceSchema,
  role: v.pipe(v.string(), v.maxLength(100)),
});

const openActionSchema = v.strictObject({
  action: v.literal(BROWSER_CONTROL_ACTION.open),
  url: urlSchema,
});

const snapshotActionSchema = v.strictObject({
  action: v.literal(BROWSER_CONTROL_ACTION.snapshot),
  /** Character offset into the page text; omit to read from the start. */
  textOffset: v.optional(
    v.pipe(
      v.number(),
      v.integer(),
      v.minValue(0),
      v.maxValue(BROWSER_CONTROL_LIMITS.pageTextTotalChars),
    ),
  ),
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

export const browserControlCommandSchema = v.variant("action", [
  openActionSchema,
  snapshotActionSchema,
  clickActionSchema,
  fillActionSchema,
  selectActionSchema,
  pressKeyActionSchema,
  goBackActionSchema,
]);

export type BrowserControlCommand = v.InferOutput<
  typeof browserControlCommandSchema
>;

export type BrowserControlElementCommand = Extract<
  BrowserControlCommand,
  { target: unknown }
>;

const browserControlElementSchema = v.strictObject({
  context: v.optional(contextSchema),
  href: v.optional(urlSchema),
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

const browserControlSnapshotSchema = v.strictObject({
  contentTrust: v.literal(BROWSER_CONTROL_CONTENT_TRUST.untrustedWebContent),
  elements: v.pipe(
    v.array(browserControlElementSchema),
    v.maxLength(BROWSER_CONTROL_LIMITS.elements),
  ),
  revision: revisionSchema,
  text: v.pipe(v.string(), v.maxLength(BROWSER_CONTROL_LIMITS.pageTextChars)),
  /** Offset of `text` within the collected page text. */
  textOffset: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /** Length of the collected page text; read further with `snapshot` and `textOffset`. */
  textTotalChars: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /** The Chrome tab the snapshot was read from. */
  tabId: tabIdSchema,
  title: v.pipe(v.string(), v.maxLength(BROWSER_CONTROL_LIMITS.titleChars)),
  url: v.pipe(v.string(), v.maxLength(BROWSER_CONTROL_LIMITS.urlChars)),
});

export type BrowserControlSnapshot = v.InferOutput<
  typeof browserControlSnapshotSchema
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
  browserControlErrorSchema,
]);

export type BrowserControlResult = v.InferOutput<
  typeof browserControlResultSchema
>;

export const BROWSER_EXTENSION_MESSAGE_SOURCE = {
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

export type BrowserClientCapability = {
  protocolVersion: typeof BROWSER_CONTROL_PROTOCOL_VERSION;
};

export const isReadOnlyBrowserCommand = (
  command: BrowserControlCommand,
): boolean => {
  switch (command.action) {
    case BROWSER_CONTROL_ACTION.snapshot:
      return true;
    // History can hold pages the user never approved, and `popstate`
    // handlers can change page state, so going back is a navigation.
    case BROWSER_CONTROL_ACTION.goBack:
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
    result.output.snapshot.elements.some(
      ({ ref }) => parseElementReference(ref) === null,
    )
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
