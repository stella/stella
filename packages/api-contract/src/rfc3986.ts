const RFC3986_EXTRA_COMPONENT_CHARACTERS = /[!'()*]/g;

/** Encode one opaque URI component using the RFC 3986 unreserved set. */
export const encodeRfc3986Component = (value: string) =>
  encodeURIComponent(value).replace(
    RFC3986_EXTRA_COMPONENT_CHARACTERS,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
