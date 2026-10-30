# Synthetic interruption fixture

`interruption-synthetic.wav` is 16kHz mono PCM16, generated on macOS with Tingting:

```bash
say -v Tingting -r 180 -o /tmp/banxue-interruption.aiff '等一下，为什么要乘以内层函数的导数？我还没有听懂。'
afconvert -f WAVE -d LEI16@16000 -c 1 /tmp/banxue-interruption.aiff interruption-synthetic.wav
```

Used only to exercise bundled Silero VAD and browser audio interruption. It is synthetic, contains no student data, does not test Qwen, and cannot establish human microphone/speaker echo performance. No system voice model is distributed with the application.
