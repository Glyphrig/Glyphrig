import type { Metadata } from 'next';
import Link from 'next/link';
import { getPrivacyDoc } from '@/lib/docs';
import { REPO_URL, withBasePath } from '@/lib/site';

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description:
    'Privacy Policy for the Glyphrig browser extension: local-only storage, zero backend servers, and direct Git forge sync.',
};

export default function PrivacyPage() {
  const doc = getPrivacyDoc();

  return (
    <div className="container docs-shell no-sidebar">
      <article className="doc-article">
        <header className="doc-header">
          <span className="card-badge">{doc.badge}</span>
          <h1>{doc.title}</h1>
          <div className="doc-meta-row">
            <span>Local-First &middot; Zero Developer Servers &middot; Direct Forge Sync</span>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <a
                href={withBasePath('/PRIVACY.md')}
                style={{ color: 'var(--accent)', fontWeight: 600 }}
              >
                Raw PRIVACY.md
              </a>
              <a
                href={`${REPO_URL}/blob/main/docs/PRIVACY.md`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: 'var(--accent)', fontWeight: 600 }}
              >
                Source on GitHub &rarr;
              </a>
            </div>
          </div>
        </header>

        <div className="prose" dangerouslySetInnerHTML={{ __html: doc.html }} />

        <nav className="doc-pager" aria-label="Back navigation">
          <Link href="/" className="btn-secondary">
            &larr; Back to Home
          </Link>
          <Link href="/docs/getting-started/" className="btn-secondary">
            Getting Started &rarr;
          </Link>
        </nav>
      </article>

      {doc.toc.length > 0 && (
        <aside className="docs-toc" aria-label="On this page">
          <p className="side-title">On This Page</p>
          <ul className="side-list">
            {doc.toc.map((heading) => (
              <li key={heading.id}>
                <a
                  href={`#${heading.id}`}
                  className={`side-link${heading.level === 3 ? ' toc-l3' : ''}`}
                >
                  {heading.text}
                </a>
              </li>
            ))}
          </ul>
        </aside>
      )}
    </div>
  );
}
