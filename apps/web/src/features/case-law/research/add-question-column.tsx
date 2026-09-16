import { panic } from "better-result";

import { useRequireAccount } from "@/components/auth/use-require-account";
import { BulkAddColumns } from "@/components/workspaces/bulk-add-columns";
import type {
  QuestionColumnSurface,
  QuestionSuggestionScope,
} from "@/features/case-law/research/question-columns.logic";

/**
 * What pressing the add-question control does here, or null where there is no
 * control to draw: a surface with nothing to ask of, and a member the
 * organization has not granted `create`.
 *
 * Callers ask this before reserving room for the control. The table's rail is
 * a transparent absolute strip over the last columns, so a rail placed for a
 * control that renders nothing would swallow pointer input on those cells.
 */
type QuestionColumnAddAction = {
  /** Whether the press opens the composer, or the account gate before it. */
  mode: "open" | "gate";
  suggestion: QuestionSuggestionScope;
};

export const questionColumnAddAction = (
  surface: QuestionColumnSurface,
): QuestionColumnAddAction | null => {
  switch (surface.type) {
    case "hidden":
      return null;
    case "gated":
      return { mode: "gate", suggestion: surface.suggestion };
    case "available":
      // A write affordance: a member the organization has not granted `create`
      // gets the table without it, not a trigger that fails on submit.
      return surface.grants.create
        ? { mode: "open", suggestion: surface.suggestion }
        : null;
    default:
      surface satisfies never;
      return panic(`Unhandled question column surface: ${String(surface)}`);
  }
};

type AddQuestionColumnProps = {
  surface: QuestionColumnSurface;
  /** The toolbar's labelled button, or the table's own end rail. */
  triggerVariant: "labelled" | "rail";
};

/**
 * The one way a question column is added, wherever the control is drawn.
 *
 * A member with the grant opens the composer. A reader without an account gets
 * the same trigger in the same place and presses it into the account gate, so
 * the results table never quietly loses the affordance it has for everyone
 * else. Both branches read `questionColumnAddAction`, so what is drawn and
 * what a caller reserves room for cannot disagree.
 */
export const AddQuestionColumn = ({
  surface,
  triggerVariant,
}: AddQuestionColumnProps) => {
  const { accountDialog, ensureAccount } = useRequireAccount();
  const action = questionColumnAddAction(surface);

  if (action === null) {
    return null;
  }

  if (action.mode === "open") {
    return (
      <BulkAddColumns
        target={{ kind: "organisation", suggestion: action.suggestion }}
        triggerVariant={triggerVariant}
      />
    );
  }

  return (
    <>
      <BulkAddColumns
        // Held closed: the press is answered by the gate, and the composer
        // opens on the next visit, with an organization behind it.
        open={false}
        onOpenChange={(open) => {
          if (open) {
            ensureAccount("writeResearchQuestion");
          }
        }}
        target={{ kind: "organisation", suggestion: action.suggestion }}
        triggerVariant={triggerVariant}
      />
      {accountDialog}
    </>
  );
};
