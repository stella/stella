---
"@stll/cli": patch
---

Three read capabilities query a matter's graph of verified claims, list facts and the documents the facts come from. `lists.graph.nodes.list` finds facts, claims and documents by their words. `lists.graph.neighbours.list` reads one node's links, with a summary by kind, stance and decision and a page of edges. `lists.graph.paths.list` follows links from a node for up to three hops. Every edge comes with the exact text it rests on, who produced it and its decision, and each tool filters by edge kind, stance or decision.
