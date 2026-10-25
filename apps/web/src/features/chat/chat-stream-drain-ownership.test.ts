import { EventType } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { ChatClient } from "@tanstack/ai-client";
import type {
  RunAgentInputContext,
  SubscribeConnectionAdapter,
} from "@tanstack/ai-client";
import { panic } from "better-result";
import { expect, test } from "bun:test";

import { nextMacrotask } from "@stll/concurrency/event-loop";

import {
  expectPersistedReloadParity,
  finishAnswer,
  startAnswer,
} from "./tests/chat-stream-cancellation-fixtures";

const DRAIN_CANCELLATION_CASES = {
  stop: { action: "stop" },
  interrupt: { action: "interrupt" },
} as const;

for (const [name, scenario] of Object.entries(DRAIN_CANCELLATION_CASES)) {
  test(`${name} releases a cancelled queue drain without letting its old send strand fresh work`, async () => {
    const streamReady = Promise.withResolvers<undefined>();
    const firstStarted = Promise.withResolvers<undefined>();
    const oldSendStarted = Promise.withResolvers<undefined>();
    const oldSendAborted = Promise.withResolvers<undefined>();
    const oldSendRelease = Promise.withResolvers<undefined>();
    const freshRelease = Promise.withResolvers<undefined>();
    const tailRelease = Promise.withResolvers<undefined>();
    const requests: RunAgentInputContext[] = [];
    const errors: Error[] = [];
    const pendingSends: Promise<void>[] = [];
    const requestMarkers = () =>
      requests.map((request) => request.forwardedProps?.["marker"]).join(",");
    const previousNow = Object.getOwnPropertyDescriptor(performance, "now");
    let stream:
      | { type: "pending" }
      | {
          type: "open";
          controller: ReadableStreamDefaultController<StreamChunk>;
        }
      | { type: "closed" } = { type: "pending" };
    let client: ChatClient | undefined;
    const closeStream = () => {
      if (stream.type !== "open") {
        return;
      }
      const controller = stream.controller;
      stream = { type: "closed" };
      controller.close();
    };

    try {
      Object.defineProperty(performance, "now", {
        configurable: true,
        value: () => 0,
      });

      const publish = (chunks: readonly StreamChunk[]) => {
        if (stream.type !== "open") {
          return panic("The SDK subscribed before sending");
        }
        for (const chunk of chunks) {
          stream.controller.enqueue(chunk);
        }
      };

      const connection = {
        subscribe(signal) {
          return new ReadableStream<StreamChunk>({
            start(controller) {
              stream = { type: "open", controller };
              streamReady.resolve(undefined);
              if (signal?.aborted) {
                closeStream();
              } else {
                signal?.addEventListener("abort", closeStream, { once: true });
              }
            },
          });
        },
        async send(_messages, _data, signal, run) {
          if (run === undefined) {
            return panic("The SDK omitted its run context");
          }
          requests.push(run);
          await streamReady.promise;
          const marker = run.forwardedProps?.["marker"];
          if (typeof marker !== "string") {
            return panic("The fixture request lost its marker");
          }

          if (marker === "initial") {
            publish([
              ...startAnswer(run, "initial-answer"),
              {
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId: "initial-answer",
                delta: "INITIAL_ANSWER",
              },
            ]);
            firstStarted.resolve(undefined);
            return;
          }

          if (marker === "drain") {
            oldSendStarted.resolve(undefined);
            if (signal === undefined) {
              return panic("The SDK omitted the send abort signal");
            }
            if (signal.aborted) {
              oldSendAborted.resolve(undefined);
            } else {
              signal.addEventListener(
                "abort",
                () => oldSendAborted.resolve(undefined),
                { once: true },
              );
            }
            await oldSendAborted.promise;
            await oldSendRelease.promise;
            if (!signal.aborted) {
              publish([
                ...startAnswer(run, "stale-answer"),
                {
                  type: EventType.TEXT_MESSAGE_CONTENT,
                  messageId: "stale-answer",
                  delta: "STALE_OLD_ANSWER",
                },
                ...finishAnswer(run, "stale-answer"),
              ]);
            }
            return;
          }

          if (marker === "fresh") {
            publish([
              ...startAnswer(run, "fresh-answer"),
              {
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId: "fresh-answer",
                delta: "FRESH_ANSWER",
              },
            ]);
            await freshRelease.promise;
            publish(finishAnswer(run, "fresh-answer"));
            return;
          }

          if (marker === "tail") {
            publish([
              ...startAnswer(run, "tail-answer"),
              {
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId: "tail-answer",
                delta: "TAIL_ANSWER",
              },
            ]);
            await tailRelease.promise;
            publish(finishAnswer(run, "tail-answer"));
            return;
          }

          return panic(`Unexpected fixture request marker: ${marker}`);
        },
      } satisfies SubscribeConnectionAdapter;

      client = new ChatClient({
        threadId: `drain-ownership-${name}`,
        connection,
        onError: (error) => {
          errors.push(error);
        },
      });

      client.attach();
      const initial = client.sendMessage("initial", { marker: "initial" });
      pendingSends.push(initial);
      await firstStarted.promise;
      await nextMacrotask();
      expect(client.getIsLoading()).toBe(true);

      await client.sendMessage("queued drain", { marker: "drain" });
      expect(client.getQueue()).toHaveLength(1);
      const initialRun = requests.at(0);
      if (initialRun === undefined) {
        return panic("The initial request was not captured");
      }
      publish(finishAnswer(initialRun, "initial-answer"));
      await oldSendStarted.promise;

      let fresh: Promise<void>;
      if (scenario.action === "interrupt") {
        await client.sendMessage("queued tail", { marker: "tail" });
        fresh = client.sendMessage(
          "fresh",
          { marker: "fresh" },
          { whenBusy: "interrupt" },
        );
        pendingSends.push(fresh);
        await oldSendAborted.promise;
        await nextMacrotask();
        expect(requestMarkers()).toBe("initial,drain,fresh");
        expect(client.getIsLoading()).toBe(true);

        freshRelease.resolve(undefined);
        await nextMacrotask();
        expect(requestMarkers()).toBe("initial,drain,fresh,tail");
        tailRelease.resolve(undefined);
      } else {
        client.stop();
        await oldSendAborted.promise;
        let freshState: "pending" | "settled" = "pending";
        fresh = client.sendMessage("fresh", { marker: "fresh" }).then(() => {
          freshState = "settled";
          return undefined;
        });
        pendingSends.push(fresh);
        await nextMacrotask();
        expect(requestMarkers()).toBe("initial,drain,fresh");
        expect(client.getIsLoading()).toBe(true);

        const uiBeforeOldSendReturns = JSON.stringify(
          expectPersistedReloadParity(client.getMessages()),
        );
        const queueBeforeOldSendReturns = client.getQueue();
        const statusBeforeOldSendReturns = client.getStatus();
        oldSendRelease.resolve(undefined);
        await initial;
        await nextMacrotask();
        expect(freshState).toBe("pending");
        expect(
          JSON.stringify(expectPersistedReloadParity(client.getMessages())),
        ).toBe(uiBeforeOldSendReturns);
        expect(client.getQueue()).toEqual(queueBeforeOldSendReturns);
        expect(client.getIsLoading()).toBe(true);
        expect(client.getStatus()).toBe(statusBeforeOldSendReturns);
        freshRelease.resolve(undefined);
      }
      await fresh;

      const beforeOldSendReturns = JSON.stringify(
        expectPersistedReloadParity(client.getMessages()),
      );
      expect(beforeOldSendReturns).toContain("FRESH_ANSWER");
      expect(beforeOldSendReturns).not.toContain("STALE_OLD_ANSWER");
      if (scenario.action === "interrupt") {
        expect(beforeOldSendReturns).toContain("TAIL_ANSWER");
      }
      const queueBeforeOldSendReturns = client.getQueue();
      const loadingBeforeOldSendReturns = client.getIsLoading();
      const statusBeforeOldSendReturns = client.getStatus();

      oldSendRelease.resolve(undefined);
      await initial;
      await nextMacrotask();

      expect(
        JSON.stringify(expectPersistedReloadParity(client.getMessages())),
      ).toBe(beforeOldSendReturns);
      expect(client.getQueue()).toEqual(queueBeforeOldSendReturns);
      expect(client.getIsLoading()).toBe(loadingBeforeOldSendReturns);
      expect(client.getStatus()).toBe(statusBeforeOldSendReturns);
      expect(requestMarkers()).toBe(
        scenario.action === "interrupt"
          ? "initial,drain,fresh,tail"
          : "initial,drain,fresh",
      );
      expect(errors).toEqual([]);
    } finally {
      try {
        client?.stop();
      } finally {
        streamReady.resolve(undefined);
        oldSendRelease.resolve(undefined);
        freshRelease.resolve(undefined);
        tailRelease.resolve(undefined);
        closeStream();
        await Promise.allSettled(pendingSends);
        try {
          client?.dispose();
        } finally {
          if (previousNow === undefined) {
            Reflect.deleteProperty(performance, "now");
          } else {
            Object.defineProperty(performance, "now", previousNow);
          }
        }
      }
    }
  });
}
