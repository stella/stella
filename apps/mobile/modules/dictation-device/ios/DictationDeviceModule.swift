import AVFoundation
import ExpoModulesCore
import Network

/// What a dictation asks of the phone beyond the recorder
/// (`src/native/dictation-device.ts`): which microphone it records from,
/// how it shares the audio session with other apps, when the system takes
/// the microphone away, where a dictation not yet transcribed waits, and
/// when the phone is online again to transcribe it.
public class DictationDeviceModule: Module {
  /// Whether a dictation holds the iPhone's own microphone, so a headset
  /// or car that connects meanwhile does not take the input.
  private var holdsBuiltInMicrophone = false
  private var observers: [NSObjectProtocol] = []
  private var network: NWPathMonitor?
  private var online: Bool?

  public func definition() -> ModuleDefinition {
    Name("DictationDevice")

    Events("onInterruption", "onInputLost", "onNetworkChange")

    OnCreate {
      self.observe()
    }

    OnDestroy {
      self.observers.forEach(NotificationCenter.default.removeObserver)
      self.observers.removeAll()
      self.network?.cancel()
      self.network = nil
    }

    OnStartObserving("onNetworkChange") {
      self.watchNetwork()
    }

    OnStopObserving("onNetworkChange") {
      self.network?.cancel()
      self.network = nil
      self.online = nil
    }

    // A folder of the app's own, left out of backups, whose files can be
    // read once the phone has been unlocked after it started, so a retry
    // with the screen locked still reads them.
    Function("keptFolder") { () -> String in
      let folder = try FileManager.default
        .url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        .appendingPathComponent("dictation-kept", isDirectory: true)
      try FileManager.default.createDirectory(
        at: folder, withIntermediateDirectories: true,
        attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      var excluded = folder
      try excluded.setResourceValues(values)
      return folder.absoluteString
    }

    // Called after the recorder prepares, since preparing resets the
    // session's options to the recorder's own.
    Function("routeForDictation") { (builtInMicrophone: Bool) in
      try self.route(builtInMicrophone: builtInMicrophone)
    }

    Function("releaseRoute") {
      self.holdsBuiltInMicrophone = false
      try? AVAudioSession.sharedInstance().setPreferredInput(nil)
    }
  }

  /// Records alongside other apps' audio: music and navigation keep playing
  /// and are neither paused nor ducked. Bluetooth headphones and cars stay
  /// on A2DP for what they play; with `builtInMicrophone` they are never the
  /// input, so they do not drop into call audio (HFP). The session's sample
  /// rate is left as it is: the recorder converts to what the file needs,
  /// and a forced rate would change other apps' audio.
  private func route(builtInMicrophone: Bool) throws {
    let session = AVAudioSession.sharedInstance()
    var options: AVAudioSession.CategoryOptions = [
      .mixWithOthers, .defaultToSpeaker, .allowBluetoothA2DP,
    ]
    if !builtInMicrophone {
      #if compiler(>=6.2)
        options.insert(.allowBluetoothHFP)
      #else
        options.insert(.allowBluetooth)
      #endif
    }
    try session.setCategory(.playAndRecord, mode: .default, options: options)
    holdsBuiltInMicrophone = builtInMicrophone
    if builtInMicrophone {
      preferBuiltInMicrophone(session)
    } else {
      try? session.setPreferredInput(nil)
    }
  }

  private func preferBuiltInMicrophone(_ session: AVAudioSession) {
    guard
      session.currentRoute.inputs.first?.portType != .builtInMic,
      let builtIn = session.availableInputs?.first(where: { $0.portType == .builtInMic })
    else { return }
    try? session.setPreferredInput(builtIn)
  }

  /// Reports each change between online and offline, as the path monitor
  /// sees it, starting with the current state.
  private func watchNetwork() {
    guard network == nil else { return }
    let monitor = NWPathMonitor()
    monitor.pathUpdateHandler = { [weak self] path in
      DispatchQueue.main.async {
        guard let self else { return }
        let online = path.status == .satisfied
        guard self.online != online else { return }
        self.online = online
        self.sendEvent("onNetworkChange", ["online": online])
      }
    }
    monitor.start(queue: DispatchQueue.global(qos: .utility))
    network = monitor
  }

  private func observe() {
    let center = NotificationCenter.default
    let session = AVAudioSession.sharedInstance()
    observers.append(
      center.addObserver(
        forName: AVAudioSession.interruptionNotification, object: session, queue: .main
      ) { [weak self] notification in
        guard
          let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
          let type = AVAudioSession.InterruptionType(rawValue: raw)
        else { return }
        switch type {
        case .began:
          self?.sendEvent("onInterruption", ["phase": "began"])
        case .ended:
          self?.sendEvent("onInterruption", ["phase": "ended"])
        @unknown default:
          break
        }
      })
    observers.append(
      center.addObserver(
        forName: AVAudioSession.routeChangeNotification, object: session, queue: .main
      ) { [weak self] notification in
        guard
          let self,
          let raw = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
          let reason = AVAudioSession.RouteChangeReason(rawValue: raw)
        else { return }
        if reason == .oldDeviceUnavailable,
          let previous = notification.userInfo?[AVAudioSessionRouteChangePreviousRouteKey]
            as? AVAudioSessionRouteDescription,
          Self.lostInput(previous: previous, current: session.currentRoute)
        {
          self.sendEvent("onInputLost", [:])
        }
        if self.holdsBuiltInMicrophone {
          self.preferBuiltInMicrophone(session)
        }
      })
    observers.append(
      center.addObserver(
        forName: AVAudioSession.mediaServicesWereResetNotification, object: session,
        queue: .main
      ) { [weak self] _ in
        // The session forgets its configuration; the recorder's next piece
        // routes again once it has prepared.
        self?.holdsBuiltInMicrophone = false
      })
  }

  /// Whether the microphone a dictation recorded from went away, as AirPods
  /// put back in their case: not merely the headphones it played to.
  private static func lostInput(
    previous: AVAudioSessionRouteDescription, current: AVAudioSessionRouteDescription
  ) -> Bool {
    guard let input = previous.inputs.first else { return false }
    return !current.inputs.contains(where: { $0.uid == input.uid })
  }
}
