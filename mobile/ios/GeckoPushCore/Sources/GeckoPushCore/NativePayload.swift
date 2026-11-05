import Foundation

/// src/shared/nativePush.ts NativePayload ile aynı. `level: silent` üretilmez
public struct NativePayload: Codable {
    public let v: Int
    public let title: String
    public let body: String
    public let accountId: Int?
    public let messageId: Int?
    public let level: String
    public let tag: String
    public let count: Int
    public let ts: Int64
    public let actions: [String]
}
