// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "GeckoPushCore",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [.library(name: "GeckoPushCore", targets: ["GeckoPushCore"])],
    targets: [
        .target(name: "GeckoPushCore"),
        .testTarget(name: "GeckoPushCoreTests", dependencies: ["GeckoPushCore"])
    ]
)
