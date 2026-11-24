import Link from 'next/link';
import {
  CHROME_WEB_STORE_URL,
  DOC_ENTRIES,
  ISSUES_URL,
  RELEASES_URL,
  REPO_URL,
  SPONSOR_NAME,
  SPONSOR_URL,
  withBasePath,
} from '@/lib/site';

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="container footer-grid">
        <div>
          <strong style={{ color: 'var(--ink)', fontFamily: 'var(--font-serif)' }}>Glyphrig</strong>
          <p style={{ margin: '6px 0 0', maxWidth: 420 }}>
            Local-first, MIT-licensed browser extension &amp; static site ecosystem for syncing a
            chosen bookmark folder with Git.
          </p>
          <p style={{ margin: '8px 0 0' }}>
            Sponsored by{' '}
            <a
              href={SPONSOR_URL}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'var(--accent)', fontWeight: 600 }}
            >
              {SPONSOR_NAME}
            </a>
          </p>
        </div>

        <div className="footer-links">
          {DOC_ENTRIES.map((doc) => (
            <Link key={doc.slug} href={`/docs/${doc.slug}/`}>
              {doc.title}
            </Link>
          ))}
          <Link href="/privacy/">Privacy Policy</Link>
          <a href={withBasePath('/PRIVACY.md')}>PRIVACY.md</a>
          <a href={CHROME_WEB_STORE_URL} target="_blank" rel="noopener noreferrer">
            Chrome Web Store
          </a>
          <a href={RELEASES_URL} target="_blank" rel="noopener noreferrer">
            Releases
          </a>
          <a href={ISSUES_URL} target="_blank" rel="noopener noreferrer">
            Support
          </a>
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
        </div>
      </div>
    </footer>
  );
}
