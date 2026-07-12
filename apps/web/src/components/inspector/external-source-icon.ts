import { sanitizeHref } from "@/lib/sanitize-href";

export const findMcpConnectorIconHref = ({
  connectorSlug,
  connectors,
}: {
  connectorSlug: string;
  connectors: {
    iconUrl: string | null;
    slug: string;
    url: string;
  }[];
}): string | undefined => {
  const connector = connectors.find(
    (item) => sanitizeMcpToolNamePart(item.slug) === connectorSlug,
  );
  if (!connector) {
    return undefined;
  }

  const iconHref = connector.iconUrl ?? fallbackIconUrl(connector.url);
  return iconHref === undefined ? undefined : sanitizeHref(iconHref);
};

const sanitizeMcpToolNamePart = (value: string): string =>
  value.replaceAll(/[^a-zA-Z0-9_-]/gu, "_");

const fallbackIconUrl = (rawUrl: string): string | undefined => {
  try {
    return new URL("/favicon.ico", rawUrl).toString();
  } catch {
    return undefined;
  }
};
