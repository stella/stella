import { useTranslations } from "use-intl";

import { SuggestedActions } from "@/components/suggested-actions";

const noop = () => undefined;

const FOLLOW_UPS = [
  "Search all accessible matters for past confidentiality agreements.",
  "Which clauses should the playbook cover first?",
  "Start from market-standard positions instead.",
  "Summarise what you have decided so far.",
];

/** Follow-up chips that overflow a narrow composer column and scroll sideways. */
export const ChatFollowUpsPlayground = () => {
  const t = useTranslations();
  return (
    <section
      className="w-full max-w-xl p-4"
      data-playground-section="chat-follow-ups"
    >
      <SuggestedActions
        actions={FOLLOW_UPS.map((label, index) => ({
          id: String(index),
          label,
        }))}
        label={t("chat.suggestedFollowupsLabel")}
        onSelect={noop}
        orientation="row"
        scrollLabels={{
          next: t("common.next"),
          previous: t("common.previous"),
        }}
        surface="floating"
      />
    </section>
  );
};
