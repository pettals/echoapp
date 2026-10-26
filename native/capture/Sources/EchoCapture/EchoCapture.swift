import AVFoundation
import CoreAudio
import CoreGraphics
import Foundation
import ScreenCaptureKit

// Ownership is transferred to the serial processing queue; no producer mutates it.
final class OwnedBuffer: @unchecked Sendable {let value:AVAudioPCMBuffer;init(_ value:AVAudioPCMBuffer){self.value=value}}

final class Capture: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let queue=DispatchQueue(label:"echo.meetings.audio")
    let output:FileHandle
    let outputLock=NSLock()
    let directory:URL
    let mode:String
    var engine:AVAudioEngine?
    var stream:SCStream?
    var writers:[String:ChunkWriter]=[:]
    var converters:[String:AVAudioConverter]=[:]
    var started=ProcessInfo.processInfo.systemUptime
    var pausedAt:Double?
    var pausedTotal:Double=0
    var stopped=false
    var lastLevel:Double=0
    let bufferSlots=DispatchSemaphore(value:8)
    let failureLock=NSLock()
    var failed=false
    var timer:DispatchSourceTimer?
    let target=AVAudioFormat(commonFormat:.pcmFormatFloat32,sampleRate:16000,channels:1,interleaved:false)!
    init(request:[String:Any],output:FileHandle) throws {
        guard let path=request["directory"] as? String,let mode=request["mode"] as? String,["online","in-person"].contains(mode) else {throw CocoaError(.coderInvalidValue)}
        self.directory=URL(fileURLWithPath:path,isDirectory:true);self.mode=mode;self.output=output
        super.init()
        for source in ["microphone","computer"] {writers[source]=ChunkWriter(directory:directory,source:source){[weak self] in self?.emit($0)}}
    }
    func emit(_ value:[String:Any]) {
        guard let data=try? JSONSerialization.data(withJSONObject:value,options:[.sortedKeys])else{return}
        outputLock.lock();defer{outputLock.unlock()};output.write(data);output.write(Data([10]))
    }
    func elapsed()->Double {((pausedAt ?? ProcessInfo.processInfo.systemUptime)-started-pausedTotal)*1000}
    func fail(_ code:String){failureLock.lock();let report = !failed;failed=true;failureLock.unlock();if report{emit(["kind":"error","code":code])}}
    func start() async throws {
        let granted=await AVCaptureDevice.requestAccess(for:.audio)
        guard granted else{emit(["kind":"error","code":"microphone_permission"]);throw CocoaError(.userCancelled)}
        if mode=="online" {
            guard CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess() else{emit(["kind":"error","code":"computer_audio_permission"]);throw CocoaError(.userCancelled)}
            let content=try await SCShareableContent.excludingDesktopWindows(false,onScreenWindowsOnly:true)
            guard let display=content.displays.first(where:{$0.displayID==CGMainDisplayID()}) ?? content.displays.first else {throw CocoaError(.featureUnsupported)}
            let excluded=content.applications.filter{$0.processID==ProcessInfo.processInfo.processIdentifier}
            let filter=SCContentFilter(display:display,excludingApplications:excluded,exceptingWindows:[])
            let config=SCStreamConfiguration();config.capturesAudio=true;config.sampleRate=16000;config.channelCount=1;config.excludesCurrentProcessAudio=true
            // No screen frames are registered, read or saved.
            config.width=2;config.height=2;config.minimumFrameInterval=CMTime(seconds:1,preferredTimescale:1)
            let next=SCStream(filter:filter,configuration:config,delegate:self)
            try next.addStreamOutput(self,type:.audio,sampleHandlerQueue:queue)
            self.stream=next;started=ProcessInfo.processInfo.systemUptime;try await next.startCapture()
        }
        let next=AVAudioEngine();let input=next.inputNode;let format=input.outputFormat(forBus:0)
        guard format.sampleRate>0 && format.channelCount>0 else{throw CocoaError(.featureUnsupported)}
        input.installTap(onBus:0,bufferSize:2048,format:format){[weak self] buffer,time in
            guard let self else{return}
            guard self.bufferSlots.wait(timeout:.now()) == .success else{DispatchQueue.global().async{self.fail("audio_buffer_overrun")};return}
            // Copy the tap's borrowed buffer before returning to the audio engine.
            guard let copy=AVAudioPCMBuffer(pcmFormat:buffer.format,frameCapacity:buffer.frameLength)else{self.bufferSlots.signal();return};copy.frameLength=buffer.frameLength
            let src=UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList),dst=UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
            for index in 0..<min(src.count,dst.count){if let from=src[index].mData,let to=dst[index].mData{memcpy(to,from,Int(src[index].mDataByteSize))}}
            let host=AVAudioTime.seconds(forHostTime:time.hostTime)
            let owned=OwnedBuffer(copy)
            self.queue.async {defer{self.bufferSlots.signal()};self.consume(owned.value,source:"microphone",hostSeconds:host)}
        }
        if mode=="in-person"{started=ProcessInfo.processInfo.systemUptime};try next.start();engine=next
        let clock=DispatchSource.makeTimerSource(queue:queue)
        clock.schedule(deadline:.now()+1,repeating:1)
        clock.setEventHandler{[weak self] in guard let self,!self.stopped else{return};self.emit(["kind":"clock","durationMs":UInt64(max(0,self.elapsed()))]);if self.elapsed()>=14_400_000{self.emit(["kind":"limit"])}}
        timer=clock;clock.resume()
        emit(["kind":"started"])
    }
    func consume(_ buffer:AVAudioPCMBuffer,source:String,hostSeconds:Double) {
        guard !stopped,pausedAt==nil else{return}
        do {
            let converter:AVAudioConverter
            if let cached=converters[source],cached.inputFormat==buffer.format{converter=cached}else{guard let next=AVAudioConverter(from:buffer.format,to:target)else{throw CocoaError(.featureUnsupported)};converters[source]=next;converter=next}
            let frames=AVAudioFrameCount(ceil(Double(buffer.frameLength)*16000/buffer.format.sampleRate))+32
            guard let converted=AVAudioPCMBuffer(pcmFormat:target,frameCapacity:frames)else{throw CocoaError(.fileWriteOutOfSpace)}
            var supplied=false;var error:NSError?
            let status=converter.convert(to:converted,error:&error){_,state in if supplied{state.pointee = .noDataNow;return nil};supplied=true;state.pointee = .haveData;return buffer}
            guard status != .error,error==nil,let values=converted.floatChannelData?[0] else{throw CocoaError(.coderInvalidValue)}
            let samples=Array(UnsafeBufferPointer(start:values,count:Int(converted.frameLength)))
            let begin=max(0,(hostSeconds-started-pausedTotal)*1000)
            try writers[source]?.push(samples,at:begin)
            let now=ProcessInfo.processInfo.systemUptime
            if now-lastLevel>0.1 {lastLevel=now;let rms=sqrt(samples.reduce(Float(0)){$0+$1*$1}/Float(max(1,samples.count)));emit(["kind":"level","source":source,"level":min(1,Double(rms)*10),"durationMs":UInt64(max(0,elapsed()))])}
            if elapsed()>=4*60*60*1000 {emit(["kind":"limit"])}
        }catch{fail("recording_write_failed")}
    }
    func stream(_ stream:SCStream,didOutputSampleBuffer sampleBuffer:CMSampleBuffer,of outputType:SCStreamOutputType){
        guard outputType == .audio,sampleBuffer.isValid,let description=sampleBuffer.formatDescription else{return}
        let format=AVAudioFormat(cmAudioFormatDescription:description)
        var listSize=0
        let first=CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sampleBuffer,bufferListSizeNeededOut:&listSize,bufferListOut:nil,bufferListSize:0,blockBufferAllocator:nil,blockBufferMemoryAllocator:nil,flags:0,blockBufferOut:nil)
        guard (first==noErr || first==kCMSampleBufferError_ArrayTooSmall),listSize>0 else{return}
        let raw=UnsafeMutableRawPointer.allocate(byteCount:listSize,alignment:MemoryLayout<AudioBufferList>.alignment);defer{raw.deallocate()}
        let list=raw.bindMemory(to:AudioBufferList.self,capacity:1);var block:CMBlockBuffer?
        guard CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sampleBuffer,bufferListSizeNeededOut:nil,bufferListOut:list,bufferListSize:listSize,blockBufferAllocator:nil,blockBufferMemoryAllocator:nil,flags:0,blockBufferOut:&block)==noErr,
              let buffer=AVAudioPCMBuffer(pcmFormat:format,bufferListNoCopy:list,deallocator:nil)else{return}
        consume(buffer,source:"computer",hostSeconds:sampleBuffer.presentationTimeStamp.seconds)
    }
    func stream(_ stream:SCStream,didStopWithError error:Error){fail("computer_audio_stopped")}
    func pause(_ value:Bool){queue.sync{let now=ProcessInfo.processInfo.systemUptime;if value && pausedAt==nil{do{for writer in writers.values{try writer.flush()}}catch{fail("recording_write_failed");return};pausedAt=now}else if !value,let since=pausedAt{pausedTotal+=now-since;pausedAt=nil;converters.removeAll()};emit(["kind":value ? "paused":"resumed","durationMs":UInt64(max(0,elapsed()))])}}
    func stop() async {
        timer?.cancel();timer=nil
        engine?.inputNode.removeTap(onBus:0);engine?.stop();engine=nil
        try? await stream?.stopCapture();stream=nil
        queue.sync{stopped=true;do{for writer in writers.values{try writer.flush()};emit(["kind":"stopped","durationMs":UInt64(max(0,elapsed()))])}catch{emit(["kind":"error","code":"recording_write_failed"])}}
    }
}

@main struct EchoCapture {
    static func main() async {
        let output=FileHandle(fileDescriptor:dup(STDOUT_FILENO),closeOnDealloc:true);dup2(STDERR_FILENO,STDOUT_FILENO)
        guard let line=readLine(),let data=line.data(using:.utf8),let request=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any] else{return}
        var capture:Capture?
        do {
            let next=try Capture(request:request,output:output);capture=next;try await next.start()
            // Read commands off the main actor, allowing TCC and AVFoundation callbacks to run.
            let commands=AsyncStream<String>{continuation in DispatchQueue.global().async{while let command=readLine(){continuation.yield(command)};continuation.finish()}}
            for await command in commands {
                guard let data=command.data(using:.utf8),let value=(try? JSONSerialization.jsonObject(with:data)) as? [String:String] else{continue}
                if value["command"]=="pause"{next.pause(true)}else if value["command"]=="resume"{next.pause(false)}else if value["command"]=="stop"{break}
            }
            await next.stop()
        }catch{capture?.emit(["kind":"error","code":"capture_failed"]);await capture?.stop()}
    }
}
