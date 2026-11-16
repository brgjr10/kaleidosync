import * as esbuild from 'esbuild';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

await esbuild.build({
  entryPoints: [join(__dirname, 'app/preload.js')],
  bundle: true,
  outfile: join(__dirname, 'app/preload.bundle.cjs'),
  format: 'cjs',
  target: 'es2020',
  platform: 'node',
  external: ['electron'],
  sourcemap: true,
  globalName: 'KaleidosyncPreload'
});

console.log('Preload bundled successfully');