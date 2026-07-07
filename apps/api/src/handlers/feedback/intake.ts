/**
 * Public feedback intake receiver (`POST /public/feedback`).
 *
 * The upstream half of the agent feedback path: a self-hosted Stella (or the
 * MCP `send_feedback` "stella" channel) forwards approved, already-sanitized
 * feedback here, and this endpoint delivers it to the maintainer inbox
 * (`FEEDBACK_EMAIL_TO`) when configured, otherwise a `feature_disabled` refusal.
 * Delivery is email-only: public issues are filed exclusively through the
 * github channel of `send_feedback`, where the human submits under their own
 * GitHub account, so the intake never holds a GitHub token.
 *
 * Security model: unauthenticated by design (the caller may have no account and
 * no email), so the protection is entirely abuse bounding, not identity:
 *   - title/body are re-sanitized here, never trusting the caller's pass;
 *   - per-IP rate limit + content dedup (`intake-guards.ts`), so a bot cannot
 *     flood the maintainer inbox;
 *   - a coarse raw-size cap at the route plus a strict Valibot `strictObject`
 *     here (rejecting unknown keys and oversize), and nothing is ever rendered
 *     as HTML.
 *
 * The route hands us the raw body string (Elysia `parse: "text"`) rather than a
 * pre-validated object: Elysia's normalizer strips unknown keys before a
 * handler sees them, so a strict "reject anything else" contract must run on the
 * raw payload here — the same shape as the hosted-usage webhook receiver.
 *
 * All error bodies use the MCP `{ error: { code, message, hint } }` envelope
 * (codes from `McpErrorCode`) so the forwarding tool can branch on HTTP status
 * and the CLI can reuse its exit-code mapping.
 */

import { Result } from "better-result";
import * as v from "valibot";

import { env } from "@/api/env";
import {
  type FeedbackIntakeGuards,
  feedbackIntakeGuards,
} from "@/api/handlers/feedback/intake-guards";
import { captureError } from "@/api/lib/analytics";
import {
  isTransactionalEmailConfigured,
  sendFeedbackEmail,
} from "@/api/lib/email";
import type { McpErrorCode } from "@/api/mcp/error-codes";
import { sanitizeFeedbackText } from "@/api/mcp/feedback-sanitize";

const FEEDBACK_KINDS = ["bug", "feature_request", "docs", "other"] as const;

const MAX_TITLE_CHARS = 200;
const MAX_BODY_CHARS = 8000;
const MAX_SOURCE_FIELD_CHARS = 40;

// Coarse raw-body cap enforced at the route before any parsing: bounds an
// unauthenticated write independently of the per-field caps below. Sized for an
// 8000-char body plus title, source, and JSON overhead.
export const MAX_RAW_FEEDBACK_BODY_BYTES = 16_384;

// Per-IP submission budget. Deliberately small: a human filing feedback sends a
// handful at most; anything above this is a bot.
const RATE_LIMIT_MAX_PER_IP = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const UNKNOWN_IP_KEY = "unknown";

// Content dedup window: an identical report inside a day is a resend, not new
// signal.
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;

const INTAKE_FOOTER =
  "---\n_Received via the stella feedback intake (agent-assisted, sanitized server-side)._";

/**
 * Strict request contract. `v.strictObject` rejects any key the schema does not
 * name (top-level and inside `source`); the per-field caps bound each string.
 */
const feedbackSourceSchema = v.strictObject({
  instance: v.optional(v.pipe(v.string(), v.maxLength(MAX_SOURCE_FIELD_CHARS))),
  version: v.optional(v.pipe(v.string(), v.maxLength(MAX_SOURCE_FIELD_CHARS))),
});

const publicFeedbackBodySchema = v.strictObject({
  kind: v.picklist(FEEDBACK_KINDS),
  title: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1),
    v.maxLength(MAX_TITLE_CHARS),
  ),
  body: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_BODY_CHARS)),
  source: v.optional(feedbackSourceSchema),
});

export type PublicFeedbackBody = v.InferOutput<typeof publicFeedbackBodySchema>;
type FeedbackSource = NonNullable<PublicFeedbackBody["source"]>;

type IntakeDeps = {
  guards?: FeedbackIntakeGuards;
  /** Delivery config; defaults to env. Present-but-undefined means "not configured". */
  emailTo?: string | undefined;
};

type DeliveryOutcome = { ok: boolean; response: Response };

const jsonResponse = (status: number, data: unknown): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

const errorResponse = (
  status: number,
  code: McpErrorCode,
  message: string,
  hint: string,
): Response => jsonResponse(status, { error: { code, message, hint } });

/** Parse and strictly validate the raw request body, or return an error Response. */
const parseFeedbackBody = (
  rawBody: string,
):
  | { ok: true; body: PublicFeedbackBody }
  | { ok: false; response: Response } => {
  const decoded = Result.try({
    try: (): unknown => JSON.parse(rawBody),
    catch: (cause) => cause,
  });
  if (Result.isError(decoded)) {
    return {
      ok: false,
      response: errorResponse(
        400,
        "validation_error",
        "Malformed JSON body",
        "Send a JSON object with kind, title, and body.",
      ),
    };
  }
  const parsed = v.safeParse(publicFeedbackBodySchema, decoded.value);
  if (!parsed.success) {
    return {
      ok: false,
      response: errorResponse(
        422,
        "validation_error",
        parsed.issues.at(0)?.message ?? "Invalid feedback payload",
        `Provide kind (${FEEDBACK_KINDS.join(", ")}), a title (1..${MAX_TITLE_CHARS} chars), a body (1..${MAX_BODY_CHARS} chars), and only those keys plus an optional source.`,
      ),
    };
  }
  return { ok: true, body: parsed.output };
};

/** SHA-256 of the sanitized content used as the dedup identity. */
const contentDedupKey = ({
  body,
  kind,
  title,
}: {
  body: string;
  kind: string;
  title: string;
}): string =>
  new Bun.CryptoHasher("sha256")
    .update(JSON.stringify({ body, kind, title }))
    .digest("hex");

const truncateSourceField = (value: string): string =>
  Array.from(value).slice(0, MAX_SOURCE_FIELD_CHARS).join("");

const sanitizeSourceField = (value: string | undefined): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const sanitized = truncateSourceField(
    sanitizeFeedbackText(value).text.trim(),
  );
  return sanitized.length === 0 ? undefined : sanitized;
};

const sanitizeSource = (
  source: FeedbackSource | undefined,
): FeedbackSource | undefined => {
  if (source === undefined) {
    return undefined;
  }
  const instance = sanitizeSourceField(source.instance);
  const version = sanitizeSourceField(source.version);
  if (instance === undefined && version === undefined) {
    return undefined;
  }
  const sanitized: FeedbackSource = {};
  if (instance !== undefined) {
    sanitized.instance = instance;
  }
  if (version !== undefined) {
    sanitized.version = version;
  }
  return sanitized;
};

const composeDeliveryBody = (
  sanitizedBody: string,
  source: FeedbackSource | undefined,
): string => {
  const sourceLine =
    source === undefined
      ? ""
      : `\n_Source: instance=${source.instance ?? "unknown"}, version=${source.version ?? "unknown"}._`;
  return `${sanitizedBody}\n\n${INTAKE_FOOTER}${sourceLine}`;
};

const deliverViaEmail = async ({
  composedBody,
  kind,
  source,
  title,
  to,
}: {
  composedBody: string;
  kind: PublicFeedbackBody["kind"];
  source: FeedbackSource | undefined;
  title: string;
  to: string;
}): Promise<DeliveryOutcome> => {
  const sent = await Result.tryPromise({
    try: async () =>
      await sendFeedbackEmail({
        to,
        kind,
        title,
        body: composedBody,
        reporter: {
          via: "intake",
          ...(source?.instance === undefined
            ? {}
            : { instance: source.instance }),
          ...(source?.version === undefined ? {} : { version: source.version }),
        },
      }),
    catch: (cause) => cause,
  });
  if (Result.isError(sent)) {
    captureError(sent.error, { source: "feedback-intake" });
    return {
      ok: false,
      response: errorResponse(
        502,
        "internal_error",
        "Could not send the feedback email",
        "Try again later.",
      ),
    };
  }
  return { ok: true, response: jsonResponse(200, { delivered: "email" }) };
};

const deliver = async ({
  composedBody,
  emailTo,
  kind,
  source,
  title,
}: {
  composedBody: string;
  emailTo: string | undefined;
  kind: PublicFeedbackBody["kind"];
  source: FeedbackSource | undefined;
  title: string;
}): Promise<DeliveryOutcome> => {
  if (emailTo) {
    if (!isTransactionalEmailConfigured()) {
      return {
        ok: false,
        response: errorResponse(
          503,
          "feature_disabled",
          "Feedback email transport is not configured on this server",
          "Configure EMAIL_PROVIDER, TRANSACTIONAL_EMAIL_FROM, and provider settings.",
        ),
      };
    }

    return await deliverViaEmail({
      composedBody,
      kind,
      source,
      title,
      to: emailTo,
    });
  }

  return {
    ok: false,
    response: errorResponse(
      503,
      "feature_disabled",
      "Feedback intake is not configured on this server",
      "No delivery channel is set: configure FEEDBACK_EMAIL_TO.",
    ),
  };
};

export const receivePublicFeedback = async ({
  clientIp,
  deps,
  rawBody,
}: {
  clientIp: string | null;
  deps?: IntakeDeps;
  rawBody: string;
}): Promise<Response> => {
  const parsed = parseFeedbackBody(rawBody);
  if (!parsed.ok) {
    return parsed.response;
  }
  const { body } = parsed;

  const guards = deps?.guards ?? feedbackIntakeGuards;
  const emailTo =
    deps && "emailTo" in deps ? deps.emailTo : env.FEEDBACK_EMAIL_TO;

  // Never trust the caller's sanitization: re-run it on both fields.
  const sanitizedTitle = sanitizeFeedbackText(body.title).text;
  const sanitizedBody = sanitizeFeedbackText(body.body).text;
  const sanitizedSource = sanitizeSource(body.source);

  const withinRate = await guards.consumeCounter({
    bucket: "ip",
    key: clientIp ?? UNKNOWN_IP_KEY,
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: RATE_LIMIT_MAX_PER_IP,
  });
  if (!withinRate) {
    return errorResponse(
      429,
      "rate_limited",
      "Too many feedback submissions from this address",
      `Up to ${RATE_LIMIT_MAX_PER_IP} submissions per hour are accepted; try again later.`,
    );
  }

  const dedupKey = contentDedupKey({
    body: sanitizedBody,
    kind: body.kind,
    title: sanitizedTitle,
  });
  const claimed = await guards.claimDedup({
    key: dedupKey,
    ttlMs: DEDUP_TTL_MS,
  });
  if (!claimed) {
    return errorResponse(
      409,
      "validation_error",
      "This feedback was already received recently",
      "An identical report was submitted in the last day; no need to resend.",
    );
  }

  const outcome = await deliver({
    composedBody: composeDeliveryBody(sanitizedBody, sanitizedSource),
    emailTo,
    kind: body.kind,
    source: sanitizedSource,
    title: sanitizedTitle,
  });

  // A failed delivery must not lock out a legitimate retry for the dedup window.
  if (!outcome.ok) {
    await guards.releaseDedup({ key: dedupKey });
  }
  return outcome.response;
};
