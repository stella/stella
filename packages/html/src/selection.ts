import type {
  Cheerio as Selection,
  CheerioAPI as Document,
  CheerioOptions as Options,
} from "cheerio/slim";

export type Cheerio<T> = Selection<T>;
export type CheerioAPI = Document;
export type CheerioOptions = Omit<Options, "xmlMode"> & { xmlMode?: boolean };
