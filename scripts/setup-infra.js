import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * NodeZero Infrastructure Setup Automation
 * v2.0.0
 *
 * What it does:
 *   1. Ensures you're logged in to your hosting provider (wrangler)
 *   2. Creates the key-value namespace (CID_STORE) if needed
 *   3. Creates the vault storage bucket if needed
 *   4. Patches wrangler.toml with the real namespace ID
 *   5. Deploys the sync service from cloudflare/cid-pointer/
 *   6. Generates .env.local + setup-extension.html
 *
 * Usage:
 *   npm run setup
 */

const WORKER_DIR = path.join(process.cwd(), 'cloudflare', 'cid-pointer');
const KV_NAMESPACE_NAME = 'CID_STORE';
const R2_BUCKET_NAME = 'nodezero-vaults';

function run(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf-8', ...opts }).trim();
}

function runSafe(cmd) {
  try { return run(cmd); } catch { return null; }
}

async function main() {
  console.log('🚀 NodeZero Infrastructure Setup (v2.0.0)\n');

  try {
    // ── 1. Hosting provider login ──────────────────────────────────────────
    console.log('--- [1/5] Provider Login ---');
    if (!runSafe('npx wrangler whoami')) {
      console.log('Logging in to hosting provider...');
      execSync('npx wrangler login', { stdio: 'inherit' });
    }
    console.log('✅ Authenticated\n');

    // ── 2. KV namespace ────────────────────────────────────────────────────
    console.log('--- [2/5] KV Namespace ---');
    let kvId = null;

    const kvListRaw = runSafe('npx wrangler kv:namespace list --json');
    if (kvListRaw) {
      try {
        const kvList = JSON.parse(kvListRaw.substring(kvListRaw.indexOf('[')));
        const existing = kvList.find(ns => ns.title.includes(KV_NAMESPACE_NAME));
        if (existing) kvId = existing.id;
      } catch { /* parse failure — will create below */ }
    }

    if (!kvId) {
      console.log(`Creating KV namespace "${KV_NAMESPACE_NAME}"...`);
      const createOutput = run(`npx wrangler kv:namespace create ${KV_NAMESPACE_NAME}`);
      const idMatch = createOutput.match(/id\s*=\s*"([a-f0-9]+)"/);
      if (idMatch) kvId = idMatch[1];
    }

    if (!kvId) {
      throw new Error('Failed to create or find KV namespace. Run manually:\n  npx wrangler kv:namespace create CID_STORE');
    }
    console.log(`✅ KV Namespace ID: ${kvId}\n`);

    // ── 3. Vault storage bucket ─────────────────────────────────────────────
    console.log('--- [3/5] Vault Storage Bucket ---');
    const r2ListRaw = runSafe('npx wrangler r2 bucket list');
    const bucketExists = r2ListRaw && r2ListRaw.includes(R2_BUCKET_NAME);

    if (!bucketExists) {
      console.log(`Creating vault storage bucket "${R2_BUCKET_NAME}"...`);
      run(`npx wrangler r2 bucket create ${R2_BUCKET_NAME}`);
    }
    console.log(`✅ Vault Storage Bucket: ${R2_BUCKET_NAME}\n`);

    // ── 4. Patch wrangler.toml with real KV ID ─────────────────────────────
    console.log('--- [4/5] Patch wrangler.toml ---');
    const tomlPath = path.join(WORKER_DIR, 'wrangler.toml');
    let toml = fs.readFileSync(tomlPath, 'utf-8');

    // Replace placeholder KV ID
    toml = toml.replace(
      /id\s*=\s*"REPLACE_WITH_YOUR_KV_NAMESPACE_ID"/,
      `id = "${kvId}"`
    );
    toml = toml.replace(
      /preview_id\s*=\s*"REPLACE_WITH_YOUR_PREVIEW_KV_NAMESPACE_ID"/,
      `preview_id = "${kvId}"`
    );
    fs.writeFileSync(tomlPath, toml);
    console.log('✅ wrangler.toml updated with KV namespace ID\n');

    // ── 5. Deploy Worker ───────────────────────────────────────────────────
    console.log('--- [5/5] Deploy Worker ---');
    console.log('Installing Worker dependencies...');
    execSync('npm install', { cwd: WORKER_DIR, stdio: 'inherit' });

    console.log('Deploying Worker...');
    const deployOutput = run('npx wrangler deploy', { cwd: WORKER_DIR });
    console.log(deployOutput);

    const workerUrl = deployOutput.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0];
    if (!workerUrl) {
      throw new Error('Could not extract Worker URL from deploy output');
    }
    console.log(`✅ Worker deployed: ${workerUrl}\n`);

    // ── Generate config files ──────────────────────────────────────────────
    const envContent = `VITE_POINTER_SERVICE_URL="${workerUrl}"`;
    fs.writeFileSync('.env.local', envContent);
    console.log('✅ .env.local written\n');

    const setupHtml = generateSetupHtml(workerUrl);
    fs.writeFileSync('setup-extension.html', setupHtml);
    console.log('✅ setup-extension.html written\n');

    // ── Done ───────────────────────────────────────────────────────────────
    console.log('='.repeat(55));
    console.log('🏁 NodeZero v2.0.0 Infrastructure Ready!');
    console.log('='.repeat(55));
    console.log('');
    console.log('Next steps:');
    console.log('  1. npm run build');
    console.log('  2. Go to chrome://extensions → refresh NodeZero');
    console.log('  3. Open setup-extension.html → copy config to service worker console');
    console.log('  4. Re-unlock your vault and press "Sync Now"');
    console.log('');
    console.log('Verify Worker: curl ' + workerUrl + '/v1/version');
    console.log('  Expected:    {"version":"2.0.0"}');
    console.log('='.repeat(55));

  } catch (err) {
    console.error('\n❌ Setup failed:', err.message);
    process.exit(1);
  }
}

function generateSetupHtml(workerUrl) {
  return `<!DOCTYPE html>
<html>
<head>
    <title>NodeZero Setup</title>
    <style>
        body { font-family: system-ui, sans-serif; padding: 40px; line-height: 1.6; max-width: 600px; margin: 0 auto; background: #18181b; color: white; }
        .card { background: #27272a; padding: 24px; border-radius: 12px; border: 1px solid #3f3f46; }
        h2 { margin-top: 0; }
        code { background: #3f3f46; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
        button { background: #3b82f6; color: white; border: none; padding: 12px 24px; border-radius: 6px; cursor: pointer; font-weight: bold; width: 100%; font-size: 16px; }
        button:hover { background: #2563eb; }
        .success { color: #10b981; display: none; margin-top: 20px; font-weight: bold; text-align: center; }
        .note { margin-top: 16px; padding: 12px; background: #1e3a5f; border-radius: 8px; font-size: 13px; color: #93c5fd; }
    </style>
</head>
<body>
    <div class="card">
        <h2>NodeZero Setup (v2.0.0)</h2>
        <ol>
            <li>Go to <code>chrome://extensions</code></li>
            <li>Click <strong>service worker</strong> link for NodeZero</li>
            <li>Paste the code below into the console and press <strong>Enter</strong></li>
        </ol>
        <button id="btn">Copy Configuration Code</button>
        <div id="msg" class="success">✅ Code copied! Paste it into the Service Worker console.</div>
        <div class="note">
            <strong>What this does:</strong> Sets the Worker URL so the extension knows
            where to sync your encrypted vault. No tokens or API keys needed — the
            extension authenticates via Ed25519 DID signatures.
        </div>
    </div>
    <script>
        document.getElementById('btn').onclick = async () => {
            const cmd = \`chrome.storage.local.set({ nodezero_pointer_url: '${workerUrl}' }, () => console.log('✅ NodeZero v2.0.0 configured! Worker URL set.'));\`;
            await navigator.clipboard.writeText(cmd);
            document.getElementById('msg').style.display = 'block';
        };
    </script>
</body>
</html>`;
}

main();
