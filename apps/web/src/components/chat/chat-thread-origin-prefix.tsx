import { GitBranchIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import {
  CHAT_THREAD_ORIGIN,
  type ChatThreadOrigin,
} from "@stll/api-contract/chat";

/** Localized provenance shown beside titles in compact thread lists. */
export const ChatThreadOriginPrefix = ({
  origin,
}: {
  origin: ChatThreadOrigin;
}) => {
  const t = useTranslations();

  switch (origin) {
    case CHAT_THREAD_ORIGIN.original: {
      return null;
    }
    case CHAT_THREAD_ORIGIN.fork: {
      return (
        <>
          <span className="inline-flex items-center gap-1">
            <GitBranchIcon aria-hidden="true" className="size-3 shrink-0" />
            {t("chat.forkedThread")}
          </span>
          {" · "}
        </>
      );
    }
    default: {
      const exhaustive: never = origin;
      return exhaustive;
    }
  }
};
