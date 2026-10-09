import type { ActionPeriodIdentity } from "@/api/lib/rate-limit/action-period-budget";

/**
 * Whose credentials serve a kind's work. `organization_model`: the work runs
 * on the organization's own model key whenever one is configured, and on the
 * managed provider otherwise (every model dispatch resolves this way).
 * `managed_service`: the work always runs on services the deployment hosts.
 */
export const ACTION_SERVICE_CREDENTIALS = {
  organizationModel: "organization_model",
  managedService: "managed_service",
} as const;

export type ActionServiceCredentials =
  (typeof ACTION_SERVICE_CREDENTIALS)[keyof typeof ACTION_SERVICE_CREDENTIALS];

export type ActionKindDefinition = {
  consumesServices: boolean;
  admission: "period" | "concurrency-only";
  serviceCredentials: ActionServiceCredentials;
};

const ORGANIZATION_MODEL = ACTION_SERVICE_CREDENTIALS.organizationModel;
const MANAGED_SERVICE = ACTION_SERVICE_CREDENTIALS.managedService;

/** One model action a member starts: it draws one period action. */
const MODEL_ACTION = {
  consumesServices: true,
  admission: "period",
  serviceCredentials: ORGANIZATION_MODEL,
} as const satisfies ActionKindDefinition;

/**
 * Model work whose period action a parent already drew; it takes a background
 * concurrency slot only. `ACTION_KIND_COUNTED_BY` names the parent.
 */
const MODEL_BACKGROUND = {
  consumesServices: true,
  admission: "concurrency-only",
  serviceCredentials: ORGANIZATION_MODEL,
} as const satisfies ActionKindDefinition;

export const ACTION_KINDS = {
  "chat.send": MODEL_ACTION,
  "chat.generate-thread-title": MODEL_ACTION,
  "chat.improve-prompt": MODEL_ACTION,
  "chat.suggest-thread-title": MODEL_ACTION,
  "chat.suggested-prompts": MODEL_ACTION,
  "chat.thread-recap": MODEL_ACTION,
  "chat.background": MODEL_BACKGROUND,
  "workflow.start": MODEL_ACTION,
  "flow.start": MODEL_ACTION,
  "workflow.background": MODEL_BACKGROUND,
  "flow.background": MODEL_BACKGROUND,
  "editor.autocomplete": MODEL_ACTION,
  "contacts.extract-power-of-attorney": MODEL_ACTION,
  "clauses.rewrite": MODEL_ACTION,
  "templates.prefill": MODEL_ACTION,
  "templates.suggest-fields": MODEL_ACTION,
  "templates.fill": MODEL_ACTION,
  "skills.rewrite-resource": MODEL_ACTION,
  "skills.generate-draft": MODEL_ACTION,
  "skills.propose-from-comments": MODEL_ACTION,
  "time-entries.polish-narrative": MODEL_ACTION,
  "entities.suggest-placements": MODEL_ACTION,
  "versions.summarize": MODEL_ACTION,
  "properties.suggest-prompt": MODEL_ACTION,
  "properties.preview": MODEL_ACTION,
  "search.refine": MODEL_ACTION,
  "search.summarize": MODEL_ACTION,
  "playbooks.derive-ask": MODEL_ACTION,
  "case-law.analysis": MODEL_ACTION,
  "case-law.search-refine": MODEL_ACTION,
  "case-law.search-expand": MODEL_ACTION,
  "case-law.research-answers": MODEL_ACTION,
  "documents.bounding-boxes": MODEL_ACTION,
  "documents.scan-deadlines": MODEL_ACTION,
  "document-reviews.parties": MODEL_ACTION,
  "document-reviews.propose-positions": MODEL_ACTION,
  "document-reviews.start": MODEL_ACTION,
  "document-reviews.background": MODEL_BACKGROUND,
  "document-translation.start": MODEL_ACTION,
  "document-translation.background": MODEL_BACKGROUND,
  "bilingual.prepare": MODEL_ACTION,
  "bilingual.start": MODEL_ACTION,
  "bilingual.background": MODEL_BACKGROUND,
  "list-verification.start": MODEL_ACTION,
  "list-verification.background": MODEL_BACKGROUND,
  "report-export.start": MODEL_ACTION,
  "report-export.background": MODEL_BACKGROUND,
  "mcp.services/call": {
    consumesServices: true,
    admission: "period",
    serviceCredentials: MANAGED_SERVICE,
  },
  "mcp.data/call": {
    consumesServices: false,
    admission: "period",
    serviceCredentials: MANAGED_SERVICE,
  },
} as const satisfies Record<string, ActionKindDefinition>;

export type ActionKind = keyof typeof ACTION_KINDS;

type RegisteredAction = {
  [Kind in ActionKind]: { actionKind: Kind } & (typeof ACTION_KINDS)[Kind];
}[ActionKind];

export type PeriodActionKind = Extract<
  RegisteredAction,
  { admission: "period" }
>["actionKind"];

export type ConcurrencyOnlyActionKind = Extract<
  RegisteredAction,
  { admission: "concurrency-only" }
>["actionKind"];

/**
 * The period-admitted action that already drew each background kind's period
 * action. Total, so a new background kind cannot ship without its parent.
 */
export const ACTION_KIND_COUNTED_BY = {
  "chat.background": "chat.send",
  "workflow.background": "workflow.start",
  "flow.background": "flow.start",
  "document-reviews.background": "document-reviews.start",
  "document-translation.background": "document-translation.start",
  "bilingual.background": "bilingual.start",
  "list-verification.background": "list-verification.start",
  "report-export.background": "report-export.start",
} as const satisfies Record<ConcurrencyOnlyActionKind, PeriodActionKind>;

export const QUEUED_ACTION_KIND = {
  extraction: "workflow.start",
  flow: "flow.start",
} as const satisfies Record<string, PeriodActionKind>;

export const BACKGROUND_ACTION_KIND = {
  extraction: "workflow.background",
  flow: "flow.background",
} as const satisfies Record<string, ConcurrencyOnlyActionKind>;

export type AdmittedActionIdentity = Omit<
  ActionPeriodIdentity,
  "actionKind"
> & {
  actionKind: PeriodActionKind;
};
