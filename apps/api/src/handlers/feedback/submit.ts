/**
 * The one place a feedback report is filed, whatever entry point carried it:
 * the `submit_feedback` MCP tool, the authenticated `POST /v1/feedback` route,
 * and the public `POST /public/feedback` intake all land here.
 *
 * Order matters and is load-bearing:
 *   1. sanitize every field the reporter wrote, and count what was removed;
 *   2. fingerprint the sanitized content;
 *   3. atomically find-or-insert the fingerprint in the last day — a match is
 *      an idempotent resend and answers with the original receipt;
 *   4. store the row, so a receipt always addresses something;
 *   5. deliver to every configured channel, outside the transaction, and
 *      record each outcome on the row.
 *
 * A deployment with no channel configured is not an error: the report is
 * stored and the response carries a warning naming the two settings that would
 * turn delivery on. A failed channel is captured and recorded as failed; the
 * reporter still gets their receipt.
 */

import { panic, Result, TaggedError } from "better-result";

import type {
  FeedbackDelivery,
  FeedbackReportInput,
  FeedbackSubmitResponse,
} from "@stll/api-contract/feedback";
import { DAY_IN_MS } from "@stll/time";

import { env } from "@/api/env";
import { createGithubFeedbackIssue } from "@/api/handlers/feedback/github-delivery";
import type {
  GithubDeliveryConfig,
  GithubIssueCreator,
} from "@/api/handlers/feedback/github-delivery";
import {
  composeGithubIssueBody,
  neutralizeGithubReferences,
} from "@/api/handlers/feedback/report-body";
import {
  feedbackFingerprint,
  sanitizeFeedbackInstance,
  sanitizeFeedbackReport,
} from "@/api/handlers/feedback/sanitize-report";
import { captureError } from "@/api/lib/analytics/capture";
import { getAnalytics } from "@/api/lib/analytics/client";
import type {
  FeedbackDeliveryOutcome,
  FeedbackReportSubmittedProperties,
} from "@/api/lib/analytics/server-analytics";
import { SERVER_ANALYTICS_EVENTS } from "@/api/lib/analytics/server-analytics";
import type { SafeId } from "@/api/lib/branded-types";
import { feedbackReportStore } from "@/api/lib/db/feedback-report-store";
import type { FeedbackReportStore } from "@/api/lib/db/feedback-report-store";
import {
  isTransactionalEmailConfigured,
  sendFeedbackEmail,
} from "@/api/lib/email/email";
import { APP_VERSION } from "@/api/lib/version";

/** Identical content inside this window is a resend, not new signal. */
const DEDUPE_WINDOW_MS = DAY_IN_MS;

const RECEIPT_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const RECEIPT_GROUP_LENGTH = 4;

export const NO_DELIVERY_CHANNEL_WARNING =
  "Stored only: this deployment has no feedback delivery channel. Set FEEDBACK_EMAIL_TO for maintainer email, or FEEDBACK_GITHUB_TOKEN and FEEDBACK_GITHUB_REPO to file issues.";

export class FeedbackStoreError extends TaggedError("FeedbackStoreError")<{
  message: string;
  cause?: unknown;
}> {}

/**
 * Who filed the report. An authenticated reporter carries the identity the
 * server validated; the public intake carries none at all, which is why this
 * is a union rather than three optional fields.
 */
export type FeedbackReporter =
  | {
      via: "mcp" | "web";
      userId: SafeId<"user">;
      organizationId: SafeId<"organization">;
      reporterEmail?: string;
    }
  | { via: "intake" };

type EmailDependencies = {
  isConfigured: () => boolean;
  send: typeof sendFeedbackEmail;
  to: string | undefined;
};

type GithubDependencies = {
  config: GithubDeliveryConfig | undefined;
  create: GithubIssueCreator;
};

/** The analytics sink, so a test can read the event without a provider. */
export type FeedbackAnalyticsSink = (event: {
  distinctId: string;
  organizationId: SafeId<"organization"> | undefined;
  properties: FeedbackReportSubmittedProperties;
}) => void;

export type SubmitFeedbackDependencies = {
  store: FeedbackReportStore;
  email: EmailDependencies;
  github: GithubDependencies;
  analytics: FeedbackAnalyticsSink;
  capture: typeof captureError;
  now: () => Date;
  serverVersion: string;
  newReceipt: () => string;
};

export type SubmitFeedbackReportOptions = {
  input: FeedbackReportInput;
  reporter: FeedbackReporter;
  /** Self-reported deployment name; only the public intake sets one. */
  instance?: string | undefined;
  deps?: Partial<SubmitFeedbackDependencies>;
};

/**
 * `FB-XXXX-XXXX` over Crockford base32 without I, L, O and U, so a receipt
 * read back over the phone cannot be transcribed into a different one. The
 * alphabet has 32 members and a byte has 256 values, so the modulo is
 * unbiased.
 */
export const generateFeedbackReceipt = (): string => {
  const bytes = crypto.getRandomValues(
    new Uint8Array(RECEIPT_GROUP_LENGTH * 2),
  );
  const characters = Array.from(
    bytes,
    (byte) =>
      RECEIPT_ALPHABET[byte % RECEIPT_ALPHABET.length] ??
      panic("receipt alphabet index out of range"),
  );
  return `FB-${characters.slice(0, RECEIPT_GROUP_LENGTH).join("")}-${characters
    .slice(RECEIPT_GROUP_LENGTH)
    .join("")}`;
};

const githubConfigFromEnv = (): GithubDeliveryConfig | undefined => {
  const repo = env.FEEDBACK_GITHUB_REPO;
  const token = env.FEEDBACK_GITHUB_TOKEN;
  // Both or neither: a token with no repository has nothing to post to.
  return repo === undefined || token === undefined
    ? undefined
    : { repo, token };
};

const deliveryOutcome = (
  configured: boolean,
  delivery: FeedbackDelivery | undefined,
): FeedbackDeliveryOutcome => {
  if (!configured) {
    return "not_configured";
  }
  return delivery?.status === "delivered" ? "delivered" : "failed";
};

export const submitFeedbackReport = async ({
  deps,
  input,
  instance,
  reporter,
}: SubmitFeedbackReportOptions): Promise<
  Result<FeedbackSubmitResponse, FeedbackStoreError>
> => {
  const store = deps?.store ?? feedbackReportStore;
  const capture = deps?.capture ?? captureError;
  const now = deps?.now ?? (() => new Date());
  const serverVersion = deps?.serverVersion ?? APP_VERSION;
  const newReceipt = deps?.newReceipt ?? generateFeedbackReceipt;
  const email: EmailDependencies = deps?.email ?? {
    isConfigured: isTransactionalEmailConfigured,
    send: sendFeedbackEmail,
    to: env.FEEDBACK_EMAIL_TO,
  };
  const github: GithubDependencies = deps?.github ?? {
    config: githubConfigFromEnv(),
    create: createGithubFeedbackIssue,
  };

  const { redactions: reportRedactions, report } =
    sanitizeFeedbackReport(input);
  const sanitizedInstance =
    instance === undefined ? undefined : sanitizeFeedbackInstance(instance);
  const redactions = reportRedactions + (sanitizedInstance?.redactions ?? 0);
  const fingerprint = feedbackFingerprint(report, sanitizedInstance?.instance);

  const receipt = newReceipt();
  const identity =
    reporter.via === "intake"
      ? { userId: null, organizationId: null }
      : { userId: reporter.userId, organizationId: reporter.organizationId };

  const stored = await Result.tryPromise({
    try: async () =>
      await store.insertIfAbsent({
        since: new Date(now().getTime() - DEDUPE_WINDOW_MS),
        row: {
          kind: report.kind,
          area: report.area,
          receipt,
          title: report.title,
          whatHappened: report.whatHappened,
          expected: report.expected ?? null,
          steps: report.steps ?? null,
          evidence: report.evidence ?? null,
          context: report.context ?? null,
          serverVersion,
          instance: sanitizedInstance?.instance ?? null,
          via: reporter.via,
          ...identity,
          redactions,
          fingerprint,
        },
      }),
    catch: (cause) =>
      new FeedbackStoreError({
        message: "Could not store the feedback report",
        cause,
      }),
  });
  if (Result.isError(stored)) {
    return stored;
  }
  if (!stored.value.inserted) {
    recordAnalytics({
      analytics: deps?.analytics,
      deduplicated: true,
      email: "skipped_duplicate",
      github: "skipped_duplicate",
      redactions,
      report,
      reporter,
    });
    return Result.ok({
      receipt: stored.value.receipt,
      redactions,
      deduplicated: true,
      deliveries: [],
      stored: true,
    });
  }

  const deliveries = await deliver({
    capture,
    email,
    github,
    instance: sanitizedInstance?.instance,
    receipt,
    report,
    reporter,
    serverVersion,
  });

  if (deliveries.length > 0) {
    const recorded = await Result.tryPromise({
      try: async () =>
        await store.recordDeliveries({ id: stored.value.id, deliveries }),
      catch: (cause) => cause,
    });
    // The report and its receipt are already durable; a failed bookkeeping
    // update must not turn a delivered report into an error.
    if (Result.isError(recorded)) {
      capture(recorded.error, { source: "feedback-submit" });
    }
  }

  recordAnalytics({
    analytics: deps?.analytics,
    deduplicated: false,
    email: deliveryOutcome(
      emailConfigured(email),
      deliveries.find((delivery) => delivery.channel === "email"),
    ),
    github: deliveryOutcome(
      github.config !== undefined,
      deliveries.find((delivery) => delivery.channel === "github"),
    ),
    redactions,
    report,
    reporter,
  });

  return Result.ok({
    receipt,
    redactions,
    deduplicated: false,
    deliveries,
    stored: true,
    ...(deliveries.length === 0
      ? { warning: NO_DELIVERY_CHANNEL_WARNING }
      : {}),
  });
};

const emailConfigured = (email: EmailDependencies): boolean =>
  email.to !== undefined && email.to.length > 0 && email.isConfigured();

type DeliverOptions = {
  capture: typeof captureError;
  email: EmailDependencies;
  github: GithubDependencies;
  instance: string | undefined;
  receipt: string;
  report: FeedbackReportInput;
  reporter: FeedbackReporter;
  serverVersion: string;
};

const deliver = async ({
  capture,
  email,
  github,
  instance,
  receipt,
  report,
  reporter,
  serverVersion,
}: DeliverOptions): Promise<FeedbackDelivery[]> => {
  const deliveries: FeedbackDelivery[] = [];

  const emailTo = email.to;
  if (emailConfigured(email) && emailTo !== undefined) {
    const sent = await Result.tryPromise({
      try: async () =>
        await email.send({
          to: emailTo,
          receipt,
          report,
          serverVersion,
          reporter:
            reporter.via === "intake"
              ? {
                  via: "intake",
                  ...(instance === undefined ? {} : { instance }),
                }
              : {
                  via: reporter.via,
                  userId: reporter.userId,
                  organizationId: reporter.organizationId,
                  ...(reporter.reporterEmail === undefined
                    ? {}
                    : { reporterEmail: reporter.reporterEmail }),
                },
        }),
      catch: (cause) => cause,
    });
    if (Result.isError(sent)) {
      capture(sent.error, { source: "feedback-delivery-email" });
    }
    deliveries.push({
      channel: "email",
      status: Result.isError(sent) ? "failed" : "delivered",
    });
  }

  const githubConfig = github.config;
  if (githubConfig !== undefined) {
    const filed = await github.create({
      config: githubConfig,
      issue: {
        title: neutralizeGithubReferences(report.title),
        body: composeGithubIssueBody({ receipt, report, serverVersion }),
        kind: report.kind,
      },
    });
    if (Result.isError(filed)) {
      capture(filed.error, { source: "feedback-delivery-github" });
      deliveries.push({ channel: "github", status: "failed" });
    } else {
      deliveries.push({
        channel: "github",
        status: "delivered",
        url: filed.value,
      });
    }
  }

  return deliveries;
};

type RecordAnalyticsOptions = {
  analytics: FeedbackAnalyticsSink | undefined;
  deduplicated: boolean;
  email: FeedbackDeliveryOutcome;
  github: FeedbackDeliveryOutcome;
  redactions: number;
  report: FeedbackReportInput;
  reporter: FeedbackReporter;
};

/** One event per submission. Never content: kind, area, route and outcome only. */
const recordAnalytics = ({
  analytics,
  deduplicated,
  email,
  github,
  redactions,
  report,
  reporter,
}: RecordAnalyticsOptions): void => {
  const properties: FeedbackReportSubmittedProperties = {
    kind: report.kind,
    area: report.area,
    via: reporter.via,
    redactions,
    deduplicated,
    email_delivery: email,
    github_delivery: github,
  };
  const distinctId = reporter.via === "intake" ? "intake" : reporter.userId;
  const organizationId =
    reporter.via === "intake" ? undefined : reporter.organizationId;

  if (analytics !== undefined) {
    analytics({ distinctId, organizationId, properties });
    return;
  }

  getAnalytics().capture({
    distinctId,
    event: SERVER_ANALYTICS_EVENTS.feedbackReportSubmitted,
    ...(organizationId === undefined
      ? {}
      : { groups: { organization: organizationId } }),
    properties,
  });
};
