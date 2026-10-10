import type { ReactNode } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import { detached } from "@/lib/detached";
import type { QueryView } from "@/lib/query-view.logic";

type PlaybookQuerySectionProps<TData, TError> = {
  view: QueryView<TData, TError>;
  pending: Exclude<ReactNode, Promise<unknown>>;
  empty: Exclude<ReactNode, Promise<unknown>>;
  children: (items: TData) => ReactNode;
};

export const PlaybookQuerySection = <TData, TError>({
  view,
  pending,
  empty,
  children,
}: PlaybookQuerySectionProps<TData, TError>) => {
  const t = useTranslations();
  switch (view.type) {
    case "pending":
      return pending;
    case "empty":
      return empty;
    case "error":
    case "items": {
      const feedback = view.type === "error" || view.refetchError !== undefined;
      return (
        <>
          {feedback && (
            <div className="flex items-center gap-2 px-3 py-2" role="alert">
              <p className="text-destructive text-sm">
                {t("common.somethingWentWrong")}
              </p>
              <Button
                onClick={() =>
                  detached(view.retry(), "playbook-query-section.retry")
                }
                size="xs"
                variant="ghost"
              >
                {t("common.retry")}
              </Button>
            </div>
          )}
          {view.type === "items" && children(view.items)}
        </>
      );
    }
    default:
      view satisfies never;
      return panic("Unhandled playbook query state");
  }
};
