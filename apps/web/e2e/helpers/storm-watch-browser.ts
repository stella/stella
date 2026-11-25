/// <reference lib="dom" />
// The storm watch, injected into every page the shared e2e fixture opens,
// before the app loads (see ./storm-watch.ts). It counts React commits
// through the DevTools hook, which development and production React DOM
// both report to, and feeds them to the storm ledger together with every
// outside cause it can see: trusted input events, finished network
// resources, stream reads and socket or channel messages. Timers, observers
// and React's own scheduler are deliberately not causes: a loop runs on them.
import { createRenderProbe } from "../../../../packages/render-probe/src/probe";
import type { RenderSnapshot } from "../../../../packages/render-probe/src/probe";
import {
  createStormLedger,
  type StormStimulus,
  type StormViolation,
} from "../../../../packages/render-probe/src/storm-ledger";
import {
  STORM_WATCH_GLOBAL,
  type StormWatchQuiescence,
  type StormWatchState,
  type StormWatchViolationReport,
} from "./storm-watch-contract";

const DEVTOOLS_HOOK = "__REACT_DEVTOOLS_GLOBAL_HOOK__";

// The real clock and timer, taken before anything else runs: a spec that
// installs Playwright's fake clock must not stop the watch's time.
const clock = performance.now.bind(performance);
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const REPORTED_VIOLATIONS = 5;
const REPORTED_COMPONENTS = 8;

const ledger = createStormLedger();
// Its own probe, separate from the one render budgets reset: it is reset at
// every outside stimulus, so at a violation it holds exactly the renders
// nothing outside the app explains.
const { probe, onCommit: walkCommit } = createRenderProbe();
const reported: StormWatchViolationReport[] = [];

let lastCommitAt = 0;
let lastStimulusAt = 0;
let commits = 0;

// A browser task ends when a message posted during it is delivered. React's
// own scheduler posts on a channel of its own, so its tasks are not causes.
let task = 0;
let taskEndPending = false;
const taskChannel = new MessageChannel();
taskChannel.port1.addEventListener("message", () => {
  task += 1;
  taskEndPending = false;
});
taskChannel.port1.start();

const topComponents = (snapshot: RenderSnapshot) =>
  Object.entries(snapshot.components)
    .toSorted(([, left], [, right]) => right.renders - left.renders)
    .slice(0, REPORTED_COMPONENTS)
    .map(([name, entry]) => ({ name, ...entry }));

const recordViolations = (found: readonly StormViolation[]) => {
  for (const violation of found) {
    if (reported.length < REPORTED_VIOLATIONS) {
      reported.push({
        violation,
        components: topComponents(probe.snapshot()),
      });
    }
  }
};

const stimulus = (kind: StormStimulus) => {
  const now = clock();
  lastStimulusAt = now;
  ledger.onStimulus(now, kind);
  probe.reset();
};

type CommitRoot = Parameters<typeof walkCommit>[0];

const onCommit = (root: CommitRoot) => {
  const now = clock();
  commits += 1;
  lastCommitAt = now;
  if (!taskEndPending) {
    taskEndPending = true;
    taskChannel.port2.postMessage(null);
  }
  try {
    walkCommit(root);
  } catch {
    // The walk only names components; counting must not depend on it.
  }
  recordViolations(ledger.onCommit(now, task));
};

// The hook: chain onto one already installed (React DevTools, the render
// probe), or install the minimal one React needs to report commits.
const existingHook: unknown = Reflect.get(globalThis, DEVTOOLS_HOOK);
if (typeof existingHook === "object" && existingHook !== null) {
  const previous: unknown = Reflect.get(existingHook, "onCommitFiberRoot");
  Reflect.set(
    existingHook,
    "onCommitFiberRoot",
    (rendererId: unknown, root: CommitRoot, ...rest: unknown[]) => {
      onCommit(root);
      if (typeof previous === "function") {
        Reflect.apply(previous, existingHook, [rendererId, root, ...rest]);
      }
    },
  );
} else {
  const renderers = new Map<number, unknown>();
  Reflect.set(globalThis, DEVTOOLS_HOOK, {
    supportsFiber: true,
    renderers,
    inject: (internals: unknown) => {
      const id = renderers.size + 1;
      renderers.set(id, internals);
      return id;
    },
    onCommitFiberRoot: (_rendererId: number, root: CommitRoot) => {
      onCommit(root);
    },
    onCommitFiberUnmount: () => undefined,
    onPostCommitFiberRoot: () => undefined,
  });
}

// Input: only trusted events, the ones a person or the test driver caused.
// An event the app dispatches itself can be part of a loop.
const INPUT_EVENTS = [
  "pointerdown",
  "pointerup",
  "pointermove",
  "pointerover",
  "pointerout",
  "click",
  "dblclick",
  "contextmenu",
  "keydown",
  "keyup",
  "input",
  "change",
  "beforeinput",
  "compositionend",
  "paste",
  "cut",
  "copy",
  "wheel",
  "scroll",
  "focusin",
  "focusout",
  "dragstart",
  "dragover",
  "drop",
  "dragend",
  "touchstart",
  "touchend",
  "resize",
] as const;
// Events that fire continuously while a pointer moves or a page scrolls
// refill at most once per interval, so a sweep of the mouse cannot keep
// topping up the bucket while a loop runs beside it.
const CONTINUOUS_EVENTS: ReadonlySet<string> = new Set([
  "pointermove",
  "pointerover",
  "pointerout",
  "wheel",
  "scroll",
  "dragover",
]);
const CONTINUOUS_REFILL_MS = 100;
const lastContinuousAt = new Map<string, number>();
for (const type of INPUT_EVENTS) {
  globalThis.addEventListener(
    type,
    (event) => {
      if (!event.isTrusted) {
        return;
      }
      if (CONTINUOUS_EVENTS.has(type)) {
        const now = clock();
        if (
          now - (lastContinuousAt.get(type) ?? Number.NEGATIVE_INFINITY) <
          CONTINUOUS_REFILL_MS
        ) {
          return;
        }
        lastContinuousAt.set(type, now);
      }
      stimulus("input");
    },
    { capture: true, passive: true },
  );
}
for (const type of ["popstate", "hashchange", "pageshow", "load"] as const) {
  globalThis.addEventListener(type, () => stimulus("navigation"), {
    capture: true,
    passive: true,
  });
}
document.addEventListener("visibilitychange", () => stimulus("navigation"), {
  capture: true,
  passive: true,
});

// Network: every finished resource (fetch, script chunk, stylesheet, image).
try {
  new PerformanceObserver((list) => {
    const finished = list.getEntries().length;
    for (let index = 0; index < finished; index += 1) {
      stimulus("network");
    }
  }).observe({ type: "resource", buffered: false });
} catch {
  // A browser without resource timing leaves network commits to the trickle.
}

// Streams: each chunk a reader takes, whether read directly or iterated.
// The originals are read and called through Reflect, so the patches hold
// whatever this browser's typings say about them.
const markRead = async (pending: unknown): Promise<unknown> => {
  const result: unknown = await Promise.resolve(pending);
  stimulus("stream");
  return result;
};
const isAsyncIterator = (value: unknown): value is AsyncIterator<unknown> =>
  typeof value === "object" &&
  value !== null &&
  "next" in value &&
  typeof value.next === "function";
const read: unknown =
  typeof ReadableStreamDefaultReader === "function"
    ? Reflect.get(ReadableStreamDefaultReader.prototype, "read")
    : undefined;
if (typeof read === "function") {
  Reflect.set(
    ReadableStreamDefaultReader.prototype,
    "read",
    async function readWithStimulus(this: ReadableStreamDefaultReader) {
      return await markRead(Reflect.apply(read, this, []));
    },
  );
}
const streamIterator: unknown = Reflect.get(
  ReadableStream.prototype,
  Symbol.asyncIterator,
);
if (typeof streamIterator === "function") {
  Reflect.set(
    ReadableStream.prototype,
    Symbol.asyncIterator,
    function iterateWithStimulus(this: ReadableStream, ...args: unknown[]) {
      const iterator: unknown = Reflect.apply(streamIterator, this, args);
      if (!isAsyncIterator(iterator)) {
        return iterator;
      }
      const advance = iterator.next.bind(iterator);
      iterator.next = async (...nextArgs) => {
        const step = await advance(...nextArgs);
        stimulus("stream");
        return step;
      };
      return iterator;
    },
  );
}

// Messages from outside the page: sockets, server events, other tabs and
// workers. MessagePort stays out: React's scheduler runs on one.
const MESSAGE_SOURCES = [
  globalThis.WebSocket,
  globalThis.EventSource,
  globalThis.BroadcastChannel,
  globalThis.Worker,
].filter((source) => typeof source === "function");
const listen: unknown = Reflect.get(EventTarget.prototype, "addEventListener");
const observed = new WeakMap<EventTarget, Set<string>>();
const observeMessages = (target: EventTarget, type: string) => {
  if (!MESSAGE_SOURCES.some((source) => target instanceof source)) {
    return;
  }
  const types = observed.get(target) ?? new Set<string>();
  observed.set(target, types);
  if (types.has(type)) {
    return;
  }
  types.add(type);
  if (typeof listen === "function") {
    Reflect.apply(listen, target, [type, () => stimulus("message")]);
  }
};
if (typeof listen === "function") {
  EventTarget.prototype.addEventListener = function addEventListener(
    this: EventTarget,
    ...args: Parameters<EventTarget["addEventListener"]>
  ) {
    try {
      observeMessages(this, args[0]);
    } catch {
      // Observing a message source must never stop the app listening to it.
    }
    Reflect.apply(listen, this, args);
  };
}
for (const source of MESSAGE_SOURCES) {
  const descriptor = Object.getOwnPropertyDescriptor(
    source.prototype,
    "onmessage",
  );
  const get: unknown = descriptor && Reflect.get(descriptor, "get");
  const set: unknown = descriptor && Reflect.get(descriptor, "set");
  if (typeof set !== "function") {
    continue;
  }
  Object.defineProperty(source.prototype, "onmessage", {
    ...descriptor,
    get(this: EventTarget): unknown {
      return typeof get === "function" ? Reflect.apply(get, this, []) : null;
    },
    set(this: EventTarget, handler: unknown) {
      observeMessages(this, "message");
      Reflect.apply(set, this, [handler]);
    },
  });
}

const POLL_MS = 50;

const waitQuiet = async (
  quietMs: number,
  timeoutMs: number,
): Promise<StormWatchQuiescence> => {
  const startedAt = clock();
  const commitsAtStart = commits;
  return await new Promise((resolve) => {
    const check = () => {
      const now = clock();
      if (now - lastCommitAt >= quietMs) {
        resolve({
          verdict: "quiet",
          waitedMs: Math.round(now - startedAt),
          commitsWhileWaiting: commits - commitsAtStart,
          components: [],
        });
        return;
      }
      if (now - startedAt >= timeoutMs) {
        // Still committing. Busy if something outside the app is still
        // arriving (a stream that has not finished), a storm if not.
        resolve({
          verdict: now - lastStimulusAt < quietMs * 2 ? "busy" : "storm",
          waitedMs: Math.round(now - startedAt),
          commitsWhileWaiting: commits - commitsAtStart,
          components: topComponents(probe.snapshot()),
        });
        return;
      }
      realSetTimeout(check, POLL_MS);
    };
    check();
  });
};

const state: StormWatchState = {
  report: () => ({ ...ledger.report(), reported: [...reported] }),
  waitQuiet,
};
Reflect.set(globalThis, STORM_WATCH_GLOBAL, state);
