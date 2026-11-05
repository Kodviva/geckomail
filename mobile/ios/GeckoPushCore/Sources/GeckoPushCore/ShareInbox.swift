import Foundation

private let maxNameBytes = 200

/// Yol ayıracı, denetim karakteri ve baştaki nokta atılır; sonuç tek dosya adıdır. Uzantı kısaltmada korunur
public func sanitizeFilename(_ name: String) -> String {
    let last = name.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? ""
    let clean = String(String.UnicodeScalarView(last.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }))
    var base = clean.trimmingCharacters(in: .whitespaces)
    while base.hasPrefix(".") { base.removeFirst() }
    base = base.trimmingCharacters(in: .whitespaces)
    if base.isEmpty { return "attachment" }
    if base.utf8.count <= maxNameBytes { return base }
    let ext = (base as NSString).pathExtension
    let suffix = ext.isEmpty || ext.utf8.count > 15 ? "" : "." + ext
    var stem = String(base.dropLast(suffix.count))
    while (stem + suffix).utf8.count > maxNameBytes { stem.removeLast() }
    return stem + suffix
}

public struct ShareFile {
    public let name: String
    public let url: URL
    public let mime: String?
}

public struct Share {
    public let id: String
    public let files: [ShareFile]
    public let text: String?
    public let skipped: Int
}

private struct Meta: Codable {
    struct Entry: Codable {
        let name: String
        let mime: String?
        let file: String
    }
    let files: [Entry]
    let text: String?
    let skipped: Int
    let at: Int64
}

/// Paylaşım eklentisi ile uygulama arasında App Group kutusu. Disktedir (süreç ölebilir), 24 saatte silinir. Dosya adları sıra numarasıdır:
/// /_capacitor_file_ yoluna kullanıcı adı girmez. meta.json en son yazılır, varlığı paylaşımın bittiğini söyler.
public final class ShareInbox {
    public static let appGroup = "group.com.kodviva.geckomail"
    public static let maxBytes: UInt64 = 25_000_000
    public static let maxFiles = 10
    public static let dayMs: Int64 = 86_400_000
    private static let metaName = "meta.json"
    private static let takenName = "taken"

    private let root: URL
    private let now: () -> Int64
    private let fm = FileManager.default

    public init(root: URL, now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.root = root
        self.now = now
    }

    /// nil: App Group yetkisi yok
    public static func shared() -> ShareInbox? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup).map { ShareInbox(root: $0.appendingPathComponent("shares")) }
    }

    public func begin() -> ShareWriter {
        let dir = root.appendingPathComponent(UUID().uuidString)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        return ShareWriter(dir: dir, now: now())
    }

    private func dirs() -> [URL] {
        ((try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []).filter { fm.fileExists(atPath: $0.appendingPathComponent(Self.metaName).path) }
    }

    private func taken(_ dir: URL) -> Bool { fm.fileExists(atPath: dir.appendingPathComponent(Self.takenName).path) }

    private func meta(_ dir: URL) -> Meta? {
        (try? Data(contentsOf: dir.appendingPathComponent(Self.metaName))).flatMap { try? JSONDecoder().decode(Meta.self, from: $0) }
    }

    /// Her paylaşım bir kez verilir; dosyalar finish ya da 24 saat dolana dek durur
    public func take() -> [Share] {
        dirs().filter { !taken($0) }.compactMap { dir in
            guard let m = meta(dir) else { return nil }
            fm.createFile(atPath: dir.appendingPathComponent(Self.takenName).path, contents: nil)
            let files = m.files.map { ShareFile(name: $0.name, url: dir.appendingPathComponent($0.file), mime: $0.mime) }
            return Share(id: dir.lastPathComponent, files: files, text: m.text, skipped: m.skipped)
        }
    }

    public func hasPending() -> Bool { dirs().contains { !taken($0) } }

    public func finish() {
        dirs().filter(taken).forEach { try? fm.removeItem(at: $0) }
    }

    public func sweep() {
        for dir in (try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? [] {
            // meta'sız dizin yarım kalmış kopyadır
            guard let m = meta(dir) else {
                try? fm.removeItem(at: dir)
                continue
            }
            if now() - m.at >= Self.dayMs { try? fm.removeItem(at: dir) }
        }
    }

    public func clear() {
        try? fm.removeItem(at: root)
    }
}

/// Eklentide sağlayıcı geri çağrıları eşzamanlı gelir: yazıcı kendi kilidini tutar
public final class ShareWriter {
    private let dir: URL
    private let at: Int64
    private let lock = NSLock()
    private var entries: [Meta.Entry] = []
    private var skipped = 0
    private let fm = FileManager.default

    fileprivate init(dir: URL, now: Int64) {
        self.dir = dir
        self.at = now
    }

    public func add(file: URL, name: String?, mime: String?) {
        lock.lock()
        defer { lock.unlock() }
        let size = (try? fm.attributesOfItem(atPath: file.path)[.size] as? NSNumber)?.uint64Value ?? .max
        let index = String(entries.count)
        guard entries.count < ShareInbox.maxFiles, size <= ShareInbox.maxBytes,
              (try? fm.copyItem(at: file, to: dir.appendingPathComponent(index))) != nil else {
            skipped += 1
            return
        }
        entries.append(.init(name: sanitizeFilename(name ?? ""), mime: mime, file: index))
    }

    public func addFailed() {
        lock.lock()
        skipped += 1
        lock.unlock()
    }

    /// false: paylaşılacak bir şey kalmadı, dizin silindi
    public func finish(text: String?) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        let note = text.map { String($0.prefix(100_000)) }.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
        guard !entries.isEmpty || note != nil, let data = try? JSONEncoder().encode(Meta(files: entries, text: note, skipped: skipped, at: at)),
              (try? data.write(to: dir.appendingPathComponent("meta.json"), options: .atomic)) != nil else {
            try? fm.removeItem(at: dir)
            return false
        }
        return true
    }
}
