import { describe, expect, it } from "bun:test";
import { DrizzleQueryError } from "drizzle-orm";

import { TimeoutError } from "@/api/lib/errors/tagged-errors";
import { PG_DRIVER_ERROR } from "@/api/lib/pg-error";

import { isTransientConnectionError } from "./transient-connection-error";

/**
 * A Bun `PostgresError` as the pool actually throws it: the message states the
 * failure and never names the type, and the driver category is in `code`. The
 * `name` matters because it is what the runner's log line renders, which is
 * how these reach an operator ("PostgresError: Idle timeout reached after 2m").
 *
 * These fixtures spell the code as `PG_DRIVER_ERROR.*`, so on their own they
 * would agree with a typo in that map. They are not the guard against it:
 * `pg-error.test.ts` pins the map to literals and drives the live `Bun.sql`
 * pool to check one code against what the driver really emits. What is left
 * for these tests is the classifier's own behaviour, which is what they cover.
 */
const postgresError = (code: string, message: string) =>
  Object.assign(new Error(message), { name: "PostgresError", code });

const wrapped = (cause: Error) =>
  new DrizzleQueryError("query failed", [], cause);

describe("isTransientConnectionError", () => {
  it("classifies a pool idle-timeout retirement as transient", () => {
    expect(
      isTransientConnectionError(
        postgresError(
          PG_DRIVER_ERROR.IDLE_TIMEOUT,
          "Idle timeout reached after 2m",
        ),
      ),
    ).toBe(true);
  });

  it("classifies a pool max-lifetime retirement as transient", () => {
    expect(
      isTransientConnectionError(
        postgresError(
          PG_DRIVER_ERROR.LIFETIME_TIMEOUT,
          "Max lifetime timeout reached after 15m",
        ),
      ),
    ).toBe(true);
  });

  it("classifies a server-closed connection as transient", () => {
    expect(
      isTransientConnectionError(
        postgresError(PG_DRIVER_ERROR.CONNECTION_CLOSED, "Connection closed"),
      ),
    ).toBe(true);
  });

  it("classifies a connection timeout as transient", () => {
    expect(
      isTransientConnectionError(
        postgresError(
          PG_DRIVER_ERROR.CONNECTION_TIMEOUT,
          "Connection timeout reached",
        ),
      ),
    ).toBe(true);
  });

  it("sees a retirement through the DrizzleQueryError wrapper", () => {
    expect(
      isTransientConnectionError(
        wrapped(
          postgresError(
            PG_DRIVER_ERROR.LIFETIME_TIMEOUT,
            "Max lifetime timeout reached after 15m",
          ),
        ),
      ),
    ).toBe(true);
  });

  it("classifies a TimeoutError as transient", () => {
    expect(
      isTransientConnectionError(
        new TimeoutError({ message: "wedged", label: "corpus-index" }),
      ),
    ).toBe(true);
  });

  /**
   * The load-bearing negative: a query the server rejected carries a SQLSTATE
   * in `errno` and a generic category in `code`, and must reach the failure
   * sink rather than being retried as a lost connection.
   */
  it("does not classify a server-rejected query as transient", () => {
    const serverError = Object.assign(
      new Error('relation "x" does not exist'),
      {
        name: "PostgresError",
        code: "ERR_POSTGRES_SERVER_ERROR",
        errno: "42P01",
      },
    );
    expect(isTransientConnectionError(serverError)).toBe(false);
    expect(isTransientConnectionError(wrapped(serverError))).toBe(false);
  });

  it("does not classify an ordinary backfill failure as transient", () => {
    expect(
      isTransientConnectionError(
        new Error("generation did not reach a fixed point"),
      ),
    ).toBe(false);
  });

  /**
   * The message is the driver's to reword and never names its own type, so a
   * classifier reading text rather than `code` silently stops matching. Both
   * shapes below are the same retirement with the wording changed.
   */
  it("classifies by code, not by message wording", () => {
    expect(
      isTransientConnectionError(
        postgresError(PG_DRIVER_ERROR.IDLE_TIMEOUT, "idle for too long"),
      ),
    ).toBe(true);
    expect(
      isTransientConnectionError(
        postgresError(PG_DRIVER_ERROR.IDLE_TIMEOUT, ""),
      ),
    ).toBe(true);
  });

  it("terminates on a self-referential cause chain", () => {
    const cyclic: Error & { cause?: unknown } = new Error("cyclic");
    cyclic.cause = cyclic;
    expect(isTransientConnectionError(cyclic)).toBe(false);
  });

  it("tolerates a non-error value", () => {
    expect(isTransientConnectionError(undefined)).toBe(false);
    expect(isTransientConnectionError(42)).toBe(false);
  });

  /**
   * The predicate also decides whether an unhandled rejection ends the
   * process, so the pre-existing free-text match stays reachable for a caller
   * that rendered the driver error into a message instead of keeping it as the
   * `cause`. Narrowing it would turn a survivable drop into an exit.
   */
  it("still matches a closure rendered into free text", () => {
    expect(
      isTransientConnectionError(new Error("pool failed: Connection closed")),
    ).toBe(true);
    expect(
      isTransientConnectionError(
        new Error(`pool failed: ${PG_DRIVER_ERROR.CONNECTION_CLOSED}`),
      ),
    ).toBe(true);
  });
});
