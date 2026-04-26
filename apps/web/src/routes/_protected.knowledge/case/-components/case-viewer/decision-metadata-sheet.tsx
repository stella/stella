import { Suspense } from "react";

import { useSuspenseQuery } from "@tanstack/react-query";
import { EllipsisIcon } from "lucide-react";

import { Button } from "@stella/ui/components/button";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
  SheetTrigger,
} from "@stella/ui/components/sheet";

import type { SafeId } from "@/lib/safe-id";
import { toSafeId } from "@/lib/safe-id";
import { MetadataPanel } from "@/routes/_protected.knowledge/case/-components/case-viewer/metadata-panel";
import { decisionOptions } from "@/routes/_protected.knowledge/case/-queries/decisions";

/**
 * Extract the ID from a composite URL param.
 * Format: "case-slug--id" or just "id" (legacy).
 */
const extractId = (param: string): SafeId<"caseLawDecision"> => {
  const sep = param.lastIndexOf("--");
  return toSafeId<"caseLawDecision">(sep !== -1 ? param.slice(sep + 2) : param);
};

const DecisionMetadataSheetInner = ({ decisionId }: { decisionId: string }) => {
  const { data: decision } = useSuspenseQuery(
    decisionOptions(extractId(decisionId)),
  );

  if (!decision.source) {
    return null;
  }

  return (
    <Sheet>
      <SheetTrigger render={<Button size="icon-sm" variant="ghost" />}>
        <EllipsisIcon className="size-5" />
      </SheetTrigger>
      <SheetPopup side="right">
        <SheetHeader>
          <SheetTitle>{decision.caseNumber}</SheetTitle>
          <SheetDescription>{decision.court}</SheetDescription>
        </SheetHeader>
        <SheetPanel>
          <MetadataPanel
            decision={{
              ...decision,
              source: decision.source,
            }}
          />
        </SheetPanel>
      </SheetPopup>
    </Sheet>
  );
};

export const DecisionMetadataSheet = ({
  decisionId,
}: {
  decisionId: string;
}) => (
  <Suspense>
    <DecisionMetadataSheetInner decisionId={decisionId} />
  </Suspense>
);
