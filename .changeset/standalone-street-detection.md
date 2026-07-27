---
"@stll/anonymize": minor
---

Add opt-in standalone street detection. `PipelineConfig.standaloneStreetDetection` defaults to `"off"`; `"houseNumberAnchored"` accepts a street-type word with a house number directly beside it in either order (`14 Rue de la Paix`, `Hauptstraße 5`, `123 Main Street`) with no known-city anchor. A bare street name with no number never fires, the mode only recognizes the street types of the pipeline's selected languages, and it carries that vocabulary so compound names (`Hauptstraße`) the whole-word street-type automaton cannot see are matched by their tail.

`addressSeedData` gains one optional field, so the prepared-package schema version moves from 7 to 8: a package built by an earlier version is now rejected rather than decoded against an incompatible layout, and persisted `.stlanonpkg` artifacts must be rebuilt. The frozen assemble oracle digests are regenerated for the same reason; no other assembled field changes.
