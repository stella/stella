type SlugifyAsciiOptions = {
  fallback: string;
  maxLength: number;
};

export const slugifyAscii = (
  value: string,
  { fallback, maxLength }: SlugifyAsciiOptions,
): string => {
  let buffer = "";
  let lastWasSeparator = true;

  for (const character of value.toLowerCase()) {
    const isSlugCharacter =
      (character >= "a" && character <= "z") ||
      (character >= "0" && character <= "9");
    if (isSlugCharacter) {
      buffer += character;
      lastWasSeparator = false;
      continue;
    }
    if (!lastWasSeparator) {
      buffer += "-";
      lastWasSeparator = true;
    }
  }

  let clipped = buffer.slice(0, maxLength);
  while (clipped.endsWith("-")) {
    clipped = clipped.slice(0, -1);
  }

  return clipped || fallback;
};
