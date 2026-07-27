---
"@stll/anonymize": patch
---

Stop an address span absorbing the sentence that precedes it. A city name that is also an ordinary word (`Send`, `Post`) seeded an address, and the seed cluster bridged the prose between it and a nearby street word, so `Send it to 14 Rue de la Paix.` produced the whole sentence as one address. Two ordinary words between two address seeds now end the cluster, but only while the cluster has not yet reached a street word: once it has, everything up to the destination is street-name material, so lowercase names and non-English connectives (`10 rue de la paix et de la liberté, Paris`) still join. Standalone street spans also bound their left edge the way they already bound the right: the walk only crosses street-name words and only when it reaches the house number that opens the address. House numbers now accept a unit letter (`221B Baker Street`).
