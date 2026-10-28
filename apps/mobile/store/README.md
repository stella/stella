# App Store listing

What App Store Connect asks for the stella app, kept beside the code so a
change to the app and to what the store says about it land together.

`ios/metadata/<locale>/` follows the layout App Store tooling uploads
(`name.txt`, `subtitle.txt`, `keywords.txt`, `description.txt`, …).
Limits: name and subtitle 30 characters, keywords 100 bytes, promotional
text 170, description 4000.

## App information

- Category: Business (primary), Productivity (secondary).
- Content rights: the app shows only what the person's own workspace holds.
- Age rating: every questionnaire answer "None" or "No"; unrestricted web
  access "No" (links open the person's own workspace and stll.app only).
- Encryption: exempt (`usesNonExemptEncryption: false` in `app.config.ts`).

## App Privacy

Matches the build's privacy manifest (`privacyManifests` in `app.config.ts`).

- Tracking: **No**.
- Data collected, all **linked to the user**, none used for tracking, all
  for **App Functionality** only:
  - Contact Info → Email Address, Name.
  - User Content → Other User Content (messages, tasks, timers, scans).
- Not collected: location, contacts, browsing or search history,
  identifiers for advertising, usage data, diagnostics (the app carries no
  analytics or crash reporting).

## App Review

- Sign-in: the reviewer uses the restricted review account
  (`APP_REVIEW_ACCOUNT_EMAIL`, `review@` the production domain), which the
  API admits by password: on the sign-in page, "Use password". Its
  organization holds sample matters. The password goes into App Store
  Connect's review information only, never into this repository.
- Notes for the reviewer:

  > stella is a workspace for law firms. Sign in on the page that opens with
  > the review account's email, choose "Use password", and enter the
  > password above. The account's workspace holds sample matters to browse,
  > a chat to ask about them, tasks and timers. Account deletion: Settings →
  > Delete account opens the account page on the web, where deletion
  > completes with an emailed code.

## Screenshots

iPhone 6.9" (1320×2868) and iPad 13" (2064×2752), from the simulators
signed in to the review account's sample workspace: the chats, a matter, a
scan, tasks, a running timer on the Lock Screen, and the iPad split view.
