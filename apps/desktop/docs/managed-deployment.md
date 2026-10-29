# Managed deployment

Administrators can fix these settings for every user of a Mac or PC. The
app reads them once at launch; a change applies the next time stella desktop
starts.

| Key                | Type    | Effect                                                                                   |
| ------------------ | ------- | ---------------------------------------------------------------------------------------- |
| `DisableUpdates`   | Boolean | No update checks: background, tray and handoff. The tray says updates are managed.       |
| `DisableActivity`  | Boolean | The activity timeline stays off even when the server enables it for the account.         |
| `DisableClipboard` | Boolean | No clipboard history: nothing is recorded, and no shortcut, tray item or link opens it.  |
| `ServerWebOrigin`  | String  | With `ServerApiURL`: the self-hosted server trusted without the approval prompt.         |
| `ServerApiURL`     | String  | With `ServerWebOrigin`: that server's API. "Connect to stella web" links to this server. |

Both server keys must be set, as exact HTTPS origins without a path; a
server named by only one of them, or by an invalid URL, is ignored. The
managed server is trusted alongside the hosted service rather than in place
of it.

`DisableActivity` stops recording and closes the activity window, like any
other closed feature gate. Data already recorded stays on the device until
retention removes it.

`DisableClipboard` keeps clipboard history from starting: the clipboard is
never read, the global shortcut is not registered, the tray has no Clipboard
item, and first-run setup skips the shortcut practice step. Settings say the
organization turned it off. Clips recorded before stay encrypted on the device
and are not shown.

Copy diagnostics reports which of these settings apply, without naming the
server.

## macOS

Preference domain: `legal.stella.desktop`. Values count only when a
configuration profile forces them or they are in the machine-wide
`legal.stella.desktop.plist`, the one in the `Library/Preferences` folder at
the root of the startup disk. Values in a user's own `~/Library/Preferences`
are ignored, so a process running as the user cannot grant itself what only
an administrator may.

Configuration profile payload, deployed through MDM. Without MDM, wrap it in
a `.mobileconfig` and install that on the Mac by hand in System Settings ›
General › Device Management; its values are forced in the same way.

```xml
<dict>
  <key>PayloadType</key>
  <string>legal.stella.desktop</string>
  <key>PayloadIdentifier</key>
  <string>com.example.firm.stella-desktop</string>
  <key>PayloadUUID</key>
  <string>REPLACE-WITH-A-UUID</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
  <key>DisableUpdates</key>
  <true/>
  <key>DisableActivity</key>
  <true/>
  <key>DisableClipboard</key>
  <true/>
  <key>ServerWebOrigin</key>
  <string>https://stella.firm.example</string>
  <key>ServerApiURL</key>
  <string>https://api.stella.firm.example</string>
</dict>
```

Booleans must be plist booleans (`<true/>`, or `-bool true` with
`defaults write`); other types are ignored.

## Windows

Registry key: `Software\Policies\stella\Desktop`. The two switches are
read from `HKEY_LOCAL_MACHINE` first, then `HKEY_CURRENT_USER`; the server
keys only from `HKEY_LOCAL_MACHINE`, because they grant trust. Booleans are
`REG_DWORD` (`1` on, `0` off); server values are `REG_SZ`.

```reg
Windows Registry Editor Version 5.00

[HKEY_LOCAL_MACHINE\SOFTWARE\Policies\stella\Desktop]
"DisableUpdates"=dword:00000001
"DisableActivity"=dword:00000001
"DisableClipboard"=dword:00000001
"ServerWebOrigin"="https://stella.firm.example"
"ServerApiURL"="https://api.stella.firm.example"
```

## Development builds

Debug builds read `legal.stella.desktop.development` on macOS and
`Software\Policies\stella\Desktop Development` on Windows, so a policy for the
released app never changes a development build.
