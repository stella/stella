import type { ReactNode } from "react";

import { CheckIcon, SigmaIcon } from "lucide-react";
import { useFormatter, useLocale } from "use-intl";

import type {
  CalculationKind,
  CalculationResult,
  CalculationValue,
} from "@stll/calculations";
import { runCalculation } from "@stll/calculations";
import { type CentsAmount, formatMoneyCents } from "@stll/money";
import { Button } from "@stll/ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "@stll/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@stll/ui/tooltip";

import type {
  CalculationFormatters,
  FormattedCalculation,
} from "./calculation-format";
import { formatCalculationResult } from "./calculation-format";
import { applyCalculationSelection } from "./calculation-selection";
import type { CalculationSelection } from "./calculation-selection";

/** A property a view can calculate over, with the reductions its values allow. */
export type CalculationProperty = {
  id: string;
  name: string;
  kinds: readonly CalculationKind[];
};

export type WorkspaceCalculationLabels = {
  choose: string;
  kinds: Record<CalculationKind, string>;
  noProperties: string;
  none: string;
  unavailable: string;
};

export type CalculationPickerProps = {
  labels: WorkspaceCalculationLabels;
  properties: readonly CalculationProperty[];
  selections: readonly CalculationSelection[];
  onChange: (selections: CalculationSelection[]) => void;
  /** Trigger content. Defaults to the calculation glyph. */
  children?: ReactNode;
};

/**
 * Choose what a view calculates: a property, then a reduction. Every step is a
 * menu item, so the whole choice is reachable from the keyboard.
 */
export const CalculationPicker = ({
  labels,
  properties,
  selections,
  onChange,
  children,
}: CalculationPickerProps) => {
  if (properties.length === 0) {
    return null;
  }

  const select = (propertyId: string, kind: CalculationKind | null) => {
    onChange(applyCalculationSelection({ selections, propertyId, kind }));
  };

  return (
    <Menu>
      <MenuTrigger
        aria-label={labels.choose}
        render={<Button size="icon-xs" variant="ghost" />}
      >
        {children ?? <SigmaIcon />}
      </MenuTrigger>
      <MenuPopup>
        {properties.map((property) => {
          const selected = selections.find(
            (selection) => selection.propertyId === property.id,
          );

          return (
            <MenuSub key={property.id}>
              <MenuSubTrigger>{property.name}</MenuSubTrigger>
              <MenuSubPopup>
                <MenuItem onClick={() => select(property.id, null)}>
                  {selected === undefined ? <CheckIcon /> : <span />}
                  {labels.none}
                </MenuItem>
                {property.kinds.map((kind) => (
                  <MenuItem
                    key={kind}
                    onClick={() => select(property.id, kind)}
                  >
                    {selected?.kind === kind ? <CheckIcon /> : <span />}
                    {labels.kinds[kind]}
                  </MenuItem>
                ))}
              </MenuSubPopup>
            </MenuSub>
          );
        })}
      </MenuPopup>
    </Menu>
  );
};

export type CalculationKindPickerProps = {
  labels: WorkspaceCalculationLabels;
  /** Reductions this column's values allow. */
  kinds: readonly CalculationKind[];
  /** The reduction currently shown, or null for none. */
  value: CalculationKind | null;
  onChange: (kind: CalculationKind | null) => void;
  /** Trigger content. Defaults to the calculation glyph. */
  children?: ReactNode;
};

/**
 * Choose one column's reduction. The board picks a property first (it shows one
 * line for the whole board); a table column already is the property.
 */
export const CalculationKindPicker = ({
  labels,
  kinds,
  value,
  onChange,
  children,
}: CalculationKindPickerProps) => {
  if (kinds.length === 0) {
    return null;
  }

  return (
    <Menu>
      <MenuTrigger
        aria-label={labels.choose}
        render={<Button size="icon-xs" variant="ghost" />}
      >
        {children ?? <SigmaIcon />}
      </MenuTrigger>
      <MenuPopup>
        <MenuItem onClick={() => onChange(null)}>
          {value === null ? <CheckIcon /> : <span />}
          {labels.none}
        </MenuItem>
        {kinds.map((kind) => (
          <MenuItem key={kind} onClick={() => onChange(kind)}>
            {value === kind ? <CheckIcon /> : <span />}
            {labels.kinds[kind]}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
};

export type CalculationSummaryProps = {
  calculation: FormattedCalculation;
};

/**
 * The calculation as one compact line. When it reduces to several currencies
 * the line stays short and the full set sits behind a tooltip.
 */
export const CalculationSummary = ({
  calculation,
}: CalculationSummaryProps) => {
  if (calculation.breakdown.length === 0) {
    return (
      <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
        {calculation.summary}
      </span>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="text-muted-foreground shrink-0 text-xs tabular-nums" />
        }
      >
        {calculation.summary}
      </TooltipTrigger>
      <TooltipPopup>
        <ul>
          {calculation.breakdown.map((entry) => (
            <li key={entry}>{entry}</li>
          ))}
        </ul>
      </TooltipPopup>
    </Tooltip>
  );
};

export type UseCalculationParams = {
  kind: CalculationKind;
  labels: WorkspaceCalculationLabels;
  values: readonly CalculationValue[];
  /** Every value in the view, for a reduction relative to the whole. */
  scopeValues?: readonly CalculationValue[] | undefined;
};

/** Reduce a column's values and format the answer for the reader's locale. */
export const useCalculation = ({
  kind,
  labels,
  values,
  scopeValues,
}: UseCalculationParams): FormattedCalculation => {
  const formatters = useCalculationFormatters();
  return formatCalculationResult({
    result: runCalculation({ kind, values, scopeValues }),
    formatters,
    labels: {
      kind: labels.kinds[kind],
      unavailable: labels.unavailable,
    },
  });
};

/** One configured calculation, reduced over a column and rendered compactly. */
export const ColumnCalculation = (params: UseCalculationParams) => (
  <CalculationSummary calculation={useCalculation(params)} />
);

export type { CalculationSelection };
export type { CalculationResult };

const useCalculationFormatters = (): CalculationFormatters => {
  const format = useFormatter();
  const locale = useLocale();

  return {
    number: (value) => format.number(value),
    money: (amountCents: CentsAmount, currency: string) =>
      formatMoneyCents({ amountCents, currency, locale }),
    percent: (ratio) => format.number(ratio, { style: "percent" }),
  };
};
