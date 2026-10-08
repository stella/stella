import {
  desktopEditSessions,
  EU_COMPLETION_STATUSES,
  euCompletionApprovals,
  euCompletionControls,
  euCompletionReceipts,
  workObligations,
} from "@/api/db/schema";
import {
  FLOW_RUN_TRANSITIONS_V1,
  FLOW_RUN_STEP_TRANSITIONS_V1,
} from "@/api/lib/db/flow-run-transition-spec";
import type {
  STATUS_COLUMNS,
  StatusTable,
} from "@/api/lib/db/status-tables.gen";
import {
  defineFixedLifecycle,
  defineKeyedTransitions,
  defineLifecycle,
  defineTransitions,
} from "@/api/lib/db/transitions";
import type {
  ScopedTransitionDeclaration,
  FixedLifecycleSpec,
  LifecycleSpec,
  TransitionSpec,
} from "@/api/lib/db/transitions";
import { PDF_SIGNING_SESSION_TRANSITIONS } from "@/api/lib/files/pdf-signing/transition-spec";
import { UPLOAD_TRIGGER_TRANSITIONS } from "@/api/lib/flows/upload-trigger-transitions";
import {
  CONTACT_MONITORING_TRANSITIONS,
  FIRM_MONITORING_TRANSITIONS,
  MATCH_MEMBERSHIP_TRANSITIONS,
  MATCH_REVIEW_TRANSITIONS,
  SCREENING_COVERAGE_TRANSITIONS,
  SANCTIONS_EDITION_FANOUT_TRANSITIONS,
  SANCTIONS_MONITORING_BACKFILL_TRANSITIONS,
} from "@/api/lib/lists/sanctions/monitoring-transition-specs";

// Each table chooses an ownership category explicitly; new status tables must
// choose a category or declare a managed spec before the total map compiles.
const UNMANAGED_REASONS = {
  authCeremony:
    "Registration lifecycle is owned by the authentication ceremony store.",
  delegatedAuth: "Invitation acceptance and expiry are owned by Better Auth.",
  antiForgery:
    "The state column stores an OAuth anti-forgery token, not a lifecycle.",
  workerRun:
    "Worker-run lifecycle remains with its existing executor pending transition-owner migration.",
  cleanup:
    "Durable cleanup and deletion requests remain with their idempotent retry workers pending migration.",
  projection:
    "Derived index or access state remains with its projection/reconciliation owner pending migration.",
  userWorkflow:
    "User-edited workflow state remains with its command handlers pending migration.",
  userDecision:
    "Approval and suggestion state combines user decisions with domain handlers pending migration.",
  fileLifecycle:
    "Upload, scan, and file-publication state remains with its file lifecycle owner pending migration.",
  configRow:
    "Configuration-row state is maintained by its configuration owner, not a worker-run lifecycle.",
  connection:
    "Connection availability combines credential updates and provider health checks pending migration.",
  externalEntitlement:
    "Provider entitlement state is ordered by external events and generations pending migration.",
  corpusEdition:
    "Corpus-edition activation is coordinated by the ingestion refresh owner pending migration.",
  collaboration:
    "Session and room state remains with its collaboration owner pending migration.",
  coordinatedTimers:
    "Timer state and its entry projection are coordinated by the timer transaction owner pending migration.",
} as const;

const DESKTOP_EDIT_SESSION_TRANSITIONS = defineTransitions(
  desktopEditSessions,
  {
    open: ["finalized", "cancelled", "expired"],
    finalized: [],
    cancelled: [],
    expired: [],
  },
  { terminal: ["finalized", "cancelled", "expired"] },
);

const WORK_OBLIGATION_TRANSITIONS = defineKeyedTransitions({
  table: workObligations,
  key: "entityId",
  edges: {
    unassigned: [
      "awaiting_acknowledgement",
      "active",
      "completed",
      "cancelled",
    ],
    awaiting_acknowledgement: [
      "unassigned",
      "active",
      "completed",
      "cancelled",
    ],
    active: [
      "unassigned",
      "awaiting_acknowledgement",
      "completed",
      "cancelled",
    ],
    completed: ["unassigned", "awaiting_acknowledgement", "active"],
    cancelled: ["unassigned", "awaiting_acknowledgement", "active"],
  },
  // Closed obligations can reopen according to their current ownership state.
  options: { terminal: [] },
});

// Active receipts settle to any outcome; dry-run settles only fetched work.
// Failed and mirror-repair receipts are readmitted; the rest are final.
const EU_COMPLETION_SETTLEMENTS = EU_COMPLETION_STATUSES.filter(
  (status): status is Exclude<typeof status, "dry-run"> => status !== "dry-run",
);
const EU_COMPLETION_RECEIPT_LIFECYCLE = defineLifecycle({
  table: euCompletionReceipts,
  key: "id",
  graphs: {
    status: {
      edges: {
        pending: EU_COMPLETION_SETTLEMENTS,
        fetched: EU_COMPLETION_STATUSES,
        "failed-backoff": EU_COMPLETION_SETTLEMENTS,
        "publisher-refused": EU_COMPLETION_SETTLEMENTS,
        "superseded-by-crawl": EU_COMPLETION_SETTLEMENTS,
        failed: ["pending", "fetched", "withdrawn"],
        "review-required": ["pending", "fetched"],
        applied: [],
        unchanged: [],
        "dry-run": [],
        "too-large": [],
        "publisher-gone": [],
        withdrawn: [],
      },
      terminal: [
        "applied",
        "unchanged",
        "dry-run",
        "too-large",
        "publisher-gone",
        "withdrawn",
      ],
    },
    // The attempt lease is taken and released around every publisher read.
    attemptState: {
      edges: {
        idle: ["picked-up", "repair"],
        "picked-up": ["idle", "repair"],
        repair: ["idle", "picked-up"],
      },
      terminal: [],
    },
  },
});

const EU_COMPLETION_CONTROL_LIFECYCLE = defineLifecycle({
  table: euCompletionControls,
  key: "key",
  graphs: { state: { edges: { off: ["on"], on: ["off"] }, terminal: [] } },
});

// The approval copies its dry-run receipt's outcome as foreign-key proof.
const EU_COMPLETION_APPROVAL_PROOF = defineFixedLifecycle({
  table: euCompletionApprovals,
  column: "proofStatus",
  value: "dry-run",
});

type StatusColumns<TTable extends StatusTable> =
  (typeof STATUS_COLUMNS)[TTable];

// Each table's decision covers exactly its inventoried lifecycle columns.
type TransitionDecision<TTable extends StatusTable> =
  | { unmanaged: string }
  | {
      scoped: {
        readonly [
          TColumn in StatusColumns<TTable>[number]
        ]: ScopedTransitionDeclaration & { readonly stateColumn: TColumn };
      } & Readonly<Record<string, ScopedTransitionDeclaration>>;
    }
  | (StatusColumns<TTable> extends readonly [infer TColumn extends string]
      ? ScopedTransitionDeclaration & { readonly stateColumn: TColumn }
      : never)
  | (StatusColumns<TTable> extends readonly ["status"] ? TransitionSpec : never)
  | LifecycleSpec<StatusColumns<TTable>[number]>
  | (StatusColumns<TTable> extends readonly [infer TColumn extends string]
      ? FixedLifecycleSpec<TColumn>
      : never);

/** Existing domain owners remain explicit until their writers migrate. */
export const TRANSITIONS = {
  agentRegistration: { unmanaged: UNMANAGED_REASONS.authCeremony },
  accountDeletionEffectChunks: { unmanaged: UNMANAGED_REASONS.cleanup },
  accountDeletionRequests: { unmanaged: UNMANAGED_REASONS.cleanup },
  agentSkillProposals: { unmanaged: UNMANAGED_REASONS.userDecision },
  aiMemories: { unmanaged: UNMANAGED_REASONS.userDecision },
  auditLogs: { unmanaged: UNMANAGED_REASONS.userDecision },
  bilingualTranslationRows: { unmanaged: UNMANAGED_REASONS.workerRun },
  bilingualTranslationRuns: { unmanaged: UNMANAGED_REASONS.workerRun },
  billingArrangements: { unmanaged: UNMANAGED_REASONS.configRow },
  bufferObjectCleanupIntents: { unmanaged: UNMANAGED_REASONS.cleanup },
  caseLawCitationResolutionCensusRuns: {
    unmanaged: UNMANAGED_REASONS.workerRun,
  },
  caseLawCitations: { unmanaged: UNMANAGED_REASONS.projection },
  caseLawCorpusUploadIntents: { unmanaged: UNMANAGED_REASONS.fileLifecycle },
  caseLawDecisionIdentifierBackfills: {
    unmanaged: UNMANAGED_REASONS.workerRun,
  },
  caseLawDecisions: { unmanaged: UNMANAGED_REASONS.projection },
  caseLawIndexJobs: { unmanaged: UNMANAGED_REASONS.workerRun },
  caseLawIngestionEvents: { unmanaged: UNMANAGED_REASONS.workerRun },
  caseLawProvisionCitations: { unmanaged: UNMANAGED_REASONS.projection },
  caseLawProvisionExtractions: { unmanaged: UNMANAGED_REASONS.workerRun },
  caseLawProvisionExtractionScopes: { unmanaged: UNMANAGED_REASONS.workerRun },
  caseLawReconciliationItems: { unmanaged: UNMANAGED_REASONS.projection },
  caseLawReplayBatches: { unmanaged: UNMANAGED_REASONS.workerRun },
  caseLawResearchAnswers: { unmanaged: UNMANAGED_REASONS.workerRun },
  caseLawSearchBackfillFailures: { unmanaged: UNMANAGED_REASONS.workerRun },
  caseLawStatuteCitationCountState: { unmanaged: UNMANAGED_REASONS.projection },
  chatThreadCompactions: { unmanaged: UNMANAGED_REASONS.workerRun },
  chatTurns: { unmanaged: UNMANAGED_REASONS.workerRun },
  contactExtractionUploads: { unmanaged: UNMANAGED_REASONS.fileLifecycle },
  contacts: CONTACT_MONITORING_TRANSITIONS,
  corpusIndexGenerations: { unmanaged: UNMANAGED_REASONS.projection },
  corpusIndexGroupEnrollments: { unmanaged: UNMANAGED_REASONS.projection },
  corpusIndexProjectionIntents: { unmanaged: UNMANAGED_REASONS.projection },
  corpusIndexProjectionStates: { unmanaged: UNMANAGED_REASONS.projection },
  correspondence: { unmanaged: UNMANAGED_REASONS.userWorkflow },
  desktopEditSessions: DESKTOP_EDIT_SESSION_TRANSITIONS,
  documentProcessingRuns: { unmanaged: UNMANAGED_REASONS.workerRun },
  documentReviewFindings: { unmanaged: UNMANAGED_REASONS.userDecision },
  documentReviewRuns: { unmanaged: UNMANAGED_REASONS.workerRun },
  documentTranslationRuns: { unmanaged: UNMANAGED_REASONS.workerRun },
  documentTranslationUnits: { unmanaged: UNMANAGED_REASONS.workerRun },
  docxSuggestions: { unmanaged: UNMANAGED_REASONS.userDecision },
  entities: { unmanaged: UNMANAGED_REASONS.userWorkflow },
  entityDeletionCleanupRequests: { unmanaged: UNMANAGED_REASONS.cleanup },
  entityDeletionEffectChunks: { unmanaged: UNMANAGED_REASONS.cleanup },
  euCompletionApprovals: EU_COMPLETION_APPROVAL_PROOF,
  euCompletionControls: EU_COMPLETION_CONTROL_LIFECYCLE,
  euCompletionReceipts: EU_COMPLETION_RECEIPT_LIFECYCLE,
  expenses: { unmanaged: UNMANAGED_REASONS.userWorkflow },
  extractionRuns: { unmanaged: UNMANAGED_REASONS.workerRun },
  fileComparisonUploads: { unmanaged: UNMANAGED_REASONS.fileLifecycle },
  flowRuns: FLOW_RUN_TRANSITIONS_V1,
  flowRunSteps: FLOW_RUN_STEP_TRANSITIONS_V1,
  flowUploadTriggerIntents: UPLOAD_TRIGGER_TRANSITIONS,
  folioCollabRooms: { unmanaged: UNMANAGED_REASONS.collaboration },
  invitation: { unmanaged: UNMANAGED_REASONS.delegatedAuth },
  invoices: { unmanaged: UNMANAGED_REASONS.userWorkflow },
  legalListClaims: { unmanaged: UNMANAGED_REASONS.userWorkflow },
  legalListGenerationCandidates: { unmanaged: UNMANAGED_REASONS.workerRun },
  legalListGenerationRuns: { unmanaged: UNMANAGED_REASONS.workerRun },
  legalListItems: { unmanaged: UNMANAGED_REASONS.userWorkflow },
  legalListItemSources: { unmanaged: UNMANAGED_REASONS.projection },
  legalLists: { unmanaged: UNMANAGED_REASONS.userWorkflow },
  legalListVerificationRuns: { unmanaged: UNMANAGED_REASONS.workerRun },
  legislationDocuments: { unmanaged: UNMANAGED_REASONS.projection },
  legislationIndexJobs: { unmanaged: UNMANAGED_REASONS.workerRun },
  mcpConnectorAuthorizationReviews: {
    unmanaged: UNMANAGED_REASONS.userDecision,
  },
  mcpOAuthState: { unmanaged: UNMANAGED_REASONS.antiForgery },
  mcpUserConnections: { unmanaged: UNMANAGED_REASONS.connection },
  officeFileEvidence: { unmanaged: UNMANAGED_REASONS.workerRun },
  organizationAccessStates: { unmanaged: UNMANAGED_REASONS.projection },
  organizationConfiguredAccess: { unmanaged: UNMANAGED_REASONS.projection },
  organizationFileObjects: { unmanaged: UNMANAGED_REASONS.fileLifecycle },
  organizationSettings: FIRM_MONITORING_TRANSITIONS,
  pdfSigningSessions: PDF_SIGNING_SESSION_TRANSITIONS,
  pendingScoutEmissions: { unmanaged: UNMANAGED_REASONS.workerRun },
  pendingUploads: { unmanaged: UNMANAGED_REASONS.fileLifecycle },
  playbookDefinitions: { unmanaged: UNMANAGED_REASONS.userDecision },
  properties: { unmanaged: UNMANAGED_REASONS.userWorkflow },
  reportExports: { unmanaged: UNMANAGED_REASONS.workerRun },
  sanctionsContactMatches: {
    scoped: {
      state: MATCH_MEMBERSHIP_TRANSITIONS,
      disposition: MATCH_REVIEW_TRANSITIONS,
    },
  },
  sanctionsContactScreenings: SCREENING_COVERAGE_TRANSITIONS,
  sanctionsEditionFanouts: SANCTIONS_EDITION_FANOUT_TRANSITIONS,
  sanctionsMonitoringBackfills: SANCTIONS_MONITORING_BACKFILL_TRANSITIONS,
  sanctionsEditions: { unmanaged: UNMANAGED_REASONS.corpusEdition },
  schedulerJobRuns: { unmanaged: UNMANAGED_REASONS.workerRun },
  scoutRuns: { unmanaged: UNMANAGED_REASONS.workerRun },
  sharepointConnections: { unmanaged: UNMANAGED_REASONS.connection },
  sharepointOAuthState: { unmanaged: UNMANAGED_REASONS.antiForgery },
  signals: { unmanaged: UNMANAGED_REASONS.userWorkflow },
  softLawDocumentLocators: { unmanaged: UNMANAGED_REASONS.projection },
  softLawDocuments: { unmanaged: UNMANAGED_REASONS.projection },
  softLawIngestionAttempts: { unmanaged: UNMANAGED_REASONS.workerRun },
  softLawSources: { unmanaged: UNMANAGED_REASONS.workerRun },
  styleSets: { unmanaged: UNMANAGED_REASONS.fileLifecycle },
  templateDeletionCleanupRequests: { unmanaged: UNMANAGED_REASONS.cleanup },
  templateFills: { unmanaged: UNMANAGED_REASONS.workerRun },
  templatePersistenceRequests: { unmanaged: UNMANAGED_REASONS.cleanup },
  templates: { unmanaged: UNMANAGED_REASONS.fileLifecycle },
  templateVersions: { unmanaged: UNMANAGED_REASONS.fileLifecycle },
  timeEntries: { unmanaged: UNMANAGED_REASONS.userWorkflow },
  timeEntrySuggestions: { unmanaged: UNMANAGED_REASONS.userDecision },
  timeEntryTimerStates: { unmanaged: UNMANAGED_REASONS.projection },
  timeTimers: { unmanaged: UNMANAGED_REASONS.coordinatedTimers },
  usageEntitlements: { unmanaged: UNMANAGED_REASONS.externalEntitlement },
  workObligations: WORK_OBLIGATION_TRANSITIONS,
  workspaces: { unmanaged: UNMANAGED_REASONS.userWorkflow },
} as const satisfies {
  [TTable in StatusTable]: TransitionDecision<TTable>;
} & {
  contacts: typeof CONTACT_MONITORING_TRANSITIONS;
  organizationSettings: typeof FIRM_MONITORING_TRANSITIONS;
};
