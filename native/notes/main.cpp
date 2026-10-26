#include "llama.h"
#include "chat.h"
#include "json-schema-to-grammar.h"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <chrono>
#include <iostream>
#include <memory>
#include <string>
#include <thread>
#include <vector>

using json = nlohmann::ordered_json;
using Clock = std::chrono::steady_clock;
static void emit(const json &value) { std::cout << value.dump() << std::endl; }

struct Runtime {
    llama_model *model = nullptr;
    llama_context *context = nullptr;
    common_chat_templates_ptr templates;
    std::string path;
    std::string phase="request";
    ~Runtime() { clear(); }
    void clear() {
        templates.reset();
        if(context) llama_free(context);
        if(model) llama_model_free(model);
        context=nullptr; model=nullptr; path.clear();
    }
    bool load(const std::string &next) {
        phase="model_load";
        if(model && next==path) return true;
        clear();
        auto mp=llama_model_default_params();
#if defined(__APPLE__) && defined(__aarch64__)
        mp.n_gpu_layers=99;
#else
        mp.n_gpu_layers=0;
#endif
        model=llama_model_load_from_file(next.c_str(),mp);
        if(!model) throw std::runtime_error("model_load_failed");
        auto cp=llama_context_default_params();
        cp.n_ctx=12288; cp.n_batch=512; cp.n_ubatch=256;
        cp.n_threads=std::max(1u,std::min(4u,std::thread::hardware_concurrency()));
        cp.n_threads_batch=cp.n_threads;
        context=llama_init_from_model(model,cp);
        if(!context) throw std::runtime_error("model_memory_failed");
        phase="chat_template";templates=common_chat_templates_init(model,"");
        path=next; return false;
    }
    std::string generate(const json &request) {
        // Every request gets an empty cache, even when weights remain warm.
        llama_memory_clear(llama_get_memory(context),true);
        phase="prompt_template";
        common_chat_templates_inputs inputs;
        inputs.enable_thinking=false;
        inputs.messages.push_back({"system",request.at("system").get<std::string>()});
        inputs.messages.push_back({"user",request.at("input").get<std::string>()});
        auto rendered=common_chat_templates_apply(templates.get(),inputs);
        phase="tokenization";
        const auto *vocab=llama_model_get_vocab(model);
        std::vector<llama_token> tokens;
        // Untrusted input parts cannot inject chat control tokens.
        for(const auto &part:rendered.prompt.parts) {
            int count=-llama_tokenize(vocab,part.text.data(),part.text.size(),nullptr,0,tokens.empty(),!part.is_input);
            if(count<0) throw std::runtime_error("tokenization_failed");
            std::vector<llama_token> next(count);
            int written=llama_tokenize(vocab,part.text.data(),part.text.size(),next.data(),count,tokens.empty(),!part.is_input);
            if(written<0) throw std::runtime_error("tokenization_failed");
            tokens.insert(tokens.end(),next.begin(),next.begin()+written);
        }
        const int limit=request.value("maxTokens",3072);
        if(tokens.empty() || limit<1 || limit>4096 || tokens.size()+limit>12288){phase="context_limit";throw std::runtime_error("context_limit");}
        phase="prompt_inference";for(size_t offset=0;offset<tokens.size();offset+=512) {
            auto batch=llama_batch_get_one(tokens.data()+offset,std::min<size_t>(512,tokens.size()-offset));
            if(llama_decode(context,batch)!=0) throw std::runtime_error("inference_failed");
        }
        auto sampler=std::unique_ptr<llama_sampler,decltype(&llama_sampler_free)>(llama_sampler_chain_init(llama_sampler_chain_default_params()),llama_sampler_free);
        phase="grammar";std::string grammar=json_schema_to_grammar(common_json::parse(request.at("schema").dump()));
        llama_sampler_chain_add(sampler.get(),llama_sampler_init_grammar(vocab,grammar.c_str(),"root"));
        llama_sampler_chain_add(sampler.get(),llama_sampler_init_greedy());
        std::string result;
        phase="generation";for(int i=0;i<limit;i++) {
            auto token=llama_sampler_sample(sampler.get(),context,-1);
            if(llama_vocab_is_eog(vocab,token)) return result;
            char buffer[1024]; int count=llama_token_to_piece(vocab,token,buffer,sizeof(buffer),0,false);
            if(count<0) throw std::runtime_error("token_failed");
            result.append(buffer,count);
            // A constrained JSON response is complete when its root object closes.
            // Do not wait for EOS: greedy models can keep emitting legal whitespace.
            auto last=result.find_last_not_of(" \t\r\n");
            if(last!=std::string::npos && result[last]=='}'){
                auto complete=json::parse(result,nullptr,false);
                if(!complete.is_discarded() && complete.is_object()) return result;
            }
            if(llama_decode(context,llama_batch_get_one(&token,1))!=0) throw std::runtime_error("inference_failed");
        }
        // Never return a silently truncated JSON document.
        phase="output_limit";throw std::runtime_error("output_limit");
    }
};

int main(int argc,char **argv) {
    if(argc==2 && std::string(argv[1])=="--self-test") { json value={{"kind","error"},{"code","invalid_request"}}; return value.dump().empty(); }
    llama_log_set([](ggml_log_level,const char*,void*){},nullptr);
    llama_backend_init();
    Runtime runtime;
    std::string line;
    while(std::getline(std::cin,line)) {
        uint64_t id=0;
        try {
            if(line.size()>1024*1024) throw std::runtime_error("invalid_request");
            auto request=json::parse(line); id=request.at("id").get<uint64_t>();
            auto start=Clock::now(); emit({{"id",id},{"kind","preparing"}});
            bool hit=runtime.load(request.at("modelPath").get<std::string>());
            auto text=runtime.generate(request);
            auto checked=json::parse(text);
            emit({{"id",id},{"kind","result"},{"notes",checked},{"modelCacheHit",hit},{"elapsedMs",std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now()-start).count()}});
        } catch(...) {
            auto phase=runtime.phase;runtime.clear();
            emit({{"id",id},{"kind","error"},{"code","local_notes_failed"},{"phase",phase}});
        }
    }
    return 0;
}
