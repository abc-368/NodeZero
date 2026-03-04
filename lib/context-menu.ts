/**
 * Context menu registration and handlers.
 *
 * Registers four items under a "NodeZero" parent menu.
 * Triggered by right-clicking on any page.
 */

export function registerContextMenus(): void {
  // Create parent menu
  browser.contextMenus.create({
    id: 'nodezero',
    title: 'NodeZero',
    contexts: ['all'],
  });

  browser.contextMenus.create({
    id: 'nodezero-fill',
    parentId: 'nodezero',
    title: 'Fill Credentials',
    contexts: ['editable'],
  });

  browser.contextMenus.create({
    id: 'nodezero-generate',
    parentId: 'nodezero',
    title: 'Generate Password',
    contexts: ['editable'],
  });

  browser.contextMenus.create({
    id: 'nodezero-save',
    parentId: 'nodezero',
    title: 'Save This Login',
    contexts: ['all'],
  });

  browser.contextMenus.create({
    id: 'nodezero-open',
    parentId: 'nodezero',
    title: 'Open NodeZero',
    contexts: ['all'],
  });

  // ── Email encryption items ──────────────────────────────────────────────
  const gmailPattern = ['*://mail.google.com/*'];
  // Link email works on Gmail AND Google Account (more reliable email detection)
  const googleAccountPatterns = [
    '*://mail.google.com/*',
    '*://myaccount.google.com/*',
    '*://accounts.google.com/*',
  ];

  browser.contextMenus.create({
    id: 'nodezero-link-email',
    parentId: 'nodezero',
    title: 'Link this email to my identity',
    contexts: ['all'],
    documentUrlPatterns: googleAccountPatterns,
  });

  browser.contextMenus.create({
    id: 'nodezero-encrypt',
    parentId: 'nodezero',
    title: 'Encrypt for recipient',
    contexts: ['editable'],
    documentUrlPatterns: gmailPattern,
  });

  browser.contextMenus.create({
    id: 'nodezero-decrypt',
    parentId: 'nodezero',
    title: 'Decrypt email',
    contexts: ['all'],
    documentUrlPatterns: gmailPattern,
  });
}

export type ContextMenuItemId =
  | 'nodezero-fill'
  | 'nodezero-generate'
  | 'nodezero-save'
  | 'nodezero-open'
  | 'nodezero-link-email'
  | 'nodezero-encrypt'
  | 'nodezero-decrypt';
