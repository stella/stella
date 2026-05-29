import { OutlookError } from "@/lib/errors";

const TOKEN_STORAGE_KEY = "stella:bearer-token";
const HANDOFF_MESSAGE_TYPE = "stella:auth";
const DIALOG_PATH = "/sign-in-outlook";

const TOKEN_SUBSCRIBERS = new Set<(token: string | null) => void>();
let currentToken: string | null = null;

const isOffice = (
  value: unknown,
): value is { context: typeof Office.context } =>
  typeof value === "object" &&
  value !== null &&
  "context" in value &&
  typeof (value as { context: unknown }).context === "object";

const getOffice = () => {
  const value: unknown = Reflect.get(globalThis, "Office");
  return isOffice(value) ? value : null;
};

const getRoamingSettings = (): Office.RoamingSettings | null => {
  const office = getOffice();
  return office?.context.roamingSettings ?? null;
};

const readPersistedToken = (): string | null => {
  const settings = getRoamingSettings();
  if (!settings) {
    return null;
  }
  const value = settings.get(TOKEN_STORAGE_KEY);
  return typeof value === "string" && value.length > 0 ? value : null;
};

const persistToken = async (token: string | null): Promise<void> => {
  const settings = getRoamingSettings();
  if (!settings) {
    return;
  }
  if (token === null) {
    settings.remove(TOKEN_STORAGE_KEY);
  } else {
    settings.set(TOKEN_STORAGE_KEY, token);
  }
  await new Promise<void>((resolve) => {
    settings.saveAsync(() => resolve());
  });
};

const notify = (token: string | null) => {
  currentToken = token;
  for (const subscriber of TOKEN_SUBSCRIBERS) {
    subscriber(token);
  }
};

export const initAuth = (): void => {
  if (currentToken !== null) {
    return;
  }
  const persisted = readPersistedToken();
  if (persisted) {
    notify(persisted);
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

export const clearAuthToken = async (): Promise<void> => {
  await persistToken(null);
  notify(null);
};

const isHandoffPayload = (
  value: unknown,
): value is { token: string; type: typeof HANDOFF_MESSAGE_TYPE } => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("type" in value) || !("token" in value)) {
    return false;
  }
  return value.type === HANDOFF_MESSAGE_TYPE && typeof value.token === "string";
};

const parseHandoffToken = (raw: string): string | null => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isHandoffPayload(parsed) ? parsed.token : null;
  } catch {
    return null;
  }
};

export const signInViaDialog = async (
  signInOrigin: string,
): Promise<string> => {
  const office = getOffice();
  const ui = office?.context.ui;
  if (!ui?.displayDialogAsync) {
    throw new OutlookError({
      message: "Office dialog API is not available in this Outlook host.",
    });
  }

  const startAddress = new URL(DIALOG_PATH, signInOrigin).toString();

  return await new Promise<string>((resolve, reject) => {
    ui.displayDialogAsync(
      startAddress,
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
          const token = parseHandoffToken(event.message);
          if (!token) {
            return;
          }
          dialog.close();
          void (async () => {
            await persistToken(token);
            notify(token);
            resolve(token);
          })();
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
