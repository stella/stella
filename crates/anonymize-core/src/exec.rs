//! Concurrency seam for the prepared-engine branches.
//!
//! Native targets fan independent work out across scoped OS threads. WebAssembly
//! targets (for example `wasm32-unknown-unknown` running in a browser) have no
//! portable thread pool, so the same closures run sequentially. Both paths share
//! one API so callers do not scatter `cfg` blocks. Results are byte-identical
//! because every spawned branch is independent and deterministic; only the
//! wall-clock scheduling differs.

#[cfg(not(target_family = "wasm"))]
mod imp {
  /// Handle to a branch spawned inside [`scope`].
  pub struct JoinHandle<'scope, T> {
    inner: std::thread::ScopedJoinHandle<'scope, T>,
  }

  impl<T> JoinHandle<'_, T> {
    /// Wait for the branch to finish and take its value.
    pub fn join(self) -> std::thread::Result<T> {
      self.inner.join()
    }
  }

  /// Scope that fans spawned branches out across OS threads.
  pub struct Scope<'scope, 'env> {
    inner: &'scope std::thread::Scope<'scope, 'env>,
  }

  impl<'scope> Scope<'scope, '_> {
    /// Spawn a branch that borrows from the enclosing scope.
    #[must_use]
    pub fn spawn<F, T>(&self, f: F) -> JoinHandle<'scope, T>
    where
      F: FnOnce() -> T + Send + 'scope,
      T: Send + 'scope,
    {
      JoinHandle {
        inner: self.inner.spawn(f),
      }
    }
  }

  /// Run `body` with a scope that executes spawned branches in parallel.
  pub fn scope<'env, F, T>(body: F) -> T
  where
    F: for<'scope> FnOnce(&Scope<'scope, 'env>) -> T,
  {
    std::thread::scope(|inner| body(&Scope { inner }))
  }
}

#[cfg(target_family = "wasm")]
mod imp {
  use core::marker::PhantomData;

  /// Handle to a branch that already ran sequentially.
  pub struct JoinHandle<'scope, T> {
    value: T,
    _scope: PhantomData<&'scope ()>,
  }

  impl<T> JoinHandle<'_, T> {
    /// Take the value the branch produced. This never reports a failure: the
    /// branch ran inline during [`Scope::spawn`], so there is no worker thread
    /// that could have panicked. The `Result` shape matches the native path so
    /// callers share one join site.
    #[allow(clippy::unnecessary_wraps)]
    pub fn join(self) -> std::thread::Result<T> {
      Ok(self.value)
    }
  }

  /// Scope that runs spawned branches inline, in spawn order.
  pub struct Scope<'scope, 'env> {
    _scope: PhantomData<&'scope ()>,
    _env: PhantomData<&'env ()>,
  }

  impl<'scope> Scope<'scope, '_> {
    /// Run a branch immediately and capture its value.
    // Mirrors the native scoped `spawn(&self, ...)` receiver so call sites are
    // identical across targets; the sequential path has no scope state to read.
    #[allow(clippy::unused_self)]
    #[must_use]
    pub fn spawn<F, T>(&self, f: F) -> JoinHandle<'scope, T>
    where
      F: FnOnce() -> T + Send + 'scope,
      T: Send + 'scope,
    {
      JoinHandle {
        value: f(),
        _scope: PhantomData,
      }
    }
  }

  /// Run `body` with a scope that executes spawned branches sequentially.
  pub fn scope<'env, F, T>(body: F) -> T
  where
    F: for<'scope> FnOnce(&Scope<'scope, 'env>) -> T,
  {
    body(&Scope {
      _scope: PhantomData,
      _env: PhantomData,
    })
  }
}

pub use imp::{JoinHandle, Scope, scope};
