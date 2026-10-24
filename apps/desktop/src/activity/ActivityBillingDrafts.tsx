import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { invoke } from "@tauri-apps/api/core";
import { panic, Result } from "better-result";
import { useFormatter, useLocale, useTranslations } from "use-intl";
import * as v from "valibot";

import {
  DESKTOP_BILLING_DRAFT_LIMITS,
  desktopBillingDraftSettingsResponseSchema,
} from "@stll/api-contract/desktop-billing-drafts";
import type {
  DesktopBillingDraftResponse,
  DesktopBillingDraftReview,
} from "@stll/api-contract/desktop-billing-drafts";
import type { DesktopTimeEntryClassification } from "@stll/api-contract/desktop-time-entries";
import { AiLabel } from "@stll/ui/ai-label";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { Checkbox } from "@stll/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";
import {
  AiActionIcon,
  AlertTriangleIcon,
  LaptopIcon,
  ServerIcon,
  XIcon,
} from "@stll/ui/icons";
import { Input } from "@stll/ui/input";
import { Label } from "@stll/ui/label";
import { ReviewDiffText } from "@stll/ui/review-diff-text";
import { diffWords } from "@stll/ui/review-word-diff";
import { Skeleton } from "@stll/ui/skeleton";

import {
  DESKTOP_TELEMETRY_ERROR_CODES,
  DESKTOP_TELEMETRY_OPERATIONS,
} from "../telemetry/desktop-telemetry";
import { calendarDate } from "./activity-logic";
import { reportActivityError } from "./activity-telemetry";
import {
  draftScalars,
  draftStructure,
  summarizeStructure,
} from "./billing-draft-logic";
import type {
  AcceptedStructure,
  DraftEntryState,
  DraftStructure,
  StructureSummary,
} from "./billing-draft-logic";

export type BillingDraftSettings =
  | { type: "loading" }
  | { type: "unavailable" }
  | {
      type: "ready";
      consent: "granted" | "revoked";
      preference: string | null;
    };

export type BillingDraftSettingsControl = {
  settings: BillingDraftSettings;
  setConsent: (consent: "granted" | "revoked") => Promise<boolean>;
  setPreference: (preference: string | null) => Promise<boolean>;
};

const settingsFrom = (value: unknown): BillingDraftSettings | null => {
  const parsed = v.safeParse(desktopBillingDraftSettingsResponseSchema, value);
  if (!parsed.success) {
    return null;
  }
  if (parsed.output.organizationMode === "disabled") {
    return { type: "unavailable" };
  }
  return {
    type: "ready",
    consent: parsed.output.consent,
    preference: parsed.output.preference,
  };
};

/**
 * The organization's AI drafting mode and the user's own consent and
 * preference. Drafting is offered only when both gates are open; a failed read
 * leaves it absent rather than guessing.
 */
export const useBillingDraftSettings = (
  enabled: boolean,
): BillingDraftSettingsControl => {
  const [loaded, setSettings] = useState<BillingDraftSettings>({
    type: "loading",
  });
  const settings: BillingDraftSettings = enabled
    ? loaded
    : { type: "unavailable" };
  const request = useRef(0);
  useEffect(() => {
    const current = ++request.current;
    if (!enabled) {
      return undefined;
    }
    invoke<unknown>("billing_draft_get_settings")
      .then((value) => {
        if (current !== request.current) {
          return undefined;
        }
        const next = settingsFrom(value);
        if (next === null) {
          reportActivityError(
            DESKTOP_TELEMETRY_OPERATIONS.activityRead,
            DESKTOP_TELEMETRY_ERROR_CODES.invalidResponse,
          );
        }
        setSettings(next ?? { type: "unavailable" });
        return undefined;
      })
      .catch(() => {
        if (current === request.current) {
          reportActivityError(
            DESKTOP_TELEMETRY_OPERATIONS.activityRead,
            DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
          );
          setSettings({ type: "unavailable" });
        }
      });
    return () => {
      request.current += 1;
    };
  }, [enabled]);
  const update = useCallback(
    async (command: string, args: Record<string, unknown>) => {
      const current = ++request.current;
      const response = await Result.tryPromise(
        async () => await invoke<unknown>(command, args),
      );
      if (Result.isError(response)) {
        reportActivityError(
          DESKTOP_TELEMETRY_OPERATIONS.activityUpdate,
          DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
        );
        return false;
      }
      const next = settingsFrom(response.value);
      if (next === null) {
        reportActivityError(
          DESKTOP_TELEMETRY_OPERATIONS.activityUpdate,
          DESKTOP_TELEMETRY_ERROR_CODES.invalidResponse,
        );
        return false;
      }
      if (current === request.current) {
        setSettings(next);
      }
      return true;
    },
    [],
  );
  return {
    settings,
    setConsent: async (consent) =>
      await update("billing_draft_set_consent", { consent }),
    setPreference: async (preference) =>
      await update("billing_draft_set_preference", { preference }),
  };
};

type ConsentDialogProps = {
  open: boolean;
  pending: boolean;
  onAllow: () => void;
  onClose: () => void;
};

export const BillingDraftConsentDialog = ({
  open,
  pending,
  onAllow,
  onClose,
}: ConsentDialogProps) => {
  const t = useTranslations("activity");
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
    >
      <DialogPopup className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("aiConsentTitle")}</DialogTitle>
          <DialogDescription>{t("aiConsentBody")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 px-6 sm:grid-cols-2">
          <ConsentColumn
            icon={<LaptopIcon aria-hidden="true" className="size-3.5" />}
            title={t("aiConsentSentTitle")}
            items={[
              t("aiConsentSentMatter"),
              t("aiConsentSentApps"),
              t("aiConsentSentTitles"),
            ]}
          />
          <ConsentColumn
            icon={<ServerIcon aria-hidden="true" className="size-3.5" />}
            title={t("aiConsentServerTitle")}
            items={[
              t("aiConsentServerHistory"),
              t("aiConsentServerFirm"),
              t("aiConsentServerClient"),
            ]}
          />
        </div>
        <p className="text-muted-foreground px-6 text-xs leading-relaxed">
          {t("aiConsentNeverSent")} {t("aiConsentRevocable")}
        </p>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            {t("aiConsentDecline")}
          </DialogClose>
          <Button disabled={pending} onClick={onAllow}>
            <AiActionIcon aria-hidden="true" />
            {t("aiConsentAllow")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};

type ConsentColumnProps = {
  icon: ReactNode;
  title: string;
  items: readonly string[];
};

const ConsentColumn = ({ icon, title, items }: ConsentColumnProps) => (
  <section className="rounded-lg border px-3 py-2.5 text-xs">
    <h3 className="mb-1.5 flex items-center gap-1.5 font-semibold">
      {icon}
      {title}
    </h3>
    <ul className="text-muted-foreground flex list-disc flex-col gap-1 ps-4">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  </section>
);

const STEER_CHIPS = [
  "aiSteerShorter",
  "aiSteerMoreDetail",
  "aiSteerClientFriendly",
] as const;

type SteerInputProps = {
  id: string;
  disabled: boolean;
  placeholder: string;
  /** Offers to keep the instruction as the user's own drafting preference. */
  remember: "offered" | "hidden";
  submitLabel: string;
  onSteer: (steer: string, remember: boolean) => void;
  onCancel?: () => void;
};

/** A plain-text adjustment with quick chips, for every draft or for one. */
export const BillingDraftSteerInput = ({
  id,
  disabled,
  placeholder,
  remember,
  submitLabel,
  onSteer,
  onCancel,
}: SteerInputProps) => {
  const t = useTranslations("activity");
  const locale = useLocale();
  const [text, setText] = useState("");
  const [keep, setKeep] = useState(false);
  const language = new Intl.DisplayNames([locale], { type: "language" }).of(
    locale,
  );
  const chips = [
    ...STEER_CHIPS.map((key) => t(key)),
    ...(language ? [t("aiSteerWriteIn", { language })] : []),
  ];
  const steer = text.trim();
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (steer.length === 0 || disabled) {
          return;
        }
        onSteer(steer, remember === "offered" && keep);
        setText("");
      }}
    >
      <div className="flex items-center gap-2">
        <AiActionIcon
          aria-hidden="true"
          className="text-muted-foreground size-4 shrink-0"
        />
        <Input
          id={id}
          aria-label={placeholder}
          className="h-8 flex-1"
          disabled={disabled}
          maxLength={DESKTOP_BILLING_DRAFT_LIMITS.steerLength}
          placeholder={placeholder}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <Button
          size="sm"
          type="submit"
          disabled={disabled || steer.length === 0}
        >
          {submitLabel}
        </Button>
        {onCancel ? (
          <Button size="sm" type="button" variant="ghost" onClick={onCancel}>
            {t("cancel")}
          </Button>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 ps-6">
        {chips.map((chip) => (
          <Button
            key={chip}
            size="xs"
            type="button"
            variant="outline"
            disabled={disabled}
            onClick={() => setText(chip)}
          >
            {chip}
          </Button>
        ))}
        {remember === "offered" ? (
          <Label className="text-muted-foreground ms-auto gap-1.5 text-xs">
            <Checkbox
              checked={keep}
              disabled={disabled}
              onCheckedChange={setKeep}
            />
            {t("aiSteerRemember")}
          </Label>
        ) : null}
      </div>
    </form>
  );
};

type SteerBarProps = {
  disabled: boolean;
  preference: string | null;
  onSteer: (steer: string, remember: boolean) => void;
  onForgetPreference: () => void;
};

export const BillingDraftSteerBar = ({
  disabled,
  preference,
  onSteer,
  onForgetPreference,
}: SteerBarProps) => {
  const t = useTranslations("activity");
  return (
    <section className="bg-card flex flex-col gap-2 rounded-xl border px-4 py-3">
      <BillingDraftSteerInput
        id="billing-draft-steer"
        disabled={disabled}
        placeholder={t("aiSteerAllPlaceholder")}
        remember="offered"
        submitLabel={t("aiSteerApply")}
        onSteer={onSteer}
      />
      {preference ? (
        <p className="text-muted-foreground flex items-center gap-1.5 ps-6 text-xs">
          {t("aiPreferenceRemembered")}
          <span className="bg-muted inline-flex items-center gap-1 rounded-full py-0.5 ps-2.5 pe-1">
            <BidiText as="span" className="max-w-64 truncate">
              {preference}
            </BidiText>
            <Button
              aria-label={t("aiPreferenceForget")}
              size="icon-xs"
              variant="ghost"
              disabled={disabled}
              onClick={onForgetPreference}
            >
              <XIcon aria-hidden="true" />
            </Button>
          </span>
        </p>
      ) : null}
    </section>
  );
};

export const BillingDraftShimmer = () => (
  <div aria-hidden="true" className="mt-2 flex flex-col gap-1.5 px-2">
    <Skeleton className="h-3 w-11/12" />
    <Skeleton className="h-3 w-2/3" />
  </div>
);

type EarlierEntry = DesktopBillingDraftReview["earlierEntries"][number];

type EntryReviewProps = {
  state: DraftEntryState;
  narrative: string;
  structure: AcceptedStructure | null;
  /** Applying needs the proposal's targets resolved; null when it cannot apply. */
  proposedStructure: AcceptedStructure | null;
  earlierEntries: ReadonlyMap<string, EarlierEntry>;
  editable: boolean;
  busy: boolean;
  refining: boolean;
  onUseOriginal: () => void;
  onUseDraft: () => void;
  onAcceptProposal: () => void;
  onDismissProposal: () => void;
  onApplyStructure: () => void;
  onUndoStructure: () => void;
  onRefine: () => void;
  onCancelRefine: () => void;
  onSteer: (steer: string) => void;
};

/** What AI changed for one entry, and every way to take it back. */
export const BillingDraftEntryReview = ({
  state,
  narrative,
  structure,
  proposedStructure,
  earlierEntries,
  editable,
  busy,
  refining,
  onUseOriginal,
  onUseDraft,
  onAcceptProposal,
  onDismissProposal,
  onApplyStructure,
  onUndoStructure,
  onRefine,
  onCancelRefine,
  onSteer,
}: EntryReviewProps) => {
  const t = useTranslations("activity");
  const tDisclosure = useTranslations("aiDisclosure");
  const { draft } = state.result;
  if (state.using === "original") {
    return (
      <p className="text-muted-foreground mt-1 flex items-center gap-1 px-2 text-xs">
        {t("aiUsingOriginal")} ·
        <Button
          size="xs"
          variant="link"
          className="h-auto px-0.5"
          disabled={!editable || busy}
          onClick={onUseDraft}
        >
          {t("aiUseDraft")}
        </Button>
      </p>
    );
  }
  const matched = draft.matchedEarlierEntryIds.flatMap((id) => {
    const entry = earlierEntries.get(id);
    return entry ? [entry] : [];
  });
  const draftStructureProposal = draftStructure(draft);
  return (
    <div className="mt-1 flex flex-col gap-2 px-2">
      <div className="text-muted-foreground flex flex-wrap items-center gap-1 text-xs">
        <AiLabel
          label={t("aiDraftLabel")}
          disclosure={tDisclosure("billingDrafts")}
        />
        ·
        <Button
          size="xs"
          variant="link"
          className="h-auto px-0.5"
          disabled={!editable || busy}
          onClick={onUseOriginal}
        >
          {t("aiUseOriginal")}
        </Button>
        ·
        <Button
          size="xs"
          variant="link"
          className="h-auto gap-1 px-0.5"
          disabled={!editable || busy}
          onClick={onRefine}
        >
          <AiActionIcon aria-hidden="true" className="size-3" />
          {t("aiRefine")}
        </Button>
        <ClassificationCodes classification={draft.classification} />
      </div>
      {draft.flags.map((flag) => (
        <div
          key={`${flag.ruleRef.fileId}:${flag.ruleRef.section}:${flag.text}`}
          className="bg-warning/10 flex items-start gap-2 rounded-lg px-2.5 py-2 text-xs"
        >
          <AlertTriangleIcon
            aria-hidden="true"
            className="text-warning-foreground mt-0.5 size-3.5 shrink-0"
          />
          <div className="min-w-0 flex-1">
            <p>{flag.text}</p>
            <p className="text-muted-foreground">
              <BidiText as="span">{flag.ruleRef.fileName}</BidiText> ·{" "}
              <BidiText as="span">{flag.ruleRef.section}</BidiText>
            </p>
          </div>
          {flag.fix === "split" &&
          draftStructureProposal?.type === "split" &&
          proposedStructure !== null &&
          structure === null ? (
            <Button
              size="xs"
              variant="outline"
              disabled={!editable || busy}
              onClick={onApplyStructure}
            >
              {t("aiSplitInto", {
                count: draftStructureProposal.parts.length,
              })}
            </Button>
          ) : null}
        </div>
      ))}
      <StructureLine
        proposal={draftStructureProposal}
        applicable={proposedStructure !== null}
        applied={structure}
        disabled={!editable || busy}
        onApply={onApplyStructure}
        onUndo={onUndoStructure}
      />
      {matched.length > 0 ? <EarlierEntries entries={matched} /> : null}
      {state.proposal ? (
        <ProposalReview
          current={narrative}
          proposal={state.proposal.draft}
          disabled={!editable || busy}
          onAccept={onAcceptProposal}
          onDismiss={onDismissProposal}
        />
      ) : null}
      {refining ? (
        <BillingDraftSteerInput
          id={`billing-draft-refine-${draft.entryId}`}
          disabled={busy}
          placeholder={t("aiRefinePlaceholder")}
          remember="hidden"
          submitLabel={t("aiSteerApply")}
          onSteer={(steer) => onSteer(steer)}
          onCancel={onCancelRefine}
        />
      ) : null}
    </div>
  );
};

const ClassificationCodes = ({
  classification,
}: {
  classification: DesktopTimeEntryClassification;
}) => {
  const t = useTranslations("activity");
  switch (classification.type) {
    case "ledes":
      return (
        <span className="ms-auto flex gap-1.5 tabular-nums">
          <code
            className="text-foreground text-2xs rounded-md border px-1.5"
            title={t("aiTaskCode")}
          >
            {classification.taskCode}
          </code>
          <code
            className="text-foreground text-2xs rounded-md border px-1.5"
            title={t("aiActivityCode")}
          >
            {classification.activityCode}
          </code>
        </span>
      );
    // Matter entries bill to the client group; a chip would repeat it on every row.
    case "activity_group":
      return null;
    default:
      classification satisfies never;
      return panic("Unknown time entry classification");
  }
};

type StructureLineProps = {
  proposal: DraftStructure | null;
  applicable: boolean;
  applied: AcceptedStructure | null;
  disabled: boolean;
  onApply: () => void;
  onUndo: () => void;
};

const StructureLine = ({
  proposal,
  applicable,
  applied,
  disabled,
  onApply,
  onUndo,
}: StructureLineProps) => {
  const t = useTranslations("activity");
  const summary = useStructureSummary();
  if (applied) {
    return (
      <p className="flex flex-wrap items-center gap-1 text-xs">
        <span className="font-medium">{t("aiApplied")}</span>
        {summary(applied.summary)}
        <Button
          size="xs"
          variant="link"
          className="h-auto px-0.5"
          disabled={disabled}
          onClick={onUndo}
        >
          {t("aiUndo")}
        </Button>
      </p>
    );
  }
  if (!proposal || !applicable) {
    return null;
  }
  return (
    <p className="flex flex-wrap items-center gap-1 text-xs">
      <span className="text-muted-foreground">{t("aiProposes")}</span>
      {summary(summarizeStructure(proposal))}
      <Button
        size="xs"
        variant="outline"
        className="ms-1"
        disabled={disabled}
        onClick={onApply}
      >
        {t("aiApply")}
      </Button>
    </p>
  );
};

const useStructureSummary = () => {
  const t = useTranslations("activity");
  const format = useFormatter();
  const hours = (minutes: number) =>
    t("hours", {
      hours: format.number(minutes / 60, {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }),
    });
  return (summary: StructureSummary) => {
    switch (summary.type) {
      case "split":
        return t("aiSplitSummary", { count: summary.parts });
      case "move":
        return t("aiMoveSummary", {
          hours: hours(summary.minutes),
          matter: summary.matter,
        });
      case "merge":
        return t("aiMergeSummary", { count: summary.entries });
      default:
        summary satisfies never;
        return panic("Unknown billing draft structure");
    }
  };
};

const EarlierEntries = ({ entries }: { entries: readonly EarlierEntry[] }) => {
  const t = useTranslations("activity");
  const format = useFormatter();
  return (
    <details className="text-muted-foreground text-xs">
      <summary className="cursor-pointer">
        {t("aiConsistentWith", { count: entries.length })}
      </summary>
      <ul className="mt-1.5 flex flex-col gap-1">
        {entries.map((entry) => (
          <li
            key={entry.id}
            className="grid grid-cols-[5.5rem_3rem_minmax(0,1fr)] gap-2 tabular-nums"
          >
            <span>
              {format.dateTime(calendarDate(entry.dateWorked), {
                dateStyle: "medium",
              })}
            </span>
            <span>
              {t("hours", {
                hours: format.number(entry.durationMinutes / 60, {
                  minimumFractionDigits: 1,
                  maximumFractionDigits: 1,
                }),
              })}
            </span>
            <BidiText as="span" className="min-w-0 wrap-break-word">
              {entry.narrative}
            </BidiText>
          </li>
        ))}
      </ul>
    </details>
  );
};

type ProposalReviewProps = {
  current: string;
  proposal: DesktopBillingDraftResponse["drafts"][number];
  disabled: boolean;
  onAccept: () => void;
  onDismiss: () => void;
};

/** A steering result shown as a tracked change against the current text;
 * nothing applies until it is accepted. */
const ProposalReview = ({
  current,
  proposal,
  disabled,
  onAccept,
  onDismiss,
}: ProposalReviewProps) => {
  const t = useTranslations("activity");
  const summary = useStructureSummary();
  const scalars = draftScalars(proposal);
  const structure = draftStructure(proposal);
  return (
    <div className="bg-muted/50 flex flex-col gap-1.5 rounded-lg border px-2.5 py-2 text-xs">
      <ReviewDiffText
        className="text-sm leading-relaxed"
        segments={diffWords(current, scalars.narrative).map(
          ({ type, token }) => ({ type, text: token }),
        )}
      />
      {structure || scalars.billable !== null ? (
        <p className="text-muted-foreground">
          {t("aiProposes")}{" "}
          {[
            ...(structure ? [summary(summarizeStructure(structure))] : []),
            ...(scalars.billable === null
              ? []
              : [scalars.billable ? t("aiBillable") : t("aiNotBillable")]),
          ].join(" · ")}
        </p>
      ) : null}
      <div className="flex gap-1.5">
        <Button size="xs" disabled={disabled} onClick={onAccept}>
          {t("aiAccept")}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={disabled}
          onClick={onDismiss}
        >
          {t("aiUndo")}
        </Button>
      </div>
    </div>
  );
};

export const BillingDraftGuidelines = ({
  files,
}: {
  files: readonly DesktopBillingDraftResponse["checkedGuidelines"][number][];
}) => {
  const t = useTranslations("activity");
  if (files.length === 0) {
    return null;
  }
  return (
    <p className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-xs">
      {t("aiCheckedAgainst")}
      {files.map((file) => (
        <BidiText
          as="span"
          key={file.fileId}
          className="bg-muted rounded-full px-2 py-0.5"
        >
          {file.fileName}
        </BidiText>
      ))}
    </p>
  );
};

type SettingsControlProps = {
  control: BillingDraftSettingsControl;
};

/** The personal gate in activity settings: consent and the remembered
 * preference, both revocable. */
export const BillingDraftSettingsSection = ({
  control,
}: SettingsControlProps) => {
  const t = useTranslations("activity");
  const [failed, setFailed] = useState(false);
  const { settings } = control;
  if (settings.type !== "ready") {
    return null;
  }
  const run = (action: () => Promise<boolean>) => {
    setFailed(false);
    void action().then((ok) => {
      setFailed(!ok);
      return undefined;
    });
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="flex flex-col">
          <span className="text-sm">{t("aiSettingsTitle")}</span>
          <span className="text-muted-foreground text-xs">
            {settings.consent === "granted"
              ? t("aiSettingsGranted")
              : t("aiSettingsRevoked")}
          </span>
        </span>
        {settings.consent === "granted" ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => run(async () => await control.setConsent("revoked"))}
          >
            {t("aiSettingsRevoke")}
          </Button>
        ) : null}
      </div>
      {settings.preference ? (
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground min-w-0 text-xs">
            {t("aiPreferenceRemembered")}{" "}
            <BidiText as="span" className="text-foreground">
              {settings.preference}
            </BidiText>
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => run(async () => await control.setPreference(null))}
          >
            {t("aiPreferenceForget")}
          </Button>
        </div>
      ) : null}
      {failed ? (
        <p role="alert" className="text-destructive text-xs">
          {t("aiSettingsFailed")}
        </p>
      ) : null}
    </div>
  );
};
