import * as v from "valibot";

export const BROWSER_CONTROL_PROTOCOL_VERSION = 2 as const;
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
  elements: 200,
  errorMessageChars: 1000,
  executionReceipts: 32,
  pageTextChars: 40_000,
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

const isElementReference = (value: string): boolean => {
  if (!value.startsWith("e:")) {
    return false;
  }
  const indexes = value.slice(2).split(".");
  return indexes.length > 0 && indexes.every(isDecimalIndex);
};

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

const referenceSchema = v.pipe(
  v.string(),
  v.startsWith("e:"),
  v.maxLength(256),
);

const pageSchema = v.strictObject({
  revision: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(BROWSER_CONTROL_LIMITS.revisionIdChars),
  ),
  url: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(BROWSER_CONTROL_LIMITS.urlChars),
  ),
});

const targetSchema = v.strictObject({
  name: v.pipe(
    v.string(),
    v.maxLength(BROWSER_CONTROL_LIMITS.elementNameChars),
  ),
  ref: referenceSchema,
  role: v.pipe(v.string(), v.maxLength(100)),
});

const openActionSchema = v.strictObject({
  action: v.literal(BROWSER_CONTROL_ACTION.open),
  url: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(BROWSER_CONTROL_LIMITS.urlChars),
  ),
});

const snapshotActionSchema = v.strictObject({
  action: v.literal(BROWSER_CONTROL_ACTION.snapshot),
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

const browserControlElementSchema = v.strictObject({
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

const browserControlSnapshotSchema = v.strictObject({
  contentTrust: v.literal(BROWSER_CONTROL_CONTENT_TRUST.untrustedWebContent),
  elements: v.pipe(
    v.array(browserControlElementSchema),
    v.maxLength(BROWSER_CONTROL_LIMITS.elements),
  ),
  text: v.pipe(v.string(), v.maxLength(BROWSER_CONTROL_LIMITS.pageTextChars)),
  title: v.pipe(v.string(), v.maxLength(BROWSER_CONTROL_LIMITS.titleChars)),
  url: v.pipe(v.string(), v.maxLength(BROWSER_CONTROL_LIMITS.urlChars)),
  revision: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(BROWSER_CONTROL_LIMITS.revisionIdChars),
  ),
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
    !isElementReference(command.target.ref)
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
    result.output.snapshot.elements.some(({ ref }) => !isElementReference(ref))
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
