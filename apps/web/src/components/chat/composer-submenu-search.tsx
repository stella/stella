import { SearchIcon } from "lucide-react";

import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@stll/ui/input-group";

import {
  isMenuNavigationKey,
  scheduleSearchFocus,
} from "@/components/chat/composer-submenu-search.logic";
import { useExternalSyncEffect } from "@/hooks/use-effect";

type ComposerSubmenuSearchProps = {
  onChange: (value: string) => void;
  placeholder: string;
  ref: React.RefObject<HTMLInputElement | null>;
  value: string;
};

export const ComposerSubmenuSearch = ({
  onChange,
  placeholder,
  ref,
  value,
}: ComposerSubmenuSearchProps) => (
  <div className="px-2 pt-1.5 pb-2">
    <InputGroup>
      <InputGroupAddon>
        <SearchIcon />
      </InputGroupAddon>
      <InputGroupInput
        aria-label={placeholder}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if (!isMenuNavigationKey(event.key)) {
            event.stopPropagation();
          }
        }}
        placeholder={placeholder}
        ref={ref}
        size="sm"
        value={value}
      />
    </InputGroup>
  </div>
);

export const useFocusSearchOnOpen = (
  open: boolean,
  ref: React.RefObject<HTMLInputElement | null>,
) => {
  useExternalSyncEffect(() => {
    if (!open) {
      return undefined;
    }

    return scheduleSearchFocus({ ref, scheduler: window });
  }, [open, ref]);
};
