import os
os.chdir('/home/brgjr10/Projects/kaleidosync-tm')

renderer = r'''/* kaleidosync — shader harness + render loop
 *
 * Ports @wearesage/vue useShader.ts + Renderer.vue. Vanilla JS, no deps beyond
 * Three.js. Reused by both the Tampermonkey script and the standalone app.
 */
(function (global) {
  "use strict";

  function KaleidoRenderer(opts) {
    opts = opts || {};
    this.canvas = opts.canvas || null;
    this.shader = opts.shader || "";
    this.utils = opts.utils || "";
    this._uniforms = {};
    this._material = null;
    this._mesh = null;
    this._scene = null;
    this._camera = null;
    this._renderer = null;
    this._width = 0;
    this._height = 0;
    this._dpr = 1;
    this._initialized = false;
  }

  KaleidoRenderer.prototype._ensureContext = function () {
    if (this._initialized) return;
    if (!this.canvas || typeof THREE === "undefined") return;
    this._renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, alpha: false });
    this._renderer.setPixelRatio(this._dpr);
    this._scene = new THREE.Scene();
    this._camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    this._camera.position.set(0, 0, 1);

    var geometry = new THREE.PlaneGeometry(2, 2);
    this._material = new THREE.ShaderMaterial({
      side: 0,
      vertexShader: DEFAULT_VERTEX_SHADER,
      fragmentShader: "",
      uniforms: this._uniforms,
    });
    this._mesh = new THREE.Mesh(geometry, this._material);
    this._scene.add(this._mesh);
    this._resize();
    this._initialized = true;
    this._rebuildShader();
  };

  KaleidoRenderer.prototype._resize = function () {
    if (!this._renderer || !this.canvas) return;
    var w = this.canvas.clientWidth || window.innerWidth;
    var h = this.canvas.clientHeight || window.innerHeight;
    this._width = w;
    this._height = h;
    this._dpr = window.devicePixelRatio || 1;
    this._renderer.setSize(w, h, false);
    this._camera.aspect = w / h;
    this._camera.updateProjectionMatrix();
  };

  KaleidoRenderer.prototype._buildUniformDeclarations = function () {
    var keys = Object.keys(this._uniforms);
    var decl = "";
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var v = this._uniforms[key].value;
      if (Array.isArray(v)) {
        if (v.length === 2) decl += "\nuniform vec2 " + key + ";";
        else decl += "\nuniform vec3 " + key + ";";
      } else if (typeof v === "number") {
        decl += "\nuniform float " + key + ";";
      } else if (typeof v === "boolean") {
        decl += "\nuniform bool " + key + ";";
      }
    }
    return decl;
  };

  KaleidoRenderer.prototype._wrapShader = function (code) {
    if (/void\s+mainImage\s*\(\s*out\s+vec4\s+\w+\s*,\s*in\s+vec2\s+\w+\s*\)/.test(code)) {
      return code + "\nvoid main() {\n  mainImage(gl_FragColor, gl_FragCoord.xy);\n}";
    }
    return code;
  };

  KaleidoRenderer.prototype._rebuildShader = function () {
    if (!this._material) return;
    var decls = this._buildUniformDeclarations();
    var code = this.shader || DEFAULT_FRAGMENT_SHADER;
    var full = DEFS + decls + this.utils + this._wrapShader(code);
    if (full !== this._material.fragmentShader) {
      this._material.fragmentShader = full;
      this._material.needsUpdate = true;
    }
  };

  KaleidoRenderer.prototype.setShader = function (code) {
    this.shader = code || "";
    this._rebuildShader();
  };

  KaleidoRenderer.prototype.setUniform = function (key, value) {
    this._uniforms[key] = { value: value };
    this._rebuildShader();
  };

  KaleidoRenderer.prototype.update = function (now, stream, volume) {
    this._ensureContext();
    if (!this._material) return;
    var w = this._width || window.innerWidth;
    var h = this._height || window.innerHeight;
    var dpr = this._dpr;
    var time = now / 1000;

    this._uniforms.resolution.value = [w * dpr, h * dpr];
    this._uniforms.time.value = time;
    this._uniforms.stream.value = stream;
    this._uniforms.volume.value = volume;

    this._uniforms.iResolution.value = [w * dpr, h * dpr, (w * dpr) / (h * dpr)];
    this._uniforms.iTime.value = time;
    this._uniforms.iStream.value = stream;
    this._uniforms.iVolume.value = volume;

    this._renderer.render(this._scene, this._camera);
  };

  KaleidoRenderer.prototype.resize = function () {
    this._resize();
  };

  var DEFS = [
    "precision highp float;",
    "#define PI 3.14159265359",
    "#define TWO_PI 2. * PI",
    "varying vec2 vUv;",
  ].join("\n");

  var DEFAULT_VERTEX_SHADER = [
    "void main() {",
    "  vUv = uv;",
    "  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);",
    "}",
  ].join("\n");

  var DEFAULT_FRAGMENT_SHADER = "void main () { gl_FragColor = vec4(.8, .2, .6, 1.); }";

  global.KaleidoRenderer = KaleidoRenderer;
  global.KaleidoDefaults = { DEFS: DEFS, DEFAULT_VERTEX_SHADER: DEFAULT_VERTEX_SHADER, DEFAULT_FRAGMENT_SHADER: DEFAULT_FRAGMENT_SHADER };
})(typeof window !== "undefined" ? window : this);
'''
with open('renderer.js', 'w') as f: f.write(renderer)
print('wrote renderer.js', len(renderer.splitlines()), 'lines')