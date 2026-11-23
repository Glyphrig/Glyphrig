import Link from 'next/link';

export default function NotFoundPage() {
  return (
    <section className="section">
      <div className="container" style={{ maxWidth: 640, textAlign: 'center', padding: '48px 0' }}>
        <div className="section-kicker">404</div>
        <h1 style={{ fontFamily: 'var(--font-serif)', fontSize: '2.2rem', margin: '0 0 12px' }}>
          Page Not Found
        </h1>
        <p style={{ color: 'var(--ink-muted)', marginBottom: 24 }}>
          The documentation or page you requested could not be found on this site.
        </p>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Link href="/" className="btn-primary">
            Go Home
          </Link>
          <Link href="/docs/" className="btn-secondary">
            Browse Docs
          </Link>
        </div>
      </div>
    </section>
  );
}
