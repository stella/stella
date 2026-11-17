//! Scheduling class for work the user is waiting on.

/// Marks the calling thread as user-initiated work, so a busy machine still
/// schedules it ahead of background and default work. Threads it creates
/// afterwards start from the same class. Returns whether the system took it.
pub fn prefer_user_initiated() -> bool {
  // SAFETY: The call takes a class constant and a relative priority within
  // the class, and changes only the calling thread's scheduling.
  unsafe {
    libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_USER_INITIATED, 0)
      == 0
  }
}

#[cfg(test)]
mod tests {
  #[test]
  fn the_calling_thread_accepts_the_user_initiated_class() {
    let accepted = std::thread::spawn(super::prefer_user_initiated)
      .join()
      .unwrap();
    assert!(accepted);
  }
}
