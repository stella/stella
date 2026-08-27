---
"@stll/anonymize": patch
---

Close seven detection gaps that let a value survive redaction.

- Treat a dash as a compound edge only when a word character sits on its far
  side. A closed-up attribution ("—John Smith") was read as a hyphen compound,
  which discarded the given name for lacking a name-bearing partner and left the
  surname as an unsupported single token.
- Accept unit designators without the abbreviating dot. The vocabulary carries
  only "apt.", "ste." and friends, and the lookup was exact, so "Apt 5" did not
  register as a unit component and the address span ended at the preceding city.
- Keep legal-form organizations on all-caps lines. The boilerplate veto reads
  line shape, so a party named in an all-caps clause was dropped once 20 letters
  sat outside it; a legal-form suffix now outweighs that, as it already does for
  the length cap.
- Strip a leading field label before the person name. A configured label at
  offset 0 ("Name: Jane Roe") left no prefix to check, so the whole trigger
  match was discarded.
- Scope US state abbreviations to the resolved country set. An empty or
  region-only deny-list scope loaded the matching cities while yielding no state
  list, which removed the STATE ZIP address-tail evidence.
- Keep both halves of an address that a barrier entity splits. A case number,
  date, or person between the street and the city divides the seed cluster,
  which is what keeps that entity out of the address span; each half was then
  judged alone, and a street with no city beside it fell below the two-kind
  evidence floor and was dropped.
- Redact URL-shaped tokens that fail to parse. `new URL()` throws on shapes such
  as `https://internal.corp:port/path`; the replacer returned those verbatim and
  reported no redaction.
