import { Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";

import type { FeedbackReportInput } from "@stll/api-contract/feedback";

import { GithubDeliveryError } from "@/api/handlers/feedback/github-delivery";
import type { GithubIssueCreator } from "@/api/handlers/feedback/github-delivery";
import {
  NO_DELIVERY_CHANNEL_WARNING,
  generateFeedbackReceipt,
  submitFeedbackReport,
} from "@/api/handlers/feedback/submit";
import type {
  FeedbackAnalyticsSink,
  FeedbackReporter,
  SubmitFeedbackDependencies,
} from "@/api/handlers/feedback/submit";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  FeedbackReportRow,
  FeedbackReportStore,
} from "@/api/lib/db/feedback-report-store";

const MCP_REPORTER_IDS = {
  userId: toSafeId<"user">("user_1"),
  organizationId: toSafeId<"organization">("org_1"),
};

const MCP_REPORTER: FeedbackReporter = { via: "mcp", ...MCP_REPORTER_IDS };

const REPORT: FeedbackReportInput = {
  kind: "bug",
  area: "documents",
  title: "read_document answers with an empty body",
  whatHappened: "A 200-page PDF read back as an empty string.",
};

/** In-memory store: the service's dedupe and bookkeeping without a database. */
const createStore = () => {
  const rows: (FeedbackReportRow & {
    id: SafeId<"feedbackReport">;
    createdAt: Date;
  })[] = [];
  const deliveriesById = new Map<string, unknown>();
  let nextId = 0;

  const store: FeedbackReportStore = {
    insertIfAbsent: async ({ row, since }) => {
      const existing = rows.find(
        (candidate) =>
          candidate.fingerprint === row.fingerprint &&
          candidate.createdAt.getTime() >= since.getTime(),
      );
      if (existing !== undefined) {
        return { id: existing.id, receipt: existing.receipt, inserted: false };
      }
      nextId += 1;
      const id = toSafeId<"feedbackReport">(
        `0000000${nextId}-0000-7000-8000-000000000000`,
      );
      rows.push({ ...row, id, createdAt: new Date() });
      return { id, receipt: row.receipt, inserted: true };
    },
    recordDeliveries: async ({ deliveries, id }) => {
      deliveriesById.set(id, deliveries);
    },
  };

  return { deliveriesById, rows, store };
};

const emailDeps = (to: string | undefined) => {
  const send = mock(async (): Promise<undefined> => undefined);
  return {
    send,
    deps: { isConfigured: () => true, send, to },
  };
};

const NO_GITHUB = { config: undefined, create: mock<GithubIssueCreator>() };

const baseDeps = (
  overrides: Partial<SubmitFeedbackDependencies> = {},
): Partial<SubmitFeedbackDependencies> => ({
  serverVersion: "1.2.3",
  newReceipt: () => "FB-7K2M-9QXZ",
  capture: () => undefined,
  analytics: () => undefined,
  email: { isConfigured: () => true, send: mock(), to: undefined },
  github: NO_GITHUB,
  ...overrides,
});

const unwrap = <T>(result: Result<T, unknown>): T => {
  if (Result.isError(result)) {
    throw new TypeError(`Expected a stored report: ${String(result.error)}`);
  }
  return result.value;
};

describe("submitFeedbackReport", () => {
  test("sanitizes the public deployment name before storing and delivering it", async () => {
    const { rows, store } = createStore();
    let deliveredInstance: string | undefined;
    const send = mock(
      async (
        input: Parameters<SubmitFeedbackDependencies["email"]["send"]>[0],
      ): Promise<undefined> => {
        if (input.reporter.via === "intake") {
          deliveredInstance = input.reporter.instance;
        }
      },
    );

    const response = unwrap(
      await submitFeedbackReport({
        input: REPORT,
        reporter: { via: "intake" },
        instance: "self-hosted at https://private.example/deployment",
        deps: baseDeps({
          store,
          email: {
            isConfigured: () => true,
            send,
            to: "maintainer@example.com",
          },
        }),
      }),
    );

    expect(response.redactions).toBe(1);
    expect(rows.at(0)?.instance).toBe("self-hosted at [redacted-url]");
    expect(deliveredInstance).toBe("self-hosted at [redacted-url]");
  });

  test("stores sanitized text and counts what the passes removed", async () => {
    const { rows, store } = createStore();

    const response = unwrap(
      await submitFeedbackReport({
        input: {
          ...REPORT,
          title: "Reported by jane@example.com",
          evidence: "Fetched https://private.example/path",
        },
        reporter: MCP_REPORTER,
        deps: baseDeps({ store }),
      }),
    );

    expect(response).toMatchObject({
      receipt: "FB-7K2M-9QXZ",
      redactions: 2,
      deduplicated: false,
      stored: true,
    });
    expect(rows.at(0)).toMatchObject({
      title: "Reported by [redacted-email]",
      evidence: "Fetched [redacted-url]",
      redactions: 2,
      via: "mcp",
      serverVersion: "1.2.3",
    });
  });

  test("keeps the request id verbatim while sanitizing every other context field", async () => {
    const { rows, store } = createStore();

    await submitFeedbackReport({
      input: {
        ...REPORT,
        context: {
          client: "mcp",
          requestId: "req_01HZX8ABCD",
          route: "read_document",
          errorReference: "seen at https://private.example/trace",
        },
      },
      reporter: MCP_REPORTER,
      deps: baseDeps({ store }),
    });

    expect(rows.at(0)?.context).toEqual({
      client: "mcp",
      requestId: "req_01HZX8ABCD",
      route: "read_document",
      errorReference: "seen at [redacted-url]",
    });
  });

  test("a request id that is not one is dropped rather than stored", async () => {
    const { rows, store } = createStore();

    await submitFeedbackReport({
      input: { ...REPORT, context: { requestId: "req 01 with spaces" } },
      reporter: MCP_REPORTER,
      deps: baseDeps({ store }),
    });

    expect(rows.at(0)?.context).toBeNull();
  });

  test("identical content returns the first receipt and delivers nothing again", async () => {
    const { store } = createStore();
    const email = emailDeps("maintainer@example.com");
    const receipts = ["FB-AAAA-1111", "FB-BBBB-2222"];
    const deps = baseDeps({
      store,
      email: email.deps,
      newReceipt: () => receipts.shift() ?? "FB-CCCC-3333",
    });

    const first = unwrap(
      await submitFeedbackReport({
        input: REPORT,
        reporter: MCP_REPORTER,
        deps,
      }),
    );
    const second = unwrap(
      await submitFeedbackReport({
        input: REPORT,
        reporter: MCP_REPORTER,
        deps,
      }),
    );

    expect(first.receipt).toBe("FB-AAAA-1111");
    expect(second).toMatchObject({
      receipt: "FB-AAAA-1111",
      deduplicated: true,
      deliveries: [],
    });
    expect(email.send).toHaveBeenCalledTimes(1);
  });

  test("concurrent identical submissions converge on one receipt and delivery", async () => {
    const { rows, store } = createStore();
    const email = emailDeps("maintainer@example.com");
    const deps = baseDeps({ store, email: email.deps });

    const responses = await Promise.all([
      submitFeedbackReport({ input: REPORT, reporter: MCP_REPORTER, deps }),
      submitFeedbackReport({ input: REPORT, reporter: MCP_REPORTER, deps }),
    ]);

    expect(rows).toHaveLength(1);
    expect(responses.map((response) => unwrap(response).receipt)).toEqual([
      "FB-7K2M-9QXZ",
      "FB-7K2M-9QXZ",
    ]);
    expect(email.send).toHaveBeenCalledTimes(1);
  });

  test("context and deployment identity participate in dedupe", async () => {
    const { rows, store } = createStore();
    const deps = baseDeps({ store });

    const first = unwrap(
      await submitFeedbackReport({
        input: { ...REPORT, context: { route: "one" } },
        reporter: { via: "intake" },
        instance: "deployment-one",
        deps,
      }),
    );
    const second = unwrap(
      await submitFeedbackReport({
        input: { ...REPORT, context: { route: "two" } },
        reporter: { via: "intake" },
        instance: "deployment-two",
        deps,
      }),
    );

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(false);
    expect(rows).toHaveLength(2);
  });

  test("reports outside the 24-hour window do not deduplicate", async () => {
    const { rows, store } = createStore();
    const deps = baseDeps({ store });

    unwrap(
      await submitFeedbackReport({
        input: REPORT,
        reporter: MCP_REPORTER,
        deps,
      }),
    );
    const stored = rows.at(0);
    if (stored === undefined) {
      throw new Error("expected a stored report");
    }
    stored.createdAt = new Date(Date.now() - 24 * 60 * 60 * 1000 - 1);

    const second = unwrap(
      await submitFeedbackReport({
        input: REPORT,
        reporter: MCP_REPORTER,
        deps,
      }),
    );
    expect(second.deduplicated).toBe(false);
    expect(rows).toHaveLength(2);
  });

  test("a failed channel is recorded as failed and the receipt still comes back", async () => {
    const { deliveriesById, store } = createStore();
    const send = mock(async () => {
      throw new Error("smtp is down");
    });
    const captured: unknown[] = [];

    const response = unwrap(
      await submitFeedbackReport({
        input: REPORT,
        reporter: MCP_REPORTER,
        deps: baseDeps({
          store,
          capture: (error) => {
            captured.push(error);
          },
          email: {
            isConfigured: () => true,
            send,
            to: "maintainer@example.com",
          },
        }),
      }),
    );

    expect(response.receipt).toBe("FB-7K2M-9QXZ");
    expect(response.deliveries).toEqual([
      { channel: "email", status: "failed" },
    ]);
    expect(captured).toHaveLength(1);
    expect([...deliveriesById.values()].at(0)).toEqual([
      { channel: "email", status: "failed" },
    ]);
  });

  test("with no channel configured the report is stored with a warning", async () => {
    const { rows, store } = createStore();

    const response = unwrap(
      await submitFeedbackReport({
        input: REPORT,
        reporter: MCP_REPORTER,
        deps: baseDeps({ store }),
      }),
    );

    expect(response.deliveries).toEqual([]);
    expect(response.warning).toBe(NO_DELIVERY_CHANNEL_WARNING);
    expect(rows).toHaveLength(1);
  });

  test("no reporter identity reaches the GitHub issue", async () => {
    const { store } = createStore();
    const create = mock<GithubIssueCreator>(async () =>
      Result.ok("https://github.test/org/repo/issues/1"),
    );

    const response = unwrap(
      await submitFeedbackReport({
        input: REPORT,
        reporter: {
          via: "web",
          userId: toSafeId<"user">("user_secret"),
          organizationId: toSafeId<"organization">("org_secret"),
          reporterEmail: "jane@example.com",
        },
        deps: baseDeps({
          store,
          github: { config: { repo: "org/repo", token: "t" }, create },
        }),
      }),
    );

    expect(response.deliveries).toEqual([
      {
        channel: "github",
        status: "delivered",
        url: "https://github.test/org/repo/issues/1",
      },
    ]);
    const issue = create.mock.calls.at(0)?.[0].issue;
    const serialized = `${issue?.title ?? ""}\n${issue?.body ?? ""}`;
    expect(serialized).not.toContain("user_secret");
    expect(serialized).not.toContain("org_secret");
    expect(serialized).not.toContain("jane@example.com");
    expect(serialized).toContain("FB-7K2M-9QXZ");
  });

  test("a refused GitHub call is recorded without taking the report down", async () => {
    const { store } = createStore();
    const create = mock<GithubIssueCreator>(async () =>
      Result.err(new GithubDeliveryError({ message: "403" })),
    );

    const response = unwrap(
      await submitFeedbackReport({
        input: REPORT,
        reporter: MCP_REPORTER,
        deps: baseDeps({
          store,
          github: { config: { repo: "org/repo", token: "t" }, create },
        }),
      }),
    );

    expect(response.deliveries).toEqual([
      { channel: "github", status: "failed" },
    ]);
    expect(response.receipt).toBe("FB-7K2M-9QXZ");
  });

  test("one analytics event per submission, carrying no content", async () => {
    const { store } = createStore();
    const events: Parameters<FeedbackAnalyticsSink>[0][] = [];

    await submitFeedbackReport({
      input: REPORT,
      reporter: MCP_REPORTER,
      deps: baseDeps({
        store,
        analytics: (event) => {
          events.push(event);
        },
      }),
    });

    expect(events).toHaveLength(1);
    expect(events.at(0)).toEqual({
      distinctId: MCP_REPORTER_IDS.userId,
      organizationId: MCP_REPORTER_IDS.organizationId,
      properties: {
        kind: "bug",
        area: "documents",
        via: "mcp",
        redactions: 0,
        deduplicated: false,
        email_delivery: "not_configured",
        github_delivery: "not_configured",
      },
    });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(REPORT.title);
    expect(serialized).not.toContain(REPORT.whatHappened);
  });

  test("a store failure is returned, not thrown", async () => {
    const { store } = createStore();
    const failing: FeedbackReportStore = {
      ...store,
      insertIfAbsent: async () => {
        throw new Error("connection refused");
      },
    };

    const result = await submitFeedbackReport({
      input: REPORT,
      reporter: MCP_REPORTER,
      deps: baseDeps({ store: failing }),
    });

    expect(Result.isError(result)).toBe(true);
  });
});

describe("generateFeedbackReceipt", () => {
  test("every receipt matches the format the database CHECK enforces", () => {
    const pattern =
      /^FB-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}$/u;

    for (let index = 0; index < 500; index += 1) {
      expect(generateFeedbackReceipt()).toMatch(pattern);
    }
  });

  test("the ambiguous Crockford letters never appear", () => {
    const receipts = Array.from({ length: 500 }, generateFeedbackReceipt).join(
      "",
    );

    for (const letter of ["I", "L", "O", "U"]) {
      expect(receipts).not.toContain(letter);
    }
  });
});
