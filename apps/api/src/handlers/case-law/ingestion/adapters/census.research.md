# Registered case-law publisher census research

Research date: 2026-10-16. This is pass A. The source authority for this scope is
the checked crawler registry in `adapter-registry.ts`, derived from
`ADAPTER_KEYS` in `lib/legal-search/ingestion-constants.ts`. Its contract is
“List all registered adapters.” It contains 29 crawler keys. CourtListener is
an import registration, not an `AdapterKey`; do not silently add it to a total
adapter capability map.

The registry adds twelve Austrian sources to the seventeen-source task list.
Each registered key has its own research note below; shared RIS mechanics do
not merge their separate application denominators.

| Registered adapter | Recommended observation | Natural axis |
| --- | --- | --- |
| [at-asylgh](at-asylgh.research.md) | `publisher-count` | decision month |
| [at-bks](at-bks.research.md) | `publisher-count` | decision month |
| [at-bvwg](at-bvwg.research.md) | `publisher-count` | decision month |
| [at-courts](at-courts.research.md) | `publisher-count` | decision month |
| [at-findok](at-findok.research.md) | `listing-enumerated` | decision year × UFS/BFG collection |
| [at-lvwg](at-lvwg.research.md) | `publisher-count` | decision month |
| [at-ubas](at-ubas.research.md) | `publisher-count` | decision month |
| [at-umse](at-umse.research.md) | `publisher-count` | decision month |
| [at-uvs](at-uvs.research.md) | `publisher-count` | decision month |
| [at-verg](at-verg.research.md) | `publisher-count` | decision month |
| [at-vfgh](at-vfgh.research.md) | `publisher-count` | decision month |
| [at-vwgh](at-vwgh.research.md) | `publisher-count` | decision month |
| [cz-ns](cz-ns.research.md) | `publisher-count` | publication day |
| [cz-nss](cz-nss.research.md) | `publisher-count` | decision day |
| [cz-regional](cz-regional.research.md) | `listing-enumerated` | publication day |
| [cz-us](cz-us.research.md) | `publisher-count` | decision year |
| [eu-ecj](eu-ecj.research.md) | `listing-enumerated` | year, enumerated through month windows × language |
| [hu-bhgy](hu-bhgy.research.md) | `publisher-count` | decision year × kollégium |
| [pl-courts](pl-courts.research.md) | `publisher-count` | decision day |
| [pl-kio](pl-kio.research.md) | `publisher-count` | issue day |
| [pl-kis](pl-kis.research.md) | `publisher-count` | issue month plus undated |
| [pl-ncourt](pl-ncourt.research.md) | `publisher-count` | judgment day |
| [pl-nsa](pl-nsa.research.md) | `none-exposed` | pinned dataset shard (with decision year on records) |
| [pl-sn](pl-sn.research.md) | `listing-enumerated` | decision day |
| [pl-tk](pl-tk.research.md) | `listing-enumerated` | decision year × proceeding stage |
| [pl-uodo](pl-uodo.research.md) | `listing-enumerated` | announcement year plus undated |
| [pl-uokik](pl-uokik.research.md) | `publisher-count` | decision year plus undated |
| [sk-courts](sk-courts.research.md) | `publisher-count` | decision day |
| [sk-us](sk-us.research.md) | `publisher-count` | decision month |

## Evidence and typed absence

The per-source notes record an official-index-first request, retrieval date,
HTTP result, archive hash when captured, and the existing reader that exposes
the count or enumeration. Index retrieval does not prove a dynamic search was
executed. A reader/fixture finding is distinguished from a live response.
Failed, forbidden, oversized, and timed-out requests remain `unverified`.
There is no unsupported `none-found` claim in pass A.

The versioned term set is structural: the publisher's own case-law index,
count field, date filter, and continuation. No full-text search terms are
needed to inspect the universe being enumerated. Checks use the local-language
index rather than English search-engine discovery. No general search result
was accepted as evidence of absence. No production corpus was queried or
modified.

Archived source responses and their SHA-256 values are retained in the private
research ledger. Public notes contain count surfaces and scope constraints,
not operational corpus numbers or response bodies with personal information.

## Independent pass resolution

Pass B independently enumerated the same 29 registered crawler keys and
inspected the publisher count/listing interfaces without reading pass A.
Integration recommendations agree for **29/29 sources (100%)** after scope
resolution. This is agreement on the interface and integration choice, not
29/29 successful live count requests.

The resolution queue contained these scope questions:

| Question | Resolution and evidence |
| --- | --- |
| UODO HTML count versus JSON enumeration | Both passes found a scalar result total in the official HTML search pager. The adapter reads a mixed-scope JSON listing; equivalence of filters is unverified. Use its completed enumeration. |
| RIS ordinary courts total | Both identified `Hits.#text`; Justiz foreign-court rows are excluded by the adapter. Preserve that exclusion in its benchmark. |
| NSA mirror footer count | Both identified a pinned secondary mirror, not live CBOSA holdings. Its footer verifies the snapshot only; official completeness stays unmeasured. |
| Page totals versus row totals | TK and regional daily paging do not establish exact row counts by multiplication. Enumerate the listing; retain regional monthly `pocet` separately when already read. |
| UOKIK count verification | Pass A retrieved and inspected official Domino JSON with `@toplevelentries`; pass B identified the same reader from code. No conflicting field or scope was found. |
| KIO undated tail | Implementation scope audit found the day reconciliation omits the separately crawled undated tail. Keep `partial-publisher` scope and an unmeasured launch verdict until that tail is also censused. |

Pass B independently encountered blocked or inaccessible SN, NSA, ncourt,
RIS/API, IPO, UZP, and Cellar requests; JavaScript index pages did not prove
Findok or Eureka census queries. Those remain unverified live observations,
not typed absence. The per-source pass-A statuses and hashes above are not
upgraded by integration agreement.

## Count semantics and known-answer checks

- A publisher-stated count and an enumerated list length are different typed
  outcomes. Structural page counts are not scalar record counts.
- Completion requires the full expected slice universe. One observed empty or
  complete slice cannot establish country completeness.
- Identity deduplication and source scope must match on both sides. BHGY
  colleges overlap; RIS headnotes differ from decision texts; ECJ language
  manifestations differ from works.
- JuDDGES shard completeness is bounded to its pinned mirror snapshot; it does
  not certify the live official NSA publisher.
- Known-answer probes in the existing adapter fixtures cover the named count
  fields, empty listings, capped windows, page contradictions, and refused
  records. Research did not run a live corpus sweep as a known-answer test.

## Publisher access constraints

[RIS official OGD guidance](https://www.ris.bka.gv.at/UI/Ogd.aspx),
“Technische Rahmenbedingungen”, says “keine parallelen Verbindungen”. It also
requires pacing and restricts bulk access hours. Census persistence must reuse
ordinary gated listing responses; it does not authorize a second research
crawler or independent count-request pool. The existing per-source rate gate
remains authoritative for execution.
