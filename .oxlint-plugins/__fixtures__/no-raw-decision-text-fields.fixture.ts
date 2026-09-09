// Passive regression fixture for
// no-raw-decision-text-fields/no-raw-decision-text-fields.
//
// Required reports carry disables. If detection regresses, the directives
// become unused and fixture lint fails. Unannotated cases must remain allowed.

type TextField =
  | { readonly type: "present"; readonly text: string }
  | { readonly type: "absent"; readonly reason: string };
type DecisionTextFields = Record<
  "abstract" | "headnote" | "legalSentence" | "summary",
  TextField
>;

declare const adapterKey: string;
declare const parsedTextField: TextField;
declare const rawAbstract: string;
declare const rawHeadnote: string;
declare const reason: string;
declare const sourceId: string;
declare const dynamicKey: string;
declare const rawMetadata: Record<string, unknown>;
declare const sourceTextField: (adapter: string, raw: string) => TextField;
declare const presentTextField: (raw: string) => TextField;
declare const absentTextField: (reason: string) => TextField;
declare const checkedDecisionMetadata: (
  metadata: Record<string, unknown>,
) => Record<string, unknown>;
declare const validTextFields: DecisionTextFields;

const directMetadata = {
  metadata: {
    // oxlint-disable-next-line no-raw-decision-text-fields/no-raw-decision-text-fields -- fixture: decision text cannot bypass TextField through metadata
    abstract: rawAbstract,
    // oxlint-disable-next-line no-raw-decision-text-fields/no-raw-decision-text-fields -- fixture: a protected key stays out of metadata even when its value is contracted
    headnote: parsedTextField,
    // oxlint-disable-next-line no-raw-decision-text-fields/no-raw-decision-text-fields -- fixture: adapters cannot forge the pipeline-owned absence sidecar
    _stellaDecisionTextAbsence: rawMetadata,
  },
  textFields: validTextFields,
};

declare const decision: {
  metadata: Record<string, unknown>;
  textFields: DecisionTextFields;
};

// oxlint-disable-next-line no-raw-decision-text-fields/no-raw-decision-text-fields -- fixture: member assignment cannot bypass TextField through metadata
decision.metadata.legalSentence = parsedTextField;
// oxlint-disable-next-line no-raw-decision-text-fields/no-raw-decision-text-fields -- fixture: every protected metadata assignment crosses the same boundary
decision.metadata.summary = rawHeadnote;

const metadataAlias = {
  // oxlint-disable-next-line no-raw-decision-text-fields/no-raw-decision-text-fields -- fixture: aliases cross the checked metadata boundary
  metadata: rawMetadata,
  textFields: validTextFields,
};
const metadataSpread = {
  metadata: {
    // oxlint-disable-next-line no-raw-decision-text-fields/no-raw-decision-text-fields -- fixture: spreads cross the checked metadata boundary
    ...rawMetadata,
  },
  textFields: validTextFields,
};
const computedMetadata = {
  metadata: {
    // oxlint-disable-next-line no-raw-decision-text-fields/no-raw-decision-text-fields -- fixture: computed keys cross the checked metadata boundary
    [dynamicKey]: rawHeadnote,
  },
  textFields: validTextFields,
};
// oxlint-disable-next-line no-raw-decision-text-fields/no-raw-decision-text-fields -- fixture: aliased assignment crosses the checked metadata boundary
decision.metadata = rawMetadata;
// oxlint-disable-next-line no-raw-decision-text-fields/no-raw-decision-text-fields -- fixture: dynamic assignment crosses the checked metadata boundary
decision.metadata[dynamicKey] = rawHeadnote;
// oxlint-disable-next-line no-raw-decision-text-fields/no-raw-decision-text-fields -- fixture: Object.assign cannot bypass the checked metadata boundary
Object.assign(decision.metadata, { sourceId });

const rawTextFields = {
  textFields: {
    // oxlint-disable-next-line no-raw-decision-text-fields/no-raw-decision-text-fields -- fixture: raw strings must cross a TextField constructor
    abstract: "raw abstract",
    // oxlint-disable-next-line no-raw-decision-text-fields/no-raw-decision-text-fields -- fixture: interpolated templates are raw strings too
    headnote: `raw ${rawHeadnote}`,
  },
};

// oxlint-disable-next-line no-raw-decision-text-fields/no-raw-decision-text-fields -- fixture: direct textFields assignments require a TextField expression
decision.textFields.legalSentence = "raw legal sentence";
// oxlint-disable-next-line no-raw-decision-text-fields/no-raw-decision-text-fields -- fixture: dynamic text-field assignment cannot bypass the contract
decision.textFields[dynamicKey] = parsedTextField;
// oxlint-disable-next-line no-raw-decision-text-fields/no-raw-decision-text-fields -- fixture: Object.assign cannot bypass the text-field contract
Object.assign(decision.textFields, { summary: parsedTextField });

const sourceRecord = { summary: "raw publisher value" };
const contractedDecision = {
  metadata: { sourceId },
  textFields: {
    abstract: sourceTextField(adapterKey, rawAbstract),
    headnote: presentTextField(rawHeadnote),
    legalSentence: absentTextField(reason),
    summary: parsedTextField,
  },
};
const checkedMetadata = {
  metadata: checkedDecisionMetadata(rawMetadata),
  textFields: validTextFields,
};
const unrelatedMetadata = { metadata: rawMetadata };
decision.metadata = { sourceId };
const { metadata } = decision;

decision.textFields.summary = parsedTextField;
const storedSummary = decision.metadata.summary;

export {
  contractedDecision,
  checkedMetadata,
  computedMetadata,
  directMetadata,
  metadata,
  metadataAlias,
  metadataSpread,
  rawTextFields,
  sourceRecord,
  storedSummary,
  unrelatedMetadata,
};
