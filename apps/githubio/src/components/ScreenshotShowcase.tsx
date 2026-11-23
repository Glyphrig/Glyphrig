'use client';

import { useState } from 'react';
import { withBasePath } from '@/lib/site';

interface Slide {
  id: string;
  label: string;
  src: string;
  alt: string;
  caption: string;
}

const SLIDES: Slide[] = [
  {
    id: 'popup',
    label: 'Two-Way Sync Popup',
    src: '/images/screenshot-1-popup-and-sync.png',
    alt: 'Glyphrig extension popup syncing a single bookmark folder to a GitHub Markdown repository',
    caption:
      'Pick one folder per sync profile, inspect live sync status, and commit clean Markdown directly to your Git repository.',
  },
  {
    id: 'settings',
    label: 'Multi-Forge Settings',
    src: '/images/screenshot-2-multi-forge-settings.png',
    alt: 'Glyphrig settings screen configuring GitHub OAuth Device Flow, GitLab, Codeberg, and folder selection',
    caption:
      'Connect GitHub (OAuth Device Flow or PAT), GitLab, or Forgejo / Codeberg—including self-hosted instances—while private folders stay untouched.',
  },
  {
    id: 'safety',
    label: 'Safety Rails & Dry-Run',
    src: '/images/screenshot-3-safety-rails-preview.png',
    alt: 'Glyphrig Public Safety Rails and first-sync dry-run preview modal filtering private hosts and secrets',
    caption:
      'Built-in Public Safety Rails strip tracking query parameters and block localhost, private LAN URLs, and secret tokens before committing.',
  },
  {
    id: 'garden',
    label: 'Digital Garden Site',
    src: '/images/screenshot-4-editorial-digital-garden.png',
    alt: 'Human-editable bookmark Markdown rendered into an Editorial Digital Garden static site',
    caption:
      'Pair your data-only repository with @glyphrig/cli to publish an Editorial Digital Garden with Pagefind search, RSS/JSON feeds, and a PWA Quick Add.',
  },
];

export function ScreenshotShowcase() {
  const [activeId, setActiveId] = useState<string>(SLIDES[0]!.id);
  const current = SLIDES.find((s) => s.id === activeId) ?? SLIDES[0]!;

  return (
    <div>
      <div className="showcase-tabs" role="tablist" aria-label="Glyphrig interface tour">
        {SLIDES.map((slide) => (
          <button
            key={slide.id}
            type="button"
            role="tab"
            aria-selected={slide.id === current.id}
            className={`showcase-tab${slide.id === current.id ? ' is-active' : ''}`}
            onClick={() => setActiveId(slide.id)}
          >
            {slide.label}
          </button>
        ))}
      </div>

      <div className="showcase-frame">
        <img src={withBasePath(current.src)} alt={current.alt} width={1280} height={800} />
        <p className="showcase-caption">{current.caption}</p>
      </div>
    </div>
  );
}
