import AppIntents
import SwiftUI
import WidgetKit

/// "Dictate to stella" in Control Center, on the Lock Screen and on the
/// Action Button: each press runs `DictateIntent`, which iOS performs in the
/// app's process.
struct DictationControl: ControlWidget {
  var body: some ControlWidgetConfiguration {
    StaticControlConfiguration(kind: "app.stll.quick-dictation") {
      ControlWidgetButton(action: DictateIntent()) {
        Label {
          Text(LocalizedStringResource("control.label", table: "QuickDictation"))
        } icon: {
          Image(systemName: "mic")
        }
      }
    }
    .displayName(LocalizedStringResource("control.displayName", table: "QuickDictation"))
    .description(LocalizedStringResource("control.description", table: "QuickDictation"))
  }
}

/// The extension's stand-in for the app's `DictateAction`: `DictateIntent`
/// is compiled here only for the control to name it, and never runs here.
enum DictateAction {
  static func perform(_ intent: DictateIntent) async throws {}
}
