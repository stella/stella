// Plan facts the pricing page renders. Prose lives in the catalogs
// (`pricing.*`); amounts and plan names stay here so no translation can
// change a price. Plan names are not translated and, like the brand, are
// always lowercase.

const PRICING_CURRENCY = "EUR";

export const billingIntervals = ["monthly", "yearly"] as const;
export type BillingInterval = (typeof billingIntervals)[number];

// "agreed": members and terms are set with the firm, so the card states none.
type PlanSeating =
  { type: "single" } | { type: "perSeat" } | { type: "agreed" };

type PlanPrice =
  | { type: "free" }
  | { type: "onRequest" }
  // Both amounts are per month (per seat on a per-seat plan); the yearly
  // charge is derived so it cannot disagree with the monthly figure shown.
  | { type: "paid"; monthly: number; yearlyPerMonth: number };

type PricingPlan = {
  id: string;
  name: Lowercase<string>;
  seating: PlanSeating;
  price: PlanPrice;
};

export const pricingPlans = [
  {
    id: "free",
    name: "free",
    seating: { type: "single" },
    price: { type: "free" },
  },
  {
    id: "solo",
    name: "solo",
    seating: { type: "single" },
    price: { type: "paid", monthly: 29, yearlyPerMonth: 24 },
  },
  {
    id: "team",
    name: "team",
    seating: { type: "perSeat" },
    price: { type: "paid", monthly: 59, yearlyPerMonth: 49 },
  },
  {
    id: "enterprise",
    name: "enterprise",
    seating: { type: "agreed" },
    price: { type: "onRequest" },
  },
] as const satisfies readonly PricingPlan[];

export type PricingPlanId = (typeof pricingPlans)[number]["id"];

const MONTHS_PER_YEAR = 12;

export const yearlyTotal = (yearlyPerMonth: number): number =>
  yearlyPerMonth * MONTHS_PER_YEAR;

// Whole-euro amounts render without decimals ("29 €", "€29"); the locale
// decides symbol position, spacing, and digits.
export const formatPrice = (amount: number, hreflang: string): string =>
  new Intl.NumberFormat(hreflang, {
    style: "currency",
    currency: PRICING_CURRENCY,
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: Number.isInteger(amount) ? 0 : 2,
  }).format(amount);
