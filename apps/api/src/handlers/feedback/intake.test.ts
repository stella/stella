import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import Elysia from "elysia";

// Replace the whole email module: importing the real one pulls in the
// transactional template package, which the shared node_modules may resolve to
// a checkout without this branch's template. Stub every export the wider test
// graph consumes so no other importer breaks.
const sendFeedbackEmailMock = mock(
  async (_args: {
    to: string;
    kind: string;
    title: string;
    body: string;
    reporter: { via: string; instance?: string; version?: string };
  }): Promise<undefined> => undefined,
);
void mock.module("@/api/lib/email", () => ({
  isTransactionalEmailConfigured: () => true,
  sendOTPEmail: mock(async () => undefined),
  sendNewDeviceLoginEmail: mock(async () => undefined),
  sendOrganizationInvitation: mock(async () => undefined),
  sendFeedbackEmail: sendFeedbackEmailMock,
}));

const { createFeedbackIntakeGuards } =
  await import("@/api/handlers/feedback/intake-guards");
const { receivePublicFeedback } =
  await import("@/api/handlers/feedback/intake");
const { feedbackPublicRoute } = await import("@/api/handlers/feedback/routes");

// In-memory-only guards: force the Redis path to throw so every call falls back
// to the deterministic in-process counters/dedup.
const memoryGuards = () =>
  createFeedbackIntakeGuards({
    createRedis: () => ({
      send: async () => {
        throw new Error("no redis in test");
      },
    }),
    onRedisError: () => undefined,
  });

const raw = (overrides?: Record<string, unknown>): string =>
  JSON.stringify({
    kind: "bug",
    title: "read_document returns empty",
    body: "Steps: call read_document on a large PDF. Body is empty.",
    ...overrides,
  });

const readError = async (
  response: Response,
): Promise<{ code?: string } | undefined> =>
  ((await response.json()) as { error?: { code?: string } }).error;

describe("public feedback intake", () => {
  beforeEach(() => {
    sendFeedbackEmailMock.mockReset();
  });

  afterAll(() => {
    mock.restore();
  });

  test("delivers via email when FEEDBACK_EMAIL_TO is set, re-sanitizing content", async () => {
    const response = await receivePublicFeedback({
      rawBody: raw({
        title: "empty for jane@example.com",
        body: "Reported by jane@example.com on a matter.",
        source: { instance: "self-hosted", version: "1.2.3" },
      }),
      clientIp: "203.0.113.5",
      deps: {
        guards: memoryGuards(),
        emailTo: "maintainer@example.com",
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ delivered: "email" });

    expect(sendFeedbackEmailMock).toHaveBeenCalledTimes(1);
    const emailArgs = sendFeedbackEmailMock.mock.calls.at(0)?.[0];
    // The caller's email is redacted server-side, and the intake footer is added.
    expect(emailArgs?.title).toBe("empty for [redacted-email]");
    expect(emailArgs?.body).toContain("[redacted-email]");
    expect(emailArgs?.body).not.toContain("jane@example.com");
    expect(emailArgs?.body).toContain(
      "Received via the stella feedback intake",
    );
  });

  test("delivers via email with an intake reporter block", async () => {
    const response = await receivePublicFeedback({
      rawBody: raw({ source: { instance: "hosted", version: "9.9.9" } }),
      clientIp: "203.0.113.6",
      deps: {
        guards: memoryGuards(),
        emailTo: "maintainer@example.com",
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ delivered: "email" });
    expect(sendFeedbackEmailMock).toHaveBeenCalledTimes(1);
    expect(sendFeedbackEmailMock.mock.calls.at(0)?.[0]).toMatchObject({
      to: "maintainer@example.com",
      kind: "bug",
      reporter: { via: "intake", instance: "hosted", version: "9.9.9" },
    });
  });

  test("sanitizes source metadata before email delivery", async () => {
    const response = await receivePublicFeedback({
      rawBody: raw({
        source: {
          instance: "jane@example.com",
          version: "https://private.example/internal",
        },
      }),
      clientIp: "203.0.113.13",
      deps: {
        guards: memoryGuards(),
        emailTo: "maintainer@example.com",
      },
    });

    expect(response.status).toBe(200);
    expect(sendFeedbackEmailMock).toHaveBeenCalledTimes(1);
    const emailArgs = sendFeedbackEmailMock.mock.calls.at(0)?.[0];
    expect(emailArgs?.body).toContain("instance=[redacted-email]");
    expect(emailArgs?.body).toContain("version=[redacted-url]");
    expect(emailArgs?.body).not.toContain("jane@example.com");
    expect(emailArgs?.body).not.toContain("private.example");
    expect(emailArgs?.reporter).toEqual({
      via: "intake",
      instance: "[redacted-email]",
      version: "[redacted-url]",
    });
  });

  test("refuses with feature_disabled when no email is configured", async () => {
    const response = await receivePublicFeedback({
      rawBody: raw(),
      clientIp: "203.0.113.7",
      deps: {
        guards: memoryGuards(),
        emailTo: undefined,
      },
    });
    expect(response.status).toBe(503);
    expect((await readError(response))?.code).toBe("feature_disabled");
  });

  test("rate-limits after 5 submissions from one IP", async () => {
    const guards = memoryGuards();
    const deps = {
      guards,
      emailTo: "maintainer@example.com",
    };
    const ip = "203.0.113.8";

    for (let i = 0; i < 5; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- sequential rate-limit probe: each submission must increment the per-IP counter before the next so the 6th trips the limit
      const ok = await receivePublicFeedback({
        // Unique content each time so dedup never fires before the rate limit.
        rawBody: raw({ title: `report ${i}`, body: `distinct body ${i}` }),
        clientIp: ip,
        deps,
      });
      expect(ok.status).toBe(200);
    }

    const blocked = await receivePublicFeedback({
      rawBody: raw({ title: "report 6", body: "distinct body 6" }),
      clientIp: ip,
      deps,
    });
    expect(blocked.status).toBe(429);
    expect((await readError(blocked))?.code).toBe("rate_limited");
  });

  test("dedups identical content within the window (409)", async () => {
    const guards = memoryGuards();
    const deps = {
      guards,
      emailTo: "maintainer@example.com",
    };

    const first = await receivePublicFeedback({
      rawBody: raw(),
      clientIp: "203.0.113.9",
      deps,
    });
    expect(first.status).toBe(200);

    const duplicate = await receivePublicFeedback({
      rawBody: raw(),
      clientIp: "203.0.113.9",
      deps,
    });
    expect(duplicate.status).toBe(409);
    expect((await readError(duplicate))?.code).toBe("validation_error");
    // Only the first submission was delivered.
    expect(sendFeedbackEmailMock).toHaveBeenCalledTimes(1);
  });

  test("schema rejects an oversized body (422)", async () => {
    const response = await receivePublicFeedback({
      rawBody: raw({ body: "x".repeat(8001) }),
      clientIp: "203.0.113.10",
      deps: { guards: memoryGuards(), emailTo: "maintainer@example.com" },
    });
    expect(response.status).toBe(422);
    expect((await readError(response))?.code).toBe("validation_error");
  });

  test("schema rejects unknown keys (422)", async () => {
    const response = await receivePublicFeedback({
      rawBody: raw({ severity: "high" }),
      clientIp: "203.0.113.11",
      deps: { guards: memoryGuards(), emailTo: "maintainer@example.com" },
    });
    expect(response.status).toBe(422);
    expect((await readError(response))?.code).toBe("validation_error");
  });

  test("rejects a malformed JSON body (400)", async () => {
    const response = await receivePublicFeedback({
      rawBody: "{not json",
      clientIp: "203.0.113.12",
      deps: { guards: memoryGuards(), emailTo: "maintainer@example.com" },
    });
    expect(response.status).toBe(400);
    expect((await readError(response))?.code).toBe("validation_error");
  });

  // End-to-end through Elysia routing + parse:"text", to prove the route wires
  // to the handler and the strict contract survives the framework layer. The
  // well-formed body proves routing reached the handler (not a 404); the
  // delivery status depends on ambient env config, so it is not asserted here.
  // The unknown-key rejection (422) is deterministic — it is refused before
  // delivery — and proves the strict Valibot contract runs on the raw payload.
  test("route wiring: POST /public/feedback reaches the handler", async () => {
    const app = new Elysia().use(feedbackPublicRoute);
    const wellFormed = await app.handle(
      new Request("http://api.test/public/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw(),
      }),
    );
    expect(wellFormed.status).not.toBe(404);

    const unknownKey = await app.handle(
      new Request("http://api.test/public/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw({ junk: 1 }),
      }),
    );
    expect(unknownKey.status).toBe(422);
  });
});
