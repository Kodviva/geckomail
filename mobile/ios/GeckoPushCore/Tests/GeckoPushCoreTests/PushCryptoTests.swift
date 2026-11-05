import CryptoKit
import Foundation
import XCTest
@testable import GeckoPushCore

struct Vector: Decodable {
    let name: String
    let plaintext: String
    let uaPrivate: String
    let auth: String
    let body: String
}

func vectors() throws -> [Vector] {
    struct File: Decodable { let vectors: [Vector] }
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("../../../../testdata/push-vectors.json").standardized
    return try JSONDecoder().decode(File.self, from: Data(contentsOf: url)).vectors
}

func b64u(_ s: String) -> Data { Data(base64URL: s)! }

final class PushCryptoTests: XCTestCase {
    private func key(_ v: Vector) throws -> P256.KeyAgreement.PrivateKey {
        try P256.KeyAgreement.PrivateKey(rawRepresentation: b64u(v.uaPrivate))
    }

    func testRfc8291AppendixVector() throws {
        let v = try XCTUnwrap(vectors().first { $0.name == "rfc8291-appendix-a" })
        XCTAssertEqual(try PushCrypto.decrypt(b64u(v.body), privateKey: key(v), auth: b64u(v.auth)), b64u(v.plaintext))
        XCTAssertEqual(String(data: b64u(v.plaintext), encoding: .utf8), "When I grow up, I want to be a watermelon")
    }

    func testNativeVectorsDecrypt() throws {
        let all = try vectors()
        XCTAssertEqual(all.count, 3)
        for v in all {
            XCTAssertEqual(try PushCrypto.decrypt(b64u(v.body), privateKey: key(v), auth: b64u(v.auth)), b64u(v.plaintext), v.name)
        }
    }

    func testWrongKeyThrows() throws {
        let v = try vectors()[0]
        XCTAssertThrowsError(try PushCrypto.decrypt(b64u(v.body), privateKey: .init(), auth: b64u(v.auth)))
    }

    func testWrongAuthThrows() throws {
        let v = try vectors()[0]
        XCTAssertThrowsError(try PushCrypto.decrypt(b64u(v.body), privateKey: key(v), auth: Data(repeating: 1, count: 16)))
    }

    func testTruncatedBodyThrows() throws {
        let v = try vectors()[0]
        let body = b64u(v.body)
        for n in [0, 10, 20, 86, 90, body.count - 1] {
            XCTAssertThrowsError(try PushCrypto.decrypt(body.prefix(n), privateKey: key(v), auth: b64u(v.auth)), "\(n)")
        }
    }

    func testBitFlipThrows() throws {
        let v = try vectors()[0]
        var body = b64u(v.body)
        body[body.count - 1] ^= 1
        XCTAssertThrowsError(try PushCrypto.decrypt(body, privateKey: key(v), auth: b64u(v.auth)))
    }

    func testPaddingStripped() throws {
        XCTAssertEqual(try PushCrypto.stripPadding(Data([0x41, 0x42, 0x02, 0, 0, 0])), Data([0x41, 0x42]))
        XCTAssertEqual(try PushCrypto.stripPadding(Data([0x41, 0x02])), Data([0x41]))
        XCTAssertThrowsError(try PushCrypto.stripPadding(Data([0x41, 0x01, 0])))
        XCTAssertThrowsError(try PushCrypto.stripPadding(Data([0, 0])))
    }

    func testKeyIdLengthChecked() throws {
        let v = try vectors()[0]
        var body = b64u(v.body)
        body[20] = 10
        XCTAssertThrowsError(try PushCrypto.decrypt(body, privateKey: key(v), auth: b64u(v.auth)))
    }
}

final class PushKeysTests: XCTestCase {
    private final class Memory: PushKeyStorage {
        var value: Data?
        func read() -> Data? { value }
        func write(_ d: Data) -> Bool { value = d; return true }
        func remove() { value = nil }
    }

    func testLoadOrCreateIsStable() throws {
        let m = Memory()
        PushKeys.storage = m
        XCTAssertNil(PushKeys.load())
        let a = try PushKeys.loadOrCreate()
        let b = try PushKeys.loadOrCreate()
        XCTAssertEqual(a.p256dh, b.p256dh)
        XCTAssertEqual(a.auth, b.auth)
        XCTAssertEqual(Data(base64URL: a.p256dh)?.count, 65)
        XCTAssertEqual(Data(base64URL: a.auth)?.count, 16)
        PushKeys.delete()
        XCTAssertNil(m.value)
        XCTAssertNotEqual(try PushKeys.loadOrCreate().p256dh, a.p256dh)
    }

    func testCorruptStorageIsNotUsed() {
        let m = Memory()
        m.value = Data(repeating: 0, count: 3)
        PushKeys.storage = m
        XCTAssertNil(PushKeys.load())
    }
}
