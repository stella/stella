import { ENTITY_NAME_MAX_LENGTH, truncateEntityName } from "@stll/api-contract";

type ResolveSiblingNameOptions = {
  name: string;
  siblingNames: ReadonlySet<string>;
};

export const resolveSiblingName = ({
  name,
  siblingNames,
}: ResolveSiblingNameOptions): string => {
  if (!siblingNames.has(name)) {
    return name;
  }
  const lastDot = name.lastIndexOf(".");
  const rawBase = lastDot > 0 ? name.slice(0, lastDot) : name;
  const extension = lastDot > 0 ? name.slice(lastDot) : "";
  const base = rawBase.replace(/_\d+$/u, "");
  for (let number = 1; ; number += 1) {
    const suffix = `_${number}`;
    const boundedExtension = truncateEntityName(
      extension,
      ENTITY_NAME_MAX_LENGTH - suffix.length,
    );
    const boundedBase = truncateEntityName(
      base,
      ENTITY_NAME_MAX_LENGTH - suffix.length - boundedExtension.length,
    );
    const candidate = `${boundedBase}${suffix}${boundedExtension}`;
    if (!siblingNames.has(candidate)) {
      return candidate;
    }
  }
};
