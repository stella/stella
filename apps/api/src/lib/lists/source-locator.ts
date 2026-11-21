import { parseSpotTarget } from "@stll/api-contract/spot";

export const parseLegalListSourceLocator = (input: unknown) =>
  parseSpotTarget(input);
