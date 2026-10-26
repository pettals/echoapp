#include <windows.h>
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <initguid.h>
#include <ksmedia.h>
#include <wrl/client.h>
#include <nlohmann/json.hpp>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <future>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

using Microsoft::WRL::ComPtr;
using json=nlohmann::json;
using Clock=std::chrono::steady_clock;
static std::mutex outputMutex;
static void emit(json value){std::lock_guard<std::mutex> lock(outputMutex);std::cout<<value.dump()<<std::endl;}
struct State {
    std::atomic<bool> stop{false},pause{false};
    std::atomic<uint64_t> paused100ns{0},pauseStarted100ns{0};
    uint64_t start100ns;
    static uint64_t now(){LARGE_INTEGER c,f;QueryPerformanceCounter(&c);QueryPerformanceFrequency(&f);return uint64_t(double(c.QuadPart)*10000000.0/double(f.QuadPart));}
    uint64_t elapsed()const{auto end=pause?pauseStarted100ns.load():now();auto base=start100ns+paused100ns.load();return end>base?(end-base)/10000:0;}
};
class Writer {
    std::filesystem::path directory;
    std::string source;
    std::vector<int16_t> samples;
    uint64_t startMs=0,sequence=0;
    bool retainedOnly=false;
    int sourceIndex;
    template<class T> static void number(std::ofstream &file,T value){file.write(reinterpret_cast<const char*>(&value),sizeof(value));}
public:
    Writer(std::filesystem::path path,std::string name):directory(path),source(name),sourceIndex(name=="microphone"?0:1){samples.reserve(240000);}
    ~Writer(){try{flush();}catch(...){}}
    void flush(bool retainOverlap=false){
        if(samples.empty())return;
        if(retainedOnly){samples.clear();retainedOnly=false;return;}
        const uint64_t id=sequence++*2+sourceIndex;
        std::string name=source+"-"+std::to_string(id)+".wav";
        auto final=directory/std::filesystem::u8path(name),partial=final;partial+=L".part";
        std::ofstream file(partial,std::ios::binary|std::ios::trunc);
        file.write("RIFF",4);number<uint32_t>(file,36+uint32_t(samples.size()*2));file.write("WAVEfmt ",8);number<uint32_t>(file,16);number<uint16_t>(file,1);number<uint16_t>(file,1);number<uint32_t>(file,16000);number<uint32_t>(file,32000);number<uint16_t>(file,2);number<uint16_t>(file,16);file.write("data",4);number<uint32_t>(file,uint32_t(samples.size()*2));
        file.write(reinterpret_cast<const char*>(samples.data()),samples.size()*2);file.flush();if(!file)throw std::runtime_error("disk_write");file.close();
        HANDLE handle=CreateFileW(partial.c_str(),GENERIC_WRITE,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr);
        if(handle==INVALID_HANDLE_VALUE)throw std::runtime_error("disk_write");
        bool synced=FlushFileBuffers(handle);CloseHandle(handle);if(!synced)throw std::runtime_error("disk_write");
        std::filesystem::rename(partial,final);
        json event={{"kind","chunk"},{"file",name},{"sequence",id},{"source",source},{"startMs",startMs},{"endMs",startMs+samples.size()/16}};
        auto journal=final;journal+=L".json";auto journalTemp=journal;journalTemp+=L".part";
        std::ofstream metadata(journalTemp,std::ios::binary|std::ios::trunc);metadata<<event.dump();metadata.flush();if(!metadata)throw std::runtime_error("disk_write");metadata.close();
        std::filesystem::rename(journalTemp,journal);
        emit(event);
        if(retainOverlap){startMs+=(samples.size()-8000)/16;samples.erase(samples.begin(),samples.end()-8000);retainedOnly=true;}else samples.clear();
    }
    void push(const std::vector<float>&values,uint64_t timestamp){
        if(!samples.empty() && std::abs(double(timestamp)-double(startMs+samples.size()/16))>150)flush();
        size_t offset=0;
        while(offset<values.size()){
            if(samples.empty())startMs=timestamp+offset/16;
            auto count=std::min<size_t>(240000-samples.size(),values.size()-offset);
            for(size_t i=0;i<count;i++)samples.push_back(int16_t(std::clamp(values[offset+i],-1.0f,1.0f)*32767));
            retainedOnly=false;offset+=count;if(samples.size()==240000)flush(true);
        }
    }
};

static void check(HRESULT result){if(FAILED(result))throw std::runtime_error("audio_device");}
static void record(State&state,const std::filesystem::path&directory,bool loopback,std::promise<bool> startup){
    bool signalled=false;bool initialized=false;WAVEFORMATEX*format=nullptr;
    ComPtr<IAudioClient> client;
    try{
        check(CoInitializeEx(nullptr,COINIT_MULTITHREADED));initialized=true;
        ComPtr<IMMDeviceEnumerator> enumerator;check(CoCreateInstance(__uuidof(MMDeviceEnumerator),nullptr,CLSCTX_ALL,IID_PPV_ARGS(&enumerator)));
        // Loop back the system's default playback device. Conferencing apps may
        // choose a separate communications endpoint for the microphone.
        ComPtr<IMMDevice> device;check(enumerator->GetDefaultAudioEndpoint(loopback?eRender:eCapture,loopback?eConsole:eCommunications,&device));
        check(device->Activate(__uuidof(IAudioClient),CLSCTX_ALL,nullptr,reinterpret_cast<void**>(client.GetAddressOf())));
        check(client->GetMixFormat(&format));
        check(client->Initialize(AUDCLNT_SHAREMODE_SHARED,loopback?AUDCLNT_STREAMFLAGS_LOOPBACK:0,1000000,0,format,nullptr));
        ComPtr<IAudioCaptureClient> capture;check(client->GetService(IID_PPV_ARGS(&capture)));
        bool floating=format->wFormatTag==WAVE_FORMAT_IEEE_FLOAT;
        if(format->wFormatTag==WAVE_FORMAT_EXTENSIBLE){auto extended=reinterpret_cast<WAVEFORMATEXTENSIBLE*>(format);floating=IsEqualGUID(extended->SubFormat,KSDATAFORMAT_SUBTYPE_IEEE_FLOAT);if(!floating&&!IsEqualGUID(extended->SubFormat,KSDATAFORMAT_SUBTYPE_PCM))throw std::runtime_error("format");}
        if((floating&&format->wBitsPerSample!=32)||(!floating&&format->wBitsPerSample!=16&&format->wBitsPerSample!=24&&format->wBitsPerSample!=32))throw std::runtime_error("format");
        Writer writer(directory,loopback?"computer":"microphone");
        check(client->Start());startup.set_value(true);signalled=true;
        double phase=0;uint64_t lastLevel=0;bool wasPaused=false;
        while(!state.stop){
            bool paused=state.pause;
            if(paused&&!wasPaused)writer.flush();wasPaused=paused;
            UINT32 packet=0;check(capture->GetNextPacketSize(&packet));
            while(packet){
                BYTE*data=nullptr;UINT32 frames=0;DWORD flags=0;UINT64 position=0,qpc=0;
                check(capture->GetBuffer(&data,&frames,&flags,&position,&qpc));
                std::vector<float> mono;mono.reserve(frames);
                if(!paused){for(UINT32 frame=0;frame<frames;frame++){
                    double total=0;
                    if(!(flags&AUDCLNT_BUFFERFLAGS_SILENT))for(WORD channel=0;channel<format->nChannels;channel++){
                        auto sample=data+frame*format->nBlockAlign+channel*(format->wBitsPerSample/8);
                        if(floating){float v;memcpy(&v,sample,4);total+=std::isfinite(v)?v:0;}else if(format->wBitsPerSample==16){int16_t v;memcpy(&v,sample,2);total+=double(v)/32768;}else if(format->wBitsPerSample==32){int32_t v;memcpy(&v,sample,4);total+=double(v)/2147483648.0;}else{uint32_t packed=(uint32_t(sample[2])<<24)|(uint32_t(sample[1])<<16)|(uint32_t(sample[0])<<8);int32_t v;memcpy(&v,&packed,4);total+=double(v)/2147483648.0;}
                    }
                    mono.push_back(float(total/std::max<WORD>(1,format->nChannels)));
                }}
                check(capture->ReleaseBuffer(frames));
                if(!paused&&!mono.empty()){
                    std::vector<float> converted;const double ratio=double(format->nSamplesPerSec)/16000;
                    while(phase<mono.size()){size_t index=size_t(phase);double fraction=phase-index;float next=mono[std::min(index+1,mono.size()-1)];converted.push_back(float(mono[index]+(next-mono[index])*fraction));phase+=ratio;}phase-=mono.size();
                    uint64_t host=qpc?qpc:State::now();uint64_t base=state.start100ns+state.paused100ns.load();
                    writer.push(converted,host>base?(host-base)/10000:0);
                    auto elapsed=state.elapsed();if(elapsed-lastLevel>=100){lastLevel=elapsed;double sum=0;for(float value:converted)sum+=value*value;emit({{"kind","level"},{"source",loopback?"computer":"microphone"},{"level",std::min(1.0,std::sqrt(sum/std::max<size_t>(1,converted.size()))*10)},{"durationMs",elapsed}});}
                }
                check(capture->GetNextPacketSize(&packet));
            }
            if(state.elapsed()>=14400000){emit({{"kind","limit"}});state.stop=true;}
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }
        check(client->Stop());writer.flush();
    }catch(...){if(!signalled)startup.set_value(false);emit({{"kind","error"},{"code","audio_capture_failed"}});state.stop=true;}
    if(format)CoTaskMemFree(format);
    client.Reset();if(initialized)CoUninitialize();
}

int main(){
    std::string line;if(!std::getline(std::cin,line))return 1;
    try{
        auto request=json::parse(line);auto mode=request.at("mode").get<std::string>();if(mode!="online"&&mode!="in-person")throw std::runtime_error("mode");
        auto directory=std::filesystem::u8path(request.at("directory").get<std::string>());
        State state;state.start100ns=State::now();
        std::promise<bool> micReady;auto micFuture=micReady.get_future();std::thread mic(record,std::ref(state),directory,false,std::move(micReady));
        std::thread computer;std::future<bool> computerFuture;
        if(mode=="online"){std::promise<bool> ready;computerFuture=ready.get_future();computer=std::thread(record,std::ref(state),directory,true,std::move(ready));}
        bool ready=micFuture.get();if(mode=="online")ready=computerFuture.get()&&ready;
        if(ready)emit({{"kind","started"}});else state.stop=true;
        // Input reader can outlive the worker only until process termination.
        std::thread commands([&state]{std::string command;while(std::getline(std::cin,command)){try{auto value=json::parse(command).at("command").get<std::string>();if(value=="stop"){state.stop=true;break;}if(value=="pause"&&!state.pause.load()){state.pauseStarted100ns=State::now();state.pause=true;emit({{"kind","paused"},{"durationMs",state.elapsed()}});}else if(value=="resume"&&state.pause){state.paused100ns+=State::now()-state.pauseStarted100ns;state.pause=false;emit({{"kind","resumed"},{"durationMs",state.elapsed()}});}}catch(...){}}state.stop=true;});
        mic.join();if(computer.joinable())computer.join();emit({{"kind","stopped"},{"durationMs",state.elapsed()}});
        // Terminate the blocked stdin reader after all audio files are finalized.
        commands.detach();ExitProcess(0);
    }catch(...){emit({{"kind","error"},{"code","capture_failed"}});return 1;}
}
