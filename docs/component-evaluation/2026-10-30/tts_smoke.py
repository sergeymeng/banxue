import sherpa_onnx, soundfile as sf, pathlib, time, json
base=pathlib.Path('/tmp/banxue-component-eval');m=base/'kokoro-int8-multi-lang-v1_1'
config=sherpa_onnx.OfflineTtsConfig(model=sherpa_onnx.OfflineTtsModelConfig(kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(model=str(m/'model.int8.onnx'),voices=str(m/'voices.bin'),tokens=str(m/'tokens.txt'),lexicon=','.join(str(m/p) for p in ['lexicon-us-en.txt','lexicon-zh.txt']),data_dir=str(m/'espeak-ng-data'),dict_dir=str(m/'dict')),num_threads=4,provider='cpu'),rule_fsts=','.join(str(m/p) for p in ['date-zh.fst','number-zh.fst','phone-zh.fst']),max_num_sentences=1)
t=time.perf_counter();tts=sherpa_onnx.OfflineTts(config);print(json.dumps({'load_seconds':time.perf_counter()-t,'speakers':tts.num_speakers}),flush=True)
samples=[('en','Let us take this one step at a time. What is the derivative of x squared?',0),('zh','我们先看这一步。先求外层函数的导数，再乘以内层函数的导数。',50),('mixed','这道题用 chain rule，也就是链式法则。',50)]
results=[]
for name,text,sid in samples:
 t=time.perf_counter();chunks=[]
 def cb(audio,progress):
  chunks.append({'at_seconds':time.perf_counter()-t,'samples':len(audio),'progress':progress});return 1
 audio=tts.generate(text,sid=sid,speed=1.0,callback=cb);elapsed=time.perf_counter()-t
 sf.write(str(base/(name+'.wav')),audio.samples,audio.sample_rate)
 result={'name':name,'input':text,'speaker':sid,'generation_seconds':round(elapsed,3),'first_chunk_seconds':round(chunks[0]['at_seconds'],3) if chunks else None,'audio_seconds':round(len(audio.samples)/audio.sample_rate,3),'chunks':len(chunks),'sample_rate':audio.sample_rate}
 results.append(result);print(json.dumps(result,ensure_ascii=False),flush=True)
(base/'tts-results.json').write_text(json.dumps(results,indent=2,ensure_ascii=False))
