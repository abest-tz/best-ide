import { describe, expect, it } from 'vitest';
import { resolveReadContent } from '../src/extension/pendingOverlay';

describe('resolveReadContent', () => {
  it('returns pending content when present', () => {
    expect(resolveReadContent('disk', 'staged')).toBe('staged');
  });

  it('returns disk content when no pending overlay', () => {
    expect(resolveReadContent('disk', undefined)).toBe('disk');
  });

  it('treats empty string pending as present overlay', () => {
    expect(resolveReadContent('disk', '')).toBe('');
  });
});
