//! Switching stella desktop to another account. A web page can only ask for
//! a switch: the current link ends only after the member confirms it in this
//! app's own window, and Cancel keeps it untouched.

use crate::account::LinkError;
use crate::types::DesktopLinkFailure;

/// The member's confirmation in the desktop window. Only [`switch_account`]
/// creates one, so nothing ends the current link for a switch without it.
pub(crate) struct SwitchConfirmed {
  _private: (),
}

pub(crate) struct SwitchOffer<'a> {
  /// The account linked now, as this app has it saved.
  pub current_email: &'a str,
  pub email: &'a str,
  pub organization_name: &'a str,
}

pub(crate) trait SwitchHost {
  /// Asks the member in the desktop window.
  async fn confirm(&self, offer: &SwitchOffer<'_>) -> Result<bool, String>;
  /// Ends the current link the way Disconnect does, then takes the switch's
  /// device key.
  async fn end_current_link(&self, confirmed: SwitchConfirmed) -> Result<(), String>;
  /// Saves the new account, revoking its credential when that fails.
  async fn link_new(&self) -> Result<(), LinkError>;
  /// Revokes the new account's credential, which this app never saved.
  async fn revoke_new(&self) -> Result<(), String>;
}

pub(crate) async fn switch_account(
  host: &impl SwitchHost,
  offer: &SwitchOffer<'_>,
) -> Result<(), LinkError> {
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
  if let Err(error) = host.end_current_link(confirmed).await {
    host.revoke_new().await?;
    return Err(error.into());
  }
  host.link_new().await
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

  struct FakeHost {
    answer: Result<bool, String>,
    end_current_link: Result<(), String>,
    steps: std::sync::Mutex<Vec<Step>>,
  }

  impl FakeHost {
    fn new(answer: Result<bool, String>) -> Self {
      Self {
        answer,
        end_current_link: Ok(()),
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

  impl SwitchHost for FakeHost {
    async fn confirm(&self, offer: &SwitchOffer<'_>) -> Result<bool, String> {
      assert_eq!(offer.current_email, "current@example.test");
      assert_eq!(offer.email, "new@example.test");
      self.record(Step::Confirm);
      self.answer.clone()
    }

    async fn end_current_link(
      &self,
      _confirmed: SwitchConfirmed,
    ) -> Result<(), String> {
      self.record(Step::EndCurrentLink);
      self.end_current_link.clone()
    }

    async fn link_new(&self) -> Result<(), LinkError> {
      self.record(Step::LinkNew);
      Ok(())
    }

    async fn revoke_new(&self) -> Result<(), String> {
      self.record(Step::RevokeNew);
      Ok(())
    }
  }

  const OFFER: SwitchOffer<'static> = SwitchOffer {
    current_email: "current@example.test",
    email: "new@example.test",
    organization_name: "Fixture Legal",
  };

  #[tokio::test]
  async fn a_confirmed_switch_ends_the_current_link_before_saving_the_new_one() {
    let host = FakeHost::new(Ok(true));
    assert_eq!(switch_account(&host, &OFFER).await, Ok(()));
    assert_eq!(
      host.steps(),
      [Step::Confirm, Step::EndCurrentLink, Step::LinkNew]
    );
  }

  #[tokio::test]
  async fn a_cancelled_switch_keeps_the_current_link_and_revokes_the_new_credential() {
    let host = FakeHost::new(Ok(false));
    let error = switch_account(&host, &OFFER).await.unwrap_err();
    assert_eq!(error.reason, DesktopLinkFailure::SwitchDeclined);
    assert_eq!(host.steps(), [Step::Confirm, Step::RevokeNew]);
  }

  #[tokio::test]
  async fn a_switch_without_an_answer_never_ends_the_current_link() {
    let host = FakeHost::new(Err("The dialog could not open".into()));
    let error = switch_account(&host, &OFFER).await.unwrap_err();
    assert_eq!(error.reason, DesktopLinkFailure::Unavailable);
    assert_eq!(host.steps(), [Step::Confirm, Step::RevokeNew]);
  }

  #[tokio::test]
  async fn a_current_link_that_cannot_end_leaves_the_new_account_unsaved() {
    let mut host = FakeHost::new(Ok(true));
    host.end_current_link = Err("Could not remove desktop account".into());
    let error = switch_account(&host, &OFFER).await.unwrap_err();
    assert_eq!(error.reason, DesktopLinkFailure::Unavailable);
    assert_eq!(
      host.steps(),
      [Step::Confirm, Step::EndCurrentLink, Step::RevokeNew]
    );
  }
}
