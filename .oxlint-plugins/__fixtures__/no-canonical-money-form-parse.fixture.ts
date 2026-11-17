import {
  parseLocaleMinorUnits,
  toMinorUnits,
  tryToMinorUnits,
} from "@stll/money";

declare const field: { state: { value: string } };

// oxlint-disable-next-line no-canonical-money-form-parse/no-canonical-money-form-parse -- fixture proves canonical parsing is rejected for form text.
tryToMinorUnits({ amount: field.state.value, currency: "EUR" });
parseLocaleMinorUnits({
  amount: field.state.value,
  currency: "EUR",
  locale: "sk-SK",
});
tryToMinorUnits({ amount: "1234.56", currency: "EUR" });

declare const dataset: { value: string };
// oxlint-disable-next-line no-canonical-money-form-parse/no-canonical-money-form-parse -- fixture proves transformed form values are rejected.
tryToMinorUnits({ amount: dataset.value, currency: "EUR" });
parseLocaleMinorUnits({
  amount: dataset.value,
  currency: "EUR",
  locale: "sk-SK",
});

declare const draft: string;
// oxlint-disable-next-line no-canonical-money-form-parse/no-canonical-money-form-parse -- fixture proves form draft aliases are rejected.
toMinorUnits({ amount: draft, currency: "EUR" });
parseLocaleMinorUnits({ amount: draft, currency: "EUR", locale: "sk-SK" });

const shadowedParser = () => {
  // oxlint-disable-next-line no-shadow -- fixture proves a local shadow is not the imported parser.
  const tryToMinorUnits = ({ amount }: { amount: string }) => amount;
  // expect-clean: no-canonical-money-form-parse/no-canonical-money-form-parse
  return tryToMinorUnits({ amount: field.state.value });
};
void shadowedParser;
