import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAllDocs, getDocBySlug } from '@/lib/docs';
import { REPO_URL } from '@/lib/site';

interface PageProps {
  params: Promise<{ slug: string }>;
}

export function generateStaticParams() {
  return getAllDocs().map((doc) => ({ slug: doc.slug }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const doc = getDocBySlug(slug);
  if (!doc) return { title: 'Not Found' };
  return {
    title: doc.title,
    description: doc.summary,
  };
}

export default async function DocDetailPage({ params }: PageProps) {
  const { slug } = await params;
  const doc = getDocBySlug(slug);
  if (!doc) notFound();

  const docs = getAllDocs();
  const idx = docs.findIndex((item) => item.slug === slug);
  const prev = idx > 0 ? docs[idx - 1] : null;
  const next = idx >= 0 && idx < docs.length - 1 ? docs[idx + 1] : null;

  return (
    <div className="container docs-shell">
      <aside className="docs-nav" aria-label="Documentation sections">
        <p className="side-title">Documentation</p>
        <ul className="side-list">
          <li>
            <Link href="/docs/" className="side-link">
              All Docs
            </Link>
          </li>
          {docs.map((item) => (
            <li key={item.slug}>
              <Link
                href={`/docs/${item.slug}/`}
                className={`side-link${item.slug === slug ? ' is-active' : ''}`}
              >
                {item.title}
              </Link>
            </li>
          ))}
          <li>
            <Link href="/privacy/" className="side-link">
              Privacy Policy
            </Link>
          </li>
        </ul>
      </aside>

      <article className="doc-article">
        <header className="doc-header">
          <span className="card-badge">{doc.badge}</span>
          <h1>{doc.title}</h1>
          <div className="doc-meta-row">
            <span>{doc.summary}</span>
            <a
              href={`${REPO_URL}/blob/main/docs/${doc.filename}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'var(--accent)', fontWeight: 600, whiteSpace: 'nowrap' }}
            >
              View on GitHub &rarr;
            </a>
          </div>
        </header>

        <div className="prose" dangerouslySetInnerHTML={{ __html: doc.html }} />

        <nav className="doc-pager" aria-label="Adjacent documentation pages">
          {prev ? (
            <Link href={`/docs/${prev.slug}/`} className="btn-secondary">
              &larr; {prev.title}
            </Link>
          ) : (
            <span />
          )}
          {next ? (
            <Link href={`/docs/${next.slug}/`} className="btn-secondary">
              {next.title} &rarr;
            </Link>
          ) : (
            <Link href="/privacy/" className="btn-secondary">
              Privacy Policy &rarr;
            </Link>
          )}
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
