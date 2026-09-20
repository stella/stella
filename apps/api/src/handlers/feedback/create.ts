import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import {
  FEEDBACK_AREAS,
  FEEDBACK_CLIENTS,
  FEEDBACK_KINDS,
  FEEDBACK_LIMITS,
} from "@stll/api-contract/feedback";
import type { FeedbackReportInput } from "@stll/api-contract/feedback";

import { member, user } from "@/api/db/auth-schema";
import { feedbackIntakeGuards } from "@/api/handlers/feedback/intake-guards";
import { submitFeedbackReport } from "@/api/handlers/feedback/submit";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { FEEDBACK_REQUEST_ID_PATTERN } from "@/api/lib/feedback/sanitize-report";

/** A person files a handful of reports at most; above this it is a script. */
const RATE_LIMIT_MAX_PER_USER = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_BUCKET = "feedback:user";

const optionalCapped = (maxLength: number) =>
  t.Optional(t.String({ maxLength }));

const config = {
  description:
    "File a feedback report from the signed-in web app. The content is " +
    "sanitized server-side, stored, and delivered to every channel the " +
    "deployment configures. Answers with the receipt the reporter quotes " +
    "later; re-sending identical content within a day answers with the " +
    "original receipt and delivers nothing.",
  // permissions-exempt: any member may report a problem with the product;
  // workspace:read is the access floor. The report carries no matter data and
  // reads no tenant resource.
  permissions: { workspace: ["read"] },
  // Internal on purpose: agents file feedback through the two-step
  // prepare_feedback / submit_feedback tools, which add the human-approval
  // gate this route does not need (a person is already at the keyboard).
  mcp: { type: "internal", reason: "native_tool_ui" },
  access: "write",
  body: t.Object({
    kind: t.UnionEnum(FEEDBACK_KINDS),
    area: t.UnionEnum(FEEDBACK_AREAS),
    title: t.String({ minLength: 1, maxLength: FEEDBACK_LIMITS.title }),
    whatHappened: t.String({
      minLength: 1,
      maxLength: FEEDBACK_LIMITS.whatHappened,
    }),
    expected: optionalCapped(FEEDBACK_LIMITS.expected),
    steps: optionalCapped(FEEDBACK_LIMITS.steps),
    evidence: optionalCapped(FEEDBACK_LIMITS.evidence),
    context: t.Optional(
      t.Object({
        // Threaded explicitly rather than defaulted server-side: the desktop
        // shell posts to this same route and is not the web app.
        client: t.UnionEnum(FEEDBACK_CLIENTS),
        clientVersion: optionalCapped(FEEDBACK_LIMITS.contextField),
        requestId: t.Optional(
          t.String({
            maxLength: 64,
            pattern: FEEDBACK_REQUEST_ID_PATTERN.source,
          }),
        ),
        route: optionalCapped(FEEDBACK_LIMITS.contextField),
        errorReference: optionalCapped(FEEDBACK_LIMITS.contextField),
      }),
    ),
  }),
} satisfies HandlerConfig;

type FeedbackBody = (typeof config)["body"]["static"];

const toReportInput = (body: FeedbackBody): FeedbackReportInput => {
  const report: FeedbackReportInput = {
    kind: body.kind,
    area: body.area,
    title: body.title,
    whatHappened: body.whatHappened,
  };
  if (body.expected !== undefined) {
    report.expected = body.expected;
  }
  if (body.steps !== undefined) {
    report.steps = body.steps;
  }
  if (body.evidence !== undefined) {
    report.evidence = body.evidence;
  }
  if (body.context !== undefined) {
    report.context = body.context;
  }
  return report;
};

const createFeedbackReport = createSafeRootHandler(
  config,
  async function* ({ body, safeDb, session, user: sessionUser }) {
    const withinRate = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await feedbackIntakeGuards.consumeCounter({
            bucket: RATE_LIMIT_BUCKET,
            key: sessionUser.id,
            windowMs: RATE_LIMIT_WINDOW_MS,
            max: RATE_LIMIT_MAX_PER_USER,
          }),
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Could not check the feedback rate limit",
            cause,
          }),
      }),
    );
    if (!withinRate) {
      return Result.err(
        new HandlerError({
          status: 429,
          message: `Up to ${RATE_LIMIT_MAX_PER_USER} reports an hour are accepted. Try again later.`,
        }),
      );
    }

    // Scoped by organization membership, not by id alone, so the read cannot
    // become a cross-org user lookup if this handler is ever reused.
    const reporterEmail = yield* Result.await(
      safeDb(
        async (tx) =>
          await tx
            .select({ email: user.email })
            .from(user)
            .innerJoin(member, eq(member.userId, user.id))
            .where(
              and(
                eq(user.id, sessionUser.id),
                eq(member.organizationId, session.activeOrganizationId),
              ),
            )
            .limit(1),
      ),
    );

    const email = reporterEmail.at(0)?.email;
    const submitted = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await submitFeedbackReport({
            input: toReportInput(body),
            reporter: {
              via: "web",
              userId: sessionUser.id,
              organizationId: session.activeOrganizationId,
              ...(email === undefined ? {} : { reporterEmail: email }),
            },
          }),
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Could not file the feedback report",
            cause,
          }),
      }),
    );
    if (Result.isError(submitted)) {
      return Result.err(
        new HandlerError({
          status: 503,
          message: "Could not record the feedback report",
          cause: submitted.error,
        }),
      );
    }

    return Result.ok(submitted.value);
  },
);

export default createFeedbackReport;
