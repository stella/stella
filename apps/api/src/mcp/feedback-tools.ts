/**
 * The two-step feedback contract: `prepare_feedback` sanitizes a draft and
 * hands it back for a human to read, `submit_feedback` files the same object
 * once they approve it.
 *
 * The split exists because the human approval is the real control on what
 * leaves the workspace. A one-call tool would have the model deciding, alone,
 * that a paragraph of matter text is safe to publish. `prepare_feedback`
 * returns the report in exactly the shape `submit_feedback` accepts, so the
 * approved bytes and the submitted bytes are the same bytes.
 */

import { Result } from "better-result";
import * as v from "valibot";

import {
  FEEDBACK_AREAS,
  FEEDBACK_CLIENTS,
  FEEDBACK_KINDS,
  FEEDBACK_LIMITS,
} from "@stll/api-contract/feedback";
import type {
  FeedbackReportContext,
  FeedbackReportInput,
} from "@stll/api-contract/feedback";

import { feedbackIntakeGuards } from "@/api/handlers/feedback/intake-guards";
import { submitFeedbackReport } from "@/api/handlers/feedback/submit";
import {
  FEEDBACK_REQUEST_ID_PATTERN,
  sanitizeFeedbackReport,
} from "@/api/lib/feedback/sanitize-report";
import type { SanitizableFeedbackField } from "@/api/lib/feedback/sanitize-report";
import type { McpToolDefinition, McpToolHandler } from "@/api/mcp/tool-types";
import { defineMcpToolSet } from "@/api/mcp/tool-types";
import {
  internalFailureResult,
  nullAsAbsent,
  structuredErrorResult,
  toolDataResult,
  validationErrorResult,
} from "@/api/mcp/tool-utils";
import {
  defineMcpToolOutput,
  defineValibotMcpTool,
} from "@/api/mcp/valibot-tool-definition";

/** Per-organization delivery budget: feedback is a trickle, not a stream. */
export const SUBMIT_RATE_LIMIT_MAX_PER_ORG = 20;
const SUBMIT_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const SUBMIT_RATE_LIMIT_BUCKET = "feedback:org";

const capped = (description: string, max: number) =>
  v.pipe(v.string(), v.maxLength(max), v.description(description));

const contextArgsSchema = v.strictObject({
  client: v.optional(
    v.pipe(
      v.picklist(FEEDBACK_CLIENTS),
      v.description("Which client you are driving stella from."),
    ),
  ),
  client_version: v.optional(
    capped("Version string of that client.", FEEDBACK_LIMITS.contextField),
  ),
  request_id: v.optional(
    v.pipe(
      v.string(),
      v.regex(
        FEEDBACK_REQUEST_ID_PATTERN,
        "request_id may contain letters, digits, dot, underscore and hyphen only",
      ),
      v.description(
        "The requestId a failing tool returned in its error envelope. Kept " +
          "verbatim (it is the only field that is not redacted) because it is " +
          "how a maintainer finds the failing call in the server logs.",
      ),
    ),
  ),
  route: v.optional(
    capped(
      "Tool name, CLI command or page the problem appeared on.",
      FEEDBACK_LIMITS.contextField,
    ),
  ),
  error_reference: v.optional(
    capped(
      "Error code from the envelope, if the call returned one.",
      FEEDBACK_LIMITS.contextField,
    ),
  ),
});

const reportProperties = {
  kind: v.pipe(
    v.picklist(FEEDBACK_KINDS),
    v.description(
      "bug (it behaved wrongly), idea (it could be better), " +
        "missing_capability (there is no way to do this), docs (the " +
        "reference or description is wrong or missing).",
    ),
  ),
  area: v.pipe(
    v.picklist(FEEDBACK_AREAS),
    v.description("Which part of stella the report is about."),
  ),
  title: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1),
    v.maxLength(FEEDBACK_LIMITS.title),
    v.description("One line naming the problem, not the symptom's location."),
  ),
  what_happened: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(FEEDBACK_LIMITS.whatHappened),
    v.description("What stella actually did."),
  ),
  expected: v.optional(
    capped("What you expected instead.", FEEDBACK_LIMITS.expected),
  ),
  steps: v.optional(
    capped(
      "Numbered steps that reproduce it, in terms of tool calls.",
      FEEDBACK_LIMITS.steps,
    ),
  ),
  evidence: v.optional(
    capped(
      "The error envelope, the refused input, or the wrong output, verbatim " +
        "but without tenant content.",
      FEEDBACK_LIMITS.evidence,
    ),
  ),
  context: v.optional(
    v.pipe(
      contextArgsSchema,
      v.description(
        "Where the problem appeared, so a maintainer can find the call.",
      ),
    ),
  ),
} as const;

const prepareArgsSchema = nullAsAbsent(v.strictObject(reportProperties));

const submitArgsSchema = nullAsAbsent(
  v.strictObject({
    ...reportProperties,
    confirm: v.optional(
      v.pipe(
        v.boolean(),
        v.description(
          "Must be true to send the report. Set it only after a human user " +
            "has read the prepared report and approved sending it.",
        ),
      ),
    ),
  }),
);

type PrepareArgs = v.InferOutput<typeof prepareArgsSchema>;

const REPORT_WIRE_SCHEMA = v.strictObject({
  kind: v.picklist(FEEDBACK_KINDS),
  area: v.picklist(FEEDBACK_AREAS),
  title: v.string(),
  what_happened: v.string(),
  expected: v.optional(v.string()),
  steps: v.optional(v.string()),
  evidence: v.optional(v.string()),
  context: v.optional(
    v.strictObject({
      client: v.optional(v.picklist(FEEDBACK_CLIENTS)),
      client_version: v.optional(v.string()),
      request_id: v.optional(v.string()),
      route: v.optional(v.string()),
      error_reference: v.optional(v.string()),
    }),
  ),
});

const PREPARE_FEEDBACK_OUTPUT_SCHEMA = v.strictObject({
  report: REPORT_WIRE_SCHEMA,
  redactions: v.pipe(v.number(), v.integer()),
  redacted_fields: v.array(v.string()),
  next_step: v.string(),
});

const SUBMIT_FEEDBACK_OUTPUT_SCHEMA = v.strictObject({
  receipt: v.string(),
  redactions: v.pipe(v.number(), v.integer()),
  deduplicated: v.boolean(),
  deliveries: v.array(
    v.strictObject({
      channel: v.picklist(["email", "github"]),
      status: v.picklist(["delivered", "failed"]),
      url: v.optional(v.string()),
    }),
  ),
  stored: v.literal(true),
  warning: v.optional(v.string()),
  next_step: v.string(),
});

/**
 * The MCP spelling of every field the redaction passes can touch. Total over
 * the sanitizer's own field union, so a new sanitized field cannot be reported
 * to an agent under a name its input schema does not have.
 */
const MCP_FIELD_NAME = {
  title: "title",
  whatHappened: "what_happened",
  expected: "expected",
  steps: "steps",
  evidence: "evidence",
  "context.clientVersion": "context.client_version",
  "context.route": "context.route",
  "context.errorReference": "context.error_reference",
} as const satisfies Record<SanitizableFeedbackField, string>;

const toReportInput = (args: PrepareArgs): FeedbackReportInput => {
  const report: FeedbackReportInput = {
    kind: args.kind,
    area: args.area,
    title: args.title,
    whatHappened: args.what_happened,
  };
  if (args.expected !== undefined) {
    report.expected = args.expected;
  }
  if (args.steps !== undefined) {
    report.steps = args.steps;
  }
  if (args.evidence !== undefined) {
    report.evidence = args.evidence;
  }
  const context = toReportContext(args.context);
  if (context !== undefined) {
    report.context = context;
  }
  return report;
};

const toReportContext = (
  context: PrepareArgs["context"],
): FeedbackReportContext | undefined => {
  if (context === undefined) {
    return undefined;
  }
  const mapped: FeedbackReportContext = {};
  if (context.client !== undefined) {
    mapped.client = context.client;
  }
  if (context.client_version !== undefined) {
    mapped.clientVersion = context.client_version;
  }
  if (context.request_id !== undefined) {
    mapped.requestId = context.request_id;
  }
  if (context.route !== undefined) {
    mapped.route = context.route;
  }
  if (context.error_reference !== undefined) {
    mapped.errorReference = context.error_reference;
  }
  return Object.keys(mapped).length === 0 ? undefined : mapped;
};

const toWireReport = (
  report: FeedbackReportInput,
): v.InferInput<typeof REPORT_WIRE_SCHEMA> => ({
  kind: report.kind,
  area: report.area,
  title: report.title,
  what_happened: report.whatHappened,
  ...(report.expected === undefined ? {} : { expected: report.expected }),
  ...(report.steps === undefined ? {} : { steps: report.steps }),
  ...(report.evidence === undefined ? {} : { evidence: report.evidence }),
  ...(report.context === undefined
    ? {}
    : { context: toWireContext(report.context) }),
});

const toWireContext = (context: FeedbackReportContext) => ({
  ...(context.client === undefined ? {} : { client: context.client }),
  ...(context.clientVersion === undefined
    ? {}
    : { client_version: context.clientVersion }),
  ...(context.requestId === undefined ? {} : { request_id: context.requestId }),
  ...(context.route === undefined ? {} : { route: context.route }),
  ...(context.errorReference === undefined
    ? {}
    : { error_reference: context.errorReference }),
});

const REDACTION_SUMMARY =
  "emails, UUIDs and ULIDs, secret-looking tokens, non-allowlisted URLs and " +
  "IP addresses are redacted server-side";

const DRAFTING_RULES =
  "Describe the problem, then what you expected against what happened, then " +
  "the steps. Refer to people by role, never by name. Never paste document " +
  "text, matter or client names, or ids. Put the requestId of a failed call " +
  "in context.request_id.";

export const FEEDBACK_TOOL_DEFINITIONS = [
  defineValibotMcpTool({
    description:
      "Draft a bug, idea, missing-capability or docs report for the stella " +
      "maintainers and get it back sanitized. Sends nothing: " +
      `${REDACTION_SUMMARY}, and the result is the report for you to show ` +
      "the human verbatim. Once they approve it, call submit_feedback with " +
      `that same report and confirm: true. ${DRAFTING_RULES} The reporter's ` +
      "identity is stored privately and is never published.",
    inputSchema: prepareArgsSchema,
    jsonSchemaProjectionWaiver: {
      ignoreActions: ["trim"],
      reason:
        "Trimming is server-side normalization, not a constraint a client can express.",
    },
    annotations: {
      title: "Prepare feedback",
      destructiveHint: false,
      openWorldHint: false,
      readOnlyHint: true,
    },
    access: "read",
    anonymized: { exposure: "excluded", reason: "dynamic_tenant_payload" },
    name: "prepare_feedback",
    scope: "stella:feedback",
  }),
  defineValibotMcpTool({
    description:
      "File the report prepared by prepare_feedback with the stella " +
      "maintainers. This sends the content out of the workspace: it is " +
      "stored, emailed to the maintainers, and may be posted as a public " +
      `issue, so it is refused without confirm: true. ${REDACTION_SUMMARY} ` +
      "again here, and the reporter's identity is stored privately and never " +
      "published. Returns a receipt to give the human. Re-sending identical " +
      "content within a day returns the original receipt and sends nothing.",
    inputSchema: submitArgsSchema,
    jsonSchemaProjectionWaiver: {
      ignoreActions: ["trim"],
      reason:
        "Trimming is server-side normalization, not a constraint a client can express.",
    },
    annotations: {
      title: "Submit feedback",
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
    },
    access: "write",
    anonymized: { exposure: "excluded", reason: "write" },
    destructiveBehavior: {
      type: "outbound",
      reason:
        "submit_feedback sends this report to the stella maintainers and may publish it as an issue.",
    },
    name: "submit_feedback",
    scope: "stella:feedback",
  }),
] as const satisfies readonly McpToolDefinition[];

const VALIDATION_HINT =
  `Provide kind (${FEEDBACK_KINDS.join(", ")}), area ` +
  `(${FEEDBACK_AREAS.join(", ")}), a title (<= ${FEEDBACK_LIMITS.title} ` +
  `chars) and what_happened (<= ${FEEDBACK_LIMITS.whatHappened} chars).`;

const handlePrepareFeedbackTool: McpToolHandler<
  v.InferInput<typeof PREPARE_FEEDBACK_OUTPUT_SCHEMA>
> = ({ args }) => {
  const parsed = v.safeParse(prepareArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues, VALIDATION_HINT);
  }

  const { redactedFields, redactions, report } = sanitizeFeedbackReport(
    toReportInput(parsed.output),
  );

  return toolDataResult({
    report: toWireReport(report),
    redactions,
    redacted_fields: redactedFields.map((field) => MCP_FIELD_NAME[field]),
    next_step:
      "Show this report to the human verbatim and ask whether to send it. " +
      "Only once they approve, call submit_feedback with exactly this " +
      "report plus confirm: true. Nothing has been sent or stored yet.",
  });
};

const handleSubmitFeedbackTool: McpToolHandler<
  v.InferInput<typeof SUBMIT_FEEDBACK_OUTPUT_SCHEMA>
> = async ({ args, context }) => {
  const parsed = v.safeParse(submitArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues, VALIDATION_HINT);
  }

  const withinRate = await feedbackIntakeGuards.consumeCounter({
    bucket: SUBMIT_RATE_LIMIT_BUCKET,
    key: context.organizationId,
    windowMs: SUBMIT_RATE_LIMIT_WINDOW_MS,
    max: SUBMIT_RATE_LIMIT_MAX_PER_ORG,
  });
  if (!withinRate) {
    return structuredErrorResult({
      code: "rate_limited",
      message: "This organization has filed too many reports this hour",
      hint: `Up to ${SUBMIT_RATE_LIMIT_MAX_PER_ORG} reports per hour are accepted; tell the human and try again later.`,
      retryable: true,
    });
  }

  const submitted = await submitFeedbackReport({
    input: toReportInput(parsed.output),
    reporter: {
      via: "mcp",
      userId: context.userId,
      organizationId: context.organizationId,
    },
  });
  if (Result.isError(submitted)) {
    return internalFailureResult(submitted.error);
  }

  const { deduplicated, deliveries, receipt, redactions, warning } =
    submitted.value;
  return toolDataResult({
    receipt,
    redactions,
    deduplicated,
    deliveries,
    stored: true,
    ...(warning === undefined ? {} : { warning }),
    next_step: deduplicated
      ? `Tell the human this report was already filed as ${receipt}; nothing was sent again.`
      : `Tell the human the report is filed as ${receipt} and give them that receipt.`,
  });
};

export const FEEDBACK_TOOL_HANDLERS = {
  prepare_feedback: handlePrepareFeedbackTool,
  submit_feedback: handleSubmitFeedbackTool,
} satisfies Record<"prepare_feedback" | "submit_feedback", McpToolHandler>;

export const FEEDBACK_TOOL_SET = defineMcpToolSet(
  FEEDBACK_TOOL_DEFINITIONS,
  FEEDBACK_TOOL_HANDLERS,
  {
    prepare_feedback: defineMcpToolOutput(PREPARE_FEEDBACK_OUTPUT_SCHEMA),
    submit_feedback: defineMcpToolOutput(SUBMIT_FEEDBACK_OUTPUT_SCHEMA),
  },
);
