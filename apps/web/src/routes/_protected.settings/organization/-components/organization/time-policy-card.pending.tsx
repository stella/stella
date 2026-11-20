import type { ReactNode } from "react";

import {
  ButtonFace,
  FaceLabelPending,
  FieldFace,
  FieldTriggerFace,
  InputFace,
  LabelFace,
  SwitchFace,
} from "@stll/ui/control-face";
import { Frame, FramePanel } from "@stll/ui/frame";

import { PendingText } from "@/components/pending-text";
import type { PendingTextKey } from "@/components/pending-text";
import { FORM_STACK_CLASS } from "@/routes/_protected.settings/-components/settings-card.pending";

/*
 * The time policy card's frame, drawn by both phases, and the card in its
 * pending phase: the minimum unit, the edit window, the locked month and the
 * narrative switch, with their captions and help lines, and the save button.
 */

/** The time policy card: the panel the policy's form sits in. */
export const TimePolicyCardFrame = ({ children }: { children: ReactNode }) => (
  <Frame>
    <FramePanel>
      <div className="p-1">{children}</div>
    </FramePanel>
  </Frame>
);

/** The locked month row: the month and year pickers, then the clear button. */
export const TIME_POLICY_MONTH_ROW_CLASS = "flex items-center gap-2";

/** A field in its pending phase: caption, the control's face, help line. */
const TimePolicyFieldPending = ({
  children,
  help,
  label,
}: {
  label: PendingTextKey;
  help: PendingTextKey;
  /** The control's face. */
  children: ReactNode;
}) => (
  <FieldFace>
    <LabelFace>
      <PendingText barClassName="w-32" id={label} />
    </LabelFace>
    {children}
    <p className="text-muted-foreground text-xs">
      <PendingText barClassName="w-72 max-w-full" id={help} />
    </p>
  </FieldFace>
);

/** The card while the organization's settings load. */
export const TimePolicyCardPending = () => (
  <TimePolicyCardFrame>
    <div className={FORM_STACK_CLASS}>
      <TimePolicyFieldPending
        help="settings.organization.timePolicy.minimumUnitHelp"
        label="settings.organization.timePolicy.minimumUnit"
      >
        <FieldTriggerFace>
          <FaceLabelPending className="w-20" />
        </FieldTriggerFace>
      </TimePolicyFieldPending>
      <TimePolicyFieldPending
        help="settings.organization.timePolicy.editWindowHelp"
        label="settings.organization.timePolicy.editWindow"
      >
        <InputFace />
      </TimePolicyFieldPending>
      <TimePolicyFieldPending
        help="settings.organization.timePolicy.lockedThroughHelp"
        label="settings.organization.timePolicy.lockedThrough"
      >
        <div className={TIME_POLICY_MONTH_ROW_CLASS}>
          {/* The month picker beside the year field (`MonthLockPicker`). */}
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <FieldTriggerFace className="min-h-11">
              <span className="text-muted-foreground">
                <PendingText
                  barClassName="w-16"
                  id="workspaces.views.calendar.month"
                />
              </span>
            </FieldTriggerFace>
            <InputFace className="min-h-11 w-28" />
          </div>
          <ButtonFace size="default" variant="ghost">
            <PendingText barClassName="w-16" id="common.clearDate" />
          </ButtonFace>
        </div>
      </TimePolicyFieldPending>
      <FieldFace className="min-h-11" layout="inline">
        <SwitchFace />
        <LabelFace>
          <PendingText
            barClassName="w-40"
            id="settings.organization.timePolicy.narrativeRequired"
          />
        </LabelFace>
      </FieldFace>
      <ButtonFace className="self-start" size="default" variant="default">
        <PendingText barClassName="w-24" id="common.saveChanges" />
      </ButtonFace>
    </div>
  </TimePolicyCardFrame>
);
