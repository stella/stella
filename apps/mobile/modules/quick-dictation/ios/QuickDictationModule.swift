import ExpoModulesCore
import UIKit

/// The app's side of a dictation recorded outside its screens: the
/// configuration it hands over at sign-in, the finished dictation it takes
/// to transcribe, and the copy its sheet offers.
public class QuickDictationModule: Module {
  private var observer: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("QuickDictation")

    Events("onChange")

    OnStartObserving {
      self.observer = NotificationCenter.default.addObserver(
        forName: QuickDictationSession.changed,
        object: nil,
        queue: nil
      ) { [weak self] notification in
        let phase = notification.userInfo?["phase"] as? String
        self?.sendEvent("onChange", ["phase": phase ?? QuickDictationPhase.idle.rawValue])
      }
    }

    OnStopObserving {
      if let observer = self.observer {
        NotificationCenter.default.removeObserver(observer)
      }
      self.observer = nil
    }

    // Defaults are safe from any thread; nothing else here touches them.
    Function("configure") { (configuration: String) -> Bool in
      QuickDictationStore.save(Data(configuration.utf8))
    }

    // The activity is ended first: ending it reads its name from the
    // configuration this then clears.
    AsyncFunction("clear") { () async in
      await QuickDictationSession.shared.cancel()
      QuickDictationStore.clear()
    }

    AsyncFunction("phase") { () async -> String in
      await MainActor.run { QuickDictationSession.shared.phase.rawValue }
    }

    AsyncFunction("take") { () async -> [String]? in
      await QuickDictationSession.shared.take()?.map(\.absoluteString)
    }

    AsyncFunction("discard") { () async in
      await QuickDictationSession.shared.discard()
    }

    AsyncFunction("copy") { (text: String) async in
      await MainActor.run { UIPasteboard.general.string = text }
    }
  }
}
