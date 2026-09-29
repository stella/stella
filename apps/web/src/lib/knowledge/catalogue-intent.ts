import * as v from "valibot";

/**
 * What a visitor asked to do with a catalogue template before they had an
 * account, carried through sign-in in the page's `intent` query. A closed
 * set: anything else is dropped, and the item it names is the page's own
 * template, resolved against the catalogue, never a value from the query.
 */
export const TEMPLATE_INTENTS = ["use", "add", "download"] as const;

export type TemplateIntent = (typeof TEMPLATE_INTENTS)[number];

export const templateIntentSearchSchema = v.object({
  intent: v.fallback(v.optional(v.picklist(TEMPLATE_INTENTS)), undefined),
});

/** A catalogue template's page, optionally naming the act to offer again. */
export const catalogueTemplateHref = (
  packId: string,
  templateId: string,
  intent?: TemplateIntent,
): string => {
  const path = `/knowledge/templates/catalogue/${encodeURIComponent(packId)}/${encodeURIComponent(templateId)}`;
  return intent === undefined ? path : `${path}?intent=${intent}`;
};
