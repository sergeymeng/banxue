import pathlib, subprocess, time, json
base=pathlib.Path('/tmp/banxue-component-eval');src=pathlib.Path((base/'whisper-source.txt').read_text());results=[]
for name,lang in [('en','en'),('zh','zh'),('mixed','zh')]:
 sample=base/(name+'-16k.wav');subprocess.run(['ffmpeg','-loglevel','error','-y','-i',str(base/(name+'.wav')),'-ar','16000','-ac','1',str(sample)],check=True)
 cmd=[str(src/'build/bin/whisper-cli'),'-m',str(base/'ggml-base.bin'),'-f',str(sample),'-l',lang,'-t','4','-nt']
 t=time.perf_counter();p=subprocess.run(cmd,capture_output=True,text=True);elapsed=time.perf_counter()-t
 (base/(name+'-asr.log')).write_text(p.stderr)
 result={'name':name,'input_type':'synthetic Kokoro speech; not human accuracy benchmark','wall_seconds':round(elapsed,3),'exit':p.returncode,'transcript':p.stdout.strip()};results.append(result);print(json.dumps(result,ensure_ascii=False),flush=True)
(base/'asr-synthetic-results.json').write_text(json.dumps(results,indent=2,ensure_ascii=False))
