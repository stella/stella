//! Switching stella desktop to another account. A web page can only ask for
//! a switch: the current link ends only after the member confirms it in this
//! app's own window, only while it is still the account the confirmation
//! named, and Cancel keeps it untouched.

use crate::account::LinkError;
use crate::types::DesktopLinkFailure;

/// One switch asks at a time: another attempt is refused rather than queued
/// behind an open confirmation, where it would name an account a confirmed
/// switch may already have replaced.
pub(crate) static SWITCH_GATE: tokio::sync::Mutex<()> =
  tokio::sync::Mutex::const_new(());

/// The member's confirmation in the desktop window. Only [`switch_account`]
/// creates one, so nothing ends the current link for a switch without it.
pub(crate) struct SwitchConfirmed {
  _private: (),
}

/// The linked account a switch offers to replace, as this app had it saved
/// when it asked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CurrentAccount {
  pub api_base_url: String,
  pub user_id: String,
  pub organization_id: String,
}

pub(crate) struct SwitchOffer<'a> {
  /// The linked account the confirmation names.
  pub current: &'a CurrentAccount,
  pub current_email: &'a str,
  pub email: &'a str,
  pub organization_name: &'a str,
}

/// Why the current link did not end.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum EndCurrentLink {
  /// The linked account is no longer the one the member confirmed replacing.
  Changed,
  Failed(String),
}

pub(crate) trait SwitchHost {
  /// Asks the member in the desktop window.
  async fn confirm(&self, offer: &SwitchOffer<'_>) -> Result<bool, String>;
  /// Under the account request lease, checks that `expected` is still the
  /// linked account, ends that link the way Disconnect does, then takes the
  /// switch's device key.
  async fn end_current_link(
    &self,
    confirmed: SwitchConfirmed,
    expected: &CurrentAccount,
  ) -> Result<(), EndCurrentLink>;
  /// Saves the new account, revoking its credential when that fails.
  async fn link_new(&self) -> Result<(), LinkError>;
  /// Revokes the new account's credential, which this app never saved.
  async fn revoke_new(&self) -> Result<(), String>;
}

pub(crate) async fn switch_account(
  host: &impl SwitchHost,
  gate: &tokio::sync::Mutex<()>,
  offer: &SwitchOffer<'_>,
) -> Result<(), LinkError> {
  let Ok(_asking) = gate.try_lock() else {
    host.revoke_new().await?;
    return Err(LinkError::new(
      DesktopLinkFailure::SwitchDeclined,
      "Another desktop account switch is waiting for an answer",
    ));
  };
  let confirmed = match host.confirm(offer).await {
    Ok(true) => SwitchConfirmed { _private: () },
    Ok(false) => {
      host.revoke_new().await?;
      return Err(LinkError::new(
        DesktopLinkFailure::SwitchDeclined,
        "The desktop account switch was not confirmed",
      ));
    }
    Err(error) => {
      host.revoke_new().await?;
      return Err(error.into());
    }
  };
  match host.end_current_link(confirmed, offer.current).await {
    Ok(()) => host.link_new().await,
    Err(EndCurrentLink::Changed) => {
      host.revoke_new().await?;
      Err(LinkError::new(
        DesktopLinkFailure::SwitchDeclined,
        "The linked desktop account changed before the switch",
      ))
    }
    Err(EndCurrentLink::Failed(error)) => {
      host.revoke_new().await?;
      Err(error.into())
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[derive(Clone, Copy, Debug, PartialEq, Eq)]
  enum Step {
    Confirm,
    EndCurrentLink,
    LinkNew,
    RevokeNew,
  }

  fn account(user_id: &str) -> CurrentAccount {
    CurrentAccount {
      api_base_url: "https://api.stll.app".into(),
      user_id: user_id.into(),
      organization_id: "org_fixture".into(),
    }
  }

  /// One desktop's linked account, shared by the switches that race on it.
  struct LinkedHere(std::sync::Mutex<Option<CurrentAccount>>);

  impl LinkedHere {
    fn new(current: &CurrentAccount) -> Self {
      Self(std::sync::Mutex::new(Some(current.clone())))
    }

    fn get(&self) -> Option<CurrentAccount> {
      self.0.lock().unwrap().clone()
    }

    fn set(&self, account: Option<CurrentAccount>) {
      *self.0.lock().unwrap() = account;
    }
  }

  struct FakeHost<'a> {
    linked: &'a LinkedHere,
    new_account: CurrentAccount,
    answer: Result<bool, String>,
    end_fails: bool,
    steps: std::sync::Mutex<Vec<Step>>,
  }

  impl<'a> FakeHost<'a> {
    fn new(linked: &'a LinkedHere, new_account: CurrentAccount) -> Self {
      Self {
        linked,
        new_account,
        answer: Ok(true),
        end_fails: false,
        steps: std::sync::Mutex::new(Vec::new()),
      }
    }

    fn record(&self, step: Step) {
      self.steps.lock().unwrap().push(step);
    }

    fn steps(&self) -> Vec<Step> {
      self.steps.lock().unwrap().clone()
    }
  }

  impl SwitchHost for FakeHost<'_> {
    async fn confirm(&self, offer: &SwitchOffer<'_>) -> Result<bool, String> {
      assert_eq!(offer.email, "new@example.test");
      self.record(Step::Confirm);
      self.answer.clone()
    }

    async fn end_current_link(
      &self,
      _confirmed: SwitchConfirmed,
      expected: &CurrentAccount,
    ) -> Result<(), EndCurrentLink> {
      self.record(Step::EndCurrentLink);
      if self.end_fails {
        return Err(EndCurrentLink::Failed(
          "Could not remove desktop account".into(),
        ));
      }
      if self.linked.get().as_ref() != Some(expected) {
        return Err(EndCurrentLink::Changed);
      }
      self.linked.set(None);
      Ok(())
    }

    async fn link_new(&self) -> Result<(), LinkError> {
      self.record(Step::LinkNew);
      self.linked.set(Some(self.new_account.clone()));
      Ok(())
    }

    async fn revoke_new(&self) -> Result<(), String> {
      self.record(Step::RevokeNew);
      Ok(())
    }
  }

  fn offer(current: &CurrentAccount) -> SwitchOffer<'_> {
    SwitchOffer {
      current,
      current_email: "current@example.test",
      email: "new@example.test",
      organization_name: "Fixture Legal",
    }
  }

  #[tokio::test]
  async fn a_confirmed_switch_ends_the_current_link_before_saving_the_new_one() {
    let (a, b) = (account("user_a"), account("user_b"));
    let linked = LinkedHere::new(&a);
    let host = FakeHost::new(&linked, b.clone());
    let gate = tokio::sync::Mutex::new(());
    assert_eq!(switch_account(&host, &gate, &offer(&a)).await, Ok(()));
    assert_eq!(
      host.steps(),
      [Step::Confirm, Step::EndCurrentLink, Step::LinkNew]
    );
    assert_eq!(linked.get(), Some(b));
  }

  #[tokio::test]
  async fn a_cancelled_switch_keeps_the_current_link_and_revokes_the_new_credential() {
    let a = account("user_a");
    let linked = LinkedHere::new(&a);
    let mut host = FakeHost::new(&linked, account("user_b"));
    host.answer = Ok(false);
    let gate = tokio::sync::Mutex::new(());
    let error = switch_account(&host, &gate, &offer(&a)).await.unwrap_err();
    assert_eq!(error.reason, DesktopLinkFailure::SwitchDeclined);
    assert_eq!(host.steps(), [Step::Confirm, Step::RevokeNew]);
    assert_eq!(linked.get(), Some(a));
  }

  #[tokio::test]
  async fn a_switch_without_an_answer_never_ends_the_current_link() {
    let a = account("user_a");
    let linked = LinkedHere::new(&a);
    let mut host = FakeHost::new(&linked, account("user_b"));
    host.answer = Err("The dialog could not open".into());
    let gate = tokio::sync::Mutex::new(());
    let error = switch_account(&host, &gate, &offer(&a)).await.unwrap_err();
    assert_eq!(error.reason, DesktopLinkFailure::Unavailable);
    assert_eq!(host.steps(), [Step::Confirm, Step::RevokeNew]);
    assert_eq!(linked.get(), Some(a));
  }

  #[tokio::test]
  async fn a_current_link_that_cannot_end_leaves_the_new_account_unsaved() {
    let a = account("user_a");
    let linked = LinkedHere::new(&a);
    let mut host = FakeHost::new(&linked, account("user_b"));
    host.end_fails = true;
    let gate = tokio::sync::Mutex::new(());
    let error = switch_account(&host, &gate, &offer(&a)).await.unwrap_err();
    assert_eq!(error.reason, DesktopLinkFailure::Unavailable);
    assert_eq!(
      host.steps(),
      [Step::Confirm, Step::EndCurrentLink, Step::RevokeNew]
    );
    assert_eq!(linked.get(), Some(a));
  }

  // Two switches both planned to replace A. The first, confirmed, links B;
  // the second still names A, so it must not end B's link.
  #[tokio::test]
  async fn a_switch_confirmed_for_an_account_already_replaced_ends_nothing() {
    let (a, b, c) = (account("user_a"), account("user_b"), account("user_c"));
    let linked = LinkedHere::new(&a);
    let gate = tokio::sync::Mutex::new(());
    let first = FakeHost::new(&linked, b.clone());
    assert_eq!(switch_account(&first, &gate, &offer(&a)).await, Ok(()));
    let second = FakeHost::new(&linked, c);
    let error = switch_account(&second, &gate, &offer(&a))
      .await
      .unwrap_err();
    assert_eq!(error.reason, DesktopLinkFailure::SwitchDeclined);
    assert_eq!(
      second.steps(),
      [Step::Confirm, Step::EndCurrentLink, Step::RevokeNew]
    );
    assert_eq!(linked.get(), Some(b));
  }

  #[tokio::test]
  async fn a_second_switch_while_one_waits_for_an_answer_is_refused_unasked() {
    let a = account("user_a");
    let linked = LinkedHere::new(&a);
    let gate = tokio::sync::Mutex::new(());
    let waiting = gate.lock().await;
    let host = FakeHost::new(&linked, account("user_b"));
    let error = switch_account(&host, &gate, &offer(&a)).await.unwrap_err();
    assert_eq!(error.reason, DesktopLinkFailure::SwitchDeclined);
    assert_eq!(host.steps(), [Step::RevokeNew]);
    assert_eq!(linked.get(), Some(a));
    drop(waiting);
  }
}
