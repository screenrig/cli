const page = document.querySelector("#page");
const prev = document.querySelector("#prev");
const next = document.querySelector("#next");
const generate = document.querySelector("#generate");
const status = document.querySelector("#status");
const input = document.querySelector("#input");
const stage = document.querySelector("#stage");

const items = [];
const cache = new Map();
let index = 0;

function pretty(source) {
  try {
    return `${JSON.stringify(JSON.parse(source), null, 2)}\n`;
  } catch {
    return source;
  }
}

function fileUrl(src) {
  return `/files/${String(src).replace(/^\.\//, "")}`;
}

function runFile(runId, file) {
  return `/runs/${runId}/${file}`;
}

function placeBox(el, rect, canvas) {
  el.style.left = `${(100 * rect.x) / canvas.width}%`;
  el.style.top = `${(100 * rect.y) / canvas.height}%`;
  el.style.width = `${(100 * rect.width) / canvas.width}%`;
  el.style.height = `${(100 * rect.height) / canvas.height}%`;
}

function mountStage(runId, pageData, canvas) {
  const layers = [...(pageData.manifest?.layers ?? [])].sort((a, b) => a.z - b.z || 0);
  stage.replaceChildren();
  const frame = document.createElement("div");
  frame.className = "stage-frame";
  for (const layer of layers) {
    const el = document.createElement("div");
    el.className = "layer";
    const mediaType = layer.media?.type;
    if (mediaType !== "video") el.classList.add("fit-contain");
    el.style.zIndex = String(layer.z);
    if (mediaType === "iframe" || mediaType === "application") {
      const hole = layer.media?.rect ?? layer.rect;
      placeBox(el, hole, canvas);
      el.classList.add(mediaType === "iframe" ? "hole-iframe" : "hole-webapp");
      if (mediaType === "iframe") {
        const iframe = document.createElement("iframe");
        iframe.src = layer.media.src;
        iframe.title = "iframe";
        iframe.setAttribute("aria-label", "iframe");
        iframe.style.pointerEvents = "none";
        el.append(iframe);
      } else {
        const placeholder = document.createElement("div");
        placeholder.className = "webapp-hole";
        placeholder.textContent = "webapp";
        el.append(placeholder);
      }
    } else if (mediaType === "video") {
      placeBox(el, layer.rect, canvas);
      const video = document.createElement("video");
      video.src = fileUrl(layer.media.src);
      video.autoplay = true;
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      el.append(video);
      video.play().catch(() => {});
    } else if (layer.file) {
      placeBox(el, layer.rect, canvas);
      const img = document.createElement("img");
      img.src = runFile(runId, layer.file);
      img.alt = layer.id;
      el.append(img);
    } else {
      continue;
    }
    if (layer.enter?.type) {
      el.classList.add(`enter-${layer.enter.type}`);
      el.style.animationDelay = `${500 + (layer.enter.stagger ?? 0) * 120}ms`;
    }
    if (layer.motion?.type === "drift") {
      el.classList.add(`motion-drift-${layer.motion.zoom ?? "in"}-${layer.motion.speed ?? "slow"}`);
    }
    if (layer.motion?.type === "spin") {
      el.classList.add(`motion-spin-${layer.motion.direction ?? "cw"}-${layer.motion.speed ?? "slow"}`);
    }
    frame.append(el);
  }
  stage.append(frame);
}

function showError(message) {
  stage.replaceChildren();
  const p = document.createElement("p");
  p.className = "error";
  p.textContent = message;
  stage.append(p);
}

async function generateSource(source) {
  const res = await fetch("/api/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: source, combined: false }),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(body.error ?? "failed");
  return body.run;
}

async function ensureRun(source) {
  let run = cache.get(source);
  if (run) return run;
  run = await generateSource(source);
  cache.set(source, run);
  return run;
}

async function showCurrent({ force } = {}) {
  const item = items[index];
  if (!item) return;
  generate.disabled = true;
  status.textContent = "rendering…";
  try {
    if (force) cache.delete(item.source);
    const source = input.value;
    const run = force ? await generateSource(source) : await ensureRun(item.source);
    if (force) {
      item.source = source;
      cache.set(source, run);
    }
    const pageData = run.pages.find((entry) => entry.id === item.pageId) ?? run.pages[0];
    mountStage(run.id, pageData, run.canvas);
    status.textContent = item.label;
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed";
    status.textContent = message;
    showError(message);
  } finally {
    generate.disabled = false;
  }
}

function setIndex(nextIndex) {
  if (!items.length) return;
  index = (nextIndex + items.length) % items.length;
  page.value = String(index);
  input.value = pretty(items[index].source);
}

page.addEventListener("change", async () => {
  setIndex(Number(page.value));
  await showCurrent();
});
prev.addEventListener("click", async () => {
  setIndex(index - 1);
  await showCurrent();
});
next.addEventListener("click", async () => {
  setIndex(index + 1);
  await showCurrent();
});
generate.addEventListener("click", () => showCurrent({ force: true }));
input.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    showCurrent({ force: true });
  }
});
window.addEventListener("keydown", (event) => {
  if (event.target === input) return;
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    prev.click();
  }
  if (event.key === "ArrowRight") {
    event.preventDefault();
    next.click();
  }
});

const res = await fetch("/api/examples");
const body = await res.json();
if (!body.ok || !body.examples.length) {
  status.textContent = "no examples";
} else {
  for (const example of body.examples) {
    let data = {};
    try {
      data = JSON.parse(example.source);
    } catch {
      data = {};
    }
    if (Array.isArray(data.pages) && data.pages.length) {
      for (const entry of data.pages) {
        const pageId = entry.id ?? "page";
        items.push({
          label: `${example.id} / ${pageId}`,
          exampleId: example.id,
          pageId,
          source: example.source,
        });
      }
    } else {
      items.push({
        label: example.id,
        exampleId: example.id,
        pageId: "page",
        source: example.source,
      });
    }
  }
  for (const [i, item] of items.entries()) {
    const option = document.createElement("option");
    option.value = String(i);
    option.textContent = item.label;
    page.append(option);
  }
  const start = items.findIndex((item) => item.exampleId === "showcase");
  setIndex(start >= 0 ? start : 0);
  await showCurrent();
}
