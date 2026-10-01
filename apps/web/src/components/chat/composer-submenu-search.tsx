import { SearchIcon } from "@stll/ui/icons";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@stll/ui/input-group";

import {
  isMenuNavigationKey,
  isTriggerErase,
  scheduleSearchFocus,
} from "@/components/chat/composer-submenu-search.logic";
import { useExternalSyncEffect } from "@/hooks/use-effect";

/** The editor character that opened this search as a shortcut popup. The
 *  field leads with it instead of the magnifier, so the "/" or "@" the user
 *  typed stays visible, and Backspace past it closes the popup. */
export type ComposerSearchTrigger = {
  char: string;
  onErase: () => void;
};

type ComposerSubmenuSearchProps = {
  onChange: (value: string) => void;
  placeholder: string;
  ref: React.RefObject<HTMLInputElement | null>;
  trigger?: ComposerSearchTrigger | undefined;
  value: string;
};

export const ComposerSubmenuSearch = ({
  onChange,
  placeholder,
  ref,
  trigger,
  value,
}: ComposerSubmenuSearchProps) => (
  <div className="px-2 pt-1.5 pb-2">
    <InputGroup>
      <InputGroupAddon>
        {trigger ? (
          <InputGroupText aria-hidden="true">{trigger.char}</InputGroupText>
        ) : (
          <SearchIcon />
        )}
      </InputGroupAddon>
      <InputGroupInput
        aria-label={placeholder}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if (trigger && isTriggerErase(event.key, value)) {
            event.preventDefault();
            event.stopPropagation();
            trigger.onErase();
            return;
          }
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
