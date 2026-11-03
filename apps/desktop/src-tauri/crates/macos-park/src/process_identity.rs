//! Which process is on the other end of a local channel, and its ancestry,
//! for a broker that answers only processes the desktop started. On Windows
//! also a named pipe that only the current user can open.
//!
//! Every call returns owned values; no native handle or pointer leaves this
//! module.

/// The parent of `pid`, or `None` when the process is gone or unreadable.
#[cfg(target_os = "macos")]
pub fn parent_process_id(pid: u32) -> Option<u32> {
  let pid = libc::c_int::try_from(pid).ok()?;
  let size = libc::c_int::try_from(std::mem::size_of::<libc::proc_bsdinfo>()).ok()?;
  let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
  // SAFETY: `info` is a writable, properly aligned `proc_bsdinfo` of `size`
  // bytes, which is the buffer `PROC_PIDTBSDINFO` fills.
  let written = unsafe {
    libc::proc_pidinfo(
      pid,
      libc::PROC_PIDTBSDINFO,
      0,
      info.as_mut_ptr().cast(),
      size,
    )
  };
  if written != size {
    return None;
  }
  // SAFETY: the call filled all `size` bytes of `info`, and an all-zero
  // `proc_bsdinfo` is valid as well.
  let info = unsafe { info.assume_init() };
  Some(info.pbi_ppid)
}

/// The parent of `pid`, or `None` when the process is gone or unreadable.
#[cfg(target_os = "windows")]
pub fn parent_process_id(pid: u32) -> Option<u32> {
  use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
  use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
    TH32CS_SNAPPROCESS,
  };

  // SAFETY: the snapshot call takes no pointers; its handle is closed below.
  let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
  if snapshot == INVALID_HANDLE_VALUE {
    return None;
  }
  let mut entry = PROCESSENTRY32W {
    dwSize: u32::try_from(std::mem::size_of::<PROCESSENTRY32W>()).ok()?,
    ..PROCESSENTRY32W::default()
  };
  let mut parent = None;
  // SAFETY: `snapshot` is a live snapshot handle and `entry` a writable
  // `PROCESSENTRY32W` whose `dwSize` names its own size.
  let mut more = unsafe { Process32FirstW(snapshot, &raw mut entry) } != 0;
  while more {
    if entry.th32ProcessID == pid {
      parent = Some(entry.th32ParentProcessID);
      break;
    }
    // SAFETY: as above.
    more = unsafe { Process32NextW(snapshot, &raw mut entry) } != 0;
  }
  // SAFETY: `snapshot` was opened above and is closed once.
  unsafe { CloseHandle(snapshot) };
  parent
}

/// The process ID of the client connected to a named pipe server.
#[cfg(target_os = "windows")]
pub fn named_pipe_client_process_id(
  pipe: std::os::windows::io::BorrowedHandle<'_>,
) -> std::io::Result<u32> {
  use std::os::windows::io::AsRawHandle;
  use windows_sys::Win32::System::Pipes::GetNamedPipeClientProcessId;

  let mut pid = 0_u32;
  // SAFETY: the borrowed handle is live for this call, and `pid` is a
  // writable `u32`.
  let ok = unsafe { GetNamedPipeClientProcessId(pipe.as_raw_handle(), &raw mut pid) };
  if ok == 0 {
    return Err(std::io::Error::last_os_error());
  }
  Ok(pid)
}

/// Creates a pipe instance whose access list grants only the current user;
/// with the default list, other local accounts could open it for reading.
#[cfg(target_os = "windows")]
pub fn create_owner_only_pipe(
  options: &tokio::net::windows::named_pipe::ServerOptions,
  name: &str,
) -> std::io::Result<tokio::net::windows::named_pipe::NamedPipeServer> {
  use windows_sys::Win32::Foundation::LocalFree;
  use windows_sys::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
  };
  use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;

  // Protected (`P`), so no inherited entry widens it; full access for the
  // current user's SID only.
  let sddl = format!("D:P(A;;GA;;;{})", current_user_sid()?);
  let wide: Vec<u16> = sddl.encode_utf16().chain(std::iter::once(0)).collect();
  let mut descriptor = std::ptr::null_mut();
  // SAFETY: `wide` is NUL-terminated and outlives the call; `descriptor`
  // receives a `LocalAlloc` block freed below.
  let ok = unsafe {
    ConvertStringSecurityDescriptorToSecurityDescriptorW(
      wide.as_ptr(),
      SDDL_REVISION_1,
      &raw mut descriptor,
      std::ptr::null_mut(),
    )
  };
  if ok == 0 {
    return Err(std::io::Error::last_os_error());
  }
  let mut attributes = SECURITY_ATTRIBUTES {
    nLength: u32::try_from(std::mem::size_of::<SECURITY_ATTRIBUTES>())
      .map_err(std::io::Error::other)?,
    lpSecurityDescriptor: descriptor,
    bInheritHandle: 0,
  };
  // SAFETY: `attributes` is a valid `SECURITY_ATTRIBUTES` whose descriptor
  // stays allocated until after the call, which copies it into the pipe.
  let created = unsafe {
    options.create_with_security_attributes_raw(name, (&raw mut attributes).cast())
  };
  // SAFETY: `descriptor` was allocated by the conversion above and is freed
  // once, after its last use.
  unsafe { LocalFree(descriptor) };
  created
}

#[cfg(target_os = "windows")]
fn current_user_sid() -> std::io::Result<String> {
  use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, LocalFree};
  use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
  use windows_sys::Win32::Security::{
    GetTokenInformation, TOKEN_QUERY, TOKEN_USER, TokenUser,
  };
  use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

  let mut token: HANDLE = std::ptr::null_mut();
  // SAFETY: the pseudo handle needs no closing; `token` receives a handle
  // closed below.
  if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw mut token) } == 0
  {
    return Err(std::io::Error::last_os_error());
  }
  let mut length = 0_u32;
  // SAFETY: a size query with no buffer; `length` receives the size needed.
  unsafe {
    GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &raw mut length)
  };
  // `u64` elements keep the buffer aligned for `TOKEN_USER`.
  let words = usize::try_from(length)
    .map_err(std::io::Error::other)?
    .div_ceil(8);
  let mut buffer = vec![0_u64; words.max(1)];
  // SAFETY: `buffer` is writable for at least `length` bytes.
  let read = unsafe {
    GetTokenInformation(
      token,
      TokenUser,
      buffer.as_mut_ptr().cast(),
      length,
      &raw mut length,
    )
  };
  let failure = std::io::Error::last_os_error();
  // SAFETY: `token` was opened above and is closed once.
  unsafe { CloseHandle(token) };
  if read == 0 {
    return Err(failure);
  }
  // SAFETY: the call wrote a `TOKEN_USER` at the start of the aligned buffer;
  // its SID points into the same buffer, which is still alive.
  let sid = unsafe { (*buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid };
  let mut text = std::ptr::null_mut();
  // SAFETY: `sid` is valid while `buffer` lives; `text` receives a
  // `LocalAlloc` string freed below.
  if unsafe { ConvertSidToStringSidW(sid, &raw mut text) } == 0 {
    return Err(std::io::Error::last_os_error());
  }
  let mut length = 0;
  // SAFETY: `text` is a NUL-terminated wide string from the call above.
  while unsafe { *text.add(length) } != 0 {
    length += 1;
  }
  // SAFETY: the first `length` elements of `text` are initialized.
  let sid =
    String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, length) });
  // SAFETY: `text` was allocated by the conversion and is freed once.
  unsafe { LocalFree(text.cast()) };
  Ok(sid)
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
  use super::*;

  #[test]
  fn the_parent_matches_what_the_system_reports() {
    assert_eq!(
      parent_process_id(std::process::id()),
      Some(std::os::unix::process::parent_id())
    );
    assert_eq!(parent_process_id(u32::MAX), None);
  }
}
