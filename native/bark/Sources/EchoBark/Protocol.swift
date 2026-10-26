import Foundation

struct Request: Decodable {
    let id: UInt64
    let modelDirectory: String
    let audioPath: String
}

struct Response: Encodable {
    let id: UInt64
    let kind: String
    var text: String? = nil
    var code: String? = nil
    var modelCacheHit: Bool? = nil
    var modelLoadMs: UInt64? = nil
    var audioDecodeMs: UInt64? = nil
    var inferenceMs: UInt64? = nil
}

func cleanTranscript(_ text: String) -> String {
    text.replacingOccurrences(of: "<unk>", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
}

func milliseconds(since start: ContinuousClock.Instant) -> UInt64 {
    let duration = start.duration(to: .now).components
    return UInt64(max(0, duration.seconds)) * 1_000 + UInt64(max(0, duration.attoseconds)) / 1_000_000_000_000_000
}
