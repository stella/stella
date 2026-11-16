import Foundation
import Security

/// Where the Lock Screen buttons send their request, and the key they send
/// it with: the server's address, this sign-in's phone id, and the key the
/// server issued for it.
struct TimerActionsConfiguration: Codable {
  let serverUrl: String
  let deviceId: String
  let key: String
}

/// The configuration, kept in the keychain like the session: readable once
/// the phone has been unlocked after boot, never restored onto another
/// device, and removed at sign-out.
enum TimerActionsStore {
  private static let service = "app.stll.timer-actions"
  private static let account = "configuration"

  private static var query: [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
  }

  static func save(_ configuration: TimerActionsConfiguration) -> Bool {
    guard let data = try? JSONEncoder().encode(configuration) else {
      return false
    }
    SecItemDelete(query as CFDictionary)
    var item = query
    item[kSecValueData as String] = data
    item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
  }

  static func load() -> TimerActionsConfiguration? {
    var lookup = query
    lookup[kSecReturnData as String] = true
    lookup[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: AnyObject?
    guard SecItemCopyMatching(lookup as CFDictionary, &result) == errSecSuccess,
          let data = result as? Data
    else {
      return nil
    }
    return try? JSONDecoder().decode(TimerActionsConfiguration.self, from: data)
  }

  static func clear() {
    SecItemDelete(query as CFDictionary)
  }
}
