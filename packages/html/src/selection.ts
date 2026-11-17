// parser-output-unchanged: HTML parser bindings come from their package owner; DOM and serialization behavior are unchanged.
import type { CheerioOptions as Options } from "cheerio/slim";

// Preserve symbol identities so dependent declarations name the public owner.
export type { Cheerio, CheerioAPI } from "cheerio/slim";
export type CheerioOptions = Omit<Options, "xmlMode"> & { xmlMode?: boolean };
