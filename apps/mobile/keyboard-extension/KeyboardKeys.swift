import UIKit

extension KeyboardLayoutChoice {
  /// Without a choice from the app, or without Full Access to read it: the
  /// layout of the person's first language.
  static var fallback: KeyboardLayoutChoice {
    let language = Locale.preferredLanguages.first.map { String($0.prefix { $0 != "-" }) }
    return language == "cs" || language == "sk" ? .qwertz : .qwerty
  }

  /// The three letter rows, as iOS lays out the same layout.
  var letterRows: [[String]] {
    switch self {
    case .qwertz:
      return [
        ["q", "w", "e", "r", "t", "z", "u", "i", "o", "p", "ú"],
        ["a", "s", "d", "f", "g", "h", "j", "k", "l", "ů"],
        ["y", "x", "c", "v", "b", "n", "m"],
      ]
    case .qwerty:
      return [
        ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
        ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
        ["z", "x", "c", "v", "b", "n", "m"],
      ]
    }
  }
}

/// The characters behind a long press and on the symbol planes.
enum KeyboardCharacters {
  /// Held, a letter offers these: Czech first, then Slovak.
  static let accents: [String: [String]] = [
    "a": ["á", "ä"],
    "c": ["č"],
    "d": ["ď"],
    "e": ["é", "ě"],
    "i": ["í"],
    "l": ["ľ", "ĺ"],
    "n": ["ň"],
    "o": ["ó", "ô"],
    "r": ["ř", "ŕ"],
    "s": ["š"],
    "t": ["ť"],
    "u": ["ú", "ů"],
    "y": ["ý"],
    "z": ["ž"],
  ]

  static let symbols: [[String]] = [
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
    ["-", "/", ":", ";", "(", ")", "§", "&", "@", "\""],
    [".", ",", "?", "!", "'"],
  ]

  static let moreSymbols: [[String]] = [
    ["[", "]", "{", "}", "#", "%", "^", "*", "+", "="],
    ["_", "\\", "|", "~", "<", ">", "€", "£", "„", "“"],
    [".", ",", "?", "!", "'"],
  ]
}

/// The stella keyboard's typing keys: letters in the chosen layout with
/// their accents under a long press, shift and caps lock, two symbol planes,
/// space, delete and return. They type whether or not the keyboard has Full
/// Access.
final class KeyboardKeys: UIView {
  struct Labels {
    let shift: String
    let capsLock: String
    let symbols: String
    let moreSymbols: String
    let letters: String
    let space: String
    let delete: String
    let newLine: String
    let nextKeyboard: String
  }

  private enum Plane {
    case letters
    case symbols
    case moreSymbols
  }

  private enum Shift {
    case off
    /// The next letter only.
    case once
    case locked
  }

  /// Held this long, a letter offers its accents.
  private static let accentDelay: TimeInterval = 0.35
  /// Two taps on shift this close together lock it.
  private static let capsLockTaps: TimeInterval = 0.3

  var insert: (String) -> Void = { _ in }
  var deleteBackward: () -> Void = {}
  /// Whether the field wants a capital at the cursor now.
  var wantsCapital: () -> Bool = { false }
  /// The globe key; the controller gives it the system's keyboard switching.
  let nextKeyboardButton = UIButton(type: .system)

  private let labels: Labels
  private var layout: KeyboardLayoutChoice
  private var plane = Plane.letters
  private var shift = Shift.off
  private var lastShiftTap: Date?
  private var letterKeys: [(button: UIButton, letter: String)] = []
  private var shiftButton: UIButton?
  private let rows = UIStackView()
  private var deleteTimer: Timer?
  private var accentTimer: Timer?
  private var callout: AccentCallout?

  init(layout: KeyboardLayoutChoice, labels: Labels) {
    self.layout = layout
    self.labels = labels
    super.init(frame: .zero)
    // A long press's accents show over the row above, or the microphone.
    clipsToBounds = false
    rows.axis = .vertical
    rows.spacing = 8
    rows.distribution = .fillEqually
    rows.translatesAutoresizingMaskIntoConstraints = false
    addSubview(rows)
    NSLayoutConstraint.activate([
      rows.leadingAnchor.constraint(equalTo: leadingAnchor),
      rows.trailingAnchor.constraint(equalTo: trailingAnchor),
      rows.topAnchor.constraint(equalTo: topAnchor),
      rows.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])
    rebuild()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    nil
  }

  func use(_ next: KeyboardLayoutChoice) {
    guard next != layout else {
      return
    }
    layout = next
    rebuild()
  }

  /// Capitalizes the next letter where the field wants it, unless locked.
  func followCursor() {
    guard shift != .locked else {
      return
    }
    shift = wantsCapital() ? .once : .off
    applyShift()
  }

  func stop() {
    stopDeleting()
    dismissCallout()
  }

  // MARK: - Layout

  private static let characterKey = UIColor { traits in
    traits.userInterfaceStyle == .dark ? UIColor(white: 0.42, alpha: 1) : .white
  }

  private static let functionKey = UIColor { traits in
    traits.userInterfaceStyle == .dark
      ? UIColor(white: 0.27, alpha: 1)
      : UIColor(red: 0.67, green: 0.69, blue: 0.73, alpha: 1)
  }

  private static func key(title: String? = nil, symbol: String? = nil, function: Bool) -> UIButton {
    var configuration = UIButton.Configuration.filled()
    configuration.baseBackgroundColor = function ? functionKey : characterKey
    configuration.baseForegroundColor = .label
    configuration.cornerStyle = .medium
    configuration.contentInsets = .zero
    configuration.title = title
    configuration.image = symbol.flatMap { UIImage(systemName: $0) }
    configuration.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer {
      var attributes = $0
      attributes.font = .systemFont(ofSize: 22)
      return attributes
    }
    return UIButton(configuration: configuration)
  }

  private func rebuild() {
    dismissCallout()
    for row in rows.arrangedSubviews {
      row.removeFromSuperview()
    }
    letterKeys = []
    shiftButton = nil
    let characterRows: [[String]]
    switch plane {
    case .letters:
      characterRows = layout.letterRows
    case .symbols:
      characterRows = KeyboardCharacters.symbols
    case .moreSymbols:
      characterRows = KeyboardCharacters.moreSymbols
    }
    for (index, characters) in characterRows.enumerated() {
      let keys = characters.map { characterKey($0) }
      let row = UIStackView(arrangedSubviews: keys)
      row.spacing = 5
      row.distribution = .fillEqually
      // The last row holds shift, or the other symbol plane, and delete.
      if index == characterRows.count - 1 {
        rows.addArrangedSubview(
          UIStackView(arrangedSubviews: [planeOrShiftKey(), row, deleteKey()]).spaced(8))
      } else {
        rows.addArrangedSubview(row)
      }
    }
    rows.addArrangedSubview(bottomRow())
    applyShift()
  }

  private func characterKey(_ character: String) -> UIButton {
    let button = Self.key(title: character, function: false)
    button.accessibilityLabel = character
    if plane == .letters {
      letterKeys.append((button, character))
    }
    button.addTarget(self, action: #selector(characterDown(_:)), for: .touchDown)
    button.addTarget(
      self, action: #selector(characterMoved(_:event:)), for: [.touchDragInside, .touchDragOutside])
    button.addTarget(self, action: #selector(characterUp(_:)), for: .touchUpInside)
    button.addTarget(self, action: #selector(characterReleasedOutside(_:)), for: .touchUpOutside)
    button.addTarget(self, action: #selector(characterCancelled), for: .touchCancel)
    return button
  }

  private func planeOrShiftKey() -> UIButton {
    switch plane {
    case .letters:
      let button = Self.key(symbol: "shift", function: true)
      button.addTarget(self, action: #selector(shiftTapped), for: .touchUpInside)
      shiftButton = button
      return button.fixedWidth(44)
    case .symbols:
      let button = Self.key(title: "#+=", function: true)
      button.accessibilityLabel = labels.moreSymbols
      button.addTarget(self, action: #selector(showMoreSymbols), for: .touchUpInside)
      return button.fixedWidth(44)
    case .moreSymbols:
      let button = Self.key(title: "123", function: true)
      button.accessibilityLabel = labels.symbols
      button.addTarget(self, action: #selector(showSymbols), for: .touchUpInside)
      return button.fixedWidth(44)
    }
  }

  private func deleteKey() -> UIButton {
    let button = Self.key(symbol: "delete.left", function: true)
    button.accessibilityLabel = labels.delete
    button.addTarget(self, action: #selector(deleteDown), for: .touchDown)
    button.addTarget(
      self, action: #selector(stopDeleting), for: [.touchUpInside, .touchUpOutside, .touchCancel])
    return button.fixedWidth(44)
  }

  private func bottomRow() -> UIStackView {
    let planeKey = Self.key(title: plane == .letters ? "123" : "ABC", function: true)
    planeKey.accessibilityLabel = plane == .letters ? labels.symbols : labels.letters
    planeKey.addTarget(
      self, action: plane == .letters ? #selector(showSymbols) : #selector(showLetters),
      for: .touchUpInside)
    nextKeyboardButton.configuration = Self.key(symbol: "globe", function: true).configuration
    nextKeyboardButton.accessibilityLabel = labels.nextKeyboard
    let space = Self.key(title: labels.space, function: false)
    space.addTarget(self, action: #selector(typeSpace), for: .touchUpInside)
    let newLine = Self.key(symbol: "return", function: true)
    newLine.accessibilityLabel = labels.newLine
    newLine.addTarget(self, action: #selector(typeReturn), for: .touchUpInside)
    return UIStackView(arrangedSubviews: [
      planeKey.fixedWidth(48), nextKeyboardButton.fixedWidth(44), space, newLine.fixedWidth(80),
    ]).spaced(6)
  }

  private func applyShift() {
    let upper = shift != .off
    for (button, letter) in letterKeys {
      var configuration = button.configuration
      configuration?.title = upper ? letter.uppercased() : letter
      button.configuration = configuration
      button.accessibilityLabel = configuration?.title
    }
    guard let shiftButton else {
      return
    }
    var configuration = shiftButton.configuration
    switch shift {
    case .off:
      configuration?.image = UIImage(systemName: "shift")
    case .once:
      configuration?.image = UIImage(systemName: "shift.fill")
    case .locked:
      configuration?.image = UIImage(systemName: "capslock.fill")
    }
    shiftButton.configuration = configuration
    shiftButton.accessibilityLabel = shift == .locked ? labels.capsLock : labels.shift
    shiftButton.accessibilityTraits = shift == .off ? .button : [.button, .selected]
  }

  // MARK: - Typing

  private func type(_ text: String) {
    insert(text)
    if shift == .once {
      shift = .off
    }
    followCursor()
  }

  private func cased(_ character: String) -> String {
    plane == .letters && shift != .off ? character.uppercased() : character
  }

  @objc private func characterDown(_ sender: UIButton) {
    dismissCallout()
    guard plane == .letters,
      let letter = letterKeys.first(where: { $0.button === sender })?.letter,
      let accents = KeyboardCharacters.accents[letter]
    else {
      return
    }
    accentTimer = Timer.scheduledTimer(withTimeInterval: Self.accentDelay, repeats: false) {
      [weak self] _ in
      self?.showAccents([letter] + accents, over: sender)
    }
  }

  @objc private func characterMoved(_ sender: UIButton, event: UIEvent) {
    guard let callout, let touch = event.allTouches?.first else {
      return
    }
    callout.select(at: touch.location(in: callout))
  }

  @objc private func characterUp(_ sender: UIButton) {
    accentTimer?.invalidate()
    accentTimer = nil
    if let chosen = callout?.selected {
      dismissCallout()
      type(chosen)
      return
    }
    if let title = letterKeys.first(where: { $0.button === sender })?.letter
      ?? sender.configuration?.title
    {
      type(cased(title))
    }
  }

  /// Let go away from the key: only an accent being chosen is typed.
  @objc private func characterReleasedOutside(_ sender: UIButton) {
    accentTimer?.invalidate()
    accentTimer = nil
    if let chosen = callout?.selected {
      type(chosen)
    }
    dismissCallout()
  }

  @objc private func characterCancelled() {
    accentTimer?.invalidate()
    accentTimer = nil
    dismissCallout()
  }

  private func showAccents(_ options: [String], over key: UIButton) {
    let callout = AccentCallout(options: options.map(cased))
    addSubview(callout)
    let frame = key.convert(key.bounds, to: self)
    let width = CGFloat(options.count) * max(frame.width, 34)
    let height = frame.height + 4
    callout.frame = CGRect(
      x: min(max(frame.midX - width / 2, 0), bounds.width - width),
      y: frame.minY - height - 4, width: width, height: height)
    // The first accent, not the letter itself, is what a press is after.
    callout.select(index: 1)
    self.callout = callout
  }

  private func dismissCallout() {
    callout?.removeFromSuperview()
    callout = nil
  }

  @objc private func shiftTapped() {
    let now = Date()
    if let last = lastShiftTap, now.timeIntervalSince(last) < Self.capsLockTaps {
      shift = .locked
      lastShiftTap = nil
    } else {
      shift = shift == .off ? .once : .off
      lastShiftTap = now
    }
    applyShift()
  }

  @objc private func showSymbols() {
    plane = .symbols
    rebuild()
  }

  @objc private func showMoreSymbols() {
    plane = .moreSymbols
    rebuild()
  }

  @objc private func showLetters() {
    plane = .letters
    rebuild()
  }

  @objc private func typeSpace() {
    type(" ")
    // As on the system keyboard, a space after symbols goes back to letters.
    if plane != .letters {
      showLetters()
    }
  }

  @objc private func typeReturn() {
    type("\n")
  }

  @objc private func deleteDown() {
    deleteBackward()
    deleteTimer = Timer.scheduledTimer(withTimeInterval: 0.45, repeats: false) { [weak self] _ in
      self?.deleteTimer = Timer.scheduledTimer(withTimeInterval: 0.08, repeats: true) {
        [weak self] _ in
        self?.deleteBackward()
      }
    }
  }

  @objc private func stopDeleting() {
    deleteTimer?.invalidate()
    deleteTimer = nil
    followCursor()
  }
}

/// A letter's accents above it, the one under the finger picked.
private final class AccentCallout: UIView {
  private let options: [String]
  private var labels: [UILabel] = []
  private(set) var selected: String?

  init(options: [String]) {
    self.options = options
    super.init(frame: .zero)
    backgroundColor = UIColor { traits in
      traits.userInterfaceStyle == .dark ? UIColor(white: 0.42, alpha: 1) : .white
    }
    layer.cornerRadius = 8
    layer.shadowColor = UIColor.black.cgColor
    layer.shadowOpacity = 0.25
    layer.shadowRadius = 3
    layer.shadowOffset = CGSize(width: 0, height: 1)
    let stack = UIStackView()
    stack.distribution = .fillEqually
    stack.translatesAutoresizingMaskIntoConstraints = false
    for option in options {
      let label = UILabel()
      label.text = option
      label.textAlignment = .center
      label.font = .systemFont(ofSize: 22)
      label.layer.cornerRadius = 6
      label.layer.masksToBounds = true
      labels.append(label)
      stack.addArrangedSubview(label)
    }
    addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 2),
      stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -2),
      stack.topAnchor.constraint(equalTo: topAnchor, constant: 2),
      stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -2),
    ])
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    nil
  }

  func select(at point: CGPoint) {
    guard bounds.width > 0 else {
      return
    }
    let index = Int(point.x / (bounds.width / CGFloat(options.count)))
    select(index: min(max(index, 0), options.count - 1))
  }

  func select(index: Int) {
    let chosen = min(max(index, 0), options.count - 1)
    selected = options[chosen]
    for (position, label) in labels.enumerated() {
      label.backgroundColor = position == chosen ? .tintColor : .clear
      label.textColor = position == chosen ? .white : .label
    }
  }
}

extension UIView {
  fileprivate func fixedWidth(_ width: CGFloat) -> Self {
    widthAnchor.constraint(equalToConstant: width).isActive = true
    return self
  }
}

extension UIStackView {
  fileprivate func spaced(_ spacing: CGFloat) -> UIStackView {
    self.spacing = spacing
    return self
  }
}
