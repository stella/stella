import AppIntents
import Foundation
import QuickDictation

/// What a run of `DictateIntent` does, in the app's process.
@available(iOS 18.0, *)
enum DictateAction {
  @MainActor
  static func perform(_ intent: DictateIntent) async throws {
    let session = QuickDictationSession.shared
    switch await session.press() {
    case .started:
      return
    case .finished, .waiting:
      // The app opens on the dictation (`src/components/quick-dictation-sync.tsx`).
      // Before iOS 26 an intent cannot bring it forward; the Live Activity
      // then says the text is ready, and a tap on it opens the app.
      if #available(iOS 26.0, *) {
        try await intent.continueInForeground(nil, alwaysConfirm: false)
      }
    case .refused(let refusal):
      if #available(iOS 26.0, *) {
        switch refusal {
        case .signedOut:
          // The app opens on its sign-in.
          try await intent.continueInForeground(nil, alwaysConfirm: false)
          return
        case .microphoneUndecided:
          // Only the app in front may ask; once allowed, the press records.
          try await intent.continueInForeground(nil, alwaysConfirm: false)
          if await session.requestMicrophone() {
            _ = await session.press()
          }
          return
        case .microphoneDenied, .failed:
          break
        }
      }
      throw DictateRefusal(refusal)
    }
  }
}

/// Why nothing was recorded, said by Siri, Shortcuts or the Action Button's
/// notice where the app cannot be brought forward.
@available(iOS 18.0, *)
struct DictateRefusal: Error, CustomLocalizedStringResourceConvertible {
  let localizedStringResource: LocalizedStringResource

  init(_ refusal: QuickDictationRefusal) {
    switch refusal {
    case .signedOut:
      localizedStringResource = LocalizedStringResource("intent.signedOut", table: "QuickDictation")
    case .microphoneUndecided, .microphoneDenied:
      localizedStringResource = LocalizedStringResource("intent.microphone", table: "QuickDictation")
    case .failed:
      localizedStringResource = LocalizedStringResource("intent.failed", table: "QuickDictation")
    }
  }
}

/// The phrases Siri knows and the action the Shortcuts app and the Action
/// Button offer without setup.
@available(iOS 18.0, *)
struct StellaShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: DictateIntent(),
      phrases: [
        "Dictate to \(.applicationName)",
        "Start \(.applicationName) dictation",
      ],
      shortTitle: LocalizedStringResource("shortcut.shortTitle", table: "QuickDictation"),
      systemImageName: "mic"
    )
  }
}
