import Foundation

// All calls are confined to the capture's serial audio queue.
final class ChunkWriter {
    let directory: URL
    let source: String
    let emit: ([String:Any])->Void
    private var samples: [Int16] = []
    private var startMs: Double = 0
    private var retainedOnly=false
    private var sequence: Int
    private let sourceIndex: Int
    init(directory: URL,source: String,emit:@escaping([String:Any])->Void) {
        self.directory=directory;self.source=source;self.emit=emit;self.sourceIndex=source == "microphone" ? 0 : 1;self.sequence=0
        samples.reserveCapacity(240000)
    }
    func push(_ input:[Float],at milliseconds:Double) throws {
        var offset=0
        if !samples.isEmpty && abs(milliseconds-(startMs+Double(samples.count)/16))>150 {try flush()}
        while offset<input.count {
            if samples.isEmpty { startMs=milliseconds+Double(offset)/16 }
            let count=min(240000-samples.count,input.count-offset)
            samples.append(contentsOf:input[offset..<offset+count].map{Int16(max(-32767,min(32767,($0.isFinite ? $0 : 0)*32767)))})
            retainedOnly=false
            offset+=count
            if samples.count==240000 {try flush(retainOverlap:true)}
        }
    }
    func flush(retainOverlap:Bool=false) throws {
        guard !samples.isEmpty else{return}
        if retainedOnly{samples.removeAll(keepingCapacity:true);retainedOnly=false;return}
        let id=sequence*2+sourceIndex;sequence+=1
        let filename="\(source)-\(id).wav"
        let destination=directory.appendingPathComponent(filename)
        var data=Self.header(frames:UInt32(samples.count))
        samples.withUnsafeBytes {data.append(contentsOf:$0)}
        try data.write(to:destination,options:[.atomic])
        let handle=try FileHandle(forWritingTo:destination);try handle.synchronize();try handle.close()
        let event:[String:Any]=["kind":"chunk","file":filename,"sequence":id,"source":source,"startMs":UInt64(max(0,startMs)),"endMs":UInt64(max(0,startMs+Double(samples.count)/16))]
        let journal=destination.appendingPathExtension("json")
        try JSONSerialization.data(withJSONObject:event).write(to:journal,options:[.atomic])
        let journalHandle=try FileHandle(forWritingTo:journal);try journalHandle.synchronize();try journalHandle.close()
        emit(event)
        if retainOverlap {
            startMs+=Double(samples.count-8000)/16
            samples=Array(samples.suffix(8000));retainedOnly=true
        }else{samples.removeAll(keepingCapacity:true)}
    }
    static func header(frames:UInt32)->Data {
        var data=Data()
        func text(_ value:String){data.append(contentsOf:value.utf8)}
        func u16(_ value:UInt16){var n=value.littleEndian;withUnsafeBytes(of:&n){data.append(contentsOf:$0)}}
        func u32(_ value:UInt32){var n=value.littleEndian;withUnsafeBytes(of:&n){data.append(contentsOf:$0)}}
        text("RIFF");u32(36+frames*2);text("WAVEfmt ");u32(16);u16(1);u16(1);u32(16000);u32(32000);u16(2);u16(16);text("data");u32(frames*2)
        return data
    }
}
