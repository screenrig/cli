import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { composeSpec, type ComposeResult } from "./compose.js";
import { expandComposeRecipe } from "./recipes.js";
import { validateSpec } from "./validate.js";

function invalid(message: string): never { throw Object.assign(new Error(message), { code: "usage_error" }); }
export interface BatchPage {
  id: string;
  status: "rendered" | "failed" | "not_selected";
  output?: string;
  layout_output?: string;
  width?: number;
  height?: number;
  warnings?: ComposeResult["warnings"];
  quality?: ComposeResult["quality"];
  error?: { code: string; message: string };
}
export async function composeBatch(inputFile: string, directory: string, options: { target?: { width: number; height: number }; safeArea?: boolean; only?: string } = {}) {
  const input = JSON.parse(await readFile(inputFile, "utf8"));
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => key !== "pages") || !Array.isArray(input.pages) || input.pages.length < 1 || input.pages.length > 100) invalid("Compose batch must be {pages:[{id,spec}]} with 1 to 100 pages. spec is a Frame/recipe object or a relative JSON file path.");
  const ids = new Set<string>();
  for (const item of input.pages) {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some((key) => key !== "id" && key !== "spec") || typeof item.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(item.id) || ids.has(item.id) || item.spec === undefined) invalid("Each batch page needs a unique safe id and spec; only id and spec are accepted.");
    ids.add(item.id);
  }
  if (options.only && !ids.has(options.only)) invalid("--only must name an id present in the batch.");
  await mkdir(directory, { recursive: true });
  const pages: BatchPage[] = [];
  const columns = Math.min(input.pages.length <= 8 ? 2 : 4, input.pages.length), rows = Math.ceil(input.pages.length / columns);
  const thumbWidth = 640, thumbHeight = 360, cellHeight = 388;
  const previewPath = path.join(directory, options.only ? `preview-${options.only}.png` : "preview.png");
  const manifestPath = path.join(directory, options.only ? `compose-batch-${options.only}.json` : "compose-batch.json");
  const canvas = createCanvas(columns * thumbWidth, rows * cellHeight), ctx = canvas.getContext("2d");
  ctx.fillStyle = "#17202A"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  // Serial rendering bounds peak memory to one full-size page and the sheet.
  for (const [index, item] of input.pages.entries()) {
    const x = (index % columns) * thumbWidth, y = Math.floor(index / columns) * cellHeight;
    const row: BatchPage = { id: item.id, status: "not_selected" };
    if (!options.only || options.only === item.id) {
      try {
        const specPath = typeof item.spec === "string" ? path.resolve(path.dirname(inputFile), item.spec) : inputFile;
        const spec = typeof item.spec === "string" ? JSON.parse(await readFile(specPath, "utf8")) : item.spec;
        validateSpec(expandComposeRecipe(spec));
        row.output = path.join(directory, `${item.id}.png`);
        row.layout_output = `${row.output}.layout.json`;
        const result = await composeSpec(spec, { baseDir: path.dirname(specPath), outPath: row.output, layoutOutPath: row.layout_output, ...options });
        row.status = "rendered"; row.width = result.width; row.height = result.height; row.warnings = result.warnings; row.quality = result.quality;
        for (let tx = 0; tx < thumbWidth; tx += 16) for (let ty = 0; ty < thumbHeight; ty += 16) { ctx.fillStyle = (tx / 16 + ty / 16) % 2 ? "#58616D" : "#3D4550"; ctx.fillRect(x + tx, y + ty, 16, 16); }
        const image = await loadImage(result.png), scale = Math.min(thumbWidth / image.width, thumbHeight / image.height);
        ctx.drawImage(image, x + (thumbWidth - image.width * scale) / 2, y + (thumbHeight - image.height * scale) / 2, image.width * scale, image.height * scale);
      } catch (error) {
        row.status = "failed";
        row.error = { code: (error as { code?: string }).code ?? "compose_failed", message: error instanceof Error ? error.message : "Compose failed" };
      }
    }
    ctx.fillStyle = row.status === "failed" ? "#FF8A80" : "#FFFFFF"; ctx.font = "17px sans-serif";
    ctx.fillText(`${item.id} · ${row.status}${row.warnings?.length ? ` · ${row.warnings.length} warnings` : ""}`, x + 5, y + cellHeight - 8, thumbWidth - 10);
    pages.push(row);
  }
  await writeFile(previewPath, canvas.toBuffer("image/png"));
  const result = { manifest: manifestPath, preview: previewPath, rendered: pages.filter((p) => p.status === "rendered").length, failed: pages.filter((p) => p.status === "failed").length, not_selected: pages.filter((p) => p.status === "not_selected").length, pages };
  await writeFile(manifestPath, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
