import CryptoKit
import Foundation

struct DraftScope {
  static func rootKey(serverOrigin: String, userId: String) throws -> String {
    guard !userId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      var origin = URLComponents(string: serverOrigin),
      let scheme = origin.scheme?.lowercased(), scheme == "http" || scheme == "https",
      let host = origin.host?.lowercased(), !host.isEmpty,
      origin.user == nil, origin.password == nil,
      origin.query == nil, origin.fragment == nil,
      origin.path.isEmpty || origin.path == "/"
    else { throw CaptureFailure.invalid("Recording account context is invalid.") }
    origin.scheme = scheme
    origin.host = host
    origin.path = ""
    if (scheme == "https" && origin.port == 443) || (scheme == "http" && origin.port == 80) { origin.port = nil }
    guard let normalized = origin.string else {
      throw CaptureFailure.invalid("Recording server origin is invalid.")
    }
    let bytes = try JSONEncoder().encode([normalized, userId])
    return SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
  }
}
