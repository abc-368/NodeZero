/**
 * NodeZero Content Script — Programmatic Injection
 *
 * Injected on-demand via chrome.scripting.executeScript() when the user
 * triggers a context menu action or opens the popup. Auto-injected on
 * Gmail pages (host_permissions) for the auto-decrypt MutationObserver.
 *
 * Security invariant: Content script performs ZERO crypto.
 * All encryption/decryption stays in the background service worker.
 */

// ── Always-fresh listener registration ──────────────────────────────────
// On re-injection (e.g. after extension reload or second inject in same
// context), remove any stale listener and register a fresh one.
// This avoids issues where the old listener is broken (runtime disconnected)
// but an idempotency guard would skip re-registration.

if (window.__nodezero_listener) {
  try {
    chrome.runtime.onMessage.removeListener(window.__nodezero_listener);
  } catch {
    /* old listener from destroyed context — ignore */
  }
}

window.__nodezero_listener = function (message, _sender, sendResponse) {
  handleMessage(message)
    .then(sendResponse)
    .catch((err) => {
      console.error('[NodeZero] Content script error:', err);
      sendResponse({ error: err?.message });
    });
  return true; // async response
};
chrome.runtime.onMessage.addListener(window.__nodezero_listener);

// ── Multi-step login: capture username on form submit ────────────────────
// Sites like Google/BBC show email on page 1, password on page 2.
// When page 1 submits, store the typed username in session storage
// so page 2's getPageInfo() can retrieve it as a fallback.
// Only register once per page (submit listener doesn't need refreshing).

if (!window.__nodezero_submit_registered) {
  window.__nodezero_submit_registered = true;
  document.addEventListener(
    'submit',
    () => {
      const field = findVisibleUsernameField();
      if (field?.value) {
        chrome.storage.session
          .set({
            lastSeenUsername: {
              origin: window.location.origin,
              value: field.value,
              timestamp: Date.now(),
            },
          })
          .catch(() => {});
      }
    },
    { capture: true }
  );
}

// ── Message dispatcher ───────────────────────────────────────────────────

async function handleMessage(message) {
  switch (message.type) {
    case 'fillCredentials':
      return fillCredentials(message.payload);
    case 'getPageInfo':
      return getPageInfo();
    case 'getGmailUserEmail':
      return getGmailUserEmail();
    case 'getGmailComposeInfo':
      return getGmailComposeInfo();
    case 'replaceComposeBody':
      return replaceComposeBody(message.payload);
    case 'getGmailMessageInfo':
      return getGmailMessageInfo();
    case 'replaceMessageBody':
      return replaceMessageBody(message.payload);
    default:
      return null;
  }
}

// ── Fill credentials ─────────────────────────────────────────────────────
// Page-aware smart fill: detects what fields are visible and fills only
// what's appropriate for the current page state.
//
//   Both fields visible  → fill both (standard login page)
//   Password field only  → fill password only (multi-step step 2, e.g. BBC)
//   Username field only  → fill username only (multi-step step 1, e.g. Google)
//   Neither found        → try the focused input with the password

function fillCredentials(payload) {
  const { username, password } = payload;

  const visible = findVisibleInputs();
  const passwordField = visible.find((el) => el.type === 'password');

  // Strict username match: explicitly typed as email, or name/id/autocomplete
  // contains a username-related keyword. Does NOT fall back to any text input.
  const strictUsernameField = visible.find(
    (el) =>
      el.type === 'email' ||
      /user|email|login|account/i.test(el.name + el.id + el.autocomplete)
  );

  // Loose fallback: any visible text input. Only used when there is NO password
  // field on the page (i.e. this is genuinely a username-only step). This
  // prevents accidentally filling the username into a search bar or display
  // field on password-only pages like BBC's "Enter your password" step.
  const usernameField =
    strictUsernameField ??
    (!passwordField ? visible.find((el) => el.type === 'text') : null);

  let filled = false;

  if (usernameField && username) {
    setInputValue(usernameField, username);
    filled = true;
  }

  if (passwordField && password) {
    setInputValue(passwordField, password);
    filled = true;
  }

  // Fallback: if nothing was filled, try the focused input with the password
  // (e.g. Generate Password on a focused input with no type="password")
  if (!filled && password) {
    const focused = document.activeElement;
    if (focused && focused.tagName === 'INPUT') {
      setInputValue(focused, password);
      filled = true;
    }
  }

  return { success: filled };
}

// ── Simulate native input events ─────────────────────────────────────────

function setInputValue(input, value) {
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value'
  )?.set;

  if (nativeInputValueSetter) {
    nativeInputValueSetter.call(input, value);
  } else {
    input.value = value;
  }

  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

// ── Find visible inputs ──────────────────────────────────────────────────

function findVisibleInputs() {
  return Array.from(document.querySelectorAll('input')).filter((el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && !el.disabled && !el.readOnly;
  });
}

// ── Find best visible username/email field ───────────────────────────────

function findVisibleUsernameField() {
  const visible = findVisibleInputs();
  return (
    visible.find(
      (el) =>
        el.type === 'email' ||
        /user|email|login|account/i.test(el.name + el.id + el.autocomplete)
    ) ?? visible.find((el) => el.type === 'text')
  );
}

// ── Get page info ────────────────────────────────────────────────────────

async function getPageInfo() {
  const visible = findVisibleInputs();

  // Password: type=password, OR type=text with password-related attributes
  // (covers "show password" toggles that change type to text)
  const passwordField =
    visible.find((el) => el.type === 'password') ??
    visible.find(
      (el) =>
        el.type === 'text' &&
        (/^(current|new)-password$/.test(el.autocomplete) ||
          /pass/i.test(el.name + el.id))
    );

  // Username: visible field first
  const visibleUsernameField = findVisibleUsernameField();
  let username = visibleUsernameField?.value || undefined;

  // Fallback 1: hidden inputs (multi-step forms often pass username as hidden)
  if (!username) {
    const hidden = document.querySelector(
      'input[type="hidden"][name*="user"], input[type="hidden"][name*="email"], ' +
        'input[type="hidden"][name*="login"], input[type="hidden"][name*="account"]'
    );
    if (hidden?.value) username = hidden.value;
  }

  // Fallback 2: session storage (username captured on a prior page submit)
  if (!username) {
    try {
      const stored = await chrome.storage.session.get('lastSeenUsername');
      const last = stored.lastSeenUsername;
      if (
        last &&
        last.origin === window.location.origin &&
        Date.now() - last.timestamp < 300000
      ) {
        username = last.value;
      }
    } catch {
      /* session storage not available */
    }
  }

  // Proactively store username for multi-step flows
  if (visibleUsernameField?.value) {
    chrome.storage.session
      .set({
        lastSeenUsername: {
          origin: window.location.origin,
          value: visibleUsernameField.value,
          timestamp: Date.now(),
        },
      })
      .catch(() => {});
  }

  // Strip query params and hash — they contain session nonces, CSRF tokens,
  // UTM tracking, etc. Only origin + pathname matters for credential identity.
  const cleanUrl = window.location.origin + window.location.pathname;

  return {
    url: cleanUrl,
    title: document.title,
    hostname: window.location.hostname,
    username,
    password: passwordField?.value || undefined,
    hasPasswordField: !!passwordField,
  };
}

// ── Gmail email handlers ──────────────────────────────────────────────────

/**
 * Extract the logged-in user's email address from Gmail's DOM.
 * This serves as proof-of-access: being logged in = having access.
 *
 * Gmail doesn't consistently expose the email in easy-to-find attributes.
 * We use multiple strategies, ordered by reliability:
 *
 * 1. Gmail's GLOBALS: window.GLOBALS or window.GM_RFP_ACCOUNT_DATA
 * 2. [data-email] attribute (present in some Gmail layouts)
 * 3. Account avatar aria-label (e.g. "Google Account: Name\n(email@example.com)")
 * 4. Page title parsing (Gmail shows "email - Gmail" in some locales)
 * 5. Sent mail: extract from "From" header in sent emails
 * 6. The page HTML body text scan for a gmail.com address pattern
 */
function getGmailUserEmail() {
  const emailRegex = /[\w.+-]+@(gmail\.com|googlemail\.com|[\w.-]+\.\w+)/;

  // Strategy 1: Gmail exposes user email in various global JS variables
  try {
    // Gmail's embedded config often contains the email in a data structure
    // The variable USER_EMAIL or GLOBALS array sometimes holds it
    if (typeof window.USER_EMAIL === 'string' && window.USER_EMAIL.includes('@')) {
      return { email: window.USER_EMAIL };
    }
  } catch { /* */ }

  // Strategy 2: [data-email] attribute (Google account switcher widget)
  const dataEmailEl = document.querySelector('[data-email]');
  if (dataEmailEl) {
    const email = dataEmailEl.getAttribute('data-email');
    if (email && email.includes('@')) {
      return { email };
    }
  }

  // Strategy 3: Account avatar button — aria-label contains email
  // Gmail renders: aria-label="Google Account: John Doe\n(john@gmail.com)"
  const avatarBtn = document.querySelector(
    'a[aria-label*="@"], img[aria-label*="@"], ' +
    'a[href*="accounts.google.com"][aria-label*="@"]'
  );
  if (avatarBtn) {
    const label = avatarBtn.getAttribute('aria-label') || '';
    const match = label.match(emailRegex);
    if (match) return { email: match[0] };
  }

  // Strategy 4: title attribute on account links
  const accountLinks = document.querySelectorAll(
    'a[href*="accounts.google.com"][title], a[href*="myaccount.google.com"][title]'
  );
  for (const link of accountLinks) {
    const title = link.getAttribute('title') || '';
    const match = title.match(emailRegex);
    if (match) return { email: match[0] };
  }

  // Strategy 5: Gmail page title sometimes contains the email
  // Format: "Inbox (3) - user@gmail.com - Gmail"
  const titleMatch = document.title.match(emailRegex);
  if (titleMatch) return { email: titleMatch[0] };

  // Strategy 6: Broader scan — look for data-hovercard-owner-id or
  // similar attributes that contain the user's email
  const hoverOwner = document.querySelector('[data-hovercard-owner-id]');
  if (hoverOwner) {
    const ownerId = hoverOwner.getAttribute('data-hovercard-owner-id') || '';
    if (ownerId.includes('@')) return { email: ownerId };
  }

  // Strategy 7: The profile/account button image often has an alt with email
  const profileImgs = document.querySelectorAll('img[alt*="@"]');
  for (const img of profileImgs) {
    const alt = img.getAttribute('alt') || '';
    const match = alt.match(emailRegex);
    if (match) return { email: match[0] };
  }

  // Strategy 8: Scan the page for a hidden input or meta tag with the email
  const metaEmail = document.querySelector('meta[name="user-email"], meta[content*="@gmail.com"]');
  if (metaEmail) {
    const content = metaEmail.getAttribute('content') || metaEmail.getAttribute('name') || '';
    const match = content.match(emailRegex);
    if (match) return { email: match[0] };
  }

  // Strategy 9: Google Account pages (myaccount.google.com, accounts.google.com)
  // These pages reliably display the email in visible text and attributes.
  if (window.location.hostname === 'myaccount.google.com' ||
      window.location.hostname === 'accounts.google.com') {
    // The account page shows email prominently — scan visible text content
    // Look for elements that display the email address
    const allElements = document.querySelectorAll(
      '[data-email], [data-identifier], .wLBAL, .TnvOCe, .VyDgLb'
    );
    for (const el of allElements) {
      const attrEmail = el.getAttribute('data-email') || el.getAttribute('data-identifier') || '';
      if (attrEmail.includes('@')) return { email: attrEmail };
      const text = (el.textContent || '').trim();
      const match = text.match(emailRegex);
      if (match) return { email: match[0] };
    }

    // Broader: scan all visible text nodes for an email pattern
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      null
    );
    while (walker.nextNode()) {
      const text = walker.currentNode.textContent || '';
      const match = text.match(emailRegex);
      if (match) return { email: match[0] };
    }
  }

  return { error: 'Could not detect email address. For most reliable results, right-click on myaccount.google.com instead.' };
}

/**
 * Extract compose window info: recipient email and body HTML.
 */
function getGmailComposeInfo() {
  // First, find the compose body — this anchors us to the right compose window
  const composeBody = document.querySelector(
    'div[aria-label="Message Body"][contenteditable="true"]'
  );

  if (!composeBody) {
    return { error: 'No compose window found. Open a compose window first.' };
  }

  // Walk up from the compose body to find the compose container.
  // Gmail compose windows use role="dialog" (popup) or a container with
  // a class like .nH (inline). We look for the nearest ancestor that
  // contains both the body and the To field.
  let composeContainer = composeBody.closest('[role="dialog"]');
  if (!composeContainer) {
    // Inline compose: walk up to find a reasonable container
    // The compose form is usually wrapped in a <form> or a div ~5-8 levels up
    composeContainer = composeBody.closest('form') || composeBody.closest('.M9') || composeBody.closest('.nH');
  }
  // Fallback: if we still can't find a container, use document but log a warning
  if (!composeContainer) {
    console.warn('[NodeZero] Could not find compose container, falling back to document');
    composeContainer = document;
  }

  // Collect ALL recipient emails (de-duplicated) from To, CC, BCC
  const recipientSet = new Set();

  // Strategy 1: To input field value (may contain comma-separated emails)
  const toField = composeContainer.querySelector('input[aria-label="To recipients"], input[aria-label="To"], input[name="to"]');
  if (toField && toField.value) {
    toField.value.split(/[,;]/).forEach(function(part) {
      const trimmed = part.trim();
      if (trimmed.includes('@')) recipientSet.add(trimmed.toLowerCase());
    });
  }

  // Strategy 2: Resolved recipient chips with data-hovercard-id (scoped to compose)
  const chips = composeContainer.querySelectorAll('[data-hovercard-id]');
  for (const chip of chips) {
    const hcId = (chip.getAttribute('data-hovercard-id') || '').trim();
    if (hcId.includes('@')) recipientSet.add(hcId.toLowerCase());
  }

  // Strategy 3: [email] attribute on chips within compose container
  const emailChips = composeContainer.querySelectorAll('[email]');
  for (const chip of emailChips) {
    const email = (chip.getAttribute('email') || '').trim();
    if (email.includes('@')) recipientSet.add(email.toLowerCase());
  }

  // Strategy 4: Span elements with email-like text inside the To row
  if (toField) {
    const parent = toField.closest('tr') || toField.parentElement?.parentElement;
    if (parent) {
      const spans = parent.querySelectorAll('span');
      for (const span of spans) {
        const text = (span.getAttribute('email') || span.textContent || '').trim();
        if (text.includes('@') && text.includes('.')) {
          recipientSet.add(text.toLowerCase());
        }
      }
    }
  }

  // Strategy 5: CC and BCC fields
  const ccFields = composeContainer.querySelectorAll(
    'input[aria-label="Cc recipients"], input[aria-label="Bcc recipients"], input[name="cc"], input[name="bcc"]'
  );
  for (const field of ccFields) {
    if (field.value) {
      field.value.split(/[,;]/).forEach(function(part) {
        const trimmed = part.trim();
        if (trimmed.includes('@')) recipientSet.add(trimmed.toLowerCase());
      });
    }
  }
  // CC/BCC resolved chips
  const ccContainers = composeContainer.querySelectorAll('[aria-label="Cc recipients"], [aria-label="Bcc recipients"]');
  for (const ccContainer of ccContainers) {
    const parent = ccContainer.closest('tr') || ccContainer.parentElement?.parentElement;
    if (parent) {
      parent.querySelectorAll('[email], [data-hovercard-id]').forEach(function(el) {
        const email = (el.getAttribute('email') || el.getAttribute('data-hovercard-id') || '').trim();
        if (email.includes('@')) recipientSet.add(email.toLowerCase());
      });
    }
  }

  const recipientEmails = Array.from(recipientSet);

  console.log('[NodeZero] Compose detected —', recipientEmails.length, 'recipient(s):', recipientEmails.join(', ') || '(none found)');

  return {
    recipientEmail: recipientEmails[0] || '',      // backward compat (first recipient)
    recipientEmails: recipientEmails,               // all recipients (To + CC + BCC)
    bodyHtml: composeBody.innerHTML || '',
    bodyText: htmlToPlainText(composeBody.innerHTML || ''),
  };
}

/**
 * Convert Gmail compose HTML to plain text preserving line breaks.
 * Gmail uses <div>, <br>, and <p> for line breaks in contenteditable.
 * .textContent strips all of these, so we convert them to \n first.
 */
function htmlToPlainText(html) {
  // Replace block-level element boundaries with newlines
  let text = html
    .replace(/<br\s*\/?>/gi, '\n')              // <br> → newline
    .replace(/<\/div>\s*<div[^>]*>/gi, '\n')     // </div><div> → newline (Gmail's enter key)
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')       // </p><p> → double newline
    .replace(/<\/?(div|p|blockquote|li|tr|h[1-6])[^>]*>/gi, '\n')  // other block elements
    .replace(/<[^>]+>/g, '')                      // strip remaining HTML tags
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");

  // Collapse runs of 3+ newlines into 2, but preserve intentional double newlines
  text = text.replace(/\n{3,}/g, '\n\n');

  // Trim leading/trailing whitespace per line, but preserve blank lines
  text = text.split('\n').map(line => line.trim()).join('\n');

  // Trim leading/trailing newlines from entire text
  return text.trim();
}

/**
 * Replace the compose body with encrypted content.
 */
function replaceComposeBody(payload) {
  const { content } = payload;
  const composeBody = document.querySelector(
    'div[aria-label="Message Body"][contenteditable="true"]'
  );

  if (!composeBody) {
    return { error: 'No compose window found.' };
  }

  // Replace content — use innerHTML so <br> tags render as line breaks
  // Escape HTML entities in content first, then convert \n to <br>
  const escaped = content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
  composeBody.innerHTML = escaped;
  composeBody.dispatchEvent(new Event('input', { bubbles: true }));

  return { success: true };
}

/**
 * Extract the currently viewed email message body text.
 */
function getGmailMessageInfo() {
  // Gmail message body: div.a3s.aiL
  const messageBody = document.querySelector('div.a3s.aiL');
  if (!messageBody) {
    return { error: 'No email message body found. Open an email first.' };
  }

  return {
    bodyText: messageBody.textContent || '',
    bodyHtml: messageBody.innerHTML || '',
  };
}

/**
 * Replace the viewed email message body with decrypted content.
 */
function replaceMessageBody(payload) {
  const { content } = payload;
  const messageBody = document.querySelector('div.a3s.aiL');
  if (!messageBody) {
    return { error: 'No email message body found.' };
  }

  // Replace with decrypted content (as text, preserving line breaks)
  messageBody.innerHTML = content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');

  return { success: true };
}

// ── Auto-decrypt: MutationObserver for Gmail message opens ──────────────
// Watches for Gmail message bodies (div.a3s.aiL) that contain NODEZERO
// markers. When found, sends a message to the background script to
// decrypt automatically (if the vault is unlocked).

const MARKER_V1 = '---NODEZERO-v1---';
const MARKER_V2 = '---NODEZERO-v2---';

function checkAndAutoDecrypt(element) {
  const text = element.textContent || '';
  if (text.includes(MARKER_V1) || text.includes(MARKER_V2)) {
    // Mark as processing to avoid duplicate attempts
    if (element.dataset.nodezeroAutoDecrypt) return;
    element.dataset.nodezeroAutoDecrypt = 'pending';

    console.log('[NodeZero] Auto-decrypt: encrypted message detected');

    // Send the encrypted text directly so background can decrypt the right
    // message (conversation view may have multiple div.a3s.aiL elements)
    chrome.runtime.sendMessage(
      { type: 'autoDecryptEmail', from: 'content', payload: { bodyText: text } },
      function(response) {
        if (chrome.runtime.lastError) {
          console.log('[NodeZero] Auto-decrypt send error:', chrome.runtime.lastError.message);
          delete element.dataset.nodezeroAutoDecrypt;
          return;
        }
        if (response?.error) {
          console.log('[NodeZero] Auto-decrypt skipped:', response.error);
          if (response.queued) {
            // Action was queued for after unlock — show inline hint
            element.dataset.nodezeroAutoDecrypt = 'queued';
            injectUnlockHint(element);
          } else {
            // Other error — allow retry via right-click
            delete element.dataset.nodezeroAutoDecrypt;
          }
        } else if (response?.success) {
          // Replace this element's content with decrypted text
          if (response.decryptedHtml) {
            element.innerHTML = response.decryptedHtml;
          }
          element.dataset.nodezeroAutoDecrypt = 'done';
          console.log('[NodeZero] Auto-decrypt completed');
        }
      }
    );
  }
}

/**
 * Inject a small visual hint above the encrypted blob telling the user
 * to click the NodeZero icon to unlock and decrypt.
 */
function injectUnlockHint(element) {
  // Avoid duplicate hints
  if (element.querySelector('.nodezero-unlock-hint')) return;

  var hint = document.createElement('div');
  hint.className = 'nodezero-unlock-hint';
  hint.style.cssText =
    'background:#FEF3C7;border:1px solid #F59E0B;border-radius:6px;' +
    'padding:8px 12px;margin-bottom:8px;font-size:13px;color:#92400E;' +
    'display:flex;align-items:center;gap:8px;';
  hint.innerHTML =
    '<span style="font-size:18px">🔒</span>' +
    '<span>This message is encrypted. Click the <strong>NodeZero</strong> extension icon to unlock with your face/fingerprint, then it will decrypt automatically.</span>';
  element.insertBefore(hint, element.firstChild);
}

// Only set up observer on Gmail pages
if (
  !window.__nodezero_autodecrypt_observer &&
  window.location.hostname === 'mail.google.com'
) {
  window.__nodezero_autodecrypt_observer = true;

  const observer = new MutationObserver(function(mutations) {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        // Check if the added node is a message body
        const messageBodies = node.matches?.('div.a3s.aiL')
          ? [node]
          : (node.querySelectorAll?.('div.a3s.aiL') || []);
        for (const body of messageBodies) {
          checkAndAutoDecrypt(body);
        }
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Also check any already-visible message bodies on inject
  document.querySelectorAll('div.a3s.aiL').forEach(function(body) {
    checkAndAutoDecrypt(body);
  });

  // Listen for "vault unlocked" broadcast from background — re-scan all
  // queued messages so they decrypt without the user needing to navigate away
  chrome.runtime.onMessage.addListener(function(message) {
    if (message.type === 'vaultUnlocked') {
      console.log('[NodeZero] Vault unlocked — re-scanning for encrypted messages');
      // Remove any unlock hint banners
      document.querySelectorAll('.nodezero-unlock-hint').forEach(function(hint) {
        hint.remove();
      });
      // Reset queued elements so they can be re-processed
      document.querySelectorAll('[data-nodezero-auto-decrypt="queued"]').forEach(function(el) {
        delete el.dataset.nodezeroAutoDecrypt;
        checkAndAutoDecrypt(el);
      });
    }
  });

  console.log('[NodeZero] Auto-decrypt observer active on Gmail');
}
