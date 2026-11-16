import type { MatterSummary } from "@/state/matters";

/** One section of the matters list: a client's matters, or those with none. */
export type MattersGroup = {
  readonly key: string;
  /** The client's name; none for the matters without a client. */
  readonly client: string | null;
  readonly data: readonly MatterSummary[];
};

/**
 * The matters by client, as the web's `groupByClient` groups them: the ones
 * without a client first, then each client's in name order for the locale,
 * each keeping the list's own order within.
 */
export function groupByClient(
  matters: readonly MatterSummary[],
  locale: string,
): readonly MattersGroup[] {
  const byClient = new Map<string, MatterSummary[]>();
  const personal: MatterSummary[] = [];
  for (const matter of matters) {
    const client = matter.client?.displayName;
    if (client === undefined) {
      personal.push(matter);
      continue;
    }
    const group = byClient.get(client);
    if (group === undefined) {
      byClient.set(client, [matter]);
    } else {
      group.push(matter);
    }
  }
  const { compare } = new Intl.Collator(locale);
  // A fresh array, sorted in place: Hermes has no `toSorted`.
  const clients: MattersGroup[] = [...byClient]
    .map(([client, data]) => ({ client, data, key: `client:${client}` }))
    .sort((a, b) => compare(a.client, b.client));
  return personal.length === 0
    ? clients
    : [{ client: null, data: personal, key: "personal" }, ...clients];
}
