import { NewChatIcon } from "@stll/ui/icons";
import { MenuItem } from "@stll/ui/menu";

import { CapabilityAction } from "@/lib/organization/feature-access/capability-actions";

export const NewChatMenuItem = ({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) => (
  <CapabilityAction action={{ capability: "ai" }} surface="menu">
    {(capabilityProps) => (
      <MenuItem onClick={onClick} {...capabilityProps}>
        <NewChatIcon />
        {label}
      </MenuItem>
    )}
  </CapabilityAction>
);
