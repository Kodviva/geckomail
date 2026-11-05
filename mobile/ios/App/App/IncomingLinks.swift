import Foundation

struct NativeOpenRequest: Equatable {
    let messageId: Int
    let reply: Bool
}

private let maxSafeId = 9_007_199_254_740_991 // Number.MAX_SAFE_INTEGER: JS tarafı üstünü reddeder

/// Yalnız geckomail://open?m=<id> ve ?reply=<id>. Sunucu, kullanıcı, yönlendirme alanı yoktur; başka hiçbir biçim kabul edilmez (T10)
func parseDeepLink(_ url: URL) -> NativeOpenRequest? {
    guard let u = URLComponents(url: url, resolvingAgainstBaseURL: false), u.scheme == "geckomail", u.host == "open", u.user == nil, u.password == nil,
          u.port == nil, u.percentEncodedPath.isEmpty, u.percentEncodedFragment == nil, let query = u.percentEncodedQuery else { return nil }
    let pair = query.split(separator: "=", omittingEmptySubsequences: false)
    guard pair.count == 2, pair[0] == "m" || pair[0] == "reply" else { return nil }
    let value = pair[1]
    guard (1...16).contains(value.count), value.first != "0", value.utf8.allSatisfy({ (48...57).contains($0) }),
          let id = Int(value), id <= maxSafeId else { return nil }
    return NativeOpenRequest(messageId: id, reply: pair[0] == "reply")
}
