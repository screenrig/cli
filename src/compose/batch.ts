import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { composeSpec, type ComposeResult, type InkTightReport } from "./compose.js";
import { expandComposeRecipe } from "./recipes.js";
import { validateSpec } from "./validate.js";
import {
  lintAdjacentComposePages,
  lintComposedPage,
  pixelsFromPng,
  sortLint,
  viewingOf,
  type LintFinding,
} from "./lint.js";

function invalid(message: string): never { throw Object.assign(new Error(message), { code: "usage_error" }); }

export const COMPOSE_BATCH_MIN_PAGES = 1;
export const COMPOSE_BATCH_MAX_PAGES = 2000;
export const COMPOSE_BATCH_CHUNK_SIZE = 100;

export interface BatchPage {
  id: string;
  status: "rendered" | "failed" | "not_selected";
  output?: string;
  layout_output?: string;
  width?: number;
  height?: number;
  warnings?: ComposeResult["warnings"];
  quality?: ComposeResult["quality"];
  ink_tight?: InkTightReport;
  lint?: LintFinding[];
  error?: { code: string; message: string };
}

export interface BatchChunkTiming {
  index: number;
  pages: number;
  duration_ms: number;
}

export interface BatchResult {
  manifest: string;
  preview: string;
  rendered: number;
  failed: number;
  not_selected: number;
  pages: BatchPage[];
  chunks: number;
  chunk_timings: BatchChunkTiming[];
  lint: LintFinding[];
}

interface BatchItem {
  id: string;
  spec: unknown;
}

function chunkPreviewPath(directory: string, chunkIndex: number, only?: string): string {
  if (only) return path.join(directory, `preview-${only}.png`);
  if (chunkIndex === 0) return path.join(directory, "preview.png");
  return path.join(directory, `preview-${chunkIndex + 1}.png`);
}

async function renderBatchChunk(
  items: BatchItem[],
  inputFile: string,
  directory: string,
  options: { target?: { width: number; height: number }; safeArea?: boolean; only?: string; inkTight?: boolean; inkPadding?: number; lintOnly?: boolean },
  previewPath: string,
): Promise<BatchPage[]> {
  const pages: BatchPage[] = [];
  const columns = Math.min(items.length <= 8 ? 2 : 4, items.length), rows = Math.ceil(items.length / columns);
  const thumbWidth = 640, thumbHeight = 360, cellHeight = 388;
  const canvas = createCanvas(columns * thumbWidth, rows * cellHeight), ctx = canvas.getContext("2d");
  ctx.fillStyle = "#17202A"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  // Serial rendering bounds peak memory to one full-size page and the sheet.
  for (const [index, item] of items.entries()) {
    const x = (index % columns) * thumbWidth, y = Math.floor(index / columns) * cellHeight;
    const row: BatchPage = { id: item.id, status: "not_selected" };
    if (!options.only || options.only === item.id) {
      try {
        const specPath = typeof item.spec === "string" ? path.resolve(path.dirname(inputFile), item.spec) : inputFile;
        const spec = typeof item.spec === "string" ? JSON.parse(await readFile(specPath, "utf8")) : item.spec;
        validateSpec(expandComposeRecipe(spec));
        row.output = path.join(directory, `${item.id}.png`);
        row.layout_output = `${row.output}.layout.json`;
        const result = await composeSpec(spec, {
          baseDir: path.dirname(specPath),
          outPath: options.lintOnly ? undefined : row.output,
          layoutOutPath: options.lintOnly ? undefined : row.layout_output,
          ...options,
        });
        row.status = "rendered"; row.width = result.width; row.height = result.height; row.warnings = result.warnings; row.quality = result.quality;
        if (result.ink_tight) row.ink_tight = result.ink_tight;
        const pixels = await pixelsFromPng(result.png);
        row.lint = lintComposedPage({ page_id: item.id, spec, layout: result.layout, quality: result.quality, pixels, viewing: viewingOf(spec) });
        if (!options.lintOnly) {
          for (let tx = 0; tx < thumbWidth; tx += 16) for (let ty = 0; ty < thumbHeight; ty += 16) { ctx.fillStyle = (tx / 16 + ty / 16) % 2 ? "#58616D" : "#3D4550"; ctx.fillRect(x + tx, y + ty, 16, 16); }
          const image = await loadImage(result.png), scale = Math.min(thumbWidth / image.width, thumbHeight / image.height);
          ctx.drawImage(image, x + (thumbWidth - image.width * scale) / 2, y + (thumbHeight - image.height * scale) / 2, image.width * scale, image.height * scale);
        }
      } catch (error) {
        row.status = "failed";
        row.error = { code: (error as { code?: string }).code ?? "compose_failed", message: error instanceof Error ? error.message : "Compose failed" };
      }
    }
    ctx.fillStyle = row.status === "failed" ? "#FF8A80" : "#FFFFFF"; ctx.font = "17px sans-serif";
    ctx.fillText(`${item.id} · ${row.status}${row.warnings?.length ? ` · ${row.warnings.length} warnings` : ""}${row.lint?.length ? ` · ${row.lint.length} lint` : ""}`, x + 5, y + cellHeight - 8, thumbWidth - 10);
    pages.push(row);
  }
  if (!options.lintOnly) await writeFile(previewPath, canvas.toBuffer("image/png"));
  return pages;
}

export async function composeBatch(inputFile: string, directory: string, options: { target?: { width: number; height: number }; safeArea?: boolean; only?: string; inkTight?: boolean; inkPadding?: number; lintOnly?: boolean } = {}): Promise<BatchResult> {
  const input = JSON.parse(await readFile(inputFile, "utf8"));
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => key !== "pages") || !Array.isArray(input.pages) || input.pages.length < COMPOSE_BATCH_MIN_PAGES || input.pages.length > COMPOSE_BATCH_MAX_PAGES) invalid(`Compose batch must be {pages:[{id,spec}]} with ${COMPOSE_BATCH_MIN_PAGES} to ${COMPOSE_BATCH_MAX_PAGES} pages. spec is a Frame/recipe object or a relative JSON file path.`);
  const ids = new Set<string>();
  for (const item of input.pages) {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some((key) => key !== "id" && key !== "spec") || typeof item.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(item.id) || ids.has(item.id) || item.spec === undefined) invalid("Each batch page needs a unique safe id and spec; only id and spec are accepted.");
    ids.add(item.id);
  }
  if (options.only && !ids.has(options.only)) invalid("--only must name an id present in the batch.");
  await mkdir(directory, { recursive: true });
  const items = input.pages as BatchItem[];
  const chunkCount = Math.ceil(items.length / COMPOSE_BATCH_CHUNK_SIZE);
  const previewPath = path.join(directory, options.only ? `preview-${options.only}.png` : "preview.png");
  const manifestPath = path.join(directory, options.only ? `compose-batch-${options.only}.json` : "compose-batch.json");
  const pages: BatchPage[] = [];
  const chunk_timings: BatchChunkTiming[] = [];
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
    const slice = items.slice(chunkIndex * COMPOSE_BATCH_CHUNK_SIZE, (chunkIndex + 1) * COMPOSE_BATCH_CHUNK_SIZE);
    const started = Date.now();
    if (options.only && !slice.some((item) => item.id === options.only)) {
      pages.push(...slice.map((item) => ({ id: item.id, status: "not_selected" as const })));
    } else {
      pages.push(...await renderBatchChunk(slice, inputFile, directory, options, chunkPreviewPath(directory, chunkIndex, options.only)));
    }
    chunk_timings.push({ index: chunkIndex, pages: slice.length, duration_ms: Math.max(0, Date.now() - started) });
  }
  const lint = sortLint(
    [
      ...pages.flatMap((page) => page.lint ?? []),
      ...lintAdjacentComposePages(items.map((item) => ({ id: item.id, spec: item.spec }))),
    ],
    items.map((item) => item.id),
  );
  const result: BatchResult = {
    manifest: manifestPath,
    preview: previewPath,
    rendered: pages.filter((p) => p.status === "rendered").length,
    failed: pages.filter((p) => p.status === "failed").length,
    not_selected: pages.filter((p) => p.status === "not_selected").length,
    pages,
    chunks: chunkCount,
    chunk_timings,
    lint,
  };
  await writeFile(manifestPath, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
