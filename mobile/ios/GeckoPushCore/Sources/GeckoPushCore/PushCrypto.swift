import CryptoKit
import Foundation

public enum PushCryptoError: Error {
    case malformed
    case padding
}

public extension Data {
    init?(base64URL s: String) {
        var b = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        b += String(repeating: "=", count: (4 - b.count % 4) % 4)
        self.init(base64Encoded: b)
    }

    var base64URL: String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}

private let saltBytes = 16
private let headerBytes = saltBytes + 4 + 1
private let publicKeyBytes = 65
private let tagBytes = 16

/// RFC 8291 aes128gcm. Gönderen tek kayıt üretir (Parça 3 encryptPayload): çok kayıtlı gövde reddedilir
public enum PushCrypto {
    public static func decrypt(_ body: Data, privateKey: P256.KeyAgreement.PrivateKey, auth: Data) throws -> Data {
        let b = Data(body) // dilimlerde indis sıfırdan başlamaz
        guard b.count > headerBytes + publicKeyBytes + tagBytes else { throw PushCryptoError.malformed }
        let salt = b.prefix(saltBytes)
        let rs = b[saltBytes..<saltBytes + 4].reduce(0) { $0 << 8 | Int($1) }
        guard Int(b[saltBytes + 4]) == publicKeyBytes else { throw PushCryptoError.malformed }
        let serverKey = b[headerBytes..<headerBytes + publicKeyBytes]
        let record = b[(headerBytes + publicKeyBytes)...]
        guard record.count <= rs else { throw PushCryptoError.malformed }

        let server = try P256.KeyAgreement.PublicKey(x963Representation: serverKey)
        let shared = try privateKey.sharedSecretFromKeyAgreement(with: server)
        let keyInfo = Data("WebPush: info\0".utf8) + privateKey.publicKey.x963Representation + serverKey
        let ikm = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: auth, sharedInfo: keyInfo, outputByteCount: 32)
        func derive(_ info: String, _ n: Int) -> SymmetricKey {
            HKDF<SHA256>.deriveKey(inputKeyMaterial: ikm, salt: salt, info: Data(info.utf8), outputByteCount: n)
        }
        let cek = derive("Content-Encoding: aes128gcm\0", 16)
        let nonce = derive("Content-Encoding: nonce\0", 12).withUnsafeBytes { Data($0) }
        let sealed = try AES.GCM.SealedBox(combined: nonce + record)
        return try stripPadding(AES.GCM.open(sealed, using: cek))
    }

    /// Sondaki sıfırlar atılır, ayraç son kayıtta 0x02'dir
    static func stripPadding(_ plain: Data) throws -> Data {
        guard let end = plain.lastIndex(where: { $0 != 0 }), plain[end] == 2 else { throw PushCryptoError.padding }
        return plain[plain.startIndex..<end]
    }
}
