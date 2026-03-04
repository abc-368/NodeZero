/**
 * Generate Chrome Web Store screenshots and promo tiles
 * from raw popup screenshots.
 *
 * Usage: node scripts/generate-cws-assets.mjs
 */

import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

const OUT = 'cws-assets';
fs.mkdirSync(OUT, { recursive: true });

// Brand colors
const BG_DEEP = '#080a12';
const BG_CARD = '#0d0f1a';
const PURPLE = '#7c3aed';
const CYAN = '#06b6d4';
const TEXT_PRIMARY = '#f0f2f8';
const TEXT_SECONDARY = '#a0a4b8';

// ── Helper: Create gradient background SVG ─────────────────────────────────
function gradientBg(w, h) {
  return Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="${w}" y2="${h}" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#050710"/>
        <stop offset="100%" stop-color="#0d0f1a"/>
      </linearGradient>
      <radialGradient id="glow1" cx="25%" cy="30%" r="40%">
        <stop offset="0%" stop-color="${PURPLE}" stop-opacity="0.15"/>
        <stop offset="100%" stop-color="${PURPLE}" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="glow2" cx="75%" cy="70%" r="35%">
        <stop offset="0%" stop-color="${CYAN}" stop-opacity="0.10"/>
        <stop offset="100%" stop-color="${CYAN}" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="${w}" height="${h}" fill="url(#bg)"/>
    <rect width="${w}" height="${h}" fill="url(#glow1)"/>
    <rect width="${w}" height="${h}" fill="url(#glow2)"/>
  </svg>`);
}

// ── Helper: Create text overlay SVG ────────────────────────────────────────
function textOverlay(w, h, title, subtitle, side = 'left', yOffset = 0) {
  const x = side === 'left' ? 80 : w - 500;
  const y = h / 2 + yOffset;
  return Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700');
    </style>
    <text x="${x}" y="${y - 30}" font-family="Inter, system-ui, sans-serif" font-size="36" font-weight="700" fill="${TEXT_PRIMARY}">
      ${escapeXml(title)}
    </text>
    <text x="${x}" y="${y + 14}" font-family="Inter, system-ui, sans-serif" font-size="18" fill="${TEXT_SECONDARY}">
      ${escapeXml(subtitle)}
    </text>
  </svg>`);
}

// ── Helper: Centered text overlay ──────────────────────────────────────────
function centeredTextOverlay(w, h, title, subtitle, yPos) {
  return Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <text x="${w/2}" y="${yPos}" font-family="Inter, system-ui, sans-serif" font-size="36" font-weight="700" fill="${TEXT_PRIMARY}" text-anchor="middle">
      ${escapeXml(title)}
    </text>
    <text x="${w/2}" y="${yPos + 40}" font-family="Inter, system-ui, sans-serif" font-size="18" fill="${TEXT_SECONDARY}" text-anchor="middle">
      ${escapeXml(subtitle)}
    </text>
  </svg>`);
}

// ── Helper: Badge/pill SVG ─────────────────────────────────────────────────
function badgeOverlay(w, h, text, x, y) {
  const bw = text.length * 8 + 24;
  return Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <rect x="${x - bw/2}" y="${y - 14}" width="${bw}" height="28" rx="14" fill="${PURPLE}" opacity="0.9"/>
    <text x="${x}" y="${y + 5}" font-family="Inter, system-ui, sans-serif" font-size="13" font-weight="600" fill="white" text-anchor="middle">
      ${escapeXml(text)}
    </text>
  </svg>`);
}

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Helper: Create popup frame (rounded card with shadow) ──────────────────
async function createFramedPopup(screenshotPath, targetH) {
  const img = sharp(screenshotPath);
  const meta = await img.metadata();
  const scale = targetH / meta.height;
  const newW = Math.round(meta.width * scale);
  const newH = Math.round(meta.height * scale);

  // Resize the screenshot
  const resized = await img.resize(newW, newH).png().toBuffer();

  // Create a rounded frame
  const padding = 4;
  const frameW = newW + padding * 2;
  const frameH = newH + padding * 2;
  const radius = 16;

  const frameSvg = Buffer.from(`<svg width="${frameW}" height="${frameH}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <filter id="shadow" x="-10%" y="-10%" width="130%" height="130%">
        <feDropShadow dx="0" dy="4" stdDeviation="20" flood-color="#000000" flood-opacity="0.5"/>
      </filter>
    </defs>
    <rect width="${frameW}" height="${frameH}" rx="${radius}" fill="#1a1d2e" filter="url(#shadow)"/>
  </svg>`);

  const frame = await sharp(frameSvg)
    .composite([{
      input: resized,
      left: padding,
      top: padding,
    }])
    .png()
    .toBuffer();

  return { buffer: frame, width: frameW, height: frameH };
}

// ── Helper: Create the NodeZero logo SVG ───────────────────────────────────
function logoSvg(size) {
  return Buffer.from(`<svg width="${size}" height="${size}" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="sg" x1="34" y1="22" x2="94" y2="106" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#7c3aed"/>
        <stop offset="100%" stop-color="#06b6d4"/>
      </linearGradient>
      <linearGradient id="lg" x1="48" y1="52" x2="80" y2="88" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#ffffff"/>
        <stop offset="100%" stop-color="#e0e7ff"/>
      </linearGradient>
      <linearGradient id="ibg" x1="0" y1="0" x2="128" y2="128" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#0d0f1a"/>
        <stop offset="100%" stop-color="#080a12"/>
      </linearGradient>
    </defs>
    <path d="M64 18L30 32V62C30 84 44.5 103 64 110C83.5 103 98 84 98 62V32L64 18Z" fill="url(#sg)" opacity="0.9"/>
    <path d="M64 24L36 36V62C36 81 48.5 97 64 103C79.5 97 92 81 92 62V36L64 24Z" fill="url(#ibg)" opacity="0.6"/>
    <rect x="50" y="60" width="28" height="22" rx="4" fill="url(#lg)"/>
    <path d="M54 60V52C54 46.5 58.5 42 64 42C69.5 42 74 46.5 74 52V60" stroke="url(#lg)" stroke-width="5" stroke-linecap="round" fill="none"/>
    <circle cx="64" cy="70" r="3.5" fill="#0d0f1a"/>
    <rect x="62.5" y="72" width="3" height="5" rx="1.5" fill="#0d0f1a"/>
  </svg>`);
}

// ═══════════════════════════════════════════════════════════════════════════
// GENERATE SCREENSHOTS (1280x800)
// ═══════════════════════════════════════════════════════════════════════════

async function generateScreenshot1() {
  // Screenshot 1: Unlock Screen
  const W = 1280, H = 800;
  const bg = await sharp(gradientBg(W, H)).png().toBuffer();
  const popup = await createFramedPopup('screenshots/Screenshot 2026-03-03 083238.png', 520);

  const composites = [
    // Place popup on the right side
    { input: popup.buffer, left: W - popup.width - 140, top: Math.round((H - popup.height) / 2) },
    // Text on the left
    { input: textOverlay(W, H, 'Secure Vault Unlock', 'PIN or hardware security key — your choice', 'left', -20), left: 0, top: 0 },
    // Logo
    { input: logoSvg(56), left: 80, top: H / 2 - 100 },
  ];

  await sharp(bg).composite(composites).flatten({ background: BG_DEEP }).jpeg({ quality: 95 }).toFile(path.join(OUT, 'screenshot-1-unlock.jpg'));
  console.log('  screenshot-1-unlock.jpg');
}

async function generateScreenshot2() {
  // Screenshot 2: Settings (DID, Sync, Theme)
  const W = 1280, H = 800;
  const bg = await sharp(gradientBg(W, H)).png().toBuffer();
  const popup = await createFramedPopup('screenshots/Screenshot 2026-03-03 083800.png', 580);

  const composites = [
    { input: popup.buffer, left: W - popup.width - 120, top: Math.round((H - popup.height) / 2) },
    { input: textOverlay(W, H, 'Your Identity, Your Rules', 'DID-based identity, cloud sync, and license — all in one place', 'left', -20), left: 0, top: 0 },
    { input: logoSvg(56), left: 80, top: H / 2 - 100 },
  ];

  await sharp(bg).composite(composites).flatten({ background: BG_DEEP }).jpeg({ quality: 95 }).toFile(path.join(OUT, 'screenshot-2-settings.jpg'));
  console.log('  screenshot-2-settings.jpg');
}

async function generateScreenshot3() {
  // Screenshot 3: Website features (full-width)
  const W = 1280, H = 800;
  const bg = await sharp(gradientBg(W, H)).png().toBuffer();

  // Resize the website screenshot to fit nicely with some padding
  const webImg = sharp('screenshots/Screenshot 2026-03-03 084434.png');
  const webMeta = await webImg.metadata();
  const targetW = 1080;
  const scale = targetW / webMeta.width;
  const targetH = Math.round(webMeta.height * scale);
  const resizedWeb = await webImg.resize(targetW, targetH).png().toBuffer();

  const composites = [
    { input: centeredTextOverlay(W, H, 'Everything You Need', 'Core security is never paywalled', 60), left: 0, top: 0 },
    { input: resizedWeb, left: Math.round((W - targetW) / 2), top: 110 },
  ];

  await sharp(bg).composite(composites).flatten({ background: BG_DEEP }).jpeg({ quality: 95 }).toFile(path.join(OUT, 'screenshot-3-features.jpg'));
  console.log('  screenshot-3-features.jpg');
}

async function generateScreenshot4() {
  // Screenshot 4: About section + Vault Sync (combined into one branded shot)
  const W = 1280, H = 800;
  const bg = await sharp(gradientBg(W, H)).png().toBuffer();

  // Use the about snippet and vault sync snippet
  const aboutImg = await sharp('screenshots/Screenshot 2026-03-03 084004.png').resize(500, null).png().toBuffer();
  const aboutMeta = await sharp(aboutImg).metadata();

  const syncImg = await sharp('screenshots/Screenshot 2026-03-03 084148.png').resize(500, null).png().toBuffer();
  const syncMeta = await sharp(syncImg).metadata();

  // Create card backgrounds for each snippet
  const cardW = 540, card1H = aboutMeta.height + 40, card2H = syncMeta.height + 40;
  const card1 = Buffer.from(`<svg width="${cardW}" height="${card1H}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${cardW}" height="${card1H}" rx="12" fill="#12152a" stroke="#1a1d2e" stroke-width="1"/>
  </svg>`);
  const card2 = Buffer.from(`<svg width="${cardW}" height="${card2H}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${cardW}" height="${card2H}" rx="12" fill="#12152a" stroke="#1a1d2e" stroke-width="1"/>
  </svg>`);

  const framedCard1 = await sharp(card1).composite([{ input: aboutImg, left: 20, top: 20 }]).png().toBuffer();
  const framedCard2 = await sharp(card2).composite([{ input: syncImg, left: 20, top: 20 }]).png().toBuffer();

  const rightX = W - cardW - 100;
  const composites = [
    { input: textOverlay(W, H, 'Open Source & Transparent', 'AGPL-3.0 licensed. Every line of code is auditable.', 'left', -60), left: 0, top: 0 },
    { input: logoSvg(56), left: 80, top: H / 2 - 140 },
    { input: framedCard1, left: rightX, top: Math.round(H / 2 - card1H - 20) },
    { input: framedCard2, left: rightX, top: Math.round(H / 2 + 20) },
  ];

  await sharp(bg).composite(composites).flatten({ background: BG_DEEP }).jpeg({ quality: 95 }).toFile(path.join(OUT, 'screenshot-4-about.jpg'));
  console.log('  screenshot-4-about.jpg');
}

async function generateScreenshot5() {
  // Screenshot 5: Both unlock screens side by side (empty + filled)
  const W = 1280, H = 800;
  const bg = await sharp(gradientBg(W, H)).png().toBuffer();

  const popup1 = await createFramedPopup('screenshots/Screenshot 2026-03-03 083405.png', 460);
  const popup2 = await createFramedPopup('screenshots/Screenshot 2026-03-03 083238.png', 460);

  const gap = 40;
  const totalW = popup1.width + gap + popup2.width;
  const startX = Math.round((W - totalW) / 2);
  const popupY = 180;

  const composites = [
    { input: centeredTextOverlay(W, H, 'Zero-Knowledge Authentication', 'Hardware security keys or vault PIN — no master password ever', 60), left: 0, top: 0 },
    { input: popup1.buffer, left: startX, top: popupY },
    { input: popup2.buffer, left: startX + popup1.width + gap, top: popupY },
    { input: badgeOverlay(W, H, 'Ready to unlock', startX + popup1.width / 2, popupY + popup1.height + 30), left: 0, top: 0 },
    { input: badgeOverlay(W, H, 'PIN entered', startX + popup1.width + gap + popup2.width / 2, popupY + popup2.height + 30), left: 0, top: 0 },
  ];

  await sharp(bg).composite(composites).flatten({ background: BG_DEEP }).jpeg({ quality: 95 }).toFile(path.join(OUT, 'screenshot-5-auth.jpg'));
  console.log('  screenshot-5-auth.jpg');
}

// ═══════════════════════════════════════════════════════════════════════════
// GENERATE PROMO TILES
// ═══════════════════════════════════════════════════════════════════════════

async function generateSmallPromo() {
  // Small promo: 440x280
  const W = 440, H = 280;

  const svgContent = Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="pbg" x1="0" y1="0" x2="${W}" y2="${H}" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#050710"/>
        <stop offset="100%" stop-color="#0d0f1a"/>
      </linearGradient>
      <radialGradient id="pg1" cx="30%" cy="40%" r="50%">
        <stop offset="0%" stop-color="${PURPLE}" stop-opacity="0.20"/>
        <stop offset="100%" stop-color="${PURPLE}" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="pg2" cx="80%" cy="70%" r="40%">
        <stop offset="0%" stop-color="${CYAN}" stop-opacity="0.12"/>
        <stop offset="100%" stop-color="${CYAN}" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="tg" x1="0" y1="0" x2="300" y2="0" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="${PURPLE}"/>
        <stop offset="100%" stop-color="${CYAN}"/>
      </linearGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#pbg)"/>
    <rect width="${W}" height="${H}" fill="url(#pg1)"/>
    <rect width="${W}" height="${H}" fill="url(#pg2)"/>

    <!-- Logo shield -->
    <g transform="translate(170, 40) scale(0.55)">
      <path d="M64 18L30 32V62C30 84 44.5 103 64 110C83.5 103 98 84 98 62V32L64 18Z" fill="url(#tg)" opacity="0.9"/>
      <path d="M64 24L36 36V62C36 81 48.5 97 64 103C79.5 97 92 81 92 62V36L64 24Z" fill="#080a12" opacity="0.6"/>
      <rect x="50" y="60" width="28" height="22" rx="4" fill="white"/>
      <path d="M54 60V52C54 46.5 58.5 42 64 42C69.5 42 74 46.5 74 52V60" stroke="white" stroke-width="5" stroke-linecap="round" fill="none"/>
      <circle cx="64" cy="70" r="3.5" fill="#0d0f1a"/>
      <rect x="62.5" y="72" width="3" height="5" rx="1.5" fill="#0d0f1a"/>
    </g>

    <!-- Text -->
    <text x="${W/2}" y="160" font-family="Inter, system-ui, -apple-system, sans-serif" font-size="28" font-weight="700" fill="${TEXT_PRIMARY}" text-anchor="middle">
      NodeZero
    </text>
    <text x="${W/2}" y="192" font-family="Inter, system-ui, -apple-system, sans-serif" font-size="13" fill="${TEXT_SECONDARY}" text-anchor="middle">
      Decentralized Password Manager
    </text>

    <!-- Tagline -->
    <text x="${W/2}" y="235" font-family="Inter, system-ui, -apple-system, sans-serif" font-size="12" fill="url(#tg)" text-anchor="middle" font-weight="600">
      Your Keys. Your Vault. No Central Server.
    </text>
  </svg>`);

  await sharp(svgContent).flatten({ background: BG_DEEP }).jpeg({ quality: 95 }).toFile(path.join(OUT, 'promo-small-440x280.jpg'));
  console.log('  promo-small-440x280.jpg');
}

async function generateMarqueePromo() {
  // Marquee promo: 1400x560
  const W = 1400, H = 560;

  const svgContent = Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="mbg" x1="0" y1="0" x2="${W}" y2="${H}" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#050710"/>
        <stop offset="100%" stop-color="#0d0f1a"/>
      </linearGradient>
      <radialGradient id="mg1" cx="20%" cy="40%" r="40%">
        <stop offset="0%" stop-color="${PURPLE}" stop-opacity="0.18"/>
        <stop offset="100%" stop-color="${PURPLE}" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="mg2" cx="80%" cy="60%" r="35%">
        <stop offset="0%" stop-color="${CYAN}" stop-opacity="0.12"/>
        <stop offset="100%" stop-color="${CYAN}" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="mtg" x1="0" y1="0" x2="500" y2="0" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="${PURPLE}"/>
        <stop offset="100%" stop-color="${CYAN}"/>
      </linearGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#mbg)"/>
    <rect width="${W}" height="${H}" fill="url(#mg1)"/>
    <rect width="${W}" height="${H}" fill="url(#mg2)"/>

    <!-- Left side: Logo + text -->
    <g transform="translate(120, 115) scale(0.8)">
      <path d="M64 18L30 32V62C30 84 44.5 103 64 110C83.5 103 98 84 98 62V32L64 18Z" fill="url(#mtg)" opacity="0.9"/>
      <path d="M64 24L36 36V62C36 81 48.5 97 64 103C79.5 97 92 81 92 62V36L64 24Z" fill="#080a12" opacity="0.6"/>
      <rect x="50" y="60" width="28" height="22" rx="4" fill="white"/>
      <path d="M54 60V52C54 46.5 58.5 42 64 42C69.5 42 74 46.5 74 52V60" stroke="white" stroke-width="5" stroke-linecap="round" fill="none"/>
      <circle cx="64" cy="70" r="3.5" fill="#0d0f1a"/>
      <rect x="62.5" y="72" width="3" height="5" rx="1.5" fill="#0d0f1a"/>
    </g>

    <!-- Title -->
    <text x="270" y="195" font-family="Inter, system-ui, -apple-system, sans-serif" font-size="52" font-weight="700" fill="${TEXT_PRIMARY}">
      NodeZero
    </text>

    <!-- Subtitle -->
    <text x="120" y="260" font-family="Inter, system-ui, -apple-system, sans-serif" font-size="20" fill="${TEXT_SECONDARY}">
      Decentralized Password Manager
    </text>

    <!-- Tagline with gradient -->
    <text x="120" y="310" font-family="Inter, system-ui, -apple-system, sans-serif" font-size="18" fill="url(#mtg)" font-weight="600">
      Your Keys. Your Vault. No Central Server.
    </text>

    <!-- Feature pills -->
    <rect x="120" y="350" width="180" height="36" rx="18" fill="${PURPLE}" opacity="0.15" stroke="${PURPLE}" stroke-opacity="0.4" stroke-width="1"/>
    <text x="210" y="374" font-family="Inter, system-ui, sans-serif" font-size="13" fill="${TEXT_PRIMARY}" text-anchor="middle" font-weight="500">
      AES-256-GCM Encryption
    </text>

    <rect x="320" y="350" width="150" height="36" rx="18" fill="${CYAN}" opacity="0.1" stroke="${CYAN}" stroke-opacity="0.3" stroke-width="1"/>
    <text x="395" y="374" font-family="Inter, system-ui, sans-serif" font-size="13" fill="${TEXT_PRIMARY}" text-anchor="middle" font-weight="500">
      WebAuthn / FIDO2
    </text>

    <rect x="490" y="350" width="150" height="36" rx="18" fill="${PURPLE}" opacity="0.15" stroke="${PURPLE}" stroke-opacity="0.4" stroke-width="1"/>
    <text x="565" y="374" font-family="Inter, system-ui, sans-serif" font-size="13" fill="${TEXT_PRIMARY}" text-anchor="middle" font-weight="500">
      DID-Based Identity
    </text>

    <!-- Badge -->
    <rect x="120" y="420" width="100" height="28" rx="6" fill="${PURPLE}" opacity="0.2" stroke="${PURPLE}" stroke-opacity="0.5" stroke-width="1"/>
    <text x="170" y="439" font-family="Inter, system-ui, sans-serif" font-size="11" fill="${PURPLE}" text-anchor="middle" font-weight="600" opacity="0.9">
      AGPL-3.0
    </text>

    <rect x="235" y="420" width="110" height="28" rx="6" fill="${CYAN}" opacity="0.15" stroke="${CYAN}" stroke-opacity="0.4" stroke-width="1"/>
    <text x="290" y="439" font-family="Inter, system-ui, sans-serif" font-size="11" fill="${CYAN}" text-anchor="middle" font-weight="600" opacity="0.9">
      Zero Telemetry
    </text>

    <!-- Right side: decorative shield glow -->
    <circle cx="1100" cy="280" r="200" fill="${PURPLE}" opacity="0.04"/>
    <circle cx="1100" cy="280" r="120" fill="${CYAN}" opacity="0.04"/>

    <!-- Right side shield (larger, faded) -->
    <g transform="translate(1000, 100) scale(2.8)" opacity="0.12">
      <path d="M64 18L30 32V62C30 84 44.5 103 64 110C83.5 103 98 84 98 62V32L64 18Z" fill="url(#mtg)"/>
    </g>
  </svg>`);

  await sharp(svgContent).flatten({ background: BG_DEEP }).jpeg({ quality: 95 }).toFile(path.join(OUT, 'promo-marquee-1400x560.jpg'));
  console.log('  promo-marquee-1400x560.jpg');
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('Generating CWS assets...\n');

  console.log('Screenshots (1280x800):');
  await generateScreenshot1();
  await generateScreenshot2();
  await generateScreenshot3();
  await generateScreenshot4();
  await generateScreenshot5();

  console.log('\nPromo tiles:');
  await generateSmallPromo();
  await generateMarqueePromo();

  console.log(`\nAll assets saved to ${OUT}/`);
}

main().catch(err => { console.error(err); process.exit(1); });
