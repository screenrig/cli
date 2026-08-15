import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cliRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const mode = process.argv.includes('--sync') ? 'sync' : 'check';
const sourceFlag = process.argv.indexOf('--source-root');
const sourceRoot = sourceFlag >= 0
  ? path.resolve(process.argv[sourceFlag + 1] ?? '')
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

async function check() {
  const expected = JSON.parse(await readFile(path.join(cliRoot, 'vendor/manifest.json'), 'utf8'));
  const actual = await actualManifest();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('CLI contract/SDK snapshot differs from vendor/manifest.json; synchronize it from canonical backend inputs');
  }
}

if (mode === 'sync') await sync();
await check();
console.log(`CLI contract/SDK snapshot ${mode === 'sync' ? 'synchronized and ' : ''}verified`);
