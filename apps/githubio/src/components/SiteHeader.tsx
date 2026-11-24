import Link from 'next/link';
import { CHROME_WEB_STORE_URL, REPO_URL, withBasePath } from '@/lib/site';
import { ThemeToggle } from './ThemeToggle';

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="container header-inner">
        <Link href="/" className="brand-link">
          <img
            src={withBasePath('/images/glyphrig-crest.png')}
            alt=""
            className="brand-crest"
            width={34}
            height={34}
          />
          <span>Glyphrig</span>
        </Link>

        <nav className="header-nav" aria-label="Main navigation">
          <Link href="/#features" className="nav-link">
            Features
          </Link>
          <Link href="/docs/" className="nav-link">
            Docs
          </Link>
          <Link href="/privacy/" className="nav-link">
            Privacy
          </Link>
          <a href={CHROME_WEB_STORE_URL} target="_blank" rel="noopener noreferrer" className="nav-link">
            Chrome Web Store
          </a>
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer" className="nav-link">
            GitHub
          </a>
          <ThemeToggle />
        </nav>
      </div>
    </header>
  );
}
