import { cp, mkdir } from 'node:fs/promises';
await mkdir('public/tldraw', { recursive: true });
for (const dir of ['fonts','icons','translations','embed-icons']) {
  try { await cp(`node_modules/@tldraw/assets/${dir}`, `public/tldraw/${dir}`, { recursive: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

// Bundle VAD model, worklet and ONNX runtime locally: no CDN or microphone data leaves via VAD.
await mkdir('public/voice', { recursive: true });
for (const file of ['vad.worklet.bundle.min.js', 'silero_vad_v5.onnx']) {
  await cp(`node_modules/@ricky0123/vad-web/dist/${file}`, `public/voice/${file}`);
}
const { readdir } = await import('node:fs/promises');
for (const file of await readdir('node_modules/onnxruntime-web/dist')) {
  if (/^ort-wasm.*\.(wasm|mjs)$/.test(file)) await cp(`node_modules/onnxruntime-web/dist/${file}`, `public/voice/${file}`);
}
