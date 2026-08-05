import { OutlookError } from "@/lib/outlook-error";

const HANDOFF_MESSAGE_TYPE = "stella:auth";
const DIALOG_PATH = "/sign-in-outlook";
const MAX_TOKEN_LENGTH = 8192;

const TOKEN_SUBSCRIBERS = new Set<(token: string | null) => void>();
let currentToken: string | null = null;

const isOffice = (
  value: unknown,
): value is { context: typeof Office.context } =>
  typeof value === "object" &&
  value !== null &&
  "context" in value &&
  typeof value.context === "object";

const getOffice = () => {
  const value: unknown = Reflect.get(globalThis, "Office");
  return isOffice(value) ? value : null;
};

const notify = (token: string | null) => {
  currentToken = token;
  for (const subscriber of TOKEN_SUBSCRIBERS) {
    subscriber(token);
  }
};

export const getAuthToken = (): string | null => currentToken;

export const subscribeAuthToken = (
  subscriber: (token: string | null) => void,
): (() => void) => {
  TOKEN_SUBSCRIBERS.add(subscriber);
  return () => {
    TOKEN_SUBSCRIBERS.delete(subscriber);
  };
};

export const clearAuthToken = (): void => notify(null);

const isHandoffPayload = (
  value: unknown,
): value is { token: string; type: typeof HANDOFF_MESSAGE_TYPE } => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("type" in value) || !("token" in value)) {
    return false;
  }
  return (
    value.type === HANDOFF_MESSAGE_TYPE &&
    typeof value.token === "string" &&
    value.token.length > 0 &&
    value.token.length <= MAX_TOKEN_LENGTH
  );
};

type ParseHandoffTokenOptions = {
  actualOrigin: string | undefined;
  expectedOrigin: string;
  raw: string;
};

export const parseHandoffToken = ({
  actualOrigin,
  expectedOrigin,
  raw,
}: ParseHandoffTokenOptions): string | null => {
  if (actualOrigin !== expectedOrigin) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isHandoffPayload(parsed) ? parsed.token : null;
  } catch {
    return null;
  }
};

export const signInViaDialog = async (
  signInOrigin: string,
  taskpaneOrigin: string,
): Promise<string> => {
  const office = getOffice();
  const ui = office?.context.ui;
  if (!ui?.displayDialogAsync) {
    throw new OutlookError({
      message: "Office dialog API is not available in this Outlook host.",
    });
  }

  const expectedOrigin = new URL(signInOrigin).origin;
  const startAddress = new URL(DIALOG_PATH, expectedOrigin);
  startAddress.searchParams.set("parentOrigin", new URL(taskpaneOrigin).origin);

  return await new Promise<string>((resolve, reject) => {
    ui.displayDialogAsync(
      startAddress.toString(),
      { height: 60, promptBeforeOpen: false, width: 40 },
      (result) => {
        if (result.status !== "succeeded") {
          reject(
            new OutlookError({
              message:
                result.error?.message ?? "Sign-in dialog failed to open.",
            }),
          );
          return;
        }

        const dialog = result.value;
        dialog.addEventHandler("DialogMessageReceived", (event) => {
          if (!("message" in event)) {
            return;
          }
          if (event.origin !== expectedOrigin) {
            dialog.close();
            reject(
              new OutlookError({
                message: "Sign-in response came from an unexpected origin.",
              }),
            );
            return;
          }
          const token = parseHandoffToken({
            actualOrigin: event.origin,
            expectedOrigin,
            raw: event.message,
          });
          if (!token) {
            return;
          }
          dialog.close();
          notify(token);
          resolve(token);
        });
        dialog.addEventHandler("DialogEventReceived", (event) => {
          if (!("error" in event)) {
            return;
          }
          dialog.close();
          reject(
            new OutlookError({
              message: `Sign-in dialog closed (code ${event.error ?? "unknown"}).`,
            }),
          );
        });
      },
    );
  });
};
