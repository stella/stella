import { describe, expect, test } from "bun:test";

import {
  BROWSER_CONTROL_CONTENT_TRUST,
  BROWSER_CONTROL_ERROR_CODE,
  BROWSER_CONTROL_LIMITS,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_EXTENSION_MESSAGE_SOURCE,
  type BrowserControlResult,
  type BrowserExtensionDownloadMessage,
  type BrowserResultDownload,
  encodeDownloadChunk,
  parseBrowserControlResult,
  parseBrowserExtensionResponse,
} from "@stll/api-contract/browser-control";
import { BROWSER_DOWNLOAD_FILE_MAX_BYTES } from "@stll/api-contract/browser-downloads";

import { createUuid } from "@/lib/uuid";

import {
  BROWSER_DOWNLOAD_FIRST_PIECE_MS,
  BROWSER_DOWNLOAD_IDLE_MS,
  BROWSER_DOWNLOAD_SETTLE_WAIT_MS,
  createBrowserDownloadInbox,
  type FileBrowserDownload,
  type InboxTimer,
} from "./browser-download-inbox";
import type { BrowserSignInDecision } from "./browser-sign-in-handoff";
import { createBrowserToolExecutionCache } from "./browser-tool-execution";

// The chat page's side of a download a chat's browser step made: the
// extension's messages as the content script forwards them (parsed by the
// contract), the real step runner, and the API's filing faked at its edge.

const THREAD = "thread-1";
const OTHER_THREAD = "thread-2";
const TURN = "turn-7";
const CONTROLLER = "controller-1";
const SOURCE = "https://fixture-library.test/decisions/42/file";
const PAGE = "https://fixture-library.test/decisions/42";
const ENTITY = "0195f3a0-0000-7000-8000-000000000042";
const WORKSPACE = "0195f3a0-0000-7000-8000-000000000001";

const success = {
  protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
  snapshot: {
    contentTrust: BROWSER_CONTROL_CONTENT_TRUST.untrustedWebContent,
    elements: [],
    elementsLeftOut: false,
    facts: { meta: [] },
    revision: "revision-1",
    tabId: 7,
    tabs: [{ active: true, tabId: 7, url: PAGE }],
    text: "Decision 42",
    title: "Decision 42",
    url: PAGE,
    window: { cursor: "r1.window", fromPercent: 0, toPercent: 100 },
  },
  status: "success",
} satisfies BrowserControlResult;

const needsSignIn = {
  code: BROWSER_CONTROL_ERROR_CODE.needsMember,
  message: "The page asks for a sign-in.",
  protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
  status: "error",
} satisfies BrowserControlResult;

const pdf = (size: number): Uint8Array => {
  const bytes = new Uint8Array(size);
  bytes.set(new TextEncoder().encode("%PDF-1.7\n"));
  return bytes;
};

/** A clock the test moves; tasks run when it passes them. */
const fakeTimer = () => {
  let now = 0;
  const tasks: { at: number; task: () => void }[] = [];
  /** Settled when a wait of the settle length is next set. */
  let settleWait = Promise.withResolvers<undefined>();
  const timer: InboxTimer = (task, ms) => {
    const entry = { at: now + ms, task };
    tasks.push(entry);
    if (ms === BROWSER_DOWNLOAD_SETTLE_WAIT_MS) {
      settleWait.resolve(undefined);
    }
    return () => {
      const index = tasks.indexOf(entry);
      if (index !== -1) {
        tasks.splice(index, 1);
      }
    };
  };
  const advance = (ms: number) => {
    now += ms;
    for (const entry of [...tasks]
      .filter(({ at }) => at <= now)
      .toSorted((a, b) => a.at - b.at)) {
      tasks.splice(tasks.indexOf(entry), 1);
      entry.task();
    }
  };
  /** Resolves once a step's result has started its settle wait. */
  const waiting = async () => {
    await settleWait.promise;
    settleWait = Promise.withResolvers<undefined>();
  };
  /** The moment the clock shows, from the start of the test. */
  const date = () => new Date(Date.parse("2026-11-25T09:30:00.000Z") + now);
  return { advance, date, timer, waiting };
};

type Filed = Parameters<FileBrowserDownload>[0];

/** The API's filing: a document per new set of bytes, the same one again for the same bytes. */
const fakeApi = () => {
  const calls: { filed: Filed; bytes: Uint8Array }[] = [];
  const held = new Map<string, string>();
  let gate: Promise<void> = Promise.resolve(undefined);
  const file: FileBrowserDownload = async (filed) => {
    await gate;
    const bytes = new Uint8Array(await filed.file.arrayBuffer());
    calls.push({ bytes, filed });
    const key = Buffer.from(bytes).toString("base64");
    const existing = held.get(key);
    held.set(key, existing ?? filed.file.name);
    return {
      filed: {
        duplicate: existing !== undefined,
        entityId: ENTITY,
        name: existing ?? filed.file.name,
        type: "document",
        workspaceId: WORKSPACE,
      },
      outcome: "filed",
      sourceUrl: filed.sourceUrl,
    };
  };
  return {
    calls,
    file,
    /** Holds every filing until the returned function is called. */
    hold: () => {
      let release: () => void = () => undefined;
      gate = new Promise((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
};

const envelope = (deliveryId: string) => ({
  controllerId: CONTROLLER,
  deliveryId,
  protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
  source: BROWSER_EXTENSION_MESSAGE_SOURCE.extension,
});

/** What the extension sends for one download, each message checked as the content script does. */
const messagesFor = (
  deliveryId: string,
  bytes: Uint8Array,
  { turnId = TURN, name = "Judgment 42.pdf" } = {},
): BrowserExtensionDownloadMessage[] => {
  const piece = BROWSER_CONTROL_LIMITS.downloadChunkBytes;
  const chunks = Math.ceil(bytes.byteLength / piece);
  const raw = [
    {
      ...envelope(deliveryId),
      pageUrl: PAGE,
      sourceUrl: SOURCE,
      suggestedName: name,
      turnId,
      type: "download-started",
    },
    ...Array.from({ length: chunks }, (_, index) => ({
      ...envelope(deliveryId),
      data: encodeDownloadChunk(
        bytes.subarray(index * piece, (index + 1) * piece),
      ),
      index,
      type: "download-chunk",
    })),
    {
      ...envelope(deliveryId),
      end: { bytes: bytes.byteLength, chunks, outcome: "captured" },
      type: "download-end",
    },
  ];
  return raw.map((message) => {
    const parsed = parseBrowserExtensionResponse(message);
    if (
      parsed === null ||
      parsed.type === "pong" ||
      parsed.type === "command-result"
    ) {
      throw new Error("Expected a download message");
    }
    return parsed;
  });
};

const stoppedFor = (
  deliveryId: string,
  reason: "not-refetchable" | "too-large",
): BrowserExtensionDownloadMessage[] => {
  const [started] = messagesFor(deliveryId, pdf(16));
  if (started === undefined) {
    throw new Error("Expected a start");
  }
  return [
    started,
    {
      ...envelope(deliveryId),
      end: { outcome: "stopped", reason },
      type: "download-end",
    },
  ];
};

const deliveryId = () => createUuid();

const SNAPSHOT = { action: "snapshot" } as const;

/** A chat whose browser steps go through the real runner with this inbox. */
const chat = (
  execute: Parameters<typeof createBrowserToolExecutionCache>[0],
  {
    waitForSignIn,
    filesNothing = false,
  }: {
    waitForSignIn?: () => Promise<BrowserSignInDecision>;
    filesNothing?: boolean;
  } = {},
) => {
  const api = fakeApi();
  const clock = fakeTimer();
  const inbox = createBrowserDownloadInbox({
    file: api.file,
    now: clock.date,
    timer: clock.timer,
  });
  const cache = createBrowserToolExecutionCache(
    execute,
    () => () => undefined,
    () => ({ by: "level", type: "run" }),
    {
      openStep: () => inbox.openStep(THREAD),
      ...(waitForSignIn === undefined
        ? {}
        : { waitForSignIn: async () => await waitForSignIn() }),
    },
  );
  let call = 0;
  return {
    api,
    clock,
    inbox,
    step: async (input?: unknown) => {
      call += 1;
      inbox.rememberTurn(TURN, { filesNothing, threadId: THREAD });
      return await cache.executeOnce(
        `call-${String(call)}`,
        input ?? SNAPSHOT,
        {
          signal: new AbortController().signal,
          turnId: TURN,
        },
      );
    },
  };
};

const downloadsOf = (
  result: BrowserControlResult,
): BrowserResultDownload[] | undefined => {
  // What the model is handed is still a result the contract accepts.
  expect(parseBrowserControlResult(result)).not.toBeNull();
  return result.downloads;
};

describe("a chat's browser downloads, filed from the chat page", () => {
  test("a PDF its step downloaded is filed with the chat, and the step's result names the document", async () => {
    const bytes = pdf(BROWSER_CONTROL_LIMITS.downloadChunkBytes + 512);
    const id = deliveryId();
    let receive: (message: BrowserExtensionDownloadMessage) => void = () =>
      undefined;
    const { api, inbox, step } = chat(async () => {
      for (const message of messagesFor(id, bytes)) {
        receive(message);
      }
      return await Promise.resolve(success);
    });
    receive = inbox.receive;

    const result = await step();

    expect(downloadsOf(result)).toEqual([
      {
        filed: {
          duplicate: false,
          entityId: ENTITY,
          name: "Judgment 42.pdf",
          type: "document",
          workspaceId: WORKSPACE,
        },
        outcome: "filed",
        sourceUrl: SOURCE,
      },
    ]);
    expect(api.calls).toHaveLength(1);
    const [call] = api.calls;
    expect(call?.filed).toMatchObject({
      downloadedAt: "2026-11-25T09:30:00.000Z",
      pageUrl: PAGE,
      sourceUrl: SOURCE,
      threadId: THREAD,
    });
    expect(Buffer.from(call?.bytes ?? []).equals(Buffer.from(bytes))).toBe(
      true,
    );
    // Reported once: the next result carries nothing more.
    expect(downloadsOf(await step())).toBeUndefined();
  });

  test("the same bytes again name the document the matter already holds", async () => {
    const bytes = pdf(2048);
    let receive: (message: BrowserExtensionDownloadMessage) => void = () =>
      undefined;
    const { api, inbox, step } = chat(async () => {
      for (const message of messagesFor(deliveryId(), bytes, {
        name: `Judgment 42 (${String(api.calls.length)}).pdf`,
      })) {
        receive(message);
      }
      return await Promise.resolve(success);
    });
    receive = inbox.receive;

    const first = downloadsOf(await step());
    const second = downloadsOf(await step());

    expect(first).toMatchObject([
      { filed: { duplicate: false, name: "Judgment 42 (0).pdf" } },
    ]);
    expect(second).toMatchObject([
      { filed: { duplicate: true, name: "Judgment 42 (0).pdf" } },
    ]);
  });

  test("a download still filing after the wait rides on the chat's next result", async () => {
    const id = deliveryId();
    let receive: (message: BrowserExtensionDownloadMessage) => void = () =>
      undefined;
    let first = true;
    const { api, clock, inbox, step } = chat(async () => {
      if (first) {
        first = false;
        for (const message of messagesFor(id, pdf(4096))) {
          receive(message);
        }
      }
      return await Promise.resolve(success);
    });
    receive = inbox.receive;
    const release = api.hold();

    const stepping = step();
    await clock.waiting();
    clock.advance(BROWSER_DOWNLOAD_SETTLE_WAIT_MS);
    const late = await stepping;

    expect(downloadsOf(late)).toBeUndefined();
    release();
    // The filing finishes after the result went out.
    await inbox.idle();
    expect(downloadsOf(await step())).toMatchObject([
      { filed: { duplicate: false }, outcome: "filed" },
    ]);
  });

  test("a download that arrives while the member signs in is listed by the result after it", async () => {
    const id = deliveryId();
    let receive: (message: BrowserExtensionDownloadMessage) => void = () =>
      undefined;
    let runs = 0;
    const { inbox, step } = chat(
      async () => {
        runs += 1;
        return await Promise.resolve(runs === 1 ? needsSignIn : success);
      },
      {
        // The member signs in; the site hands over the file meanwhile.
        waitForSignIn: async () => {
          for (const message of messagesFor(id, pdf(2048))) {
            receive(message);
          }
          return await Promise.resolve("resume");
        },
      },
    );
    receive = inbox.receive;

    const result = await step({ action: "open", url: PAGE });

    expect(runs).toBe(2);
    expect(result.status).toBe("success");
    expect(downloadsOf(result)).toMatchObject([{ outcome: "filed" }]);
  });

  test("a file larger than what is filed, a stopped one, or one that cannot be fetched again is not filed, with why", async () => {
    let receive: (message: BrowserExtensionDownloadMessage) => void = () =>
      undefined;
    const tooLargeId = deliveryId();
    const { api, inbox, step } = chat(async () => {
      // More pieces than a filed file may hold.
      const pieces = Math.floor(
        BROWSER_DOWNLOAD_FILE_MAX_BYTES /
          BROWSER_CONTROL_LIMITS.downloadChunkBytes,
      );
      const [started] = messagesFor(tooLargeId, pdf(16));
      if (started !== undefined) {
        receive(started);
      }
      const full = encodeDownloadChunk(
        pdf(BROWSER_CONTROL_LIMITS.downloadChunkBytes),
      );
      for (let index = 0; index <= pieces; index += 1) {
        receive({
          ...envelope(tooLargeId),
          data: full,
          index,
          type: "download-chunk",
        });
      }
      for (const message of [
        ...stoppedFor(deliveryId(), "too-large"),
        ...stoppedFor(deliveryId(), "not-refetchable"),
      ]) {
        receive(message);
      }
      return await Promise.resolve(success);
    });
    receive = inbox.receive;

    const downloads = downloadsOf(await step());

    expect(api.calls).toEqual([]);
    expect(downloads?.map((download) => download.outcome)).toEqual([
      "not-filed",
      "not-filed",
      "not-filed",
    ]);
    const messages = downloads?.map((download) =>
      download.outcome === "not-filed" ? download.message : "",
    );
    expect(messages?.at(0)).toContain("larger");
    expect(messages?.at(1)).toContain("larger");
    expect(messages?.at(2)).toContain("could not be fetched again");
  });

  test("a gap in the pieces, or pieces that stop arriving, file nothing", async () => {
    let receive: (message: BrowserExtensionDownloadMessage) => void = () =>
      undefined;
    const gapped = deliveryId();
    const stalled = deliveryId();
    const { api, clock, inbox, step } = chat(async () => {
      const piece = BROWSER_CONTROL_LIMITS.downloadChunkBytes;
      const [start, , second, end] = messagesFor(gapped, pdf(piece + 10));
      for (const message of [start, second, end]) {
        if (message !== undefined) {
          receive(message);
        }
      }
      const [stalledStart] = messagesFor(stalled, pdf(16));
      if (stalledStart !== undefined) {
        receive(stalledStart);
      }
      return await Promise.resolve(success);
    });
    receive = inbox.receive;

    const stepping = step();
    await clock.waiting();
    clock.advance(BROWSER_DOWNLOAD_SETTLE_WAIT_MS);
    const first = downloadsOf(await stepping);
    // The first piece waits as long as the extension may take to fetch the
    // file: a pause between later pieces would have ended it by now.
    clock.advance(BROWSER_DOWNLOAD_IDLE_MS);
    const waiting = downloadsOf(await step());
    clock.advance(BROWSER_DOWNLOAD_FIRST_PIECE_MS);
    const second = downloadsOf(await step());

    expect(api.calls).toEqual([]);
    expect(first).toMatchObject([{ outcome: "not-filed" }]);
    expect(waiting).toBeUndefined();
    expect(second).toMatchObject([{ outcome: "not-filed" }]);
  });

  test("in Plan mode nothing is filed, and the result says so", async () => {
    let receive: (message: BrowserExtensionDownloadMessage) => void = () =>
      undefined;
    const { api, inbox, step } = chat(
      async () => {
        for (const message of messagesFor(deliveryId(), pdf(2048))) {
          receive(message);
        }
        return await Promise.resolve(success);
      },
      { filesNothing: true },
    );
    receive = inbox.receive;

    const downloads = downloadsOf(await step());

    expect(api.calls).toEqual([]);
    expect(downloads).toEqual([
      {
        message: "In Plan mode stella files nothing into the matter.",
        name: "Judgment 42.pdf",
        outcome: "not-filed",
        sourceUrl: SOURCE,
      },
    ]);
  });

  test("a download for a turn this tab ran no command for is never filed, nor shown to another chat", async () => {
    const api = fakeApi();
    const inbox = createBrowserDownloadInbox({ file: api.file });
    inbox.rememberTurn(TURN, { filesNothing: false, threadId: THREAD });

    for (const message of messagesFor(deliveryId(), pdf(2048), {
      turnId: "turn-of-another-tab",
    })) {
      inbox.receive(message);
    }
    const other = await inbox.openStep(OTHER_THREAD).close(success);
    const own = await inbox.openStep(THREAD).close(success);

    expect(api.calls).toEqual([]);
    expect(other.downloads).toBeUndefined();
    expect(own.downloads).toBeUndefined();
  });

  test("a result lists at most a result's worth of downloads; the rest wait for the next", async () => {
    let receive: (message: BrowserExtensionDownloadMessage) => void = () =>
      undefined;
    const count = BROWSER_CONTROL_LIMITS.resultDownloads + 2;
    let first = true;
    const { inbox, step } = chat(async () => {
      if (first) {
        first = false;
        for (let index = 0; index < count; index += 1) {
          for (const message of stoppedFor(deliveryId(), "not-refetchable")) {
            receive(message);
          }
        }
      }
      return await Promise.resolve(success);
    });
    receive = inbox.receive;

    expect(downloadsOf(await step())).toHaveLength(
      BROWSER_CONTROL_LIMITS.resultDownloads,
    );
    expect(downloadsOf(await step())).toHaveLength(2);
  });
  test("a download that starts long after its chat's step ended is never filed, for that chat or another", async () => {
    let receive: (message: BrowserExtensionDownloadMessage) => void = () =>
      undefined;
    const { api, clock, inbox, step } = chat(
      async () => await Promise.resolve(success),
    );
    receive = inbox.receive;
    await step();

    // A page's export lands well after the step: whose it is cannot be told.
    clock.advance(BROWSER_DOWNLOAD_SETTLE_WAIT_MS + 1);
    for (const message of messagesFor(deliveryId(), pdf(2048))) {
      receive(message);
    }

    expect(downloadsOf(await step())).toBeUndefined();
    expect(api.calls).toEqual([]);
  });

  test("a download beyond the inbox's capacity is reported once and never taken", async () => {
    let receive: (message: BrowserExtensionDownloadMessage) => void = () =>
      undefined;
    const ids = Array.from({ length: 9 }, () => deliveryId());
    let first = true;
    const { api, clock, inbox, step } = chat(async () => {
      if (first) {
        first = false;
        // Eight start and wait for their pieces; the ninth finds no room.
        for (const id of ids) {
          const [started] = messagesFor(id, pdf(16));
          if (started !== undefined) {
            receive(started);
            receive(started);
          }
        }
      }
      return await Promise.resolve(success);
    });
    receive = inbox.receive;

    const stepping = step();
    await clock.waiting();
    clock.advance(BROWSER_DOWNLOAD_SETTLE_WAIT_MS);
    const downloads = downloadsOf(await stepping);

    expect(api.calls).toEqual([]);
    expect(downloads).toMatchObject([
      { message: expect.stringContaining("Too many"), outcome: "not-filed" },
    ]);
  });
});
