import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ApiClient } from "./client.js";
import type { CliRuntime } from "./runtime.js";
import { apexHost } from "./apex-origin.js";
import { withPreviewBrowser, type PreviewAsset, type PreviewBrowser } from "./headless-preview.js";
import { CliError, usageError } from "./problems.js";

type Json = Record<string, any>;
export interface CardPreviewInput {
  card: string; major?: number; params?: Json; data?: Json; feed?: Json;
  layout?: string; anchor?: string; width: number; height: number;
  now?: string; timezone?: string;
  placement?: { rect?: { x: number; y: number; width: number; height: number }; strips: string[] };
}

/** Public renderer bytes are verified before a local browser ever sees project data. */
export async function withCardPreview<T>(options: { apiUrl: string; runtime: CliRuntime; client?: ApiClient }, work: (renderer: LocalCardPreview) => Promise<T>): Promise<T> {
  const origin = new URL(options.apiUrl);
  origin.hostname = apexHost(origin.hostname) ?? origin.hostname;
  const response = await fetch(new URL("/cards/index.json?local-preview=" + Date.now(), origin), { signal: AbortSignal.timeout(30_000), redirect: "error" });
  if (!response.ok) throw usageError(`Cannot load the public card renderer (${response.status}).`);
  const index = await response.json() as Json;
  if (!index.web?.script || !index.web?.sandbox || !index.web?.fonts) throw usageError("The public cards index has no web renderer.");
  const assets = new Map<string, PreviewAsset>();
  const cache = path.join(options.runtime.homedir(), ".cache", "screenrig", "preview");
  await mkdir(cache, { recursive: true });
  for (const link of [index.web.script, index.web.sandbox, index.web.fonts, ...(index.web.font_files ?? [])]) {
    if (typeof link.src !== "string" || !/^\/cards\//.test(link.src) || !/^[a-f0-9]{64}$/.test(link.sha256)) throw usageError("Invalid public renderer asset reference.");
    const filename = path.join(cache, link.sha256);
    let bytes = await readFile(filename).catch(() => undefined);
    const valid = (value: Buffer): boolean => createHash("sha256").update(value).digest("hex") === link.sha256;
    if (!bytes || !valid(bytes)) {
      const answer = await fetch(new URL(link.src, origin), { signal: AbortSignal.timeout(30_000), redirect: "error" });
      if (!answer.ok) throw usageError(`Cannot load a public card renderer asset (${answer.status}).`);
      bytes = Buffer.from(await answer.arrayBuffer());
      if (bytes.length > 32 * 1024 * 1024 || !valid(bytes)) throw usageError("Public card renderer asset failed its digest or size check.");
      await writeFile(filename, bytes);
    }
    assets.set(new URL(link.src, origin).pathname, { bytes, type: link.src.endsWith(".js") ? "text/javascript" : link.src.endsWith(".css") ? "text/css" : "font/ttf" });
  }
  return await withPreviewBrowser(options.runtime.env, async (browser: PreviewBrowser) => work({
      async render(input) {
        if (![input.width, input.height].every((size) => Number.isSafeInteger(size) && size > 0 && size <= 8192)) throw usageError("Preview dimensions must be integers from 1 to 8192.");
        if (input.now && !Number.isFinite(Date.parse(input.now))) throw usageError("--now must be an ISO timestamp.");
        if (input.timezone) { try { new Intl.DateTimeFormat("en", { timeZone: input.timezone }); } catch { throw usageError("--timezone must be an IANA timezone."); } }
        if (input.params && (typeof input.params !== "object" || Array.isArray(input.params))) throw usageError("Card params must be a JSON object.");
        const unrendered: string[] = [];
        // Resolve project images in Node. The browser has no project credential.
        async function resolveMedia(value: any): Promise<any> {
          if (Array.isArray(value)) return Promise.all(value.map(resolveMedia));
          if (value && typeof value === "object") return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key,item]) => [key, await resolveMedia(item)])));
          if (typeof value !== "string" || !value.startsWith("media:")) return value;
          const id = value.slice(6);
          if (!/^(?:(?:stage|qa|development)_)?med_[A-Za-z0-9_-]+$/.test(id) || !options.client) { unrendered.push(`Card image ${value} unavailable`); return ""; }
          try {
            const answer = await options.client.download({ method: "GET", path: `/api/media/${encodeURIComponent(id)}/content` });
            if (!answer.body) throw new Error("empty image");
            const bytes = Buffer.from(await new Response(answer.body as any).arrayBuffer());
            if (bytes.length > 32 * 1024 * 1024) throw new Error("image too large");
            const localPath = `/preview-media/${id}`;
            assets.set(localPath, {bytes, type: "application/octet-stream"});
            return value;
          } catch { unrendered.push(`Card image ${id} unavailable`); return ""; }
        }
        const resolved = { ...input, params: await resolveMedia(input.params), data: await resolveMedia(input.data) };
        const payload = JSON.stringify(resolved).replace(/</g, "\\u003c");
        const html = `<!doctype html><html><head><link rel="stylesheet" href="${index.web.fonts.src}"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}#card{position:absolute;inset:0}</style><script src="${index.web.script.src}"></script></head><body><div id="card"></div><script>
          const p=${payload};
          window.onerror=(message)=>window.previewError=String(message);
          window.onunhandledrejection=(event)=>window.previewError=String(event.reason?.message||event.reason);
          (async()=>{
            await document.fonts.ready;
            const api=window.ScreenRigCards;
            api.configure({cardmlSandbox:()=>new Worker(${JSON.stringify(index.web.sandbox.src)})});
            const version=api.versions().cards[p.card];
            if(!version || (p.major!==undefined && Number(version.split('.')[0])!==p.major)) throw new Error('Published renderer does not carry '+p.card+' major '+p.major);
            const manifest=api.manifest(p.card);
            window.previewFeed=manifest.feed;
            const params=Object.assign({},p.params,p.layout?{layout:p.layout}:{},p.anchor?{anchor:p.anchor}:{});
            let geometry=api.place(p.layout||'full',p.anchor||'',p.width,p.height);
            if(p.placement){
              if(p.layout==='free'&&p.placement.rect){const r=p.placement.rect;geometry={x:r.x,y:r.y,w:r.width,h:r.height,rotation:0};}
              if(p.layout==='corner'||p.layout==='chip'){
                const thickness=api.place('strip','bottom',p.width,p.height).h;
                const anchor=p.anchor||'top-right';
                for(const edge of p.placement.strips){if(anchor.indexOf(edge)>=0){if(edge==='top')geometry.y+=thickness;else if(edge==='bottom')geometry.y-=thickness;else if(edge==='left')geometry.x+=thickness;else if(edge==='right')geometry.x-=thickness;}}
              }
              Object.assign(document.getElementById('card').style,{inset:'auto',left:geometry.x+'px',top:geometry.y+'px',width:geometry.w+'px',height:geometry.h+'px',transform:'rotate('+geometry.rotation+'deg)'});
            }
            const handle=api.mount(document.getElementById('card'),{cardId:p.card,params,dataKey:p.data?'preview':'',dataSource:p.data?{fetch:(key,done)=>done(p.data)}:null,feed:p.feed||null,mediaResolver:{resolve:(src,done)=>done(typeof src==='string'&&/^media:(?:(?:stage|qa|development)_)?med_[A-Za-z0-9_-]+$/.test(src)?'/preview-media/'+src.slice(6):'')},active:true,fadeMs:0,frozenNowMs:p.now?Date.parse(p.now):Date.now(),timeZone:p.timezone||Intl.DateTimeFormat().resolvedOptions().timeZone,onFailed:(code,cause)=>window.previewError=cause?code+': '+cause:code,onReady:()=>requestAnimationFrame(async()=>{await document.fonts.ready;await Promise.all(Array.from(document.images).filter(img=>img.getAttribute('src')).map(img=>img.decode().catch(()=>{})));requestAnimationFrame(()=>{window.previewResult={card:p.card,version,geometry,feed:manifest.feed,unrendered:[]};window.previewReady=true;});})});
          })().catch(e=>window.previewError=e.message);
        </script></body></html>`;
        const answer = await browser.render(html, input.width, input.height, assets);
        // A feed is host-supplied; an absent feed can draw a designed waiting state.
        if (answer.result.feed && !input.feed && !(input.card === "events" && input.data?.events)) unrendered.push(`Host feed ${answer.result.feed} was not supplied`);
        answer.result.unrendered = unrendered;
        return answer;
      },
      async placement(raw) {
        let card = raw.card, params = raw.params ?? {}, major = raw.major, data: Json | undefined;
        if (typeof card !== "string") throw usageError("Card placement has no card identifier.");
        if (/^(?:(?:stage|qa|development)_)?crd_/.test(card)) {
          if (!options.client) throw usageError("Previewing a card instance requires a project credential.");
          const instance = (await options.client.call({ method: "GET", path: `/api/cards/${encodeURIComponent(card)}` })).body as Json;
          params = instance.params; major = instance.major;
          try {
            const record = (await options.client.call({ method: "GET", path: `/api/cards/${encodeURIComponent(card)}/data` })).body as Json;
            if (!record.expired) data = record.document;
          } catch (error) { if (!(error instanceof CliError) || error.problem.status !== 404) throw error; }
          card = instance.type;
        } else if (raw.data && options.client) {
          const record = (await options.client.call({ method: "GET", path: `/api/card-data/${encodeURIComponent(raw.data)}` })).body as Json;
          if (!record.expired) data = record.document;
        }
        return { card, params, major, data };
      },
    }));
}

export interface LocalCardPreview {
  render(input: CardPreviewInput): Promise<{ png: Buffer; result: Json }>;
  placement(raw: Json): Promise<{ card: string; params: Json; major: number | undefined; data: Json | undefined }>;
}
