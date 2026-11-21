/// <reference types="wxt/vite-builder-env" />

interface ImportMetaEnv {
  readonly VITE_GITHUB_OAUTH_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
