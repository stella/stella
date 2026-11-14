/**
 * A provider queue and the region its URL names. Requests to the queue are
 * signed for that region, which need not be the object store's.
 */
export type SqsQueue = { url: string; region: string };

// The form AWS returns for a queue: https://sqs.<region>.amazonaws.com/<account>/<name>.
const SQS_QUEUE_URL =
  /^https:\/\/sqs\.([a-z]{2}(?:-[a-z]+)+-\d)\.amazonaws\.com(?:\.cn)?\/\d{12}\/[A-Za-z0-9_-]{1,80}(?:\.fifo)?$/u;

export const parseSqsQueueUrl = (url: string): SqsQueue | null => {
  const region = SQS_QUEUE_URL.exec(url)?.[1];
  return region === undefined ? null : { url, region };
};
