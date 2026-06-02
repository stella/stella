const SAFE_BUNDLED_ICON_DATA_URL =
  /^data:image\/(?:png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/u;

export const getCatalogueIconImageSrc = (
  icon: string | null | undefined,
): string | undefined => {
  const trimmed = icon?.trim();
  if (!trimmed) {
    return undefined;
  }

  if (!SAFE_BUNDLED_ICON_DATA_URL.test(trimmed)) {
    return undefined;
  }

  return trimmed;
};
