import type { ReactNode } from "react";

import {
  ButtonFace,
  FaceLabelPending,
  FieldDescriptionFace,
  FieldFace,
  FieldTriggerFace,
  InputFace,
  LabelFace,
  SwitchFace,
} from "@stll/ui/control-face";
import { Separator } from "@stll/ui/separator";
import { SettingsPanel, SettingsSection } from "@stll/ui/settings";

import { MatterNumberPreview } from "@/components/matter-number-preview.pending";
import { PendingText } from "@/components/pending-text";
import type { PendingTextKey } from "@/components/pending-text";

/*
 * The matter numbering card's layout, drawn by both phases: the "show in
 * title" switch, the pattern picker, the custom pattern field (only for a
 * pattern no preset names), the padding picker, the next number's preview
 * and the save button. The live card fills it with its fields; the pending
 * phase with their faces, so the card that loads lands in its own box.
 */

type MatterNumberingCardFrameProps = {
  /** The "show in title" checkbox's field. */
  numberingToggle: ReactNode;
  /** The pattern picker's field. */
  pattern: ReactNode;
  /** The custom pattern's field, while the pattern is a custom one. */
  customPattern?: ReactNode;
  /** The padding picker's field. */
  padding: ReactNode;
  /** The next number's preview (`MatterNumberPreview`). */
  preview: ReactNode;
  /** The document name pattern's field and its sample name. */
  documentNaming: ReactNode;
  /** The save button. */
  save: ReactNode;
};

/** The matter numbering card, in both phases. */
export const MatterNumberingCardFrame = ({
  customPattern,
  documentNaming,
  numberingToggle,
  padding,
  pattern,
  preview,
  save,
}: MatterNumberingCardFrameProps) => (
  <SettingsSection>
    <SettingsPanel>
      <div className="flex flex-col gap-3">
        {numberingToggle}
        {pattern}
        {customPattern}
        {padding}
        {preview}
        <Separator />
        {documentNaming}
        {save}
      </div>
    </SettingsPanel>
  </SettingsSection>
);

/** The next number: its caption, then the number in a code chip. */

/** The preview while the next number is worked out: its chip holds a bar. */
export const MatterNumberPreviewPending = () => (
  <MatterNumberPreview
    label={
      <PendingText
        barClassName="w-28"
        id="organization.matterNumber.nextPreview"
      />
    }
  >
    <FaceLabelPending className="w-16" />
  </MatterNumberPreview>
);

/** A picker's field in its pending phase: caption, trigger face, line. */
const PickerFieldPending = ({
  description,
  label,
}: {
  label: PendingTextKey;
  description?: PendingTextKey | undefined;
}) => (
  <FieldFace>
    <LabelFace>
      <PendingText barClassName="w-24" id={label} />
    </LabelFace>
    <FieldTriggerFace>
      <FaceLabelPending className="w-32" />
    </FieldTriggerFace>
    {description !== undefined && (
      <p className="text-muted-foreground text-xs">
        <PendingText barClassName="w-72 max-w-full" id={description} />
      </p>
    )}
  </FieldFace>
);

/**
 * The card while the organization's settings load: the fields' faces, with
 * their captions and lines through `PendingText`. A stored custom pattern
 * adds its field once the settings are there.
 */
export const MatterNumberingCardPending = () => (
  <MatterNumberingCardFrame
    numberingToggle={
      <div className="flex min-h-11 items-center justify-between gap-4 py-2">
        <span className="flex min-w-0 flex-col gap-0.5">
          <LabelFace>
            <PendingText
              barClassName="w-40"
              id="organization.matterNumber.showInTitle"
            />
          </LabelFace>
          <FieldDescriptionFace>
            <PendingText
              barClassName="w-72 max-w-full"
              id="organization.matterNumber.showInTitleDescription"
            />
          </FieldDescriptionFace>
        </span>
        <SwitchFace />
      </div>
    }
    padding={
      <PickerFieldPending
        description="organization.matterNumber.paddingDescription"
        label="organization.matterNumber.padding"
      />
    }
    pattern={<PickerFieldPending label="organization.matterNumber.pattern" />}
    preview={<MatterNumberPreviewPending />}
    documentNaming={
      <FieldFace>
        <LabelFace>
          <PendingText
            barClassName="w-24"
            id="organization.documentNaming.pattern"
          />
        </LabelFace>
        <InputFace>
          <FaceLabelPending className="w-48" />
        </InputFace>
      </FieldFace>
    }
    save={
      <ButtonFace className="self-start" size="sm" variant="default">
        <PendingText barClassName="w-20" id="common.saveChanges" />
      </ButtonFace>
    }
  />
);
