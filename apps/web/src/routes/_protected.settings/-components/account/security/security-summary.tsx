import type { ReactNode } from "react";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { sanitizeHref } from "@stll/decision-reader/sanitize-href";
import { CheckIcon, CircleAlertIcon } from "@stll/ui/icons";
import { Skeleton } from "@stll/ui/skeleton";
import { cn } from "@stll/ui/utils";

import {
  socialProviderName,
  socialProviderSchema,
} from "@/components/auth/access-reset.logic";
import { useFormatter } from "@/i18n/formatting-context";
import { linkedAccountsOptions } from "@/lib/account/queries";
import { authCapabilitiesOptions } from "@/lib/auth-capabilities";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { queryView } from "@/lib/query-view.logic";
import { resourceQueryOptions } from "@/lib/workspace-realtime";
import type { SignedInDevice } from "@/routes/_protected.settings/-account.security.logic";
import {
  SECURITY_SUMMARY_CLASS,
  SECURITY_SUMMARY_TILE_CLASS,
  SIGNED_IN_DEVICES_SECTION_ID,
} from "@/routes/_protected.settings/-account.security.pending";
import { useDeviceWording } from "@/routes/_protected.settings/-components/account/security/device-wording";
import { SIGN_IN_METHODS_SECTION_ID } from "@/routes/_protected.settings/-components/account/sign-in-methods.pending";
import { TWO_FACTOR_SECTION_ID } from "@/routes/_protected.settings/-components/account/two-factor-card.pending";

type SummaryTone = "ok" | "attention";

type SummaryTileProps = {
  href: string;
  tone: SummaryTone;
  title: ReactNode;
  detail: ReactNode;
};

const SummaryTile = ({ href, tone, title, detail }: SummaryTileProps) => (
  <a
    className={cn(
      SECURITY_SUMMARY_TILE_CLASS,
      "focus-visible:ring-ring outline-none hover:shadow-sm focus-visible:ring-2",
      tone === "attention" && "border-warning/40 bg-warning/10",
    )}
    href={sanitizeHref(href)}
  >
    <span
      aria-hidden="true"
      className={cn(
        "grid size-8 place-items-center rounded-full",
        tone === "ok"
          ? "bg-success/12 text-success"
          : "bg-warning/16 text-warning",
      )}
    >
      {tone === "ok" ? (
        <CheckIcon className="size-4" />
      ) : (
        <CircleAlertIcon className="size-4" />
      )}
    </span>
    <span className="font-semibold">{title}</span>
    <span className="text-muted-foreground text-sm text-pretty">{detail}</span>
  </a>
);

type SecuritySummaryProps = {
  twoFactorEnabled: boolean;
  pendingReviews: readonly SignedInDevice[];
};

/** Three tiles: sign-in methods, two-factor state, sign-ins to check. */
export const SecuritySummary = ({
  twoFactorEnabled,
  pendingReviews,
}: SecuritySummaryProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const { id } = useAuthenticatedUser();
  const { deviceLabel, placeLabel } = useDeviceWording();
  // The sign-in methods section below reads the same two queries and shows
  // their failure; the tile keeps its placeholder until both are there.
  const accounts = queryView(useQuery(linkedAccountsOptions(id)), {
    isEmpty: () => false,
  });
  const capabilities = queryView(
    useQuery(
      resourceQueryOptions(
        { ...authCapabilitiesOptions },
        { type: "independent" },
      ),
    ),
  );
  const next = pendingReviews.at(0);

  const methodNames =
    accounts.type !== "items" || capabilities.type !== "items"
      ? undefined
      : [
          ...(capabilities.items.emailOtp
            ? [t("settings.account.signInMethods.emailCode")]
            : []),
          ...accounts.items.map((account) => {
            const provider = v.safeParse(
              socialProviderSchema,
              account.providerId,
            );
            if (account.providerId === "credential") {
              return t("auth.password");
            }
            return provider.success
              ? socialProviderName(provider.output)
              : account.providerId;
          }),
        ];

  return (
    <section
      aria-label={t("settings.account.security.summaryLabel")}
      className={SECURITY_SUMMARY_CLASS}
    >
      <SummaryTile
        detail={
          methodNames === undefined ? (
            <Skeleton className="h-4 w-32" />
          ) : (
            format.list(methodNames, { type: "conjunction" })
          )
        }
        href={`#${SIGN_IN_METHODS_SECTION_ID}`}
        title={
          methodNames === undefined ? (
            <Skeleton className="h-5 w-36" />
          ) : (
            t("settings.account.security.summaryMethods", {
              count: methodNames.length,
            })
          )
        }
        tone="ok"
      />
      <SummaryTile
        detail={
          twoFactorEnabled
            ? t("settings.account.security.summaryTwoFactorOn")
            : t("settings.account.security.summaryTwoFactorOff")
        }
        href={`#${TWO_FACTOR_SECTION_ID}`}
        title={t("settings.account.twoFactor.title")}
        tone={twoFactorEnabled ? "ok" : "attention"}
      />
      <SummaryTile
        detail={
          next === undefined
            ? t("settings.account.security.summaryReviewsNone")
            : t("settings.account.security.summaryReviewNext", {
                device: deviceLabel(next.name),
                place:
                  next.location.type === "known"
                    ? placeLabel(next.location)
                    : t("settings.account.security.unknownLocation"),
              })
        }
        href={`#${SIGNED_IN_DEVICES_SECTION_ID}`}
        title={t("settings.account.security.summaryReviews", {
          count: pendingReviews.length,
        })}
        tone={next === undefined ? "ok" : "attention"}
      />
    </section>
  );
};
