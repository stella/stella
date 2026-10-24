// parser-output-unchanged: kill-switch overrides are admission state read per request; no parser reads them.
import { Result } from "better-result";
import * as v from "valibot";

import type { ActionKind } from "@/api/lib/rate-limit/action-kinds";
import { isRecord } from "@/api/lib/type-guards";

export const KILL_SWITCH_STATE = {
  on: "on",
  off: "off",
} as const;

export type KillSwitchState =
  (typeof KILL_SWITCH_STATE)[keyof typeof KILL_SWITCH_STATE];

type KillSwitchDefinition = {
  /** The state when the `KILL_SWITCHES` override does not name the switch. */
  default: KillSwitchState;
  /** Repo-relative path of the code that owns the switched feature. */
  owner: string;
  /**
   * The refusal hint callers receive while the switch is off, naming what is
   * off. The message stays the code's canonical, localized sentence.
   */
  offHint: string;
};

/**
 * Operator kill switches for AI and service-consuming features. A switch turned
 * off refuses new work of every action kind it covers with the typed
 * `action_feature_disabled` admission refusal; work already admitted finishes.
 *
 * Operators flip switches through the `KILL_SWITCHES` deployment variable, a
 * JSON object of switch id to state (`{"chat":"off"}`). Every process reads it
 * at startup, so restarting the running build applies a change; no release is
 * needed. Unknown ids and states refuse startup, so drop an override before
 * removing its switch here.
 */
export const KILL_SWITCHES = {
  chat: {
    default: KILL_SWITCH_STATE.on,
    owner: "apps/api/src/handlers/chat",
    offHint: "Chat is turned off. Do not retry until it is turned back on.",
  },
  "editor-autocomplete": {
    default: KILL_SWITCH_STATE.on,
    owner: "apps/api/src/handlers/ai-autocomplete",
    offHint:
      "Autocomplete is turned off. Do not retry until it is turned back on.",
  },
  workflows: {
    default: KILL_SWITCH_STATE.on,
    owner: "apps/api/src/handlers/workspaces/workflow",
    offHint:
      "Workflow generation is turned off. Do not retry until it is turned back on.",
  },
  flows: {
    default: KILL_SWITCH_STATE.on,
    owner: "apps/api/src/handlers/flows",
    offHint:
      "Flows are turned off. Do not retry until they are turned back on.",
  },
  "search-assist": {
    default: KILL_SWITCH_STATE.on,
    owner: "apps/api/src/handlers/search",
    offHint:
      "Search refinement and summaries are turned off. Do not retry until they are turned back on.",
  },
  "case-law-research": {
    default: KILL_SWITCH_STATE.on,
    owner: "apps/api/src/handlers/case-law",
    offHint:
      "Case-law research assistance is turned off. Do not retry until it is turned back on.",
  },
  "document-reviews": {
    default: KILL_SWITCH_STATE.on,
    owner: "apps/api/src/handlers/document-reviews",
    offHint:
      "Document reviews are turned off. Do not retry until they are turned back on.",
  },
  "document-translation": {
    default: KILL_SWITCH_STATE.on,
    owner: "apps/api/src/handlers/document-translations",
    offHint:
      "Document translation is turned off. Do not retry until it is turned back on.",
  },
  "bilingual-documents": {
    default: KILL_SWITCH_STATE.on,
    owner: "apps/api/src/handlers/bilingual-translations",
    offHint:
      "Bilingual documents are turned off. Do not retry until they are turned back on.",
  },
  "bounding-boxes": {
    default: KILL_SWITCH_STATE.on,
    owner: "apps/api/src/handlers/workspaces/generate-bounding-boxes.ts",
    offHint:
      "Document region detection is turned off. Do not retry until it is turned back on.",
  },
  "deadline-scan": {
    default: KILL_SWITCH_STATE.on,
    owner: "apps/api/src/lib/scouts",
    offHint:
      "Deadline scanning is turned off. Do not retry until it is turned back on.",
  },
  templates: {
    default: KILL_SWITCH_STATE.on,
    owner: "apps/api/src/handlers/templates",
    offHint:
      "Template assistance is turned off. Do not retry until it is turned back on.",
  },
  skills: {
    default: KILL_SWITCH_STATE.on,
    owner: "apps/api/src/handlers/skills",
    offHint:
      "Skill drafting is turned off. Do not retry until it is turned back on.",
  },
  "clause-rewrite": {
    default: KILL_SWITCH_STATE.on,
    owner: "apps/api/src/handlers/clauses",
    offHint:
      "Clause rewriting is turned off. Do not retry until it is turned back on.",
  },
  "version-summaries": {
    default: KILL_SWITCH_STATE.on,
    owner: "apps/api/src/lib/entity-versions",
    offHint:
      "Version summaries are turned off. Do not retry until they are turned back on.",
  },
  "billing-drafts": {
    default: KILL_SWITCH_STATE.on,
    owner: "apps/api/src/handlers/desktop-time-entries",
    offHint:
      "AI billing drafts are turned off. Do not retry until they are turned back on.",
  },
  "time-narratives": {
    default: KILL_SWITCH_STATE.on,
    owner: "apps/api/src/handlers/time-entries",
    offHint:
      "Time narrative polishing is turned off. Do not retry until it is turned back on.",
  },
  "placement-suggestions": {
    default: KILL_SWITCH_STATE.on,
    owner: "apps/api/src/handlers/entities/placements",
    offHint:
      "Placement suggestions are turned off. Do not retry until they are turned back on.",
  },
  "contact-extraction": {
    default: KILL_SWITCH_STATE.on,
    owner: "apps/api/src/handlers/contacts",
    offHint:
      "Contact extraction is turned off. Do not retry until it is turned back on.",
  },
  "list-verification": {
    default: KILL_SWITCH_STATE.on,
    owner: "apps/api/src/handlers/lists/verifications",
    offHint:
      "List verification is turned off. Do not retry until it is turned back on.",
  },
  "report-export": {
    default: KILL_SWITCH_STATE.on,
    owner: "apps/api/src/handlers/reports",
    offHint:
      "Report export is turned off. Do not retry until it is turned back on.",
  },
  "mcp-tools": {
    default: KILL_SWITCH_STATE.on,
    owner: "apps/api/src/mcp",
    offHint:
      "Tool calls are turned off. Do not retry until they are turned back on.",
  },
} as const satisfies Record<string, KillSwitchDefinition>;

export type KillSwitchId = keyof typeof KILL_SWITCHES;

/**
 * The switch every admitted action answers to. Total over `ActionKind`, so an
 * action kind cannot land without one; the model dispatch census proves every
 * model dispatch carries an admitted action kind.
 */
export const ACTION_KIND_KILL_SWITCH = {
  "chat.send": "chat",
  "chat.generate-thread-title": "chat",
  "chat.improve-prompt": "chat",
  "chat.table-chart": "chat",
  "chat.span-edit": "chat",
  "chat.suggest-thread-title": "chat",
  "chat.suggested-prompts": "chat",
  "chat.thread-recap": "chat",
  "chat.background": "chat",
  "workflow.start": "workflows",
  "flow.start": "flows",
  "workflow.background": "workflows",
  "flow.background": "flows",
  "editor.autocomplete": "editor-autocomplete",
  "contacts.extract-power-of-attorney": "contact-extraction",
  "clauses.rewrite": "clause-rewrite",
  "templates.prefill": "templates",
  "templates.suggest-fields": "templates",
  "templates.fill": "templates",
  "skills.rewrite-resource": "skills",
  "skills.generate-draft": "skills",
  "skills.propose-from-comments": "skills",
  "time-entries.polish-narrative": "time-narratives",
  "billing.activity-drafts": "billing-drafts",
  "entities.suggest-placements": "placement-suggestions",
  "versions.summarize": "version-summaries",
  "properties.suggest-prompt": "workflows",
  "properties.preview": "workflows",
  "search.refine": "search-assist",
  "search.summarize": "search-assist",
  "playbooks.derive-ask": "document-reviews",
  "case-law.analysis": "case-law-research",
  "case-law.search-refine": "case-law-research",
  "case-law.search-expand": "case-law-research",
  "case-law.research-answers": "case-law-research",
  "documents.bounding-boxes": "bounding-boxes",
  "documents.scan-deadlines": "deadline-scan",
  "document-reviews.parties": "document-reviews",
  "document-reviews.propose-positions": "document-reviews",
  "document-reviews.start": "document-reviews",
  "document-reviews.background": "document-reviews",
  "document-translation.start": "document-translation",
  "document-translation.background": "document-translation",
  "bilingual.prepare": "bilingual-documents",
  "bilingual.start": "bilingual-documents",
  "bilingual.background": "bilingual-documents",
  "list-verification.start": "list-verification",
  "list-verification.background": "list-verification",
  "report-export.start": "report-export",
  "report-export.background": "report-export",
  "mcp.services/call": "mcp-tools",
  "mcp.data/call": "mcp-tools",
} as const satisfies Record<ActionKind, KillSwitchId>;

/** Operator overrides; a switch the map does not name stays at its default. */
type KillSwitchOverrides = ReadonlyMap<KillSwitchId, KillSwitchState>;

const isKillSwitchId = (id: string): id is KillSwitchId =>
  Object.hasOwn(KILL_SWITCHES, id);

const killSwitchStateSchema = v.picklist(Object.values(KILL_SWITCH_STATE));

/**
 * `KILL_SWITCHES`: a JSON object of switch id to `on` or `off`. An unknown id
 * or state refuses startup, so a mistyped override cannot leave a feature on
 * unnoticed.
 */
export const killSwitchesEnvSchema = v.optional(
  v.pipe(
    v.string(),
    v.rawTransform(({ dataset, addIssue, NEVER }) => {
      const json = Result.try((): unknown => JSON.parse(dataset.value));
      if (json.isErr() || !isRecord(json.value)) {
        addIssue({
          message: 'KILL_SWITCHES must be a JSON object such as {"chat":"off"}',
        });
        return NEVER;
      }
      const overrides = new Map<KillSwitchId, KillSwitchState>();
      for (const [id, state] of Object.entries(json.value)) {
        const parsed = v.safeParse(killSwitchStateSchema, state);
        if (!isKillSwitchId(id) || !parsed.success) {
          addIssue({
            message: `KILL_SWITCHES names an unknown switch or state: ${id}`,
          });
          return NEVER;
        }
        overrides.set(id, parsed.output);
      }
      const parsedOverrides: KillSwitchOverrides = overrides;
      return parsedOverrides;
    }),
  ),
  "{}",
);
