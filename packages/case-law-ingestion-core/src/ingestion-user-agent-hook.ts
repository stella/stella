// parser-output-unchanged: host-registered User-Agent header value only; parsed output is unchanged.
const DEFAULT_INGESTION_USER_AGENT =
  "stella-ingestion/dev (+https://github.com/stella/stella)";

let activeIngestionUserAgent = DEFAULT_INGESTION_USER_AGENT;

export const registerIngestionUserAgent = (userAgent: string): void => {
  activeIngestionUserAgent = userAgent;
};

export const getIngestionUserAgent = (): string => activeIngestionUserAgent;
