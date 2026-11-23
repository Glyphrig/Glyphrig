import type { Metadata } from 'next';
import { SiteFooter } from '@/components/SiteFooter';
import { SiteHeader } from '@/components/SiteHeader';
import { SITE_URL, withBasePath } from '@/lib/site';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Glyphrig — Two-Way Git Bookmark Sync & Digital Garden',
    template: '%s | Glyphrig',
  },
  description:
    'Two-way sync a chosen bookmark folder with GitHub, GitLab, or Forgejo/Codeberg and publish a searchable static bookmark site.',
  icons: {
    icon: withBasePath('/favicon.png'),
    apple: withBasePath('/icon-128.png'),
  },
  openGraph: {
    type: 'website',
    title: 'Glyphrig — Two-Way Git Bookmark Sync & Digital Garden',
    description:
      'Sync one chosen bookmark folder across Chrome, Firefox, and Android backed by a data-only Git repository.',
    url: SITE_URL,
    images: [
      {
        url: `${SITE_URL}/images/og-marquee.png`,
        width: 1400,
        height: 560,
        alt: 'Glyphrig banner showing Git-backed Markdown bookmarks',
      },
    ],
  },
};

const themeInitScript = `
(function () {
  try {
    var saved = localStorage.getItem('glyphrig-theme');
    if (saved === 'dark' || saved === 'light') {
      document.documentElement.setAttribute('data-theme', saved);
    } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      document.documentElement.setAttribute('data-theme', 'dark');
    }
  } catch (e) {}
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <SiteHeader />
        <main className="site-main">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
