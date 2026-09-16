import type { McpToolName } from "@/api/lib/api-handlers";
import { PROVISION_READ_STATUSES } from "@/api/lib/legal-search/legislation-provision-vocabulary";
import { LIMITS } from "@/api/lib/limits";

/**
 * The order to drive the stella legislation corpus in. The tool descriptions
 * say what each tool takes; none of them says that an ELI is the handle every
 * later call needs, that anchors come from a read rather than from a section
 * number, or that a point-in-time question is answered by `as_of` on the read
 * rather than by a filter on the search. An agent holding only the tool list
 * has to discover that order by trial, so it is written down here.
 *
 * Every tool this document names is typed as {@link McpToolName} and every
 * number is rendered from the limit the code enforces, so a rename or a
 * re-bound limit is a compile error here rather than prose that has quietly
 * stopped being true.
 */

/**
 * Canonical URI of the workflow resource. Owned here with the text it
 * addresses, so the resource registry and the server instructions that point
 * agents at it cannot drift apart.
 */
export const LEGISLATION_WORKFLOW_REFERENCE_URI =
  "stella://reference/legislation-workflow";

/**
 * The tools the procedure below names. Typed against the registry union, and
 * asserted present in the rendered text by `resources.test.ts`, so neither
 * half can drift from the other.
 */
const TOOL = {
  searchLegislation: "search_legislation",
  readStatute: "read_statute",
  readStatuteProvisions: "read_statute_provisions",
  readProvisionHistory: "read_provision_history",
  searchBoeLegislation: "search_boe_legislation",
  prepareFeedback: "prepare_feedback",
} as const satisfies Record<string, McpToolName>;

export const LEGISLATION_WORKFLOW_TOOL_NAMES = Object.values(TOOL);

const {
  prepareFeedback: PREPARE_FEEDBACK,
  readProvisionHistory: READ_PROVISION_HISTORY,
  readStatute: READ_STATUTE,
  readStatuteProvisions: READ_STATUTE_PROVISIONS,
  searchBoeLegislation: SEARCH_BOE_LEGISLATION,
  searchLegislation: SEARCH_LEGISLATION,
} = TOOL;

type WorkflowStep = {
  /** Short label shown as the step heading. */
  title: string;
  /** What to call, with the inputs and response fields that matter. */
  detail: string;
};

const WORKFLOW_STEPS: readonly WorkflowStep[] = [
  {
    title: "Find the act",
    detail:
      `${SEARCH_LEGISLATION} with \`query\` and a \`country\`. Each hit ` +
      "carries the act's `eli` (the European Legislation Identifier), its " +
      "title, language, document type, publication status, effective date " +
      "and a matched snippet. No facets come back and `total` is not " +
      "counted, so page with the returned `nextCursor` rather than " +
      "reasoning about how many results exist. The `eli` is the handle " +
      "every later call takes: it addresses the act, not one consolidation " +
      "of it.",
  },
  {
    title: "Read it as of a date",
    detail:
      `${READ_STATUTE} with that \`eli\`. \`as_of\` (ISO YYYY-MM-DD) picks ` +
      "the consolidation in force on that day; omit it for the text in " +
      "force today. There is no as-of filter on the search, so a " +
      "point-in-time question is answered here. The reply carries the " +
      "consolidation's `versionValidFrom`/`versionValidTo`, `versions` " +
      `(up to ${LIMITS.legislationVersionsPageSizeDefault} of the work's ` +
      "consolidations, newest window first), `outline` (its heading " +
      `anchors, at most ${LIMITS.legislationOutlineHeadingsMax} of them ` +
      "with `outlineTruncated` when there are more) and the plain `text` " +
      "in windows: pass the returned `nextCursor` back as `cursor` to keep " +
      "reading. An ELI the corpus does not hold and a date no " +
      "consolidation covers are different answers, and each names its own " +
      "next call.",
  },
  {
    title: "Read the provisions you need, batched",
    detail:
      `${READ_STATUTE_PROVISIONS} with \`items\`, up to ` +
      `${LIMITS.legislationProvisionBatchMax} entries of ` +
      "{ eli, anchor } plus an optional `as_of` and `language`. An `anchor` " +
      "is the publisher's own (`par_1729`, `par_1729-odst_1`) and the " +
      `\`outline\` from ${READ_STATUTE} is where they come from: they are ` +
      "not derivable from a section number, so do not spell one yourself. " +
      "Entries may name different acts and different dates in one call. " +
      "Every entry is answered on its own, in input order, under " +
      `\`status\`: ${PROVISION_READ_STATUSES.join(", ")}. Only \`found\` ` +
      "carries `text`; the rest carry a `message` saying what to change. " +
      `Provision text is cut at ${LIMITS.legislationProvisionTextChars} ` +
      "characters with `truncated` set. Prefer one batched call over one " +
      "call per provision.",
  },
  {
    title: "Follow one provision across amendments",
    detail:
      `${READ_PROVISION_HISTORY} with the work's \`eli\` and one \`anchor\`. ` +
      "It returns that provision's text in each consolidation of the work, " +
      "newest validity window first, so two wordings can be compared " +
      "without downloading whole statutes. A consolidation that does not " +
      "carry the anchor is left out of `items`. It defaults to " +
      `${LIMITS.legislationProvisionHistoryPageSizeDefault} versions per ` +
      "page and takes at most " +
      `${LIMITS.legislationProvisionHistoryPageSizeMax}; pass the returned ` +
      "`nextCursor` back as `cursor` for older windows.",
  },
];

const FACTS = [
  {
    title: "The corpus is not every jurisdiction",
    detail:
      "Only admitted jurisdictions and only sources cleared for " +
      "redistribution are searched and read. A country outside the admitted " +
      `set answers \`not_found\` from ${SEARCH_LEGISLATION} with the ` +
      "admitted codes in the hint; an act from a source that is not cleared " +
      "reads as not found at all.",
  },
  {
    title:
      "Displaying wording and feeding it to a model are separate permissions",
    detail:
      `A source may permit one and not the other. ${READ_STATUTE} then ` +
      "answers with the metadata, the versions and the outline, and " +
      "`textWithheldReason` in place of `text`; the same entry in " +
      `${READ_STATUTE_PROVISIONS} answers \`text_withheld\`. Follow the ` +
      "statute's `appUrl` and read it there instead; retrying will not " +
      "change the answer.",
  },
  {
    title: "Spanish BOE legislation is a different tool",
    detail:
      `${SEARCH_BOE_LEGISLATION} queries the BOE's live service and takes ` +
      "BOE identifiers (`BOE-A-1889-4763`) and YYYYMMDD dates. It is not " +
      "part of this corpus, and its ids are not ELIs.",
  },
] as const;

const renderStep = ({ detail, title }: WorkflowStep, index: number): string =>
  `${index + 1}. ${title}. ${detail}`;

const renderFact = (fact: { title: string; detail: string }): string =>
  `- ${fact.title}: ${fact.detail}`;

/** Build the legislation-workflow reference text. */
export const buildLegislationWorkflowReference = (): string =>
  [
    "stella legislation workflow (search, read as of a date, read provisions, follow amendments)",
    "",
    "The order to call things in. The corpus holds consolidated statutes: " +
      "an act is a Work, each consolidation of it is one version with its " +
      "own validity window, and an ELI addresses the Work. So finding the " +
      "act, choosing a date and naming a provision are three separate " +
      "steps.",
    "",
    "Procedure:",
    WORKFLOW_STEPS.map(renderStep).join("\n"),
    "",
    "Facts that are easy to get wrong:",
    FACTS.map(renderFact).join("\n"),
    "",
    "Errors: a failed tool returns one text content of " +
      '`{"error":{"code","message","hint"}}` with isError set. Read `hint`: ' +
      "it names the next call.",
    "",
    `Something missing or wrong here? Prepare a report with ${PREPARE_FEEDBACK}.`,
  ].join("\n");
