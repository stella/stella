/**
 * End-to-end procedure for reporting a stella bug or gap from the agent
 * surface. The two tool descriptions say what each call takes; neither says
 * when a report is worth filing, what must never go into one, or that the
 * human has to see the sanitized text before it is sent. An agent that has
 * only the tool list discovers that order by trial, so it is written here.
 *
 * Every tool this document names is typed as {@link McpToolName}, so a rename
 * or removal in the registry is a compile error here rather than prose that
 * points at a tool that no longer exists. Every number is rendered from
 * `FEEDBACK_LIMITS`, and every value list from its own constant, so the
 * reference cannot promise a cap the schema does not enforce.
 */

import {
  FEEDBACK_AREAS,
  FEEDBACK_CLIENTS,
  FEEDBACK_KINDS,
  FEEDBACK_LIMITS,
} from "@stll/api-contract/feedback";

import type { McpToolName } from "@/api/lib/api-handlers";
import { SUBMIT_RATE_LIMIT_MAX_PER_ORG } from "@/api/mcp/feedback-tools";

/**
 * Canonical URI of the workflow resource. Owned here with the text it
 * addresses, so the resource registry and the server instructions that point
 * agents at it cannot drift apart.
 */
export const FEEDBACK_WORKFLOW_REFERENCE_URI =
  "stella://reference/feedback-workflow";

const TOOL = {
  prepareFeedback: "prepare_feedback",
  submitFeedback: "submit_feedback",
} as const satisfies Record<string, McpToolName>;

export const FEEDBACK_WORKFLOW_TOOL_NAMES = Object.values(TOOL);

const { prepareFeedback: PREPARE, submitFeedback: SUBMIT } = TOOL;

const WHEN_TO_REPORT = [
  "A stella tool fails the same way twice and the error's hint did not fix it.",
  "There is no tool or argument for what the human asked for.",
  "A call succeeded but the result is wrong: a missing document, a wrong count, a citation that does not exist.",
  "The human says stella got something wrong.",
] as const;

const NEVER_INCLUDE = [
  "Document text, clause wording, or any extract from a matter.",
  'Matter, client, counterparty or person names. Say the role instead: "the client", "opposing counsel".',
  "Ids of any kind: matter, document, entity, contact. The server redacts what it recognises, but a report that needed an id to be understood was written wrong.",
  "Credentials, tokens, cookies, or an Authorization header.",
] as const;

const FIELDS = [
  { name: "kind", detail: `one of ${FEEDBACK_KINDS.join(", ")}` },
  { name: "area", detail: `one of ${FEEDBACK_AREAS.join(", ")}` },
  {
    name: "title",
    detail: `one line naming the problem, at most ${FEEDBACK_LIMITS.title} characters`,
  },
  {
    name: "what_happened",
    detail: `what stella actually did, at most ${FEEDBACK_LIMITS.whatHappened} characters`,
  },
  {
    name: "expected",
    detail: `optional; what you expected instead, at most ${FEEDBACK_LIMITS.expected} characters`,
  },
  {
    name: "steps",
    detail: `optional; numbered tool calls that reproduce it, at most ${FEEDBACK_LIMITS.steps} characters`,
  },
  {
    name: "evidence",
    detail: `optional; the error envelope or refused input verbatim, at most ${FEEDBACK_LIMITS.evidence} characters`,
  },
  {
    name: "context",
    detail:
      `optional; client (${FEEDBACK_CLIENTS.join(", ")}), client_version, ` +
      "request_id, route, error_reference. Each string is capped at " +
      `${FEEDBACK_LIMITS.contextField} characters. request_id is the one ` +
      "field kept verbatim, so put the requestId from a failed call there " +
      "rather than in the prose, where the secret passes would eat it",
  },
] as const;

const STEPS = [
  {
    title: "Draft",
    detail:
      `Call ${PREPARE} with the fields above. It stores and sends nothing. ` +
      "It answers with `report` (the same object, sanitized), `redactions` " +
      "(how many substitutions were made) and `redacted_fields` (which " +
      "fields they were in).",
  },
  {
    title: "Show the human and get approval",
    detail:
      "Print the returned `report` verbatim and ask whether to send it. If " +
      "`redactions` is above zero, say which fields were changed: the human " +
      "is the one who can tell whether what is left still describes the " +
      "problem. Do not send a report they have not seen.",
  },
  {
    title: "Send",
    detail:
      `Call ${SUBMIT} with exactly the \`report\` object ${PREPARE} returned, ` +
      "its `approval_token`, and `confirm: true`. The token covers that " +
      "exact report for one hour: a report edited between the two calls, or " +
      "one without its token, is refused with `confirmation_required`. That " +
      "refusal means prepare again and ask the human, not retry with the " +
      "flag set.",
  },
] as const;

const RECEIPT_NOTE =
  `${SUBMIT} answers with a \`receipt\` of the form FB-XXXX-XXXX. Give it to ` +
  "the human: it is how they or a maintainer refer to this report later, and " +
  "it is the only identifier that appears both in the private record and on " +
  "any public issue filed from it. `deliveries` says where the report went; " +
  "an empty list with a `warning` means the deployment stores feedback " +
  "locally and has no delivery channel configured, which is not a failure.";

const RATE_LIMIT_NOTE =
  "Identical content re-sent within a day answers with the original receipt, " +
  "`deduplicated: true`, and sends nothing, so a retry is safe. An " +
  `organization may file ${SUBMIT_RATE_LIMIT_MAX_PER_ORG} reports an hour; ` +
  "past that the call answers `rate_limited`.";

const PRIVACY_NOTE =
  "Who filed the report (the user and organization) is stored privately and " +
  "is never published. The report's own text may be posted as a public " +
  "issue, which is why it must carry no tenant content.";

const renderStep = (
  { detail, title }: { title: string; detail: string },
  index: number,
): string => `${index + 1}. ${title}. ${detail}`;

const renderBullet = (line: string): string => `- ${line}`;

const renderField = ({
  detail,
  name,
}: {
  name: string;
  detail: string;
}): string => `- ${name}: ${detail}`;

/** Build the feedback-workflow reference text. */
export const buildFeedbackWorkflowReference = (): string =>
  [
    "stella feedback workflow (draft, approve, send)",
    "",
    "How to report a stella bug or gap. Two calls, with a human approval " +
      "between them: the draft step sanitizes and returns the report, the " +
      "send step files it.",
    "",
    "When to file one:",
    ...WHEN_TO_REPORT.map(renderBullet),
    "",
    "What a report must never contain:",
    ...NEVER_INCLUDE.map(renderBullet),
    "",
    "Fields:",
    ...FIELDS.map(renderField),
    "",
    "Procedure:",
    ...STEPS.map(renderStep),
    "",
    RECEIPT_NOTE,
    "",
    RATE_LIMIT_NOTE,
    "",
    PRIVACY_NOTE,
  ].join("\n");
