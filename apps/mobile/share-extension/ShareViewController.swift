import UIKit
import UniformTypeIdentifiers

/// The share sheet's way into stella. It reads nothing it is handed: each
/// file is copied into a folder of its own in the App Group's share inbox,
/// links and text are listed beside the files in the folder's manifest, and
/// the app is opened on the share, which it imports and then deletes. Signing
/// in, matters and uploads stay in the app; the extension holds no session.
///
/// A share's folder is named `<milliseconds since 1970>-<UUID>`, so a share
/// abandoned before the app took it is deleted by age, by the next share or
/// by the app, without reading file dates. Nothing here logs a file's name or
/// contents.
final class ShareViewController: UIViewController {
  /// The most items one share takes, as the activation rule offers.
  private static let maxItems = 10
  /// A share the app has not taken within this long is deleted.
  private static let staleAfterMilliseconds: Int64 = 60 * 60 * 1000
  /// Written last, so the app never reads a share still being copied.
  private static let manifestName = "manifest.json"

  /// One shared item, as the manifest lists it; the app reads the same shape.
  private struct Item: Encodable {
    let type: String
    var file: String? = nil
    var name: String? = nil
    var mimeType: String? = nil
    var url: String? = nil
    var text: String? = nil
  }

  private struct Manifest: Encodable {
    let items: [Item]
  }

  private struct Configuration {
    let inbox: URL
    let scheme: String
    let route: String
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .clear
    let spinner = UIActivityIndicatorView(style: .large)
    spinner.translatesAutoresizingMaskIntoConstraints = false
    spinner.startAnimating()
    view.addSubview(spinner)
    NSLayoutConstraint.activate([
      spinner.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      spinner.centerYAnchor.constraint(equalTo: view.centerYAnchor),
    ])
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    Task { @MainActor in
      finish(opening: await handOver())
    }
  }

  /// Copies the share into the inbox; the link that opens it in the app, or
  /// nil when there was nothing to hand over or it could not be written.
  private func handOver() async -> URL? {
    guard let configuration = Self.configuration() else {
      return nil
    }
    let now = Int64(Date().timeIntervalSince1970 * 1000)
    Self.removeStaleShares(in: configuration.inbox, now: now)
    let shareId = "\(now)-\(UUID().uuidString.lowercased())"
    let folder = configuration.inbox.appendingPathComponent(shareId, isDirectory: true)
    do {
      // Readable only while the phone is unlocked, as the app reads it.
      try FileManager.default.createDirectory(
        at: folder, withIntermediateDirectories: true,
        attributes: [.protectionKey: FileProtectionType.complete])
      let items = await collect(into: folder)
      guard !items.isEmpty else {
        try FileManager.default.removeItem(at: folder)
        return nil
      }
      try JSONEncoder().encode(Manifest(items: items)).write(
        to: folder.appendingPathComponent(Self.manifestName),
        options: [.atomic, .completeFileProtection])
    } catch {
      try? FileManager.default.removeItem(at: folder)
      return nil
    }
    return URL(string: "\(configuration.scheme)://\(configuration.route)/\(shareId)")
  }

  /// The App Group, inbox and link the app config set for this build.
  private static func configuration() -> Configuration? {
    guard let info = Bundle.main.infoDictionary,
      let group = info["StellaAppGroup"] as? String,
      let inbox = info["StellaShareInbox"] as? String,
      let scheme = info["StellaAppScheme"] as? String,
      let route = info["StellaShareRoute"] as? String,
      let container = FileManager.default.containerURL(
        forSecurityApplicationGroupIdentifier: group)
    else {
      return nil
    }
    return Configuration(
      inbox: container.appendingPathComponent(inbox, isDirectory: true),
      scheme: scheme, route: route)
  }

  private func collect(into folder: URL) async -> [Item] {
    let providers = (extensionContext?.inputItems ?? [])
      .compactMap { $0 as? NSExtensionItem }
      .flatMap { $0.attachments ?? [] }
    var items: [Item] = []
    for provider in providers.prefix(Self.maxItems) {
      if let item = await Self.load(provider, index: items.count, into: folder) {
        items.append(item)
      }
    }
    return items
  }

  /// A file is copied as it is, under its index; a web address is kept as a
  /// link and text as text. A file's own type wins over a link or text it
  /// also offers, so a PDF open in Safari arrives as the PDF.
  private static func load(_ provider: NSItemProvider, index: Int, into folder: URL) async
    -> Item?
  {
    let types = provider.registeredTypeIdentifiers.compactMap { UTType($0) }
    if let fileType = types.first(where: {
      $0.conforms(to: .data) && !$0.conforms(to: .text) && !$0.conforms(to: .url)
    }) {
      return await copyFile(provider, type: fileType, index: index, into: folder)
    }
    if types.contains(where: { $0.conforms(to: .url) }) {
      switch await loadItem(provider, type: .url) {
      case let url as URL where url.isFileURL:
        return copy(url, name: provider.suggestedName, type: nil, index: index, into: folder)
      case let url as URL where ["http", "https"].contains(url.scheme?.lowercased()):
        return Item(type: "link", url: url.absoluteString)
      default:
        return nil
      }
    }
    if types.contains(where: { $0.conforms(to: .plainText) }) {
      switch await loadItem(provider, type: .plainText) {
      case let text as String where !text.isEmpty:
        return Item(type: "text", text: text)
      case let url as URL where url.isFileURL:
        return copy(url, name: provider.suggestedName, type: .plainText, index: index, into: folder)
      case let data as Data:
        return String(data: data, encoding: .utf8).map { Item(type: "text", text: $0) }
      default:
        return nil
      }
    }
    if let fileType = types.first(where: { $0.conforms(to: .data) }) {
      return await copyFile(provider, type: fileType, index: index, into: folder)
    }
    return nil
  }

  private static func loadItem(_ provider: NSItemProvider, type: UTType) async -> NSSecureCoding? {
    await withCheckedContinuation { continuation in
      provider.loadItem(forTypeIdentifier: type.identifier, options: nil) { item, _ in
        continuation.resume(returning: item)
      }
    }
  }

  /// The provider's file lives only while its handler runs, so it is copied there.
  private static func copyFile(
    _ provider: NSItemProvider, type: UTType, index: Int, into folder: URL
  ) async -> Item? {
    let name = provider.suggestedName
    return await withCheckedContinuation { continuation in
      provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, _ in
        continuation.resume(
          returning: url.flatMap {
            copy($0, name: name, type: type, index: index, into: folder)
          })
      }
    }
  }

  /// Copies `source` into the share as `<index>.<extension>`: the name the
  /// person sees is kept only in the manifest, never in a path.
  private static func copy(_ source: URL, name: String?, type: UTType?, index: Int, into folder: URL)
    -> Item?
  {
    let fileType = type ?? UTType(filenameExtension: source.pathExtension)
    let given = (name?.isEmpty == false ? name : nil) ?? source.lastPathComponent
    let givenExtension = URL(fileURLWithPath: given).pathExtension
    let pathExtension =
      givenExtension.isEmpty ? (fileType?.preferredFilenameExtension ?? "") : givenExtension
    let displayName =
      givenExtension.isEmpty && !pathExtension.isEmpty ? "\(given).\(pathExtension)" : given
    let safeExtension = String(
      pathExtension.lowercased().unicodeScalars
        .filter { CharacterSet.alphanumerics.contains($0) && $0.isASCII }
        .prefix(10))
    let file = safeExtension.isEmpty ? "\(index)" : "\(index).\(safeExtension)"
    let destination = folder.appendingPathComponent(file)
    do {
      try FileManager.default.copyItem(at: source, to: destination)
      try FileManager.default.setAttributes(
        [.protectionKey: FileProtectionType.complete], ofItemAtPath: destination.path)
    } catch {
      return nil
    }
    return Item(
      type: "file", file: file, name: displayName,
      mimeType: fileType?.preferredMIMEType ?? "application/octet-stream")
  }

  /// Deletes every share older than an hour, and anything in the inbox not
  /// named as a share.
  private static func removeStaleShares(in inbox: URL, now: Int64) {
    guard
      let names = try? FileManager.default.contentsOfDirectory(atPath: inbox.path)
    else {
      return
    }
    for name in names {
      let created = name.split(separator: "-", maxSplits: 1).first.flatMap { Int64($0) }
      if let created, now - created < staleAfterMilliseconds {
        continue
      }
      try? FileManager.default.removeItem(at: inbox.appendingPathComponent(name))
    }
  }

  /// Opens the app on the share, then closes the sheet. A share extension has
  /// no `openURL` of its own; the application is reached through the
  /// responder chain. Without a link, the sheet only closes.
  private func finish(opening url: URL?) {
    if let url {
      var responder: UIResponder? = self
      while let current = responder {
        if let application = current as? UIApplication {
          application.open(url, options: [:], completionHandler: nil)
          break
        }
        responder = current.next
      }
    }
    extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
  }
}
