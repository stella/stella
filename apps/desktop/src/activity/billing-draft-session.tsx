import { useRef, useState } from "react";
import type { ReactNode } from "react";

import { invoke } from "@tauri-apps/api/core";
import { panic, Result } from "better-result";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import {
  DESKTOP_BILLING_DRAFT_LIMITS,
  desktopBillingDraftReviewSchema,
} from "@stll/api-contract/desktop-billing-drafts";
import type { DesktopBillingDraftReview } from "@stll/api-contract/desktop-billing-drafts";
import type { DesktopTimeEntryMatterCandidate } from "@stll/api-contract/desktop-time-entries";
import { Temporal } from "@stll/time";

import {
  DESKTOP_TELEMETRY_ERROR_CODES,
  DESKTOP_TELEMETRY_OPERATIONS,
} from "../telemetry/desktop-telemetry";
import { reportActivityError } from "./activity-telemetry";
import type { ActivityDaySnapshot } from "./activity-types";
import {
  BillingDraftConsentDialog,
  BillingDraftEntryReview,
  BillingDraftGuidelines,
  BillingDraftShimmer,
  BillingDraftSteerBar,
} from "./ActivityBillingDrafts";
import type { BillingDraftSettingsControl } from "./ActivityBillingDrafts";
import {
  draftRequestEntries,
  draftsByGroup,
  draftScalars,
  draftStructure,
  previousDraftResult,
  resolveStructure,
} from "./billing-draft-logic";
import type {
  DraftableGroup,
  DraftEntryState,
  DraftResult,
  EntryEdit,
} from "./billing-draft-logic";

type DraftingStatus =
  { type: "idle" } | { type: "drafting"; groupIds: readonly string[] };
type ConsentPrompt = "closed" | "open" | "saving";
type EarlierEntry = DesktopBillingDraftReview["earlierEntries"][number];
type CheckedGuideline =
  DesktopBillingDraftReview["result"]["checkedGuidelines"][number];

export type DraftStatus = "draft" | "drafting" | "drafted" | "tooMany";

export type ReviewBarDrafts = {
  status: DraftStatus;
  undoable: boolean;
  onDraft: () => void;
  onUndoAll: () => void;
};

type DraftStatusOptions = {
  busy: boolean;
  undrafted: number;
  selected: number;
};

const draftStatus = ({
  busy,
  undrafted,
  selected,
}: DraftStatusOptions): DraftStatus => {
  if (busy) {
    return "drafting";
  }
  if (selected > 0 && undrafted === 0) {
    return "drafted";
  }
  return undrafted > DESKTOP_BILLING_DRAFT_LIMITS.entries ? "tooMany" : "draft";
};

/** The scalar outcome of a draft applied to an entry; structure stays a
 * separate, explicit acceptance. */
const withDraft = (edit: EntryEdit, { draft }: DraftResult) => {
  const scalars = draftScalars(draft);
  return {
    narrative: scalars.narrative,
    classification: scalars.classification,
    billable: scalars.billable ?? edit.billable,
    structure: null,
  };
};

const originalEdit = (state: DraftEntryState) => ({
  narrative: state.original.narrative,
  billable: state.original.billable,
  classification: null,
  structure: null,
});

type BillingDraftSessionOptions = {
  snapshot: ActivityDaySnapshot;
  billingDrafts: BillingDraftSettingsControl;
  eligible: readonly DraftableGroup[];
  selected: readonly DraftableGroup[];
  matters: readonly DesktopTimeEntryMatterCandidate[];
  editable: boolean;
  editFor: (group: DraftableGroup) => EntryEdit;
  update: (group: DraftableGroup, change: Partial<EntryEdit>) => void;
  onError: (message: string | null) => void;
};

/**
 * AI drafting for one day review: what was drafted for which group, the
 * request in flight, and every way back to the recorded text. Edits stay owned
 * by the review; this session only proposes and applies changes to them.
 */
export const useBillingDraftSession = ({
  snapshot,
  billingDrafts,
  eligible,
  selected,
  matters,
  editable,
  editFor,
  update,
  onError,
}: BillingDraftSessionOptions) => {
  const t = useTranslations("activity");
  const [drafts, setDrafts] = useState<ReadonlyMap<string, DraftEntryState>>(
    new Map(),
  );
  const [drafting, setDrafting] = useState<DraftingStatus>({ type: "idle" });
  const [consentPrompt, setConsentPrompt] = useState<ConsentPrompt>("closed");
  const [refining, setRefining] = useState<string | null>(null);
  const [earlierEntries, setEarlierEntries] = useState<
    ReadonlyMap<string, EarlierEntry>
  >(new Map());
  const [guidelines, setGuidelines] = useState<readonly CheckedGuideline[]>([]);
  const draftRequest = useRef(0);
  const busy = drafting.type === "drafting";
  const undrafted = selected.filter((group) => !drafts.has(group.id));

  const setDraftState = (groupId: string, state: DraftEntryState) =>
    setDrafts((current) => new Map(current).set(groupId, state));

  const applyReview = ({
    review,
    groups,
    steer,
  }: {
    review: DesktopBillingDraftReview;
    groups: readonly DraftableGroup[];
    steer: string | null;
  }) => {
    const sentGroupIds = groups.map(({ id }) => id);
    const results = draftsByGroup({ groupIds: sentGroupIds, review });
    setEarlierEntries((current) => {
      const next = new Map(current);
      for (const entry of review.earlierEntries) {
        next.set(entry.id, entry);
      }
      return next;
    });
    setGuidelines((current) => {
      const next = new Map(current.map((file) => [file.fileId, file]));
      for (const file of review.result.checkedGuidelines) {
        next.set(file.fileId, file);
      }
      return [...next.values()];
    });
    const next = new Map(drafts);
    for (const group of groups) {
      const draft = results.get(group.id) ?? panic("Draft missing for group");
      const result: DraftResult = { draft, sentGroupIds };
      const existing = drafts.get(group.id);
      if (steer !== null && existing) {
        next.set(group.id, { ...existing, proposal: result });
        continue;
      }
      const edit = editFor(group);
      next.set(group.id, {
        original: existing?.original ?? {
          narrative: edit.narrative,
          billable: edit.billable,
        },
        result,
        using: "draft",
        proposal: null,
      });
      update(group, withDraft(edit, result));
    }
    setDrafts(next);
    setRefining(null);
  };

  const requestDrafts = ({
    groups,
    steer,
  }: {
    groups: readonly DraftableGroup[];
    steer: string | null;
  }) => {
    if (groups.length === 0 || busy) {
      return;
    }
    const previous = groups.map((group) => drafts.get(group.id));
    const previousResult =
      steer !== null && previous.every((state) => state !== undefined)
        ? previousDraftResult(
            groups.map((group, index) => ({
              groupId: group.id,
              result:
                previous.at(index)?.result ??
                panic("Steered group lost its draft"),
            })),
          )
        : null;
    const request = ++draftRequest.current;
    onError(null);
    setDrafting({ type: "drafting", groupIds: groups.map(({ id }) => id) });
    void Result.tryPromise(
      async () =>
        await invoke<unknown>("billing_draft_create_confirmed", {
          request: {
            entries: draftRequestEntries({
              groups,
              date: snapshot.date,
              timezone: Temporal.Now.timeZoneId(),
              captureDetails: snapshot.captureDetails,
            }),
            ...(steer === null ? {} : { steer }),
            ...(previousResult === null ? {} : { previousResult }),
          },
        }),
    ).then((response) => {
      if (request !== draftRequest.current) {
        return undefined;
      }
      setDrafting({ type: "idle" });
      if (Result.isError(response)) {
        reportActivityError(
          DESKTOP_TELEMETRY_OPERATIONS.activityUpdate,
          DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
        );
        onError(t("aiDraftFailed"));
        return undefined;
      }
      const parsed = v.safeParse(
        desktopBillingDraftReviewSchema,
        response.value,
      );
      if (!parsed.success) {
        reportActivityError(
          DESKTOP_TELEMETRY_OPERATIONS.activityUpdate,
          DESKTOP_TELEMETRY_ERROR_CODES.invalidResponse,
        );
        onError(t("aiDraftFailed"));
        return undefined;
      }
      applyReview({ review: parsed.output, groups, steer });
      return undefined;
    });
  };

  const settingsFailed = (saved: boolean) => {
    if (!saved) {
      onError(t("aiSettingsFailed"));
    }
    return undefined;
  };

  const startDrafting = () => {
    if (billingDrafts.settings.type !== "ready") {
      return;
    }
    if (billingDrafts.settings.consent !== "granted") {
      setConsentPrompt("open");
      return;
    }
    requestDrafts({ groups: undrafted, steer: null });
  };

  const allowDrafting = () => {
    setConsentPrompt("saving");
    void billingDrafts.setConsent("granted").then((granted) => {
      setConsentPrompt("closed");
      if (granted) {
        requestDrafts({ groups: undrafted, steer: null });
      }
      return settingsFailed(granted);
    });
  };

  const steerAll = (steer: string, remember: boolean) => {
    if (remember) {
      void billingDrafts.setPreference(steer).then(settingsFailed);
    }
    requestDrafts({
      groups: selected.filter(
        (group) => drafts.get(group.id)?.using === "draft",
      ),
      steer,
    });
  };

  const undoAll = () => {
    draftRequest.current += 1;
    setDrafting({ type: "idle" });
    for (const group of eligible) {
      const state = drafts.get(group.id);
      if (state) {
        update(group, originalEdit(state));
      }
    }
    setDrafts(new Map());
    setRefining(null);
    setGuidelines([]);
  };

  const draftReview = (group: DraftableGroup): ReactNode => {
    if (busy && drafting.groupIds.includes(group.id)) {
      return <BillingDraftShimmer />;
    }
    const state = drafts.get(group.id);
    if (!state) {
      return null;
    }
    return (
      <SessionEntryReview
        state={state}
        edit={editFor(group)}
        matters={matters}
        earlierEntries={earlierEntries}
        editable={editable}
        busy={busy}
        refining={refining === group.id}
        onState={(next) => setDraftState(group.id, next)}
        onEdit={(change) => update(group, change)}
        onRefining={(next) => setRefining(next ? group.id : null)}
        onSteer={(steer) => requestDrafts({ groups: [group], steer })}
      />
    );
  };

  const offered =
    snapshot.timeBillingEnabled && billingDrafts.settings.type === "ready";
  const steering =
    billingDrafts.settings.type === "ready" &&
    [...drafts.values()].some(({ using }) => using === "draft");
  const preference =
    billingDrafts.settings.type === "ready"
      ? billingDrafts.settings.preference
      : null;

  return {
    busy,
    bar: offered
      ? {
          status: draftStatus({
            busy,
            undrafted: undrafted.length,
            selected: selected.length,
          }),
          undoable: drafts.size > 0,
          onDraft: startDrafting,
          onUndoAll: undoAll,
        }
      : null,
    draftReview,
    steerBar: steering ? (
      <BillingDraftSteerBar
        disabled={!editable || busy}
        preference={preference}
        onSteer={steerAll}
        onForgetPreference={() => {
          void billingDrafts.setPreference(null).then(settingsFailed);
        }}
      />
    ) : null,
    guidelines: <BillingDraftGuidelines files={guidelines} />,
    consentDialog: (
      <BillingDraftConsentDialog
        open={consentPrompt !== "closed"}
        pending={consentPrompt === "saving"}
        onAllow={allowDrafting}
        onClose={() => setConsentPrompt("closed")}
      />
    ),
  };
};

type SessionEntryReviewProps = {
  state: DraftEntryState;
  edit: EntryEdit;
  matters: readonly DesktopTimeEntryMatterCandidate[];
  earlierEntries: ReadonlyMap<string, EarlierEntry>;
  editable: boolean;
  busy: boolean;
  refining: boolean;
  onState: (state: DraftEntryState) => void;
  onEdit: (change: Partial<EntryEdit>) => void;
  onRefining: (refining: boolean) => void;
  onSteer: (steer: string) => void;
};

/** One entry's draft and the actions that move between it, its original and
 * a pending proposal. */
const SessionEntryReview = ({
  state,
  edit,
  matters,
  earlierEntries,
  editable,
  busy,
  refining,
  onState,
  onEdit,
  onRefining,
  onSteer,
}: SessionEntryReviewProps) => {
  const structure = draftStructure(state.result.draft);
  const proposedStructure = structure
    ? resolveStructure({
        structure,
        groupIds: state.result.sentGroupIds,
        candidates: matters,
      })
    : null;
  return (
    <BillingDraftEntryReview
      state={state}
      narrative={edit.narrative}
      structure={edit.structure}
      proposedStructure={proposedStructure}
      earlierEntries={earlierEntries}
      editable={editable}
      busy={busy}
      refining={refining}
      onUseOriginal={() => {
        onState({
          original: state.original,
          result: state.result,
          using: "original",
          proposal: null,
        });
        onEdit(originalEdit(state));
      }}
      onUseDraft={() => {
        onState({
          original: state.original,
          result: state.result,
          using: "draft",
          proposal: state.proposal,
        });
        onEdit(withDraft(edit, state.result));
      }}
      onAcceptProposal={() => {
        if (!state.proposal) {
          return;
        }
        onState({
          original: state.original,
          result: state.proposal,
          using: "draft",
          proposal: null,
        });
        onEdit(withDraft(edit, state.proposal));
      }}
      onDismissProposal={() =>
        onState({
          original: state.original,
          result: state.result,
          using: state.using,
          proposal: null,
        })
      }
      onApplyStructure={() => {
        if (proposedStructure) {
          onEdit({ structure: proposedStructure });
        }
      }}
      onUndoStructure={() => onEdit({ structure: null })}
      onRefine={() => onRefining(true)}
      onCancelRefine={() => onRefining(false)}
      onSteer={onSteer}
    />
  );
};
