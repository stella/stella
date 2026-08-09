const RFC3986_EXTRA_COMPONENT_ENCODINGS = {
  "!": "%21",
  "'": "%27",
  "(": "%28",
  ")": "%29",
  "*": "%2A",
} as const;

const RFC3986_EXTRA_COMPONENT_CHARACTERS = /[!'()*]/gu;

const isRfc3986ExtraComponentCharacter = (
  value: string,
): value is keyof typeof RFC3986_EXTRA_COMPONENT_ENCODINGS =>
  Object.hasOwn(RFC3986_EXTRA_COMPONENT_ENCODINGS, value);

const encodeRfc3986ExtraComponentCharacter = (character: string) => {
  if (!isRfc3986ExtraComponentCharacter(character)) {
    return character;
  }

  return RFC3986_EXTRA_COMPONENT_ENCODINGS[character];
};

/** Encode one opaque URI component using the RFC 3986 unreserved set. */
export const encodeRfc3986Component = (value: string) =>
  encodeURIComponent(value).replace(
    RFC3986_EXTRA_COMPONENT_CHARACTERS,
    encodeRfc3986ExtraComponentCharacter,
  );
