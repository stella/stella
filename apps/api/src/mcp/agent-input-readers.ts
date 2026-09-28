import type { AgentInputReaders } from "@stll/agent-input";
import { locateGazetteCitations } from "@stll/legal-atlas/provision-citation-grammars";

/**
 * The publisher that serves each ELI jurisdiction the legislation corpus
 * holds, keyed by the ELI's own jurisdiction segment. A stored ELI is this
 * origin plus `/eli/<jurisdiction>/<collection>/<year>/<number>`, so a short
 * or prefix-less spelling a model writes is read back into it.
 */
const ELI_PUBLISHER_ORIGINS = {
  cz: "https://www.e-sbirka.cz",
} as const satisfies Readonly<Record<string, string>>;

/**
 * A gazette citation ("89/2012 Sb.", "zákon č. 89/2012 Sb.") names one work,
 * and the citation grammars already know which ELI it is. A text naming
 * several works, or none, is not one ELI.
 */
const eliOfGazetteCitation = (text: string): string | undefined => {
  const located = locateGazetteCitations(text);
  return located.length === 1 ? located[0]?.eli : undefined;
};

/**
 * The readers the shared agent-input kinds need from this server: which
 * publisher serves an ELI, and how a gazette citation names one. Every
 * dispatch surface passes the same object, so an ELI reads the same on MCP,
 * the CLI and chat.
 */
export const MCP_AGENT_INPUT_READERS: AgentInputReaders = {
  eli: {
    hosts: ELI_PUBLISHER_ORIGINS,
    readCitation: eliOfGazetteCitation,
    hint: "Pass the eli a search_legislation result returned.",
  },
};
