import Link from 'next/link';
import { CopyCommand } from '@/components/CopyCommand';
import { ScreenshotShowcase } from '@/components/ScreenshotShowcase';
import {
  CHROME_WEB_STORE_URL,
  DOC_ENTRIES,
  RELEASES_URL,
  REPO_URL,
  SPONSOR_NAME,
  SPONSOR_URL,
  withBasePath,
} from '@/lib/site';

const FEATURES = [
  {
    badge: 'Privacy-First Scope',
    title: 'Selective Single-Folder Sync',
    body: 'Pick one bookmark folder per sync profile—never your entire bookmark bar. Keep personal or work bookmarks completely untouched.',
  },
  {
    badge: 'Conflict-Safe',
    title: 'Two-Way 3-Way Merge',
    body: 'Mirror a folder across Desktop Chrome, Desktop Firefox, and Firefox for Android, or enable Contribute-only mode for shared team lists.',
  },
  {
    badge: 'Multi-Forge',
    title: 'GitHub, GitLab & Codeberg',
    body: 'Authenticate via one-click GitHub OAuth Device Flow or scoped PATs across GitHub, GitLab, and Forgejo / Gitea (including self-hosted).',
  },
  {
    badge: 'Safety Rails',
    title: 'Built-In Public Leak Guards',
    body: 'Skips localhost, LAN IPs, file://, and credentialed URLs, strips tracking params (utm_*, fbclid, gclid), and enforces a dry-run preview.',
  },
  {
    badge: 'Open Format',
    title: 'Human-Editable Markdown',
    body: 'Stores folders cleanly as bookmarks/<folder>/README.md while preserving YAML frontmatter, intro prose, notes, and #tags on every round-trip.',
  },
  {
    badge: 'Static Site',
    title: 'Editorial Digital Garden',
    body: 'Run npx @glyphrig/cli build in CI to publish a fast Astro site with Pagefind search, local favicons, RSS/JSON feeds, and a PWA Quick Add.',
  },
];

const PACKAGES = [
  {
    name: '@glyphrig/extension',
    role: 'Browser Extension (MV3)',
    summary: 'WXT extension for Chrome, Desktop Firefox, and Firefox for Android with background alarms and dry-run previews.',
  },
  {
    name: '@glyphrig/cli',
    role: 'Zero-Boilerplate CLI',
    summary: 'Scaffold repos with glyphrig init, validate links, enrich cached metadata, and build your site in CI.',
  },
  {
    name: '@glyphrig/site',
    role: 'Astro Digital Garden',
    summary: 'Editorial, minimal, terminal, and nord themes with offline PWA Share Target, Pagefind search, and feeds.',
  },
  {
    name: '@glyphrig/core',
    role: 'Pure TypeScript Engine',
    summary: 'Round-trip Markdown parser/serializer, URL safety filters, 3-way merge algorithm, and forge REST adapters.',
  },
];

export default function HomePage() {
  return (
    <>
      <section className="hero">
        <div className="container hero-grid">
          <div>
            <div className="eyebrow">Open Source &middot; Manifest V3 &middot; MIT License</div>
            <h1>Sync one bookmark folder. Own it in Git.</h1>
            <p className="hero-lead">
              Glyphrig turns a single chosen browser bookmark folder into a two-way Git-backed
              knowledge archive—and publishes it as a searchable static Digital Garden across
              Chrome, Firefox, and mobile.
            </p>

            <div className="hero-actions">
              <a
                href={CHROME_WEB_STORE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-primary"
              >
                Install on Chrome Web Store
              </a>
              <Link href="/docs/getting-started/" className="btn-secondary">
                Get Started
              </Link>
              <a href={RELEASES_URL} target="_blank" rel="noopener noreferrer" className="btn-secondary">
                Firefox &amp; Releases
              </a>
            </div>

            <CopyCommand command="npx --yes @glyphrig/cli@0 init glyphrig_bookmarks" />
          </div>

          <div className="hero-crest-card">
            <img
              src={withBasePath('/images/glyphrig-crest.png')}
              alt="Glyphrig Archival Gryphon Crest"
              className="hero-crest-img"
              width={170}
              height={170}
            />
            <strong style={{ fontFamily: 'var(--font-serif)', fontSize: '1.15rem' }}>
              Data-Only Git Repository
            </strong>
            <p className="hero-crest-caption">
              Zero developer servers, zero telemetry, zero vendor lock-in. Your browser talks
              directly to your Git forge.
            </p>
            <p className="hero-crest-caption">
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
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="section-head">
            <div className="section-kicker">Product Tour</div>
            <h2>Built for selective sync, public safety, and readable Markdown</h2>
            <p>
              Explore the extension popup, multi-forge profile settings, dry-run safety rails, and
              published Editorial Digital Garden output.
            </p>
          </div>
          <ScreenshotShowcase />
        </div>
      </section>

      <section id="features" className="section section-muted">
        <div className="container">
          <div className="section-head">
            <div className="section-kicker">Why Glyphrig</div>
            <h2>Everything you need to curate bookmarks without cloud lock-in</h2>
          </div>
          <div className="grid-3">
            {FEATURES.map((f) => (
              <article key={f.title} className="card">
                <span className="card-badge">{f.badge}</span>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="section-head">
            <div className="section-kicker">How It Works</div>
            <h2>Three steps from local folder to published garden</h2>
          </div>
          <div className="grid-3">
            <article className="card">
              <div className="step-num">01</div>
              <h3>Scaffold a Data-Only Repo</h3>
              <p>
                Run <code>npx @glyphrig/cli init</code> to create a clean repository holding only{' '}
                <code>bookmarks/</code>, <code>glyphrig.config.yaml</code>, and a CI deploy workflow.
              </p>
            </article>
            <article className="card">
              <div className="step-num">02</div>
              <h3>Connect One Browser Folder</h3>
              <p>
                Install from the{' '}
                <a
                  href={CHROME_WEB_STORE_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: 'var(--accent)', fontWeight: 600 }}
                >
                  Chrome Web Store
                </a>
                , open Glyphrig Settings, sign in with GitHub Device Flow or a scoped PAT, choose one
                bookmark folder, and verify the Dry-Run Preview.
              </p>
            </article>
            <article className="card">
              <div className="step-num">03</div>
              <h3>Sync &amp; Publish Everywhere</h3>
              <p>
                Edits push cleanly as Markdown commits while GitHub Actions, GitLab CI, or Codeberg
                Pages publishes your searchable bookmark site.
              </p>
            </article>
          </div>
        </div>
      </section>

      <section className="section section-muted">
        <div className="container">
          <div className="section-head">
            <div className="section-kicker">Architecture &amp; Packages</div>
            <h2>Modular open-source monorepo</h2>
          </div>
          <div className="grid-4" style={{ marginBottom: 42 }}>
            {PACKAGES.map((pkg) => (
              <article key={pkg.name} className="card">
                <span className="card-badge">{pkg.role}</span>
                <h3 style={{ fontFamily: 'var(--font-mono)', fontSize: '0.98rem' }}>{pkg.name}</h3>
                <p>{pkg.summary}</p>
              </article>
            ))}
          </div>

          <div className="section-head">
            <div className="section-kicker">Documentation</div>
            <h2>Guides &amp; Reference</h2>
          </div>
          <div className="grid-2">
            {DOC_ENTRIES.map((doc) => (
              <Link key={doc.slug} href={`/docs/${doc.slug}/`} className="card doc-card">
                <div>
                  <span className="card-badge">{doc.badge}</span>
                  <h3>{doc.title}</h3>
                  <p>{doc.summary}</p>
                </div>
                <span className="doc-card-more">Read guide &rarr;</span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="privacy-banner">
            <div style={{ maxWidth: 660 }}>
              <div className="section-kicker" style={{ marginBottom: 4 }}>
                Privacy Policy
              </div>
              <h2 style={{ fontFamily: 'var(--font-serif)', fontSize: '1.55rem', margin: '0 0 8px' }}>
                Zero backend servers. Local storage &amp; direct forge commits only.
              </h2>
              <p style={{ margin: 0, color: 'var(--ink-muted)' }}>
                Credentials remain in <code>browser.storage.local</code> and bookmark data is sent
                only to the Git forge you configure. Read the full policy or download raw{' '}
                <code>PRIVACY.md</code>.
              </p>
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <Link href="/privacy/" className="btn-primary">
                Read Privacy Policy
              </Link>
              <a href={withBasePath('/PRIVACY.md')} className="btn-secondary">
                Raw PRIVACY.md
              </a>
              <a href={REPO_URL} target="_blank" rel="noopener noreferrer" className="btn-secondary">
                Inspect Source
              </a>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
