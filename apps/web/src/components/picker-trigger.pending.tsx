import type { ReactNode } from "react";

import { ButtonFace, FaceLabelPending } from "@stll/ui/control-face";
import type { LucideIcon } from "@stll/ui/icons";

export const pickerTriggerProps = { size: "sm", variant: "outline" } as const;

export const PickerTriggerContent = ({
  icon: Icon,
  children,
}: {
  icon: LucideIcon;
  children: ReactNode;
}) => (
  <>
    <Icon className="size-4" />
    {children}
  </>
);

export const PickerTriggerPending = ({ icon }: { icon: LucideIcon }) => (
  <ButtonFace {...pickerTriggerProps}>
    <PickerTriggerContent icon={icon}>
      <FaceLabelPending className="w-12" />
    </PickerTriggerContent>
  </ButtonFace>
);
