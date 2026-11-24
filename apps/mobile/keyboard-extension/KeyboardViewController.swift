import UIKit

/// The stella keyboard: dictation into any app. A keyboard may not record,
/// so the stella app records and transcribes, and the two talk through the
/// App Group (`KeyboardDictationBridge.swift`, copied in at prebuild). While
/// the app keeps the microphone warm, the big key starts and stops a
/// dictation here; otherwise it opens the app, which starts recording, and
/// the person comes back to stop it. Text that arrives while the keyboard is
/// shown goes in at the cursor; text that arrives after it closed is kept for
/// ten minutes behind a Paste dictation chip.
///
/// Its letters (`KeyboardKeys.swift`) type with or without Full Access; only
/// dictation needs it, and without it the big key says how to turn it on.
///
/// The keyboard records nothing, makes no network request and keeps nothing
/// typed; it reads the text before the cursor only to space what it inserts
/// and to capitalize a sentence's first letter.
final class KeyboardViewController: UIInputViewController {
  private struct Configuration {
    let group: String
    let scheme: String
    let dictateRoute: String
    let setupRoute: String
  }

  /// What the big key does and what the status line says.
  private enum Mode: Equatable {
    case noFullAccess
    /// The app's microphone is off: the key opens the app.
    case cold
    case ready
    case starting
    case recording
    case transcribing
    case stalled
  }

  private enum Notice {
    case silent
    case failed
  }

  /// Held this long, the big key records until it is let go.
  private static let holdToTalk: TimeInterval = 0.35
  /// A start the app has not taken up within this long was refused.
  private static let startWindowMs: Int64 = 3_000

  private let strings = KeyboardStrings.current
  private var configuration: Configuration?
  private var store: KeyboardDictationStore?
  private var language = KeyboardDictationBridge.languages[0]
  /// The dictation this keyboard started or came back to stop; its text
  /// goes in at the cursor when it arrives.
  private var pendingJob: String?
  private var pendingSince: Int64 = 0
  private var notice: Notice?
  private var mode: Mode = .cold
  private var holdTimer: Timer?
  private var holding = false
  private var stopOnRelease = false
  private var refreshTimer: Timer?
  private var observing = false

  private let statusLabel = UILabel()
  private let actionButton = UIButton(type: .system)
  private let micButton = UIButton(type: .system)
  private let languageButton = UIButton(type: .system)
  private lazy var keys = KeyboardKeys(
    layout: .fallback,
    labels: KeyboardKeys.Labels(
      shift: strings.shift, capsLock: strings.capsLock, symbols: strings.symbols,
      moreSymbols: strings.moreSymbols, letters: strings.letters, space: strings.space,
      delete: strings.delete, newLine: strings.newLine, nextKeyboard: strings.nextKeyboard))
  private let spinner = UIActivityIndicatorView(style: .medium)

  override func viewDidLoad() {
    super.viewDidLoad()
    configuration = Self.readConfiguration()
    layout()
  }

  override func viewWillAppear(_ animated: Bool) {
    super.viewWillAppear(animated)
    store = hasFullAccess ? configuration.flatMap { KeyboardDictationStore(group: $0.group) } : nil
    if let store {
      store.write(KeyboardDictationBridge.now(), KeyboardDictationBridge.keyboardSeenKey)
      if let chosen = store.read(String.self, KeyboardDictationBridge.languageKey),
        KeyboardDictationBridge.languages.contains(chosen)
      {
        language = chosen
      }
      // Back from the app with a dictation still recording: this keyboard
      // stops it, and inserts its text.
      let now = KeyboardDictationBridge.now()
      if let snapshot = store.snapshot, snapshot.phase == .recording, snapshot.isLive(at: now),
        let jobId = snapshot.jobId
      {
        pendingJob = jobId
        pendingSince = now
      }
      startObserving(group: store.group)
    }
    keys.use(
      store?.read(String.self, KeyboardDictationBridge.layoutKey)
        .flatMap(KeyboardLayoutChoice.init(rawValue:)) ?? .fallback)
    keys.followCursor()
    refreshTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      self?.render()
    }
    render()
  }

  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    refreshTimer?.invalidate()
    refreshTimer = nil
    keys.stop()
    holdTimer?.invalidate()
    if holding, let jobId = pendingJob {
      send(.stop, jobId: jobId)
    }
    holding = false
    stopOnRelease = false
    // Text for a dictation still under way now waits behind the chip:
    // the field it was meant for may be gone.
    pendingJob = nil
    notice = nil
    stopObserving()
  }

  override func viewWillLayoutSubviews() {
    super.viewWillLayoutSubviews()
    keys.nextKeyboardButton.isHidden = !needsInputModeSwitchKey
  }

  // MARK: - State

  private func render() {
    let now = KeyboardDictationBridge.now()
    guard let store else {
      mode = .noFullAccess
      apply(offered: false)
      return
    }
    let snapshot = store.snapshot
    if let jobId = pendingJob, let result = store.results.first(where: { $0.jobId == jobId }) {
      take(result, store: store)
    }
    if let jobId = pendingJob {
      if let snapshot, snapshot.jobId == jobId, snapshot.isLive(at: now) {
        mode = snapshot.phase == .transcribing ? .transcribing : .recording
      } else if snapshot?.isLive(at: now) != true {
        mode =
          now - pendingSince >= KeyboardDictationBridge.stalledAfterMs ? .stalled : .starting
      } else if now - pendingSince < Self.startWindowMs {
        mode = .starting
      } else {
        // The app is there but never took the dictation up.
        pendingJob = nil
        notice = .failed
        mode = snapshot?.isWarm(at: now) == true ? .ready : .cold
      }
    } else {
      mode = snapshot?.isWarm(at: now) == true ? .ready : .cold
    }
    apply(offered: pendingJob == nil && !store.offeredResults(at: now).isEmpty)
  }

  /// The pending dictation's outcome: its text goes in, or the notice says
  /// why there is none.
  private func take(_ result: KeyboardResult, store: KeyboardDictationStore) {
    switch result.outcome {
    case .text:
      if let text = result.text, !text.isEmpty {
        insert(text)
      }
    case .silent:
      notice = .silent
    case .failed:
      notice = .failed
    }
    markTaken(result.jobId, store: store)
    pendingJob = nil
  }

  private func markTaken(_ jobId: String, store: KeyboardDictationStore) {
    store.write(
      Array((store.inserted + [jobId]).suffix(KeyboardDictationBridge.keptInserted)),
      KeyboardDictationBridge.insertedKey)
  }

  private func apply(offered: Bool) {
    statusLabel.text = statusText()
    let recording = mode == .recording
    let busy = mode == .starting || mode == .transcribing
    var mic = micButton.configuration ?? .filled()
    mic.image = UIImage(
      systemName: recording ? "stop.fill" : "mic.fill",
      withConfiguration: UIImage.SymbolConfiguration(pointSize: 20, weight: .semibold))
    mic.title = recording ? strings.stop : strings.dictate
    mic.imagePadding = 8
    mic.baseBackgroundColor = recording ? .systemRed : .tintColor
    mic.baseForegroundColor = .white
    micButton.configuration = mic
    micButton.isEnabled = !busy
    micButton.accessibilityLabel = recording ? strings.stop : strings.dictate
    if busy {
      spinner.startAnimating()
    } else {
      spinner.stopAnimating()
    }

    let cancellable = recording || mode == .transcribing || mode == .starting
    actionButton.isHidden = !(cancellable || offered)
    var action = actionButton.configuration ?? .tinted()
    action.title = cancellable ? strings.cancel : strings.paste
    action.image = cancellable ? nil : UIImage(systemName: "doc.on.clipboard")
    actionButton.configuration = action

    var languageKey = languageButton.configuration ?? .filled()
    languageKey.title = language == "auto" ? strings.languageAutoShort : language.uppercased()
    languageButton.configuration = languageKey
    languageButton.accessibilityValue = languageName(language)
  }

  private func statusText() -> String {
    switch mode {
    case .noFullAccess:
      return strings.fullAccess
    case .starting:
      return strings.starting
    case .recording:
      return holding ? strings.holding : strings.recording
    case .transcribing:
      return strings.transcribing
    case .stalled:
      return strings.stalled
    case .cold, .ready:
      switch notice {
      case .silent:
        return strings.silent
      case .failed:
        return strings.failed
      case nil:
        return mode == .ready ? strings.ready : strings.openToDictate
      }
    }
  }

  // MARK: - The big key

  @objc private func micDown() {
    notice = nil
    stopOnRelease = mode == .recording
    guard mode == .ready else {
      return
    }
    holdTimer = Timer.scheduledTimer(withTimeInterval: Self.holdToTalk, repeats: false) {
      [weak self] _ in
      guard let self else {
        return
      }
      self.holdTimer = nil
      self.holding = true
      UIImpactFeedbackGenerator(style: .medium).impactOccurred()
      self.startDictation()
    }
  }

  @objc private func micUp() {
    let tapped = holdTimer != nil
    holdTimer?.invalidate()
    holdTimer = nil
    if holding || stopOnRelease {
      holding = false
      stopOnRelease = false
      if let jobId = pendingJob {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        send(.stop, jobId: jobId)
      }
      render()
      return
    }
    if tapped {
      startDictation()
      return
    }
    switch mode {
    case .noFullAccess:
      open(route: \.setupRoute, query: [])
    case .cold:
      // The app starts recording as it opens; the person comes back here
      // to stop it. The handoff in the App Group is what tells the app this
      // link came from here.
      let handoff = KeyboardHandoff(
        jobId: UUID().uuidString.lowercased(), language: language,
        sentAt: KeyboardDictationBridge.now())
      store?.write(handoff, KeyboardDictationBridge.handoffKey)
      open(
        route: \.dictateRoute,
        query: [
          URLQueryItem(name: "job", value: handoff.jobId),
          URLQueryItem(name: "language", value: handoff.language),
          URLQueryItem(name: "at", value: String(handoff.sentAt)),
        ])
    case .stalled:
      open(route: \.dictateRoute, query: [])
    case .ready, .starting, .recording, .transcribing:
      break
    }
    render()
  }

  private func startDictation() {
    let jobId = UUID().uuidString.lowercased()
    pendingJob = jobId
    pendingSince = KeyboardDictationBridge.now()
    send(.start, jobId: jobId)
    render()
  }

  @objc private func actionTapped() {
    guard let store else {
      return
    }
    if let jobId = pendingJob {
      send(.cancel, jobId: jobId)
      pendingJob = nil
      render()
      return
    }
    if let result = store.offeredResults(at: KeyboardDictationBridge.now()).first,
      let text = result.text
    {
      insert(text)
      markTaken(result.jobId, store: store)
    }
    render()
  }

  private func send(_ kind: KeyboardCommandKind, jobId: String) {
    guard let store else {
      return
    }
    let command = KeyboardCommand(
      id: UUID().uuidString.lowercased(), kind: kind, jobId: jobId, language: language,
      sentAt: KeyboardDictationBridge.now())
    store.write(
      Array((store.commands + [command]).suffix(KeyboardDictationBridge.keptCommands)),
      KeyboardDictationBridge.commandsKey)
    KeyboardDictationBridge.post(KeyboardDictationBridge.commandNotification(group: store.group))
  }

  /// Opens the app on one of its routes. A keyboard has no `openURL`; the
  /// application at the end of the responder chain opens it.
  private func open(route: KeyPath<Configuration, String>, query: [URLQueryItem]) {
    guard let configuration,
      var components = URLComponents(string: "\(configuration.scheme)://\(configuration[keyPath: route])")
    else {
      return
    }
    components.queryItems = query.isEmpty ? nil : query
    guard let url = components.url else {
      return
    }
    var responder: UIResponder? = self
    while let current = responder {
      if let application = current as? UIApplication {
        application.open(url, options: [:], completionHandler: nil)
        return
      }
      responder = current.next
    }
  }

  // MARK: - Typing

  /// Inserts dictated text at the cursor, a space before it when it would
  /// otherwise run into the word before.
  private func insert(_ text: String) {
    let before = textDocumentProxy.documentContextBeforeInput?.last
    let opensWord = text.first.map { !".,;:!?)]}…".contains($0) } ?? false
    let runsOn = before.map { !$0.isWhitespace && !"([{„“‚'\"".contains($0) } ?? false
    textDocumentProxy.insertText(runsOn && opensWord ? " \(text)" : text)
    keys.followCursor()
  }

  override func textDidChange(_ textInput: UITextInput?) {
    super.textDidChange(textInput)
    keys.followCursor()
  }

  /// A capital where the field asks for one: at its start, or after a
  /// sentence's end, a space and nothing else.
  private func wantsCapital() -> Bool {
    let proxy = textDocumentProxy
    switch proxy.autocapitalizationType ?? .sentences {
    case .none:
      return false
    case .allCharacters:
      return true
    case .words:
      return proxy.documentContextBeforeInput?.last.map(\.isWhitespace) ?? true
    case .sentences:
      let before = proxy.documentContextBeforeInput ?? ""
      let trimmed = before.trimmingCharacters(in: .whitespaces)
      if trimmed.isEmpty || before.hasSuffix("\n") {
        return true
      }
      return before.last == " " && ".!?".contains(trimmed.last ?? " ")
    @unknown default:
      return false
    }
  }

  @objc private func nextLanguage() {
    let languages = KeyboardDictationBridge.languages
    let next = ((languages.firstIndex(of: language) ?? 0) + 1) % languages.count
    language = languages[next]
    store?.write(language, KeyboardDictationBridge.languageKey)
    render()
  }

  /// A language by its own name; `auto` lets the transcription hear which.
  private func languageName(_ code: String) -> String {
    guard code != "auto" else {
      return strings.languageAuto
    }
    let own = Locale(identifier: code)
    return own.localizedString(forLanguageCode: code)?.capitalized(with: own) ?? code
  }

  // MARK: - Darwin notifications

  private func startObserving(group: String) {
    guard !observing else {
      return
    }
    observing = true
    CFNotificationCenterAddObserver(
      CFNotificationCenterGetDarwinNotifyCenter(),
      Unmanaged.passUnretained(self).toOpaque(),
      { _, observer, _, _, _ in
        guard let observer else {
          return
        }
        let keyboard = Unmanaged<KeyboardViewController>.fromOpaque(observer).takeUnretainedValue()
        DispatchQueue.main.async { keyboard.render() }
      },
      KeyboardDictationBridge.snapshotNotification(group: group) as CFString,
      nil, .deliverImmediately)
  }

  private func stopObserving() {
    guard observing else {
      return
    }
    observing = false
    CFNotificationCenterRemoveEveryObserver(
      CFNotificationCenterGetDarwinNotifyCenter(), Unmanaged.passUnretained(self).toOpaque())
  }

  deinit {
    CFNotificationCenterRemoveEveryObserver(
      CFNotificationCenterGetDarwinNotifyCenter(), Unmanaged.passUnretained(self).toOpaque())
  }

  // MARK: - Layout

  private static func readConfiguration() -> Configuration? {
    guard let info = Bundle.main.infoDictionary,
      let group = info["StellaAppGroup"] as? String,
      let scheme = info["StellaAppScheme"] as? String,
      let dictateRoute = info["StellaKeyboardDictateRoute"] as? String,
      let setupRoute = info["StellaKeyboardSetupRoute"] as? String
    else {
      return nil
    }
    return Configuration(
      group: group, scheme: scheme, dictateRoute: dictateRoute, setupRoute: setupRoute)
  }

  private static let functionKey = UIColor { traits in
    traits.userInterfaceStyle == .dark
      ? UIColor(white: 0.27, alpha: 1)
      : UIColor(red: 0.67, green: 0.69, blue: 0.73, alpha: 1)
  }


  private func layout() {
    statusLabel.font = .preferredFont(forTextStyle: .footnote)
    statusLabel.textColor = .secondaryLabel
    statusLabel.numberOfLines = 2
    statusLabel.adjustsFontSizeToFitWidth = true
    statusLabel.minimumScaleFactor = 0.8

    var action = UIButton.Configuration.tinted()
    action.cornerStyle = .capsule
    action.buttonSize = .small
    actionButton.configuration = action
    actionButton.isHidden = true
    actionButton.setContentHuggingPriority(.required, for: .horizontal)
    actionButton.setContentCompressionResistancePriority(.required, for: .horizontal)
    actionButton.addTarget(self, action: #selector(actionTapped), for: .touchUpInside)

    let top = UIStackView(arrangedSubviews: [statusLabel, actionButton])
    top.spacing = 8
    top.alignment = .center
    top.heightAnchor.constraint(greaterThanOrEqualToConstant: 34).isActive = true

    var mic = UIButton.Configuration.filled()
    mic.cornerStyle = .large
    micButton.configuration = mic
    micButton.addTarget(self, action: #selector(micDown), for: .touchDown)
    micButton.addTarget(self, action: #selector(micUp), for: [.touchUpInside, .touchUpOutside])
    micButton.addTarget(self, action: #selector(micUp), for: .touchCancel)
    micButton.heightAnchor.constraint(equalToConstant: 48).isActive = true
    spinner.translatesAutoresizingMaskIntoConstraints = false
    spinner.hidesWhenStopped = true
    spinner.color = .white
    micButton.addSubview(spinner)
    NSLayoutConstraint.activate([
      spinner.trailingAnchor.constraint(equalTo: micButton.trailingAnchor, constant: -16),
      spinner.centerYAnchor.constraint(equalTo: micButton.centerYAnchor),
    ])

    keys.nextKeyboardButton.addTarget(
      self, action: #selector(handleInputModeList(from:with:)), for: .allTouchEvents)
    keys.insert = { [weak self] text in
      self?.textDocumentProxy.insertText(text)
    }
    keys.deleteBackward = { [weak self] in
      self?.textDocumentProxy.deleteBackward()
    }
    keys.wantsCapital = { [weak self] in
      self?.wantsCapital() ?? false
    }

    var languageKey = UIButton.Configuration.filled()
    languageKey.baseBackgroundColor = Self.functionKey
    languageKey.baseForegroundColor = .label
    languageKey.cornerStyle = .medium
    languageButton.configuration = languageKey
    languageButton.accessibilityLabel = strings.language
    languageButton.addTarget(self, action: #selector(nextLanguage), for: .touchUpInside)
    languageButton.widthAnchor.constraint(equalToConstant: 52).isActive = true

    // The microphone stays the biggest key, right above the letters.
    let dictation = UIStackView(arrangedSubviews: [languageButton, micButton])
    dictation.spacing = 6

    let stack = UIStackView(arrangedSubviews: [top, dictation, keys])
    stack.axis = .vertical
    stack.spacing = 8
    stack.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(stack)
    let height = view.heightAnchor.constraint(equalToConstant: 310)
    height.priority = .defaultHigh
    NSLayoutConstraint.activate([
      height,
      stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 6),
      stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -6),
      stack.topAnchor.constraint(equalTo: view.topAnchor, constant: 6),
      stack.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -4),
    ])
  }
}
