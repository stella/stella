import { Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";
import Elysia from "elysia";

import { COUNTRY_CODES } from "@stll/country-codes";

import type { ScopedDb } from "@/api/db/safe-db";
import { env } from "@/api/env";
import { createPublicSanctionsRoute } from "@/api/handlers/sanctions/public-routes";
import { isSafePublicHandler } from "@/api/lib/api-handlers";
import { MAX_CONTACT_NATIONALITY_CODES } from "@/api/lib/business-registries/nationality-codes";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import { SANCTIONS_WARMING_RETRY_AFTER_SECONDS } from "@/api/lib/lists/sanctions/public-screening";
import { SanctionsPublicRoleError } from "@/api/lib/lists/sanctions/read-db";
import type { SanctionsPublicReadDb } from "@/api/lib/lists/sanctions/read-db";
import {
  screenSanctionsSubject,
  SanctionsSubjectError,
  unavailableSanctionsScreening,
} from "@/api/lib/lists/sanctions/screening-service";
import { answerRequestError } from "@/api/lib/observability/request-lifecycle";
import { InMemoryRateLimitContext } from "@/api/lib/rate-limit/rate-limit";
import {
  CACHE_CONTROL_HEADER,
  PRIVATE_CACHE_CONTROL,
} from "@/api/lib/security-headers";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

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

const testDb = (
  validateRole: SanctionsPublicReadDb["validateRole"] = async () =>
    Result.ok(undefined),
) =>
  asTestRaw<SanctionsPublicReadDb>(
    Object.assign(
      async () => {
        throw new TypeError("Unexpected database read in route test");
      },
      { validateRole },
    ),
  );

const appWith = (screen: typeof screenSanctionsSubject, db = testDb()) => {
  const route = createPublicSanctionsRoute({
    db,
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
  test("one warming list among others still asks for a retry", async () => {
    const now = new Date("2026-09-29T12:00:00.000Z");
    const warming = unavailableSanctionsScreening({
      reason: "warming",
      practiceJurisdictions: [],
      now,
    });
    const loadFailed = unavailableSanctionsScreening({
      reason: "load-failed",
      practiceJurisdictions: [],
      now,
    });
    const { app } = appWith(
      mock<typeof screenSanctionsSubject>(async () =>
        Result.ok({
          ...warming,
          lists: [...warming.lists.slice(0, 1), ...loadFailed.lists.slice(1)],
        }),
      ),
    );
    const response = await app.handle(
      request({ type: "organization", name: "Example Trading" }),
    );
    const body = asTestRaw<{ retryAfterSeconds: number | null }>(
      await response.json(),
    );
    expect(body.retryAfterSeconds).toBe(SANCTIONS_WARMING_RETRY_AFTER_SECONDS);
  });

  test.each([
    {
      reason: "warming",
      retryAfterSeconds: SANCTIONS_WARMING_RETRY_AFTER_SECONDS,
    },
    { reason: "load-failed", retryAfterSeconds: null },
  ] as const)(
    "a $reason list answers retry-after $retryAfterSeconds",
    async ({ reason, retryAfterSeconds }) => {
      const now = new Date("2026-09-29T12:00:00.000Z");
      const { app } = appWith(
        mock<typeof screenSanctionsSubject>(async () =>
          Result.ok(
            unavailableSanctionsScreening({
              reason,
              practiceJurisdictions: [],
              now,
            }),
          ),
        ),
      );
      const response = await app.handle(
        request({ type: "organization", name: "Example Trading" }),
      );
      expect(response.status).toBe(200);
      const body = asTestRaw<{
        status: string;
        retryAfterSeconds: number | null;
        lists: { reason: string | null }[];
      }>(await response.json());
      expect(body).toMatchObject({ status: "unavailable", retryAfterSeconds });
      expect(body.lists.every((list) => list.reason === reason)).toBe(true);
    },
  );

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
    expect(await response.json()).toEqual({
      ...screening,
      retryAfterSeconds: null,
    });
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

  test("refuses excess public screenings before database work and releases capacity", async () => {
    const analytics = installRecordingAnalytics();
    const logger = installRecordingLogger();
    const maximum = API_RATE_LIMITS.publicSanctionsSearch.maxConcurrent;
    const held = Promise.withResolvers();
    const allStarted = Promise.withResolvers();
    let started = 0;
    const screen = mock<typeof screenSanctionsSubject>(async () => {
      started += 1;
      if (started === maximum) {
        allStarted.resolve(undefined);
      }
      if (started <= maximum) {
        await held.promise;
      }
      return Result.ok({ ...screening, lists: [] });
    });
    const validateRole = mock<SanctionsPublicReadDb["validateRole"]>(async () =>
      Result.ok(undefined),
    );
    const db = testDb(validateRole);
    // Different handler instances share the per-process admission ceiling.
    const requests = Array.from(
      { length: maximum },
      async () =>
        await appWith(screen, db).app.handle(
          request({ type: "organization", name: "Held" }),
        ),
    );
    try {
      await allStarted.promise;
      const { app } = appWith(screen, db);
      const began = performance.now();
      const rejected = await app.handle(
        request({ type: "organization", name: "Private Admission Sentinel" }),
      );
      expect(rejected.status).toBe(503);
      expect(rejected.headers.get(CACHE_CONTROL_HEADER)).toBe(
        PRIVATE_CACHE_CONTROL,
      );
      expect(analytics.exceptions()).toHaveLength(0);
      expect(
        logger.records.some(
          (record) => record.message === "sanctions.search.busy",
        ),
      ).toBe(true);
      expect(JSON.stringify(logger.records)).not.toContain(
        "Private Admission Sentinel",
      );
      console.info(
        JSON.stringify({
          admissionRejectionMs: Number((performance.now() - began).toFixed(2)),
        }),
      );
      expect(await rejected.text()).not.toContain("Private Admission Sentinel");
      // Saturated admission must add no role checks or matcher evaluations.
      expect(validateRole.mock.calls).toHaveLength(maximum);
      expect(screen.mock.calls).toHaveLength(maximum);
      held.resolve(undefined);
      expect((await Promise.all(requests)).map(({ status }) => status)).toEqual(
        Array.from({ length: maximum }, () => 200),
      );
      expect(
        (await app.handle(request({ type: "organization", name: "Released" })))
          .status,
      ).toBe(200);
    } finally {
      held.resolve(undefined);
      await Promise.all(requests);
      logger.restore();
      analytics.restore();
    }
  });

  test("releases public screening capacity after role and matcher failures", async () => {
    for (const failure of ["role", "matcher"] as const) {
      const screen =
        failure === "matcher"
          ? async () => {
              throw new TypeError("Private failure sentinel");
            }
          : clearScreen();
      const db =
        failure === "role"
          ? testDb(async () =>
              Result.err(
                new SanctionsPublicRoleError({
                  message: "Private failure sentinel",
                }),
              ),
            )
          : testDb();
      const { app } = appWith(screen, db);
      for (
        let count = 0;
        count < API_RATE_LIMITS.publicSanctionsSearch.maxConcurrent + 1;
        count += 1
      ) {
        expect(
          (await app.handle(request({ type: "organization", name: "Example" })))
            .status,
        ).toBe(500);
      }
      expect(
        (
          await appWith(clearScreen()).app.handle(
            request({ type: "organization", name: "Recovered" }),
          )
        ).status,
      ).toBe(200);
    }
  });

  test("rejects oversized identity input without returning it in validation errors", async () => {
    const screen = clearScreen();
    const { app } = appWith(screen);
    const marker = "Private Validation Sentinel";
    const name = marker.padEnd(600, "x");
    expect(name.length).toBeGreaterThan(512);
    const response = await app.handle(request({ type: "organization", name }));
    expect(response.status).toBe(422);
    expect(await response.text()).not.toContain(marker);
    expect(screen.mock.calls).toHaveLength(0);
  });

  test.each([
    { field: "name", limit: 512 },
    { field: "companyId", limit: 32 },
    { field: "firstName", limit: 100 },
    { field: "lastName", limit: 100 },
  ] as const)(
    "every public identity field enforces its size boundary before database work ($field)",
    async ({ field, limit }) => {
      const screen = clearScreen();
      const validateRole = mock<SanctionsPublicReadDb["validateRole"]>(
        async () => Result.ok(undefined),
      );
      const { app } = appWith(screen, testDb(validateRole));
      const value = "Qzx".padEnd(limit, "a");
      const subject = (input: string) =>
        field === "name" || field === "companyId"
          ? { type: "organization", name: "Example", [field]: input }
          : {
              type: "person",
              firstName: "Alex",
              lastName: "Tester",
              [field]: input,
            };
      expect((await app.handle(request(subject(value)))).status).toBe(200);
      expect(validateRole.mock.calls).toHaveLength(1);
      expect(screen.mock.calls).toHaveLength(1);
      for (const input of [`${value}a`, ""]) {
        const response = await app.handle(request(subject(input)));
        expect(response.status).toBe(422);
        expect(response.headers.get(CACHE_CONTROL_HEADER)).toBe(
          PRIVATE_CACHE_CONTROL,
        );
        expect(await response.text()).not.toContain(value);
      }
      expect(validateRole.mock.calls).toHaveLength(1);
      expect(screen.mock.calls).toHaveLength(1);
      if (field === "companyId") {
        return;
      }
      if (field === "name") {
        screen.mockImplementationOnce(screenSanctionsSubject);
      }
      const blank = await app.handle(request(subject(" ")));
      // The full person's other name still supplies a usable identity.
      expect(blank.status).toBe(field === "name" ? 400 : 200);
    },
  );

  test("nationality cardinality and uniqueness are enforced before role validation", async () => {
    const screen = clearScreen();
    const validateRole = mock<SanctionsPublicReadDb["validateRole"]>(async () =>
      Result.ok(undefined),
    );
    const { app } = appWith(screen, testDb(validateRole));
    const subject = { type: "person", firstName: "Alex", lastName: "Tester" };
    const valid = await app.handle(
      request({ ...subject, nationalityCodes: [...COUNTRY_CODES] }),
    );
    expect(valid.status).toBe(200);
    const distinct = Array.from(
      { length: MAX_CONTACT_NATIONALITY_CODES + 1 },
      (_, index) =>
        String.fromCodePoint(65 + Math.floor(index / 26), 65 + (index % 26)),
    );
    // Distinct syntactically valid codes isolate cardinality from uniqueness.
    const boundary = await app.handle(
      request({
        ...subject,
        nationalityCodes: distinct.slice(0, MAX_CONTACT_NATIONALITY_CODES),
      }),
    );
    expect(boundary.status).toBe(400);
    expect(boundary.headers.get(CACHE_CONTROL_HEADER)).toBe(
      PRIVATE_CACHE_CONTROL,
    );
    for (const nationalityCodes of [distinct, ["CZ", "CZ"]]) {
      const response = await app.handle(
        request({ ...subject, nationalityCodes }),
      );
      expect(response.status).toBe(422);
      expect(response.headers.get(CACHE_CONTROL_HEADER)).toBe(
        PRIVATE_CACHE_CONTROL,
      );
    }
    expect(validateRole.mock.calls).toHaveLength(1);
    expect(screen.mock.calls).toHaveLength(1);
  });

  test("rejects excess normalized query tokens before database or screening work", async () => {
    const screen = clearScreen();
    const validateRole = mock<SanctionsPublicReadDb["validateRole"]>(async () =>
      Result.ok(undefined),
    );
    const { app } = appWith(screen, testDb(validateRole));
    for (const name of [
      `Registered ${"r ".repeat(249)}`.slice(0, 512),
      "Registered ".repeat(46),
    ]) {
      const response = await app.handle(
        request({ type: "organization", name }),
      );
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain(name);
    }
    expect(screen.mock.calls).toHaveLength(0);
    expect(validateRole.mock.calls).toHaveLength(0);
  });

  test("accepts legitimate names beyond the previous twelve-token cap", async () => {
    const screen = clearScreen();
    const { app } = appWith(screen);
    const response = await app.handle(
      request({
        type: "person",
        firstName: "Abu Muhammad Abd al-Rahman bin Ali",
        lastName: "bin Muhammad al-Hashimi al-Qurashi",
      }),
    );
    expect(response.status).toBe(200);
    expect(screen.mock.calls).toHaveLength(1);
  });

  test("reports failed role validation before any screening", async () => {
    const screen = clearScreen();
    const marker = "Private Role Failure Sentinel";
    const { app } = appWith(
      screen,
      testDb(async () =>
        Result.err(new SanctionsPublicRoleError({ message: marker })),
      ),
    );
    const response = await app.handle(
      request({ type: "organization", name: "Example" }),
    );
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(marker);
    expect(screen.mock.calls).toHaveLength(0);
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

  test("uses bounded busy logging and never captures identities directly", async () => {
    const source = await Bun.file(new URL("search.ts", import.meta.url)).text();
    const imports = new Bun.Transpiler({ loader: "ts" })
      .scan(source)
      .imports.map(({ path }) => path);
    expect(
      imports.some(
        (path) => path.includes("analytics") || path.includes("failure-sink"),
      ),
    ).toBe(false);
    const code = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
    expect(code).not.toMatch(/console\.|observeFailure\(/u);
    expect(code).not.toMatch(/cause\s*[,}:]/u);
    expect(source).toContain("createSafePublicHandler");
  });
});

test("public identity responses are never cached, including validation and server errors", async () => {
  const { app } = appWith(clearScreen());
  for (const subject of [
    { type: "organization", name: "Example" },
    { type: "organization", name: "---" },
    { type: "organization" },
  ]) {
    const response = await app.handle(request(subject));
    expect(response.headers.get(CACHE_CONTROL_HEADER)).toBe(
      PRIVATE_CACHE_CONTROL,
    );
    expect([200, 400, 422]).toContain(response.status);
  }
  for (let index = 0; index < 20; index += 1) {
    await app.handle(request({ type: "organization", name: "Example" }));
  }
  const limited = await app.handle(
    request({ type: "organization", name: "Example" }),
  );
  expect(limited.status).toBe(429);
  expect(limited.headers.get(CACHE_CONTROL_HEADER)).toBe(PRIVATE_CACHE_CONTROL);
  const failed = appWith(async () => {
    throw new TypeError("Matcher unavailable");
  }).app;
  const error = await failed.handle(
    request({ type: "organization", name: "Example" }),
  );
  expect(error.status).toBe(500);
  expect(error.headers.get(CACHE_CONTROL_HEADER)).toBe(PRIVATE_CACHE_CONTROL);
});

test.each([
  {
    label: "truncated JSON",
    contentType: "application/json",
    body: '{"subject":{"name":"PrivateParseQzxv"',
    status: 400,
  },
  {
    label: "malformed JSON",
    contentType: "application/json",
    body: '{"subject":"PrivateParseQzxv",}',
    status: 400,
  },
  {
    label: "unsupported content type",
    contentType: "application/octet-stream",
    body: "PrivateParseQzxv",
    status: 422,
  },
])(
  "malformed public identity bodies are sanitized, never cached, and consume admission ($label)",
  async ({ contentType, body, status }) => {
    const screen = clearScreen();
    const validateRole = mock<SanctionsPublicReadDb["validateRole"]>(async () =>
      Result.ok(undefined),
    );
    const { app } = appWith(screen, testDb(validateRole));
    const response = await app.handle(
      new Request("http://localhost/sanctions/search", {
        method: "POST",
        headers: { "content-type": contentType },
        body,
      }),
    );
    expect(response.status).toBe(status);
    expect(response.headers.get(CACHE_CONTROL_HEADER)).toBe(
      PRIVATE_CACHE_CONTROL,
    );
    expect(await response.text()).not.toContain("PrivateParseQzxv");
    expect(validateRole.mock.calls).toHaveLength(0);
    expect(screen.mock.calls).toHaveLength(0);
    for (let count = 1; count < 20; count += 1) {
      expect(
        (await app.handle(request({ type: "organization", name: "Example" })))
          .status,
      ).toBe(200);
    }
    const refused = await app.handle(
      request({ type: "organization", name: "Example" }),
    );
    expect(refused.status).toBe(429);
    expect(refused.headers.get(CACHE_CONTROL_HEADER)).toBe(
      PRIVATE_CACHE_CONTROL,
    );
    expect(screen.mock.calls).toHaveLength(19);
  },
);
