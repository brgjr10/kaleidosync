/**
 * Variant utilities - ported from @wearesage/vue/src/util/
 * Handles variant interpolation (buildVariantInterpolator) and generation (generateVariant)
 */

import { interpolateNumber } from 'd3-interpolate';

const INTEGER_KEYS = ['sides'];
const LOW_KEYS = ['contrast', 'ballSize', 'orbSize', 'multiplier', 'brightness', 'colorSpread', 'glow'];
const MED_KEYS = ['iterator'];
const HIGH_KEYS = ['radius', 'zoom', 'colorMultiplier', 'colorSpread'];

function getTemp(key, temp = 0.7) {
  if (LOW_KEYS.includes(key)) return temp / 8;
  if (MED_KEYS.includes(key)) return temp / 3;
  if (HIGH_KEYS.includes(key)) return temp / 1.5;
  return temp;
}

function isIntegerKey(key) {
  return INTEGER_KEYS.includes(key);
}

function getMin(key, n, temp = 0.7) {
  if (isIntegerKey(key)) return 1;
  return n - getTemp(key, temp) * n;
}

function getMax(key, n, temp = 0.7) {
  if (isIntegerKey(key)) return 12;
  return n + getTemp(key, temp) * n;
}

function getStep(key, _n) {
  return isIntegerKey(key) ? 1 : 0;
}

function toPrecision(val, precision = 5) {
  return Number(val.toFixed(precision));
}

function randomNumber(min, max) {
  return min + Math.random() * (max - min);
}

/**
 * Generate a random variant based on a source variant
 * @param {Object} source - Source variant { key: value }
 * @param {number} temp - Temperature for randomness (0-1)
 * @returns {Object} New variant
 */
export function generateVariant(source, temp = 0.7) {
  const result = {};

  for (const [key, value] of Object.entries(source)) {
    const val = value;

    switch (typeof val) {
      case 'object':
        // Currently only colors (vec3)
        if (Array.isArray(val)) {
          result[key] = [
            toPrecision(Math.random(), 3),
            toPrecision(Math.random(), 3),
            toPrecision(Math.random(), 3)
          ];
        } else {
          result[key] = val;
        }
        break;
      case 'boolean':
        // Don't tween bools
        result[key] = val;
        break;
      case 'number':
        // Don't tween ints
        if (getStep(key, val) === 1) {
          result[key] = val;
        } else {
          const min = getMin(key, val, temp);
          const max = getMax(key, val, temp);
          const newVal = randomNumber(min, max);
          result[key] = toPrecision(newVal, 5);
        }
        break;
      default:
        result[key] = val;
    }
  }

  return result;
}

/**
 * Build an interpolator function between two variants
 * @param {Object} from - Source variant
 * @param {Object} to - Target variant
 * @returns {Function} Interpolator function (progress: 0-1) => variant
 */
export function buildVariantInterpolator(from, to) {
  const fromKeys = Object.keys(from);
  const toKeys = Object.keys(to);

  if (fromKeys.length !== toKeys.length || !fromKeys.every((key, i) => key === toKeys[i])) {
    console.warn('[VariantUtils] TWEEN ERROR - Both variants must have the same keys.');
  }

  const interpolators = {};

  for (const key of fromKeys) {
    const fromVal = from[key];
    const toVal = to[key];

    if (Array.isArray(fromVal) && Array.isArray(toVal)) {
      // vec2/vec3 interpolation
      const interpolatorsArr = fromVal.map((v, i) => interpolateNumber(v, toVal[i]));
      interpolators[key] = (t) => interpolatorsArr.map(interp => toPrecision(interp(t)));
    } else if (typeof fromVal === 'number' && typeof toVal === 'number') {
      const interp = interpolateNumber(fromVal, toVal);
      interpolators[key] = (t) => toPrecision(interp(t));
    } else if (typeof fromVal === 'boolean') {
      // Smooth bool interpolation for k_swap style uniforms
      // Use smoothstep for smoother transition instead of hard snap
      interpolators[key] = (t) => t >= 1 ? toVal : fromVal;
    } else {
      // Fallback
      interpolators[key] = (t) => t >= 1 ? toVal : fromVal;
    }
  }

  // Add Tween and TweenProgress interpolators for bool uniforms
  // These are used by the shader for smooth boolean transitions
  for (const key of fromKeys) {
    const fromVal = from[key];
    if (typeof fromVal === 'boolean') {
      const tweenKey = `${key}Tween`;
      const progressKey = `${key}TweenProgress`;
      if (tweenKey in from && tweenKey in to) {
        // Tween is bool - don't interpolate, just use target
        interpolators[tweenKey] = (t) => t >= 1 ? to[tweenKey] : from[tweenKey];
      }
      if (progressKey in from && progressKey in to) {
        // TweenProgress is float - interpolate smoothly
        const interp = interpolateNumber(from[progressKey], to[progressKey]);
        interpolators[progressKey] = (t) => toPrecision(interp(t));
      }
    }
  }

  return (progress) => {
    const result = {};
    for (const key of fromKeys) {
      if (interpolators[key]) {
        result[key] = interpolators[key](progress);
      }
    }
    return result;
  };
}

/**
 * Simple interpolation helper for direct use
 * @param {Object} from - Source variant
 * @param {Object} to - Target variant
 * @param {number} progress - 0 to 1
 * @returns {Object} Interpolated variant
 */
export function interpolateVariants(from, to, progress) {
  const interpolator = buildVariantInterpolator(from, to);
  return interpolator(progress);
}

export const uniformRangeUtils = { getMin, getMax, getStep };