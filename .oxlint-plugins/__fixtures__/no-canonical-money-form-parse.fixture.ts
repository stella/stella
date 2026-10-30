import { parseLocaleMinorUnits, tryToMinorUnits } from "@stll/money";

declare const field: { state: { value: string } };

// oxlint-disable-next-line no-canonical-money-form-parse/no-canonical-money-form-parse -- fixture proves canonical parsing is rejected for form text.
tryToMinorUnits({ amount: field.state.value, currency: "EUR" });
parseLocaleMinorUnits({ amount: field.state.value, currency: "EUR", locale: "sk-SK" });
tryToMinorUnits({ amount: "1234.56", currency: "EUR" });
