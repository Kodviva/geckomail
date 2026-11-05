import Foundation
import XCTest
@testable import GeckoPushCore

final class ShareInboxTests: XCTestCase {
    private var root: URL!
    private var source: URL!
    private var now: Int64 = 1_000

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        source = root.appendingPathComponent("kaynak.bin")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try Data(count: 10).write(to: source)
        root = root.appendingPathComponent("gelen")
    }

    private func inbox() -> ShareInbox { ShareInbox(root: root, now: { [unowned self] in self.now }) }

    private func accept(_ names: [String], text: String? = nil) {
        let w = inbox().begin()
        names.forEach { w.add(file: source, name: $0, mime: "application/pdf") }
        XCTAssertTrue(w.finish(text: text))
    }

    func testShareWaitsForLogin() throws {
        accept(["a.pdf"], text: "not")
        let again = inbox() // süreç yeniden başladı
        let s = try XCTUnwrap(again.take().first)
        XCTAssertEqual(s.files.map(\.name), ["a.pdf"])
        XCTAssertEqual(s.text, "not")
        XCTAssertTrue(FileManager.default.fileExists(atPath: s.files[0].url.path))
        XCTAssertTrue(again.take().isEmpty)
    }

    func testOversizedShareWarns() throws {
        let big = root.deletingLastPathComponent().appendingPathComponent("buyuk.bin")
        FileManager.default.createFile(atPath: big.path, contents: nil)
        let h = try FileHandle(forWritingTo: big)
        try h.truncate(atOffset: ShareInbox.maxBytes + 1)
        try h.close()
        let w = inbox().begin()
        w.add(file: big, name: "buyuk", mime: nil)
        (0..<11).forEach { w.add(file: source, name: "n\($0)", mime: nil) }
        XCTAssertTrue(w.finish(text: nil))
        let s = try XCTUnwrap(inbox().take().first)
        XCTAssertEqual(s.files.count, ShareInbox.maxFiles)
        XCTAssertEqual(s.skipped, 2)
        XCTAssertFalse(s.files.contains { $0.name == "buyuk" })
    }

    func testEmptyShareRefused() {
        XCTAssertFalse(inbox().begin().finish(text: "   "))
        XCTAssertTrue(inbox().take().isEmpty)
    }

    func testUnfinishedShareInvisible() {
        inbox().begin().add(file: source, name: "a", mime: nil)
        XCTAssertTrue(inbox().take().isEmpty)
        XCTAssertFalse(inbox().hasPending())
    }

    func testFinishDeletesOnlyTaken() throws {
        accept(["a"])
        let b = inbox()
        let taken = try XCTUnwrap(b.take().first)
        accept(["b"])
        b.finish()
        XCTAssertFalse(FileManager.default.fileExists(atPath: taken.files[0].url.path))
        XCTAssertEqual(b.take().first?.files.first?.name, "b")
    }

    func testSweepRemovesAfterDay() {
        accept(["a"])
        now += ShareInbox.dayMs - 1
        inbox().sweep()
        XCTAssertTrue(inbox().hasPending())
        now += 2
        inbox().sweep()
        XCTAssertFalse(inbox().hasPending())
    }

    func testSignOutClears() {
        accept(["a"])
        inbox().clear()
        XCTAssertFalse(inbox().hasPending())
    }

    func testFilenameSanitized() {
        XCTAssertEqual(sanitizeFilename("../../x"), "x")
        XCTAssertEqual(sanitizeFilename("a\\b/x.pdf"), "x.pdf")
        XCTAssertEqual(sanitizeFilename("rapor\u{0}\n.pdf"), "rapor.pdf")
        XCTAssertEqual(sanitizeFilename(".gizli"), "gizli")
        XCTAssertEqual(sanitizeFilename(""), "attachment")
        XCTAssertEqual(sanitizeFilename("../.."), "attachment")
        XCTAssertEqual(sanitizeFilename("Şubat raporu.pdf"), "Şubat raporu.pdf")
        let long = sanitizeFilename(String(repeating: "a", count: 300) + ".pdf")
        XCTAssertLessThanOrEqual(long.utf8.count, 200)
        XCTAssertTrue(long.hasSuffix(".pdf"))
    }
}
