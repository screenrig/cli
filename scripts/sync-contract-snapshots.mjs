import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cliRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const mode = process.argv.includes('--sync') ? 'sync' : 'check';
const sourceFlag = process.argv.indexOf('--source-root');
const sourceRootGiven = sourceFlag >= 0;
const sourceRootArg = sourceRootGiven ? process.argv[sourceFlag + 1] : undefined;
if (sourceRootGiven && (sourceRootArg === undefined || sourceRootArg.startsWith('--'))) {
  // Resolving an empty value would silently fall back to the current directory
  // and report confusing drift, so refuse the argument outright.
  console.error('--source-root requires a path, for example --source-root ../backend');
  process.exit(1);
}
const sourceRoot = sourceRootGiven
  ? path.resolve(sourceRootArg)
  : path.resolve(cliRoot, '../..');

const snapshots = [
  {
    path: 'vendor/protocol/openapi.gen.ts',
    source: 'packages/protocol/src/openapi.gen.ts',
  },
  {
    path: 'vendor/openapi.yaml',
    source: 'api/openapi.yaml',
  },
  {
    path: 'assets/screenrig.runtime.js',
    source: 'packages/sdk/dist/screenrig.runtime.js',
  },
];

async function digest(filename) {
  const bytes = await readFile(filename);
  return {
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

async function actualManifest() {
  const files = [];
  for (const snapshot of snapshots) {
    files.push({ path: snapshot.path, source: snapshot.source, ...await digest(path.join(cliRoot, snapshot.path)) });
  }
  return {
    schema: 'screenrig.vendor-snapshot/v1',
    purpose: 'cli-contract-and-sdk-inputs',
    files,
  };
}

async function sync() {
  for (const snapshot of snapshots) {
    const source = path.join(sourceRoot, snapshot.source);
    await stat(source);
    const destination = path.join(cliRoot, snapshot.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
  const manifest = await actualManifest();
  await mkdir(path.join(cliRoot, 'vendor'), { recursive: true });
  await writeFile(path.join(cliRoot, 'vendor/manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Internal consistency only: the vendored bytes still match vendor/manifest.json.
 *
 * This proves nobody hand-edited vendor/, and nothing more. It cannot detect
 * that the backend contract moved on, because it never reads the backend. CI
 * has no backend checkout, so this stays the default gate. Use --source-root to
 * additionally check for drift.
 */
async function check() {
  const expected = JSON.parse(await readFile(path.join(cliRoot, 'vendor/manifest.json'), 'utf8'));
  const actual = await actualManifest();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('CLI contract/SDK snapshot differs from vendor/manifest.json; synchronize it from canonical backend inputs');
  }
}

/**
 * Drift: the vendored snapshot still matches the canonical backend inputs.
 *
 * Fails closed. A source root that is absent, unreadable, or missing any
 * canonical input is an error, never a pass, because this gate exists precisely
 * because the internal-consistency check failed open.
 */
async function checkDrift() {
  const rootProblems = [];
  try {
    const info = await stat(sourceRoot);
    if (!info.isDirectory()) {
      rootProblems.push(`--source-root is not a directory: ${sourceRoot}`);
    }
  } catch (error) {
    rootProblems.push(`--source-root is unreadable: ${sourceRoot} (${error.code ?? error.message})`);
  }
  if (rootProblems.length > 0) {
    throw new Error(
      [
        'Cannot verify contract drift.',
        ...rootProblems.map((problem) => `  ${problem}`),
        '  Pass --source-root <backend-checkout> pointing at a readable backend repository.',
      ].join('\n'),
    );
  }

  const drifted = [];
  const unreadable = [];
  for (const snapshot of snapshots) {
    const vendored = await digest(path.join(cliRoot, snapshot.path));
    let canonical;
    try {
      canonical = await digest(path.join(sourceRoot, snapshot.source));
    } catch (error) {
      unreadable.push(`  ${snapshot.source}: unreadable in the source root (${error.code ?? error.message})`);
      continue;
    }
    if (canonical.sha256 !== vendored.sha256 || canonical.bytes !== vendored.bytes) {
      drifted.push(
        [
          `  ${snapshot.path}`,
          `    vendored  ${vendored.sha256}  ${vendored.bytes} bytes`,
          `    canonical ${canonical.sha256}  ${canonical.bytes} bytes`,
          `    source    ${snapshot.source}`,
        ].join('\n'),
      );
    }
  }

  if (unreadable.length > 0 || drifted.length > 0) {
    const lines = [`CLI contract/SDK snapshot does not match the backend checkout at ${sourceRoot}.`];
    if (unreadable.length > 0) {
      lines.push('Missing canonical inputs:', ...unreadable);
    }
    if (drifted.length > 0) {
      lines.push('Drifted snapshots:', ...drifted);
    }
    lines.push(
      'Refresh with:',
      `  node scripts/sync-contract-snapshots.mjs --sync --source-root ${sourceRoot}`,
      'then review the whole generated diff before committing.',
    );
    throw new Error(lines.join('\n'));
  }
}

if (mode === 'sync') await sync();
await check();
if (mode === 'check' && sourceRootGiven) {
  await checkDrift();
  console.log(`CLI contract/SDK snapshot verified against ${sourceRoot}`);
} else {
  console.log(
    mode === 'sync'
      ? 'CLI contract/SDK snapshot synchronized and verified'
      : 'CLI contract/SDK snapshot verified (internal consistency only; pass --source-root to check for backend drift)',
  );
}
