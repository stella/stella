/**
 * The one token estimate for text sent to a model.
 *
 * Bytes over three over-counts English by about a quarter, and stays close for
 * Chinese, Japanese, Arabic and similar scripts, where four characters per
 * token is badly wrong. A request must fit on the worst case, so the estimate
 * follows the densest script.
 */
export const BYTES_PER_TOKEN_ESTIMATE = 3;

export const estimateTextTokens = (text: string): number =>
  Math.ceil(Buffer.byteLength(text) / BYTES_PER_TOKEN_ESTIMATE);
