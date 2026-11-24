import { describe, it, expect } from 'vitest';
import { docsUrl } from './version';

describe('bundled documentation URLs', () => {
  it('opens the product guide without a remote host or release-series dependency', () => {
    expect(docsUrl()).toBe('/docs');
  });

  it('normalizes page links while retaining section anchors', () => {
    expect(docsUrl('change-guard/#settings')).toBe('/docs/change-guard#settings');
    expect(docsUrl('/change-guard/')).toBe('/docs/change-guard');
  });

  it('maps the old onboarding page to the product guide', () => {
    expect(docsUrl('/adoption/')).toBe('/docs/router-onboarding');
  });
});
