// Plan facts the pricing page renders. Prose lives in the catalogs
// (`pricing.*`); amounts, storage, and plan names stay here so no translation
// can change a price. Plan names are not translated: they match what the app
// and checkout show.

export const PRICING_CURRENCY = "EUR";

export const billingIntervals = ["monthly", "yearly"] as const;
export type BillingInterval = (typeof billingIntervals)[number];

type PlanSeating = { type: "single" } | { type: "perSeat" };

type PlanPrice =
  | { type: "free" }
  // Both amounts are per month (per seat on a per-seat plan); the yearly
  // charge is derived so it cannot disagree with the monthly figure shown.
  | { type: "paid"; monthly: number; yearlyPerMonth: number };

type PricingPlan = {
  id: string;
  name: string;
  seating: PlanSeating;
  /** Storage in gigabytes, per seat on a per-seat plan. */
  storageGb: number;
  price: PlanPrice;
};

export const pricingPlans = [
  {
    id: "free",
    name: "Free",
    seating: { type: "single" },
    storageGb: 1,
    price: { type: "free" },
  },
  {
    id: "solo",
    name: "Solo",
    seating: { type: "single" },
    storageGb: 50,
    price: { type: "paid", monthly: 29, yearlyPerMonth: 24 },
  },
  {
    id: "team",
    name: "Team",
    seating: { type: "perSeat" },
    storageGb: 200,
    price: { type: "paid", monthly: 59, yearlyPerMonth: 49 },
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

// Locale-aware unit ("50 GB", fr "50 Go").
export const formatStorage = (gigabytes: number, hreflang: string): string =>
  new Intl.NumberFormat(hreflang, {
    style: "unit",
    unit: "gigabyte",
    unitDisplay: "short",
  }).format(gigabytes);
