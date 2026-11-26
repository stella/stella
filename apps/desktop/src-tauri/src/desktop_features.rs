//! The desktop features in the one order every surface lists them in. The
//! order lives in `fixtures/desktop-feature-order.json`: the Settings window
//! and the setup overview read it there, and the tray menu and the setup
//! tour take theirs from it here, so no surface keeps an order of its own.

use std::sync::LazyLock;

use serde::Deserialize;

/// A feature as the shared order names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Feature {
  Documents,
  Clipboard,
  Signing,
  Dictation,
  Activity,
}

#[derive(Deserialize)]
struct FeatureOrder {
  features: Vec<Feature>,
}

static ORDER: LazyLock<Vec<Feature>> = LazyLock::new(|| {
  serde_json::from_str::<FeatureOrder>(include_str!(
    "../../fixtures/desktop-feature-order.json"
  ))
  .expect("The shared desktop feature order must be valid")
  .features
});

fn rank(feature: Feature) -> usize {
  ORDER
    .iter()
    .position(|listed| *listed == feature)
    .expect("The shared desktop feature order names every feature")
}

/// `items` with those that are for a feature put in the one feature order,
/// among the places they hold; the others keep theirs.
pub fn in_feature_order<T: Copy, const N: usize>(
  items: [T; N],
  feature: impl Fn(T) -> Option<Feature>,
) -> [T; N] {
  let mut featured = items
    .iter()
    .copied()
    .filter(|item| feature(*item).is_some())
    .collect::<Vec<_>>();
  featured.sort_by_key(|item| feature(*item).map(rank));
  let mut featured = featured.into_iter();
  items.map(|item| match feature(item) {
    Some(_) => featured.next().unwrap_or(item),
    None => item,
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  const ALL: [Feature; 5] = [
    Feature::Documents,
    Feature::Clipboard,
    Feature::Signing,
    Feature::Dictation,
    Feature::Activity,
  ];

  #[test]
  fn the_shared_order_names_every_feature_once() {
    assert_eq!(ORDER.len(), ALL.len());
    for feature in ALL {
      assert_eq!(
        ORDER.iter().filter(|listed| **listed == feature).count(),
        1,
        "{feature:?}"
      );
    }
  }

  #[test]
  fn featured_items_follow_the_order_and_the_rest_keep_their_places() {
    let mut reversed = ALL.map(Some);
    reversed.reverse();
    let items = [None, reversed[0], None, reversed[1], reversed[2]];
    let ordered = in_feature_order(items, |item| item);
    assert_eq!(ordered[0], None);
    assert_eq!(ordered[2], None);
    let featured = [ordered[1], ordered[3], ordered[4]]
      .into_iter()
      .flatten()
      .map(rank)
      .collect::<Vec<_>>();
    assert!(featured.windows(2).all(|pair| pair[0] < pair[1]));
  }
}
