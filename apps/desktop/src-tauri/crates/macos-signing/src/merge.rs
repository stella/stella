//! Joining identity searches that may answer with the same certificate.

use std::collections::HashSet;

/// Every item of `searches`, in order, except one whose `key` an earlier item
/// already had. A smart card's certificate can also sit in a file keychain,
/// and the first search's entry is the one kept.
pub(crate) fn first_by_key<T>(
  searches: impl IntoIterator<Item = Vec<T>>,
  key: impl Fn(&T) -> &str,
) -> Vec<T> {
  let mut seen = HashSet::new();
  searches
    .into_iter()
    .flatten()
    .filter(|item| seen.insert(key(item).to_owned()))
    .collect()
}

#[cfg(test)]
mod tests {
  use super::*;

  /// An identity as a search returns it: its fingerprint, and which search
  /// found it.
  type Found = (&'static str, &'static str);

  fn merged(searches: [Vec<Found>; 2]) -> Vec<Found> {
    first_by_key(searches, |(fingerprint, _)| fingerprint)
  }

  #[test]
  fn keeps_both_searches_in_order() {
    assert_eq!(
      merged([
        vec![("a", "keychain"), ("b", "keychain")],
        vec![("c", "token")]
      ]),
      [("a", "keychain"), ("b", "keychain"), ("c", "token")]
    );
  }

  #[test]
  fn a_certificate_both_searches_find_keeps_the_first_entry() {
    assert_eq!(
      merged([
        vec![("a", "keychain"), ("b", "keychain")],
        vec![("b", "token"), ("c", "token")]
      ]),
      [("a", "keychain"), ("b", "keychain"), ("c", "token")]
    );
  }

  #[test]
  fn a_repeat_inside_one_search_is_listed_once() {
    assert_eq!(
      merged([vec![], vec![("c", "token"), ("c", "token")]]),
      [("c", "token")]
    );
  }

  #[test]
  fn either_search_may_come_back_empty() {
    assert_eq!(
      merged([vec![("a", "keychain")], vec![]]),
      [("a", "keychain")]
    );
    assert_eq!(merged([vec![], vec![("c", "token")]]), [("c", "token")]);
    assert!(merged([vec![], vec![]]).is_empty());
  }

  /// Whatever the searches return, the result holds each key once, holds
  /// every key some search had, and keeps each key's first occurrence.
  #[test]
  fn every_key_survives_exactly_once_as_its_first_occurrence() {
    const KEYS: [&str; 3] = ["a", "b", "c"];
    // Every pair of searches of up to three items drawn from three keys.
    let searches: Vec<Vec<&str>> = (0..4)
      .flat_map(|length| {
        (0..KEYS.len().pow(length)).map(move |mut index| {
          (0..length)
            .map(|_| {
              let key = KEYS[index % KEYS.len()];
              index /= KEYS.len();
              key
            })
            .collect()
        })
      })
      .collect();
    for first in &searches {
      for second in &searches {
        let tagged = [
          first
            .iter()
            .map(|key| (*key, "keychain"))
            .collect::<Vec<_>>(),
          second.iter().map(|key| (*key, "token")).collect(),
        ];
        let everything: Vec<Found> = tagged.iter().flatten().copied().collect();
        let result = merged(tagged);

        let mut keys: Vec<&str> = result.iter().map(|(key, _)| *key).collect();
        let listed = keys.len();
        keys.sort_unstable();
        keys.dedup();
        assert_eq!(keys.len(), listed, "{first:?} {second:?}");
        for key in KEYS {
          assert_eq!(
            result.iter().find(|(found, _)| *found == key),
            everything.iter().find(|(found, _)| *found == key),
            "{first:?} {second:?}"
          );
        }
      }
    }
  }
}
