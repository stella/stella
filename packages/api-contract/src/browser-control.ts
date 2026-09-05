import * as v from "valibot";

export const BROWSER_CONTROL_PROTOCOL_VERSION = 3 as const;
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
  titleChars: 1000,
  urlChars: 4096,
  valueChars: 10_000,
} as const;

const boundedIdSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(BROWSER_CONTROL_LIMITS.requestIdChars),
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

const isDecimalIndex = (index: string): boolean => {
  if (index.length === 0) {
    return false;
  }
  for (const char of index) {
    if (char < "0" || char > "9") {
      return false;
    }
  }
  return true;
};

const isElementPath = (path: string): boolean => {
  const segments = path.split(".");
  const first = segments.at(0);
  const last = segments.at(-1);
  if (first === undefined || last === undefined) {
    return false;
  }
  if (!isDecimalIndex(first) || !isDecimalIndex(last)) {
    return false;
  }
  return segments.every(
    (segment, index) =>
      isDecimalIndex(segment) ||
      (segment === ELEMENT_REFERENCE_SHADOW_SEGMENT &&
        segments[index - 1] !== ELEMENT_REFERENCE_SHADOW_SEGMENT),
  );
};

export const parseElementReference = (
  value: string,
): ElementReference | null => {
  if (value.length > BROWSER_CONTROL_LIMITS.referenceChars) {
    return null;
  }
  const [prefix, frame, path, ...rest] = value.split(":");
  if (
    prefix !== "e" ||
    frame === undefined ||
    path === undefined ||
    rest.length > 0 ||
    !isDecimalIndex(frame) ||
    !isElementPath(path)
  ) {
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
  v.startsWith("e:"),
  v.maxLength(BROWSER_CONTROL_LIMITS.referenceChars),
);

const urlSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(BROWSER_CONTROL_LIMITS.urlChars),
);

const pageSchema = v.strictObject({
  revision: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(BROWSER_CONTROL_LIMITS.revisionIdChars),
  ),
  url: urlSchema,
});

const targetSchema = v.strictObject({
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
  revision: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(BROWSER_CONTROL_LIMITS.revisionIdChars),
  ),
  text: v.pipe(v.string(), v.maxLength(BROWSER_CONTROL_LIMITS.pageTextChars)),
  /** Offset of `text` within the collected page text. */
  textOffset: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /** Length of the collected page text; read further with `snapshot` and `textOffset`. */
  textTotalChars: v.pipe(v.number(), v.integer(), v.minValue(0)),
  title: v.pipe(v.string(), v.maxLength(BROWSER_CONTROL_LIMITS.titleChars)),
  url: v.pipe(v.string(), v.maxLength(BROWSER_CONTROL_LIMITS.urlChars)),
});

export type BrowserControlSnapshot = v.InferOutput<
  typeof browserControlSnapshotSchema
>;

export const BROWSER_CONTROL_ERROR_CODE = {
  controllerBusy: "controller-busy",
  disconnected: "disconnected",
  elementNotFound: "element-not-found",
  executionFailed: "execution-failed",
  invalidCommand: "invalid-command",
  navigationFailed: "navigation-failed",
  noControlledTab: "no-controlled-tab",
  permissionDenied: "permission-denied",
  replayStateUnknown: "replay-state-unknown",
  sensitiveField: "sensitive-field",
  staleController: "stale-controller",
  staleSnapshot: "stale-snapshot",
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

const browserExtensionCommandRequestSchema = v.strictObject({
  command: browserControlCommandSchema,
  controllerId: controllerIdSchema,
  protocolVersion: v.literal(BROWSER_CONTROL_PROTOCOL_VERSION),
  requestId: requestIdSchema,
  source: v.literal(BROWSER_EXTENSION_MESSAGE_SOURCE.web),
  toolCallId: toolCallIdSchema,
  type: v.literal("command"),
});

export const browserExtensionRequestSchema = v.variant("type", [
  browserExtensionPingRequestSchema,
  browserExtensionCommandRequestSchema,
]);

export type BrowserExtensionRequest = v.InferOutput<
  typeof browserExtensionRequestSchema
>;

const browserExtensionPongResponseSchema = v.strictObject({
  allSitesGranted: v.boolean(),
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
    case BROWSER_CONTROL_ACTION.goBack:
    case BROWSER_CONTROL_ACTION.snapshot:
      return true;
    case BROWSER_CONTROL_ACTION.click:
    case BROWSER_CONTROL_ACTION.fill:
    case BROWSER_CONTROL_ACTION.open:
    case BROWSER_CONTROL_ACTION.pressKey:
    case BROWSER_CONTROL_ACTION.select:
      return false;
    default:
      command satisfies never;
      return false;
  }
};

export const parseBrowserControlCommand = (input: unknown) => {
  const result = v.safeParse(browserControlCommandSchema, input);
  if (!result.success) {
    return null;
  }
  const command = result.output;
  if (
    command.action !== BROWSER_CONTROL_ACTION.open &&
    command.action !== BROWSER_CONTROL_ACTION.snapshot &&
    command.action !== BROWSER_CONTROL_ACTION.goBack &&
    parseElementReference(command.target.ref) === null
  ) {
    return null;
  }
  return command;
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
