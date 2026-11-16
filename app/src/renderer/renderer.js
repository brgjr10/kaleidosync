/**
 * Renderer - Three.js ShaderMaterial harness matching @wearesage/vue useShader.ts
 * Handles full uniform support, responsive resize, mainImage wrapping, bool tween uniforms
 */

import * as THREE from 'three';

const VERTEX_DEFS = [
  'precision highp float;',
  '#define PI 3.14159265359',
  '#define TWO_PI 2. * PI',
  'varying vec2 vUv;'
].join('\n');

const FRAGMENT_DEFS = [
  'precision highp float;',
  '#define PI 3.14159265359',
  '#define TWO_PI 2. * PI',
  'varying vec2 vUv;'
].join('\n');

const DEFAULT_VERTEX_SHADER = `
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const DEFAULT_FRAGMENT_SHADER = `
void main() {
  gl_FragColor = vec4(0.0);
}
`;

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.mesh = null;
    this.material = null;
    this.uniforms = {};
    this.fragmentShader = '';
    this.vertexShader = '';
    this.vertexDefs = VERTEX_DEFS;
    this.fragmentDefs = FRAGMENT_DEFS;
    this.initialized = false;
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.aspectRatio = 1;
    this.time = 0;
    this.startTime = performance.now();
    this.lastResizeTime = 0;
    
    // GLSL utils (will be injected)
    this.glslUtils = '';
    
    // Pending shader rebuild state. setShader()/setUniforms() only mutate these
    // caches; the material is updated atomically on the next render() call.
    this.needsRebuild = false;
    this.cachedVertexShader = '';
    this.cachedFragmentShader = '';
    this.cachedMaterialUniforms = {};
    
    // Initialize internal uniforms
    this.initInternalUniforms();
    
    this.initThree();
  }
  
  initInternalUniforms() {
    // Internal uniforms that the renderer manages
    this.uniforms.resolution = { value: new THREE.Vector2() };
    this.uniforms.time = { value: 0 };
    this.uniforms.stream = { value: 0 };
    this.uniforms.volume = { value: 0 };
    this.uniforms.bass = { value: 0 };
    this.uniforms.treble = { value: 0 };
    this.uniforms.bpm = { value: 0 };
    this.uniforms.beat = { value: 0 };
    
    // Shadertoy uniforms
    this.uniforms.iResolution = { value: new THREE.Vector3() };
    this.uniforms.iTime = { value: 0 };
    this.uniforms.iStream = { value: 0 };
    this.uniforms.iVolume = { value: 0 };
    this.uniforms.iBass = { value: 0 };
    this.uniforms.iTreble = { value: 0 };
    this.uniforms.iBpm = { value: 0 };
    this.uniforms.iBeat = { value: 0 };
    this.uniforms.iSpeed = { value: 0 };
  }
  
  initThree() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false,
      alpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance'
    });
    
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(this.canvas.clientWidth, this.canvas.clientHeight, false);
    
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    
    // Full-screen quad - proper UVs [0,1] x [0,1]
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0], 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
    geometry.setIndex([0, 1, 2, 2, 1, 3]);
    
    this.material = new THREE.ShaderMaterial({
      vertexShader: DEFAULT_VERTEX_SHADER,
      fragmentShader: DEFAULT_FRAGMENT_SHADER,
      uniforms: {},
      glslVersion: THREE.GLSL1
    });
    
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.scene.add(this.mesh);
    
    this.handleResize();
  }
  
  handleResize(force = false) {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    
    if (force || width !== this.width || height !== this.height || dpr !== this.dpr) {
      this.width = width;
      this.height = height;
      this.dpr = dpr;
      this.aspectRatio = width / height;
      
      // NOTE: setPixelRatio() internally calls setSize() using the stored
      // _width/_height, which are already in CSS pixels and get multiplied by
      // _pixelRatio inside setSize(). Passing width*dpr here would double-apply
      // the DPR and blow up the drawing buffer (dpr^2), which is exactly the
      // kind of stale/backbuffer mismatch that corrupts output after rapid
      // sketch switches. Pass the raw CSS-pixel size.
      this.renderer.setPixelRatio(dpr);
      this.renderer.setSize(width, height, false);
      
      // Update resolution-dependent uniforms
      this.updateResolutionUniforms();
      
      this.material.needsUpdate = true;
      this.lastResizeTime = performance.now();
    }
  }
  
  updateResolutionUniforms() {
    const w = this.width * this.dpr;
    const h = this.height * this.dpr;
    
    // Legacy uniforms
    if (this.uniforms.resolution) this.uniforms.resolution.value.set(w, h);
    if (this.uniforms.time) this.uniforms.time.value = this.time;
    
    // Shadertoy uniforms
    if (this.uniforms.iResolution) this.uniforms.iResolution.value.set(w, h, w / h);
    if (this.uniforms.iTime) this.uniforms.iTime.value = this.time;
  }
  
  setGLSLUtils(utils) {
    this.glslUtils = utils;
  }
  
  setShader(shaderCode) {
    this.fragmentShader = shaderCode;
    this.requestRebuild();
  }
  
  setUniforms(uniforms) {
    this.uniforms = { ...this.uniforms, ...uniforms };
    this.requestRebuild();
  }

  // Schedule a shader/material rebuild. All mutation of this.material is
  // deferred to render() so that rapid back-to-back calls (e.g. applyCurrentSketch
  // calling setShader then setUniforms, or fast Prev/Next sketch switching) cannot
  // race a Three.js ShaderMaterial recompilation that runs asynchronously on the
  // GL thread. Only the latest pending state is ever applied.
  requestRebuild() {
    this.needsRebuild = true;
  }
  
  rebuildShaders() {
    const declarations = this.buildUniformDeclarations();
    
    // Sync material uniforms from our uniform state
    const materialUniforms = {};
    for (const [key, uniform] of Object.entries(this.uniforms)) {
      if (uniform && uniform.value !== undefined) {
        materialUniforms[key] = uniform;
      }
    }
    
    // Vertex shader
    const newVertexShader = this.vertexDefs + declarations + DEFAULT_VERTEX_SHADER;
    
    // Fragment shader
    let shaderCode = this.fragmentShader || DEFAULT_FRAGMENT_SHADER;
    
    // Check for mainImage format
    const isMainImageShader = /void\s+mainImage\s*\(\s*out\s+vec4\s+\w+\s*,\s*in\s+vec2\s+\w+\s*\)/.test(shaderCode);
    
    if (isMainImageShader) {
      shaderCode = this.wrapMainImage(shaderCode);
    } else {
      // For shaders using void main(), ensure gl_FragColor is initialized
      shaderCode = shaderCode.replace(/void\s+main\s*\(\s*\)\s*\{/, 'void main() {\n  gl_FragColor = vec4(0.0);');
    }
    
    const fullShader = this.fragmentDefs + declarations + this.glslUtils + shaderCode;
    
    // Cache the result; the material is updated atomically in render().
    this.cachedVertexShader = newVertexShader;
    this.cachedFragmentShader = fullShader;
    this.cachedMaterialUniforms = materialUniforms;
    this.cachedDeclarations = declarations;
  }
  
  applyCachedShader() {
    if (!this.needsRebuild) return;
    
    this.rebuildShaders();
    
    // Apply atomically to the material on the main thread, during the render
    // call, so Three.js never sees a half-written shader while a previous
    // compile is in flight on the GL thread. Mutate the existing material
    // uniforms object in place rather than replacing it, so uniform values
    // pushed by updateUniforms() (audio, time, tween) on the previous frame
    // survive the rebuild instead of being dropped.
    const materialUniforms = this.material.uniforms;
    for (const key of Object.keys(this.cachedMaterialUniforms)) {
      const incoming = this.cachedMaterialUniforms[key];
      if (materialUniforms[key] && materialUniforms[key].value !== undefined) {
        materialUniforms[key].value = incoming.value;
      } else {
        materialUniforms[key] = incoming;
      }
    }
    
    if (this.cachedVertexShader !== this.vertexShader) {
      this.vertexShader = this.cachedVertexShader;
      this.material.vertexShader = this.cachedVertexShader;
    }
    
    if (this.cachedFragmentShader !== this.material.fragmentShader) {
      this.material.fragmentShader = this.cachedFragmentShader;
    }
    
    this.material.needsUpdate = true;
    this.needsRebuild = false;
    this.initialized = true;
  }
  
  buildUniformDeclarations() {
    const keys = Object.keys(this.uniforms).sort();
    const seen = new Set();
    return keys.map(key => {
      const uniform = this.uniforms[key];
      if (!uniform || uniform.value === undefined) return '';
      if (seen.has(key)) return '';
      seen.add(key);
      
      const value = uniform.value;
      if (Array.isArray(value)) {
        return `uniform ${value.length === 2 ? 'vec2' : 'vec3'} ${key};`;
      }
      if (value && typeof value === 'object' && value.isVector2) {
        return `uniform vec2 ${key};`;
      }
      if (value && typeof value === 'object' && value.isVector3) {
        return `uniform vec3 ${key};`;
      }
      if (typeof value === 'number') return `uniform float ${key};`;
      if (typeof value === 'boolean') return `uniform bool ${key};`;
      return '';
    }).filter(Boolean).join('\n');
  }
  
  wrapMainImage(shaderCode) {
    // Robust mainImage detection - check for the exact signature
    const hasMainImage = /void\s+mainImage\s*\(\s*out\s+vec4\s+\w+\s*,\s*in\s+vec2\s+\w+\s*\)/.test(shaderCode);
    if (!hasMainImage) return shaderCode;

    // Find the mainImage function and extract everything.
    // Brace counting is done on a comment/string/preprocessor-stripped view of
    // each line so that braces inside // comments, /* */ blocks, string
    // literals or #define macros do not throw off the depth.
    const lines = shaderCode.split('\n');
    const globalLines = [];
    const functionLines = [];
    let inFunction = false;
    let braceCount = 0;
    let mainImageFound = false;
    let inBlockComment = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Track block-comment state across lines using the raw line.
      let blockState = inBlockComment;
      let stripped = '';
      let j = 0;
      while (j < line.length) {
        const two = line.slice(j, j + 2);
        if (blockState) {
          if (two === '*/') { blockState = false; j += 2; continue; }
          stripped += ' ';
          j += 1;
          continue;
        }
        if (two === '//') { stripped += '  '; j += 2; break; } // rest of line is comment
        if (two === '/*') { blockState = true; stripped += '  '; j += 2; continue; }
        const ch = line[j];
        if (ch === '"') {
          stripped += '"';
          j += 1;
          while (j < line.length && line[j] !== '"') {
            if (line[j] === '\\') { stripped += '  '; j += 2; continue; }
            stripped += '"';
            j += 1;
          }
          if (j < line.length) { stripped += '"'; j += 1; }
          continue;
        }
        if (ch === "'") {
          stripped += "'";
          j += 1;
          while (j < line.length && line[j] !== "'") {
            if (line[j] === '\\') { stripped += '  '; j += 2; continue; }
            stripped += "'";
            j += 1;
          }
          if (j < line.length) { stripped += "'"; j += 1; }
          continue;
        }
        stripped += ch;
        j += 1;
      }
      inBlockComment = blockState;

      // Preprocessor lines (#define, #ifdef, ...) are not real scope braces.
      const isPreprocessor = /^\s*#/.test(line);
      const codeForBraces = isPreprocessor ? '' : stripped;

      // Detect mainImage function start on the raw trimmed line (signature is
      // never inside a comment/string in practice).
      if (!inFunction && /void\s+mainImage\s*\(\s*out\s+vec4\s+\w+\s*,\s*in\s+vec2\s+\w+\s*\)/.test(trimmed)) {
        inFunction = true;
        mainImageFound = true;
        functionLines.push(line);
        braceCount += (codeForBraces.match(/\{/g) || []).length;
        braceCount -= (codeForBraces.match(/\}/g) || []).length;
        continue;
      }

      if (inFunction) {
        functionLines.push(line);
        braceCount += (codeForBraces.match(/\{/g) || []).length;
        braceCount -= (codeForBraces.match(/\}/g) || []).length;

        if (braceCount <= 0) {
          inFunction = false;
          braceCount = 0;
        }
      } else {
        globalLines.push(line);
      }
    }

    if (!mainImageFound) return shaderCode;

    const globalSection = globalLines.join('\n');
    const functionSection = functionLines.join('\n');

    // Add fallback main() if not already present in the shader.
    if (!/void\s+main\s*\(\s*\)\s*\{/.test(functionSection) && !/void\s+main\s*\(\s*\)\s*\{/.test(globalSection)) {
      return `${globalSection}\n\n${functionSection}\n\nvoid main() {\n  mainImage(gl_FragColor, gl_FragCoord.xy);\n}`;
    }
    return `${globalSection}\n\n${functionSection}`;
  }
  
  updateUniforms(now) {
    if (!this.initialized) return;
    
    // Push any interpolated tween uniforms to the material WITHOUT rebuilding
    // shaders. This lets the SketchEngine tween (bool tween uniforms) drive
    // visuals on every frame without racing a Three.js shader recompilation.
    if (this.onTweenUniforms) {
      this.applyUniformValues(this.onTweenUniforms());
    }
    
    const time = now / 1000;
    this.time = time;
    const w = this.width * this.dpr;
    const h = this.height * this.dpr;
    
    // Update internal uniforms - always update time-based ones
    if (this.uniforms.resolution) this.uniforms.resolution.value.set(w, h);
    if (this.uniforms.time) this.uniforms.time.value = time;
    
    // Stream: use actual audio value (no fallback - silent audio = no motion)
    // Volume: use actual audio value (no fallback)
    
    // Shadertoy uniforms
    if (this.uniforms.iResolution) this.uniforms.iResolution.value.set(w, h, w / h);
    if (this.uniforms.iTime) this.uniforms.iTime.value = time;
    
    // iStream/iVolume: use actual audio values (no fallback)
    
    // Bass/treble: pass through to shader uniforms via setExternalUniforms
    
    // Update material uniforms
    for (const key of Object.keys(this.uniforms)) {
      if (this.material.uniforms[key]) {
        this.material.uniforms[key].value = this.uniforms[key].value;
      }
    }
  }
  
  setExternalUniforms(uniforms) {
    for (const [key, value] of Object.entries(uniforms)) {
      if (this.uniforms[key] !== undefined) {
        this.uniforms[key].value = value;
      }
    }
  }
  
  // Merge uniform VALUES (in {key: {value}} form) into the renderer's uniform
  // state WITHOUT triggering a shader rebuild. Used to push interpolated
  // tween values to the material every frame. New keys are registered so the
  // per-frame updateUniforms() sync in render() can copy them to the material.
  applyUniformValues(uniforms) {
    for (const [key, wrapper] of Object.entries(uniforms)) {
      if (!wrapper || wrapper.value === undefined) continue;
      if (this.uniforms[key] === undefined) {
        this.uniforms[key] = { value: wrapper.value };
      } else {
        this.uniforms[key].value = wrapper.value;
      }
    }
  }
  
  render(now = performance.now()) {
    // Apply any pending shader/uniform rebuild atomically, inside the render
    // call, so Three.js never compiles a shader while a previous compile is
    // still in flight on the GL thread. This gates rapid sketch/variant
    // switches behind material.needsUpdate clearing.
    this.applyCachedShader();
    
    // Force resize if dimensions are 0 (first frame)
    if (this.width === 0 || this.height === 0) {
      this.handleResize(true);
    }
    // Resize is driven by the window 'resize' event listener in the renderer
    // process (renderer.js) plus the explicit handleResize(true) call on sketch
    // switch; polling every frame here caused the drawing buffer to be
    // invalidated mid-transition and produced the garbled/blank output seen
    // during rapid Prev/Next/variant switching.
    this.updateUniforms(now);
    this.renderer.render(this.scene, this.camera);
  }
  
  dispose() {
    if (this.material) this.material.dispose();
    if (this.mesh) this.mesh.geometry.dispose();
    if (this.renderer) this.renderer.dispose();
  }
  
  getUniforms() {
    return this.uniforms;
  }
  
  getCanvas() {
    return this.canvas;
  }
}