# Local file creation

`local_store` owns application file creation, opening and publication. Its
platform backends implement the native filesystem operations.

The approved roots are Stella's platform data, local-data, cache and state
directories, plus its macOS log directory. The macOS LaunchAgents directory
is a shared per-user registration directory. Root handles are cached; a
platform temporary anchor supports exclusively created private roots. The test-only
`write_generated_rpc_bindings` entry point writes the fixed repository source
artifact with ordinary source-file permissions, outside application data.

## Dependency-managed write allow-list

Only the following dependency-owned writes are delegated, through named
`local_store` entry points. They manage application registration and release
assets.

| Owner entry point                       | Dependency               | Files managed by the dependency                                                            |
| --------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------ |
| `enable_autostart`, `disable_autostart` | `tauri-plugin-autostart` | Platform login registration (LaunchAgents, Linux autostart entries, Windows registration). |
| `install_update`                        | `tauri-plugin-updater`   | Download staging, archive extraction, bundle replacement and the platform installer.       |

The application serializes its macOS launch-agent amendment to memory and
publishes it through `write_private_atomic`. The plugin's registration and
installation internals own their filesystem policies.

Clippy rejects raw writers, publication primitives and delegated plugin writer
calls outside `local_store`. Compile-fail probes enumerate the configured
methods and verify diagnostics at each call site. The probe example requires
the test-only `local-file-guard-probe` feature; its expected result is Clippy
failure, checked by `local_file_creation_clippy_contract`.

## Runtime publication

`create_runtime_file` creates a new regular file with an explicit data (0644)
or executable (0755) mode on Unix, independent of the process umask.
`create_private_dir_new` creates an exclusive 0700 directory;
`publish_directory` publishes a directory without replacing an existing entry.
Unix operations use pinned parent descriptors and no-follow traversal, and sync
the directories after publication. Windows holds non-delete-shared ancestor
handles and refuses reparse points before creating or publishing runtime entries;
publication uses a write-through move.

`create_temporary_root` creates a unique private directory under a pinned,
trusted platform temporary directory. `bind_private_socket` binds through the
pinned directory on Linux and sets the socket mode to 0600 inside its 0700
parent. Platforms without a handle-relative socket namespace return
`UnsupportedPinnedOperation` with `ErrorKind::Unsupported`; in particular,
macOS broker startup fails closed instead of using path-based binding. Protocol
fixtures still exercise real peer credentials and socket I/O on those platforms.
