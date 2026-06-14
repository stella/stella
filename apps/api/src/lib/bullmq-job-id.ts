const BULLMQ_JOB_ID_SEPARATOR = "-";

const encodeBullMqJobIdPart = (part: string): string =>
  encodeURIComponent(part).replaceAll(BULLMQ_JOB_ID_SEPARATOR, "%2D");

export const createBullMqJobId = (...parts: readonly string[]): string =>
  parts.map(encodeBullMqJobIdPart).join(BULLMQ_JOB_ID_SEPARATOR);
