import fs from 'node:fs/promises';
import { resolveFromCwd } from '../utils.js';

export async function loadRules(config) {
  return JSON.parse(await fs.readFile(resolveFromCwd(config.rulesPath), 'utf8'));
}

export function extractAttributes(listing, rules) {
  const normalizedSpecs = normalizeSpecs(listing.specifications);
  const auto = {};

  setIf(auto, 'brand', listing.brand || findBySynonym(normalizedSpecs, rules.attributeSynonyms.brand));
  setIf(auto, 'model', listing.model || findBySynonym(normalizedSpecs, rules.attributeSynonyms.model));
  setIf(auto, 'material', findBySynonym(normalizedSpecs, rules.attributeSynonyms.material));
  setIf(auto, 'ingredients', findBySynonym(normalizedSpecs, rules.attributeSynonyms.ingredients));
  setIf(auto, 'size', findBySynonym(normalizedSpecs, rules.attributeSynonyms.size));
  setIf(auto, 'weight', findBySynonym(normalizedSpecs, rules.attributeSynonyms.weight));
  setIf(auto, 'color', findBySynonym(normalizedSpecs, rules.attributeSynonyms.color));
  setIf(auto, 'countryOfOrigin', findBySynonym(normalizedSpecs, rules.attributeSynonyms.countryOfOrigin));
  setIf(auto, 'expiryDate', findBySynonym(normalizedSpecs, rules.attributeSynonyms.expiryDate));
  setIf(auto, 'capacity', findBySynonym(normalizedSpecs, rules.attributeSynonyms.capacity));

  const warnings = detectWarnings(listing, rules);
  const required = requiredForListing(listing, rules);
  const missing = required.filter((key) => !auto[key]);
  const needsReview = Object.entries(auto)
    .filter(([key]) => ['ingredients', 'expiryDate', 'countryOfOrigin'].includes(key))
    .map(([key, value]) => ({ key, value, reason: 'Regulated or compliance-sensitive attribute. Human confirmation required.' }));

  const specificationDefaults = buildSpecificationDefaults(listing, rules);

  return { auto, missing, needsReview, warnings, specificationDefaults };
}

export function mapAttributesToShopeeFields(detectedFields, extracted) {
  const filled = [];
  const unfilled = [];

  for (const field of detectedFields) {
    const key = guessAttributeKey(field.label);
    const value = extracted.auto[key];
    if (value && field.editable) {
      filled.push({ ...field, key, value });
    } else {
      unfilled.push({ ...field, key, reason: value ? 'Field was not editable' : 'No matching Amazon value' });
    }
  }

  return { filled, unfilled };
}

function normalizeSpecs(specs = {}) {
  return Object.fromEntries(
    Object.entries(specs).map(([key, value]) => [key.toLowerCase().trim(), String(value).trim()])
  );
}

function findBySynonym(specs, synonyms = []) {
  for (const [key, value] of Object.entries(specs)) {
    if (synonyms.some((synonym) => key.includes(synonym.toLowerCase()))) return value;
  }
  return '';
}

function setIf(target, key, value) {
  if (value) target[key] = value;
}

function detectWarnings(listing, rules) {
  const haystack = `${listing.title} ${listing.description} ${JSON.stringify(listing.specifications)}`.toLowerCase();
  return rules.restrictedKeywords
    .filter((rule) => rule.keywords.some((keyword) => haystack.includes(keyword.toLowerCase())))
    .map((rule) => ({ name: rule.name, warning: rule.warning }));
}

function requiredForListing(listing, rules) {
  const haystack = `${listing.title} ${listing.description}`.toLowerCase();
  const matched = rules.categoryRules
    .filter((rule) => rule.matchKeywords.some((keyword) => haystack.includes(keyword.toLowerCase())))
    .flatMap((rule) => rule.requiredAttributes);
  return Array.from(new Set(matched));
}

export function applyCategoryDefaults(extracted, categoryText, rules) {
  const defaults = buildSpecificationDefaultsForText(categoryText, rules);
  return {
    ...extracted,
    specificationDefaults: {
      ...(extracted.specificationDefaults || {}),
      ...defaults
    }
  };
}

function buildSpecificationDefaults(listing, rules) {
  const haystack = `${listing.title} ${listing.description} ${JSON.stringify(listing.specifications)}`.toLowerCase();
  return buildSpecificationDefaultsForText(haystack, rules);
}

function buildSpecificationDefaultsForText(text, rules) {
  const haystack = String(text || '').toLowerCase();
  const defaults = {};
  for (const rule of rules.specificationDefaults || []) {
    const matched = (rule.matchCategoryKeywords || []).some((keyword) => haystack.includes(keyword.toLowerCase()));
    if (matched) Object.assign(defaults, rule.defaults || {});
  }
  return defaults;
}

function guessAttributeKey(label = '') {
  const lower = label.toLowerCase();
  if (/brand|ブランド/.test(lower)) return 'brand';
  if (/model|型番|品番/.test(lower)) return 'model';
  if (/material|素材|材質/.test(lower)) return 'material';
  if (/ingredient|成分|原材料/.test(lower)) return 'ingredients';
  if (/size|dimension|サイズ|寸法/.test(lower)) return 'size';
  if (/weight|重量/.test(lower)) return 'weight';
  if (/colo(u)?r|色|カラー/.test(lower)) return 'color';
  if (/origin|原産国/.test(lower)) return 'countryOfOrigin';
  if (/expiry|expiration|賞味期限|使用期限/.test(lower)) return 'expiryDate';
  if (/capacity|volume|容量/.test(lower)) return 'capacity';
  return lower.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}
