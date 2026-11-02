// Patterns the Claude plugin directory's scan reads as a credential leaving the
// machine. The scan treats a script's text like shell: a ${NAME} or $NAME
// expansion whose name looks like a credential, a bare set, env, printenv or
// export starting a command (an environment dump), the pass password manager
// starting a command, and whole-environment access. A file with any of them
// beside a URL is held for a person's review, and the plugin with it. The
// release bundle must have none: bundle-release.mjs fails on a finding, and the
// plugin repository runs the same rules over the whole plugin folder.

const CREDENTIAL = /(key|secret|token|bearer|passw|pwd|credential|authorization|cookie|apikey)/i;
const COMMAND_START = String.raw`(?:^|[;&|(\x60{\n]|\$\(|\\n)`;
const RULES = [
  ["environment dump", new RegExp(COMMAND_START + String.raw`\s*["']?(?:set|env|printenv|export|declare|typeset|compgen)["']?\s*(?=$|[;&|)\x60}\n]|\\n|-p\b)`, "gm")],
  ["pass password manager", new RegExp(COMMAND_START + String.raw`\s*["']?pass["']?\s+[^\s;&|)]`, "gm")],
  ["whole environment", /process\.env\s*\[|\.\.\.\s*process\.env\b|=\s*process\.env\s*[;,\n)]|:\s*process\.env\s*[,}\n]|\(\s*process\.env\s*\)|\bin\s+process\.env\b|os\.environ\b(?!\s*\.get\(\s*["'])/g],
  ["credential file", /\b(?:op read|op item get|gh auth token|security find-(?:generic|internet)-password|gcloud auth print|aws configure get|secret-tool lookup|id_rsa|id_ed25519|\.netrc|\.git-credentials|\.npmrc|\.pypirc)\b/g],
  ["download and run", /(?:curl|wget)[^\n|]{0,200}\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b|\$\(\s*(?:curl|wget)|\x60\s*(?:curl|wget)|\b(?:iex|Invoke-Expression)\b/g],
];

function* interpolations(text) {
  let from = 0;
  for (;;) {
    const start = text.indexOf("${", from);
    if (start < 0) return;
    let depth = 0;
    let end = start + 1;
    for (; end < text.length; end += 1) {
      if (text[end] === "{") depth += 1;
      else if (text[end] === "}" && --depth === 0) break;
    }
    yield { at: start, inner: text.slice(start + 2, end) };
    from = start + 2;
  }
}

/** Every pattern the directory's scan could read as a credential read, with its offset. */
export function directoryScanFindings(text) {
  const findings = [];
  for (const { at, inner } of interpolations(text)) {
    const names = inner.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
    if (names.some((name) => CREDENTIAL.test(name))) findings.push({ rule: "credential expansion", at, sample: `\${${inner.slice(0, 60)}}` });
  }
  for (const match of text.matchAll(/(?<![\w$])\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
    if (CREDENTIAL.test(match[1])) findings.push({ rule: "credential expansion", at: match.index, sample: match[0] });
  }
  for (const [rule, pattern] of RULES) {
    for (const match of text.matchAll(pattern)) findings.push({ rule, at: match.index, sample: match[0].trim().slice(0, 60) });
  }
  return findings;
}

/** A one-line description of a finding, with the source module esbuild named above it. */
export function describeFinding(file, text, finding) {
  let module = "";
  for (const match of text.matchAll(/^\/\/ ((?:dist|node_modules)\/\S+)/gm)) {
    if (match.index > finding.at) break;
    module = match[1];
  }
  return `${file}${module ? ` (${module})` : ""}: ${finding.rule}: ${JSON.stringify(finding.sample)}`;
}
