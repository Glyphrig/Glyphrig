import type { Metadata } from 'next';
import Link from 'next/link';
import { getAllDocs } from '@/lib/docs';
import { withBasePath } from '@/lib/site';

export const metadata: Metadata = {
  title: 'Documentation',
  description: 'Guides, theming documentation, architecture specification, and OAuth setup for Glyphrig.',
};

export default function DocsIndexPage() {
  const docs = getAllDocs();

  return (
    <section className="section">
      <div className="container">
        <div className="section-head">
          <div className="section-kicker">Documentation</div>
          <h1 style={{ fontFamily: 'var(--font-serif)', fontSize: '2.3rem', margin: '0 0 10px' }}>
            Glyphrig Guides &amp; Reference
          </h1>
          <p>
            Everything you need to scaffold a bookmark repository, configure multi-browser sync,
            customize themes, and set up GitHub OAuth Device Flow.
          </p>
        </div>

        <div className="grid-2">
          {docs.map((doc) => (
            <Link key={doc.slug} href={`/docs/${doc.slug}/`} className="card doc-card">
              <div>
                <span className="card-badge">{doc.badge}</span>
                <h3>{doc.title}</h3>
                <p>{doc.summary}</p>
              </div>
              <span className="doc-card-more">Open guide &rarr;</span>
            </Link>
          ))}

          <Link href="/privacy/" className="card doc-card">
            <div>
              <span className="card-badge">Policy</span>
              <h3>Privacy Policy</h3>
              <p>
                Detailed breakdown of browser permissions, local storage, Public Safety Rails, and
                direct-to-forge data handling.
              </p>
            </div>
            <span className="doc-card-more">Read Privacy Policy &rarr;</span>
          </Link>

          <a href={withBasePath('/PRIVACY.md')} className="card doc-card">
            <div>
              <span className="card-badge">Raw Markdown</span>
              <h3>PRIVACY.md</h3>
              <p>
                Direct plain-text Markdown mirror of <code>docs/PRIVACY.md</code> hosted at the site
                root for automated tools and Chrome Web Store links.
              </p>
            </div>
            <span className="doc-card-more">Open raw PRIVACY.md &rarr;</span>
          </a>
        </div>
      </div>
    </section>
  );
}
