import * as v from "valibot";

/**
 * What a visitor asked to do with a catalogue template before they had an
 * account, carried through sign-in in the page's `intent` query. A closed
 * set: anything else is dropped, and the item it names is the page's own
 * template, resolved against the catalogue, never a value from the query.
 */
const TEMPLATE_INTENTS = ["use", "add", "download"] as const;

export type TemplateIntent = (typeof TEMPLATE_INTENTS)[number];

export const templateIntentSearchSchema = v.object({
  intent: v.fallback(v.optional(v.picklist(TEMPLATE_INTENTS)), undefined),
});

/** A ready-made playbook's id: lowercase kebab-case, as the catalogue names it. */
const STARTER_ID_PATTERN = /^[a-z][a-z0-9-]*$/u;

/**
 * Starting from a ready-made playbook, carried through sign-in in the
 * playbooks page's query: the act and the starter it names. The id is only a
 * name to look up in the member's own list of ready-made playbooks; one that
 * is not there drops the act.
 */
export const playbooksIntentSearchSchema = v.object({
  intent: v.fallback(v.optional(v.picklist(["useStarter"])), undefined),
  starter: v.fallback(
    v.optional(
      v.pipe(v.string(), v.maxLength(64), v.regex(STARTER_ID_PATTERN)),
    ),
    undefined,
  ),
});

/** The playbooks page, offering the ready-made playbook again. */
export const starterIntentHref = (starterId: string): string =>
  `/knowledge/playbooks?intent=useStarter&starter=${encodeURIComponent(starterId)}`;

/** A catalogue template's page, optionally naming the act to offer again. */
export const catalogueTemplateHref = (
  packId: string,
  templateId: string,
  intent?: TemplateIntent,
): string => {
  const path = `/knowledge/templates/catalogue/${encodeURIComponent(packId)}/${encodeURIComponent(templateId)}`;
  return intent === undefined ? path : `${path}?intent=${intent}`;
};
