import { Suspense } from "react";
import type { ReactNode } from "react";

import { NewChatIcon } from "@stll/ui/icons";
import { MenuItem } from "@stll/ui/menu";

export const ChatMenuContent = ({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) => (
  <Suspense
    fallback={
      <MenuItem disabled>
        <NewChatIcon />
        {label}
      </MenuItem>
    }
  >
    {children}
  </Suspense>
);
