import * as v from "valibot";

/**
 * The popup asks the worker over a port named this; the worker owns every
 * change the popup requests.
 */
export const POPUP_PORT_NAME = "stella-extension-popup";
const POPUP_REQUEST_SOURCE = "stella-extension-popup";

const tabIdSchema = v.pipe(v.number(), v.integer(), v.minValue(0));

const popupRequestSchema = v.variant("type", [
  v.strictObject({
    source: v.literal(POPUP_REQUEST_SOURCE),
    tabId: tabIdSchema,
    type: v.literal("pair"),
  }),
  v.strictObject({
    source: v.literal(POPUP_REQUEST_SOURCE),
    tabId: tabIdSchema,
    type: v.literal("adopt"),
  }),
  v.strictObject({
    source: v.literal(POPUP_REQUEST_SOURCE),
    type: v.literal("disconnect"),
  }),
  v.strictObject({
    source: v.literal(POPUP_REQUEST_SOURCE),
    type: v.literal("revoke"),
  }),
]);

type PopupRequest = v.InferOutput<typeof popupRequestSchema>;

export const parsePopupRequest = (input: unknown): PopupRequest | null => {
  const result = v.safeParse(popupRequestSchema, input);
  return result.success ? result.output : null;
};

const popupResponseSchema = v.variant("status", [
  v.strictObject({ status: v.literal("adopted"), url: v.string() }),
  v.strictObject({ status: v.literal("done") }),
  v.strictObject({ status: v.literal("failed") }),
  v.strictObject({ status: v.literal("unsupported-page") }),
  v.strictObject({ status: v.literal("unsupported-tab") }),
]);

export type PopupResponse = v.InferOutput<typeof popupResponseSchema>;

type PopupRequestInput =
  | { tabId: number; type: "adopt" | "pair" }
  | { type: "disconnect" | "revoke" };

/** Sends a popup action to the worker and reads its verdict. */
export const sendPopupRequest = async (
  request: PopupRequestInput,
): Promise<PopupResponse> =>
  await new Promise<PopupResponse>((resolve) => {
    const port = chrome.runtime.connect({ name: POPUP_PORT_NAME });
    port.onMessage.addListener((response: unknown) => {
      const parsed = v.safeParse(popupResponseSchema, response);
      resolve(parsed.success ? parsed.output : { status: "failed" });
      port.disconnect();
    });
    port.onDisconnect.addListener(() => {
      resolve({ status: "failed" });
    });
    port.postMessage({ ...request, source: POPUP_REQUEST_SOURCE });
  });

/**
 * Only the extension's own pages speak for the popup. A content script's
 * sender URL is the web page it runs in, never an extension page.
 */
export const isExtensionPageSender = (
  sender: chrome.runtime.MessageSender | undefined,
): boolean => {
  if (sender?.id !== chrome.runtime.id) {
    return false;
  }
  try {
    return (
      sender.url !== undefined &&
      new URL(sender.url).origin === new URL(chrome.runtime.getURL("/")).origin
    );
  } catch {
    return false;
  }
};
