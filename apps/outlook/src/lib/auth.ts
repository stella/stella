import { getOfficeRuntime } from "@/lib/office";
import { OutlookError } from "@/lib/outlook-error";

const HANDOFF_MESSAGE_TYPE = "stella:auth";
const DIALOG_BOOTSTRAP_PATH = "/dialog.html";
const MAX_TOKEN_LENGTH = 8192;

const TOKEN_SUBSCRIBERS = new Set<(token: string | null) => void>();
let currentToken: string | null = null;

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

export const buildDialogStartAddress = (taskpaneOrigin: string): string => {
  const origin = new URL(taskpaneOrigin).origin;
  const startAddress = new URL(DIALOG_BOOTSTRAP_PATH, origin);
  startAddress.searchParams.set("parentOrigin", origin);
  return startAddress.toString();
};

type SignInViaDialogOptions = {
  signInOrigin: string;
  taskpaneOrigin: string;
};

export const signInViaDialog = async ({
  signInOrigin,
  taskpaneOrigin,
}: SignInViaDialogOptions): Promise<string> => {
  const office = getOfficeRuntime();
  if (!office) {
    throw new OutlookError({
      message: "Office dialog API is not available in this Outlook host.",
    });
  }

  const ui = office.context.ui;
  if (typeof Reflect.get(ui, "displayDialogAsync") !== "function") {
    throw new OutlookError({
      message: "Office dialog API is not available in this Outlook host.",
    });
  }

  const expectedOrigin = new URL(signInOrigin).origin;
  const startAddress = buildDialogStartAddress(taskpaneOrigin);

  return await new Promise<string>((resolve, reject) => {
    ui.displayDialogAsync(
      startAddress,
      { height: 60, promptBeforeOpen: false, width: 40 },
      (result) => {
        if (result.status !== office.AsyncResultStatus.Succeeded) {
          reject(
            new OutlookError({
              message: result.error.message,
            }),
          );
          return;
        }

        const dialog = result.value;
        dialog.addEventHandler(
          office.EventType.DialogMessageReceived,
          (event) => {
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
          },
        );
        dialog.addEventHandler(
          office.EventType.DialogEventReceived,
          (event) => {
            if (!("error" in event)) {
              return;
            }
            dialog.close();
            reject(
              new OutlookError({
                message: `Sign-in dialog closed (code ${event.error}).`,
              }),
            );
          },
        );
      },
    );
  });
};
