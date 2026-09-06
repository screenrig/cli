import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { composeSpec } from "./compose.js";
import {
  expandComposeRecipe,
  RECIPE_NAMES,
  RECIPE_VARIANTS,
  SIGNAGE_RECIPES,
  recipeExamples,
  type RecipeWarning,
  type SignageRecipe,
} from "./recipes.js";
import { pixelsFromPng } from "./lint.js";
import { testTemp } from "../test-temp.js";
import type { ComposeFrame, ComposeNode } from "./types.js";
import { ROLES } from "./types.js";
import { THEMES } from "./tokens.js";

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function filler(count: number): string {
  return Array.from({ length: count }, (_, i) => `word${i}`).join(" ");
}

function assertUsage(fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal((err as { code?: string }).code, "usage_error");
    assert.match(err.message, pattern);
    return true;
  });
}

function walk(node: ComposeNode, visit: (node: ComposeNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

function signageSpec(name: SignageRecipe, variant: string, image: string): Record<string, unknown> {
  const spec: Record<string, unknown> = { ...(recipeExamples()[name].example as Record<string, unknown>), variant, width: 960, height: 540 };
  if (name === "hero" || name === "promo" || name === "menu-board" || name === "event" || (name === "quote" && variant === "c")) {
    spec.image = image;
  }
  return spec;
}

test("each signage recipe variant expands without raw sizes and stages 8% margin", () => {
  for (const name of SIGNAGE_RECIPES) {
    const trees: string[] = [];
    for (const variant of RECIPE_VARIANTS) {
      const spec = signageSpec(name, variant, "./photo.png");
      const frame = expandComposeRecipe(spec) as ComposeFrame;
      assert.equal(frame.type, "Frame");
      trees.push(JSON.stringify(frame));
      walk(frame, (node) => {
        assert.equal("fontSize" in node, false, `${name}/${variant} must not set fontSize`);
        if (node.type === "Text") {
          assert.ok(node.role && (ROLES as readonly string[]).includes(node.role), `${name}/${variant} Text needs a role`);
        }
      });
      const bleed = name === "hero" || name === "promo" || (name === "quote" && variant === "c");
      if (!bleed) {
        const inner = frame.children?.[0];
        assert.equal(inner?.width, 960 * 0.84, `${name}/${variant} width inset`);
        assert.equal(inner?.height, 540 * 0.84, `${name}/${variant} height inset`);
      }
    }
    assert.notEqual(trees[0], trees[1], `${name} variant a and b must differ`);
    assert.notEqual(trees[1], trees[2], `${name} variant b and c must differ`);
    assert.notEqual(trees[0], trees[2], `${name} variant a and c must differ`);
    const base = { ...signageSpec(name, "a", "./photo.png") };
    delete base.variant;
    assert.deepEqual(expandComposeRecipe(base), expandComposeRecipe({ ...base, variant: "a" }));
  }
});

test("each signage recipe variant renders a nonempty PNG", async () => {
  const dir = await testTemp("signage-recipes-");
  await composeSpec(
    { type: "Frame", width: 64, height: 64, background: "#336699" },
    { baseDir: dir, outPath: path.join(dir, "photo.png") },
  );
  for (const name of SIGNAGE_RECIPES) {
    for (const variant of RECIPE_VARIANTS) {
      const result = await composeSpec(signageSpec(name, variant, "photo.png"), { baseDir: dir });
      assert.ok(result.png.length > 8, `${name}/${variant} png`);
      assert.ok(result.png.subarray(0, 8).equals(PNG_HEADER), `${name}/${variant} png header`);
    }
  }
  await rm(dir, { recursive: true, force: true });
});

test("over-budget signage copy warns too_dense and still renders", async () => {
  const dir = await testTemp("signage-dense-");
  await composeSpec(
    { type: "Frame", width: 64, height: 64, background: "#336699" },
    { baseDir: dir, outPath: path.join(dir, "photo.png") },
  );
  const long = filler(120);
  const patches: Record<SignageRecipe, Record<string, unknown>> = {
    hero: { headline: long },
    "price-list": { title: long },
    "menu-board": { title: long },
    promo: { headline: long },
    event: { title: long },
    quote: { quotation: long },
    schedule: { title: long },
  };
  for (const name of SIGNAGE_RECIPES) {
    const spec = { ...signageSpec(name, "a", "photo.png"), ...patches[name] };
    const warnings: RecipeWarning[] = [];
    expandComposeRecipe(spec, warnings);
    assert.ok(warnings.some((warning) => warning.code === "too_dense"), `${name} expand too_dense`);
    const result = await composeSpec(spec, { baseDir: dir });
    assert.ok(result.warnings.some((warning) => warning.code === "too_dense"), `${name} compose too_dense`);
    assert.ok(result.png.length > 8, `${name} dense png`);
  }
  await rm(dir, { recursive: true, force: true });
});

test("hero, promo, and quote texts set plate auto", () => {
  for (const name of ["hero", "promo", "quote"] as const) {
    for (const variant of RECIPE_VARIANTS) {
      const spec = signageSpec(name, variant, "./photo.png");
      const frame = expandComposeRecipe(spec) as ComposeFrame;
      const texts: ComposeNode[] = [];
      walk(frame, (node) => {
        if (node.type === "Text") texts.push(node);
      });
      assert.ok(texts.length > 0, `${name}/${variant} has text`);
      for (const node of texts) {
        assert.equal(node.plate, "auto", `${name}/${variant} ${node.role} plate`);
      }
    }
  }
});

test("price-list leaders are dotted dividers, not filled bars", () => {
  const frame = expandComposeRecipe({
    recipe: "price-list",
    variant: "b",
    theme: "cinema-noir",
    title: "Kitchen",
    rows: [
      { name: "Salad", price: "9" },
      { name: "Soup", price: "8" },
      { name: "Pie", price: "11" },
      { name: "Chicken", price: "22" },
      { name: "Trout", price: "24" },
      { name: "Tart", price: "10" },
    ],
  }) as ComposeFrame;
  const leaders: ComposeNode[] = [];
  walk(frame, (node) => {
    if (node.type === "Divider" && node.style === "dotted") leaders.push(node);
  });
  assert.ok(leaders.length >= 6, "dotted leaders for each price row");
  walk(frame, (node) => {
    if (node.type === "Divider" && node.flex === 1) {
      assert.equal(node.style, "dotted");
      assert.equal(node.thickness, 2);
    }
  });
});

test("list recipes fill the lower third of a 1080 frame", async () => {
  const dir = await testTemp("recipe-fill-");
  await composeSpec(
    { type: "Frame", width: 64, height: 64, background: "#336699" },
    { baseDir: dir, outPath: path.join(dir, "photo.png") },
  );
  const lists: SignageRecipe[] = ["price-list", "menu-board", "schedule"];
  for (const name of lists) {
    for (const variant of RECIPE_VARIANTS) {
      const spec: Record<string, unknown> = { ...signageSpec(name, variant, "photo.png"), width: 1920, height: 1080 };
      if (name === "price-list") {
        spec.theme = "cinema-noir";
        spec.rows = [
          { name: "House salad", price: "9" },
          { name: "Tomato soup", price: "8" },
          { name: "Grilled cheese", price: "11" },
          { name: "Roast chicken", price: "22" },
          { name: "River trout", price: "24" },
          { name: "Chocolate tart", price: "10" },
        ];
      }
      const result = await composeSpec(spec, { baseDir: dir });
      const pixels = await pixelsFromPng(result.png);
      const themeName = typeof spec.theme === "string" ? spec.theme : "earthy-market";
      const bg = THEMES[themeName as keyof typeof THEMES]?.background ?? "#1B2632";
      const raw = bg.replace("#", "");
      const rgb = [Number.parseInt(raw.slice(0, 2), 16), Number.parseInt(raw.slice(2, 4), 16), Number.parseInt(raw.slice(4, 6), 16)];
      const start = Math.floor(pixels.height * 2 / 3);
      let near = 0;
      let total = 0;
      for (let y = start; y < pixels.height; y++) {
        for (let x = 0; x < pixels.width; x++) {
          const i = (y * pixels.width + x) * 4;
          const dr = (pixels.data[i] ?? 0) - rgb[0]!;
          const dg = (pixels.data[i + 1] ?? 0) - rgb[1]!;
          const db = (pixels.data[i + 2] ?? 0) - rgb[2]!;
          if (dr * dr + dg * dg + db * db < 8 * 8) near++;
          total++;
        }
      }
      const fraction = near / Math.max(1, total);
      assert.ok(fraction < 0.9, `${name}/${variant} lower-third near-background ${fraction.toFixed(3)}`);
    }
  }
  await rm(dir, { recursive: true, force: true });
});

test("every catalog recipe example composes for lint", async () => {
  const dir = await testTemp("recipe-lint-only-");
  await composeSpec(
    { type: "Frame", width: 64, height: 64, background: "#336699" },
    { baseDir: dir, outPath: path.join(dir, "photo.png") },
  );
  const examples = recipeExamples();
  for (const name of RECIPE_NAMES) {
    const spec = { ...(examples[name].example as Record<string, unknown>) };
    if (JSON.stringify(spec).includes("./photo.png")) spec.image = "photo.png";
    const result = await composeSpec(spec, { baseDir: dir });
    assert.ok(result.png.length > 8, `${name} example png`);
  }
  await rm(dir, { recursive: true, force: true });
});

test("signage recipes validate content bounds and variants", () => {
  assertUsage(
    () => expandComposeRecipe({ recipe: "hero", variant: "d", headline: "Hi", subhead: "There", image: "./photo.png" }),
    /variant must be a\|b\|c/,
  );
  assertUsage(
    () => expandComposeRecipe({ recipe: "price-list", title: "Menu", rows: [{ name: "Soup", price: "8" }] }),
    /6 to 14/,
  );
  assertUsage(
    () => expandComposeRecipe({ recipe: "schedule", title: "Day", rows: [{ time: "09:00", item: "Doors" }] }),
    /4 to 10/,
  );
  assertUsage(
    () => expandComposeRecipe({ recipe: "menu-board", sections: [{ heading: "Only", items: [{ name: "Pie" }] }] }),
    /2 to 3/,
  );
  assertUsage(
    () => expandComposeRecipe({ recipe: "quote", variant: "c", quotation: "Stay.", attribution: "House" }),
    /variant c requires image/,
  );
  assertUsage(
    () => expandComposeRecipe({ recipe: "hero", headline: "Hi", subhead: "Two\nlines", image: "./photo.png" }),
    /must be one line/,
  );
});
