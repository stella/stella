export const isPublicSsrPath = (pathname: string) =>
  pathname === "/law" ||
  pathname.startsWith("/law/") ||
  pathname === "/tools" ||
  pathname.startsWith("/tools/");
