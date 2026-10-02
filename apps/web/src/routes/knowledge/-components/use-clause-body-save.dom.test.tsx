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
const HISTORY = [{ text: "Historical clause" }];
const WRITE_FAILED = new Error("clause write failed");

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  cleanup();
  jest.useRealTimers();
});
afterAll(async () => GlobalRegistrator.unregister());

// Drain promise continuations without advancing the autosave deadline.
const drain = async () => {
  for (let index = 0; index < 20; index++) {
    await Promise.resolve();
  }
  jest.advanceTimersByTime(0);
};

const mountSave = () => {
  const requests: {
    write: ClauseBodyWrite;
    deferred: ReturnType<typeof Promise.withResolvers<unknown>>;
  }[] = [];
  const errors: unknown[] = [];
  let head: ClauseParagraph[] = A;
  const versions: ClauseParagraph[][] = [];
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const hook = renderHook(
    () =>
      useClauseBodySave({
        initialBody: A,
        persist: async (write) => {
          const deferred = Promise.withResolvers<unknown>();
          requests.push({ write, deferred });
          await deferred.promise;
          head = write.body;
          if (write.snapshotVersion) {
            versions.push(write.body);
          }
        },
        onError: (error) => errors.push(error),
      }),
    {
      wrapper: ({ children }) =>
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          children,
        ),
    },
  );
  const resolve = async (index: number) => {
    const request = requests.at(index);
    expect(request).toBeDefined();
    await act(async () => {
      request?.deferred.resolve(undefined);
      await drain();
    });
  };
  const reject = async (index: number) => {
    const request = requests.at(index);
    expect(request).toBeDefined();
    await act(async () => {
      request?.deferred.reject(WRITE_FAILED);
      await drain();
    });
  };
  const change = async (body: ClauseParagraph[]) => {
    await act(async () => {
      hook.result.current.change(body);
      await drain();
    });
  };
  const tickAutosave = async () =>
    act(async () => {
      jest.advanceTimersByTime(1200);
      await drain();
    });
  return {
    ...hook,
    requests,
    errors,
    resolve,
    reject,
    change,
    tickAutosave,
    head: () => head,
    versions,
  };
};

describe("clause body publication", () => {
  test("clause publication preserves the captured revision and the latest later edit", async () => {
    await assertProperty(
      "clause publication preserves the captured revision and the latest later edit",
      fc.asyncProperty(
        fc.array(fc.string({ maxLength: 40 }), { minLength: 1, maxLength: 4 }),
        fc.array(fc.string({ maxLength: 40 }), { maxLength: 4 }),
        async (before, after) => {
          const save = mountSave();
          try {
            const precedingBodies = before.map((text) => [{ text }]);
            const followingBodies = after.map((text) => [{ text }]);
            for (const next of precedingBodies) {
              await save.change(next);
            }
            const captured = precedingBodies.at(-1);
            let publication: Promise<boolean> | undefined;
            await act(async () => {
              publication = save.result.current.snapshot();
              await drain();
            });
            expect(save.requests).toHaveLength(1);
            expect(save.requests.at(0)?.write).toEqual({
              body: captured,
              expectedBody: A,
            });
            await save.resolve(0);
            expect(save.requests.at(1)?.write).toEqual({
              body: captured,
              expectedBody: captured,
              snapshotVersion: true,
            });
            for (const next of followingBodies) {
              await save.change(next);
            }
            await save.tickAutosave();
            expect(save.requests).toHaveLength(2);
            await save.resolve(1);
            expect(await publication).toBe(after.length === 0);
            expect(save.versions).toEqual([captured]);
            expect(save.result.current.dirty).toBe(after.length > 0);
            if (after.length > 0) {
              await save.tickAutosave();
              const latest = followingBodies.at(-1);
              expect(save.requests.at(2)?.write).toEqual({
                body: latest,
                expectedBody: captured,
              });
              await save.resolve(2);
              expect(save.head()).toEqual(latest);
              expect(save.result.current.body).toEqual(latest);
              expect(save.result.current.dirty).toBe(true);
            }
          } finally {
            save.unmount();
            jest.clearAllTimers();
          }
        },
      ),
      { numRuns: 20 },
    );
  });

  test("publication immediately captures the live edit and waits for the head", async () => {
    const save = mountSave();
    await save.change(B);
    let publication: Promise<boolean> | undefined;
    await act(async () => {
      publication = save.result.current.snapshot();
      await drain();
    });
    expect(save.requests.map(({ write }) => write)).toEqual([
      { body: B, expectedBody: A },
    ]);
    expect(save.head()).toEqual(A);
    expect(save.result.current.dirty).toBe(true);
    await save.resolve(0);
    expect(save.requests.at(1)?.write).toEqual({
      body: B,
      expectedBody: B,
      snapshotVersion: true,
    });
    expect(save.versions).toEqual([]);
    await save.resolve(1);
    expect(await publication).toBe(true);
    expect(save.head()).toEqual(B);
    expect(save.versions).toEqual([B]);
    expect(save.result.current.dirty).toBe(false);
  });

  test("a pending autosave blocks publication and cannot commit after its snapshot", async () => {
    const save = mountSave();
    await save.change(B);
    await save.tickAutosave();
    expect(save.requests).toHaveLength(1);
    let publication: Promise<boolean> | undefined;
    await act(async () => {
      publication = save.result.current.snapshot();
      await drain();
    });
    expect(save.requests).toHaveLength(1);
    await save.resolve(0);
    expect(save.requests.at(1)?.write).toEqual({
      body: B,
      expectedBody: B,
      snapshotVersion: true,
    });
    await save.resolve(1);
    expect(await publication).toBe(true);
    await save.tickAutosave();
    expect(save.requests).toHaveLength(2);
    expect(save.head()).toEqual(B);
    expect(save.versions).toEqual([B]);
  });

  test("a failed flush stops publication and leaves the edit dirty", async () => {
    const save = mountSave();
    await save.change(B);
    let publication: Promise<boolean> | undefined;
    await act(async () => {
      publication = save.result.current.snapshot();
      await drain();
    });
    await save.reject(0);
    expect(await publication).toBe(false);
    expect(save.requests).toHaveLength(1);
    expect(save.errors).toEqual([WRITE_FAILED]);
    expect(save.head()).toEqual(A);
    expect(save.versions).toEqual([]);
    expect(save.result.current.body).toEqual(B);
    expect(save.result.current.dirty).toBe(true);
  });

  test("a failed snapshot retains dirty state after a successful head write", async () => {
    const save = mountSave();
    await save.change(B);
    let publication: Promise<boolean> | undefined;
    await act(async () => {
      publication = save.result.current.snapshot();
      await drain();
    });
    await save.resolve(0);
    await save.reject(1);
    expect(await publication).toBe(false);
    expect(save.errors).toEqual([WRITE_FAILED]);
    expect(save.head()).toEqual(B);
    expect(save.versions).toEqual([]);
    expect(save.result.current.dirty).toBe(true);
  });

  test("publication joined to a failing pending autosave does not retry or append a snapshot", async () => {
    const save = mountSave();
    await save.change(B);
    await save.tickAutosave();
    expect(save.requests.at(0)?.write).toEqual({ body: B, expectedBody: A });
    let publication: Promise<boolean> | undefined;
    await act(async () => {
      publication = save.result.current.snapshot();
      await drain();
    });
    expect(save.requests).toHaveLength(1);
    await save.reject(0);
    expect(await publication).toBe(false);
    expect(save.requests).toHaveLength(1);
    expect(save.errors).toEqual([WRITE_FAILED]);
    expect(save.head()).toEqual(A);
    expect(save.versions).toEqual([]);
    expect(save.result.current.body).toEqual(B);
    expect(save.result.current.dirty).toBe(true);
  });

  test.each(["head", "snapshot"])(
    "typing during the pending %s preserves the later edit and refuses leaving",
    async (phase) => {
      const save = mountSave();
      await save.change(B);
      let publication: Promise<boolean> | undefined;
      await act(async () => {
        publication = save.result.current.snapshot();
        await drain();
      });
      if (phase === "snapshot") {
        await save.resolve(0);
      }
      await save.change(C);
      await save.tickAutosave();
      expect(save.requests).toHaveLength(phase === "head" ? 1 : 2);
      if (phase === "head") {
        await save.resolve(0);
      }
      expect(save.requests.at(1)?.write).toEqual({
        body: B,
        expectedBody: B,
        snapshotVersion: true,
      });
      await save.resolve(1);
      expect(await publication).toBe(false);
      expect(save.versions).toEqual([B]);
      expect(save.result.current.body).toEqual(C);
      expect(save.result.current.dirty).toBe(true);
      await save.tickAutosave();
      expect(save.requests.at(2)?.write).toEqual({ body: C, expectedBody: B });
      await save.resolve(2);
      expect(save.head()).toEqual(C);
      expect(save.result.current.dirty).toBe(true);
    },
  );

  test("History restore shares the pending autosave sequence and preserves subsequent typing", async () => {
    const save = mountSave();
    await save.change(B);
    await save.tickAutosave();
    let restoration: Promise<boolean> | undefined;
    await act(async () => {
      restoration = save.result.current.restore(HISTORY);
      await drain();
    });
    expect(save.result.current.body).toEqual(HISTORY);
    expect(save.requests).toHaveLength(1);
    await save.resolve(0);
    expect(save.requests.at(1)?.write).toEqual({
      body: HISTORY,
      expectedBody: B,
    });
    await save.resolve(1);
    expect(save.requests.at(2)?.write).toEqual({
      body: HISTORY,
      expectedBody: HISTORY,
      snapshotVersion: true,
    });
    await save.change(C);
    await save.resolve(2);
    expect(await restoration).toBe(false);
    expect(save.versions).toEqual([HISTORY]);
    expect(save.result.current.body).toEqual(C);
    expect(save.result.current.dirty).toBe(true);
    await save.tickAutosave();
    expect(save.requests.at(3)?.write).toEqual({
      body: C,
      expectedBody: HISTORY,
    });
    await save.resolve(3);
    expect(save.head()).toEqual(C);
  });

  test("an obsolete blur callback flushes the live body instead of its render's body", async () => {
    const save = mountSave();
    const obsoleteBlur = save.result.current.flush;
    await save.change(B);
    let flushed: Promise<boolean> | undefined;
    await act(async () => {
      flushed = obsoleteBlur();
      await drain();
    });
    expect(save.requests.at(0)?.write).toEqual({ body: B, expectedBody: A });
    await save.resolve(0);
    expect(await flushed).toBe(true);
    expect(save.head()).toEqual(B);
    expect(save.result.current.dirty).toBe(true);
  });

  test("History waits for the head before loading and preserves typing during the version read", async () => {
    const save = mountSave();
    const loaded = Promise.withResolvers<ClauseParagraph[]>();
    let reads = 0;
    await save.change(B);
    let restoration: Promise<boolean> | undefined;
    await act(async () => {
      restoration = save.result.current.restoreFrom(async () => {
        reads += 1;
        return loaded.promise;
      });
      await drain();
    });
    expect(reads).toBe(0);
    expect(save.requests.at(0)?.write).toEqual({ body: B, expectedBody: A });
    await save.resolve(0);
    expect(reads).toBe(1);
    await save.change(C);
    await act(async () => {
      loaded.resolve(HISTORY);
      await drain();
    });
    expect(save.result.current.body).toEqual(C);
    expect(save.requests.at(1)?.write).toEqual({
      body: HISTORY,
      expectedBody: B,
    });
    await save.resolve(1);
    expect(save.requests.at(2)?.write).toEqual({
      body: HISTORY,
      expectedBody: HISTORY,
      snapshotVersion: true,
    });
    await save.resolve(2);
    expect(await restoration).toBe(false);
    expect(save.versions).toEqual([HISTORY]);
    expect(save.result.current.body).toEqual(C);
    expect(save.result.current.dirty).toBe(true);
    await save.tickAutosave();
    expect(save.requests.at(3)?.write).toEqual({
      body: C,
      expectedBody: HISTORY,
    });
    await save.resolve(3);
    expect(save.head()).toEqual(C);
  });

  test("a successful publication with a later edit does not prevent the next queued publication", async () => {
    const save = mountSave();
    await save.change(B);
    let first: Promise<boolean> | undefined;
    let second: Promise<boolean> | undefined;
    await act(async () => {
      first = save.result.current.snapshot();
      await drain();
    });
    await save.resolve(0);
    await save.change(C);
    await act(async () => {
      second = save.result.current.snapshot();
      await drain();
    });
    expect(save.requests).toHaveLength(2);
    await save.resolve(1);
    expect(await first).toBe(false);
    expect(save.requests.at(2)?.write).toEqual({ body: C, expectedBody: B });
    await save.resolve(2);
    expect(save.requests.at(3)?.write).toEqual({
      body: C,
      expectedBody: C,
      snapshotVersion: true,
    });
    await save.resolve(3);
    expect(await second).toBe(true);
    expect(save.versions).toEqual([B, C]);
    expect(save.head()).toEqual(C);
    expect(save.result.current.dirty).toBe(false);
  });
});
