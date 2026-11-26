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
      'Git-backed bookmark sync with team notes, PR proposals, read-only garden subscriptions, and public safety rails.',
    permissions: ['bookmarks', 'storage', 'alarms', 'activeTab', 'contextMenus'],
    optional_permissions: ['tabs'],
    commands: {
      _execute_action: {
        suggested_key: {
          default: 'Alt+Shift+B',
        },
        description: 'Open Glyphrig Quick Save & Team Notes for current tab',
      },
    },
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
              strict_min_version: '140.0',
              data_collection_permissions: {
                required: ['none'],
              },
            },
          },
        }
      : {}),
  }),
});
