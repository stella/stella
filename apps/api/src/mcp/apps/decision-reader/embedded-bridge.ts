import { createDetached } from "@stll/errors";

import {
  appFailure,
  createAppRequestId,
  formatAppFailure,
} from "../shared/app-error";
import type { AppFailure } from "../shared/app-error";
import { appLocale } from "../shared/locale";
import type { ReaderController } from "./controller";
import { readerToolFailure } from "./failures";
import { parseOpenDecision } from "./model";

type ReaderBridge = ReaderController["bridge"];
type ReaderSnapshot = ReturnType<ReaderBridge["getSnapshot"]>;
type EmbeddedReaderTransport = Pick<
  ReaderBridge,
  | "requestTool"
  | "requestFullscreen"
  | "requestInline"
  | "supportsTools"
  | "openLink"
  | "connect"
  | "subscribe"
> & {
  getSnapshot: () => { context: ReaderSnapshot["context"] };
};

/** The reader owns its open state while sharing the results app's connected host transport. */
export const createEmbeddedReaderBridge = (parent: EmbeddedReaderTransport) => {
  const listeners = new Set<() => void>();
  let generation = 0;
  let snapshot: ReaderSnapshot = {
    context: parent.getSnapshot().context,
    input: {},
    tool: "open_case_law_decision",
    result: { status: "idle" },
  };
  const publish = (result: ReaderSnapshot["result"]) => {
    snapshot = {
      context: parent.getSnapshot().context,
      input: snapshot.input,
      tool: "open_case_law_decision",
      result,
    };
    for (const listener of listeners) {
      listener();
    }
  };
  const failedResult = (failure: AppFailure) =>
    ({
      status: "error",
      failure,
      message: formatAppFailure(
        failure,
        appLocale(parent.getSnapshot().context.locale).t,
      ),
    }) as const;
  const publishFailure = (failure: AppFailure) =>
    publish(failedResult(failure));
  parent.subscribe(() => {
    snapshot = {
      ...snapshot,
      context: parent.getSnapshot().context,
      result:
        snapshot.result.status === "error"
          ? failedResult(snapshot.result.failure)
          : snapshot.result,
    };
    for (const listener of listeners) {
      listener();
    }
  });
  const call = async (request: Parameters<ReaderBridge["call"]>[0]) => {
    if (request.name !== "open_case_law_decision") {
      publishFailure(appFailure("invalid_arguments", createAppRequestId()));
      return;
    }
    const current = ++generation;
    snapshot = {
      context: parent.getSnapshot().context,
      input: request.arguments,
      tool: "open_case_law_decision",
      result: { status: "loading" },
    };
    for (const listener of listeners) {
      listener();
    }
    const result = await parent.requestTool(request);
    if (current !== generation) {
      return;
    }
    const view =
      result.isError === true
        ? undefined
        : parseOpenDecision(result.structuredContent);
    publish(
      view === undefined
        ? failedResult(readerToolFailure(result))
        : { status: "ready", view },
    );
  };
  const session = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    detached: createDetached(() =>
      publishFailure(appFailure("unavailable", createAppRequestId(), true)),
    ),
    call,
    retry: async () =>
      call({ name: "open_case_law_decision", arguments: snapshot.input }),
    requestTool: parent.requestTool,
    requestFullscreen: async () => {
      const current = generation;
      await parent.requestFullscreen(() => {
        if (current === generation) {
          publishFailure(appFailure("unavailable", createAppRequestId(), true));
        }
      });
    },
    requestInline: async () => {
      const current = generation;
      await parent.requestInline(() => {
        if (current === generation) {
          publishFailure(appFailure("unavailable", createAppRequestId(), true));
        }
      });
    },
    supportsTools: parent.supportsTools,
    openLink: async (url: string) => {
      const current = generation;
      await parent.openLink(url, () => {
        if (current === generation) {
          publishFailure(appFailure("unavailable", createAppRequestId(), true));
        }
      });
    },
    reset: () => {
      generation += 1;
      publish({ status: "idle" });
    },
    connect: parent.connect,
  };
  session satisfies ReaderBridge;
  return session;
};
