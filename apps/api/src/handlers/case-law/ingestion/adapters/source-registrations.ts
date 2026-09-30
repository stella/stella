import { panic } from "better-result";

/** Declared map keys remain authoritative across discovery capabilities. */
export const checkedSourceRegistrations = <
  TRegistration extends {
    readonly key: string;
    readonly source: { readonly key: string };
  },
>(
  registrations: readonly TRegistration[],
): readonly TRegistration[] => {
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
