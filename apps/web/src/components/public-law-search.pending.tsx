import { useSearch } from "@tanstack/react-router";

import {
  ButtonFace,
  buttonFaceClassName,
  InputFace,
} from "@stll/ui/control-face";
import {
  AiActionIcon,
  MessageSquareTextIcon,
  SearchIcon,
} from "@stll/ui/icons";
import { cn } from "@stll/ui/utils";

import { PendingText } from "@/components/pending-text";
import type { PendingTextKey } from "@/components/pending-text";

/** The URL owns the entry until the search field mounts. */
export const PublicLawSearchFace = ({
  placeholder,
  refine = false,
}: {
  placeholder: PendingTextKey;
  refine?: boolean | undefined;
}) => {
  const query = useSearch({
    strict: false,
    select: (search) => (typeof search.q === "string" ? search.q : ""),
  });
  return (
    <div
      className="mx-auto flex w-full max-w-2xl flex-wrap items-center justify-center gap-2"
      role="search"
    >
      <InputFace
        className="h-11 min-h-11 min-w-64 flex-1"
        icon={<SearchIcon />}
      >
        {query.length > 0 ? (
          <bdi className="text-foreground">{query}</bdi>
        ) : (
          <PendingText barClassName="w-48 max-w-full" id={placeholder} />
        )}
      </InputFace>
      {refine && (
        <ButtonFace size="icon-sm" variant="muted">
          <AiActionIcon aria-hidden="true" className="size-4" />
        </ButtonFace>
      )}
      {query.trim().length > 0 && (
        <span
          aria-hidden="true"
          className={cn(
            buttonFaceClassName({ size: "sm", variant: "ghost" }),
            "text-muted-foreground",
          )}
        >
          <MessageSquareTextIcon aria-hidden="true" className="size-3.5" />
          <PendingText barClassName="w-16" id="common.askInChat" />
        </span>
      )}
    </div>
  );
};
