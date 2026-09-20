/**
 * Public feedback intake receiver (`POST /public/feedback`).
 *
 * Unauthenticated by design: the caller may have no Stella account and no
 * email, which is the whole reason the intake exists. Identity is therefore
 * not the protection; abuse bounding is:
 *   - a coarse raw-string cap at the route plus a strict Valibot
 *     `strictObject` here, rejecting unknown keys and oversize fields;
 *   - a per-IP rate limit (`intake-guards.ts`), so a bot cannot flood the
 *     maintainer inbox;
 *   - the shared submit service, which sanitizes every field again (the
 *     caller's own pass is never trusted) and deduplicates identical content
 *     against the stored reports.
 *
 * The route hands us the raw body string (Elysia `parse: "text"`) rather than
 * a pre-validated object: Elysia's normalizer strips unknown keys before a
 * handler sees them, so a strict "reject anything else" contract must run on
 * the raw payload here, the same shape as the hosted-usage webhook receiver.
 *
 * All error bodies use the MCP `{ error: { code, message, hint } }` envelope
 * (codes from `McpErrorCode`) so a forwarding tool can branch on HTTP status
 * and the CLI can reuse its exit-code mapping.
 */

import { Result } from "better-result";
import * as v from "valibot";

import {
  FEEDBACK_AREAS,
  FEEDBACK_CLIENTS,
  FEEDBACK_KINDS,
  FEEDBACK_LIMITS,
} from "@stll/api-contract/feedback";
import type { FeedbackReportInput } from "@stll/api-contract/feedback";

import {
  type FeedbackIntakeGuards,
  feedbackIntakeGuards,
} from "@/api/handlers/feedback/intake-guards";
import { FEEDBACK_REQUEST_ID_PATTERN } from "@/api/handlers/feedback/sanitize-report";
import { submitFeedbackReport } from "@/api/handlers/feedback/submit";
import type { SubmitFeedbackDependencies } from "@/api/handlers/feedback/submit";
import type { McpErrorCode } from "@/api/mcp/error-codes";

// Coarse raw-body string cap enforced at the route before JSON parsing: bounds
// an unauthenticated write independently of the per-field caps below. Sized so
// a valid maximum-length report still fits after JSON escaping: the worst case
// is a control character, which JSON.stringify expands to six characters
// (`\u0000`), over every capped field plus the object's own keys and
// punctuation. `intake.test.ts` computes that worst case from FEEDBACK_LIMITS
// and asserts it fits, so shrinking a cap here cannot start refusing a report
// the schema accepts.
export const MAX_RAW_FEEDBACK_BODY_CHARS = 96_000;

// Per-IP submission budget. Deliberately small: a human filing feedback sends a
// handful at most; anything above this is a bot.
const RATE_LIMIT_MAX_PER_IP = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const UNKNOWN_IP_KEY = "unknown";

const optionalCapped = (max: number) =>
  v.optional(v.pipe(v.string(), v.maxLength(max)));

const contextSchema = v.strictObject({
  client: v.optional(v.picklist(FEEDBACK_CLIENTS)),
  clientVersion: optionalCapped(FEEDBACK_LIMITS.contextField),
  requestId: v.optional(
    v.pipe(v.string(), v.regex(FEEDBACK_REQUEST_ID_PATTERN)),
  ),
  route: optionalCapped(FEEDBACK_LIMITS.contextField),
  errorReference: optionalCapped(FEEDBACK_LIMITS.contextField),
});

/**
 * Strict request contract. `v.strictObject` rejects any key the schema does
 * not name (top level and inside `context`); the per-field caps bound each
 * string.
 */
const publicFeedbackBodySchema = v.strictObject({
  kind: v.picklist(FEEDBACK_KINDS),
  area: v.picklist(FEEDBACK_AREAS),
  title: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1),
    v.maxLength(FEEDBACK_LIMITS.title),
  ),
  whatHappened: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(FEEDBACK_LIMITS.whatHappened),
  ),
  expected: optionalCapped(FEEDBACK_LIMITS.expected),
  steps: optionalCapped(FEEDBACK_LIMITS.steps),
  evidence: optionalCapped(FEEDBACK_LIMITS.evidence),
  context: v.optional(contextSchema),
  /** Self-reported deployment name, for a maintainer triaging self-hosts. */
  instance: optionalCapped(FEEDBACK_LIMITS.contextField),
});

type PublicFeedbackBody = v.InferOutput<typeof publicFeedbackBodySchema>;

type IntakeDeps = {
  guards?: FeedbackIntakeGuards;
  submit?: typeof submitFeedbackReport;
  submitDeps?: Partial<SubmitFeedbackDependencies>;
  skipRateLimit?: boolean | undefined;
};

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

const VALIDATION_HINT =
  `Provide kind (${FEEDBACK_KINDS.join(", ")}), area ` +
  `(${FEEDBACK_AREAS.join(", ")}), a title (1..${FEEDBACK_LIMITS.title} ` +
  `chars), whatHappened (1..${FEEDBACK_LIMITS.whatHappened} chars), and only ` +
  "those keys plus optional expected, steps, evidence, context and instance.";

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
        "Send a JSON object with kind, area, title and whatHappened.",
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
        VALIDATION_HINT,
      ),
    };
  }
  return { ok: true, body: parsed.output };
};

/**
 * The validated body carries one extra key (`instance`) beyond the shared
 * report shape, so the report is rebuilt field by field rather than spread:
 * a spread would carry `instance` into the report the service stores.
 */
const toReportInput = (body: PublicFeedbackBody): FeedbackReportInput => {
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
  const context = toReportContext(body.context);
  if (context !== undefined) {
    report.context = context;
  }
  return report;
};

/**
 * Rebuilt key by key rather than assigned: with `exactOptionalPropertyTypes`,
 * a valibot optional is `T | undefined`, and assigning the parsed object whole
 * would put explicit `undefined` values into a shape whose optionals mean
 * absent.
 */
const toReportContext = (
  context: PublicFeedbackBody["context"],
): FeedbackReportInput["context"] => {
  if (context === undefined) {
    return undefined;
  }
  const mapped: NonNullable<FeedbackReportInput["context"]> = {};
  if (context.client !== undefined) {
    mapped.client = context.client;
  }
  if (context.clientVersion !== undefined) {
    mapped.clientVersion = context.clientVersion;
  }
  if (context.requestId !== undefined) {
    mapped.requestId = context.requestId;
  }
  if (context.route !== undefined) {
    mapped.route = context.route;
  }
  if (context.errorReference !== undefined) {
    mapped.errorReference = context.errorReference;
  }
  return Object.keys(mapped).length === 0 ? undefined : mapped;
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

  if (deps?.skipRateLimit !== true) {
    const guards = deps?.guards ?? feedbackIntakeGuards;
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
  }

  const submit = deps?.submit ?? submitFeedbackReport;
  const submitted = await submit({
    input: toReportInput(body),
    reporter: { via: "intake" },
    instance: body.instance,
    ...(deps?.submitDeps === undefined ? {} : { deps: deps.submitDeps }),
  });
  if (Result.isError(submitted)) {
    return errorResponse(
      503,
      "internal_error",
      "Could not record the feedback report",
      "Try again later.",
    );
  }

  return jsonResponse(200, submitted.value);
};
