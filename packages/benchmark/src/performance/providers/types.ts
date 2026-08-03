import type { Distribution } from "../statistics";

export const CROSS_PROVIDER_REPORT_SCHEMA_VERSION = 2 as const;

export const CROSS_PROVIDER_IDS = [
  "stella-full",
  "stella-regex-detectors-only",
  "openredaction-default",
  "scrubadub-base",
  "datafog-regex-only",
] as const;

export type CrossProviderId = (typeof CROSS_PROVIDER_IDS)[number];

export type ProviderScope =
  | "full-pipeline"
  | "base-install"
  | "regex-only"
  | "regex-detectors-only";

export type ProviderSample = {
  readonly provider: CrossProviderId;
  readonly providerVersion: string;
  readonly runtimeVersion: string;
  readonly scope: ProviderScope;
  readonly inputBytes: number;
  readonly inputCharacters: number;
  readonly inputSha256: string;
  readonly outputCount: number;
  readonly outputDigest: string;
  readonly outputLabelCounts: Readonly<Record<string, number>>;
  readonly initSeconds: number;
  readonly firstCallSeconds: number;
  readonly secondCallSeconds: number;
  /** Total worker CPU time since process start, including runtime startup. */
  readonly processCpuSeconds: number;
};

export type IsolatedProviderSample = ProviderSample & {
  readonly startupSeconds: number;
  /** Parent-observed spawn-to-clean-worker-exit duration. */
  readonly wallSeconds: number;
};

export type ProviderResult = {
  readonly provider: CrossProviderId;
  readonly providerVersion: string;
  readonly runtimeVersion: string;
  readonly scope: ProviderScope;
  readonly inputBytes: number;
  readonly inputCharacters: number;
  readonly inputSha256: string;
  readonly outputCount: number;
  readonly outputDigest: string;
  readonly outputLabelCounts: Readonly<Record<string, number>>;
  readonly startupSeconds: Distribution;
  readonly wallSeconds: Distribution;
  readonly initSeconds: Distribution;
  readonly firstCallSeconds: Distribution;
  readonly secondCallSeconds: Distribution;
  readonly processCpuSeconds: Distribution;
  readonly secondCallCharactersPerSecond: Distribution;
};
