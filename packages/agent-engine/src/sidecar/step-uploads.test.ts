import { panic, Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CHAT_LOCAL_RUN_STEP_CONTENT_RUN_BUDGET,
  chatLocalRunStepContentUploadPath,
} from "@stll/api-contract/chat-local-run-step-content";
import { CHAT_LOCAL_RUN_STEP_MAX_BYTES } from "@stll/api-contract/chat-local-run-step-output";

import { keepStepOutput, stepOutputRunDir } from "./step-outputs";
import {
  createStepUploads,
  type StepContentUpload,
  stepContentUploader,
  type StepUploadOutcome,
  type UploadStepContent,
} from "./step-uploads";

const RUN_ID = "0b6f5c8e-2d3a-4f1b-9c7e-5a4d3b2c1e0f";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "stella-step-uploads-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const pendingDir = () => `${stepOutputRunDir(root, RUN_ID)}.pending`;

const sorted = (names: readonly string[]) =>
  names.toSorted((left, right) => (left < right ? -1 : 1));

/** The step keys still waiting to be sent; none once the folder is gone. */
const pending = async () => {
  const names = await Result.tryPromise(
    async () => await readdir(pendingDir()),
  );
  return Result.isOk(names) ? sorted(names.value) : [];
};

/** Keep a command step's output as the sidecar does, and answer what it kept. */
const keep = async (toolCallId: string, output: string) => {
  const kept = await keepStepOutput({
    stepOutputDir: root,
    workspaceDir: root,
    runId: RUN_ID,
    toolCallId,
    output: { type: "command", output },
  });
  return kept.unwrap() ?? panic("a command step keeps its output");
};

const uploadsWith = (upload: UploadStepContent) =>
  createStepUploads({
    pendingDir: pendingDir(),
    keptFile: (stepKey) => path.join(stepOutputRunDir(root, RUN_ID), stepKey),
    upload,
    log: () => {},
  });

const text = (content: Uint8Array | null) =>
  content === null ? null : new TextDecoder().decode(content);

describe("sending what a run's steps produced", () => {
  test("a kept step is sent with its kind and size, and leaves the folder", async () => {
    const sent: StepContentUpload[] = [];
    const uploads = uploadsWith(async (step) => {
      sent.push(step);
      return await Promise.resolve("done");
    });
    const step = await keep("call-1", "3 pass\n");
    await uploads.send(step, 1000);
    expect(
      sent.map(({ content, ...rest }) => ({ ...rest, text: text(content) })),
    ).toEqual([
      {
        stepKey: step.stepKey,
        kind: "command",
        totalBytes: 7,
        text: "3 pass\n",
      },
    ]);
    expect(await pending()).toEqual([]);
  });

  test("on a healthy connection the content is sent before the step's event goes on", async () => {
    const order: string[] = [];
    const uploads = uploadsWith(async () => {
      // Answered on a later turn of the loop, as a request is.
      await Promise.resolve();
      order.push("stored");
      return "done";
    });
    await uploads.send(await keep("call-1", "out"), 5000);
    order.push("event");
    expect(order).toEqual(["stored", "event"]);
  });

  test("a slow send holds the step's event no longer than its wait, and still finishes", async () => {
    const order: string[] = [];
    const release = Promise.withResolvers<StepUploadOutcome>();
    const uploads = uploadsWith(async () => {
      const outcome = await release.promise;
      order.push("stored");
      return outcome;
    });
    const step = await keep("call-1", "out");
    await uploads.send(step, 30);
    order.push("event");
    // Still waiting to be sent while the event has gone on.
    expect(await pending()).toEqual([step.stepKey]);
    release.resolve("done");
    await uploads.drain(5000);
    expect(order).toEqual(["event", "stored"]);
    expect(await pending()).toEqual([]);
  });

  test("steps that could not be sent wait on disk and go with the next that can", async () => {
    let away = true;
    let inFlight = 0;
    let mostInFlight = 0;
    const sent: string[] = [];
    const uploads = uploadsWith(async ({ stepKey }) => {
      inFlight += 1;
      mostInFlight = Math.max(mostInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      if (away) {
        return "retry";
      }
      sent.push(stepKey);
      return "done";
    });
    const first = await keep("call-1", "one");
    const second = await keep("call-2", "two");
    await uploads.send(first, 1000);
    await uploads.send(second, 1000);
    expect(await pending()).toEqual(sorted([first.stepKey, second.stepKey]));
    away = false;
    const third = await keep("call-3", "three");
    await uploads.send(third, 1000);
    expect(sorted(sent)).toEqual(
      sorted([first.stepKey, second.stepKey, third.stepKey]),
    );
    expect(await pending()).toEqual([]);
    expect(mostInFlight).toBe(1);
  });

  test("a run that is over sends nothing more and leaves no folder", async () => {
    let calls = 0;
    const uploads = uploadsWith(async () => {
      calls += 1;
      return await Promise.resolve("retry");
    });
    const step = await keep("call-1", "out");
    await uploads.send(step, 1000);
    expect(await pending()).toEqual([step.stepKey]);
    await uploads.close();
    expect(await pending()).toEqual([]);
    const before = calls;
    await uploads.send(await keep("call-2", "late"), 1000);
    await uploads.drain(1000);
    expect(calls).toBe(before);
    expect(await pending()).toEqual([]);
  });

  test("a marker that names no kept step is dropped, never sent", async () => {
    let calls = 0;
    const uploads = uploadsWith(async () => {
      calls += 1;
      return await Promise.resolve("done");
    });
    const step = await keep("call-1", "out");
    await rm(path.join(stepOutputRunDir(root, RUN_ID), step.stepKey));
    await uploads.send(step, 1000);
    expect(calls).toBe(0);
    expect(await pending()).toEqual([]);
  });
});

/**
 * The one part a step's multipart body carries, as text: between the part's
 * headers and the closing boundary. `null` for a body with no part.
 */
const contentOf = (body: string) => {
  const start = body.indexOf("\r\n\r\n");
  const end = body.lastIndexOf("\r\n--");
  return start === -1 || end < start + 4 ? null : body.slice(start + 4, end);
};

type Received = {
  path: string;
  kind: string | null;
  totalBytes: string | null;
  authorization: string | null;
  content: string | null;
};

/**
 * A local API: answers what `answer` says, and records each request unless
 * told to keep none (a long run's requests would otherwise be held here).
 */
const serveApi = (
  answer: (request: Received) => Response,
  keeps: "requests" | "nothing" = "requests",
) => {
  const received: Received[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const record = {
        path: url.pathname,
        kind: url.searchParams.get("kind"),
        totalBytes: url.searchParams.get("totalBytes"),
        authorization: request.headers.get("authorization"),
        content: contentOf(await request.text()),
      };
      if (keeps === "requests") {
        received.push(record);
      }
      return answer(record);
    },
  });
  return {
    received,
    origin: `http://127.0.0.1:${String(server.port)}`,
    stop: async () => {
      await server.stop(true);
    },
  };
};

const settledAs = (state: string) => Response.json({ state });

const STEP_KEY = "ab".repeat(32);

const commandStep = (content: string): StepContentUpload => ({
  stepKey: STEP_KEY,
  kind: "command",
  totalBytes: Buffer.byteLength(content),
  content: new TextEncoder().encode(content),
});

const IN_TIME = () => AbortSignal.timeout(5000);

describe("one step's request to the API", () => {
  test("puts the kept bytes to the step's path with the run's token", async () => {
    const api = serveApi(() => settledAs("stored"));
    const upload = stepContentUploader({
      apiOrigin: api.origin,
      runId: RUN_ID,
      token: () => "run-token-1",
    });
    expect(await upload(commandStep("ok ✓"), IN_TIME())).toBe("done");
    // An image past its cap sends its size and no content.
    expect(
      await upload(
        {
          stepKey: STEP_KEY,
          kind: "image",
          totalBytes: 20_000_000,
          content: null,
        },
        IN_TIME(),
      ),
    ).toBe("done");
    await api.stop();
    expect(api.received).toEqual([
      {
        path: chatLocalRunStepContentUploadPath(RUN_ID, STEP_KEY),
        kind: "command",
        totalBytes: String(Buffer.byteLength("ok ✓")),
        authorization: "Bearer run-token-1",
        content: "ok ✓",
      },
      {
        path: chatLocalRunStepContentUploadPath(RUN_ID, STEP_KEY),
        kind: "image",
        totalBytes: "20000000",
        authorization: "Bearer run-token-1",
        content: null,
      },
    ]);
  });

  test("a refusal for good is not sent again; an API that is away is", async () => {
    const outcomes = new Map<number, StepUploadOutcome>();
    for (const status of [401, 404, 409, 422, 429, 500, 503]) {
      const api = serveApi(() => new Response(null, { status }));
      const upload = stepContentUploader({
        apiOrigin: api.origin,
        runId: RUN_ID,
        token: () => "run-token-1",
      });
      outcomes.set(status, await upload(commandStep("x"), IN_TIME()));
      await api.stop();
    }
    expect(Object.fromEntries(outcomes)).toEqual({
      401: "retry",
      404: "done",
      409: "done",
      422: "done",
      429: "retry",
      500: "retry",
      503: "retry",
    });
  });

  test("no token, no answer and an answer that is not the API's all wait", async () => {
    const stranger = serveApi(() => Response.json({ ok: true }));
    const answered = stepContentUploader({
      apiOrigin: stranger.origin,
      runId: RUN_ID,
      token: () => "run-token-1",
    });
    expect(await answered(commandStep("x"), IN_TIME())).toBe("retry");
    const withoutToken = stepContentUploader({
      apiOrigin: stranger.origin,
      runId: RUN_ID,
      token: () => null,
    });
    expect(await withoutToken(commandStep("x"), IN_TIME())).toBe("retry");
    expect(stranger.received).toHaveLength(1);
    await stranger.stop();
    // The listener is gone: nothing answers.
    expect(await answered(commandStep("x"), IN_TIME())).toBe("retry");
  });
});

describe("a run of hours", () => {
  // timeout: thousands of kept files and requests to a local listener.
  test("thousands of steps are sent from disk, one at a time, with bounded memory", async () => {
    const SMALL_STEPS = 3000;
    const CAPPED_STEPS = 24;
    const AWAY_FOR = 1500;
    // The run had stored nearly all it may before these steps.
    const budget = CHAT_LOCAL_RUN_STEP_CONTENT_RUN_BUDGET.textBytes;
    // Room for every small step and three at the cap, whatever their order.
    let stored = budget - 3 * CHAT_LOCAL_RUN_STEP_MAX_BYTES.text - 64 * 1024;
    let away = true;
    let inFlight = 0;
    let mostInFlight = 0;
    const states = new Map<string, number>();
    const api = serveApi(({ content }) => {
      if (away) {
        return new Response(null, { status: 503 });
      }
      const bytes = Buffer.byteLength(content ?? "");
      const fits = stored + bytes <= budget;
      if (fits) {
        stored += bytes;
      }
      const state = fits ? "stored" : "run_budget_reached";
      states.set(state, (states.get(state) ?? 0) + 1);
      return settledAs(state);
    }, "nothing");
    const send = stepContentUploader({
      apiOrigin: api.origin,
      runId: RUN_ID,
      token: () => "run-token-1",
    });
    const uploads = uploadsWith(async (step, signal) => {
      inFlight += 1;
      mostInFlight = Math.max(mostInFlight, inFlight);
      const outcome = await send(step, signal);
      inFlight -= 1;
      return outcome;
    });
    const capped = "x".repeat(CHAT_LOCAL_RUN_STEP_MAX_BYTES.text);

    Bun.gc(true);
    const heapBefore = process.memoryUsage().heapUsed;
    for (let index = 0; index < SMALL_STEPS + CAPPED_STEPS; index += 1) {
      if (index === AWAY_FOR) {
        // While the API was away every step waited on disk, none in memory.
        expect(await pending()).toHaveLength(AWAY_FOR);
        away = false;
      }
      const output =
        index >= SMALL_STEPS ? capped : `step ${String(index)} ok\n`;
      // await-in-loop: steps complete one after another, as a turn's do.
      await uploads.send(await keep(`call-${String(index)}`, output), 200);
    }
    await uploads.drain(60_000);
    Bun.gc(true);
    const heapGrowth = process.memoryUsage().heapUsed - heapBefore;
    await api.stop();

    expect(await pending()).toEqual([]);
    expect(mostInFlight).toBe(1);
    // Every step settled: the small ones and three capped ones fit, the rest
    // of the capped ones found the run's budget reached.
    expect(Object.fromEntries(states)).toEqual({
      stored: SMALL_STEPS + 3,
      run_budget_reached: CAPPED_STEPS - 3,
    });
    // Half of what the capped steps alone weigh, were they held.
    expect(heapGrowth).toBeLessThan(
      (CAPPED_STEPS * CHAT_LOCAL_RUN_STEP_MAX_BYTES.text) / 2,
    );
    await uploads.close();
  }, 120_000);
});
