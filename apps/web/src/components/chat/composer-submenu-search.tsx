import { SearchIcon } from "lucide-react";

import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@stll/ui/components/input-group";

import { useExternalSyncEffect } from "@/hooks/use-effect";

const isMenuNavigationKey = (key: string): boolean =>
  key === "Escape" ||
  key === "ArrowDown" ||
  key === "ArrowUp" ||
  key === "Enter";

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

export const focusSearchOnOpen = (
  ref: React.RefObject<HTMLInputElement | null>,
) => {
  setTimeout(() => ref.current?.focus(), 0);
};

export const useFocusSearchOnOpen = (
  open: boolean,
  ref: React.RefObject<HTMLInputElement | null>,
) => {
  useExternalSyncEffect(() => {
    if (!open) {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => ref.current?.focus(), 0);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [open, ref]);
};
