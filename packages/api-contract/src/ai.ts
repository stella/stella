/** Maximum email text accepted by the Outlook AI endpoints. */
export const OUTLOOK_AI_INPUT_MAX_CHARS = 20_000;

/** Keep client requests within the endpoint's email-text boundary. */
export const truncateOutlookAIInput = (value: string): string =>
  value.slice(0, OUTLOOK_AI_INPUT_MAX_CHARS);
