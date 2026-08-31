import type { ReactNode } from "react";

import { Link } from "@tanstack/react-router";
import { GitBranchIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { cn } from "@stll/ui/utils";

import type { ForkProvenance } from "@/features/chat/queries";
import { chatThreadRoute } from "@/lib/chat-thread-ref";
import { isPlaceholderThreadTitle } from "@/lib/chat-thread-title";

const BANNER_CLASSNAME =
  "text-muted-foreground inline-flex max-w-full items-center gap-1.5 text-xs";

/**
 * "Forked from <source>" above a forked thread's transcript. A fork opens on
 * history its reader never wrote, so the banner stays even once the source is
 * gone: only the link disappears with it.
 *
 * The linked sentence is one message, so no locale has to reassemble it around
 * a separately linked title, and the title is isolated in a `bdi` because it
 * is user-authored text of unknown direction inside a sentence whose direction
 * comes from the UI locale.
 */
export const ChatForkedFromBanner = ({
  forkProvenance,
}: {
  forkProvenance: ForkProvenance;
}) => {
  const t = useTranslations();

  switch (forkProvenance.type) {
    case "none": {
      return null;
    }
    case "parent-unavailable": {
      return (
        <div className="mx-auto w-full max-w-5xl px-4 pt-2">
          <span className={BANNER_CLASSNAME}>
            <GitBranchIcon aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="truncate">{t("chat.forkedFromUnavailable")}</span>
          </span>
        </div>
      );
    }
    case "parent": {
      const { threadId, title, workspaceId } = forkProvenance;
      return (
        <div className="mx-auto w-full max-w-5xl px-4 pt-2">
          <Link
            className={cn(
              BANNER_CLASSNAME,
              "hover:text-foreground underline-offset-2 hover:underline",
            )}
            {...chatThreadRoute({ threadId, workspaceId })}
          >
            <GitBranchIcon aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="truncate">
              {t.rich("chat.forkedFrom", {
                bdi: (chunks: ReactNode) => <BidiText>{chunks}</BidiText>,
                // Threads are titled asynchronously, so a very fresh parent is
                // still on its placeholder; show the same "New chat" label the
                // rest of the UI gives it rather than the raw placeholder.
                title: isPlaceholderThreadTitle(title)
                  ? t("chat.newChat")
                  : title,
              })}
            </span>
          </Link>
        </div>
      );
    }
    default: {
      const exhaustive: never = forkProvenance;
      return exhaustive;
    }
  }
};
