// Passive regression fixture for
// `route-pending-component/pending-module-imports`.
//
// The disabled lines must be flagged: a pending half the frame draws
// (`framePendingView`) imports only
// pending-safe modules and calls no context hook. The rest is clean.

import type { ReactNode } from "react";

import { useParams } from "@tanstack/react-router";

// oxlint-disable-next-line route-pending-component/pending-module-imports
import { Button } from "@stll/ui/button";
import { LandingRowsPending } from "@stll/ui/landing-shell";
import { framePendingView } from "@/routes/-pending-view.logic";

// expect-clean: route-pending-component/pending-module-imports
export const FixtureShell = ({ rows }: { rows: ReactNode }) => (
  <section>{rows}</section>
);

export const FixturePending = () => {
  const params = useParams({ strict: false });
  return (
    <FixtureShell
      rows={
        Object.keys(params).length > 0 ? <LandingRowsPending /> : <Button />
      }
    />
  );
};

export const FixtureStrictPending = () => {
  // oxlint-disable-next-line route-pending-component/pending-module-imports
  const params = useParams({ from: "/__fixture" });
  return <FixtureShell rows={String(params)} />;
};

export const FixtureFramePending = framePendingView(FixturePending);
