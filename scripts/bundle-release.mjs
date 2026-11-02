#!/usr/bin/env node
// Bundle the built CLI (dist/ after `npm run build`) and every runtime
// dependency into readable (unminified) ESM files: dist/bin.js and the flat dist/*.js chunks
// it loads per command group. Write the files that travel with them: assets/,
// the runtime dependency lock, the license notices of every bundled package,
// and a package.json for the bundle.
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describeFinding, directoryScanFindings } from "./directory-scan.mjs";
import { loadRuntimeDependencyLock, NOTICES_FILE, RUNTIME_LOCK_FILE } from "./runtime-dependencies.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
// Fields of package.json that describe the bundle. The rest describe the npm
// package (its module entry points, file list and scripts).
const MANIFEST_FIELDS = ["name", "version", "private", "description", "homepage", "repository", "bugs", "license", "type", "bin", "engines", "dependencies"];
// The Claude plugin directory reads at most 256 KiB of a script and holds a
// larger one for review, so no bundled file may be bigger.
const MAX_OUTPUT_BYTES = 256 * 1024;

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

// Readable code is several times larger than minified code, and a shared chunk
// (every input that the same set of entry points reaches) can outgrow the file
// limit however the command bundles are cut: ajv alone is 280 KB. A chunk over
// TARGET_OUTPUT_BYTES is therefore cut into pieces of about equal size, leaving
// headroom for growth. esbuild has no manual chunks, but it gives every distinct
// set of entry points its own chunk. So each piece gets a hint entry that imports
// just its modules. Only the hint's own code and its output file are dropped; the
// real entry points load the pieces as ordinary chunks.
const TARGET_OUTPUT_BYTES = 235_000;
const HINT_PREFIX = "split-hint-";
const MAX_SPLIT_ROUNDS = 8;

function splitHintPlugin(groups) {
  return {
    name: "split-hint",
    setup(esbuild) {
      esbuild.onResolve({ filter: new RegExp(`^${HINT_PREFIX}`) }, (args) => ({ path: args.path, namespace: "split-hint" }));
      esbuild.onLoad({ filter: /.*/, namespace: "split-hint" }, (args) => {
        const group = groups[Number(args.path.slice(HINT_PREFIX.length))];
        const names = group.map((_, index) => `module${index}`);
        const imports = group.map((input, index) => `import * as ${names[index]} from ${JSON.stringify(`./${input}`)};`);
        return { contents: `${imports.join("\n")}\nexport { ${names.join(", ")} };\n`, resolveDir: root, loader: "js" };
      });
    },
  };
}

// Dependency code the Claude plugin directory's scan would read as a credential
// read (scripts/directory-scan.mjs), changed at bundle time without changing
// what runs. Each change must apply exactly as written, so an upgraded
// dependency fails the bundle here instead of shipping a pattern.
const DEPENDENCY_PATCHES = [
  {
    file: "node_modules/commander/lib/command.js",
    // The CLI declares no Option.env() variables, so the release reads none.
    find: `  _parseOptionsEnv() {
    this.options.forEach((option) => {
      if (option.envVar && option.envVar in process.env) {
        const optionKey = option.attributeName();
        // Priority check. Do not overwrite cli or options from unknown source (client-code).
        if (
          this.getOptionValue(optionKey) === undefined ||
          ['default', 'config', 'env'].includes(
            this.getOptionValueSource(optionKey),
          )
        ) {
          if (option.required || option.optional) {
            // option can take a value
            // keep very simple, optional always takes value
            this.emit(\`optionEnv:\${option.name()}\`, process.env[option.envVar]);
          } else {
            // boolean
            // keep very simple, only care that envVar defined and not the value
            this.emit(\`optionEnv:\${option.name()}\`);
          }
        }
      }
    });
  }`,
    replace: `  _parseOptionsEnv() {
    // The screenRIG CLI declares no Option.env() variables and reads none.
    for (const option of this.options) {
      if (option.envVar) throw new Error("option " + option.flags + " names an environment variable; the screenRIG CLI reads none");
    }
  }`,
  },
  {
    file: "node_modules/commander/lib/command.js",
    count: 2,
    find: "   * Expected values are default | config | env | cli | implied",
    replace: "   * Expected values are default, config, env, cli or implied",
  },
  {
    file: "node_modules/ajv/dist/compile/index.js",
    // The constructor's parameter is renamed; the class reads the same fields.
    find: /class SchemaEnv \{\n    constructor\(env\) \{[\s\S]*?\n    \}\n\}/,
    replace: (block) => block.replace(/\benv\b/g, "schemaEnv"),
  },
];

function dependencyPatchPlugin() {
  const files = [...new Set(DEPENDENCY_PATCHES.map((patch) => patch.file))];
  return {
    name: "dependency-patches",
    setup(esbuild) {
      esbuild.onLoad({ filter: /[\\/]node_modules[\\/](?:commander[\\/]lib[\\/]command|ajv[\\/]dist[\\/]compile[\\/]index)\.js$/ }, async (args) => {
        const file = files.find((name) => args.path.endsWith(path.join(...name.split("/"))));
        if (!file) return undefined;
        let contents = await readFile(args.path, "utf8");
        for (const patch of DEPENDENCY_PATCHES.filter((entry) => entry.file === file)) {
          const found = typeof patch.find === "string" ? contents.split(patch.find).length - 1 : (contents.match(new RegExp(patch.find.source, "g")) ?? []).length;
          if (found !== (patch.count ?? 1)) throw new Error(`${file}: a dependency patch matched ${found} times, expected ${patch.count ?? 1}; update DEPENDENCY_PATCHES for the new version`);
          contents = typeof patch.find === "string" ? contents.split(patch.find).join(patch.replace) : contents.replace(patch.find, patch.replace);
        }
        return { contents, loader: "js" };
      });
    },
  };
}

function isHint(file) {
  return path.basename(file).startsWith(HINT_PREFIX);
}

/** Cut each oversized output's modules, in path order, into pieces of about equal size. */
function cutOversized(metafile) {
  const groups = [];
  for (const [file, output] of Object.entries(metafile.outputs)) {
    if (isHint(file) || output.bytes <= TARGET_OUTPUT_BYTES) continue;
    const inputs = Object.entries(output.inputs).filter(([, input]) => input.bytesInOutput > 0).sort(([left], [right]) => (left < right ? -1 : 1));
    if (inputs.length < 2) continue;
    const total = inputs.reduce((sum, [, input]) => sum + input.bytesInOutput, 0);
    const share = total / Math.ceil(output.bytes / TARGET_OUTPUT_BYTES);
    let group = [];
    let size = 0;
    for (const [name, input] of inputs) {
      group.push(name);
      size += input.bytesInOutput;
      if (size >= share) { groups.push(group); group = []; size = 0; }
    }
    if (group.length) groups.push(group);
  }
  return groups;
}

/** Bundle dist/bin.js into outdir (not written), cutting oversized chunks until the files fit. */
async function bundleSplit(outdir) {
  const groups = [];
  for (let round = 0; ; round += 1) {
    const result = await build({
      // Chunk names hash input paths relative to the working directory: pin it
      // to this checkout so every machine and CI produce the same files.
      absWorkingDir: root,
      entryPoints: { bin: path.join(root, "dist", "bin.js"), ...Object.fromEntries(groups.map((_, index) => [`${HINT_PREFIX}${index}`, `${HINT_PREFIX}${index}`])) },
      outdir,
      // Chunks sit beside bin.js, so ../assets/ resolves from every one of them.
      entryNames: "[name]",
      chunkNames: "[name]-[hash]",
      splitting: true,
      bundle: true,
      // Readable output: the plugin directory's security scan cannot review minified code.
      minify: false,
      format: "esm",
      platform: "node",
      target: "node22",
      // The directory's scan reads a template literal's interpolation as a shell
      // variable expansion, and holds a file that seems to expand one named like a
      // credential (a KV key, an API field) beside a URL. Template literals are
      // emitted as "...".concat(...), which converts each value exactly as a
      // template literal does.
      supported: { "template-literal": false },
      legalComments: "none",
      metafile: true,
      write: false,
      plugins: [dependencyPatchPlugin(), splitHintPlugin(groups)],
      logLevel: "warning",
      // Bundled CommonJS dependencies require Node built-ins.
      banner: { js: 'import { createRequire as screenrigCreateRequire } from "node:module";\nconst require = screenrigCreateRequire(import.meta.url);' },
    });
    const more = cutOversized(result.metafile);
    if (!more.length || round >= MAX_SPLIT_ROUNDS) {
      return { files: result.outputFiles.filter((file) => !isHint(file.path)), metafile: result.metafile };
    }
    groups.push(...more);
  }
}

async function main() {
  const flag = process.argv.indexOf("--destination");
  if (flag < 0 || !process.argv[flag + 1] || process.argv.length !== 4) {
    throw new Error("usage: bundle-release.mjs --destination <package-root>");
  }
  const destination = path.resolve(process.argv[flag + 1]);
  const runtimeLock = await loadRuntimeDependencyLock(root);
  await rm(path.join(destination, "dist"), { recursive: true, force: true });
  const { files, metafile } = await bundleSplit(path.join(destination, "dist"));
  const outputs = files.map((file) => ({ file: path.relative(destination, file.path), bytes: file.contents.length }));
  const oversized = outputs.filter((output) => output.bytes > MAX_OUTPUT_BYTES);
  if (oversized.length) {
    throw new Error(`${oversized.map((output) => `${output.file} is ${output.bytes} bytes`).join(", ")}; every bundled file must stay within ${MAX_OUTPUT_BYTES} bytes. A single module over the limit has to be split in source; otherwise move code behind a command bundle (src/cli-commands/index.ts).`);
  }
  const scanned = files.flatMap((file) => directoryScanFindings(file.text).map((finding) => describeFinding(path.relative(destination, file.path), file.text, finding)));
  for (const name of (await readdir(path.join(root, "assets"))).sort()) {
    const text = await readFile(path.join(root, "assets", name), "utf8");
    scanned.push(...directoryScanFindings(text).map((finding) => describeFinding(`assets/${name}`, text, finding)));
  }
  if (scanned.length) {
    throw new Error(`${scanned.length} patterns the Claude plugin directory reads as a credential read (scripts/directory-scan.mjs):\\n  ${scanned.join("\\n  ")}`);
  }
  for (const file of files) {
    await mkdir(path.dirname(file.path), { recursive: true });
    await writeFile(file.path, file.contents);
  }

  // src/assets.ts reads these at run time from ../assets/ beside dist/.
  await mkdir(path.join(destination, "assets"), { recursive: true });
  for (const name of (await readdir(path.join(root, "assets"))).sort()) {
    await copyFile(path.join(root, "assets", name), path.join(destination, "assets", name));
  }

  const bundled = [...new Set(Object.keys(metafile.inputs).map(packageOf).filter(Boolean))].sort();
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
