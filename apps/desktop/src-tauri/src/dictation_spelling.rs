//! Spells the speaker's custom words the way the speaker does after the
//! speech model on this computer transcribed without them. Only when cleanup
//! is off: cleanup gets the words itself.
//!
//! A word or phrase in the text is replaced only when it is close to one
//! custom word and to no other: the same letters with other case or
//! diacritics, or, in a longer word, one or two letters off. Whole words
//! only, never part of one, and short words only when they differ in case or
//! diacritics alone. Pure: tested without a model.

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

/// A custom word or phrase as compared: its words, folded.
struct Target<'a> {
  spelling: &'a str,
  folded: Vec<String>,
  letters: usize,
}

/// A piece of the text: a word, or what lies between two words.
#[derive(Debug, PartialEq, Eq)]
enum Piece<'a> {
  Word(&'a str),
  Between(&'a str),
}

/// `text` with every close miss of a custom word spelled as in `words`.
pub fn respell(text: &str, words: &[String]) -> String {
  let targets = words
    .iter()
    .filter_map(|word| target(word))
    .collect::<Vec<_>>();
  if targets.is_empty() {
    return text.to_string();
  }
  let pieces = pieces(text);
  let mut out = String::with_capacity(text.len());
  let mut index = 0;
  while index < pieces.len() {
    match pieces[index] {
      Piece::Between(between) => {
        out.push_str(between);
        index += 1;
      }
      Piece::Word(word) => match best_match(&pieces[index..], &targets) {
        Some((target, taken)) => {
          let original = joined(&pieces[index..index + taken]);
          out.push_str(&cased_like(target.spelling, &original));
          index += taken;
        }
        None => {
          out.push_str(word);
          index += 1;
        }
      },
    }
  }
  out
}

fn target(word: &str) -> Option<Target<'_>> {
  let folded = word
    .split_whitespace()
    .map(fold)
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>();
  let letters = folded.iter().map(|part| part.chars().count()).sum();
  (letters >= MIN_LETTERS).then_some(Target {
    spelling: word,
    folded,
    letters,
  })
}

/// Splits `text` into words and what lies between them. A word is a run of
/// letters and digits, with an apostrophe or a hyphen inside it.
fn pieces(text: &str) -> Vec<Piece<'_>> {
  let mut pieces = Vec::new();
  let mut start = 0;
  let mut in_word = false;
  let chars = text.char_indices().collect::<Vec<_>>();
  for (position, &(offset, character)) in chars.iter().enumerate() {
    let joins = matches!(character, '\'' | '’' | '-')
      && in_word
      && chars
        .get(position + 1)
        .is_some_and(|(_, next)| next.is_alphanumeric());
    let wordlike = character.is_alphanumeric() || joins;
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

/// The custom word the words at the start of `pieces` are a close miss of,
/// and how many pieces it covers; the closest wins, then the longest phrase.
/// `None` when none is close, when two are equally close, or when the words
/// already read as the custom word.
fn best_match<'t>(
  pieces: &[Piece<'_>],
  targets: &'t [Target<'t>],
) -> Option<(&'t Target<'t>, usize)> {
  let mut best: Option<(&Target, usize, (usize, Reverse<usize>))> = None;
  let mut tied = false;
  for target in targets {
    let Some((words, taken)) = leading_words(pieces, target.folded.len()) else {
      continue;
    };
    let distance = words
      .iter()
      .zip(&target.folded)
      .map(|(word, folded)| distance(&fold(word), folded))
      .sum::<usize>();
    if distance > allowed(target.letters) {
      continue;
    }
    let rank = (distance, Reverse(target.folded.len()));
    match best {
      Some((_, _, known)) if known < rank => {}
      Some((_, _, known)) if known == rank => tied = true,
      _ => {
        best = Some((target, taken, rank));
        tied = false;
      }
    }
  }
  let (target, taken, _) = best.filter(|_| !tied)?;
  (joined(&pieces[..taken]) != target.spelling).then_some((target, taken))
}

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
    .filter(|character| !matches!(character, '\'' | '’' | '-'))
    .flat_map(char::to_lowercase)
    .map(base_letter)
    .collect()
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

  fn words(list: &[&str]) -> Vec<String> {
    list.iter().map(ToString::to_string).collect()
  }

  #[test]
  fn missing_diacritics_and_case_are_restored() {
    assert_eq!(
      respell(
        "dopis pro pana novaka a dvoracka",
        &words(&["Nováka", "Dvořáčka"])
      ),
      "dopis pro pana Nováka a Dvořáčka"
    );
  }

  #[test]
  fn a_longer_word_may_be_a_letter_off() {
    assert_eq!(
      respell("smlouva s firmou Kubernetis", &words(&["Kubernetes"])),
      "smlouva s firmou Kubernetes"
    );
    assert_eq!(
      respell("klient Hrdlicka", &words(&["Hrdlička"])),
      "klient Hrdlička"
    );
  }

  #[test]
  fn a_word_too_far_off_stays() {
    assert_eq!(
      respell("Nováková přijde", &words(&["Novák"])),
      "Nováková přijde"
    );
    assert_eq!(respell("pan Novy", &words(&["Novák"])), "pan Novy");
  }

  #[test]
  fn short_words_change_only_in_case_or_diacritics() {
    assert_eq!(respell("firma stll", &words(&["STLL"])), "firma STLL");
    assert_eq!(respell("firma stil", &words(&["STLL"])), "firma stil");
  }

  #[test]
  fn very_short_custom_words_are_left_alone() {
    assert_eq!(
      respell("ano, to je ono", &words(&["ANO"])),
      "ano, to je ono"
    );
  }

  #[test]
  fn only_whole_words_change() {
    assert_eq!(
      respell("dvorackova a dvoracek", &words(&["Dvořák"])),
      "dvorackova a dvoracek"
    );
  }

  #[test]
  fn phrases_match_word_for_word() {
    assert_eq!(
      respell(
        "podle smlouvy s Baker Mckenzie včera",
        &words(&["Baker McKenzie"])
      ),
      "podle smlouvy s Baker McKenzie včera"
    );
    // The whole phrase wins over one of its words.
    assert_eq!(
      respell("baker mckenzie", &words(&["Baker", "Baker McKenzie"])),
      "Baker McKenzie"
    );
    // Punctuation between the words is not a phrase.
    assert_eq!(
      respell("Baker. Mckenzie", &words(&["Baker McKenzie"])),
      "Baker. Mckenzie"
    );
  }

  #[test]
  fn a_word_close_to_two_custom_words_stays() {
    assert_eq!(
      respell("pan Kovarik", &words(&["Kovářík", "Kovarík"])),
      "pan Kovarik"
    );
  }

  #[test]
  fn a_capital_at_the_start_of_a_sentence_stays() {
    assert_eq!(
      respell("Ebitda vzrostla.", &words(&["EBITDA", "e-mailem"])),
      "EBITDA vzrostla."
    );
    assert_eq!(
      respell("Emailem posílám.", &words(&["e-mailem"])),
      "E-mailem posílám."
    );
  }

  #[test]
  fn punctuation_and_spacing_are_kept() {
    assert_eq!(
      respell("„novak“, (dvorak)!", &words(&["Novák", "Dvořák"])),
      "„Novák“, (Dvořák)!"
    );
  }

  #[test]
  fn the_right_spelling_and_no_words_change_nothing() {
    assert_eq!(respell("pan Novák", &words(&["Novák"])), "pan Novák");
    assert_eq!(respell("pan novak", &[]), "pan novak");
  }

  #[test]
  fn a_swap_of_two_letters_is_one_edit() {
    assert_eq!(distance("novka", "novak"), 1);
    assert_eq!(distance("kitten", "sitting"), 3);
  }
}
