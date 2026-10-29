# Local file creation

`local_store` owns application file creation, opening and publication. Its
platform backends implement the native filesystem operations. On Unix, harness
archives use owner-only files (0700 for executables, 0600 otherwise) and directories;
release directories are published through the same storage owner.

`local_store::token_broker` owns the private channel directory and socket
permissions, and Windows pipe client options. Its short-lived Unix directory
is under the platform temporary directory; its socket is 0600 inside a 0700
directory. Windows clients retain identification-only security quality of
service. These channel operations do not use application-data file opens.

The approved roots are Stella's platform data, local-data, cache and state
directories, plus its macOS log directory. The macOS LaunchAgents directory
is a shared per-user registration directory. Root handles are cached; a
test-only temporary anchor supports isolated fixtures. The test-only
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
