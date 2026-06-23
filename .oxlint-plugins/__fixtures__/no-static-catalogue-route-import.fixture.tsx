// Passive regression fixture for
// `no-static-catalogue-route-import/no-static-catalogue-route-import`.

import { lazy } from "react";

import type { CatalogueBrowserFilterKind } from "@/routes/_protected.knowledge/-components/catalogue/catalogue-browser";
// oxlint-disable-next-line no-static-catalogue-route-import/no-static-catalogue-route-import
import { CatalogueBrowser } from "@/routes/_protected.knowledge/-components/catalogue/catalogue-browser";

const LazyCatalogueBrowser = lazy(async () => {
  const module =
    await import("@/routes/_protected.knowledge/-components/catalogue/catalogue-browser");
  return { default: module.CatalogueBrowserWithRouteData };
});

export function StaticCatalogueRouteImportFixture({
  kind,
}: {
  kind: CatalogueBrowserFilterKind;
}) {
  return (
    <>
      <LazyCatalogueBrowser initialKind={kind} organizationId="org_fixture" />
      <CatalogueBrowser
        canManageCustomTools={false}
        initialKind={kind}
        organizationId="org_fixture"
      />
    </>
  );
}
