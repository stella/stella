export const isPublicSsrPath = (pathname: string) =>
  pathname === "/law" || pathname.startsWith("/law/");
