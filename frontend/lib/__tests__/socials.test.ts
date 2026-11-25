import { describe, expect, it } from 'vitest';
import {
  getPlatform,
  isHttpUrl,
  normalizeSocialValue,
  SOCIAL_PLATFORMS,
  type SocialPlatform,
} from '@/lib/socials';

const handleCases: Array<[string, string, string]> = [
  ['twitter', 'creator', 'https://x.com/creator'],
  ['instagram', 'creator', 'https://instagram.com/creator'],
  ['youtube', 'mychannel', 'https://www.youtube.com/@mychannel'],
  ['tiktok', 'myuser', 'https://www.tiktok.com/@myuser'],
  ['github', 'creator', 'https://github.com/creator'],
  ['linkedin', 'in/creator', 'https://linkedin.com/in/creator'],
  ['telegram', 'creator', 'https://t.me/creator'],
];

const platform = (key: string): SocialPlatform => {
  const found = getPlatform(key);
  if (!found) throw new Error(`Missing platform: ${key}`);
  return found;
};

describe('normalizeSocialValue', () => {
  it.each(handleCases)('adds the %s prefix to a bare handle', (key, handle, expected) => {
    expect(normalizeSocialValue(platform(key), handle)).toBe(expected);
  });

  it.each(handleCases)('adds the %s prefix once when the handle starts with @', (key, handle, expected) => {
    expect(normalizeSocialValue(platform(key), `@${handle}`)).toBe(expected);
  });

  it('adds https to a bare Website domain', () => {
    expect(normalizeSocialValue(platform('website'), 'example.com')).toBe('https://example.com');
  });

  it.each(SOCIAL_PLATFORMS)('keeps a pasted URL verbatim for $key', ({ key }) => {
    const pasted = 'https://example.com/social?ref=creator';
    expect(normalizeSocialValue(platform(key), pasted)).toBe(pasted);
  });

  it.each(SOCIAL_PLATFORMS)('returns an empty string for empty $key input', ({ key }) => {
    expect(normalizeSocialValue(platform(key), '')).toBe('');
    expect(normalizeSocialValue(platform(key), '   ')).toBe('');
  });

  it('trims whitespace around a handle before normalizing', () => {
    expect(normalizeSocialValue(platform('youtube'), '  @mychannel  ')).toBe(
      'https://www.youtube.com/@mychannel',
    );
    expect(normalizeSocialValue(platform('tiktok'), '  myuser  ')).toBe(
      'https://www.tiktok.com/@myuser',
    );
  });
});

describe('getPlatform', () => {
  it.each(SOCIAL_PLATFORMS)('finds the $key platform definition', (expected) => {
    expect(getPlatform(expected.key)).toEqual(expected);
  });

  it('returns undefined for an unknown key', () => {
    expect(getPlatform('unknown')).toBeUndefined();
  });
});

describe('isHttpUrl', () => {
  it.each(['https://example.com', 'http://example.com/path'])('accepts %s', (value) => {
    expect(isHttpUrl(value)).toBe(true);
  });

  it.each(['javascript:alert(1)', 'data:text/html,hello', 'my site', 'https://'])('rejects %s', (value) => {
    expect(isHttpUrl(value)).toBe(false);
  });
});
