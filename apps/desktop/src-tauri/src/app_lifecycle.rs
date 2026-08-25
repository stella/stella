pub const BACKGROUND_LAUNCH_ARGUMENT: &str = "--stella-background-launch";

pub fn should_reveal_clipboard_on_launch<'a>(
  args: impl IntoIterator<Item = &'a str>,
) -> bool {
  !args
    .into_iter()
    .any(|arg| arg == BACKGROUND_LAUNCH_ARGUMENT || arg.starts_with("stella://"))
}

pub fn should_prevent_exit(code: Option<i32>) -> bool {
  code.is_none()
}

#[cfg(test)]
mod tests {
  use super::{
    BACKGROUND_LAUNCH_ARGUMENT, should_prevent_exit, should_reveal_clipboard_on_launch,
  };

  #[test]
  fn background_exit_is_prevented_but_explicit_exit_is_allowed() {
    assert!(should_prevent_exit(None));
    assert!(!should_prevent_exit(Some(0)));
    assert!(!should_prevent_exit(Some(i32::MAX)));
  }

  #[test]
  fn explicit_launch_reveals_clipboard_but_background_and_deep_links_do_not() {
    assert!(should_reveal_clipboard_on_launch(["stella-desktop"]));
    assert!(!should_reveal_clipboard_on_launch([
      "stella-desktop",
      BACKGROUND_LAUNCH_ARGUMENT,
    ]));
    assert!(!should_reveal_clipboard_on_launch([
      "stella-desktop",
      "stella://open/session",
    ]));
  }
}
