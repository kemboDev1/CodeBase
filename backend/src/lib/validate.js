import { badRequest } from './errors.js';

/** Required, trimmed, length-capped string. */
export function str(value, field, { max = 2000, min = 1, optional = false, trim = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return '';
    throw badRequest(`${field} bo‘sh bo‘lmasligi kerak.`, 'invalid_field');
  }
  if (typeof value !== 'string') throw badRequest(`${field} matn bo‘lishi kerak.`, 'invalid_field');
  const result = trim ? value.trim() : value;
  if (result.length < min) throw badRequest(`${field} juda qisqa.`, 'invalid_field');
  if (result.length > max) throw badRequest(`${field} juda uzun (maksimal ${max} belgi).`, 'invalid_field');
  return result;
}

export function optionalStr(value, field, options = {}) {
  return str(value, field, { ...options, optional: true });
}

export function num(value, field, { min = -Infinity, max = Infinity, fallback } = {}) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    throw badRequest(`${field} raqam bo‘lishi kerak.`, 'invalid_field');
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw badRequest(`${field} raqam bo‘lishi kerak.`, 'invalid_field');
  return Math.min(max, Math.max(min, parsed));
}

export function bool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1 || value === '1') return true;
  if (value === 'false' || value === 0 || value === '0') return false;
  return fallback;
}

export function oneOf(value, allowed, field, fallback) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    throw badRequest(`${field} qiymati noto‘g‘ri.`, 'invalid_field');
  }
  const normalized = String(value);
  if (!allowed.includes(normalized)) {
    throw badRequest(`${field} quyidagilardan biri bo‘lishi kerak: ${allowed.join(', ')}`, 'invalid_field');
  }
  return normalized;
}

/** Plain object with only the allowed keys, JSON-safe. */
export function pick(source, keys) {
  const out = {};
  if (!source || typeof source !== 'object') return out;
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

/** String→string map from either an object or `KEY=VALUE` lines. */
export function envMap(value, field = 'env') {
  if (value === undefined || value === null || value === '') return {};
  const out = {};
  if (typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, val] of Object.entries(value)) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = String(val ?? '');
    }
    return out;
  }
  if (typeof value === 'string') {
    for (const line of value.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const index = trimmed.indexOf('=');
      if (index < 0) throw badRequest(`${field} qatori "KEY=VALUE" ko‘rinishida bo‘lishi kerak: ${trimmed}`, 'invalid_field');
      const key = trimmed.slice(0, index).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw badRequest(`${field} kaliti noto‘g‘ri: ${key}`, 'invalid_field');
      out[key] = trimmed.slice(index + 1).trim();
    }
    return out;
  }
  throw badRequest(`${field} obyekt yoki matn bo‘lishi kerak.`, 'invalid_field');
}

/** Array of trimmed strings from an array or a newline separated string. */
export function stringList(value, field, { max = 200, itemMax = 400 } = {}) {
  if (value === undefined || value === null || value === '') return [];
  const source = Array.isArray(value) ? value : String(value).split(/\r?\n/);
  const out = source
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .slice(0, max);
  for (const item of out) {
    if (item.length > itemMax) throw badRequest(`${field} elementi juda uzun.`, 'invalid_field');
  }
  return out;
}
