type JSONObject = Record<string, unknown>;
const isObject = (value: unknown): value is JSONObject => typeof value === "object" && value !== null && !Array.isArray(value);

const TOKEN = /\{field\.([a-z0-9_]{1,32})\}/g;
const WHOLE_TOKEN = /^\{field\.([a-z0-9_]{1,32})\}$/;

export interface TemplateIssue { path: string; message: string }

/**
 * The offline half of playlist templates: the rules the server checks when a
 * playlist declares `fields`, so `playlist validate` and a create fail on a
 * template file before it is sent. Pure; the server stays the authority.
 */

/** A document that declares fields is a template; its tokens are read by the rules below. */
export function declaresFields(document: unknown): boolean {
  return isObject(document) && Array.isArray(document.fields) && document.fields.length > 0;
}

/**
 * The document with each field token that stands for a media id or a web
 * address replaced by a value the schema accepts, so the canonical schema can
 * check the rest of a template. Other documents come back as they are.
 */
export function withFieldStandIns(document: unknown): unknown {
  if (!declaresFields(document)) return document;
  const copy = structuredClone(document) as JSONObject;
  for (const page of Array.isArray(copy.pages) ? copy.pages : []) {
    if (!isObject(page)) continue;
    for (const primitive of Array.isArray(page.primitives) ? page.primitives : []) {
      if (!isObject(primitive)) continue;
      const selector = primitive.selector;
      if ((primitive.primitive === "image" || primitive.primitive === "video") && isObject(selector) && selector.by === "id"
        && typeof selector.media_id === "string" && WHOLE_TOKEN.test(selector.media_id)) selector.media_id = "med_template_field";
      if (primitive.primitive === "iframe" && typeof primitive.src === "string" && WHOLE_TOKEN.test(primitive.src)) primitive.src = "https://example.com/field";
    }
  }
  return copy;
}

interface Use { name: string; site: "card" | "image" | "video" | "iframe"; path: string }

const SITES = "a field token stands only in a card's params, an image or video selector media_id and an iframe src";

function stringsUnder(value: unknown, path: string, visit: (text: string, path: string) => void): void {
  if (typeof value === "string") visit(value, path);
  else if (Array.isArray(value)) value.forEach((item, index) => stringsUnder(item, `${path}/${index}`, visit));
  else if (isObject(value)) for (const [key, item] of Object.entries(value)) stringsUnder(item, `${path}/${key}`, visit);
}

/**
 * The rules the server checks when fields are declared: every token names a
 * declared field of the right type, a token stands only where a field may, a
 * locked primitive reads none, and every declared field is read.
 */
export function templateIssues(document: unknown): TemplateIssue[] {
  if (!declaresFields(document)) return [];
  const doc = document as JSONObject;
  const fields = new Map<string, JSONObject>();
  for (const field of doc.fields as unknown[]) if (isObject(field) && typeof field.name === "string") fields.set(field.name, field);
  const issues: TemplateIssue[] = [];
  const uses: Use[] = [];
  const stray = (path: string) => issues.push({ path, message: SITES });
  const pages = Array.isArray(doc.pages) ? doc.pages : [];
  pages.forEach((page, pageIndex) => {
    if (!isObject(page)) return;
    const pagePath = `/pages/${pageIndex}`;
    for (const [key, value] of Object.entries(page)) {
      if (key !== "primitives") stringsUnder(value, `${pagePath}/${key}`, (text, path) => { if (text.includes("{field.") && new RegExp(TOKEN.source).test(text)) stray(path); });
    }
    (Array.isArray(page.primitives) ? page.primitives : []).forEach((primitive, index) => {
      if (!isObject(primitive)) return;
      const path = `${pagePath}/primitives/${index}`;
      const kind = primitive.primitive;
      const before = uses.length;
      for (const [key, value] of Object.entries(primitive)) {
        const keyPath = `${path}/${key}`;
        if (key === "params" && kind === "card") {
          stringsUnder(value, keyPath, (text, at) => { for (const match of text.matchAll(TOKEN)) uses.push({ name: match[1]!, site: "card", path: at }); });
        } else if (key === "selector" && (kind === "image" || kind === "video") && isObject(value)) {
          for (const [member, item] of Object.entries(value)) {
            const whole = typeof item === "string" ? WHOLE_TOKEN.exec(item) : null;
            if (whole && member === "media_id" && value.by === "id") uses.push({ name: whole[1]!, site: kind, path: `${keyPath}/media_id` });
            else stringsUnder(item, `${keyPath}/${member}`, (text, at) => { if (new RegExp(TOKEN.source).test(text)) stray(at); });
          }
        } else if (key === "src" && kind === "iframe" && typeof value === "string") {
          const whole = WHOLE_TOKEN.exec(value);
          if (whole) uses.push({ name: whole[1]!, site: "iframe", path: keyPath });
          else if (new RegExp(TOKEN.source).test(value)) issues.push({ path: keyPath, message: "an iframe src takes a url field only as the whole address" });
        } else {
          stringsUnder(value, keyPath, (text, at) => { if (text.includes("{field.") && new RegExp(TOKEN.source).test(text)) stray(at); });
        }
      }
      if (primitive.locked === true && uses.length > before) issues.push({ path: `${path}/locked`, message: "a locked primitive cannot read a field: locked elements are the template's fixed content" });
    });
  });
  const used = new Map<string, string>();
  for (const use of uses) {
    const field = fields.get(use.name);
    if (!field) { issues.push({ path: use.path, message: `{field.${use.name}} is not a declared field` }); continue; }
    const type = field.type;
    if ((use.site === "image" || use.site === "video") && type !== "media") issues.push({ path: use.path, message: `{field.${use.name}} is a ${String(type)} field; an image or video media_id takes a media field` });
    else if (use.site === "iframe" && type !== "url") issues.push({ path: use.path, message: `{field.${use.name}} is a ${String(type)} field; an iframe src takes a url field` });
    else if (use.site === "card" && type === "media") issues.push({ path: use.path, message: `{field.${use.name}} is a media field; a card's params take text and url fields` });
    const previous = used.get(use.name);
    if ((use.site === "image" || use.site === "video") && previous && previous !== use.site) issues.push({ path: use.path, message: `{field.${use.name}} is used as an ${previous} and as a ${use.site}; a media field has one kind` });
    used.set(use.name, use.site);
  }
  (doc.fields as unknown[]).forEach((field, index) => {
    if (isObject(field) && typeof field.name === "string" && !used.has(field.name)) issues.push({ path: `/fields/${index}`, message: `{field.${field.name}} is declared but no page uses it` });
  });
  return issues;
}

