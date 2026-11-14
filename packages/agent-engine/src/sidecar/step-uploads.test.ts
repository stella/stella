import { panic, Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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
  type StepUploadTimer,
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
const awaitedDir = () => `${stepOutputRunDir(root, RUN_ID)}.awaited`;

const sorted = (names: readonly string[]) =>
  names.toSorted((left, right) => (left < right ? -1 : 1));

const namesIn = async (dir: string) => {
  const names = await Result.tryPromise(async () => await readdir(dir));
  return Result.isOk(names) ? sorted(names.value) : [];
};

/** The step keys still waiting to be sent; none once the folder is gone. */
const pending = async () => await namesIn(pendingDir());

/** The step keys handed over at the run's end; none without the folder. */
const awaited = async () => await namesIn(awaitedDir());

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

const uploadsWith = (upload: UploadStepContent, timer?: StepUploadTimer) =>
  createStepUploads({
    pendingDir: pendingDir(),
    awaitedDir: awaitedDir(),
    keptFile: (stepKey) => path.join(stepOutputRunDir(root, RUN_ID), stepKey),
    upload,
    log: () => {},
    ...(timer === undefined ? {} : { timer }),
  });

/**
 * A timer the test turns by hand: every wait asked for is counted, and
 * passes only when the test says so.
 */
const handTimer = () => {
  const waits: PromiseWithResolvers<"waited">[] = [];
  const firstAsked = Promise.withResolvers<null>();
  const timer: StepUploadTimer = () => {
    const wait = Promise.withResolvers<"waited">();
    waits.push(wait);
    firstAsked.resolve(null);
    return { promise: wait.promise, cancel: () => {} };
  };
  return {
    timer,
    /** Resolves once a first wait was asked for. */
    firstAsked: firstAsked.promise,
    /** How many waits were asked for so far. */
    asked: () => waits.length,
    /** Let the latest wait pass. */
    pass: () => {
      waits.at(-1)?.resolve("waited");
    },
  };
};

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
    await uploads.drain({ waitMs: 5000, retryEveryMs: 1 });
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
    // Sending was in trouble, so this step does not wait for it either.
    await uploads.send(third, 1000);
    await uploads.drain({ waitMs: 5000, retryEveryMs: 1 });
    expect(sorted(sent)).toEqual(
      sorted([first.stepKey, second.stepKey, third.stepKey]),
    );
    expect(await pending()).toEqual([]);
    expect(mostInFlight).toBe(1);
  });

  const STEPS = 200;

  /** Keep and send `STEPS` steps one after another, as a turn's events do. */
  const sendSteps = async (
    uploads: ReturnType<typeof uploadsWith>,
    onSent: (index: number) => void,
  ) => {
    const keys: string[] = [];
    for (let index = 0; index < STEPS; index += 1) {
      // await-in-loop: steps complete one after another, as a turn's do.
      const step = await keep(`call-${String(index)}`, `out ${String(index)}`);
      keys.push(step.stepKey);
      await uploads.send(step, 3000);
      onSent(index);
    }
    return keys;
  };

  test("an API that never answers costs a run one wait, not one per step", async () => {
    const hand = handTimer();
    const answers = Promise.withResolvers<StepUploadOutcome>();
    const stored: string[] = [];
    let recovered = false;
    const uploads = uploadsWith(async ({ stepKey }) => {
      // The first request hangs until the API is back; later ones answer.
      const outcome = recovered ? "done" : await answers.promise;
      stored.push(stepKey);
      return outcome;
    }, hand.timer);
    const order: number[] = [];
    // The first step waits; its wait passing is what marks the trouble.
    const first = await keep("call-first", "out first");
    const waiting = uploads.send(first, 3000);
    await hand.firstAsked;
    expect(hand.asked()).toBe(1);
    hand.pass();
    await waiting;
    const keys = await sendSteps(uploads, (index) => {
      order.push(index);
    });
    // No later step asked for a wait, and their events went on in order.
    expect(hand.asked()).toBe(1);
    expect(order).toEqual(Array.from({ length: STEPS }, (_, index) => index));
    expect(await pending()).toHaveLength(STEPS + 1);
    // The API recovers: everything queued is stored, each step once.
    recovered = true;
    answers.resolve("done");
    await uploads.drain({ waitMs: 600_000, retryEveryMs: 1 });
    expect(await pending()).toEqual([]);
    expect(sorted(stored)).toEqual(sorted([first.stepKey, ...keys]));
  });

  test("an API that answers late stops being waited for, and is waited for again once it keeps up", async () => {
    const hand = handTimer();
    const late = Promise.withResolvers<StepUploadOutcome>();
    const stored: string[] = [];
    let slow = true;
    const uploads = uploadsWith(async ({ stepKey }) => {
      const outcome = slow ? await late.promise : "done";
      stored.push(stepKey);
      return outcome;
    }, hand.timer);
    const first = await keep("call-first", "out first");
    const waiting = uploads.send(first, 3000);
    await hand.firstAsked;
    hand.pass();
    await waiting;
    const order: number[] = [];
    const keys = await sendSteps(uploads, (index) => {
      order.push(index);
    });
    expect(hand.asked()).toBe(1);
    expect(order).toEqual(Array.from({ length: STEPS }, (_, index) => index));
    // The late answer arrives; the rest follow at once.
    slow = false;
    late.resolve("done");
    await uploads.drain({ waitMs: 600_000, retryEveryMs: 1 });
    expect(await pending()).toEqual([]);
    expect(sorted(stored)).toEqual(sorted([first.stepKey, ...keys]));
    // Sending kept up again, so the next step's content is stored before
    // its event goes on.
    const next = await keep("call-next", "out next");
    await uploads.send(next, 3000);
    expect(stored.at(-1)).toBe(next.stepKey);
  });

  test("a turn's end keeps trying while the API is away, and sends once it is back", async () => {
    let calls = 0;
    const uploads = uploadsWith(async () => {
      calls += 1;
      return await Promise.resolve(calls < 3 ? "retry" : "done");
    });
    const step = await keep("call-1", "out");
    // The step's own wait tries once and goes on.
    await uploads.send(step, 1000);
    expect(calls).toBe(1);
    expect(await pending()).toEqual([step.stepKey]);
    await uploads.drain({ waitMs: 60_000, retryEveryMs: 1 });
    expect(calls).toBe(3);
    expect(await pending()).toEqual([]);
  });

  test("a turn's end does not wait for an API that cannot be reached", async () => {
    let calls = 0;
    const uploads = uploadsWith(async () => {
      calls += 1;
      return await Promise.resolve("away");
    });
    const step = await keep("call-1", "out");
    await uploads.send(step, 1000);
    await uploads.drain({ waitMs: 600_000, retryEveryMs: 600_000 });
    expect(calls).toBe(2);
    expect(await pending()).toEqual([step.stepKey]);
  });

  test("a stop ends a turn's wait for an API that keeps refusing for now", async () => {
    const stop = new AbortController();
    let calls = 0;
    const retried = Promise.withResolvers<null>();
    const uploads = uploadsWith(async () => {
      calls += 1;
      if (calls === 2) {
        retried.resolve(null);
      }
      return await Promise.resolve("retry");
    });
    const step = await keep("call-1", "out");
    await uploads.send(step, 1000);
    const drained = uploads.drain({
      waitMs: 600_000,
      retryEveryMs: 600_000,
      signal: stop.signal,
    });
    // The end's own try was made, and it now pauses before the next.
    await retried.promise;
    stop.abort();
    await drained;
    // What could not be sent still waits; the run's end drops it.
    expect(await pending()).toEqual([step.stepKey]);
    await uploads.close();
    expect(await pending()).toEqual([]);
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
    await uploads.drain({ waitMs: 1000, retryEveryMs: 1 });
    expect(calls).toBe(before);
    expect(await pending()).toEqual([]);
  });

  test("a run's end names the steps still waiting and leaves them to be sent after it", async () => {
    let calls = 0;
    const uploads = uploadsWith(async () => {
      calls += 1;
      return await Promise.resolve("away");
    });
    const first = await keep("call-1", "one");
    const second = await keep("call-2", "two");
    await uploads.send(first, 1000);
    await uploads.send(second, 1000);
    const left = (await uploads.leave(10)).unwrap();
    expect(sorted(left.stepKeys)).toEqual(
      sorted([first.stepKey, second.stepKey]),
    );
    expect(left.more).toBe(0);
    // Nothing is sent from here once the run named what it holds.
    const before = calls;
    await uploads.send(await keep("call-3", "late"), 1000);
    await uploads.drain({ waitMs: 1000, retryEveryMs: 1 });
    await uploads.close();
    expect(calls).toBe(before);
    // The named markers are handed over, and with their kept files outlive
    // the run; the run's own folder is gone.
    expect(await awaited()).toEqual(sorted(left.stepKeys));
    expect(await readdir(root)).toEqual([RUN_ID, `${RUN_ID}.awaited`]);
    const keptDir = stepOutputRunDir(root, RUN_ID);
    expect(await readdir(keptDir)).toEqual(
      expect.arrayContaining([first.stepKey, second.stepKey]),
    );
  });

  test("past the bound a run's end names a count, and keeps only the steps it named", async () => {
    const uploads = uploadsWith(async () => await Promise.resolve("away"));
    const kept: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const step = await keep(`call-${String(index)}`, "out");
      kept.push(step.stepKey);
      await uploads.send(step, 1000);
    }
    const left = (await uploads.leave(2)).unwrap();
    expect(left.stepKeys).toHaveLength(2);
    expect(left.more).toBe(3);
    expect(kept).toEqual(expect.arrayContaining(left.stepKeys));
    await uploads.close();
    expect(await awaited()).toEqual(sorted(left.stepKeys));
    expect(await pending()).toEqual([]);
  });

  test("a run's end with nothing waiting names nothing and leaves no folder", async () => {
    const uploads = uploadsWith(async () => await Promise.resolve("done"));
    await uploads.send(await keep("call-1", "out"), 1000);
    expect((await uploads.leave(10)).unwrap()).toEqual({
      stepKeys: [],
      more: 0,
    });
    expect(await readdir(root)).toEqual([RUN_ID]);
    await uploads.close();
    expect(await readdir(root)).toEqual([RUN_ID]);
  });

  test("a run's end names markers only: anything else in the folder is removed, a link is not followed", async () => {
    const uploads = uploadsWith(async () => await Promise.resolve("away"));
    const step = await keep("call-1", "out");
    await uploads.send(step, 1000);
    const outside = path.join(root, "outside.txt");
    await writeFile(outside, "not a step");
    const linked = "a".repeat(64);
    await symlink(outside, path.join(pendingDir(), linked));
    await writeFile(path.join(pendingDir(), "notes.txt"), "text");
    await mkdir(path.join(pendingDir(), "b".repeat(64)));
    const left = (await uploads.leave(10)).unwrap();
    expect(left).toEqual({ stepKeys: [step.stepKey], more: 0 });
    expect(await awaited()).toEqual([step.stepKey]);
    expect(await readFile(outside, "utf-8")).toBe("not a step");
  });

  test("a run's end stops a send that is under way and names its step", async () => {
    const started = Promise.withResolvers<null>();
    const hand = handTimer();
    const uploads = uploadsWith(async (_step, signal) => {
      started.resolve(null);
      const aborted = Promise.withResolvers<StepUploadOutcome>();
      signal.addEventListener("abort", () => {
        aborted.resolve("away");
      });
      return await aborted.promise;
    }, hand.timer);
    const step = await keep("call-1", "out");
    const sent = uploads.send(step, 1000);
    await started.promise;
    const left = (await uploads.leave(10)).unwrap();
    hand.pass();
    await sent;
    expect(left).toEqual({ stepKeys: [step.stepKey], more: 0 });
    expect(await awaited()).toEqual([step.stepKey]);
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

  test("a refusal for good is not sent again; an API that cannot take it now is asked again", async () => {
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

  test("no token and no answer are an API that is away; a foreign answer is asked again", async () => {
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
    expect(await withoutToken(commandStep("x"), IN_TIME())).toBe("away");
    expect(stranger.received).toHaveLength(1);
    await stranger.stop();
    // The listener is gone: nothing answers.
    expect(await answered(commandStep("x"), IN_TIME())).toBe("away");
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
    await uploads.drain({ waitMs: 60_000, retryEveryMs: 1 });
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
