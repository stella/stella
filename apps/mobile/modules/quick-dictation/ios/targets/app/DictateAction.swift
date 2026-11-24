import AppIntents
import Foundation
internal import QuickDictation

/// What a run of `DictateIntent` does, in the app's process.
enum DictateAction {
  @MainActor
  static func perform(_ intent: DictateIntent) async throws {
    let session = QuickDictationSession.shared
    switch await session.press() {
    case .started:
      return
    case .finished, .waiting:
      // The app opens on the dictation (`src/components/quick-dictation-sync.tsx`).
      try await intent.continueInForeground(nil, alwaysConfirm: false)
    case .refused(let refusal):
      switch refusal {
      case .signedOut:
        // The app opens on its sign-in.
        try await intent.continueInForeground(nil, alwaysConfirm: false)
      case .microphoneUndecided:
        // Only the app in front may ask; once allowed, the press records.
        try await intent.continueInForeground(nil, alwaysConfirm: false)
        if await session.requestMicrophone() {
          _ = await session.press()
        }
      case .microphoneDenied, .failed:
        throw DictateRefusal(refusal)
      }
    }
  }
}

/// Why nothing was recorded, said by Siri, Shortcuts or the Action Button's
/// notice where the app cannot be brought forward.
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
