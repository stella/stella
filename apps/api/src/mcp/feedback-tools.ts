import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import { member, user } from "@/api/db/auth-schema";
import { env } from "@/api/env";
import { feedbackIntakeGuards } from "@/api/handlers/feedback/intake-guards";
import { captureError } from "@/api/lib/analytics";
import { sendFeedbackEmail } from "@/api/lib/email";
import type { McpRequestContext } from "@/api/mcp/context";
import { sanitizeFeedbackText } from "@/api/mcp/feedback-sanitize";
import {
  createFeedbackToken,
  FEEDBACK_TOKEN_TTL_MINUTES,
  verifyFeedbackToken,
} from "@/api/mcp/feedback-token";
import type { McpToolDefinition, McpToolHandler } from "@/api/mcp/tool-types";
import {
  enumProp,
  MCP_INTERNAL_ERROR_HINT,
  stringProp,
  structuredErrorResult,
  textResult,
} from "@/api/mcp/tool-utils";

const FEEDBACK_KINDS = ["bug", "feature_request", "docs", "other"] as const;
type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

const FEEDBACK_CHANNELS = ["github", "email", "stella"] as const;

const MAX_FEEDBACK_TITLE_CHARS = 200;
const MAX_FEEDBACK_BODY_CHARS = 8000;

// Per-organization ceiling on actual feedback deliveries (the email and stella
// channels' phase-2 sends). Phase-1 previews and the github channel never
// deliver server-side, so they are not counted. Keyed by organization id under
// a bucket distinct from the public intake's per-IP one.
const FEEDBACK_DELIVERY_MAX_PER_ORG = 5;
const FEEDBACK_DELIVERY_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const FEEDBACK_DELIVERY_BUCKET = "mcp-delivery-org";

// Self-reported deployment descriptor forwarded to the hosted intake on the
// stella channel. No user identity exists on that path, so this is the only
// provenance the maintainer receives.
const FEEDBACK_INTAKE_TIMEOUT_MS = 10_000;

const GITHUB_REPO = "stella/stella";
const GITHUB_ISSUE_LABEL = "agent-feedback";
const GITHUB_NEW_ISSUE_URL = `https://github.com/${GITHUB_REPO}/issues/new`;
// A conservative cap: browsers and servers accept much longer, but keeping the
// prefilled URL small avoids client-side truncation surprises. The full
// sanitized body is always returned separately, so nothing is lost.
const MAX_GITHUB_ISSUE_URL_CHARS = 7500;
const GITHUB_BODY_TRUNCATION_MARKER =
  "\n\n[body truncated — paste the rest manually]";
const STELLA_INTAKE_BODY_TRUNCATION_MARKER =
  "\n\n[body truncated to fit stella feedback intake]";

export const FEEDBACK_TOOL_DEFINITIONS = [
  {
    description:
      "File a bug, feature request, or docs issue with the stella maintainers. " +
      "Requires explicit human approval; the tool never publishes anything on " +
      "its own. Prefer channel github (the default): it returns a prefilled " +
      "new-issue URL and a gh command the human opens and submits under their " +
      "own GitHub account. If the human has no GitHub account, use email " +
      "(this server's configured maintainer inbox) or stella (forwards to the " +
      "hosted stella intake); both need a two-step confirmation-token " +
      "handshake. All content is sanitized server-side (emails, ids, secrets, " +
      "URLs, IPs are redacted). Never include tenant data, client or matter " +
      "names, ids, or secrets; describe the problem, reproduction steps, and " +
      "expected vs actual result.",
    inputSchema: {
      type: "object",
      properties: {
        kind: enumProp(
          "Feedback category: bug, feature_request, docs, or other",
          FEEDBACK_KINDS,
        ),
        title: stringProp(
          "Short one-line summary of the issue; no tenant data, ids, or secrets",
          { maxLength: MAX_FEEDBACK_TITLE_CHARS },
        ),
        body: stringProp(
          "Markdown details: reproduction steps, expected vs actual behavior, " +
            "environment. Never include tenant data, client or matter names, " +
            "ids, or secrets; they are redacted server-side.",
          { maxLength: MAX_FEEDBACK_BODY_CHARS },
        ),
        channel: enumProp(
          "Delivery channel. github (default) returns a prefilled issue URL the " +
            "human submits under their own GitHub account (strongly preferred). " +
            "email and stella are fallbacks for humans without a GitHub account " +
            "and each need a confirmation-token handshake: email sends to this " +
            "server's configured maintainer inbox; stella forwards to the " +
            "hosted stella intake (use when there is no GitHub account and no " +
            "local email is configured).",
          FEEDBACK_CHANNELS,
        ),
        confirmation_token: stringProp(
          "email/stella channels only: the confirmation_token from a prior " +
            "approval_required response. Send it on the second call, with the " +
            "same kind/title/body, only after the human approved the content.",
        ),
      },
      required: ["kind", "title", "body"],
    },
    access: "write",
    anonymized: { exposure: "excluded", reason: "write" },
    name: "send_feedback",
    scope: "stella:feedback",
  },
] as const satisfies readonly McpToolDefinition[];

const feedbackArgsSchema = v.strictObject({
  kind: v.picklist(FEEDBACK_KINDS),
  title: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1),
    v.maxLength(MAX_FEEDBACK_TITLE_CHARS),
  ),
  body: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(MAX_FEEDBACK_BODY_CHARS),
  ),
  channel: v.optional(v.picklist(FEEDBACK_CHANNELS), "github"),
  confirmation_token: v.optional(v.pipe(v.string(), v.minLength(1))),
});

/**
 * Sanitized body plus a provenance footer. No user/org identifiers appear
 * anywhere in the published body: those live only in the private reporter block
 * of the email channel, never on the public issue.
 */
const composeFeedbackBody = ({
  body,
  kind,
}: {
  body: string;
  kind: FeedbackKind;
}): string =>
  `${body}\n\n---\n_Filed via stella send_feedback (agent-assisted, sanitized). Kind: ${kind}._`;

const fitStellaIntakeBody = (body: string): string => {
  const bodyChars = Array.from(body);
  if (bodyChars.length <= MAX_FEEDBACK_BODY_CHARS) {
    return body;
  }

  const markerChars = Array.from(STELLA_INTAKE_BODY_TRUNCATION_MARKER);
  return [
    ...bodyChars.slice(0, MAX_FEEDBACK_BODY_CHARS - markerChars.length),
    ...markerChars,
  ].join("");
};

const buildGithubIssueUrl = ({
  body,
  title,
}: {
  body: string;
  title: string;
}): string => {
  const params = new URLSearchParams({
    title,
    body,
    labels: GITHUB_ISSUE_LABEL,
  });
  return `${GITHUB_NEW_ISSUE_URL}?${params.toString()}`;
};

export const sliceWithoutDanglingHighSurrogate = (
  value: string,
  end: number,
): string => {
  const sliced = value.slice(0, end);
  const last = sliced.charCodeAt(sliced.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? sliced.slice(0, -1) : sliced;
};

/**
 * Prefilled issue URL bounded to `MAX_GITHUB_ISSUE_URL_CHARS`. When the full
 * body overflows, the URL carries a truncated body with a paste-the-rest
 * marker; the caller still returns the full sanitized body separately.
 */
const buildBoundedGithubIssueUrl = ({
  composedBody,
  title,
}: {
  composedBody: string;
  title: string;
}): string => {
  const full = buildGithubIssueUrl({ body: composedBody, title });
  if (full.length <= MAX_GITHUB_ISSUE_URL_CHARS) {
    return full;
  }
  for (let keep = composedBody.length; keep > 0; keep -= 128) {
    const candidate = buildGithubIssueUrl({
      body:
        sliceWithoutDanglingHighSurrogate(composedBody, keep) +
        GITHUB_BODY_TRUNCATION_MARKER,
      title,
    });
    if (candidate.length <= MAX_GITHUB_ISSUE_URL_CHARS) {
      return candidate;
    }
  }
  // Even an empty body overflows (an outsized title): fall back to marker-only.
  return buildGithubIssueUrl({ body: GITHUB_BODY_TRUNCATION_MARKER, title });
};

/** POSIX single-quote escaping so the gh command is safe to paste verbatim. */
const shellSingleQuote = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`;

const buildGithubFeedbackResult = ({
  composedBody,
  redactions,
  sanitizedTitle,
}: {
  composedBody: string;
  redactions: number;
  sanitizedTitle: string;
}): CallToolResult => {
  const issueUrl = buildBoundedGithubIssueUrl({
    composedBody,
    title: sanitizedTitle,
  });
  const ghCliCommand =
    `gh issue create --repo ${GITHUB_REPO} --label ${GITHUB_ISSUE_LABEL} ` +
    `--title ${shellSingleQuote(sanitizedTitle)} --body ${shellSingleQuote(composedBody)}`;

  return textResult({
    channel: "github",
    sanitized_title: sanitizedTitle,
    sanitized_body: composedBody,
    redactions,
    issue_url: issueUrl,
    gh_cli_command: ghCliCommand,
    next_step:
      "Show sanitized content and issue_url to the human. Nothing is published " +
      "until they open the URL (or run the gh command) and submit under their " +
      "own GitHub account. For code contributions, fork github.com/stella/stella " +
      "and open a PR (see CONTRIBUTING.md).",
  });
};

/** Best-effort reporter email for the private block; omitted on any failure. */
const resolveReporterEmail = async (
  context: McpRequestContext,
): Promise<string | undefined> => {
  const lookup = await Result.tryPromise({
    try: async () =>
      await context.scopedDb((tx) =>
        tx
          .select({ email: user.email })
          .from(user)
          .innerJoin(member, eq(member.userId, user.id))
          .where(
            and(
              eq(member.userId, context.userId),
              eq(member.organizationId, context.organizationId),
            ),
          )
          .limit(1),
      ),
    catch: (cause) => cause,
  });
  if (Result.isError(lookup)) {
    captureError(lookup.error, { source: "mcp", toolName: "send_feedback" });
    return undefined;
  }
  return lookup.value.at(0)?.email;
};

const handleSendFeedbackTool: McpToolHandler = async ({ args, context }) => {
  const parsed = v.safeParse(feedbackArgsSchema, args);
  if (!parsed.success) {
    return structuredErrorResult({
      code: "validation_error",
      message:
        parsed.issues.at(0)?.message ?? "Invalid send_feedback arguments",
      hint:
        `Provide kind (one of ${FEEDBACK_KINDS.join(", ")}), a non-empty title ` +
        `(<= ${MAX_FEEDBACK_TITLE_CHARS} chars), and a non-empty body ` +
        `(<= ${MAX_FEEDBACK_BODY_CHARS} chars).`,
    });
  }
  const { body, channel, confirmation_token, kind, title } = parsed.output;

  const sanitizedTitlePass = sanitizeFeedbackText(title);
  const sanitizedBodyPass = sanitizeFeedbackText(body);
  const sanitizedTitle = sanitizedTitlePass.text;
  const composedBody = composeFeedbackBody({
    body: sanitizedBodyPass.text,
    kind,
  });
  const approvedBody =
    channel === "stella" ? fitStellaIntakeBody(composedBody) : composedBody;
  const redactions =
    sanitizedTitlePass.redactions + sanitizedBodyPass.redactions;

  if (channel === "github") {
    return buildGithubFeedbackResult({
      composedBody,
      redactions,
      sanitizedTitle,
    });
  }

  // email and stella both require the two-phase handshake. Phase 1: no token
  // yet. Hand back a token bound to this exact sanitized content and stop.
  // Nothing is delivered until the human approves and the agent calls again
  // with the token. The token hash covers kind/title/body only, so it is
  // channel-agnostic and the same handshake gates both channels.
  if (confirmation_token === undefined) {
    const token = createFeedbackToken({
      kind,
      sanitizedTitle,
      sanitizedBody: approvedBody,
    });
    return textResult({
      channel,
      status: "approval_required",
      sanitized_title: sanitizedTitle,
      sanitized_body: approvedBody,
      redactions,
      confirmation_token: token,
      expires_in_minutes: FEEDBACK_TOKEN_TTL_MINUTES,
      next_step:
        "Display the sanitized content verbatim to the human and ask for " +
        "explicit approval. Only after they approve, call send_feedback again " +
        "with the same kind/title/body, this channel, and this " +
        "confirmation_token.",
    });
  }

  // Phase 2: the token must match the sanitized content the human approved. A
  // content or expiry tamper fails closed.
  if (
    !verifyFeedbackToken({
      token: confirmation_token,
      kind,
      sanitizedTitle,
      sanitizedBody: approvedBody,
    })
  ) {
    return structuredErrorResult({
      code: "validation_error",
      message: "Confirmation token is invalid or expired",
      hint:
        "Restart the handshake: call send_feedback with the same channel and no " +
        "confirmation_token, show the human the sanitized content, then retry " +
        "with the fresh token and the same kind/title/body.",
    });
  }

  // Phase-2 delivery rate limit: bound actual sends per organization. Only the
  // email and stella channels reach here (github returns above without any
  // server-side delivery, and phase-1 previews already returned), so this
  // counts deliveries, not previews.
  const withinDeliveryLimit = await feedbackIntakeGuards.consumeCounter({
    bucket: FEEDBACK_DELIVERY_BUCKET,
    key: context.organizationId,
    windowMs: FEEDBACK_DELIVERY_WINDOW_MS,
    max: FEEDBACK_DELIVERY_MAX_PER_ORG,
  });
  if (!withinDeliveryLimit) {
    return structuredErrorResult({
      code: "rate_limited",
      message: "Too many feedback deliveries from this organization",
      hint: `Up to ${FEEDBACK_DELIVERY_MAX_PER_ORG} feedback deliveries per hour per organization; try again later or use the github channel.`,
      retryable: true,
    });
  }

  const delivered =
    channel === "stella"
      ? await deliverViaStella({
          composedBody: approvedBody,
          kind,
          sanitizedTitle,
        })
      : await deliverViaEmail({
          composedBody: approvedBody,
          context,
          kind,
          sanitizedTitle,
        });
  if (delivered.isError) {
    await feedbackIntakeGuards.releaseCounter({
      bucket: FEEDBACK_DELIVERY_BUCKET,
      key: context.organizationId,
    });
  }
  return delivered;
};

const deliverViaEmail = async ({
  composedBody,
  context,
  kind,
  sanitizedTitle,
}: {
  composedBody: string;
  context: McpRequestContext;
  kind: FeedbackKind;
  sanitizedTitle: string;
}): Promise<CallToolResult> => {
  const feedbackEmailTo = env.FEEDBACK_EMAIL_TO;
  if (!feedbackEmailTo) {
    return structuredErrorResult({
      code: "feature_disabled",
      message: "Email feedback is not configured on this server",
      hint: 'Email feedback is not configured on this server; use channel "github" or "stella".',
    });
  }

  const reporterEmail = await resolveReporterEmail(context);
  const sent = await Result.tryPromise({
    try: async () =>
      await sendFeedbackEmail({
        to: feedbackEmailTo,
        kind,
        title: sanitizedTitle,
        body: composedBody,
        reporter: {
          via: "mcp",
          userId: context.userId,
          organizationId: context.organizationId,
          ...(reporterEmail === undefined ? {} : { reporterEmail }),
        },
      }),
    catch: (cause) => cause,
  });
  if (Result.isError(sent)) {
    captureError(sent.error, { source: "mcp", toolName: "send_feedback" });
    return structuredErrorResult({
      code: "internal_error",
      message: "Failed to send feedback email",
      hint: MCP_INTERNAL_ERROR_HINT,
      retryable: true,
    });
  }

  return textResult({
    channel: "email",
    status: "sent",
    next_step: "Tell the human their feedback was emailed to the maintainers.",
  });
};

/**
 * Forward approved, sanitized feedback to the hosted Stella intake. Used when
 * the human has no GitHub account and this server has no maintainer inbox: the
 * intake delivers on the maintainer's side (a GitHub issue or their own inbox).
 * Intake failures are mapped back onto the same structured error envelope so
 * the agent can branch on `code` exactly as it would for a local failure.
 */
const deliverViaStella = async ({
  composedBody,
  kind,
  sanitizedTitle,
}: {
  composedBody: string;
  kind: FeedbackKind;
  sanitizedTitle: string;
}): Promise<CallToolResult> => {
  const intakeUrl = env.FEEDBACK_INTAKE_URL;
  if (!intakeUrl) {
    return structuredErrorResult({
      code: "feature_disabled",
      message: "The stella feedback intake is not configured on this server",
      hint: 'No hosted intake URL is set; use channel "github" or "email".',
    });
  }

  const response = await Result.tryPromise({
    try: async () =>
      await fetch(intakeUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind,
          title: sanitizedTitle,
          body: composedBody,
          source: { instance: env.isDev ? "dev" : "self-hosted" },
        }),
        signal: AbortSignal.timeout(FEEDBACK_INTAKE_TIMEOUT_MS),
      }),
    catch: (cause) => cause,
  });
  if (Result.isError(response)) {
    captureError(response.error, { source: "mcp", toolName: "send_feedback" });
    return structuredErrorResult({
      code: "internal_error",
      message: "Could not reach the stella feedback intake",
      hint: MCP_INTERNAL_ERROR_HINT,
      retryable: true,
    });
  }

  return await mapIntakeResponse(response.value);
};

type IntakeSuccessBody = {
  delivered?: unknown;
  issueUrl?: unknown;
};

const mapIntakeResponse = async (
  response: Response,
): Promise<CallToolResult> => {
  if (response.status === 429) {
    return structuredErrorResult({
      code: "rate_limited",
      message: "The stella feedback intake is rate limiting submissions",
      hint: "Wait before retrying, or ask the human to file it on GitHub instead.",
      retryable: true,
    });
  }
  if (response.status === 409) {
    return structuredErrorResult({
      code: "validation_error",
      message: "This feedback was already forwarded to the stella intake",
      hint: "An identical report was submitted recently; no need to resend.",
    });
  }
  if (!response.ok) {
    return structuredErrorResult({
      code: "internal_error",
      message: "The stella feedback intake rejected the submission",
      hint: MCP_INTERNAL_ERROR_HINT,
      retryable: true,
    });
  }

  const parsed = await Result.tryPromise({
    try: async () => (await response.json()) as IntakeSuccessBody,
    catch: (cause) => cause,
  });
  const delivered =
    Result.isOk(parsed) && typeof parsed.value.delivered === "string"
      ? parsed.value.delivered
      : "forwarded";
  const issueUrl =
    Result.isOk(parsed) && typeof parsed.value.issueUrl === "string"
      ? parsed.value.issueUrl
      : undefined;

  return textResult({
    channel: "stella",
    status: "sent",
    delivered,
    ...(issueUrl === undefined ? {} : { issue_url: issueUrl }),
    next_step:
      "Tell the human their feedback was forwarded to the stella maintainers.",
  });
};

export const FEEDBACK_TOOL_HANDLERS = {
  send_feedback: handleSendFeedbackTool,
} satisfies Record<"send_feedback", McpToolHandler>;
