import AppIntents
import Foundation

/// "Dictate to stella": the first run records, the next finishes and opens
/// the app on the text. The Action Button, Siri, Shortcuts and the Control
/// Center control all run it.
///
/// Compiled into the app and the widget extension, as the control needs
/// it there; being a Live Activity and audio recording intent, it always
/// runs in the app's process, where `DictateAction` records. The extension's
/// `DictateAction` is never called.
@available(iOS 18.0, *)
struct DictateIntent: AudioRecordingIntent, LiveActivityIntent {
  static let title = LocalizedStringResource("intent.title", table: "QuickDictation")
  static let description = IntentDescription(
    LocalizedStringResource("intent.description", table: "QuickDictation")
  )

  /// In the background by default; in front once a dictation is finished,
  /// or when only the app can go on (signing in, asking for the microphone).
  @available(iOS 26.0, *)
  static let supportedModes: IntentModes = [.background, .foreground(.dynamic)]

  init() {}

  func perform() async throws -> some IntentResult {
    try await DictateAction.perform(self)
    return .result()
  }
}
