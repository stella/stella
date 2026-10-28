import { useRef, useState } from "react";
import type { ReactNode } from "react";

import { invoke } from "@tauri-apps/api/core";
import { panic, Result } from "better-result";
import { useTranslations } from "use-intl";

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
  absorbedGroupIds,
  draftFailureMessage,
  draftRequestEntries,
  draftsByGroup,
  draftStructure,
  previousDraftResult,
  resolveStructure,
} from "./billing-draft-logic";
import type { DraftableGroup, DraftResult } from "./billing-draft-logic";
import { canAcceptStructure } from "./billing-review-state";
import type { EntryEdit, ReviewAction } from "./billing-review-state";

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

type DraftOffersOptions = {
  groups: readonly DraftableGroup[];
  sentEdits: ReadonlyMap<string, EntryEdit>;
  review: DesktopBillingDraftReview;
};

const draftOffers = ({ groups, sentEdits, review }: DraftOffersOptions) => {
  const sentGroupIds = groups.map(({ id }) => id);
  const results = draftsByGroup({ groupIds: sentGroupIds, review });
  return groups.map((group) => {
    const initial =
      sentEdits.get(group.id) ?? panic("Draft lost its starting revision");
    const draft = results.get(group.id) ?? panic("Draft missing for group");
    const result: DraftResult = { draft, sentGroupIds };
    return {
      groupId: group.id,
      initial,
      expectedRevision: initial.revision,
      result,
    };
  });
};

type BillingDraftSessionOptions = {
  snapshot: ActivityDaySnapshot;
  billingDrafts: BillingDraftSettingsControl;
  eligible: readonly DraftableGroup[];
  selected: readonly DraftableGroup[];
  matters: readonly DesktopTimeEntryMatterCandidate[];
  editable: boolean;
  editFor: (group: DraftableGroup) => EntryEdit;
  dispatch: (action: ReviewAction) => void;
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
  dispatch,
  onError,
}: BillingDraftSessionOptions) => {
  const t = useTranslations("activity");
  const [drafting, setDrafting] = useState<DraftingStatus>({ type: "idle" });
  const [consentPrompt, setConsentPrompt] = useState<ConsentPrompt>("closed");
  const [refining, setRefining] = useState<string | null>(null);
  const [earlierEntries, setEarlierEntries] = useState<
    ReadonlyMap<string, EarlierEntry>
  >(new Map());
  const [guidelines, setGuidelines] = useState<readonly CheckedGuideline[]>([]);
  const draftRequest = useRef(0);
  const busy = drafting.type === "drafting";
  const drafts = new Map(
    eligible.flatMap((group) => {
      const draft = editFor(group).draft;
      return draft === null ? [] : [[group.id, draft] as const];
    }),
  );
  const absorbed = absorbedGroupIds(
    eligible.map((group) => ({ group, content: editFor(group).content })),
  );
  const canDraft = (group: DraftableGroup) =>
    editFor(group).content.type === "single" && !absorbed.has(group.id);
  const undrafted = selected.filter(
    (group) => canDraft(group) && !drafts.has(group.id),
  );

  const applyReview = ({
    review,
    groups,
    steer,
    sentEdits,
  }: {
    review: DesktopBillingDraftReview;
    sentEdits: ReadonlyMap<string, EntryEdit>;
    groups: readonly DraftableGroup[];
    steer: string | null;
  }) => {
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
    dispatch({
      type: "offer-results",
      mode: steer === null ? "initial" : "steer",
      offers: draftOffers({ groups, sentEdits, review }),
    });
    setRefining(null);
  };

  const requestDrafts = ({
    groups: requestedGroups,
    steer,
  }: {
    groups: readonly DraftableGroup[];
    steer: string | null;
  }) => {
    const groups = requestedGroups.filter(canDraft);
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
    const sentEdits = new Map(
      groups.map((group) => [group.id, editFor(group)]),
    );
    const request = ++draftRequest.current;
    onError(null);
    setDrafting({ type: "drafting", groupIds: groups.map(({ id }) => id) });
    void Result.tryPromise({
      try: async () =>
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
      catch: draftFailureMessage,
    }).then(async (response) => {
      if (request !== draftRequest.current) {
        return undefined;
      }
      if (Result.isError(response)) {
        setDrafting({ type: "idle" });
        reportActivityError(
          DESKTOP_TELEMETRY_OPERATIONS.activityUpdate,
          DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
        );
        onError(t(response.error));
        return undefined;
      }
      const parsed = await desktopBillingDraftReviewSchema[
        "~standard"
      ].validate(response.value);
      if (request !== draftRequest.current) {
        return undefined;
      }
      setDrafting({ type: "idle" });
      if (parsed.issues !== undefined) {
        reportActivityError(
          DESKTOP_TELEMETRY_OPERATIONS.activityUpdate,
          DESKTOP_TELEMETRY_ERROR_CODES.invalidResponse,
        );
        onError(t("aiDraftFailed"));
        return undefined;
      }
      applyReview({ review: parsed.value, groups, steer, sentEdits });
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
      settingsFailed(granted);
      return undefined;
    });
  };

  const steerAll = (steer: string, remember: boolean) => {
    if (remember) {
      void billingDrafts.setPreference(steer).then(settingsFailed);
    }
    requestDrafts({
      groups: selected.filter(
        (group) => drafts.get(group.id)?.using === "draft" && canDraft(group),
      ),
      steer,
    });
  };

  const undoAll = () => {
    draftRequest.current += 1;
    setDrafting({ type: "idle" });
    dispatch({ type: "undo-all" });
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
    const edit = editFor(group);
    const target = { groupId: group.id, initial: edit };
    const structure = draftStructure(state.result.draft);
    const proposedStructure = structure
      ? resolveStructure({
          structure,
          groupIds: state.result.sentGroupIds,
          candidates: matters,
        })
      : null;
    const acceptance =
      proposedStructure === null
        ? null
        : ({
            type: "accept-structure",
            ...target,
            proposal: proposedStructure,
            groups: eligible.map((entry) => ({
              group: entry,
              initial: editFor(entry),
            })),
          } as const satisfies ReviewAction);
    const applicable =
      acceptance !== null &&
      canAcceptStructure(
        new Map(eligible.map((entry) => [entry.id, editFor(entry)])),
        acceptance,
      );
    return (
      <BillingDraftEntryReview
        state={state}
        content={edit.content}
        proposedStructure={applicable ? proposedStructure : null}
        earlierEntries={earlierEntries}
        editable={editable}
        busy={busy}
        refining={refining === group.id}
        onUseOriginal={() => dispatch({ type: "use-original", ...target })}
        onUseDraft={() => dispatch({ type: "use-draft", ...target })}
        onAcceptProposal={() => dispatch({ type: "apply-proposal", ...target })}
        onDismissProposal={() =>
          dispatch({ type: "dismiss-proposal", ...target })
        }
        onApplyStructure={() => {
          if (acceptance !== null) {
            dispatch(acceptance);
          }
        }}
        onUndoStructure={() => dispatch({ type: "undo-structure", ...target })}
        onRefine={() => setRefining(group.id)}
        onCancelRefine={() => setRefining(null)}
        onSteer={(steer) => requestDrafts({ groups: [group], steer })}
      />
    );
  };

  const offered =
    snapshot.timeBillingEnabled && billingDrafts.settings.type === "ready";
  const steering =
    billingDrafts.settings.type === "ready" &&
    eligible.some(
      (group) => drafts.get(group.id)?.using === "draft" && canDraft(group),
    );
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
