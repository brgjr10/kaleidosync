/**
 * Sketch Engine - Loads catalog, manages sketch/variant selection, handles bool tween uniforms
 * ES Module version for renderer process
 */

import { generateVariant, buildVariantInterpolator } from './variant-utils.js';

// Keys the engine itself generates. A boolean uniform whose name ends in one of
// these suffixes is already a tween helper, not a shader uniform to augment.
const TWEEN_KEY_PATTERN = /(Tween|TweenProgress)$/;

export class SketchEngine {
  constructor() {
    this.catalog = null;
    this.currentSketch = null;
    this.currentVariantIndex = 0;
    this.currentUniforms = {};
    this.tweening = false;
    this.tweenInterpolator = null;
    this.tweenStartTime = 0;
    this.tweenDuration = 1000;
    this.shuffleVariants = false;
    this.shuffleInterval = null;
    this.magicInterval = null;
  }
  
  async loadCatalog() {
    try {
      // Use IPC to get catalog from main process (works with file:// protocol)
      console.log('[SketchEngine] Loading catalog via IPC...');
      this.catalog = await window.kaleidosync.sketches.getCatalog();
      console.log('[SketchEngine] Catalog loaded:', this.catalog?.count, 'sketches');
    } catch (err) {
      console.error('[SketchEngine] Failed to load catalog:', err);
    }
  }
  
  getCatalog() {
    return this.catalog;
  }
  
  getSketches() {
    return this.catalog?.sketches || [];
  }
  
  selectSketch(index) {
    const sketches = this.getSketches();
    if (index < 0 || index >= sketches.length) return false;
    
    const sketch = sketches[index];
    this.currentSketch = sketch;
    this.currentVariantIndex = 0;
    this.currentUniforms = this.cloneVariant(sketch.variants[0]);
    this.tweening = false;
    
    // Add bool tween uniforms for boolean uniforms
    this.augmentUniformsWithTweens();
    
    console.log(`[SketchEngine] Selected sketch ${index}: ${sketch.id}`);
    return true;
  }
  
  selectSketchById(id) {
    const sketches = this.getSketches();
    const index = sketches.findIndex(s => s.id === id);
    if (index !== -1) {
      return this.selectSketch(index);
    }
    return false;
  }
  
  selectNextSketch() {
    if (!this.currentSketch) return false;
    const sketches = this.getSketches();
    const currentIndex = sketches.findIndex(s => s.id === this.currentSketch.id);
    const nextIndex = (currentIndex + 1) % sketches.length;
    return this.selectSketch(nextIndex);
  }
  
  selectPreviousSketch() {
    if (!this.currentSketch) return false;
    const sketches = this.getSketches();
    const currentIndex = sketches.findIndex(s => s.id === this.currentSketch.id);
    const prevIndex = (currentIndex - 1 + sketches.length) % sketches.length;
    return this.selectSketch(prevIndex);
  }
  
  selectRandomSketch() {
    const sketches = this.getSketches();
    const randomIndex = Math.floor(Math.random() * sketches.length);
    return this.selectSketch(randomIndex);
  }
  
  selectVariant(variantIndex) {
    if (!this.currentSketch) return false;
    const variants = this.currentSketch.variants;
    if (variantIndex < 0 || variantIndex >= variants.length) return false;
    
    const targetVariant = this.cloneVariant(variants[variantIndex]);
    this.tweenTo(targetVariant);
    this.currentVariantIndex = variantIndex;
    return true;
  }
  
  selectNextVariant() {
    if (!this.currentSketch) return false;
    const variants = this.currentSketch.variants;
    const nextIndex = (this.currentVariantIndex + 1) % variants.length;
    return this.selectVariant(nextIndex);
  }
  
  selectPreviousVariant() {
    if (!this.currentSketch) return false;
    const variants = this.currentSketch.variants;
    const prevIndex = (this.currentVariantIndex - 1 + variants.length) % variants.length;
    return this.selectVariant(prevIndex);
  }
  
  tweenTo(targetVariant, duration = 1000) {
    // Initialize Tween/TweenProgress for boolean uniforms. Only consider
    // genuine shader uniforms: skipping keys that are themselves generated
    // tween helpers stops the set from growing (warpTween -> warpTweenTween ->
    // ...) on every successive tween.
    for (const [key, value] of Object.entries(this.currentUniforms)) {
      if (typeof value !== 'boolean' || TWEEN_KEY_PATTERN.test(key)) continue;

      const tweenKey = `${key}Tween`;
      const progressKey = `${key}TweenProgress`;

      // Set up initial state: Tween = from value, TweenProgress = 0
      this.currentUniforms[tweenKey] = value;
      this.currentUniforms[progressKey] = 0;

      // Set target state in targetVariant
      if (targetVariant[key] !== undefined) {
        targetVariant[tweenKey] = targetVariant[key];
        targetVariant[progressKey] = 1;
      }
    }
    
    this.tweenInterpolator = buildVariantInterpolator(this.currentUniforms, targetVariant);
    this.tweening = true;
    this.tweenStartTime = performance.now();
    this.tweenDuration = duration;
  }
  
  updateTween(now) {
    if (!this.tweening || !this.tweenInterpolator) return null;
    
    const elapsed = now - this.tweenStartTime;
    const progress = Math.min(1, elapsed / this.tweenDuration);
    
    const nextUniforms = this.tweenInterpolator(progress);
    this.currentUniforms = nextUniforms;
    
    // Ensure TweenProgress is updated for bool uniforms during tween
    for (const [key, value] of Object.entries(this.currentUniforms)) {
      if (typeof value === 'boolean' && !TWEEN_KEY_PATTERN.test(key)) {
        const progressKey = `${key}TweenProgress`;
        if (this.currentUniforms[progressKey] !== undefined) {
          this.currentUniforms[progressKey] = progress;
        }
      }
    }
    
    if (progress >= 1) {
      this.tweening = false;
      this.tweenInterpolator = null;
    }
    
    // Return the interpolated uniform values so the renderer can push them to
    // the material every frame without rebuilding shaders.
    return this.getCurrentUniforms();
  }
  
  augmentUniformsWithTweens() {
    // For every boolean uniform, ensure Tween and TweenProgress exist. Ignore
    // generated tween helpers so repeated calls cannot compound the set.
    for (const [key, value] of Object.entries(this.currentUniforms)) {
      if (typeof value === 'boolean' && !TWEEN_KEY_PATTERN.test(key)) {
        if (this.currentUniforms[`${key}Tween`] === undefined) {
          this.currentUniforms[`${key}Tween`] = value;
        }
        if (this.currentUniforms[`${key}TweenProgress`] === undefined) {
          this.currentUniforms[`${key}TweenProgress`] = 0;
        }
      }
    }
  }
  
  // Magic/random variant generation
  magicTween(duration = 500, temp = 0.7) {
    if (!this.currentSketch) return;
    const source = this.currentSketch.variants[this.currentVariantIndex];
    const target = generateVariant(source, temp);
    this.tweenTo(target, duration);
  }
  
  startMagicInterval() {
    this.stopMagicInterval();
    this.magicInterval = setInterval(() => {
      this.magicTween(3000, 0.25);
    }, 3100);
  }
  
  stopMagicInterval() {
    if (this.magicInterval) {
      clearInterval(this.magicInterval);
      this.magicInterval = null;
    }
  }
  
  // Shuffle variants
  toggleShuffleVariants() {
    this.shuffleVariants = !this.shuffleVariants;
    if (this.shuffleVariants) {
      this.startShuffleInterval();
    } else {
      this.stopShuffleInterval();
    }
    return this.shuffleVariants;
  }
  
  startShuffleInterval() {
    this.stopShuffleInterval();
    this.shuffleInterval = setInterval(() => {
      this.selectNextVariant();
    }, 3050);
  }
  
  stopShuffleInterval() {
    if (this.shuffleInterval) {
      clearInterval(this.shuffleInterval);
      this.shuffleInterval = null;
    }
  }
  
  // Get current state for renderer
  getCurrentShader() {
    return this.currentSketch ? this.currentSketch.shader : '';
  }
  
  getCurrentUniforms() {
    // Convert to format expected by renderer (value objects)
    const result = {};
    for (const [key, value] of Object.entries(this.currentUniforms)) {
      result[key] = { value };
    }
    return result;
  }
  
  getCurrentVariantIndex() {
    return this.currentVariantIndex;
  }
  
  getCurrentSketch() {
    return this.currentSketch;
  }
  
  getVariantList() {
    return this.currentSketch ? this.currentSketch.variants : [];
  }
  
  isTweening() {
    return this.tweening;
  }
  
  cloneVariant(variant) {
    const result = {};
    for (const [key, value] of Object.entries(variant)) {
      if (Array.isArray(value)) {
        result[key] = [...value];
      } else {
        result[key] = value;
      }
    }
    return result;
  }
  
  // For UI
  getSketchList() {
    return this.getSketches().map((s, i) => ({
      index: i,
      id: s.id,
      variantCount: s.variants.length
    }));
  }
}