/* kaleidosync — GLSL utilities (ported from @wearesage/vue constants/glsl-util.ts) */
(function (global) {
  "use strict";

  var K_HUE = `
vec4 k_hue(vec4 color, float shift) {
  float I = dot(color, vec4(0.596, -0.275, -0.321, 0.0));
  float Q = dot(color, vec4(0.212, -0.523, 0.311, 0.0));
  float hue = atan(Q, I);
  float chroma = sqrt(I * I + Q * Q);
  hue += shift;
  Q = chroma * sin(hue);
  I = chroma * cos(hue);
  vec4 yIQ = vec4(dot(color, vec4(0.299, 0.587, 0.114, 0.0)), I, Q, 0.0);
  color.r = dot(yIQ, vec4(1.0, 0.956, 0.621, 0.0));
  color.g = dot(yIQ, vec4(1.0, -0.272, -0.647, 0.0));
  color.b = dot(yIQ, vec4(1.0, -1.107, 1.704, 0.0));
  return color;
}
`;

  var K_KALE = `
vec2 k_kale(vec2 uv, vec2 offset, float sides) {
  float angle = atan(uv.y, uv.x);
  angle = ((angle / 3.14159265359) + 1.0) * 0.5;
  angle = mod(angle, 1.0 / sides) * sides;
  angle = -abs(2.0 * angle - 1.0) + 1.0;
  float y = length(uv);
  angle = angle * (y);
  return vec2(angle, y) - offset;
}
`;

  var K_ORB = `
vec4 k_orb(vec2 uv, float size, vec2 position, vec3 color, float contrast) {
  return pow(vec4(size / length(uv + position) * color, 1.), vec4(contrast));
}
`;

  var K_RAINBOW = `
vec3 k_rainbow(float progress, float stretch, float offset) {
  return vec3(cos(vec3(-2, 0, -1) * 3.14159265359 * 2. / 3. + (2. * 3.14159265359) * (progress * stretch) + offset) * 0.5 + 0.5);
}
`;

  var K_ROTATE2D = `
mat2 k_rotate2d(float angle) {
  return mat2(cos(angle), -sin(angle), sin(angle), cos(angle));
}
`;

  var K_SPHERE = `
vec2 k_sphere (vec3 pos) {
  float theta = atan(pos.z, pos.x);
  float phi = acos(pos.y);
  float u = (theta + 3.14159265359) / (2.0 * 3.14159265359);
  float v = phi / 3.14159265359;
  return vec2(u, v);
}
`;

  var K_UV_TO_SPHERE = `
vec3 k_uv_to_sphere(vec2 uv) {
  float theta = uv.x * 6.28318530718;
  float phi = uv.y * 3.14159265359;
  float x = sin(phi) * cos(theta);
  float y = cos(phi);
  float z = sin(phi) * sin(theta);
  return vec3(x, y, z);
}
`;

  var K_SWAP = `
vec2 k_swap(vec2 uv, vec2 uv2, bool val, bool valTween, float valTweenProgress) {
  return valTween
    ? (val ? mix(uv, uv2, valTweenProgress) : mix(uv2, uv, valTweenProgress))
    : (val ? uv2 : uv);
}
`;

  var K_UV = `
vec2 k_uv() {
  vec2 uv = 2.0 * vUv - 1.0;
  uv.x *= resolution.x / resolution.y;
  return uv;
}
`;

  global.KaleidoGLSL = {
    k_hue: K_HUE, k_kale: K_KALE, k_orb: K_ORB, k_rainbow: K_RAINBOW,
    k_rotate2d: K_ROTATE2D, k_sphere: K_SPHERE, k_uv_to_sphere: K_UV_TO_SPHERE, k_swap: K_SWAP, k_uv: K_UV,
    all: [K_HUE, K_KALE, K_ORB, K_RAINBOW, K_ROTATE2D, K_SPHERE, K_UV_TO_SPHERE, K_SWAP, K_UV].join("\n"),
  };
})(typeof window !== "undefined" ? window : this);
