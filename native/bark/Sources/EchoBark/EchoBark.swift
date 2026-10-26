import AVFoundation
import CoreML
import FluidAudio
import Foundation

@main
struct EchoBark {
    static func emit(_ response: Response, to output: FileHandle) {
        if let data = try? JSONEncoder().encode(response) {
            output.write(data)
            output.write(Data([10]))
        }
    }

    static func main() async {
        // Reserve stdout for the protocol even if a dependency prints diagnostics.
        let output = FileHandle(fileDescriptor: dup(STDOUT_FILENO), closeOnDealloc: true)
        dup2(STDERR_FILENO, STDOUT_FILENO)
        var manager: AsrManager?
        var loadedDirectory: String?
        while let line = readLine() {
            guard let data = line.data(using: .utf8), let request = try? JSONDecoder().decode(Request.self, from: data) else {
                emit(Response(id: 0, kind: "error", code: "bark_invalid_request"), to: output)
                continue
            }
            do {
                #if arch(arm64)
                let cacheHit = manager != nil && loadedDirectory == request.modelDirectory
                let loadStart = ContinuousClock.now
                if !cacheHit {
                    emit(Response(id: request.id, kind: "preparing"), to: output)
                    manager = nil
                    loadedDirectory = nil
                    let config = MLModelConfiguration()
                    config.computeUnits = .cpuOnly
                    let models = try AsrModels.loadLocal(
                        from: URL(fileURLWithPath: request.modelDirectory),
                        version: .ultra,
                        configuration: config,
                        encoderComputeUnits: .cpuAndNeuralEngine
                    )
                    let next = AsrManager(config: .default)
                    try await next.loadModels(models)
                    manager = next
                    loadedDirectory = request.modelDirectory
                }
                let loadMs = milliseconds(since: loadStart)
                guard let manager else { throw CocoaError(.coderInvalidValue) }
                // A fresh state per request prevents text leaking between dictations.
                var decoderState = TdtDecoderState.make(decoderLayers: await manager.decoderLayerCount)
                let start = ContinuousClock.now
                let result = try await manager.transcribe(
                    URL(fileURLWithPath: request.audioPath), decoderState: &decoderState
                )
                emit(Response(id: request.id, kind: "result", text: cleanTranscript(result.text),
                              modelCacheHit: cacheHit, modelLoadMs: loadMs,
                              inferenceMs: milliseconds(since: start)), to: output)
                #else
                emit(Response(id: request.id, kind: "error", code: "bark_unsupported_platform"), to: output)
                #endif
            } catch {
                // Do not forward dependency messages containing paths or audio/text.
                manager = nil
                loadedDirectory = nil
                emit(Response(id: request.id, kind: "error", code: "bark_transcription_failed"), to: output)
            }
        }
    }
}
