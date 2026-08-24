pub fn should_prevent_exit(code: Option<i32>) -> bool {
  code.is_none()
}

#[cfg(test)]
mod tests {
  use super::should_prevent_exit;

  #[test]
  fn background_exit_is_prevented_but_explicit_exit_is_allowed() {
    assert!(should_prevent_exit(None));
    assert!(!should_prevent_exit(Some(0)));
    assert!(!should_prevent_exit(Some(i32::MAX)));
  }
}
