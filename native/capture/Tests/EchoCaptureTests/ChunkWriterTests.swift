import Foundation
import Testing
@testable import EchoCapture
struct ChunkWriterTests {
    @Test func wavHeaderAndBoundedChunks() throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true);defer{try? FileManager.default.removeItem(at:root)}
        var events:[[String:Any]]=[]
        let writer=ChunkWriter(directory:root,source:"microphone"){events.append($0)}
        try writer.push(Array(repeating:Float(0.5),count:240100),at:1000);try writer.flush()
        #expect(events.count==2)
        #expect(events[0]["startMs"] as? UInt64 == 1000)
        #expect(events[1]["startMs"] as? UInt64 == 15500)
        let file=try Data(contentsOf:root.appendingPathComponent("microphone-0.wav"))
        #expect(file.count==480044)
        #expect(String(data:file.prefix(4),encoding:.utf8)=="RIFF")
    }
    @Test func fourHourRecordingStaysChunkedAndDoesNotRetainProcessedAudio() throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true);defer{try? FileManager.default.removeItem(at:root)}
        let input=Array(repeating:Float(0.01),count:240000)
        var events=0
        for source in ["microphone","computer"] {
            let writer=ChunkWriter(directory:root,source:source){event in
                events+=1
                let file=root.appendingPathComponent(event["file"] as! String)
                #expect((try? Data(contentsOf:file).count).map{$0>44 && $0<=480044} == true)
                #expect(FileManager.default.fileExists(atPath:file.appendingPathExtension("json").path))
                // Simulate deleting audio only after a durable transcript commit.
                try? FileManager.default.removeItem(at:file);try? FileManager.default.removeItem(at:file.appendingPathExtension("json"))
            }
            for chunk in 0..<960 {try writer.push(input,at:Double(chunk*15000))}
            try writer.flush()
        }
        #expect(events>=1920 && events<2000)
        #expect(try FileManager.default.contentsOfDirectory(atPath:root.path).isEmpty)
    }
}
