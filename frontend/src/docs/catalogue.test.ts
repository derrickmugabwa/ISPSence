import { describe, expect, it } from 'vitest';
import { articles, articlePath, extractHeadings, searchArticles } from './catalogue';
import { helpPath } from './helpLinks';

describe('ISPSense documentation content', () => {
  it('ships a source for every navigation entry with unique headings', () => {
    expect(new Set(articles.map(a => a.slug)).size).toBe(articles.length);
    for (const article of articles) {
      expect(article.body.length).toBeGreaterThan(200);
      expect(article.headings.length).toBeGreaterThan(0);
      expect(new Set(article.headings.map(h => h.id)).size).toBe(article.headings.length);
    }
  });
  it('keeps all internal article links and section anchors resolvable', () => {
    for (const article of articles) {
      for (const match of article.body.matchAll(/\]\((\/docs[^)]*)\)/g)) {
        const [path, hash] = match[1].split('#');
        const target = articles.find(a => articlePath(a.slug) === path);
        expect(target, `${article.slug}: ${match[1]}`).toBeDefined();
        if (hash) expect(target?.headings.some(h => h.id === hash)).toBe(true);
      }
    }
  });
  it('searches body text and titles and handles empty and unmatched queries', () => {
    expect(searchArticles('PayHero')[0].slug).toBe('payhero');
    expect(searchArticles('counter resets').some(a => a.slug === 'sessions')).toBe(true);
    expect(searchArticles('  ')).toHaveLength(4);
    expect(searchArticles('zzzznomatchhere')).toEqual([]);
  });
  it('ignores fenced code headings and makes repeated anchors unique', () => {
    expect(extractHeadings('## Setup\n```sh\n## Ignore\n```\n## Setup\n### Verify').map(h => h.id)).toEqual(['setup', 'setup-1', 'verify']);
  });
  it('maps contextual help without matching unrelated URL prefixes', () => {
    expect(helpPath('/billing/customers/12')).toBe('/docs/access-management');
    expect(helpPath('/billing/sessions')).toBe('/docs/sessions');
    expect(helpPath('/billing/packages-unrelated')).toBe('/docs');
    expect(helpPath('/dashboard')).toBe('/docs');
  });
});
