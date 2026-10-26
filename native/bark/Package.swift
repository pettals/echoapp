// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "EchoBark",
    platforms: [.macOS(.v15)],
    products: [.executable(name: "echo-bark", targets: ["EchoBark"])],
    dependencies: [
        // No NeMo Rust static library: Echo already links Rust through Tauri.
        .package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.17.7", traits: []),
    ],
    targets: [
        .executableTarget(name: "EchoBark", dependencies: [.product(name: "FluidAudio", package: "FluidAudio")]),
        .testTarget(name: "EchoBarkTests", dependencies: ["EchoBark"]),
    ]
)
