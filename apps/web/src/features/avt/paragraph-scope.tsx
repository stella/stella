/**
 * A verification limited to a range of a document's paragraphs: the control
 * that starts one, and the quiet mark that says a run checked only part of
 * its document.
 */

import * as React from "react";

import { useTranslations } from "use-intl";

import { VERIFICATION_SCOPE_REFUSALS } from "@stll/api-contract/verification-scope";
import type { VerificationScopeRefusal } from "@stll/api-contract/verification-scope";
import { Button } from "@stll/ui/button";
import { Form } from "@stll/ui/form";
import { ChevronDownIcon } from "@stll/ui/icons";
import { Input } from "@stll/ui/input";
import { Label } from "@stll/ui/label";
import { Popover, PopoverPopup, PopoverTrigger } from "@stll/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@stll/ui/tooltip";

import {
  paragraphRangeLabel,
  readParagraphRangeInput,
} from "@/features/avt/paragraph-scope.logic";
import type {
  ParagraphRangeInput,
  VerificationScope,
} from "@/features/avt/paragraph-scope.logic";
import type { TranslationKey } from "@/i18n/types";

const INPUT_ERROR_KEYS = {
  garbage: "avt.scope.errors.garbage",
  reversed: "avt.scope.errors.reversed",
  "too-wide": "avt.scope.errors.tooWide",
} as const satisfies Record<
  Extract<ParagraphRangeInput, { type: "invalid" }>["reason"],
  TranslationKey
>;

const REFUSAL_KEYS = {
  [VERIFICATION_SCOPE_REFUSALS.paragraphsNotFound]: "avt.scope.errors.notFound",
  [VERIFICATION_SCOPE_REFUSALS.paragraphsEmpty]: "avt.scope.errors.empty",
  [VERIFICATION_SCOPE_REFUSALS.numberingUnclear]:
    "avt.scope.errors.numberingUnclear",
  [VERIFICATION_SCOPE_REFUSALS.noText]: "avt.runs.errors.noText",
} as const satisfies Record<VerificationScopeRefusal, TranslationKey>;

/** Every message the field can show: a narrow union keeps `t` cheap to
 *  type-check. */
type ScopeErrorKey =
  | (typeof INPUT_ERROR_KEYS)[keyof typeof INPUT_ERROR_KEYS]
  | (typeof REFUSAL_KEYS)[keyof typeof REFUSAL_KEYS]
  | "avt.scope.errors.required";

type ParagraphRangeStartProps = {
  disabled: boolean;
  starting: boolean;
  /** Why the server refused this document's last range, if it did. */
  refusal: VerificationScopeRefusal | null;
  onVerify: (paragraphs: string) => void;
  /** The reviewer changed the range: an earlier refusal no longer applies. */
  onEdit: () => void;
};

/** Verify only some paragraphs: opened beside the document's Verify. */
export const ParagraphRangeStart = ({
  disabled,
  starting,
  refusal,
  onVerify,
  onEdit,
}: ParagraphRangeStartProps) => {
  const t = useTranslations();
  const inputId = React.useId();
  const errorId = React.useId();
  const [open, setOpen] = React.useState(false);
  const [value, setValue] = React.useState("");
  const [submitted, setSubmitted] = React.useState(false);
  const input = readParagraphRangeInput(value);
  const errorKey = ((): ScopeErrorKey | null => {
    if (input.type === "invalid") {
      return INPUT_ERROR_KEYS[input.reason];
    }
    if (input.type === "empty") {
      return submitted ? "avt.scope.errors.required" : null;
    }
    return refusal === null ? null : REFUSAL_KEYS[refusal];
  })();

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        render={
          <Button
            aria-label={t("avt.scope.verifyParagraphs")}
            disabled={disabled}
            size="icon-sm"
            tooltip={t("avt.scope.verifyParagraphs")}
            variant="outline"
          />
        }
      >
        <ChevronDownIcon />
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-64">
        <Form
          className="flex flex-col gap-2"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            setSubmitted(true);
            if (input.type === "valid") {
              onVerify(input.paragraphs);
            }
          }}
        >
          <Label htmlFor={inputId}>
            {t("inspector.metadata.documentProperties.keys.paragraphs")}
          </Label>
          <Input
            aria-describedby={errorKey === null ? undefined : errorId}
            aria-invalid={errorKey !== null}
            autoComplete="off"
            dir="ltr"
            id={inputId}
            inputMode="numeric"
            onChange={(event) => {
              setValue(event.target.value);
              setSubmitted(false);
              onEdit();
            }}
            placeholder={t("avt.scope.example")}
            value={value}
          />
          {errorKey !== null && (
            <p className="text-destructive-foreground text-xs" id={errorId}>
              {t(errorKey)}
            </p>
          )}
          <Button
            disabled={disabled}
            loading={starting}
            size="sm"
            type="submit"
          >
            {t("common.verify")}
          </Button>
        </Form>
      </PopoverPopup>
    </Popover>
  );
};

/** Why the server refused a range, where the range was asked for again
 *  without its field (verifying a failed range run again). */
export const ScopeRefusalMessage = ({
  refusal,
}: {
  refusal: VerificationScopeRefusal;
}) => {
  const t = useTranslations();
  return (
    <p className="text-destructive-foreground text-xs" role="alert">
      {t(REFUSAL_KEYS[refusal])}
    </p>
  );
};

/** `¶ 82–136` beside a run that checked only those paragraphs; nothing for
 *  a run over the whole document. */
export const ScopeMark = ({ scope }: { scope: VerificationScope }) => {
  const t = useTranslations();
  if (scope.kind === "whole") {
    return null;
  }
  // A range reads left to right in every locale: "82–136" set in a
  // right-to-left line would otherwise show as "136–82".
  const range = paragraphRangeLabel(scope);
  const values = {
    range,
    num: (chunks: React.ReactNode) => <bdi dir="ltr">{chunks}</bdi>,
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="text-muted-foreground shrink-0 text-xs tabular-nums" />
        }
      >
        {t.rich("avt.scope.mark", values)}
      </TooltipTrigger>
      <TooltipPopup>
        {scope.numbering === "document"
          ? t.rich("avt.scope.checkedDocument", values)
          : t.rich("avt.scope.checkedOrdinal", values)}
      </TooltipPopup>
    </Tooltip>
  );
};
