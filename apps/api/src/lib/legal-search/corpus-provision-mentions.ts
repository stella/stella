import type {
  JurisdictionProfile,
  WorkIdentifier,
} from "@stll/legal-atlas/provision-citation-profile";
import { foldToAscii } from "@stll/text-normalize";

import type { CorpusQueryToken } from "@/api/lib/legal-search/corpus-query";
import { corpusTokens } from "@/api/lib/legal-search/corpus-tokens";

export type CorpusProvisionMention = {
  sectionIndex: number;
  /** Token indices, with an exclusive end. */
  actTokenRange: { start: number; end: number };
  /** Subdivision and lead-in tokens through the act, excluding the section. */
  consumedRange: { start: number; end: number };
  works: WorkIdentifier[];
};

const titleKey = (value: string) => foldToAscii(value).toLowerCase();

type ActSpelling = {
  words: string[];
  caseSensitive: boolean;
  work: WorkIdentifier;
};

const compileProfile = (profile: JurisdictionProfile) => ({
  acts: [
    ...profile.titles.flatMap((entry) =>
      entry.unit === "article"
        ? []
        : entry.spellings.map((spelling) => ({
            words: corpusTokens(spelling).map(titleKey),
            caseSensitive: false,
            work: entry.identifier,
          })),
    ),
    ...profile.aliases.flatMap((entry) =>
      entry.unit === "article"
        ? []
        : entry.spellings.map((spelling) => ({
            words: corpusTokens(spelling),
            caseSensitive: true,
            work: entry.identifier,
          })),
    ),
  ].toSorted((left, right) => right.words.length - left.words.length),
  subdivisions: profile.subdivisionTerms
    .map(({ text }) => corpusTokens(text).map(titleKey))
    .toSorted((left, right) => right.length - left.length),
  leadIns: profile.actLeadIns
    .map((text) => corpusTokens(text).map(titleKey))
    .toSorted((left, right) => right.length - left.length),
  collections: profile.collections
    .flatMap(({ canonical, spellings }) =>
      spellings.map((spelling) => ({
        words: corpusTokens(spelling).map(titleKey),
        canonical,
      })),
    )
    .toSorted((left, right) => right.words.length - left.words.length),
});

// Profile objects are stable; tokenising their vocabulary once keeps each query
// scan bounded by its tokens rather than repeating vocabulary normalisation.
const compiledProfiles = new WeakMap<
  JurisdictionProfile,
  ReturnType<typeof compileProfile>
>();

type MatchesWordsOptions = {
  tokens: readonly CorpusQueryToken[];
  start: number;
  words: readonly string[];
  caseSensitive?: boolean;
};

const matchesWords = ({
  tokens,
  start,
  words,
  caseSensitive = false,
}: MatchesWordsOptions): boolean =>
  words.length > 0 &&
  words.every((word, offset) => {
    const token = tokens.at(start + offset);
    return (
      token?.type === "term" &&
      (caseSensitive ? token.value : titleKey(token.value)) === word
    );
  });

type ReadNamedActOptions = {
  tokens: readonly CorpusQueryToken[];
  start: number;
  acts: readonly ActSpelling[];
};

const readNamedAct = ({ tokens, start, acts }: ReadNamedActOptions) => {
  let length = 0;
  const works: WorkIdentifier[] = [];
  for (const { words, caseSensitive, work } of acts) {
    if (length > words.length) {
      break;
    }
    if (!matchesWords({ tokens, start, words, caseSensitive })) {
      continue;
    }
    length = words.length;
    if (
      !works.some(
        (existing) =>
          existing.number === work.number &&
          existing.year === work.year &&
          existing.collection === work.collection,
      )
    ) {
      works.push(work);
    }
  }
  return length === 0 ? undefined : { end: start + length, works };
};

type ReadGazetteActOptions = {
  tokens: readonly CorpusQueryToken[];
  start: number;
  profile: JurisdictionProfile;
  collections: ReturnType<typeof compileProfile>["collections"];
};

const readGazetteAct = ({
  tokens,
  start,
  profile,
  collections,
}: ReadGazetteActOptions) => {
  const introducer = tokens.at(start);
  const numberIndex =
    introducer?.type === "term" && titleKey(introducer.value) === "c"
      ? start + 1
      : start;
  const number = tokens.at(numberIndex);
  const year = tokens.at(numberIndex + 1);
  if (
    number?.type !== "term" ||
    !/^\d+$/u.test(number.value) ||
    !Number.isSafeInteger(Number(number.value)) ||
    Number(number.value) < 1 ||
    year?.type !== "term" ||
    !/^\d{4}$/u.test(year.value) ||
    Number(year.value) < profile.earliestYear
  ) {
    return undefined;
  }
  const collectionStart = numberIndex + 2;
  const collection = collections.find(({ words }) =>
    matchesWords({ tokens, start: collectionStart, words }),
  );
  if (!collection) {
    return undefined;
  }
  return {
    end: collectionStart + collection.words.length,
    works: [
      {
        number: Number(number.value),
        year: Number(year.value),
        collection: collection.canonical,
      },
    ],
  };
};

/** Reads original query tokens; a quoted phrase retains its own boundary. */
export const readCorpusProvisionMentions = (
  tokens: readonly CorpusQueryToken[],
  profile: JurisdictionProfile,
): CorpusProvisionMention[] => {
  let compiled = compiledProfiles.get(profile);
  if (!compiled) {
    compiled = compileProfile(profile);
    compiledProfiles.set(profile, compiled);
  }
  const mentions: CorpusProvisionMention[] = [];
  for (let sectionIndex = 0; sectionIndex < tokens.length; sectionIndex += 1) {
    const section = tokens.at(sectionIndex);
    if (section?.type !== "term" || !/^\d+[a-z]?$/iu.test(section.value)) {
      continue;
    }
    const consumedStart = sectionIndex + 1;
    let actStart = consumedStart;
    for (;;) {
      const start = actStart;
      const subdivision = compiled.subdivisions.find((words) =>
        matchesWords({ tokens, start, words }),
      );
      if (!subdivision) {
        break;
      }
      const value = tokens.at(actStart + subdivision.length);
      if (
        value?.type !== "term" ||
        !/^(?:\d+[a-z]?|[a-z])$/iu.test(value.value)
      ) {
        break;
      }
      actStart += subdivision.length + 1;
    }
    for (;;) {
      const act =
        readNamedAct({ tokens, start: actStart, acts: compiled.acts }) ??
        readGazetteAct({
          tokens,
          start: actStart,
          profile,
          collections: compiled.collections,
        });
      if (act) {
        mentions.push({
          sectionIndex,
          actTokenRange: { start: actStart, end: act.end },
          consumedRange: { start: consumedStart, end: act.end },
          works: act.works,
        });
        sectionIndex = act.end - 1;
        break;
      }
      const start = actStart;
      const leadIn = compiled.leadIns.find((words) =>
        matchesWords({ tokens, start, words }),
      );
      if (!leadIn) {
        break;
      }
      actStart += leadIn.length;
    }
  }
  return mentions;
};
