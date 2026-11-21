import type { ReactNode } from "react";

import {
  ButtonFace,
  FaceLabelPending,
  FieldTriggerFace,
  InputFace,
} from "@stll/ui/control-face";
import { Trash2Icon, UploadIcon } from "@stll/ui/icons";
import { SettingsPanel, SettingsSection } from "@stll/ui/settings";

import { PendingText } from "@/components/pending-text";

/*
 * The deny list card's layout, drawn by both phases: the box that adds a
 * term (its field, its label picker and add button, the import button and
 * its hint), then the team-wide terms under their heading. The live card
 * fills it with its form and its rows, and while the list loads it shows
 * `AnonymizationEntriesPending` in the list's place; the page's pending
 * phase draws the whole card from faces.
 */

type AnonymizationDenyListFrameProps = {
  /** A failed read's feedback, above the card's content. */
  feedback?: ReactNode;
  /** The form that adds a term. */
  addTerm: ReactNode;
  /** The heading and the terms (`AnonymizationEntriesHeading` and rows). */
  entries: ReactNode;
};

/** The deny list card, in both phases. */
export const AnonymizationDenyListFrame = ({
  addTerm,
  entries,
  feedback,
}: AnonymizationDenyListFrameProps) => (
  <SettingsSection>
    <SettingsPanel>
      <div className="flex flex-col gap-3">
        {feedback}
        <div className="rounded-md border p-3">{addTerm}</div>
        <div className="flex flex-col gap-1">{entries}</div>
      </div>
    </SettingsPanel>
  </SettingsSection>
);

/** The add-term form's rows: the label picker beside the add button, and
 *  the import button beside its hint. */
export const ANONYMIZATION_FORM_ROW_CLASS = "flex items-center gap-2";

/** The import button's hint. */
export const ANONYMIZATION_IMPORT_HINT_CLASS = "text-muted-foreground text-xs";

/** The terms' heading, with their count. */
export const AnonymizationEntriesHeading = ({
  children,
}: {
  children: ReactNode;
}) => (
  <div className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
    {children}
  </div>
);

/** One team-wide term: the term and its label, then its delete button. */
export const AnonymizationEntryRow = ({
  action,
  canonical,
  label,
}: {
  /** The term, cut to its line. */
  canonical: ReactNode;
  /** The term's label. */
  label: ReactNode;
  /** The delete button. */
  action: ReactNode;
}) => (
  <div className="hover:bg-muted/50 flex items-center justify-between gap-2 rounded-md border px-3 py-2">
    <div className="flex min-w-0 flex-col">
      {canonical}
      <span className="text-muted-foreground text-xs">{label}</span>
    </div>
    {action}
  </div>
);

/** Placeholder terms while the list loads. */
const ENTRY_ROWS_PENDING = [
  { key: "a", term: "w-40", label: "w-20" },
  { key: "b", term: "w-56", label: "w-24" },
  { key: "c", term: "w-32", label: "w-16" },
] as const;

/** The terms while they load: the heading's bar and placeholder rows. */
export const AnonymizationEntriesPending = () => (
  <>
    <AnonymizationEntriesHeading>
      <FaceLabelPending className="w-32" />
    </AnonymizationEntriesHeading>
    {ENTRY_ROWS_PENDING.map((row) => (
      <AnonymizationEntryRow
        action={
          <ButtonFace size="icon" variant="ghost">
            <Trash2Icon className="size-4" />
          </ButtonFace>
        }
        canonical={
          // The term's line (`TruncatedText`, a block line box).
          <span className="block text-sm font-medium">
            <FaceLabelPending className={row.term} />
          </span>
        }
        key={row.key}
        label={<FaceLabelPending className={row.label} />}
      />
    ))}
  </>
);

/**
 * The card in the page's pending phase: the add-term form's faces with their
 * placeholders and captions through `PendingText`, over the terms' pending
 * rows. The label picker shows the label a new term starts with.
 */
export const AnonymizationDenyListCardPending = () => (
  <AnonymizationDenyListFrame
    addTerm={
      // The form's `compact` stack (`@stll/ui/form`).
      <div className="flex w-full flex-col gap-2">
        <InputFace>
          <PendingText
            barClassName="w-56"
            id="settings.organization.anonymization.addPlaceholder"
          />
        </InputFace>
        <div className={ANONYMIZATION_FORM_ROW_CLASS}>
          {/* The label picker's input box (`h-9`, sharing the row). */}
          <FieldTriggerFace className="h-9 min-w-0 flex-1">
            <span className="text-foreground">
              <PendingText
                barClassName="w-24"
                id="common.anonymizationLabels.miscellaneous"
              />
            </span>
          </FieldTriggerFace>
          <ButtonFace size="sm" variant="default">
            <PendingText barClassName="w-8" id="common.add" />
          </ButtonFace>
        </div>
        <div className={ANONYMIZATION_FORM_ROW_CLASS}>
          <ButtonFace size="sm" variant="outline">
            <UploadIcon className="size-3.5" />
            <PendingText barClassName="w-12" id="common.import" />
          </ButtonFace>
          <span className={ANONYMIZATION_IMPORT_HINT_CLASS}>
            <PendingText
              barClassName="w-72 max-w-full"
              id="settings.organization.anonymization.importHint"
            />
          </span>
        </div>
      </div>
    }
    entries={<AnonymizationEntriesPending />}
  />
);
