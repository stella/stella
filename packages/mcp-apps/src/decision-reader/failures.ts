import {
  appFailure,
  createAppRequestId,
  formatAppFailure,
  toolAppFailure,
} from "../shared/app-error";
import { parseAppToolPayload } from "../shared/bridge";
import type { AppToolResult } from "../shared/bridge";
import type { appLocale } from "../shared/locale";
import type { ReaderController } from "./controller";

type ReaderBridge = ReaderController["bridge"];

export const readerToolFailure = (result: AppToolResult) => {
  if (result.isError === true) {
    return toolAppFailure(parseAppToolPayload(result), createAppRequestId());
  }
  return appFailure("invalid_response", createAppRequestId());
};

type ReaderErrorPresentationOptions = {
  state: ReturnType<ReaderController["getSnapshot"]>;
  bridgeState: ReturnType<ReaderBridge["getSnapshot"]>;
  t: ReturnType<typeof appLocale>["t"];
};

export const readerErrorPresentation = ({
  state,
  bridgeState,
  t,
}: ReaderErrorPresentationOptions) => {
  if (bridgeState.result.status === "error") {
    return {
      errorMessage: bridgeState.result.message,
      retryable: bridgeState.result.failure.retryable,
    };
  }
  const failure = state.requestFailure ?? state.previewFailure;
  if (failure === null) {
    return {
      errorMessage: null,
      retryable: state.requestStatus === "conflict",
    };
  }
  return {
    errorMessage: formatAppFailure(failure, t),
    retryable: state.requestStatus === "conflict" || failure.retryable,
  };
};
