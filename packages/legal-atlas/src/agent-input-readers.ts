import {
  hungarianDesignationWorkEli,
  readHungarianActCitations,
} from "@stll/api-contract/magyar-kozlony-designation";
import {
  STATUTE_ELI_PUBLISHER_ORIGINS,
  STATUTE_WORK_URN_PREFIXES,
} from "@stll/api-contract/statute-work-identifier";

import { locateGazetteCitations } from "./provision-citation-grammars";

// A code abbreviation passed as an identifier names the code in force now,
// the latest reading the alias table holds.
const LATEST_READING = "9999-12-31";

/**
 * A citation names one work, and the grammars already know which identifier
 * it is: a gazette number ("89/2012 Sb.", "zákon č. 89/2012 Sb.") its ELI, a
 * Hungarian designation ("2013. évi V. törvény") its Magyar Közlöny URN. A
 * text naming several works, or none, is not one identifier.
 */
const workOfCitation = (text: string): string | undefined => {
  const located = locateGazetteCitations(text);
  if (located.length > 0) {
    return located.length === 1 ? located[0]?.eli : undefined;
  }
  const hungarian = readHungarianActCitations(text, LATEST_READING);
  const [act, ...others] = hungarian;
  return act === undefined || others.length > 0
    ? undefined
    : (hungarianDesignationWorkEli(act) ?? undefined);
};

/**
 * The readers the shared agent-input kinds need from this server: which
 * publisher serves an ELI, which URNs name works of publishers without one,
 * and how a citation names a work. Every dispatch surface passes the same
 * object, so an identifier reads the same on MCP, the CLI and chat.
 */
export const MCP_AGENT_INPUT_READERS = {
  eli: {
    hosts: STATUTE_ELI_PUBLISHER_ORIGINS,
    urnPrefixes: STATUTE_WORK_URN_PREFIXES,
    readCitation: workOfCitation,
    hint: "Pass the eli a search_legislation result returned.",
  },
};
