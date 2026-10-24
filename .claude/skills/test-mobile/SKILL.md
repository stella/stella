---
name: test-mobile
description: "Drive the mobile app on an iOS simulator or Android emulator against this checkout's local stack: keep the development client in step with the native fingerprint, start Metro, sign in for real and capture evidence with `agent-device`. Use to see a mobile change working, not just tested."
---

# Test the Mobile App

Use this whenever a change to `apps/mobile` (or an API route it calls) needs
to be seen working on a device. Unit tests do not replace it: sign-in,
navigation and native modules only fail for real in the app.

The device driver is `agent-device` (pinned in `apps/mobile`; run it as
`bunx agent-device` from `apps/mobile`). It reads the accessibility tree, so
prefer `snapshot -i` and refs over screenshots, and screenshot for evidence.
Its sessions are scoped to this worktree and it claims the device it opens, so
parallel agents do not take over each other's simulators. Never shut down or
erase a simulator another session holds (`bunx agent-device device status`).

## 1. Start the stack

```bash
bun run agent:up
bun run agent:status
```

Note the API and web URLs it prints (`/dev` explains the stack). An iOS
simulator reaches them as printed (`http://localhost:<port>`); an Android
emulator reaches the host as `http://10.0.2.2:<port>`.

## 2. Pick a device and its development client

```bash
cd apps/mobile
bunx agent-device devices --platform ios
bun scripts/native-client.ts ensure ios <simulator-udid>
```

`ensure` installs the development client (`app.stll.mobile.dev`) when the
installed one does not match this checkout's native fingerprint, and does
nothing otherwise. A stale or missing client is a build step, not a blocker:
run `ensure`, which builds with `expo run`, unless the person said not to
build. `check` reports without building (exit 2: a build is needed). Android
takes an emulator serial (`adb devices`) the same way.

## 3. Start Metro

Run it in the background and keep it for the session. Use a port no other
checkout is serving (the default 8081 usually is), and name the stack's API
so the sign-in screen is prefilled:

```bash
cd apps/mobile
CI=1 EXPO_PUBLIC_STELLA_SERVER_URL=<api url> bunx expo start --dev-client --port <port>
```

`CI=1` keeps Expo from prompting. Open the bundle in the development client:

```bash
bunx agent-device open app.stll.mobile.dev \
  "exp+stella://expo-development-client/?url=http%3A%2F%2Flocalhost%3A<port>" \
  --platform ios --udid <simulator-udid>
```

## 4. Sign in

Sign in the way a person does; the flow is part of what you verify.

1. On "Sign in to stella", check the prefilled server address and press
   **Continue**.
2. iOS asks whether the app may use the server to sign in: `alert accept`.
3. The stack's sign-in page opens in the system browser session. Enter
   `test@stella.dev`, the seeded owner with matters and documents.
4. The local API does not send email; it keeps the last code per address:

   ```bash
   curl -s "<api url>/dev-public/last-otp?email=test@stella.dev"
   ```

   Fill in the `otp` it returns.
5. Approve the consent screen. The app returns to its tabs, signed in.

A person who should see an empty account signs in with a fresh address the
same way. Never paste tokens into the app or the keychain: a session that did
not come through this flow proves nothing about sign-in.

## 5. Drive and verify

```bash
bunx agent-device snapshot -i
bunx agent-device press @e4 --settle
bunx agent-device screenshot ../../.stella-dev/evidence/mobile-matters.png
```

Refs are valid only in the latest output; after `--settle`, use the refs in
its diff. Drive the state the change affects: signed out and signed in,
an empty and a full list, a failed request (stop the API, or
`bun run agent:down`, and check the message the app shows), a relaunch
(`bunx agent-device close` then `open` again; the keychain session must
survive it), and dark mode when a screen changed. Confirm what the app saved
through `bun run agent:cli` or the API, as `/dev` describes.

## 6. Finish

Report what you ran and what it showed: the commands, the screens you
reached, the screenshot paths, and any state from §5 you did not drive and
why. Then close your session (`bunx agent-device close`) and stop the Metro
process you started. Leave the stack and the simulator running for the next
iteration; `bun run agent:down` stops the stack when you are done with it.
