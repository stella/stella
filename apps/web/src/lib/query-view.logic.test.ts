import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { FetchStatus } from "@tanstack/react-query";
import { Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { queryView, queryViewError } from "./query-view.logic";

const FETCH_STATUSES: readonly FetchStatus[] = ["idle", "fetching", "paused"];
const readError = new Error("Read failed");
const refetch = mock(async () => {
  throw readError;
});

describe("query view states", () => {
  test("keeps empty placeholder data pending until a response succeeds", async () => {
    const client = new QueryClient();
    const observer = new QueryObserver(client, {
      queryKey: ["query-view", "placeholder"],
      queryFn: async () => [],
      placeholderData: [],
      enabled: false,
    });
    const placeholder = observer.getCurrentResult();
    expect(placeholder.status).toBe("success");
    expect(placeholder.isPlaceholderData).toBe(true);
    expect(queryView(placeholder)).toEqual({ type: "pending" });
    const response = await observer.refetch();
    expect(response.isPlaceholderData).toBe(false);
    expect(queryView(response)).toEqual({ type: "empty" });
    observer.destroy();
    client.clear();
  });

  test("retains non-empty placeholder items while awaiting a response", () => {
    const data = [1];
    const client = new QueryClient();
    const observer = new QueryObserver(client, {
      queryKey: ["query-view", "previous-items"],
      queryFn: async () => [2],
      placeholderData: data,
      enabled: false,
    });
    const placeholder = observer.getCurrentResult();
    expect(placeholder.isPlaceholderData).toBe(true);
    const view = queryView(placeholder);
    expect(view.type).toBe("items");
    if (view.type === "items") {
      expect(view.items).toBe(data);
    }
    observer.destroy();
    client.clear();
  });

  for (const fetchStatus of FETCH_STATUSES) {
    test(`keeps pending ${fetchStatus} reads distinct from empty`, () => {
      expect(
        queryView({
          status: "pending",
          fetchStatus,
          isPlaceholderData: false,
          data: undefined,
          error: null,
          refetch,
        }),
      ).toEqual({ type: "pending" });
    });

    test(`exposes initial ${fetchStatus} failure and the original retry`, async () => {
      const view = queryView({
        status: "error",
        fetchStatus,
        isPlaceholderData: false,
        data: undefined,
        error: readError,
        refetch,
      });
      expect(view.type).toBe("error");
      if (view.type !== "error") {
        return;
      }
      expect(view.error).toBe(readError);
      expect(view.retry).toBe(refetch);
      const before = refetch.mock.calls.length;
      const retryResult = await Result.tryPromise(
        async () => await view.retry(),
      );
      expect(Result.isError(retryResult)).toBe(true);
      if (Result.isError(retryResult)) {
        expect(retryResult.error.cause).toBe(readError);
      }
      expect(refetch.mock.calls.length).toBe(before + 1);
    });

    test(`retains cached empty items on ${fetchStatus} refetch failure`, () => {
      const data: number[] = [];
      const isEmpty = mock(() => true);
      expect(
        queryView(
          {
            status: "error",
            fetchStatus,
            isPlaceholderData: false,
            data,
            error: readError,
            refetch,
          },
          { isEmpty },
        ),
      ).toEqual({
        type: "items",
        items: data,
        refetchError: readError,
        retry: refetch,
      });
      expect(isEmpty).not.toHaveBeenCalled();
    });

    test(`renders successful empty ${fetchStatus} reads as empty`, () => {
      expect(
        queryView({
          status: "success",
          fetchStatus,
          isPlaceholderData: false,
          data: [],
          error: null,
          refetch,
        }),
      ).toEqual({ type: "empty" });
    });

    test(`preserves successful ${fetchStatus} item identity`, () => {
      const data = [1, 2];
      const view = queryView({
        status: "success",
        fetchStatus,
        isPlaceholderData: false,
        data,
        error: null,
        refetch,
      });
      expect(view).toEqual({ type: "items", items: data, retry: refetch });
      if (view.type === "items") {
        expect(view.items).toBe(data);
      }
    });
  }

  test("treats false, zero, null and empty text as successful scalar values", () => {
    for (const data of [false, 0, null, ""]) {
      expect(
        queryView({
          status: "success",
          fetchStatus: "idle",
          isPlaceholderData: false,
          data,
          error: null,
          refetch,
        }),
      ).toEqual({ type: "items", items: data, retry: refetch });
      expect(
        queryView({
          status: "error",
          fetchStatus: "idle",
          isPlaceholderData: false,
          data,
          error: readError,
          refetch,
        }),
      ).toEqual({
        type: "items",
        items: data,
        retry: refetch,
        refetchError: readError,
      });
    }
  });

  test("uses the caller's empty predicate only after success", () => {
    expect(
      queryView(
        {
          status: "success",
          fetchStatus: "idle",
          isPlaceholderData: false,
          data: false,
          error: null,
          refetch,
        },
        { isEmpty: (value) => !value },
      ),
    ).toEqual({ type: "empty" });
    expect(
      queryView(
        {
          status: "success",
          fetchStatus: "idle",
          isPlaceholderData: false,
          data: [],
          error: null,
          refetch,
        },
        { isEmpty: () => false },
      ),
    ).toEqual({ type: "items", items: [], retry: refetch });
  });

  test("query view preserves data and failures across fetch states", () => {
    assertProperty(
      "query view preserves data and failures across fetch states",
      fc.property(
        fc.array(fc.integer()),
        fc.record({ message: fc.string() }),
        fc.boolean(),
        (data, error, empty) => {
          for (const fetchStatus of FETCH_STATUSES) {
            const isEmpty = () => empty;
            const pending = queryView(
              {
                status: "pending",
                fetchStatus,
                isPlaceholderData: false,
                data: undefined,
                error: null,
                refetch,
              },
              { isEmpty },
            );
            const failed = queryView(
              {
                status: "error",
                fetchStatus,
                isPlaceholderData: false,
                data: undefined,
                error,
                refetch,
              },
              { isEmpty },
            );
            const cachedFailure = queryView(
              {
                status: "error",
                fetchStatus,
                isPlaceholderData: false,
                data,
                error,
                refetch,
              },
              { isEmpty },
            );
            const successful = queryView(
              {
                status: "success",
                fetchStatus,
                isPlaceholderData: false,
                data,
                error: null,
                refetch,
              },
              { isEmpty },
            );
            expect(pending.type).toBe("pending");
            expect(queryViewError(pending)).toBeUndefined();
            expect(failed).toEqual({ type: "error", error, retry: refetch });
            expect(queryViewError(failed)).toBe(error);
            expect(cachedFailure).toEqual({
              type: "items",
              items: data,
              refetchError: error,
              retry: refetch,
            });
            if (cachedFailure.type === "items") {
              expect(cachedFailure.items).toBe(data);
            }
            expect(queryViewError(cachedFailure)).toBe(error);
            expect(successful.type === "empty").toBe(empty);
            expect(queryViewError(successful)).toBeUndefined();
            if (successful.type === "items") {
              expect(successful.items).toBe(data);
              expect(successful).not.toHaveProperty("refetchError");
            }
          }
        },
      ),
    );
  });

  test("empty arrays require a successful response rather than a placeholder", () => {
    assertProperty(
      "empty arrays require a successful response rather than a placeholder",
      fc.property(fc.array(fc.jsonValue()), (data) => {
        for (const fetchStatus of FETCH_STATUSES) {
          for (const isPlaceholderData of [false, true]) {
            const view = queryView({
              status: "success",
              fetchStatus,
              isPlaceholderData,
              data,
              error: null,
              refetch,
            });
            expect(view.type === "empty").toBe(
              !isPlaceholderData && data.length === 0,
            );
            expect(view.type === "pending").toBe(
              isPlaceholderData && data.length === 0,
            );
            if (view.type === "items") {
              expect(view.items).toBe(data);
            }
          }
        }
      }),
    );
  });
});
