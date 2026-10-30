import { useTranslations } from "use-intl";

import { TriangleAlertIcon } from "@stll/ui/icons";

import { useFormatter } from "@/i18n/formatting-context";
import type Messages from "@/i18n/langs/messages.gen";
import type { TranslationKey } from "@/i18n/types";
import {
  groupOAuthScopeDisplayEntries,
  groupOAuthScopeSummaryEntries,
  type OAuthScopeDisplayEntry,
  type OAuthScopeGroup,
  type OAuthScopeSummaryGroup,
  toOAuthScopeDisplayEntries,
  translateOAuthScopeEntry,
  translateOAuthScopeSummary,
} from "@/lib/oauth-scopes";

const SCOPE_GROUP_LABELS = {
  read: { group: "read", label: "consent.canRead" },
  change: { group: "change", label: "consent.canChange" },
  other: { group: "other", label: "consent.otherPermissions" },
} as const satisfies {
  [Group in OAuthScopeGroup]: { group: Group; label: TranslationKey };
};
const SUMMARY_LABELS = {
  read: { group: "read", summary: "summaryLineRead" },
  change: { group: "change", summary: "summaryLineChange" },
  use: { group: "use", summary: "summaryLineUse" },
  other: { group: "other", summary: "summaryLineOther" },
} as const satisfies {
  [Group in OAuthScopeSummaryGroup]: {
    group: Group;
    summary: keyof Messages["consent"];
  };
};

export const ScopeSummary = ({ scopes }: { scopes: readonly string[] }) => {
  const entries = toOAuthScopeDisplayEntries(scopes);
  const groups = groupOAuthScopeDisplayEntries(entries);
  const summaryGroups = groupOAuthScopeSummaryEntries(entries);
  const t = useTranslations();
  const tConsent = useTranslations("consent");
  const format = useFormatter();
  const total = Object.values(groups).reduce(
    (sum, groupEntries) => sum + groupEntries.length,
    0,
  );
  const sensitive = Object.values(groups)
    .flat()
    .filter((entry) => entry.type === "known" && entry.sensitive);

  return (
    <section className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2 text-sm">
        {Object.values(SUMMARY_LABELS).map(({ group, summary }) =>
          summaryGroups[group].length > 0 ? (
            <li
              key={group}
              className="text-pretty"
              data-slot="consent-summary-line"
            >
              {summaryGroups[group].length === 1 &&
              summaryGroups[group].every(
                (entry) =>
                  entry.type === "known" &&
                  entry.summary === "consent.summaryStaySignedIn",
              )
                ? t("consent.summaryStaySignedIn")
                : tConsent.rich(summary, {
                    items: format.list(
                      summaryGroups[group].map((entry) =>
                        translateOAuthScopeSummary(t, entry),
                      ),
                    ),
                    group: (chunks) => (
                      <span className="font-medium">{chunks}</span>
                    ),
                  })}
            </li>
          ) : null,
        )}
      </ul>
      {sensitive.length > 0 ? (
        <div
          className="bg-warning/8 text-foreground flex gap-2 rounded-md p-3 text-sm"
          data-slot="consent-sensitive-access"
        >
          <TriangleAlertIcon
            className="text-warning mt-0.5 size-4 shrink-0"
            aria-hidden="true"
          />
          <div className="flex min-w-0 flex-col gap-1">
            <p className="font-medium">{t("consent.sensitiveAccess")}</p>
          </div>
        </div>
      ) : null}
      <details className="text-sm" data-slot="consent-permissions">
        <summary className="text-muted-foreground min-h-11 cursor-pointer content-center">
          {t("consent.showAllPermissions", { count: total })}
        </summary>
        <div className="flex flex-col gap-4 pt-1 pb-2">
          {Object.values(SCOPE_GROUP_LABELS).map(({ group, label }) =>
            groups[group].length > 0 ? (
              <section key={group} className="flex flex-col gap-2">
                <h2 className="font-medium">{t(label)}</h2>
                <ul className="flex flex-col gap-2">
                  {groups[group].map((entry) => (
                    <li
                      className="flex items-start gap-2"
                      key={entry.type === "known" ? entry.label : entry.scope}
                    >
                      <span
                        aria-hidden="true"
                        className="bg-muted-foreground mt-2 size-1 shrink-0 rounded-full"
                      />
                      <ScopeLabel entry={entry} />
                    </li>
                  ))}
                </ul>
              </section>
            ) : null,
          )}
        </div>
      </details>
    </section>
  );
};

const ScopeLabel = ({ entry }: { entry: OAuthScopeDisplayEntry }) => {
  const t = useTranslations();

  return <bdi>{translateOAuthScopeEntry(t, entry)}</bdi>;
};
