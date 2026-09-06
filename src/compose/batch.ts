import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { composeAndWrite, type ComposeQuality, type ComposeWarning } from "./compose.js";
import { parseComposeSpec } from "./parse.js";
import {
  lintAdjacentComposePages,
  lintComposedPage,
  pageSpecForLint,
  pixelsFromPng,
  sortLint,
  viewingOf,
  type LintFinding,
} from "./lint.js";

function invalid(message: string): never {
  throw Object.assign(new Error(message), { code: "usage_error" });
}

export const COMPOSE_BATCH_MIN_PAGES = 1;
export const COMPOSE_BATCH_MAX_PAGES = 2000;
export const COMPOSE_BATCH_CHUNK_SIZE = 100;

export interface BatchPage {
  id: string;
  status: "rendered" | "failed" | "not_selected";
  output?: string;
  width?: number;
  height?: number;
  warnings?: ComposeWarning[];
  quality?: ComposeQuality;
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

function pageSource(input: unknown, pageId: string): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  if (!Array.isArray(record.pages)) return input;
  const match = record.pages.find((item) => (
    item && typeof item === "object" && !Array.isArray(item) && (item as { id?: string }).id === pageId
  ));
  if (!match || typeof match !== "object" || Array.isArray(match)) return input;
  const { pages: _pages, ...rails } = record;
  const { id: _id, ...body } = match as Record<string, unknown>;
  return { ...rails, ...body };
}

async function writeContactSheet(
  items: Array<{ id: string; file: string; status: string; warnings: number; lint: number }>,
  previewPath: string,
): Promise<void> {
  const columns = Math.min(items.length <= 8 ? 2 : 4, Math.max(1, items.length));
  const rows = Math.max(1, Math.ceil(items.length / columns));
  const thumbWidth = 640;
  const thumbHeight = 360;
  const cellHeight = 388;
  const canvas = createCanvas(columns * thumbWidth, rows * cellHeight);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#17202A";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const [index, item] of items.entries()) {
    const x = (index % columns) * thumbWidth;
    const y = Math.floor(index / columns) * cellHeight;
    for (let tx = 0; tx < thumbWidth; tx += 16) {
      for (let ty = 0; ty < thumbHeight; ty += 16) {
        ctx.fillStyle = (tx / 16 + ty / 16) % 2 ? "#58616D" : "#3D4550";
        ctx.fillRect(x + tx, y + ty, 16, 16);
      }
    }
    const image = await loadImage(item.file);
    const scale = Math.min(thumbWidth / image.width, thumbHeight / image.height);
    ctx.drawImage(
      image,
      x + (thumbWidth - image.width * scale) / 2,
      y + (thumbHeight - image.height * scale) / 2,
      image.width * scale,
      image.height * scale,
    );
    ctx.fillStyle = item.status === "failed" ? "#FF8A80" : "#FFFFFF";
    ctx.font = "17px sans-serif";
    ctx.fillText(
      `${item.id} · ${item.status}${item.warnings ? ` · ${item.warnings} warnings` : ""}${item.lint ? ` · ${item.lint} lint` : ""}`,
      x + 5,
      y + cellHeight - 8,
      thumbWidth - 10,
    );
  }
  await writeFile(previewPath, canvas.toBuffer("image/png"));
}

export async function composeBatch(
  inputFile: string,
  directory: string,
  options: { target?: { width: number; height: number }; safeArea?: boolean; only?: string; lintOnly?: boolean } = {},
): Promise<BatchResult> {
  let input: unknown;
  try {
    input = JSON.parse(await readFile(inputFile, "utf8"));
  } catch (err) {
    invalid(`Cannot read compose spec: ${err instanceof Error ? err.message : "invalid JSON"}`);
  }
  const document = parseComposeSpec(input);
  if (document.pages.length < COMPOSE_BATCH_MIN_PAGES || document.pages.length > COMPOSE_BATCH_MAX_PAGES) {
    invalid(`Compose batch must have ${COMPOSE_BATCH_MIN_PAGES} to ${COMPOSE_BATCH_MAX_PAGES} pages.`);
  }
  const ids = document.pages.map((page) => page.id);
  if (options.only && !ids.includes(options.only)) invalid("--only must name an id present in the deck.");
  await mkdir(directory, { recursive: true });
  const previewPath = path.join(directory, options.only ? `preview-${options.only}.png` : "preview.png");
  const manifestPath = path.join(directory, options.only ? `compose-batch-${options.only}.json` : "compose-batch.json");
  const nest = Array.isArray((input as { pages?: unknown }).pages);
  const chunkCount = Math.ceil(ids.length / COMPOSE_BATCH_CHUNK_SIZE);
  const pages: BatchPage[] = [];
  const chunk_timings: BatchChunkTiming[] = [];
  const thumbs: Array<{ id: string; file: string; status: string; warnings: number; lint: number }> = [];
  const baseDir = path.dirname(inputFile);
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
    const chunkIds = ids.slice(chunkIndex * COMPOSE_BATCH_CHUNK_SIZE, (chunkIndex + 1) * COMPOSE_BATCH_CHUNK_SIZE);
    const started = Date.now();
    for (const id of chunkIds) {
      if (options.only && options.only !== id) {
        pages.push({ id, status: "not_selected" });
        continue;
      }
      const pageDir = nest ? path.join(directory, id) : directory;
      const spec = pageSpecForLint(input, id);
      try {
        const written = await composeAndWrite(pageSource(input, id), {
          baseDir,
          outDir: pageDir,
          combined: !options.lintOnly,
          target: options.target,
          safeArea: options.safeArea,
          lintOnly: options.lintOnly,
        });
        const page = written.result.pages[0];
        if (!page) {
          pages.push({ id, status: "failed", error: { code: "compose_failed", message: `page ${id} missing after render` } });
          continue;
        }
        const pixels = await pixelsFromPng(page.combined);
        const lint = lintComposedPage({
          page_id: id,
          spec,
          quality: page.quality,
          pixels,
          viewing: viewingOf(spec),
        });
        pages.push({
          id,
          status: "rendered",
          output: pageDir,
          width: page.manifest.canvas.width,
          height: page.manifest.canvas.height,
          warnings: page.warnings,
          quality: page.quality,
          lint,
        });
        if (!options.lintOnly) {
          thumbs.push({
            id,
            file: path.join(pageDir, "combined.png"),
            status: "rendered",
            warnings: page.warnings.length,
            lint: lint.length,
          });
        }
      } catch (error) {
        pages.push({
          id,
          status: "failed",
          error: { code: (error as { code?: string }).code ?? "compose_failed", message: error instanceof Error ? error.message : "Compose failed" },
        });
      }
    }
    chunk_timings.push({ index: chunkIndex, pages: chunkIds.length, duration_ms: Math.max(0, Date.now() - started) });
  }
  if (!options.lintOnly && thumbs.length) await writeContactSheet(thumbs, previewPath);
  const lint = sortLint(
    [
      ...pages.flatMap((page) => page.lint ?? []),
      ...lintAdjacentComposePages(ids.map((id) => ({ id, spec: pageSpecForLint(input, id) }))),
    ],
    ids,
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
