import type { App } from "@modelcontextprotocol/ext-apps";
import { Result } from "better-result";
import { createTranslator } from "use-intl";

import { createDetached } from "@stll/errors";

import type { appLocale } from "./locale";

type UploadLocale = ReturnType<typeof appLocale>;

export const isUploadRecord = (
  value: unknown,
): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const parseUploadToolPayload = (
  result: Awaited<ReturnType<App["callServerTool"]>>,
): unknown => {
  if (result.structuredContent !== undefined) {
    return result.structuredContent;
  }
  const text = result.content.find((part) => part.type === "text")?.text;
  if (text === undefined) {
    return undefined;
  }
  const parsed = Result.try((): unknown => JSON.parse(text));
  return Result.isError(parsed) ? undefined : parsed.value;
};

// Host changes update the locale read by the translator without rebuilding the upload controller.
export const createUploadTranslator =
  (getLocale: () => UploadLocale) =>
  (
    key: keyof UploadLocale["messages"],
    values?: Record<string, string | number>,
  ) => {
    const locale = getLocale();
    return createTranslator({
      locale: locale.formattingLocale,
      messages: locale.messages,
    })(key, values);
  };

type ConnectUploadAppOptions = {
  app: App;
  onContext: (context: ReturnType<App["getHostContext"]>) => void;
  onError: (message: string) => void;
};
export const connectUploadApp = async ({
  app,
  onContext,
  onError,
}: ConnectUploadAppOptions) => {
  const connected = await Result.tryPromise(async () => await app.connect());
  if (Result.isError(connected)) {
    onError(connected.error.message);
    return;
  }
  onContext(app.getHostContext());
};

export const createUploadSubscriptions = () => {
  const listeners = new Set<() => void>();
  return {
    notify: () => {
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

type BindUploadSdkErrorsOptions = {
  app: App;
  getLabel: () => string;
  onError: (message: string) => void;
};
export const bindUploadSdkErrors = ({
  app,
  getLabel,
  onError,
}: BindUploadSdkErrorsOptions) => {
  const reportError: NonNullable<typeof app.onerror> = ({ message }) => {
    onError(`${getLabel()}: ${message}`);
  };
  // SDK Protocol exposes an error callback, not a DOM error event.
  Object.assign(app, { onerror: reportError } satisfies Pick<App, "onerror">);
  return createDetached((error) => {
    const message = error instanceof Error ? error.message : getLabel();
    onError(`${getLabel()}: ${message}`);
  });
};
