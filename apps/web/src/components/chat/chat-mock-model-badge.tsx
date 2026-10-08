import { useTranslations } from "use-intl";

import Tooltip from "@/components/tooltip";
import { useChromeQuery } from "@/hooks/use-chrome-query";
import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";
import { aiAvailabilityOptions } from "@/lib/organization/ai-config-queries";
import { useQueryView } from "@/lib/use-query-view";

/**
 * Marks the composer while the local mock model answers this organization's
 * turns, so canned replies never pass for a real model's answer. The server
 * decides (`mockAnswers` is false on every deployed runtime); the badge sits
 * outside the reply text, and marketing captures hide it through
 * `data-dev-chrome` so filmed replies stay clean.
 */
export const ChatMockModelBadge = () => {
  const user = useMaybeAuthenticatedUser();
  const availabilityQuery = useChromeQuery({
    ...aiAvailabilityOptions({
      organizationId: user?.activeOrganizationId ?? "",
    }),
    enabled: user !== null,
    // The app shell already keeps this answer fresh; a composer mounting must
    // not refetch it.
    refetchOnMount: false,
  });
  const availabilityView = useQueryView(availabilityQuery);
  // This dev-only decoration can be omitted when availability cannot be read.
  if (
    user === null ||
    availabilityView.type !== "items" ||
    !availabilityView.items.mockAnswers
  ) {
    return null;
  }
  return <MockModelBadge />;
};

const MockModelBadge = () => {
  const t = useTranslations();
  return (
    <Tooltip
      content={t("chat.mockModel.description")}
      render={
        <span
          className="text-muted-foreground shrink-0 rounded-sm border border-dashed px-1.5 text-xs leading-5 whitespace-nowrap"
          data-dev-chrome=""
          data-slot="chat-mock-model-badge"
        />
      }
    >
      {t("chat.mockModel.label")}
    </Tooltip>
  );
};
