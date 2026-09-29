import { Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";
import Elysia from "elysia";

import type { ScopedDb } from "@/api/db/safe-db";
import { env } from "@/api/env";
import { createPublicSanctionsRoute } from "@/api/handlers/sanctions/public-routes";
import { isSafePublicHandler } from "@/api/lib/api-handlers";
import type { SanctionsPublicReadDb } from "@/api/lib/lists/sanctions/read-db";
import { SanctionsSubjectError } from "@/api/lib/lists/sanctions/screening-service";
import type { screenSanctionsSubject } from "@/api/lib/lists/sanctions/screening-service";
import { answerRequestError } from "@/api/lib/observability/request-lifecycle";
import { InMemoryRateLimitContext } from "@/api/lib/rate-limit/rate-limit";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";

// @ts-expect-error The anonymous boundary must not accept a tenant-scoped handle.
const scopedHandleIsPublic: ScopedDb extends SanctionsPublicReadDb
  ? true
  : false = true;
void scopedHandleIsPublic;

const screening = {
  status: "clear",
  checkedAt: "2026-09-29T12:00:00.000Z",
  cutoff: 0.8,
  lists: [],
} as const;
const request = (subject: unknown) =>
  new Request("http://localhost/sanctions/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subject }),
  });

const appWith = (screen: typeof screenSanctionsSubject) => {
  const route = createPublicSanctionsRoute({
    screen,
    rateLimitOptions: {
      context: new InMemoryRateLimitContext(),
      duration: 60_000,
      max: 20,
      generator: () => "test-client",
    },
  });
  return { route, app: new Elysia().onError(answerRequestError).use(route) };
};

const clearScreen = () =>
  mock<typeof screenSanctionsSubject>(async () =>
    Result.ok({ ...screening, lists: [] }),
  );

describe("anonymous sanctions search", () => {
  test("is a safe anonymous POST and labels lists without firm jurisdictions", async () => {
    const screen = clearScreen();
    const { app, route } = appWith(screen);
    const response = await app.handle(
      request({
        type: "organization",
        name: "Example Trading",
        companyId: "1234",
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(screening);
    expect(screen.mock.calls.at(0)?.at(0)).toMatchObject({
      subject: {
        type: "organization",
        name: "Example Trading",
        identifiers: ["1234"],
      },
      practiceJurisdictions: [],
    });
    const mounted = route.routes.filter(
      ({ path }) => path === "/sanctions/search",
    );
    expect(mounted).toHaveLength(1);
    expect(mounted.at(0)?.method).toBe("POST");
    expect(isSafePublicHandler(mounted.at(0)?.handler)).toBe(true);
    expect(
      (await app.handle(new Request("http://localhost/sanctions/search")))
        .status,
    ).toBe(404);
  });

  test("retains partial date precision and validates nationality codes", async () => {
    const screen = clearScreen();
    const { app } = appWith(screen);
    for (const dateOfBirth of [
      { precision: "year", year: 1980 },
      { precision: "month", year: 1980, month: 2 },
      { precision: "day", year: 1980, month: 2, day: 29 },
    ]) {
      const response = await app.handle(
        request({
          type: "person",
          firstName: " Alex ",
          lastName: " Tester ",
          dateOfBirth,
          nationalityCodes: ["CZ", "SK"],
        }),
      );
      expect(response.status).toBe(200);
      const { precision, ...birthDate } = dateOfBirth;
      expect(precision).toBeDefined();
      expect(screen.mock.calls.at(-1)?.at(0)).toMatchObject({
        subject: {
          type: "person",
          name: "Alex Tester",
          birthDate,
          nationalityCodes: ["CZ", "SK"],
        },
      });
    }
    expect(
      (
        await app.handle(
          request({ type: "person", firstName: "Alex", lastName: "Tester" }),
        )
      ).status,
    ).toBe(200);
    expect(screen.mock.calls.at(-1)?.at(0)).toMatchObject({
      subject: { birthDate: null, nationalityCodes: [] },
    });
    const count = screen.mock.calls.length;
    for (const subject of [
      { type: "company-id", value: "1234" },
      {
        type: "person",
        firstName: "Alex",
        lastName: "Tester",
        dateOfBirth: { precision: "day", year: 1981, month: 2, day: 29 },
      },
      {
        type: "person",
        firstName: "Alex",
        lastName: "Tester",
        nationalityCodes: ["ZZ"],
      },
    ]) {
      expect([400, 422]).toContain((await app.handle(request(subject))).status);
    }
    expect(screen.mock.calls).toHaveLength(count);
  });

  test("bounds searches on the mounted route without affecting siblings", async () => {
    const screen = clearScreen();
    const { app } = appWith(screen);
    app.get("/other", () => "ok");
    for (let index = 0; index < 20; index += 1) {
      expect(
        (await app.handle(request({ type: "organization", name: "Example" })))
          .status,
      ).toBe(200);
    }
    expect(
      (await app.handle(request({ type: "organization", name: "Example" })))
        .status,
    ).toBe(429);
    expect(screen.mock.calls).toHaveLength(20);
    expect(
      (await app.handle(new Request("http://localhost/other"))).status,
    ).toBe(200);
  });

  test("never sends identity input or the original failure to telemetry, even in debug mode", async () => {
    const analytics = installRecordingAnalytics();
    const logger = installRecordingLogger();
    const previousDebug = env.DEBUG_UNREDACTED_ERRORS;
    env.DEBUG_UNREDACTED_ERRORS = true;
    const secret = "Private Query Sentinel";
    try {
      for (const screen of [
        async () =>
          Result.err(
            new SanctionsSubjectError({ code: "empty-query", message: secret }),
          ),
        async () => {
          throw new TypeError(secret);
        },
      ]) {
        const { app } = appWith(screen);
        const response = await app.handle(
          request({ type: "organization", name: secret }),
        );
        expect([400, 500]).toContain(response.status);
        expect(await response.text()).not.toContain(secret);
      }
      expect(logger.records.length).toBeGreaterThan(0);
      expect(analytics.exceptions().length).toBeGreaterThan(0);
      expect(JSON.stringify(logger.records)).not.toContain(secret);
      expect(JSON.stringify(analytics.events)).not.toContain(secret);
    } finally {
      env.DEBUG_UNREDACTED_ERRORS = previousDebug;
      logger.restore();
      analytics.restore();
    }
  });

  test("has no direct logger or failure-sink logging", async () => {
    const source = await Bun.file(new URL("search.ts", import.meta.url)).text();
    const imports = new Bun.Transpiler({ loader: "ts" })
      .scan(source)
      .imports.map(({ path }) => path);
    expect(imports).not.toContain("@/api/lib/observability/logger");
    expect(
      imports.some(
        (path) => path.includes("analytics") || path.includes("failure-sink"),
      ),
    ).toBe(false);
    expect(source).not.toMatch(/console\.|logger\.|observeFailure\(/u);
    expect(source).not.toMatch(/cause\s*[,}:]/u);
    expect(source).toContain("createSafePublicHandler");
  });
});
