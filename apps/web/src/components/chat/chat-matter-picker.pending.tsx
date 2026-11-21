import { COMPOSER_PICKER_TRIGGER_CLASS } from "@stll/ui/composer-tokens";
import { FaceLabelPending } from "@stll/ui/control-face";
import { ChevronDownIcon } from "@stll/ui/icons";
import { MatterIcon } from "@stll/ui/matter-icon";
import { cn } from "@stll/ui/utils";

/** The chevron after the picker's label. */
export const MatterPickerChevron = () => (
  <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-70" />
);

/**
 * The picker trigger's content while the matters load: the no-matter glyph,
 * a bar on the label's line and the chevron, where the chosen matter lands.
 */
export const MatterPickerTriggerPendingContent = () => (
  <>
    <MatterIcon className="size-3 shrink-0" variant="none" />
    <FaceLabelPending className="w-16" />
    <MatterPickerChevron />
  </>
);

/**
 * The chat's matter picker before it mounts, in the status row under the
 * composer: the trigger's box with its pending content.
 */
export const ChatMatterPickerPending = () => (
  <div
    aria-hidden="true"
    className={cn(COMPOSER_PICKER_TRIGGER_CLASS, "max-w-[220px] gap-0.5")}
  >
    <MatterPickerTriggerPendingContent />
  </div>
);
