/**
 * Changing which calculation a view shows for a property.
 *
 * The order of the list is the order the header draws, so a property that
 * already has a calculation keeps its place when its reduction changes.
 * Removing and re-appending would have read as the summary jumping to the end
 * of the row every time someone switched sum to average.
 */

import type { CalculationKind } from "@stll/calculations";

export type CalculationSelection = {
  propertyId: string;
  kind: CalculationKind;
};

export type ApplyCalculationSelectionParams = {
  selections: readonly CalculationSelection[];
  propertyId: string;
  /** The reduction to show, or null to stop showing one. */
  kind: CalculationKind | null;
};

export const applyCalculationSelection = ({
  selections,
  propertyId,
  kind,
}: ApplyCalculationSelectionParams): CalculationSelection[] => {
  if (kind === null) {
    return selections.filter(
      (selection) => selection.propertyId !== propertyId,
    );
  }

  const alreadyShown = selections.some(
    (selection) => selection.propertyId === propertyId,
  );

  if (alreadyShown) {
    return selections.map((selection) =>
      selection.propertyId === propertyId ? { propertyId, kind } : selection,
    );
  }

  return [...selections, { propertyId, kind }];
};
