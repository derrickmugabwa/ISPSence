import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import Markdown, { type Components } from 'react-markdown';
import { ArrowLeft, ArrowRight, BookOpen, ChevronDown, ChevronRight, ExternalLink, FileText, Info, Menu, Moon, Network, Search, Settings, ShieldCheck, Sun, Users, Wrench, X } from 'lucide-react';
import { articles, articlePath, searchArticles, sections, type DocArticle, type DocSection } from '../docs/catalogue';
import { useThemeStore } from '../store/themeStore';
import './docs.css';

const groupIcons = new Map<DocSection, ReactNode>([['Start here', <BookOpen key="start" size={17} />], ['Customers & billing', <Users key="billing" size={17} />], ['Network', <Network key="network" size={17} />], ['Integrations', <Settings key="integrations" size={17} />], ['Administration', <ShieldCheck key="admin" size={17} />], ['Technical reference', <FileText key="reference" size={17} />]]);

function DocsNavigation({ slug, close }: { slug: string; close?: () => void }) {
  return <nav aria-label="Documentation navigation" className="docs-navigation">
    {sections.map(section => <NavigationGroup key={section} section={section} slug={slug} close={close} />)}
    <div className="docs-nav-footer">ISPSense documentation<br /><Link to="/docs/feature-readiness" onClick={close}>Current feature readiness <ArrowRight size={13} /></Link></div>
  </nav>;
}

function NavigationGroup({ section, slug, close }: { section: DocSection; slug: string; close?: () => void }) {
  const current = articles.find(a => a.slug === slug)?.section === section;
  return <details className="docs-nav-group" key={`${section}-${current}`} open={current || section === 'Start here' || (slug === 'first-setup' && section === 'Network')}>
    <summary>{groupIcons.get(section)}<span>{section}</span><ChevronRight size={14} className="docs-chevron" /></summary>
    <div className="docs-nav-links">{articles.filter(a => a.section === section).map(article => <Link key={article.slug} to={articlePath(article.slug)} aria-current={slug === article.slug ? 'page' : undefined} onClick={close}>{article.slug === 'first-setup' ? 'First setup' : article.title}</Link>)}</div>
  </details>;
}

function DocsSearch() {
  const dialog = useRef<HTMLDialogElement>(null), input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const navigate = useNavigate();
  const results = searchArticles(query);
  const open = () => { dialog.current?.showModal(); input.current?.focus(); };
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault(); dialog.current?.showModal(); input.current?.focus();
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);
  return <>
    <button className="docs-search-trigger" aria-label="Search documentation" onClick={open}><Search size={18} /><span>Search documentation...</span><kbd>Ctrl K</kbd></button>
    <dialog ref={dialog} className="docs-search-dialog" aria-labelledby="docs-search-title" onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
      <div className="docs-search-box"><Search size={20} /><label id="docs-search-title" className="sr-only" htmlFor="docs-search-input">Search documentation</label><input ref={input} id="docs-search-input" type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search guides, features, or questions…" onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); dialog.current?.close(); } else if (e.key === 'Enter' && results[0]) { e.preventDefault(); navigate(articlePath(results[0].slug)); dialog.current?.close(); } }} /><button className="docs-icon-button" aria-label="Close search" onClick={() => dialog.current?.close()}><X size={18} /></button></div>
      <div className="docs-search-results"><p className="docs-eyebrow" role="status">{query.trim() ? `${results.length} matching guides` : 'Popular guides'}</p>{results.length ? results.map(article => <Link key={article.slug} to={articlePath(article.slug)} onClick={() => dialog.current?.close()}><FileText size={19} /><span><small>{article.section}</small><strong>{article.title}</strong><span>{article.description}</span></span><ArrowRight size={16} /></Link>) : <div className="docs-search-empty"><Search size={24} /><h2>No matching guides</h2><p>Try a shorter phrase, such as “payments”, “usage”, or “router”.</p><button onClick={() => { setQuery(''); input.current?.focus(); }}>Clear search</button></div>}</div>
      <div className="docs-search-hint"><span>Tab to browse · Enter to open</span><span>Esc to close</span></div>
    </dialog>
  </>;
}

const quickLinks = [
  { slug: 'installation', title: 'Set up ISPSense', detail: 'Install and configure your workspace.', Icon: Settings },
  { slug: 'router-onboarding', title: 'Connect a router', detail: 'Prepare Hotspot and PPPoE access.', Icon: Network },
  { slug: 'customers', title: 'Manage customers', detail: 'Create packages and customer accounts.', Icon: Users },
  { slug: 'troubleshooting', title: 'Troubleshoot', detail: 'Find answers to common issues.', Icon: Wrench },
];

function GuideContent({ article }: { article: DocArticle }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [active, setActive] = useState(article.headings[0]?.id ?? '');
  const { hash } = useLocation();
  const index = articles.indexOf(article);
  useEffect(() => {
    const previous = document.title;
    document.title = `${article.title} | ISPSense Docs`;
    if (!window.location.hash) { window.scrollTo(0, 0); heading.current?.focus({ preventScroll: true }); }
    return () => { document.title = previous; };
  }, [article]);
  useEffect(() => {
    if (hash) { try { document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView(); } catch { /* malformed link remains readable */ } }
  }, [hash]);
  useEffect(() => {
    const observer = new IntersectionObserver(entries => {
      const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (visible[0]) setActive(visible[0].target.id);
    }, { rootMargin: '-90px 0px -60% 0px' });
    article.headings.forEach(h => { const element = document.getElementById(h.id); if (element) observer.observe(element); });
    return () => observer.disconnect();
  }, [article]);
  const components = useMemo<Components>(() => {
  const renderHeading = (level: 2 | 3, line: number | undefined, children: ReactNode) => {
    const item = article.headings.find(h => h.line === line);
    const Tag = level === 2 ? 'h2' : 'h3';
    return <Tag id={item?.id}>{children}{item && <a className="docs-heading-anchor" href={`#${item.id}`} aria-label={`Link to ${item.title}`}>#</a>}</Tag>;
  };
  return {
    h2: ({ node, children }) => renderHeading(2, node?.position?.start.line, children),
    h3: ({ node, children }) => renderHeading(3, node?.position?.start.line, children),
    a: ({ href, children }) => href?.startsWith('/docs') ? <Link to={href}>{children}</Link> : <a href={href} {...(href?.startsWith('http') ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{children}</a>,
  };
  }, [article]);
  return <div className="docs-reading-layout">
    <main id="docs-content" className="docs-main">
      <div className="docs-breadcrumb"><Link to={articlePath(articles.find(a => a.section === article.section)!.slug)}>{article.section}</Link><ChevronRight size={13} /><span>{article.slug === 'first-setup' ? 'First setup' : article.title}</span></div>
      <header className="docs-article-header"><h1 ref={heading} tabIndex={-1}>{article.title}</h1><p>{article.description}</p><div className="docs-article-meta"><BookOpen size={16} /><span>{article.section === 'Start here' ? 'Getting started guide' : article.section}</span>{article.status && <span className="docs-readiness">{article.status}</span>}</div></header>
      {article.slug === 'first-setup' && <><div className="docs-callout"><Info size={19} /><p><strong>New to ISPSense?</strong> Follow these steps to prepare your workspace.</p></div><div className="docs-quick-links">{quickLinks.map(({ slug, title, detail, Icon }) => <Link key={slug} to={articlePath(slug)}><span className="docs-quick-icon"><Icon size={25} /></span><span><strong>{title}</strong><span>{detail}</span></span><ArrowRight size={17} /></Link>)}</div></>}
      <article className="docs-prose"><Markdown skipHtml components={components}>{article.body}</Markdown></article>
      <footer className="docs-article-footer"><p>Need more help? <Link to="/docs/troubleshooting">Browse troubleshooting <ArrowRight size={14} /></Link></p><div className="docs-page-links">{index > 0 && <Link to={articlePath(articles[index - 1].slug)}><ArrowLeft size={16} /><span><small>Previous</small>{articles[index - 1].title}</span></Link>}{index < articles.length - 1 && <Link to={articlePath(articles[index + 1].slug)}><span><small>Next guide</small>{articles[index + 1].title}</span><ArrowRight size={16} /></Link>}</div></footer>
    </main>
    <aside className="docs-outline" aria-label="On this page"><p>On this page</p><nav>{article.headings.map(item => <a key={item.id} href={`#${item.id}`} className={`${active === item.id ? 'is-active' : ''} ${item.level === 3 ? 'is-nested' : ''}`} aria-current={active === item.id ? 'location' : undefined} onClick={() => setActive(item.id)}>{item.title}</a>)}</nav><div className="docs-outline-help"><strong>Need help?</strong><Link to="/docs/troubleshooting">Troubleshooting <ArrowRight size={14} /></Link><Link to="/docs/feature-readiness">Feature readiness <ArrowRight size={14} /></Link></div></aside>
  </div>;
}

export default function DocsPage() {
  const { '*': path } = useParams();
  const slug = path?.replace(/\/$/, '') || 'first-setup';
  const article = articles.find(a => a.slug === slug);
  const menu = useRef<HTMLDialogElement>(null);
  const { theme, toggleTheme } = useThemeStore();
  return <div className="docs-site">
    <a className="docs-skip" href="#docs-content">Skip to content</a>
    <header className="docs-topbar"><Link to="/docs" className="docs-brand"><Network size={28} /><strong>ISPSense <span>Docs</span></strong></Link><DocsSearch /><div className="docs-top-links"><Link to="/docs" className="docs-header-link">Guides</Link><Link to="/docs/api-reference" className="docs-header-link">API reference</Link><button className="docs-icon-button" onClick={toggleTheme} aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}>{theme === 'light' ? <Moon size={19} /> : <Sun size={19} />}</button><Link className="docs-dashboard-link" to="/dashboard">Open dashboard <ExternalLink size={14} /></Link></div></header>
    <div className="docs-mobile-toolbar"><button onClick={() => menu.current?.showModal()}><Menu size={18} />Documentation<ChevronDown size={14} /></button><Link to="/dashboard">Dashboard <ExternalLink size={14} /></Link></div>
    <div className="docs-shell"><aside className="docs-sidebar"><DocsNavigation slug={slug} /></aside>{article ? <GuideContent key={article.slug} article={article} /> : <main id="docs-content" className="docs-not-found"><FileText size={36} /><p className="docs-eyebrow">Guide not found</p><h1>Let’s find the right page.</h1><p>This documentation address doesn’t match an existing guide. Search above or return to the setup guide.</p><Link to="/docs">Get started with ISPSense <ArrowRight size={17} /></Link></main>}</div>
    <dialog ref={menu} className="docs-mobile-menu" aria-label="Documentation menu" onClick={e => { if (e.target === e.currentTarget) menu.current?.close(); }}><div className="docs-mobile-menu-heading"><strong>Documentation</strong><button className="docs-icon-button" aria-label="Close menu" onClick={() => menu.current?.close()}><X size={20} /></button></div><DocsNavigation slug={slug} close={() => menu.current?.close()} /></dialog>
  </div>;
}
