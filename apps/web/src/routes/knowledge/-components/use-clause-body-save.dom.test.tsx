import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import type { ClauseParagraph } from "@/components/templates/clause-editor-types";
import { APIError } from "@/lib/errors/api";
import { unregisterDomEnvironment } from "@/test-dom-environment";

import type { ClauseBodyWrite } from "./use-clause-body-save";

GlobalRegistrator.register({ url: "http://localhost:3000/knowledge" });
const React = await import("react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { act, cleanup, renderHook } = await import("@testing-library/react");
const { useClauseBodySave } = await import("./use-clause-body-save");
const A = [{ text: "Initial clause" }];
const B = [{ text: "Edited clause" }];
const C = [{ text: "Later edit" }];
const REMOTE = [{ text: "Another writer" }];
const HISTORY = [{ text: "Historical clause" }];
const WRITE_FAILED = new Error("clause write failed");
const CONFLICT = new APIError({ status: 409, message: "head changed" });
beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  cleanup();
  jest.useRealTimers();
});
afterAll(async () => unregisterDomEnvironment());

type MountOptions = {
  readHead?: (() => Promise<ClauseParagraph[]>) | undefined;
  reportError?: ((error: unknown) => void) | undefined;
  onPersisted?: ((body: ClauseParagraph[]) => void) | undefined;
};
const mountSave = ({
  readHead,
  reportError,
  onPersisted,
}: MountOptions = {}) => {
  const requests: {
    write: ClauseBodyWrite;
    deferred: ReturnType<typeof Promise.withResolvers<unknown>>;
  }[] = [];
  const starts = new Map<
    number,
    ReturnType<typeof Promise.withResolvers<undefined>>
  >();
  const errors: unknown[] = [];
  let head: ClauseParagraph[] = A;
  const versions: ClauseParagraph[][] = [];
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const hook = renderHook(
    ({ initialBody }) =>
      useClauseBodySave({
        initialBody,
        readHead,
        onPersisted,
        persist: async (write) => {
          const deferred = Promise.withResolvers<unknown>();
          const index = requests.length;
          requests.push({ write, deferred });
          starts.get(index)?.resolve(undefined);
          await deferred.promise;
          head = write.body;
          if (write.snapshotVersion) {
            versions.push(write.body);
          }
        },
        onError: (error) => {
          errors.push(error);
          reportError?.(error);
        },
      }),
    {
      initialProps: { initialBody: A },
      wrapper: ({ children }) =>
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          children,
        ),
    },
  );
  const whenStarted = async (index: number) => {
    await act(async () => {
      if (requests.at(index)) {
        return;
      }
      const started = Promise.withResolvers<undefined>();
      starts.set(index, started);
      await started.promise;
    });
    const request = requests.at(index);
    if (!request) {
      throw new Error("expected clause transport to start");
    }
    return request;
  };
  const start = async (operation: () => Promise<boolean>) => {
    let outcome = Promise.resolve(false);
    await act(async () => {
      outcome = operation();
    });
    return { outcome };
  };
  const settle = async (
    index: number,
    outcome?: Promise<unknown>,
    error?: unknown,
  ) => {
    const request = await whenStarted(index);
    await act(async () => {
      if (error !== undefined) {
        request.deferred.reject(error);
      } else {
        request.deferred.resolve(undefined);
      }
      if (outcome) {
        await outcome;
      }
    });
  };
  const change = async (body: ClauseParagraph[]) =>
    act(() => hook.result.current.change(body));
  const tick = async () =>
    act(async () => {
      jest.advanceTimersByTime(1200);
    });
  return {
    ...hook,
    requests,
    errors,
    whenStarted,
    start,
    settle,
    change,
    tick,
    head: () => head,
    versions,
  };
};

describe("clause body publication", () => {
  test("debounce timers advance the Date clock used by use-debounce", async () => {
    const save = mountSave();
    const before = Date.now();
    await save.change(B);
    await save.tick();
    expect(Date.now() - before).toBe(1200);
    expect((await save.whenStarted(0)).write).toEqual({
      body: B,
      expectedBody: A,
    });
    await save.settle(0);
  });
  test("publication is one atomic request with the live body", async () => {
    const save = mountSave();
    await save.change(B);
    const { outcome } = await save.start(async () =>
      save.result.current.snapshot(),
    );
    expect((await save.whenStarted(0)).write).toEqual({
      body: B,
      expectedBody: A,
      snapshotVersion: true,
    });
    expect(save.head()).toEqual(A);
    await save.settle(0, outcome);
    expect(await outcome).toBe(true);
    expect(save.requests).toHaveLength(1);
    expect(save.head()).toEqual(B);
    expect(save.versions).toEqual([B]);
    expect(save.result.current.dirty).toBe(false);
  });
  test("an atomic publication refusal changes neither head nor version", async () => {
    const save = mountSave();
    await save.change(B);
    const { outcome } = await save.start(async () =>
      save.result.current.snapshot(),
    );
    expect((await save.whenStarted(0)).write.snapshotVersion).toBe(true);
    await save.settle(0, outcome, WRITE_FAILED);
    expect(await outcome).toBe(false);
    expect(save.errors).toEqual([WRITE_FAILED]);
    expect(save.head()).toEqual(A);
    expect(save.versions).toEqual([]);
    expect(save.result.current.dirty).toBe(true);
  });
  test.each([false, true])(
    "publication waits for an autosave, whose failure is %s",
    async (failing) => {
      const save = mountSave();
      await save.change(B);
      await save.tick();
      await save.whenStarted(0);
      const { outcome } = await save.start(async () =>
        save.result.current.snapshot(),
      );
      expect(save.requests).toHaveLength(1);
      await save.settle(
        0,
        failing ? outcome : undefined,
        failing ? WRITE_FAILED : undefined,
      );
      if (failing) {
        expect(await outcome).toBe(false);
        expect(save.requests).toHaveLength(1);
        expect(save.versions).toEqual([]);
        expect(save.result.current.dirty).toBe(true);
        return;
      }
      expect((await save.whenStarted(1)).write).toEqual({
        body: B,
        expectedBody: B,
        snapshotVersion: true,
      });
      await save.settle(1, outcome);
      expect(await outcome).toBe(true);
      expect(save.versions).toEqual([B]);
    },
  );
  test("clause publication preserves the captured revision and the latest later edit", async () => {
    await assertProperty(
      "clause publication preserves the captured revision and the latest later edit",
      fc.asyncProperty(
        fc.array(fc.string({ maxLength: 40 }), { minLength: 1, maxLength: 4 }),
        fc.array(fc.string({ maxLength: 40 }), { maxLength: 4 }),
        async (before, after) => {
          const save = mountSave();
          try {
            const preceding = before.map((text) => [
              { text: `Before: ${text}` },
            ]);
            const following = after.map((text) => [{ text: `After: ${text}` }]);
            for (const next of preceding) {
              await save.change(next);
            }
            const captured = preceding.at(-1);
            if (!captured) {
              throw new Error("Expected a preceding publication revision");
            }
            const { outcome } = await save.start(async () =>
              save.result.current.snapshot(),
            );
            expect((await save.whenStarted(0)).write).toEqual({
              body: captured,
              expectedBody: A,
              snapshotVersion: true,
            });
            for (const next of following) {
              await save.change(next);
            }
            await save.settle(0, outcome);
            expect(await outcome).toBe(after.length === 0);
            expect(save.versions).toEqual([captured]);
            expect(save.result.current.dirty).toBe(after.length > 0);
            if (after.length === 0) {
              return;
            }
            await save.tick();
            const latest = following.at(-1);
            if (!latest) {
              throw new Error("Expected a later edit");
            }
            expect((await save.whenStarted(1)).write).toEqual({
              body: latest,
              expectedBody: captured,
            });
            await save.settle(1);
            expect(save.head()).toEqual(latest);
            expect(save.result.current.body).toEqual(latest);
            expect(save.result.current.dirty).toBe(true);
          } finally {
            save.unmount();
            jest.clearAllTimers();
          }
        },
      ),
      { numRuns: 20 },
    );
  });
  test("a new publication proceeds after an earlier successful publication refuses leaving", async () => {
    const save = mountSave();
    await save.change(B);
    const first = await save.start(async () => save.result.current.snapshot());
    await save.whenStarted(0);
    await save.change(C);
    const second = await save.start(async () => save.result.current.snapshot());
    expect(save.requests).toHaveLength(1);
    await save.settle(0, first.outcome);
    expect(await first.outcome).toBe(false);
    expect((await save.whenStarted(1)).write).toEqual({
      body: C,
      expectedBody: B,
      snapshotVersion: true,
    });
    await save.settle(1, second.outcome);
    expect(await second.outcome).toBe(true);
    expect(save.versions).toEqual([B, C]);
    expect(save.result.current.dirty).toBe(false);
  });
  test("an obsolete blur callback reads the live body", async () => {
    const save = mountSave();
    const obsolete = save.result.current.flush;
    await save.change(B);
    const { outcome } = await save.start(obsolete);
    expect((await save.whenStarted(0)).write).toEqual({
      body: B,
      expectedBody: A,
    });
    await save.settle(0, outcome);
    expect(await outcome).toBe(true);
    expect(save.result.current.dirty).toBe(true);
  });
  test("a head endpoint follows the flush and retains later typing while reporting success", async () => {
    const save = mountSave();
    const restored = Promise.withResolvers<ClauseParagraph[]>();
    const called = Promise.withResolvers<ClauseParagraph[]>();
    await save.change(B);
    const { outcome } = await save.start(async () =>
      save.result.current.sequenceHead(async (expectedBody) => {
        called.resolve(expectedBody);
        return restored.promise;
      }),
    );
    expect((await save.whenStarted(0)).write).toEqual({
      body: B,
      expectedBody: A,
    });
    await save.settle(0);
    expect(await called.promise).toEqual(B);
    await save.change(C);
    await act(async () => {
      restored.resolve(HISTORY);
      await outcome;
    });
    expect(await outcome).toBe(true);
    expect(save.result.current.body).toEqual(C);
    expect(save.result.current.dirty).toBe(true);
    await save.tick();
    expect((await save.whenStarted(1)).write).toEqual({
      body: C,
      expectedBody: HISTORY,
    });
    await save.settle(1);
    expect(save.head()).toEqual(C);
  });
  test("echoing an adopted body creates neither an unsaved revision nor another write", async () => {
    const save = mountSave();
    const { outcome } = await save.start(async () =>
      save.result.current.sequenceHead(async () => HISTORY),
    );
    await act(async () => {
      await outcome;
    });
    expect(await outcome).toBe(true);
    expect(save.result.current.body).toEqual(HISTORY);
    await save.change(structuredClone(HISTORY));
    await save.tick();
    expect(save.requests).toHaveLength(0);
    expect(save.result.current.dirty).toBe(false);
  });
  test("clean refetches update the displayed head and next precondition", async () => {
    const save = mountSave();
    act(() => {
      save.rerender({ initialBody: REMOTE });
    });
    expect(save.result.current.body).toEqual(REMOTE);
    expect(save.result.current.conflict.status).toBe("none");
    await save.change(B);
    const { outcome } = await save.start(async () =>
      save.result.current.flush(),
    );
    expect((await save.whenStarted(0)).write).toEqual({
      body: B,
      expectedBody: REMOTE,
    });
    await save.settle(0, outcome);
  });
  test.each(["keep mine", "take theirs"])(
    "dirty refetches keep local text until %s",
    async (choice) => {
      const save = mountSave();
      await save.change(B);
      act(() => {
        save.rerender({ initialBody: REMOTE });
      });
      expect(save.result.current.body).toEqual(B);
      expect(save.result.current.conflict).toEqual({
        status: "choice",
        head: REMOTE,
      });
      if (choice === "take theirs") {
        act(() => {
          save.result.current.takeTheirs();
        });
        expect(save.result.current.body).toEqual(REMOTE);
        expect(save.result.current.dirty).toBe(false);
        await save.tick();
        expect(save.requests).toHaveLength(0);
        return;
      }
      const { outcome } = await save.start(async () =>
        save.result.current.keepMine(),
      );
      expect((await save.whenStarted(0)).write).toEqual({
        body: B,
        expectedBody: REMOTE,
      });
      await save.settle(0, outcome);
      expect(await outcome).toBe(true);
      expect(save.result.current.conflict.status).toBe("none");
      expect(save.result.current.body).toEqual(B);
    },
  );
  test("409 refetches the head and offers a recoverable choice", async () => {
    const read = Promise.withResolvers<ClauseParagraph[]>();
    const reading = Promise.withResolvers<undefined>();
    const save = mountSave({
      readHead: async () => {
        reading.resolve(undefined);
        return read.promise;
      },
    });
    await save.change(B);
    const { outcome } = await save.start(async () =>
      save.result.current.flush(),
    );
    await save.settle(0, undefined, CONFLICT);
    await reading.promise;
    await act(async () => {
      read.resolve(REMOTE);
      await outcome;
    });
    expect(await outcome).toBe(false);
    expect(save.result.current.body).toEqual(B);
    expect(save.result.current.conflict).toEqual({
      status: "choice",
      head: REMOTE,
    });
    const retry = await save.start(async () => save.result.current.keepMine());
    expect((await save.whenStarted(1)).write).toEqual({
      body: B,
      expectedBody: REMOTE,
    });
    await save.settle(1, retry.outcome);
  });
  test("recovering a committed head after a lost response does not discard local text", async () => {
    const save = mountSave({ readHead: async () => B });
    await save.change(B);
    const { outcome } = await save.start(async () =>
      save.result.current.flush(),
    );
    await save.settle(0, outcome, CONFLICT);
    expect(save.result.current.conflict.status).toBe("none");
    expect(save.result.current.body).toEqual(B);
    const retry = await save.start(async () => save.result.current.snapshot());
    expect((await save.whenStarted(1)).write).toEqual({
      body: B,
      expectedBody: B,
      snapshotVersion: true,
    });
    await save.settle(1, retry.outcome);
    expect(await retry.outcome).toBe(true);
  });
  test.each(["reporter", "observer", "head operation"])(
    "a throwing %s does not wedge the FIFO",
    async (fault) => {
      const save = mountSave({
        reportError:
          fault === "reporter"
            ? () => {
                throw new Error("reporter failed");
              }
            : undefined,
        onPersisted:
          fault === "observer"
            ? () => {
                throw new Error("observer failed");
              }
            : undefined,
      });
      if (fault === "head operation") {
        const failed = await save.start(async () =>
          save.result.current.sequenceHead(async () => {
            throw WRITE_FAILED;
          }),
        );
        await act(async () => {
          await failed.outcome;
        });
        expect(await failed.outcome).toBe(false);
      } else {
        await save.change(B);
        const first = await save.start(async () => save.result.current.flush());
        await save.settle(
          0,
          first.outcome,
          fault === "reporter" ? WRITE_FAILED : undefined,
        );
      }
      await save.change(C);
      const retried = await save.start(async () =>
        save.result.current.snapshot(),
      );
      await save.settle(fault === "head operation" ? 0 : 1, retried.outcome);
      expect(await retried.outcome).toBe(true);
      expect(save.result.current.body).toEqual(C);
    },
  );
  test.each(["typing", "blur"])(
    "failed review persistence stays gated until a successful %s retry",
    async (retry) => {
      const save = mountSave();
      act(() => {
        save.result.current.onReviewStatusChange("pending");
      });
      const reviewed = await save.start(async () =>
        save.result.current.resolveReview(B),
      );
      expect(save.result.current.reviewStatus).toBe("persisting");
      await save.settle(0, reviewed.outcome, WRITE_FAILED);
      expect(save.result.current.reviewStatus).toBe("persisting");
      if (retry === "typing") {
        await save.change(C);
        await save.tick();
        await save.settle(1);
      } else {
        const flushed = await save.start(async () =>
          save.result.current.flush(),
        );
        await save.settle(1, flushed.outcome);
      }
      expect(save.result.current.reviewStatus).toBe("resolved");
    },
  );
  test("an older review settlement cannot resolve a newer pending review", async () => {
    const save = mountSave();
    act(() => {
      save.result.current.onReviewStatusChange("pending");
    });
    const reviewed = await save.start(async () =>
      save.result.current.resolveReview(B),
    );
    await save.whenStarted(0);
    act(() => {
      save.result.current.onReviewStatusChange("pending");
    });
    await save.settle(0, reviewed.outcome);
    expect(save.result.current.reviewStatus).toBe("pending");
  });
  test("fully rejecting a second review cannot resolve an unpersisted earlier acceptance", async () => {
    const save = mountSave();
    act(() => {
      save.result.current.onReviewStatusChange("pending");
    });
    const reviewed = await save.start(async () =>
      save.result.current.resolveReview(B),
    );
    await save.settle(0, reviewed.outcome, WRITE_FAILED);
    act(() => {
      save.result.current.onReviewStatusChange("pending");
    });
    act(() => {
      save.result.current.onReviewStatusChange("resolved");
    });
    expect(save.result.current.reviewStatus).toBe("persisting");
    const retried = await save.start(async () => save.result.current.flush());
    await save.settle(1, retried.outcome);
    expect(save.result.current.reviewStatus).toBe("resolved");
  });
  test("an own intermediate cache acknowledgement cannot become a conflict after a later queued write", async () => {
    const save = mountSave();
    await save.change(B);
    const first = await save.start(async () => save.result.current.flush());
    await save.whenStarted(0);
    await save.change(C);
    const published = await save.start(async () =>
      save.result.current.snapshot(),
    );
    act(() => {
      save.rerender({ initialBody: B });
    });
    await save.change([{ text: "Newest edit" }]);
    await save.settle(0, first.outcome);
    expect((await save.whenStarted(1)).write).toEqual({
      body: C,
      expectedBody: B,
      snapshotVersion: true,
    });
    await save.settle(1, published.outcome);
    expect(await published.outcome).toBe(false);
    expect(save.result.current.conflict.status).toBe("none");
    expect(save.result.current.dirty).toBe(true);
    await save.tick();
    expect((await save.whenStarted(2)).write).toEqual({
      body: [{ text: "Newest edit" }],
      expectedBody: C,
    });
    await save.settle(2);
    expect(save.result.current.body).toEqual([{ text: "Newest edit" }]);
  });
});
