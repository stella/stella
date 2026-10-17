type SeparateNavigationOptions<PerformanceResult, DepthResult> = {
  collectDepth: () => Promise<DepthResult>;
  collectPerformance: () => Promise<PerformanceResult>;
};

/** Keeps the round barrier out of the navigation whose timings are reported. */
export const collectSeparateNavigationMeasurements = async <
  PerformanceResult,
  DepthResult,
>({
  collectDepth,
  collectPerformance,
}: SeparateNavigationOptions<PerformanceResult, DepthResult>) => {
  const performance = await collectPerformance();
  const depth = await collectDepth();
  return { depth, performance };
};
