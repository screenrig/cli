// Command handlers for the docs commands, loaded on demand.
import type { DocsPage, DocsSearchResponse, DocsSearchResult } from "../adapters/protocol.js";
import { flagString } from "../command-input.js";
import { ExitCode } from "../exit-codes.js";
import { unexpectedResponseError } from "../problems.js";
import { clearResultContext } from "../project-context.js";
import { shellQuote } from "../temp-file.js";
import { clientFor, commandHandler, jsonBody } from "../commands.js";

// The documentation is public and belongs to no project: the request carries no
// credential, works before sign-in, and a stored project name never prefixes the
// answer. The API origin is the one every other command resolves; the API checks
// the query, limit, address and section.

/** title — section, the page address, then the text around the match on one line. */
function hitLines(hit: DocsSearchResult): string[] {
  const snippet = hit.snippet.replace(/\s+/g, " ").trim();
  return [hit.section ? `${hit.title} — ${hit.section}` : hit.title, hit.url, ...(snippet ? [snippet] : [])];
}

export const handleDocsSearch = commandHandler(async (args, runtime, resolved) => {
  clearResultContext(runtime);
  const query = args.positionals.slice(2).join(" ");
  const client = clientFor(runtime, args, resolved.apiUrl);
  const response = await client.call({ method: "GET", path: "/api/docs/search", query: { q: query, limit: flagString(args.flags, "limit") } });
  const body = response.body as DocsSearchResponse | undefined;
  if (!Array.isArray(body?.results)) throw unexpectedResponseError("GET /api/docs/search answered without a list of matching sections.", client.requestId);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: body.results.length ? body.results.map((hit) => hitLines(hit).join("\n")).join("\n\n") : `No documentation matches ${JSON.stringify(query)}.`,
  };
}, false);

export const handleDocsShow = commandHandler(async (args, runtime, resolved) => {
  clearResultContext(runtime);
  const client = clientFor(runtime, args, resolved.apiUrl);
  const response = await client.call({ method: "GET", path: "/api/docs/page", query: { url: args.positionals[2], section: flagString(args.flags, "section") } });
  const page = response.body as DocsPage | undefined;
  if (typeof page?.markdown !== "string" || !Array.isArray(page.sections)) throw unexpectedResponseError("GET /api/docs/page answered without a documentation page.", client.requestId);
  const lines = [page.markdown.trimEnd()];
  if (page.truncated) lines.push("", `Truncated. Read a section with: ${shellQuote(["screenrig", "docs", "show", page.url, "--section", "NAME"])}`);
  if (page.sections.length) lines.push("", "Sections to read next:", ...page.sections.map((name) => `- ${name}`));
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: lines.join("\n") };
}, false);
