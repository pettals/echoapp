// swift-tools-version: 6.2
import PackageDescription
let package = Package(name:"EchoCapture",platforms:[.macOS(.v13)],products:[.executable(name:"echo-capture",targets:["EchoCapture"])],targets:[.executableTarget(name:"EchoCapture"),.testTarget(name:"EchoCaptureTests",dependencies:["EchoCapture"])])
