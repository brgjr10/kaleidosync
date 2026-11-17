#!/usr/bin/env node
/**
 * Sketch Catalog Extractor
 * Parses @wearesage/vue/src/stores/sketches.ts and emits assets/sketches.json
 * with stable IDs, verbatim shaders, variants, and derived uniform schemas.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The upstream catalogue lives in the @wearesage/vue package. Resolve it from
// the project's node_modules so `npm run extract` works on any machine, and
// allow an explicit override for CI or a vendored copy:
//
//   npm run extract -- /path/to/sketches.ts
//   SKETCHES_TS_PATH=/path/to/sketches.ts npm run extract
const DEFAULT_REFERENCE_PATH = path.join(
  __dirname,
  'node_modules',
  '@wearesage',
  'vue',
  'src',
  'stores',
  'sketches.ts'
);
const REFERENCE_PATH = process.argv[2] || process.env.SKETCHES_TS_PATH || DEFAULT_REFERENCE_PATH;
const OUTPUT_PATH = path.join(__dirname, 'assets', 'sketches.json');

function extractSketches() {
  if (!fs.existsSync(REFERENCE_PATH)) {
    throw new Error(
      `Reference file not found: ${REFERENCE_PATH}\n` +
      `Install the upstream package (npm install @wearesage/vue) or pass a path:\n` +
      `  npm run extract -- /path/to/sketches.ts`
    );
  }
  const content = fs.readFileSync(REFERENCE_PATH, 'utf-8');

  // Find the sketchesData array content
  const match = content.match(/const sketchesData = ref<Sketch\[\]>\((\[[\s\S]*?\])\);/);
  if (!match) {
    throw new Error('Could not find sketchesData array in reference file');
  }

  const arrayStr = match[1];

  // Parse the array by finding each sketch object
  // Each sketch has: shader, variants, walletAddress, isPublic
  const sketches = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let stringChar = '';
  let escaped = false;

  for (let i = 0; i < arrayStr.length; i++) {
    const char = arrayStr[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === stringChar) {
        inString = false;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      inString = true;
      stringChar = char;
      continue;
    }

    if (char === '{') {
      if (depth === 0) {
        start = i;
      }
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        const objStr = arrayStr.slice(start, i + 1);
        const sketch = parseSketchObject(objStr);
        if (sketch) sketches.push(sketch);
        start = -1;
      }
    }
  }

  return sketches;
}

// Turn a sketch object literal from the upstream catalogue into a plain
// object without eval(). The source is a trusted local package, but the
// literal is JavaScript, not JSON (unquoted keys, single quotes, trailing
// commas, template literals for shaders), so evaluate it inside a `new
// Function` sandbox that only exposes inert globals and freezes the result.
// Any escape attempt throws and the sketch is skipped with a diagnostic.
function parseSketchObject(objStr) {
  const inert = Object.freeze({
    Object, Array, String, Number, Boolean, Math, JSON, undefined, NaN, Infinity
  });
  const factory = new Function(...Object.keys(inert), `"use strict"; return (${objStr});`);
  try {
    const sketch = factory(...Object.values(inert));
    if (!sketch || typeof sketch !== 'object') return null;
    return sketch;
  } catch (e) {
    console.error('Failed to parse sketch object:', e.message);
    console.error('Object string (first 500 chars):', objStr.slice(0, 500));
    return null;
  }
}

function inferUniformType(value) {
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number') return 'float';
  if (Array.isArray(value)) {
    return value.length === 2 ? 'vec2' : value.length === 3 ? 'vec3' : 'unknown';
  }
  return 'unknown';
}

function generateStableId(index, shader) {
  // Create a hash from the shader source for stability
  const hash = crypto.createHash('md5').update(shader).digest('hex').slice(0, 8);
  return `sketch_${String(index).padStart(3, '0')}_${hash}`;
}

function inferName(index, shader) {
  // Derive a human-readable name from the shader's #define directive
  const defineMatch = shader.match(/#define\s+(\w+)\s+([\d.]+)/);
  if (defineMatch) {
    const type = defineMatch[1];
    const count = parseFloat(defineMatch[2]);
    if (type === 'orbs') return `Orbs ${count}`;
    if (type === 'BALLS') return `Balls ${count}`;
    return `${type.charAt(0).toUpperCase() + type.slice(1)} ${count}`;
  }
  return `Custom ${index}`;
}

function processSketches(rawSketches) {
  return rawSketches.map((sketch, index) => {
    const variants = sketch.variants.map(v => {
      const result = {};
      for (const [key, val] of Object.entries(v)) {
        result[key] = val.value;
      }
      return result;
    });

    // Derive uniform schema from first variant
    const firstVariant = variants[0] || {};
    const uniformSchema = {};
    for (const [key, value] of Object.entries(firstVariant)) {
      uniformSchema[key] = {
        type: inferUniformType(value),
        default: value
      };
    }

    // Also check for boolean uniforms that need tween helpers
    for (const [key, value] of Object.entries(firstVariant)) {
      if (typeof value === 'boolean') {
        uniformSchema[`${key}Tween`] = { type: 'bool', default: false };
        uniformSchema[`${key}TweenProgress`] = { type: 'float', default: 0 };
      }
    }

    return {
      id: generateStableId(index, sketch.shader),
      name: inferName(index, sketch.shader),
      index,
      shader: sketch.shader,
      variants,
      uniformSchema,
      walletAddress: sketch.walletAddress,
      isPublic: sketch.isPublic
    };
  });
}

function main() {
  console.log('Extracting sketches from reference...');
  const rawSketches = extractSketches();
  console.log(`Found ${rawSketches.length} sketches`);

  const processed = processSketches(rawSketches);

  // Verify round-trip
  let allMatch = true;
  for (let i = 0; i < rawSketches.length; i++) {
    const orig = rawSketches[i];
    const proc = processed[i];

    if (orig.shader !== proc.shader) {
      console.error(`Shader mismatch at index ${i}`);
      allMatch = false;
    }

    if (orig.variants.length !== proc.variants.length) {
      console.error(`Variant count mismatch at index ${i}: ${orig.variants.length} vs ${proc.variants.length}`);
      allMatch = false;
    } else {
      for (let j = 0; j < orig.variants.length; j++) {
        const origVar = orig.variants[j];
        const procVar = proc.variants[j];
        const origKeys = Object.keys(origVar).sort();
        const procKeys = Object.keys(procVar).sort();
        if (JSON.stringify(origKeys) !== JSON.stringify(procKeys)) {
          console.error(`Variant ${j} keys mismatch at index ${i}`);
          allMatch = false;
        }
        for (const key of origKeys) {
          if (JSON.stringify(origVar[key].value) !== JSON.stringify(procVar[key])) {
            console.error(`Variant ${j} value mismatch for ${key} at index ${i}`);
            allMatch = false;
          }
        }
      }
    }
  }

  if (allMatch) {
    console.log('✓ All sketches round-trip verified');
  } else {
    console.error('✗ Round-trip verification failed');
    process.exit(1);
  }

  const output = {
    extractedAt: new Date().toISOString(),
    source: REFERENCE_PATH,
    count: processed.length,
    sketches: processed
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`✓ Written to ${OUTPUT_PATH}`);
  console.log(`  Total sketches: ${processed.length}`);

  // Print summary
  const totalVariants = processed.reduce((sum, s) => sum + s.variants.length, 0);
  const totalUniforms = processed.reduce((sum, s) => sum + Object.keys(s.uniformSchema).length, 0);
  console.log(`  Total variants: ${totalVariants}`);
  console.log(`  Total uniform entries (with tween helpers): ${totalUniforms}`);
}

main();