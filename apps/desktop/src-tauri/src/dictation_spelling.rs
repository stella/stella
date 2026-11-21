//! Spells the speaker's custom words the way the speaker does after the
//! speech model on this computer transcribed without them. Only when cleanup
//! is off: cleanup gets the words itself.
//!
//! A word or phrase in the text is replaced only when it is close to one
//! custom word and to no other: the same letters with other case,
//! diacritics, apostrophes or hyphens, or, in a longer word, one or two
//! letters off. A Czech or Slovak case ending, or an English possessive, on
//! a name keeps the ending, so "dvoraka" of "Dvořák" reads "Dvořáka".
//! Whole words only, never part of one, and short words only when they
//! differ in case or diacritics alone; a word with digits only as written.
//! The twin of `@stll/transcript/spelling`: both pass the cases in
//! `packages/transcript/src/spelling.fixtures.json`. Pure: tested without a
//! model.

#![cfg_attr(
  not(dictation),
  allow(dead_code, reason = "only builds with the speech engine transcribe")
)]

use std::cmp::Reverse;

/// Custom words shorter than this, in letters, are left alone: too many
/// ordinary words are that close to them.
const MIN_LETTERS: usize = 4;
/// From this many letters on, one letter may differ.
const ONE_OFF_LETTERS: usize = 6;
/// From this many letters on, two letters may differ.
const TWO_OFF_LETTERS: usize = 10;

/// Czech and Slovak case endings a name takes: after a word ending in a
/// consonant (Novák, Nováka, Novákovi), in place of a final -a, -o or -e
/// (Hrdlička, Hrdličky), and in place of a final -ý or -í (Novotný,
/// Novotného). Any word takes the "s" of an English possessive. Written
/// with their accents where only one spelling exists, so an ending spoken
/// without them gets them back; an ending that could be either is kept as
/// spoken.
const CONSONANT_ENDINGS: &[&str] = &[
  "a", "u", "e", "ovi", "em", "om", "ové", "i", "y", "ům", "ech", "och", "ov", "ami",
];
const VOWEL_ENDINGS: &[&str] = &[
  "a", "y", "e", "u", "ou", "o", "ám", "ách", "ami", "em", "ech", "ům", "i",
];
const ADJECTIVE_ENDINGS: &[&str] = &[
  "ého", "ému", "ým", "ých", "ými", "ího", "ímu", "ím", "á", "é", "ou",
];
const POSSESSIVE_ENDINGS: &[&str] = &["s"];

/// A piece of a custom word: a word, also folded, or what lies between two.
enum Wanted {
  Word { text: String, folded: String },
  Between(String),
}

/// A custom word or phrase as compared, from its first word on.
struct Target {
  pieces: Vec<Wanted>,
  words: usize,
  letters: usize,
}

/// How one word of the text reads as one word of a custom word.
struct WordMatch {
  distance: usize,
  /// The word as it should be written, its ending kept.
  spelled: String,
  inflected: bool,
}

/// How the pieces at one place read as a custom word.
struct Aligned {
  spelled: String,
  taken: usize,
  distance: usize,
  inflected: usize,
}

/// A piece of the text: a word, or what lies between two words.
#[derive(Debug, PartialEq, Eq)]
enum Piece<'a> {
  Word(&'a str),
  Between(&'a str),
}

/// `text` with every close miss of a custom word spelled as in `words`.
pub fn respell(text: &str, words: &[String]) -> String {
  // One target per spelling: the same name twice is no tie.
  let mut spellings: Vec<String> = Vec::new();
  for word in words {
    let spelling = compose(word.trim());
    if !spellings.contains(&spelling) {
      spellings.push(spelling);
    }
  }
  let targets = spellings
    .iter()
    .filter_map(|spelling| target(spelling))
    .collect::<Vec<_>>();
  if targets.is_empty() {
    return text.to_string();
  }
  let pieces = pieces(text);
  let mut out = String::with_capacity(text.len());
  let mut index = 0;
  while index < pieces.len() {
    let found = match pieces[index] {
      Piece::Word(_) => best_match(&pieces, index, &targets),
      Piece::Between(_) => None,
    };
    match found {
      Some((spelled, taken)) => {
        out.push_str(&spelled);
        index += taken;
      }
      None => {
        out.push_str(&joined(&pieces[index..=index]));
        index += 1;
      }
    }
  }
  out
}

/// A learned fix that is on: the words as dictated, and as the speaker
/// writes them.
pub struct LearnedSpelling<'a> {
  pub from: &'a str,
  pub to: &'a str,
}

/// `text` with every whole-word, case-insensitive match of a learned fix's
/// words written as the speaker writes them: the longest phrase first, a
/// match only where a word starts, words apart only by spaces, and a capital
/// kept where the match had one. The twin of `applyLearnedFixes` in
/// `@stll/transcript/corrections`; both pass the cases in
/// `fixtures/dictation-learned-fixes.json`.
pub fn apply_learned(text: &str, fixes: &[LearnedSpelling<'_>]) -> String {
  let mut active = fixes
    .iter()
    .filter_map(|fix| {
      let keys = pieces(fix.from)
        .into_iter()
        .filter_map(|piece| match piece {
          Piece::Word(word) => Some(learned_key(word)),
          Piece::Between(_) => None,
        })
        .collect::<Vec<_>>();
      (!keys.is_empty()).then_some((keys, fix.to))
    })
    .collect::<Vec<_>>();
  if active.is_empty() {
    return text.to_string();
  }
  // Stable, so of two phrases as long the first listed wins.
  active.sort_by_key(|(keys, _)| Reverse(keys.len()));
  let pieces = pieces(text);
  let mut out = String::with_capacity(text.len());
  let mut index = 0;
  while index < pieces.len() {
    let rest = &pieces[index..];
    let found = match rest[0] {
      Piece::Word(_) => active.iter().find_map(|(keys, to)| {
        let (words, taken) = leading_words(rest, keys.len())?;
        words
          .iter()
          .zip(keys)
          .all(|(word, key)| learned_key(word) == *key)
          .then_some((*to, taken))
      }),
      Piece::Between(_) => None,
    };
    match found {
      Some((to, taken)) => {
        out.push_str(&cased_like(to, &joined(&rest[..taken])));
        index += taken;
      }
      None => {
        out.push_str(joined(&rest[..1]).as_str());
        index += 1;
      }
    }
  }
  out
}

/// The words of `text`, split as the spelling passes split them.
pub fn words_of(text: &str) -> Vec<String> {
  pieces(text)
    .into_iter()
    .filter_map(|piece| match piece {
      Piece::Word(word) => Some(word.to_string()),
      Piece::Between(_) => None,
    })
    .collect()
}

/// How a learned fix's words compare: in lower case, curly apostrophes made
/// straight.
fn learned_key(word: &str) -> String {
  word.to_lowercase().replace('’', "'")
}

/// A custom word as compared, from its first word on; what follows its last
/// word stays, as the full stop of "s.r.o.". Composed by the caller, so its
/// last letter is one character.
fn target(spelling: &str) -> Option<Target> {
  let split = pieces(spelling);
  let start = split
    .iter()
    .position(|piece| matches!(piece, Piece::Word(_)))
    .unwrap_or(0);
  let wanted = split[start..]
    .iter()
    .map(|piece| match piece {
      Piece::Word(text) => Wanted::Word {
        text: (*text).to_string(),
        folded: fold(text),
      },
      Piece::Between(text) => Wanted::Between((*text).to_string()),
    })
    .collect::<Vec<_>>();
  let letters = wanted
    .iter()
    .map(|piece| match piece {
      Wanted::Word { folded, .. } => folded.chars().count(),
      Wanted::Between(_) => 0,
    })
    .sum();
  let words = wanted
    .iter()
    .filter(|piece| matches!(piece, Wanted::Word { .. }))
    .count();
  (letters >= MIN_LETTERS).then_some(Target {
    pieces: wanted,
    words,
    letters,
  })
}

/// Splits `text` into words and what lies between them. A word is a run of
/// letters and digits, with an apostrophe or a hyphen inside it and the
/// combining accents that follow its letters.
fn pieces(text: &str) -> Vec<Piece<'_>> {
  let mut pieces = Vec::new();
  let mut start = 0;
  let mut in_word = false;
  let chars = text.char_indices().collect::<Vec<_>>();
  for (position, &(offset, character)) in chars.iter().enumerate() {
    let joins = joiner(character)
      && in_word
      && chars
        .get(position + 1)
        .is_some_and(|(_, next)| next.is_alphanumeric());
    let wordlike =
      character.is_alphanumeric() || joins || (in_word && combining(character));
    if wordlike != in_word && offset > start {
      pieces.push(piece(&text[start..offset], in_word));
      start = offset;
    }
    in_word = wordlike;
  }
  if start < text.len() {
    pieces.push(piece(&text[start..], in_word));
  }
  pieces
}

const fn piece(text: &str, word: bool) -> Piece<'_> {
  if word {
    Piece::Word(text)
  } else {
    Piece::Between(text)
  }
}

fn joined(pieces: &[Piece<'_>]) -> String {
  pieces
    .iter()
    .map(|piece| match piece {
      Piece::Word(text) | Piece::Between(text) => *text,
    })
    .collect()
}

/// How close a custom word is: fewer edits first, then fewer endings, then
/// more words.
type Rank = (usize, usize, Reverse<usize>);

/// The custom word the words from `start` on are a close miss of, spelled,
/// and how many pieces it covers; the closest wins, then the one without
/// endings, then the longest phrase. A match already spelled right is still
/// returned, so its words are not matched again one by one. `None` when none
/// is close or when two are equally close.
fn best_match(
  pieces: &[Piece<'_>],
  start: usize,
  targets: &[Target],
) -> Option<(String, usize)> {
  let mut best: Option<(String, usize, Rank)> = None;
  let mut tied = false;
  for target in targets {
    let Some(aligned) = align(pieces, start, target) else {
      continue;
    };
    if aligned.distance > allowed(target.letters) {
      continue;
    }
    let rank = (aligned.distance, aligned.inflected, Reverse(target.words));
    match &best {
      Some((_, _, known)) if *known < rank => {}
      Some((_, _, known)) if *known == rank => tied = true,
      _ => {
        let original = joined(&pieces[start..start + aligned.taken]);
        best = Some((cased_like(&aligned.spelled, &original), aligned.taken, rank));
        tied = false;
      }
    }
  }
  let (spelled, taken, _) = best.filter(|_| !tied)?;
  Some((spelled, taken))
}

/// How the pieces from `start` on read as the custom word: each word close
/// to its word, spaces where it has spaces and the same punctuation where it
/// has punctuation; a full stop it ends with may be followed by more. `None`
/// when the pieces do not line up.
fn align(pieces: &[Piece<'_>], start: usize, target: &Target) -> Option<Aligned> {
  let mut aligned = Aligned {
    spelled: String::new(),
    taken: target.pieces.len(),
    distance: 0,
    inflected: 0,
  };
  for (index, want) in target.pieces.iter().enumerate() {
    let piece = pieces.get(start + index)?;
    match (want, piece) {
      (Wanted::Word { text, folded }, Piece::Word(word)) => {
        let matched = match_word(word, text, folded)?;
        aligned.spelled.push_str(&matched.spelled);
        aligned.distance += matched.distance;
        aligned.inflected += usize::from(matched.inflected);
      }
      (Wanted::Between(want), Piece::Between(between)) => {
        if want.chars().all(char::is_whitespace) {
          if !between.chars().all(|character| character == ' ') {
            return None;
          }
          aligned.spelled.push_str(want);
        } else if index == target.pieces.len() - 1 && between.starts_with(want.as_str())
        {
          aligned.spelled.push_str(between);
        } else if between == want {
          aligned.spelled.push_str(want);
        } else {
          return None;
        }
      }
      _ => return None,
    }
  }
  Some(aligned)
}

/// How `word` reads as one word of a custom word: as it stands, or as its
/// stem with a case ending. `None` when the two differ in a word with digits,
/// such as a section or standard number, which must match exactly.
fn match_word(word: &str, spelling: &str, custom: &str) -> Option<WordMatch> {
  // A number matches only as written: folding would drop the hyphen of
  // "27-001".
  if word.chars().chain(spelling.chars()).any(char::is_numeric) {
    return (word.to_lowercase() == spelling.to_lowercase()).then(|| WordMatch {
      distance: 0,
      spelled: spelling.to_string(),
      inflected: false,
    });
  }
  let folded = fold(word);
  let mut best = WordMatch {
    distance: distance(&folded, custom),
    spelled: spelling.to_string(),
    inflected: false,
  };
  if best.distance == 0 {
    return Some(best);
  }
  let folded_letters = folded.chars().collect::<Vec<_>>();
  for (stem, written, endings) in stems(spelling, custom) {
    for ending in endings {
      let key = fold(ending).chars().collect::<Vec<_>>();
      if folded_letters.len() <= key.len() || !folded_letters.ends_with(&key) {
        continue;
      }
      let rest = folded_letters[..folded_letters.len() - key.len()]
        .iter()
        .collect::<String>();
      let apart = distance(&rest, &stem);
      if apart < best.distance {
        best = WordMatch {
          distance: apart,
          spelled: format!("{written}{}", spoken_ending(word, ending)),
          inflected: true,
        };
      }
    }
  }
  Some(best)
}

/// The stems a custom word takes endings on: the whole word after a
/// consonant or before a possessive, the word without its final vowel, and
/// the word without the "e" of a final -ek or -ec (Dvořáček, Dvořáčka).
/// Only stems of at least `MIN_LETTERS` letters, so a short word does not
/// become an ending away from ordinary words.
fn stems(
  spelling: &str,
  custom: &str,
) -> Vec<(String, String, &'static [&'static str])> {
  let letters = spelling.chars().collect::<Vec<_>>();
  let custom_letters = custom.chars().collect::<Vec<_>>();
  let without = |list: &[char], count: usize| -> String {
    list[..list.len().saturating_sub(count)].iter().collect()
  };
  let mut found = vec![(custom.to_string(), spelling.to_string(), POSSESSIVE_ENDINGS)];
  match custom_letters.last() {
    Some('a' | 'e' | 'o') => found.push((
      without(&custom_letters, 1),
      without(&letters, 1),
      VOWEL_ENDINGS,
    )),
    Some('y' | 'i') => found.push((
      without(&custom_letters, 1),
      without(&letters, 1),
      ADJECTIVE_ENDINGS,
    )),
    Some(&last) if last.is_alphabetic() => {
      found.push((custom.to_string(), spelling.to_string(), CONSONANT_ENDINGS));
      let before_last = letters
        .len()
        .checked_sub(2)
        .and_then(|at| letters.get(at))
        .map(|letter| fold(&letter.to_string()));
      if (custom.ends_with("ek") || custom.ends_with("ec"))
        && before_last.as_deref() == Some("e")
      {
        let mut stem = without(&custom_letters, 2);
        stem.push(last);
        let mut written = without(&letters, 2);
        written.extend(letters.last());
        found.push((stem, written, CONSONANT_ENDINGS));
      }
    }
    _ => {}
  }
  found
    .into_iter()
    .filter(|(stem, _, _)| stem.chars().count() >= MIN_LETTERS)
    .collect()
}

/// The ending of `word` as spoken, with the apostrophe before an English
/// "s"; spoken without accents, as written in `ending`, in the case spoken.
fn spoken_ending(word: &str, ending: &str) -> String {
  let spoken = last_letters(word, fold(ending).chars().count());
  // Accents or an apostrophe: the ending was spoken in full.
  if fold(&spoken) != spoken.to_lowercase() {
    return spoken;
  }
  if spoken == spoken.to_uppercase() && spoken != spoken.to_lowercase() {
    ending.to_uppercase()
  } else {
    ending.to_string()
  }
}

/// The last `letters` letters of `word`, with their accents and the
/// apostrophe or hyphen before them.
fn last_letters(word: &str, letters: usize) -> String {
  let characters = word.chars().collect::<Vec<_>>();
  let mut start = characters.len();
  let mut counted = 0;
  while start > 0 && counted < letters {
    start -= 1;
    if !combining(characters[start]) && !joiner(characters[start]) {
      counted += 1;
    }
  }
  while start > 0 && joiner(characters[start - 1]) {
    start -= 1;
  }
  characters[start..].iter().collect()
}

const fn joiner(character: char) -> bool {
  matches!(character, '\'' | '’' | '-')
}

/// `text` with each Latin letter the dictation languages use, written as a
/// letter and its combining accent, as the one composed letter (NFC), so a
/// custom word's last letter is one character. Other text stays as written.
fn compose(text: &str) -> String {
  let mut out = String::with_capacity(text.len());
  let mut characters = text.chars().peekable();
  while let Some(character) = characters.next() {
    let composed = characters.peek().and_then(|&mark| {
      COMPOSED
        .binary_search_by(|(base, accent, _)| (*base, *accent).cmp(&(character, mark)))
        .ok()
        .map(|at| COMPOSED[at].2)
    });
    match composed {
      Some(letter) => {
        out.push(letter);
        characters.next();
      }
      None => out.push(character),
    }
  }
  out
}

/// Letter, combining accent, and the letter they compose, sorted by the
/// first two.
const COMPOSED: &[(char, char, char)] = &[
  ('A', '\u{300}', 'À'),
  ('A', '\u{301}', 'Á'),
  ('A', '\u{302}', 'Â'),
  ('A', '\u{303}', 'Ã'),
  ('A', '\u{304}', 'Ā'),
  ('A', '\u{306}', 'Ă'),
  ('A', '\u{308}', 'Ä'),
  ('A', '\u{30a}', 'Å'),
  ('A', '\u{328}', 'Ą'),
  ('C', '\u{301}', 'Ć'),
  ('C', '\u{30c}', 'Č'),
  ('C', '\u{327}', 'Ç'),
  ('D', '\u{30c}', 'Ď'),
  ('E', '\u{300}', 'È'),
  ('E', '\u{301}', 'É'),
  ('E', '\u{302}', 'Ê'),
  ('E', '\u{304}', 'Ē'),
  ('E', '\u{307}', 'Ė'),
  ('E', '\u{308}', 'Ë'),
  ('E', '\u{30c}', 'Ě'),
  ('E', '\u{328}', 'Ę'),
  ('G', '\u{327}', 'Ģ'),
  ('I', '\u{300}', 'Ì'),
  ('I', '\u{301}', 'Í'),
  ('I', '\u{302}', 'Î'),
  ('I', '\u{304}', 'Ī'),
  ('I', '\u{308}', 'Ï'),
  ('I', '\u{328}', 'Į'),
  ('K', '\u{327}', 'Ķ'),
  ('L', '\u{301}', 'Ĺ'),
  ('L', '\u{30c}', 'Ľ'),
  ('L', '\u{327}', 'Ļ'),
  ('N', '\u{301}', 'Ń'),
  ('N', '\u{303}', 'Ñ'),
  ('N', '\u{30c}', 'Ň'),
  ('N', '\u{327}', 'Ņ'),
  ('O', '\u{300}', 'Ò'),
  ('O', '\u{301}', 'Ó'),
  ('O', '\u{302}', 'Ô'),
  ('O', '\u{303}', 'Õ'),
  ('O', '\u{304}', 'Ō'),
  ('O', '\u{308}', 'Ö'),
  ('O', '\u{30b}', 'Ő'),
  ('R', '\u{301}', 'Ŕ'),
  ('R', '\u{30c}', 'Ř'),
  ('S', '\u{301}', 'Ś'),
  ('S', '\u{30c}', 'Š'),
  ('S', '\u{326}', 'Ș'),
  ('S', '\u{327}', 'Ş'),
  ('T', '\u{30c}', 'Ť'),
  ('T', '\u{326}', 'Ț'),
  ('T', '\u{327}', 'Ţ'),
  ('U', '\u{300}', 'Ù'),
  ('U', '\u{301}', 'Ú'),
  ('U', '\u{302}', 'Û'),
  ('U', '\u{304}', 'Ū'),
  ('U', '\u{308}', 'Ü'),
  ('U', '\u{30a}', 'Ů'),
  ('U', '\u{30b}', 'Ű'),
  ('U', '\u{328}', 'Ų'),
  ('Y', '\u{301}', 'Ý'),
  ('Y', '\u{308}', 'Ÿ'),
  ('Z', '\u{301}', 'Ź'),
  ('Z', '\u{307}', 'Ż'),
  ('Z', '\u{30c}', 'Ž'),
  ('a', '\u{300}', 'à'),
  ('a', '\u{301}', 'á'),
  ('a', '\u{302}', 'â'),
  ('a', '\u{303}', 'ã'),
  ('a', '\u{304}', 'ā'),
  ('a', '\u{306}', 'ă'),
  ('a', '\u{308}', 'ä'),
  ('a', '\u{30a}', 'å'),
  ('a', '\u{328}', 'ą'),
  ('c', '\u{301}', 'ć'),
  ('c', '\u{30c}', 'č'),
  ('c', '\u{327}', 'ç'),
  ('d', '\u{30c}', 'ď'),
  ('e', '\u{300}', 'è'),
  ('e', '\u{301}', 'é'),
  ('e', '\u{302}', 'ê'),
  ('e', '\u{304}', 'ē'),
  ('e', '\u{307}', 'ė'),
  ('e', '\u{308}', 'ë'),
  ('e', '\u{30c}', 'ě'),
  ('e', '\u{328}', 'ę'),
  ('g', '\u{327}', 'ģ'),
  ('i', '\u{300}', 'ì'),
  ('i', '\u{301}', 'í'),
  ('i', '\u{302}', 'î'),
  ('i', '\u{304}', 'ī'),
  ('i', '\u{308}', 'ï'),
  ('i', '\u{328}', 'į'),
  ('k', '\u{327}', 'ķ'),
  ('l', '\u{301}', 'ĺ'),
  ('l', '\u{30c}', 'ľ'),
  ('l', '\u{327}', 'ļ'),
  ('n', '\u{301}', 'ń'),
  ('n', '\u{303}', 'ñ'),
  ('n', '\u{30c}', 'ň'),
  ('n', '\u{327}', 'ņ'),
  ('o', '\u{300}', 'ò'),
  ('o', '\u{301}', 'ó'),
  ('o', '\u{302}', 'ô'),
  ('o', '\u{303}', 'õ'),
  ('o', '\u{304}', 'ō'),
  ('o', '\u{308}', 'ö'),
  ('o', '\u{30b}', 'ő'),
  ('r', '\u{301}', 'ŕ'),
  ('r', '\u{30c}', 'ř'),
  ('s', '\u{301}', 'ś'),
  ('s', '\u{30c}', 'š'),
  ('s', '\u{326}', 'ș'),
  ('s', '\u{327}', 'ş'),
  ('t', '\u{30c}', 'ť'),
  ('t', '\u{326}', 'ț'),
  ('t', '\u{327}', 'ţ'),
  ('u', '\u{300}', 'ù'),
  ('u', '\u{301}', 'ú'),
  ('u', '\u{302}', 'û'),
  ('u', '\u{304}', 'ū'),
  ('u', '\u{308}', 'ü'),
  ('u', '\u{30a}', 'ů'),
  ('u', '\u{30b}', 'ű'),
  ('u', '\u{328}', 'ų'),
  ('y', '\u{301}', 'ý'),
  ('y', '\u{308}', 'ÿ'),
  ('z', '\u{301}', 'ź'),
  ('z', '\u{307}', 'ż'),
  ('z', '\u{30c}', 'ž'),
];

/// The first `count` words of `pieces` when only spaces separate them, and
/// how many pieces they span.
fn leading_words<'p>(
  pieces: &[Piece<'p>],
  count: usize,
) -> Option<(Vec<&'p str>, usize)> {
  let mut words = Vec::with_capacity(count);
  let mut taken = 0;
  for piece in pieces {
    match piece {
      Piece::Word(word) => words.push(*word),
      Piece::Between(between) if between.chars().all(|c| c == ' ') => {}
      Piece::Between(_) => return None,
    }
    taken += 1;
    if words.len() == count {
      return Some((words, taken));
    }
  }
  None
}

/// How many letters may differ in a custom word of `letters` letters.
const fn allowed(letters: usize) -> usize {
  if letters >= TWO_OFF_LETTERS {
    2
  } else if letters >= ONE_OFF_LETTERS {
    1
  } else {
    0
  }
}

/// `spelling` as the speaker wrote it, with a capital first letter when the
/// replaced text had one and the custom word starts in lower case, as at the
/// start of a sentence.
fn cased_like(spelling: &str, original: &str) -> String {
  let starts_upper = |text: &str| text.chars().next().is_some_and(char::is_uppercase);
  let starts_lower = spelling.chars().next().is_some_and(char::is_lowercase);
  if starts_upper(original) && starts_lower {
    let mut chars = spelling.chars();
    chars.next().map_or_else(String::new, |first| {
      first.to_uppercase().chain(chars).collect()
    })
  } else {
    spelling.to_string()
  }
}

/// Lower case, without diacritics and without apostrophes or hyphens.
fn fold(word: &str) -> String {
  word
    .chars()
    .filter(|character| !joiner(*character) && !combining(*character))
    .flat_map(char::to_lowercase)
    .map(base_letter)
    .collect()
}

/// A combining accent, written after the letter it belongs to.
const fn combining(character: char) -> bool {
  matches!(
    character as u32,
    0x0300..=0x036F | 0x1AB0..=0x1AFF | 0x1DC0..=0x1DFF | 0x20D0..=0x20FF | 0xFE20..=0xFE2F
  )
}

/// The letter without its diacritic, for the Latin letters the dictation
/// languages use.
const fn base_letter(letter: char) -> char {
  match letter {
    'á' | 'à' | 'â' | 'ä' | 'ã' | 'å' | 'ā' | 'ą' | 'ă' => 'a',
    'č' | 'ć' | 'ç' => 'c',
    'ď' | 'đ' => 'd',
    'é' | 'è' | 'ê' | 'ë' | 'ě' | 'ē' | 'ę' | 'ė' => 'e',
    'ģ' => 'g',
    'í' | 'ì' | 'î' | 'ï' | 'ī' | 'į' => 'i',
    'ķ' => 'k',
    'ĺ' | 'ľ' | 'ł' | 'ļ' => 'l',
    'ň' | 'ń' | 'ñ' | 'ņ' => 'n',
    'ó' | 'ò' | 'ô' | 'ö' | 'õ' | 'ő' | 'ø' | 'ō' => 'o',
    'ŕ' | 'ř' => 'r',
    'š' | 'ś' | 'ş' | 'ș' => 's',
    'ť' | 'ţ' | 'ț' => 't',
    'ú' | 'ù' | 'û' | 'ü' | 'ů' | 'ű' | 'ū' | 'ų' => 'u',
    'ý' | 'ÿ' => 'y',
    'ž' | 'ź' | 'ż' => 'z',
    other => other,
  }
}

/// Edits between two words, a swap of neighbouring letters counted once.
fn distance(left: &str, right: &str) -> usize {
  let left = left.chars().collect::<Vec<_>>();
  let right = right.chars().collect::<Vec<_>>();
  let width = right.len() + 1;
  let mut table = vec![0usize; (left.len() + 1) * width];
  for (row, cell) in table.iter_mut().step_by(width).enumerate() {
    *cell = row;
  }
  for (column, cell) in table.iter_mut().take(width).enumerate() {
    *cell = column;
  }
  for row in 1..=left.len() {
    for column in 1..=right.len() {
      let cost = usize::from(left[row - 1] != right[column - 1]);
      let mut best = (table[(row - 1) * width + column] + 1)
        .min(table[row * width + column - 1] + 1)
        .min(table[(row - 1) * width + column - 1] + cost);
      if row > 1
        && column > 1
        && left[row - 1] == right[column - 2]
        && left[row - 2] == right[column - 1]
      {
        best = best.min(table[(row - 2) * width + column - 2] + 1);
      }
      table[row * width + column] = best;
    }
  }
  table[left.len() * width + right.len()]
}

#[cfg(test)]
mod tests {
  use super::*;

  /// Cases shared with `applyLearnedFixes` in `@stll/transcript`.
  #[derive(serde::Deserialize)]
  struct LearnedCase {
    name: String,
    text: String,
    fixes: Vec<LearnedCaseFix>,
    expected: String,
  }

  #[derive(serde::Deserialize)]
  struct LearnedCaseFix {
    from: String,
    to: String,
  }

  #[test]
  fn learned_fixes_rewrite_the_shared_cases() {
    let cases: Vec<LearnedCase> =
      serde_json::from_str(include_str!("../fixtures/dictation-learned-fixes.json"))
        .unwrap();
    assert!(!cases.is_empty());
    for case in cases {
      let fixes = case
        .fixes
        .iter()
        .map(|fix| LearnedSpelling {
          from: &fix.from,
          to: &fix.to,
        })
        .collect::<Vec<_>>();
      assert_eq!(
        apply_learned(&case.text, &fixes),
        case.expected,
        "{}",
        case.name
      );
    }
  }

  /// Cases shared with `respell` in `@stll/transcript/spelling`.
  #[derive(serde::Deserialize)]
  struct SpellingCase {
    name: String,
    text: String,
    words: Vec<String>,
    expected: String,
  }

  #[test]
  fn custom_words_respell_the_shared_cases() {
    let cases: Vec<SpellingCase> = serde_json::from_str(include_str!(
      "../../../../packages/transcript/src/spelling.fixtures.json"
    ))
    .unwrap();
    assert!(!cases.is_empty());
    for case in cases {
      assert_eq!(
        respell(&case.text, &case.words),
        case.expected,
        "{}",
        case.name
      );
    }
  }

  #[test]
  fn composing_joins_a_letter_and_its_accent_and_leaves_the_rest() {
    assert_eq!(compose("Dvor\u{30c}a\u{301}k"), "Dvořák");
    assert_eq!(compose("Novotny\u{301}"), "Novotný");
    assert_eq!(compose("q\u{301}"), "q\u{301}");
    assert!(
      COMPOSED
        .windows(2)
        .all(|pair| (pair[0].0, pair[0].1) < (pair[1].0, pair[1].1))
    );
  }

  #[test]
  fn a_swap_of_two_letters_is_one_edit() {
    assert_eq!(distance("novka", "novak"), 1);
    assert_eq!(distance("kitten", "sitting"), 3);
  }
}
