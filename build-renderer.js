import * as esbuild from 'esbuild';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

await esbuild.build({
  entryPoints: [join(__dirname, 'app/renderer.js')],
  bundle: true,
  outfile: join(__dirname, 'app/renderer.bundle.js'),
  format: 'iife',
  target: 'es2020',
  platform: 'browser',
  external: ['electron'],
  define: {
    'process.env.NODE_ENV': '"development"'
  },
  sourcemap: true,
  globalName: 'KaleidosyncRenderer'
});

console.log('Renderer bundled successfully');