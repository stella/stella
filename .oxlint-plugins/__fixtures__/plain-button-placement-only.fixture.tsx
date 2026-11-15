// Passive regression fixture for `plain-button-placement-only`.
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag; if
// the rule regresses the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. Lines without a
// directive cover the allow-list and must keep passing.

import { Button } from "@stll/ui/button";
import { cn } from "@stll/ui/lib/utils";

// --- Flagged: a plain button styled at the call site ---
export const _flagged = ({
  active,
  label,
}: {
  active: boolean;
  label: string;
}) => (
  <>
    <Button
      variant="plain"
      // oxlint-disable-next-line plain-button-placement-only/plain-button-placement-only
      className="hover:bg-muted flex w-full rounded-md px-2"
    >
      {label}
    </Button>
    <Button
      variant="plain"
      // oxlint-disable-next-line plain-button-placement-only/plain-button-placement-only
      className={cn("flex", active && "text-primary font-medium")}
    >
      {label}
    </Button>
    <Button
      variant={active ? "plain" : "ghost"}
      // oxlint-disable-next-line plain-button-placement-only/plain-button-placement-only
      className="border-border block border shadow-xs"
    >
      {label}
    </Button>
  </>
);

// --- Allowed: placement on the button, the look on its content ---
export const _allowed = ({ label }: { label: string }) => (
  <>
    <Button
      variant="plain"
      // expect-clean: plain-button-placement-only/plain-button-placement-only
      className="flex w-full min-w-0 pointer-coarse:min-h-11"
    >
      <span className="hover:bg-muted rounded-md px-2">{label}</span>
    </Button>
    <Button
      variant="plain"
      // expect-clean: plain-button-placement-only/plain-button-placement-only
      className="absolute inset-0 z-10 before:absolute before:-inset-2"
    >
      {label}
    </Button>
    <Button
      variant="ghost"
      // expect-clean: plain-button-placement-only/plain-button-placement-only
      className="text-muted-foreground"
    >
      {label}
    </Button>
  </>
);
