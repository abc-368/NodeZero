import { defineConfig } from 'wxt';
import react from '@vitejs/plugin-react';
import { execSync } from 'child_process';

// Inject git commit hash at build time for traceability
const GIT_HASH = (() => {
  try {
    return execSync('git rev-parse --short=7 HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
})();

// See https://wxt.dev/api/config.html
export default defineConfig({
  manifest: {
    name: 'NodeZero',
    description: 'Decentralized credential manager — your keys, your vault, no central server.',
    version: '1.2.0',
    default_locale: 'en',
    permissions: [
      'activeTab',
      'alarms',
      'scripting',
      'storage',
      'tabs',
      'contextMenus',
      'idle',
      'sidePanel',
    ],
    action: {
      default_popup: 'popup.html',
      default_title: 'NodeZero',
    },
    side_panel: {
      default_path: 'sidepanel.html',
    },
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self';",
    },
    background: {
      service_worker: 'entrypoints/background.ts',
      type: 'module',
    },
    icons: {
      '16': 'icon/16.png',
      '32': 'icon/32.png',
      '48': 'icon/48.png',
      '96': 'icon/96.png',
      '128': 'icon/128.png',
    },
    // Gmail permission declared as optional so Chrome Web Store does not
    // require an in-depth host_permissions review. The extension requests
    // this at runtime the first time the user triggers an email action.
    // Once granted, the tabs.onUpdated listener auto-injects the content
    // script on Gmail for the auto-decrypt MutationObserver.
    optional_host_permissions: ['*://mail.google.com/*'],
  },
  // Ensure the worker is treated as an entrypoint
  entrypointsDir: 'entrypoints',
  vite: () => ({
    plugins: [react()],
    define: {
      __GIT_HASH__: JSON.stringify(GIT_HASH),
    },
  }),
});
