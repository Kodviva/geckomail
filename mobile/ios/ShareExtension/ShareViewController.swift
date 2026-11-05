import GeckoPushCore
import UIKit
import UniformTypeIdentifiers

/// Paylaşılanı App Group kapsayıcısına yazar, uygulamayı açmasını söyler. Eklenti API'si uygulama açmaya izin vermez: uygulama
/// etkinleşince kutuyu görür (SceneDelegate). Ağ ve oturum yok: yükleme uygulamada, giriş ve kilit sonrası yapılır.
class ShareViewController: UIViewController {
    private static let noteSeconds = 1.6
    private var started = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !started else { return }
        started = true
        collect()
    }

    private func collect() {
        guard let inbox = ShareInbox.shared() else { return end() }
        let writer = inbox.begin()
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
        let group = DispatchGroup()
        let lock = NSLock()
        var notes: [String] = []
        func note(_ s: String) {
            lock.lock()
            notes.append(s)
            lock.unlock()
        }
        for p in providers {
            group.enter()
            if p.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) || !isTextOnly(p) {
                let type = p.registeredTypeIdentifiers.first { UTType($0)?.conforms(to: .data) == true } ?? UTType.data.identifier
                p.loadFileRepresentation(forTypeIdentifier: type) { url, _ in
                    defer { group.leave() }
                    guard let url else { return writer.addFailed() }
                    writer.add(file: url, name: p.suggestedName.map { Self.named($0, like: url) } ?? url.lastPathComponent, mime: UTType(type)?.preferredMIMEType)
                }
            } else if p.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                _ = p.loadObject(ofClass: URL.self) { url, _ in
                    if let url { note(url.absoluteString) }
                    group.leave()
                }
            } else {
                _ = p.loadObject(ofClass: String.self) { text, _ in
                    if let text { note(text) }
                    group.leave()
                }
            }
        }
        group.notify(queue: .main) { [self] in
            let saved = writer.finish(text: notes.isEmpty ? nil : notes.joined(separator: "\n"))
            if saved { tellToOpenApp() } else { end() }
        }
    }

    private func isTextOnly(_ p: NSItemProvider) -> Bool {
        p.hasItemConformingToTypeIdentifier(UTType.url.identifier) || p.hasItemConformingToTypeIdentifier(UTType.plainText.identifier)
    }

    /// suggestedName uzantısız gelebilir
    private static func named(_ name: String, like url: URL) -> String {
        (name as NSString).pathExtension.isEmpty && !url.pathExtension.isEmpty ? "\(name).\(url.pathExtension)" : name
    }

    private func tellToOpenApp() {
        let note = UIAlertController(title: nil, message: NSLocalizedString("mobile.share.openApp", comment: ""), preferredStyle: .alert)
        present(note, animated: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.noteSeconds) { [self] in
            note.dismiss(animated: true) { [self] in end() }
        }
    }

    private func end() {
        extensionContext?.completeRequest(returningItems: nil)
    }
}
