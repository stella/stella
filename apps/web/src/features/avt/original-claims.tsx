/**
 * What every original view (DOCX, PDF) shares: how a claim is marked, and
 * the claims with no place in the original, listed under the pages so they
 * stay one click away.
 */

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { ScrollArea } from "@stll/ui/scroll-area";
import type { TextMarkState } from "@stll/ui/text-mark";

import { StateSwatch } from "@/features/avt/state-chip";
import type { ClaimState, VerificationClaim } from "@/features/avt/types";

/** How one claim is drawn; `mark: null` leaves it unmarked but clickable. */
export type OriginalClaimMark = {
  state: ClaimState;
  mark: TextMarkState | null;
};

type UnlocatedClaimsProps = {
  claims: readonly VerificationClaim[];
  selected: VerificationClaim["id"] | null;
  markOf: (claim: VerificationClaim) => OriginalClaimMark;
  onSelect: (id: VerificationClaim["id"]) => void;
};

export const UnlocatedClaims = ({
  claims,
  selected,
  markOf,
  onSelect,
}: UnlocatedClaimsProps) => {
  const t = useTranslations();
  if (claims.length === 0) {
    return null;
  }
  return (
    <div className="flex max-h-32 shrink-0 flex-col border-t">
      <ScrollArea axis="vertical" className="min-h-0">
        <div className="space-y-1.5 px-4 py-2">
          <p className="text-muted-foreground text-xs font-medium">
            {t("avt.verification.notLocated", { count: claims.length })}
          </p>
          <ul className="flex flex-wrap gap-1.5">
            {claims.map((claim) => (
              <li className="min-w-0" key={claim.id}>
                <Button
                  aria-pressed={claim.id === selected}
                  className="max-w-64"
                  onClick={() => onSelect(claim.id)}
                  size="sm"
                  variant={claim.id === selected ? "secondary" : "outline"}
                >
                  <StateSwatch state={markOf(claim).state} />
                  <span className="truncate" dir="auto">
                    {claim.text}
                  </span>
                </Button>
              </li>
            ))}
          </ul>
        </div>
      </ScrollArea>
    </div>
  );
};
