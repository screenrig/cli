#!/usr/bin/env node
// Bundle the built CLI (dist/ after `npm run build`) and every runtime
// dependency into minified ESM files: dist/bin.js and the flat dist/*.js chunks
// it loads per command group. Write the files that travel with them: assets/,
// the runtime dependency lock, the license notices of every bundled package,
// and a package.json for the bundle.
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { loadRuntimeDependencyLock, NOTICES_FILE, RUNTIME_LOCK_FILE } from "./runtime-dependencies.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
// Fields of package.json that describe the bundle. The rest describe the npm
// package (its module entry points, file list and scripts).
const MANIFEST_FIELDS = ["name", "version", "private", "description", "homepage", "repository", "bugs", "license", "type", "bin", "engines", "dependencies"];
// The Claude plugin directory reads at most 256 KiB of a script and holds a
// larger one for review, so no bundled file may be bigger.
const MAX_OUTPUT_BYTES = 256 * 1024;
// Short lines keep the minified code reviewable as text.
const LINE_LIMIT = 500;

function packageOf(input) {
  const parts = input.split(/[\\/]/);
  const marker = parts.lastIndexOf("node_modules");
  if (marker < 0) return undefined;
  const first = parts[marker + 1];
  return first.startsWith("@") ? `${first}/${parts[marker + 2]}` : first;
}

async function licenseText(name) {
  const directory = path.join(root, "node_modules", name);
  const license = (await readdir(directory)).find((entry) => /^licen[cs]e(?:\.(?:md|txt))?$/i.test(entry));
  if (!license) throw new Error(`${name}: no license file to carry into ${NOTICES_FILE}`);
  return (await readFile(path.join(directory, license), "utf8")).trim();
}

async function main() {
  const flag = process.argv.indexOf("--destination");
  if (flag < 0 || !process.argv[flag + 1] || process.argv.length !== 4) {
    throw new Error("usage: bundle-release.mjs --destination <package-root>");
  }
  const destination = path.resolve(process.argv[flag + 1]);
  const runtimeLock = await loadRuntimeDependencyLock(root);
  await rm(path.join(destination, "dist"), { recursive: true, force: true });
  const result = await build({
    // Chunk names hash input paths relative to the working directory: pin it
    // to this checkout so every machine and CI produce the same files.
    absWorkingDir: root,
    entryPoints: [path.join(root, "dist", "bin.js")],
    outdir: path.join(destination, "dist"),
    // Chunks sit beside bin.js, so ../assets/ resolves from every one of them.
    entryNames: "[name]",
    chunkNames: "[name]-[hash]",
    splitting: true,
    bundle: true,
    minify: true,
    lineLimit: LINE_LIMIT,
    format: "esm",
    platform: "node",
    target: "node22",
    legalComments: "none",
    metafile: true,
    logLevel: "warning",
    // Bundled CommonJS dependencies require Node built-ins.
    banner: { js: 'import { createRequire as screenrigCreateRequire } from "node:module";\nconst require = screenrigCreateRequire(import.meta.url);' },
  });

  const outputs = Object.entries(result.metafile.outputs).map(([file, output]) => ({ file: path.relative(destination, file), bytes: output.bytes }));
  const oversized = outputs.filter((output) => output.bytes > MAX_OUTPUT_BYTES);
  if (oversized.length) {
    throw new Error(`${oversized.map((output) => `${output.file} is ${output.bytes} bytes`).join(", ")}; every bundled file must stay within ${MAX_OUTPUT_BYTES} bytes. Move code behind a command bundle (src/cli-commands/index.ts) or split a bundle.`);
  }

  // src/assets.ts reads these at run time from ../assets/ beside dist/.
  await mkdir(path.join(destination, "assets"), { recursive: true });
  for (const name of (await readdir(path.join(root, "assets"))).sort()) {
    await copyFile(path.join(root, "assets", name), path.join(destination, "assets", name));
  }

  const bundled = [...new Set(Object.keys(result.metafile.inputs).map(packageOf).filter(Boolean))].sort();
  const sections = [];
  for (const name of bundled) {
    const locked = runtimeLock.packages.find((entry) => entry.name === name);
    if (!locked) throw new Error(`${name} is bundled but is not a runtime dependency in package-lock.json`);
    const metadata = JSON.parse(await readFile(path.join(root, "node_modules", name, "package.json"), "utf8"));
    if (metadata.version !== locked.version) throw new Error(`${name}: node_modules has ${metadata.version}, package-lock.json has ${locked.version}; run npm ci`);
    sections.push(`${name}@${locked.version} (${metadata.license})\n${locked.resolved}\n\n${await licenseText(name)}\n`);
  }
  const rule = `\n${"=".repeat(72)}\n\n`;
  await writeFile(
    path.join(destination, NOTICES_FILE),
    `screenRIG CLI third-party notices\n\nThe files in dist/ bundle these packages. Each one's license follows.${rule}${sections.join(rule)}`,
    "utf8",
  );
  await writeFile(path.join(destination, RUNTIME_LOCK_FILE), `${JSON.stringify(runtimeLock, null, 2)}\n`, "utf8");
  const source = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const manifest = Object.fromEntries(MANIFEST_FIELDS.filter((field) => field in source).map((field) => [field, source[field]]));
  await writeFile(path.join(destination, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const largest = Math.max(...outputs.map((output) => output.bytes));
  process.stdout.write(`bundled ${outputs.length} files in dist/ (largest ${largest} bytes) with ${bundled.join(", ")}\n`);
}

main().catch((error) => {
  process.stderr.write(`bundle-release: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
