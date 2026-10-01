#!/usr/bin/env node
// Bundle the built CLI (dist/bin.js after `npm run build`) and every runtime
// dependency into one minified ESM file, and write the files that travel with
// it: the runtime lock the renderer download checks, the license notices of
// every bundled package, and a package.json for the bundle.
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { isRendererPlatformPackage, loadRuntimeDependencyLock, NOTICES_FILE, RUNTIME_LOCK_FILE } from "./runtime-dependencies.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
// Fields of package.json that describe the bundle. The rest describe the npm
// package (its module entry points, file list and scripts).
const MANIFEST_FIELDS = ["name", "version", "private", "description", "homepage", "repository", "bugs", "license", "type", "bin", "engines", "dependencies"];

// The release bundle carries src/assets.ts's files inline, JSON minified.
const embedAssets = {
  name: "embed-assets",
  setup(build) {
    build.onLoad({ filter: /[\\/]dist[\\/]assets\.js$/ }, async () => {
      const assets = {};
      for (const name of (await readdir(path.join(root, "assets"))).sort()) {
        const bytes = await readFile(path.join(root, "assets", name));
        const text = bytes.toString("utf8");
        if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error(`assets/${name} is not UTF-8 text`);
        assets[name] = name.endsWith(".json") ? JSON.stringify(JSON.parse(text)) : text;
      }
      return {
        loader: "js",
        contents: `const assets = ${JSON.stringify(assets)};\nexport function readAsset(name) { return Buffer.from(assets[name], "utf8"); }\n`,
      };
    });
  },
};

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
  const result = await build({
    entryPoints: [path.join(root, "dist", "bin.js")],
    outfile: path.join(destination, "dist", "bin.js"),
    bundle: true,
    minify: true,
    format: "esm",
    platform: "node",
    target: "node22",
    legalComments: "none",
    metafile: true,
    logLevel: "warning",
    // The renderer's own loader requires its native binary by path at run time.
    banner: { js: 'import { createRequire as screenrigCreateRequire } from "node:module";\nconst require = screenrigCreateRequire(import.meta.url);' },
    external: ["@napi-rs/canvas-*"],
    plugins: [embedAssets],
  });

  const bundled = [...new Set(Object.keys(result.metafile.inputs).map(packageOf).filter(Boolean))].sort();
  const sections = [];
  for (const name of bundled) {
    const locked = runtimeLock.packages.find((entry) => entry.name === name && !isRendererPlatformPackage(entry));
    if (!locked) throw new Error(`${name} is bundled but is not a runtime dependency in package-lock.json`);
    const metadata = JSON.parse(await readFile(path.join(root, "node_modules", name, "package.json"), "utf8"));
    if (metadata.version !== locked.version) throw new Error(`${name}: node_modules has ${metadata.version}, package-lock.json has ${locked.version}; run npm ci`);
    sections.push(`${name}@${locked.version} (${metadata.license})\n${locked.resolved}\n\n${await licenseText(name)}\n`);
  }
  const rule = `\n${"=".repeat(72)}\n\n`;
  await writeFile(
    path.join(destination, NOTICES_FILE),
    `screenRIG CLI third-party notices\n\ndist/bin.js bundles these packages. Each one's license follows.${rule}${sections.join(rule)}`,
    "utf8",
  );
  await writeFile(path.join(destination, RUNTIME_LOCK_FILE), `${JSON.stringify(runtimeLock, null, 2)}\n`, "utf8");
  const source = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const manifest = Object.fromEntries(MANIFEST_FIELDS.filter((field) => field in source).map((field) => [field, source[field]]));
  await writeFile(path.join(destination, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  process.stdout.write(`bundled dist/bin.js with ${bundled.join(", ")}\n`);
}

main().catch((error) => {
  process.stderr.write(`bundle-release: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
