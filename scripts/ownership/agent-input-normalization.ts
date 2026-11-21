import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "agent-input-normalization",
  capability:
    "Reading a value a model wrote on the MCP/CLI wire: dates, date formats, numbers, booleans, locales, countries, closed vocabularies",
  owner: ["packages/agent-input/src/"],
  summary:
    "Every agent-facing surface is lenient in the same way or it is lenient " +
    "in several different ways, which is worse than being strict: `4 000`, " +
    "`1. 10. 2026`, `ano` and `cs_CZ` have to mean the same thing in a " +
    "marker, in a tool input and in a fill value. One reader per kind " +
    "auto-normalizes the spellings that carry a single meaning and returns " +
    "the one ask-for-a-fix shape (`received`, `expected`, `hint`) when a " +
    "spelling carries two — `01/02/2026` and a bare `1,234` are asked " +
    "about, never guessed, because guessing them wrong is a wrong date or " +
    "a factor of a thousand on an instrument. The rule below confines " +
    "locale plausibility, whose canonical spelling is also what keeps " +
    "`new Intl.DateTimeFormat` from throwing at fill time; the other kinds " +
    "are held by the census in `agent-input-owner.test.ts`, which lists the " +
    "pre-existing readers of our own bytes that are not agent input.",
  enforcement: {
    kind: "global-member",
    object: "Intl",
    path: ["getCanonicalLocales"],
    allowed: [],
  },
} as const satisfies OwnershipEntry;
