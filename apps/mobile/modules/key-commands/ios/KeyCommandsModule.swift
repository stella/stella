import ExpoModulesCore
import UIKit

public class KeyCommandsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("KeyCommands")

    View(KeyCommandsView.self) {
      Prop("commands") { (view: KeyCommandsView, commands: [[String: Any]]) in
        view.setCommands(commands)
      }
      Events("onCommand")
    }
  }
}

/// One shortcut the app declares: what the key is, and the name the iPad's
/// shortcut overlay shows while ⌘ is held.
private struct Shortcut {
  let id: String
  let input: String
  let modifiers: UIKeyModifierFlags
  let title: String
}

/// A view around the app that answers hardware keyboard shortcuts. Every
/// view inside it passes them up to it, a text field being typed in too;
/// with nothing focused it takes the focus itself, so the shortcuts still
/// reach it, without raising a software keyboard.
final class KeyCommandsView: ExpoView {
  let onCommand = EventDispatcher()
  private var shortcuts: [Shortcut] = []
  private let noKeyboard = UIView(frame: .zero)

  override var canBecomeFirstResponder: Bool { true }
  override var inputView: UIView? { noKeyboard }

  override var keyCommands: [UIKeyCommand]? {
    shortcuts.map { shortcut in
      let command = UIKeyCommand(
        title: shortcut.title,
        action: #selector(runShortcut(_:)),
        input: shortcut.input,
        modifierFlags: shortcut.modifiers,
        propertyList: shortcut.id,
        discoverabilityTitle: shortcut.title
      )
      command.wantsPriorityOverSystemBehavior = true
      return command
    }
  }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    for name in [
      UITextField.textDidEndEditingNotification,
      UITextView.textDidEndEditingNotification,
      UIApplication.didBecomeActiveNotification,
    ] {
      NotificationCenter.default.addObserver(
        self, selector: #selector(takeFocusIfFree), name: name, object: nil)
    }
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
  }

  /// The keys a command names in words, as UIKit spells them.
  private static let specialInputs = [
    "escape": UIKeyCommand.inputEscape,
    "up": UIKeyCommand.inputUpArrow,
    "down": UIKeyCommand.inputDownArrow,
  ]

  /// While a text field is composing, as a Japanese or Chinese keyboard does
  /// before a word is chosen, the arrows and Escape belong to the field.
  override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    if action == #selector(runShortcut(_:)),
      let command = sender as? UIKeyCommand,
      !command.modifierFlags.contains(.command),
      let field = window?.findFirstResponder() as? UITextInput,
      field.markedTextRange != nil
    {
      return false
    }
    return super.canPerformAction(action, withSender: sender)
  }

  func setCommands(_ commands: [[String: Any]]) {
    shortcuts = commands.compactMap { command in
      guard let id = command["id"] as? String,
        let input = command["input"] as? String,
        let title = command["title"] as? String
      else { return nil }
      var modifiers: UIKeyModifierFlags = []
      for name in command["modifiers"] as? [String] ?? [] {
        switch name {
        case "command": modifiers.insert(.command)
        case "shift": modifiers.insert(.shift)
        case "option": modifiers.insert(.alternate)
        case "control": modifiers.insert(.control)
        default: break
        }
      }
      return Shortcut(
        id: id, input: Self.specialInputs[input] ?? input,
        modifiers: modifiers, title: title)
    }
    takeFocusIfFree()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    takeFocusIfFree()
  }

  @objc private func runShortcut(_ sender: UIKeyCommand) {
    guard let id = sender.propertyList as? String else { return }
    onCommand(["id": id])
  }

  /// Takes the focus when nothing else holds it, a text field above all.
  @objc private func takeFocusIfFree() {
    DispatchQueue.main.async { [weak self] in
      guard let self, let window = self.window, !self.isFirstResponder else { return }
      if window.findFirstResponder() == nil {
        self.becomeFirstResponder()
      }
    }
  }
}

extension UIView {
  fileprivate func findFirstResponder() -> UIResponder? {
    if isFirstResponder { return self }
    for subview in subviews {
      if let responder = subview.findFirstResponder() { return responder }
    }
    return nil
  }
}
