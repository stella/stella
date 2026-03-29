import type {
  ChatRequestOptions,
  ChatTransport,
  UIMessage,
  UIMessageChunk,
} from "ai";
import { panic } from "better-result";
import type { EventUnsubscribe } from "rivetkit/client";

import type {
  SequencedChunk as BaseSequencedChunk,
  UserContext,
} from "@stella/rivet/actors/chat-actor-config";

export type { UserContext } from "@stella/rivet/actors/chat-actor-config";
import { getAnalytics } from "@/lib/analytics/provider";
import { ClientTelemetryError } from "@/lib/errors";

export type SequencedChunk = BaseSequencedChunk<UIMessageChunk>;

/** A file processed by the upload-context-file endpoint. */
export type ProcessedAttachment =
  | {
      type: "native-file";
      dataUrl: string;
      mediaType: string;
      filename: string;
    }
  | {
      type: "extracted-text";
      filename: string;
      mediaType: string;
      views: {
        simple: string;
        original?: string | undefined;
        trackedChanges?: string | undefined;
      };
    };

export type ActiveFileContext = {
  entityId: string;
  fileName: string;
};

export type ChatStreamConnection = {
  on(
    eventName: "stream-chunk",
    callback: (payload: SequencedChunk) => void,
  ): EventUnsubscribe;
  sendMessages(input: {
    threadId: string;
    chatId: string;
    message: UIMessage;
    workspaceId?: string | undefined;
    modelId?: string | undefined;
    userContext?: UserContext | undefined;
    attachments?: ProcessedAttachment[] | undefined;
    activeFile?: ActiveFileContext | undefined;
  }): Promise<{ status: "started" | "busy" }>;
  stop(input: { threadId: string }): Promise<void>;
  getStreamSnapshot(input: {
    threadId: string;
    startFromSeq: number;
  }): Promise<{
    done: boolean;
    snapshot: SequencedChunk[];
  }>;
};

type SendMessagesOptions = {
  trigger: "submit-message" | "regenerate-message";
  chatId: string;
  messageId: string | undefined;
  messages: UIMessage[];
  abortSignal: AbortSignal | undefined;
} & ChatRequestOptions;

export class RivetChatTransport implements ChatTransport<UIMessage> {
  private readonly connection: ChatStreamConnection;
  private readonly threadId: string;
  private readonly workspaceId: string | undefined;
  private readonly getModelId: (() => string | null) | undefined;
  private readonly userContext: UserContext | undefined;
  private readonly getActiveFile:
    | (() => ActiveFileContext | undefined)
    | undefined;

  /** Attachments queued for the next sendMessages call.
   *  Drained (cleared) on each send. */
  pendingAttachments: ProcessedAttachment[] = [];

  // Highest seq successfully delivered to the SDK.
  // Used on reconnect to skip chunks already processed.
  private lastSeq = -1;

  // Track whether userContext was already sent (only
  // needed on the first message of a new thread).
  private contextSent = false;

  constructor(opts: {
    connection: ChatStreamConnection;
    threadId: string;
    workspaceId?: string | undefined;
    getModelId?: (() => string | null) | undefined;
    userContext?: UserContext | undefined;
    getActiveFile?: (() => ActiveFileContext | undefined) | undefined;
  }) {
    this.connection = opts.connection;
    this.threadId = opts.threadId;
    this.workspaceId = opts.workspaceId;
    this.getModelId = opts.getModelId;
    this.userContext = opts.userContext;
    this.getActiveFile = opts.getActiveFile;
  }

  /** Subscribe to stream-chunk events for this thread only. */
  private onChunk(
    callback: (payload: SequencedChunk) => void,
  ): EventUnsubscribe {
    return this.connection.on("stream-chunk", (sequenced) => {
      if (sequenced.threadId !== this.threadId) {
        return;
      }
      callback(sequenced);
    });
  }

  /** Enqueue a chunk into the stream, advance the seq
   *  high-water mark, and finalize on a finish chunk.
   *  Returns true if the stream closed. */
  private enqueueChunk(
    controller: ReadableStreamDefaultController<UIMessageChunk>,
    sequenced: SequencedChunk,
    unsubscribe: () => void,
  ): boolean {
    try {
      this.lastSeq = sequenced.seq;
      controller.enqueue(sequenced.chunk);

      if (sequenced.chunk.type === "finish") {
        unsubscribe();
        controller.close();
        return true;
      }

      return false;
    } catch (error) {
      getAnalytics().captureError(
        new ClientTelemetryError({
          area: "chat-stream",
          message: "Failed to enqueue stream chunk",
          cause: error,
        }),
      );
      unsubscribe();
      return true;
    }
  }

  sendMessages = async ({
    chatId,
    messages,
    abortSignal,
  }: SendMessagesOptions): Promise<ReadableStream<UIMessageChunk>> => {
    const lastMessage = messages.at(-1);
    if (!lastMessage) {
      panic("No messages to send");
    }

    this.lastSeq = -1;

    let unsubscribeStream: EventUnsubscribe | undefined;

    const stream = new ReadableStream<UIMessageChunk>({
      start: (controller) => {
        const unsubscribe = this.onChunk((sequenced) => {
          this.enqueueChunk(controller, sequenced, unsubscribe);
        });
        unsubscribeStream = unsubscribe;

        abortSignal?.addEventListener(
          "abort",
          // eslint-disable-next-line typescript/no-misused-promises
          async () => {
            try {
              controller.close();
            } catch (error) {
              getAnalytics().captureError(
                new ClientTelemetryError({
                  area: "chat-stream",
                  message: "Failed to close stream controller",
                  cause: error,
                }),
              );
            }
            unsubscribe();
            await this.connection.stop({ threadId: this.threadId });
          },
          { once: true },
        );
      },
      cancel: () => {
        unsubscribeStream?.();
      },
    });

    // Send userContext only on the first message so the
    // server can store it in thread metadata once.
    const ctx = this.contextSent ? undefined : this.userContext;
    this.contextSent = true;

    // Drain pending attachments so they travel with this
    // message only; subsequent messages start clean.
    const attachments =
      this.pendingAttachments.length > 0
        ? this.pendingAttachments.splice(0)
        : undefined;

    const { status } = await this.connection.sendMessages({
      threadId: this.threadId,
      chatId,
      message: lastMessage,
      workspaceId: this.workspaceId,
      modelId: this.getModelId?.() ?? undefined,
      userContext: ctx,
      attachments,
      activeFile: this.getActiveFile?.(),
    });

    // Another connection already owns this thread's generation.
    // Close gracefully so the SDK returns to 'ready' state and
    // the stream-started event handler can resume the stream.
    if (status === "busy") {
      // eslint-disable-next-line typescript/no-floating-promises
      stream.cancel();
      return stream;
    }

    return stream;
  };

  reconnectToStream =
    async (): Promise<ReadableStream<UIMessageChunk> | null> => {
      // 1. Subscribe first so nothing is missed.
      const realtimeBuffer: SequencedChunk[] = [];
      const unsubscribeBuffer = this.onChunk((sequenced) => {
        realtimeBuffer.push(sequenced);
      });

      // 2. Get undelivered chunks from the server.
      const resumeFrom = this.lastSeq + 1;
      const { done: streamDone, snapshot } =
        await this.connection.getStreamSnapshot({
          threadId: this.threadId,
          startFromSeq: resumeFrom,
        });

      if (streamDone) {
        unsubscribeBuffer();
        return null;
      }

      // 3. Replay snapshot, then drain buffered realtime
      //    events that arrived after the snapshot cutoff.
      const lastSnapshotSeq = snapshot.at(-1)?.seq ?? -1;
      const pendingIdx = realtimeBuffer.findIndex(
        (c) => c.seq > lastSnapshotSeq,
      );
      const pendingChunks =
        pendingIdx === -1 ? [] : realtimeBuffer.slice(pendingIdx);

      return new ReadableStream<UIMessageChunk>({
        start: (controller) => {
          for (const chunk of snapshot) {
            const done = this.enqueueChunk(
              controller,
              chunk,
              unsubscribeBuffer,
            );
            if (done) {
              return;
            }
          }

          for (const chunk of pendingChunks) {
            const done = this.enqueueChunk(
              controller,
              chunk,
              unsubscribeBuffer,
            );
            if (done) {
              return;
            }
          }

          // Switch to direct pipe.
          unsubscribeBuffer();
          const unsubscribePipe = this.onChunk((sequenced) => {
            this.enqueueChunk(controller, sequenced, unsubscribePipe);
          });
        },
      });
    };
}
