import { ButtonFace, FaceLabelPending } from "@stll/ui/control-face";
import type { LucideIcon } from "@stll/ui/icons";

export const pickerTriggerProps = { size: "sm", variant: "outline" } as const;

export const PickerTriggerIcon = ({ icon: Icon }: { icon: LucideIcon }) => (
  <Icon className="size-4" />
);

export const PickerTriggerPending = ({ icon }: { icon: LucideIcon }) => (
  <ButtonFace {...pickerTriggerProps}>
    <PickerTriggerIcon icon={icon} />
    <FaceLabelPending className="w-12" />
  </ButtonFace>
);
