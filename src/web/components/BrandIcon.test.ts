import { describe, expect, it } from 'vitest';
import { getBrand } from './BrandIcon.js';

describe('getBrand', () => {
  it('detects simple prefixed model names', () => {
    expect(getBrand('claude-opus-4-6')?.name).toBe('Anthropic');
    expect(getBrand('gpt-4o-mini')?.name).toBe('OpenAI');
  });

  it('detects brand for regex and wrapped model patterns', () => {
    expect(getBrand('re:^claude-(opus|sonnet)-4-5$')?.name).toBe('Anthropic');
    expect(getBrand('[Summer] gpt-5.2-codex')?.name).toBe('OpenAI');
  });

  it('detects brand from namespaced model paths', () => {
    expect(getBrand('openrouter/anthropic/claude-3-7-sonnet')?.name).toBe('Anthropic');
    expect(getBrand('openrouter/google/gemini-2.5-pro')?.name).toBe('Google');
  });

  it('returns null for unknown model names', () => {
    expect(getBrand('totally-unknown-model')).toBeNull();
  });
});
