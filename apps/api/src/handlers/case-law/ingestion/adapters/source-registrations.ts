import { panic } from "better-result";

import { checkProvisionCapabilityCoverage } from "@/api/lib/case-law/provision-capability-coverage";

/** Declared map keys remain authoritative across discovery capabilities. */
export const checkedSourceRegistrations = <
  TRegistration extends {
    readonly key: string;
    readonly source: {
      readonly key: string;
      readonly country: string;
      readonly language: string;
    };
  },
>(
  registrations: readonly TRegistration[],
): readonly TRegistration[] => {
  checkProvisionCapabilityCoverage(registrations.map(({ source }) => source));
  const seen = new Set<string>();
  for (const registration of registrations) {
    if (seen.has(registration.key)) {
      return panic(`Duplicate source registry key: ${registration.key}`);
    }
    seen.add(registration.key);
    if (registration.source.key !== registration.key) {
      return panic(`Source registry key mismatch for ${registration.key}`);
    }
  }
  return registrations;
};
