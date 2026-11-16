import os
os.chdir('/home/brgjr10/Projects/kaleidosync-tm')

shader = r'''
// kaleidosync — default kaleidoscope shader (Shadertoy format)
// Uniforms injected by the harness: iResolution, iTime, iStream, iVolume

#ifdef GL_ES
precision mediump float;
#endif

#define PI 3.14159265359
#define TWO_PI 6.28318530718

// kaleidoscope polar mapping (from @wearesage glsl-util k_kale)
vec2 k_kale(vec2 uv, vec2 offset, float sides) {
  float angle = atan(uv.y, uv.x);
  angle = ((angle / PI) + 1.0) * 0.5;
  angle = mod(angle, 1.0 / sides) * sides;
  angle = -abs(2.0 * angle - 1.0) + 1.0;
  float y = length(uv);
  angle = angle * (y);
  return vec2(angle, y) - offset;
}

// radial orb (from @wearesage glsl-util k_orb)
vec4 k_orb(vec2 uv, float size, vec2 position, vec3 color, float contrast) {
  return pow(vec4(size / length(uv + position) * color, 1.), vec4(contrast));
}

// rainbow palette (from @wearesage glsl-util k_rainbow)
vec3 k_rainbow(float progress, float stretch, float offset) {
  return vec3(cos(vec3(-2, 0, -1) * PI * 2. / 3. + TWO_PI * (progress * stretch) + offset) * 0.5 + 0.5);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = (fragCoord.xy - 0.5 * iResolution.xy) / iResolution.y;

  // Kaleidoscope: fold the plane into N sectors
  float sides = 6.0;
  uv = k_kale(uv, vec2(0.0), sides);

  // Rotate over time, speed tied to iStream (the music-driven counter)
  float rot = iTime * 0.15 + iStream * 0.05;
  uv = mat2(cos(rot), -sin(rot), sin(rot), cos(rot)) * uv;

  // Distance from center drives orb size
  float d = length(uv);
  float pulse = 0.5 + 0.5 * sin(iStream * 2.0);

  // Color cycles with iTime and iVolume
  vec3 col = k_rainbow(iTime * 0.1 + iVolume * 0.5, 1.0, 0.0);

  // Orb glow
  vec4 orb = k_orb(uv, 0.3 + iVolume * 0.2 + pulse * 0.1, vec2(0.0), col, 1.5);

  // Kaleidoscope edge glow
  float edge = smoothstep(0.0, 0.08, d);
  vec3 edgeCol = k_rainbow(iTime * 0.2 + iStream * 0.02, 2.0, PI);

  vec3 finalCol = mix(edgeCol * edge, orb.rgb, orb.a);
  finalCol *= 0.6 + iVolume * 0.8;

  fragColor = vec4(finalCol, 1.0);
}
'''
with open('shader-source.frag.glsl', 'w') as f: f.write(shader)
print('wrote shader-source.frag.glsl', len(shader.splitlines()), 'lines')