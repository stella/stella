// Passive regression fixture for `prefer-temporal/prefer-temporal`.

declare const epochMilliseconds: number;
declare const isoTimestamp: string;

// oxlint-disable-next-line prefer-temporal/prefer-temporal -- fixture: ambient Temporal would skip the fallback on unsupported runtimes
export const ambientTemporalInstant = Temporal.Now.instant();
// oxlint-disable-next-line prefer-temporal/prefer-temporal -- fixture: global-object access cannot evade explicit Temporal imports
export const globalTemporalInstant = globalThis.Temporal.Now.instant();

// oxlint-disable-next-line prefer-temporal/prefer-temporal -- fixture: ambient clock statics must use Temporal
export const ambientEpoch = Date.now();
// oxlint-disable-next-line prefer-temporal/prefer-temporal -- fixture: global-object access cannot evade the rule
export const parsedEpoch = globalThis.Date.parse(isoTimestamp);
// oxlint-disable-next-line prefer-temporal/prefer-temporal -- fixture: legacy calendar construction must use Temporal
export const localCalendarDate = new Date(2026, 8, 8);
// oxlint-disable-next-line prefer-temporal/prefer-temporal, unicorn/new-for-builtins -- fixture: callable Date must be rejected
export const ambientDateString = Date();

const DateAlias = Date;
const { UTC: utcAlias } = DateAlias;
// oxlint-disable-next-line prefer-temporal/prefer-temporal -- fixture: stable aliases retain Date provenance
export const aliasedUtc = utcAlias(2026, 8, 8);

const typedDate: Date = new Date(epochMilliseconds);
// oxlint-disable-next-line prefer-temporal/prefer-temporal -- fixture: typed Date calendar getters must use Temporal
export const calendarYear = typedDate.getUTCFullYear();

const inferredDate = new Date(isoTimestamp);
const inferredDateAlias = inferredDate;
// oxlint-disable-next-line prefer-temporal/prefer-temporal -- fixture: inferred local aliases retain Date provenance
inferredDateAlias.setMonth(8);

// oxlint-disable-next-line prefer-temporal/prefer-temporal -- fixture: immediate legacy formatting is not a boundary
export const localeDate = new Date(isoTimestamp).toLocaleDateString();

// Approved database, protocol, and third-party boundary shapes.
export const databaseDate = new Date(epochMilliseconds);
export const timestampEpoch = new Date(isoTimestamp).getTime();
export const isoSerialization = new Date(epochMilliseconds).toISOString();
export const jsonSerialization = new Date(epochMilliseconds).toJSON();
export const httpSerialization = new Date(epochMilliseconds).toUTCString();

const localDateApi = {
  now: () => 0,
  parse: (_value: string) => 0,
  UTC: (..._parts: number[]) => 0,
};
export const localStaticLookalikes = [
  localDateApi.now(),
  localDateApi.parse(isoTimestamp),
  localDateApi.UTC(2026, 8, 8),
];

export const formApi = {
  setDate: (_value: string) => undefined,
  getFullYear: () => 2026,
};
formApi.setDate("2026-09-08");
formApi.getFullYear();

export const withShadowedDate = (Date: {
  (): string;
  now: () => number;
  new (...parts: number[]): object;
}) => ({
  value: Date(),
  now: Date.now(),
  date: new Date(2026, 8, 8),
});
