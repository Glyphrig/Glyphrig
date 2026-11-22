import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  vite: () => ({
    build: {
      modulePreload: false,
    },
  }),
  manifest: ({ browser }) => ({
    name: 'Glyphrig',
    description:
      'Two-way sync a chosen bookmark folder with a Git repository (GitHub, GitLab, Forgejo/Codeberg) to publish a static bookmark site.',
    permissions: ['bookmarks', 'storage', 'alarms'],
    host_permissions: [
      'https://api.github.com/*',
      'https://github.com/*',
      'https://gitlab.com/*',
      'https://codeberg.org/*',
    ],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    icons: {
      16: 'icon/16.png',
      32: 'icon/32.png',
      48: 'icon/48.png',
      128: 'icon/128.png',
    },
    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: {
              id: 'glyphrig@glyphrig.dev',
              strict_min_version: '128.0',
              data_collection_permissions: {
                required: ['none'],
              },
            },
            gecko_android: {
              strict_min_version: '128.0',
            },
          },
        }
      : {}),
  }),
});
