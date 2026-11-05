import GeckoPushCore
import QuickLook
import UIKit

/// İndirilen ekler: açılışta ve her dönüşte 24 saati geçenler, çıkışta hepsi silinir. Dizin adındaki zaman yaşı verir, dosya tarihi okunmaz
final class AttachmentCache {
    private let root: URL
    private let now: () -> Int64
    private let fm = FileManager.default

    init(root: URL, now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.root = root
        self.now = now
    }

    func newFile(name: String) -> URL {
        let dir = root.appendingPathComponent("\(now())-\(UUID().uuidString)")
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent(sanitizeFilename(name))
    }

    func purge() {
        for dir in (try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? [] {
            let at = dir.lastPathComponent.split(separator: "-").first.flatMap { Int64($0) } ?? 0
            if now() - at >= ShareInbox.dayMs { try? fm.removeItem(at: dir) }
        }
    }

    func clear() {
        try? fm.removeItem(at: root)
    }
}

/// QuickLook kendi paylaş düğmesini taşır; önizlenemeyen tür doğrudan paylaşım sayfasına gider
final class AttachmentPreview: NSObject, QLPreviewControllerDataSource, QLPreviewControllerDelegate {
    private static var current: AttachmentPreview? // sunum sürerken QuickLook kaynağı zayıf tutar

    private let url: URL

    private init(url: URL) {
        self.url = url
    }

    static func present(_ url: URL, from vc: UIViewController) {
        guard QLPreviewController.canPreview(url as QLPreviewItem) else { return share(url, from: vc) { _ in } }
        let p = AttachmentPreview(url: url)
        current = p
        let ql = QLPreviewController()
        ql.dataSource = p
        ql.delegate = p
        vc.present(ql, animated: true)
    }

    static func share(_ url: URL, from vc: UIViewController, done: @escaping (Bool) -> Void) {
        let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        sheet.completionWithItemsHandler = { _, completed, _, _ in done(completed) }
        sheet.popoverPresentationController?.sourceView = vc.view // iPad
        sheet.popoverPresentationController?.sourceRect = CGRect(x: vc.view.bounds.midX, y: vc.view.bounds.midY, width: 0, height: 0)
        vc.present(sheet, animated: true)
    }

    func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
    func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { url as QLPreviewItem }
    func previewControllerDidDismiss(_ controller: QLPreviewController) { Self.current = nil }
}
