//! Test-only coordination between child-process tests and file-lock tests.
//!
//! A spawned child shares every open file description of the test binary
//! until exec closes the close-on-exec ones. An flock is released only when
//! its last reference closes, so a lock that one test drops while a sibling
//! test is spawning a child can still look held for that instant. Tests that
//! release and re-acquire file locks take this guard shared; tests that spawn
//! child processes take it exclusively, so the two never overlap.

use std::sync::{PoisonError, RwLock, RwLockReadGuard, RwLockWriteGuard};

static CHILD_PROCESSES: RwLock<()> = RwLock::new(());

/// Held by tests whose assertions depend on a dropped file lock being free.
pub(crate) fn shared() -> RwLockReadGuard<'static, ()> {
  CHILD_PROCESSES
    .read()
    .unwrap_or_else(PoisonError::into_inner)
}

/// Held by tests that spawn child processes from the test binary.
pub(crate) fn exclusive() -> RwLockWriteGuard<'static, ()> {
  CHILD_PROCESSES
    .write()
    .unwrap_or_else(PoisonError::into_inner)
}
