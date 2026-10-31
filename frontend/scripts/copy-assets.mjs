import { cp, mkdir, rm } from 'node:fs/promises';
// Remove only the former generated SDK asset directory when upgrading an existing checkout.
await rm('public/tldraw', { recursive: true, force: true });

// Bundle VAD model, worklet and ONNX runtime locally: no CDN or microphone data leaves via VAD.
await mkdir('public/voice', { recursive: true });
for (const file of ['vad.worklet.bundle.min.js', 'silero_vad_v5.onnx']) {
  await cp(`node_modules/@ricky0123/vad-web/dist/${file}`, `public/voice/${file}`);
}
const { readdir } = await import('node:fs/promises');
for (const file of await readdir('node_modules/onnxruntime-web/dist')) {
  if (/^ort-wasm.*\.(wasm|mjs)$/.test(file)) await cp(`node_modules/onnxruntime-web/dist/${file}`, `public/voice/${file}`);
}

// PDF renderer and fonts stay local in browser and packaged desktop builds.
await mkdir('public/pdf', { recursive: true });
await cp('node_modules/pdfjs-dist/LICENSE', 'public/pdf/LICENSE');
await cp('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'public/pdf/pdf.worker.min.mjs');
for (const dir of ['cmaps', 'standard_fonts', 'wasm']) {
  await cp(`node_modules/pdfjs-dist/${dir}`, `public/pdf/${dir}`, { recursive: true });
}
