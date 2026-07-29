export const isExternalSharePath = (pathname: string): boolean =>
  pathname.startsWith("/share/") || pathname.startsWith("/shared/");
