import { copyFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const output = resolve('dist/renderer/voice-assets');
await mkdir(output, { recursive: true });
for (const file of ['vad.worklet.bundle.min.js', 'silero_vad_v5.onnx']) {
  await copyFile(resolve('node_modules/@ricky0123/vad-web/dist', file), resolve(output, file));
}
for (const file of ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs']) {
  await copyFile(resolve('node_modules/onnxruntime-web/dist', file), resolve(output, file));
}
