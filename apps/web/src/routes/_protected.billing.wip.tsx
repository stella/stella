import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { formatMoneyCents } from "@stll/money";
import { parsePlainDate, Temporal } from "@stll/time";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { ScrollArea } from "@stll/ui/scroll-area";
import { Skeleton } from "@stll/ui/skeleton";
import { stellaToast } from "@stll/ui/toast";

import { InlineEdit } from "@/components/inline-edit";
import { MatterContextMenu } from "@/components/workspaces/matter-context-menu";
import type { WebApiRoutes } from "@/generated/api-routes.gen";
import { usePermissions } from "@/hooks/use-permissions";
import { isTimeBillingRouteEnabled } from "@/hooks/use-time-billing-preview";
import { getFormattingLocale } from "@/i18n/i18n-store";
import { getAnalytics } from "@/lib/analytics/provider";
import { authClient } from "@/lib/auth-client";
import { roleOptions } from "@/lib/auth-queries";
import { detached } from "@/lib/detached";
import {
  ensureRouteInfiniteQueryData,
  ensureRouteQueryData,
} from "@/lib/react-query";
import {
  wipClientsInfiniteOptions,
  wipMattersInfiniteOptions,
} from "@/queries/billing-wip";

export const Route = createFileRoute("/_protected/billing/wip")({
  validateSearch: (search) => ({
    asOf:
      typeof search["asOf"] === "string" &&
      parsePlainDate(search["asOf"]) !== null
        ? search["asOf"]
        : Temporal.Now.plainDateISO("UTC").toString(),
    view:
      search["view"] === "clients"
        ? ("clients" as const)
        : ("matters" as const),
  }),
  loaderDeps: ({ search }) => search,
  beforeLoad: async ({ context }) => {
    if (!isTimeBillingRouteEnabled()) {
      redirect({ to: "/workspaces", throw: true });
    }
    const role = await ensureRouteQueryData(context.queryClient, roleOptions);
    if (
      !authClient.organization.checkRolePermission({
        role,
        permissions: { workspace: ["read"], timeEntry: ["read"] },
      })
    ) {
      redirect({ to: "/workspaces", throw: true });
    }
  },
  loader: async ({ context, deps }) => {
    const args = {
      organizationId: context.user.activeOrganizationId,
      userId: context.user.id,
      asOf: deps.asOf,
    };
    if (deps.view === "clients") {
      await ensureRouteInfiniteQueryData(
        context.queryClient,
        wipClientsInfiniteOptions(args),
      );
      return;
    }
    await ensureRouteInfiniteQueryData(
      context.queryClient,
      wipMattersInfiniteOptions(args),
    );
  },
  pendingComponent: () => (
    <div className="p-4">
      <Skeleton className="h-28 w-full" />
    </div>
  ),
  component: WipPage,
});

function WipPage() {
  const t = useTranslations();
  const { asOf, view } = Route.useSearch({
    select: (search) => ({ asOf: search.asOf, view: search.view }),
  });
  const navigate = Route.useNavigate();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
        <div>
          <h1 className="text-lg font-medium">{t("billing.wip.title")}</h1>
          <p className="text-muted-foreground text-sm">
            {t("billing.wip.description")}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant={view === "matters" ? "secondary" : "ghost"}
            onClick={() =>
              detached(
                navigate({ search: { asOf, view: "matters" } }),
                "wip.navigate",
              )
            }
          >
            {t("common.matters")}
          </Button>
          <Button
            variant={view === "clients" ? "secondary" : "ghost"}
            onClick={() =>
              detached(
                navigate({ search: { asOf, view: "clients" } }),
                "wip.navigate",
              )
            }
          >
            {t("contacts.title")}
          </Button>
        </div>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex max-w-6xl flex-col gap-5 p-4">
          {view === "clients" ? (
            <ClientWip key={asOf} />
          ) : (
            <MatterWip key={asOf} />
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

const useWipArgs = () => {
  const asOf = Route.useSearch({ select: (search) => search.asOf });
  const user = Route.useRouteContext({ select: (context) => context.user });
  return { organizationId: user.activeOrganizationId, userId: user.id, asOf };
};

type CurrencyWip =
  WebApiRoutes["billing"]["wip"]["get"]["response"][200]["totalsByCurrency"][number];

const Amounts = ({ amounts }: { amounts: readonly CurrencyWip[] }) => {
  const t = useTranslations();
  const locale = getFormattingLocale();
  return (
    <div className="flex flex-col gap-3">
      {amounts.map((value) => {
        const money = (amount: string) =>
          formatMoneyCents({
            amountCents: BigInt(amount),
            currency: value.currency,
            locale,
          });
        const ageValues = {
          days0To30: {
            label: t("billing.wip.days0To30"),
            amount: value.aged.days0To30,
          },
          days31To60: {
            label: t("billing.wip.days31To60"),
            amount: value.aged.days31To60,
          },
          days61To90: {
            label: t("billing.wip.days61To90"),
            amount: value.aged.days61To90,
          },
          daysOver90: {
            label: t("billing.wip.daysOver90"),
            amount: value.aged.daysOver90,
          },
        } satisfies Record<
          keyof CurrencyWip["aged"],
          { label: string; amount: string }
        >;
        return (
          <div key={value.currency} className="bg-muted/30 rounded-md p-3">
            <div className="flex flex-wrap justify-between gap-3 text-sm tabular-nums">
              <span className="font-medium">
                <BidiText>{value.currency}</BidiText> ·{" "}
                {money(value.totalAmount)}
              </span>
              <span className="text-muted-foreground">
                {t("billing.wip.timeValue", {
                  amount: money(value.timeAmount),
                })}{" "}
                ·{" "}
                {t("billing.wip.expenseValue", {
                  amount: money(value.expenseAmount),
                })}
              </span>
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              {Object.entries(ageValues).map(([bucket, { label, amount }]) => (
                <div key={bucket}>
                  <dt className="text-muted-foreground text-xs">{label}</dt>
                  <dd className="tabular-nums">{money(amount)}</dd>
                </div>
              ))}
            </dl>
            {BigInt(value.unpricedTimeEntryCount) > 0n && (
              <p className="text-muted-foreground mt-2 text-xs">
                {t("billing.wip.unpriced", {
                  count: new Intl.NumberFormat(locale).format(
                    BigInt(value.unpricedTimeEntryCount),
                  ),
                })}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
};

const MatterWip = () => {
  const t = useTranslations();
  const query = useSuspenseInfiniteQuery(
    wipMattersInfiniteOptions(useWipArgs()),
  );
  const canCreate = usePermissions({ invoice: ["create"] });
  const first = query.data.pages.at(0);
  const items = query.data.pages.flatMap((page) => page.items);
  return (
    <>
      {first && (
        <section>
          <h2 className="mb-2 text-sm font-medium">
            {t("billing.wip.currencyTotals")}
          </h2>
          <Amounts amounts={first.totalsByCurrency} />
        </section>
      )}
      {items.length === 0 && (
        <p className="text-muted-foreground text-sm">
          {t("billing.wip.empty")}
        </p>
      )}
      {items.map((item) => (
        <section key={item.matterId} className="rounded-lg border p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <MatterContextMenu
                target={{
                  id: item.matterId,
                  name: item.matterName,
                  color: null,
                  client:
                    item.clientName === null
                      ? null
                      : { displayName: item.clientName },
                }}
              >
                {({ rename }) =>
                  rename.status === "editing" ? (
                    <InlineEdit
                      onChange={rename.setDraft}
                      onCancel={rename.cancel}
                      onCommit={rename.commit}
                      value={rename.draft}
                    />
                  ) : (
                    <Link
                      to="/workspaces/$workspaceId"
                      params={{ workspaceId: item.matterId }}
                      className="font-medium hover:underline"
                    >
                      <BidiText>{item.matterName}</BidiText>
                    </Link>
                  )
                }
              </MatterContextMenu>
              {item.clientName && (
                <p className="text-muted-foreground text-sm">
                  <BidiText>{item.clientName}</BidiText>
                </p>
              )}
            </div>
            {canCreate && (
              <Link
                to="/workspaces/$workspaceId/invoices"
                params={{ workspaceId: item.matterId }}
                search={{}}
              >
                <Button size="sm" variant="outline">
                  {t("billing.invoices.createInvoice")}
                </Button>
              </Link>
            )}
          </div>
          <Amounts amounts={item.currencies} />
        </section>
      ))}
      <LoadMore
        hasNext={query.hasNextPage}
        loading={query.isFetchingNextPage}
        load={async () => {
          await query.fetchNextPage({ throwOnError: true });
        }}
      />
    </>
  );
};

const ClientWip = () => {
  const t = useTranslations();
  const query = useSuspenseInfiniteQuery(
    wipClientsInfiniteOptions(useWipArgs()),
  );
  const first = query.data.pages.at(0);
  const items = query.data.pages.flatMap((page) => page.items);
  return (
    <>
      {first && (
        <section>
          <h2 className="mb-2 text-sm font-medium">
            {t("billing.wip.currencyTotals")}
          </h2>
          <Amounts amounts={first.totalsByCurrency} />
        </section>
      )}
      {items.length === 0 && (
        <p className="text-muted-foreground text-sm">
          {t("billing.wip.empty")}
        </p>
      )}
      {items.map((item) => (
        <section
          key={item.clientId ?? "unassigned"}
          className="rounded-lg border p-4"
        >
          <h2 className="mb-3 font-medium">
            <BidiText>
              {item.clientName ?? t("workspaces.parties.noClient")}
            </BidiText>
          </h2>
          <Amounts amounts={item.currencies} />
        </section>
      ))}
      <LoadMore
        hasNext={query.hasNextPage}
        loading={query.isFetchingNextPage}
        load={async () => {
          await query.fetchNextPage({ throwOnError: true });
        }}
      />
    </>
  );
};

const LoadMore = ({
  hasNext,
  loading,
  load,
}: {
  hasNext: boolean;
  loading: boolean;
  load: () => Promise<void>;
}) => {
  const t = useTranslations();
  const loadPage = async () => {
    const result = await Result.tryPromise(load);
    if (result.isErr()) {
      getAnalytics().captureError(result.error);
      stellaToast.add({
        type: "error",
        title: t("common.somethingWentWrong"),
        description: result.error.message,
      });
    }
  };
  if (!hasNext) {
    return null;
  }
  return (
    <Button
      variant="outline"
      disabled={loading}
      onClick={() => detached(loadPage(), "wip.next-page")}
    >
      {loading ? t("common.loading") : t("common.loadMore")}
    </Button>
  );
};
