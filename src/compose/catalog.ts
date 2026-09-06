import { GlobalFonts } from "@napi-rs/canvas";
import { FONT_FALLBACKS, loadUserFonts } from "./fonts.js";
import { LOOK_AT_THE_CONTACT_SHEET, lintCodesList } from "./lint.js";
import { viewingGuidance } from "./type.js";
import {
  ALIGN,
  CARD_FITS,
  DRIFT_DIR,
  DRIFT_ZOOM,
  ENTER_TYPES,
  LOGO_CORNERS,
  REGIONS,
  SPEED,
  SPIN_DIR,
  VALIGN,
  VIEWING_DISTANCES,
  WIRE_PRIMITIVES,
} from "./types.js";

export { FONT_FALLBACKS } from "./fonts.js";
export { WIRE_PRIMITIVES } from "./types.js";

export interface ComposeCatalog {
  page_keys: string[];
  regions: typeof REGIONS[number][];
  region_fields: string[];
  card_fields: string[];
  card_plate_fields: string[];
  card_fits: typeof CARD_FITS[number][];
  logo_corners: typeof LOGO_CORNERS[number][];
  table_fields: string[];
  enter: typeof ENTER_TYPES[number][];
  motion: {
    types: ["spin", "drift"];
    spin: { direction: typeof SPIN_DIR[number][]; speed: typeof SPEED[number][] };
    drift: { zoom: typeof DRIFT_ZOOM[number][]; direction: typeof DRIFT_DIR[number][]; speed: typeof SPEED[number][] };
  };
  align: typeof ALIGN[number][];
  valign: typeof VALIGN[number][];
  viewing: typeof VIEWING_DISTANCES[number][];
  installed_fonts: string[];
  examples: Record<string, unknown>;
  rules: {
    authoring: string;
    font: string;
    fontSize: false;
    xy: false;
    page_text: string;
    region_text: string;
    title_color: string;
    card: string;
    logo: string;
    iframe: string;
    markdown: string;
    image_src: string;
    shadow: string;
    outline: string;
    layered: string;
    envelope: string;
    viewing: string;
    lint: string;
    preview: string;
    wire: string;
  };
  wire_primitives: typeof WIRE_PRIMITIVES[number][];
  font_fallbacks: typeof FONT_FALLBACKS[number][];
}

const PAGE_KEYS = [
  "width", "height", "font", "background", "brand", "text", "image", "video", "motion", "pages", "name", "viewing", "logo",
];
const REGION_FIELDS = [
  "title", "subtitle", "text", "footer", "image", "video", "iframe", "webapp", "cards", "card", "table",
  "enter", "stagger", "motion", "align", "valign", "fill", "color", "z", "shadow", "outline",
];

export function composeCatalog(): ComposeCatalog {
  loadUserFonts();
  return {
    page_keys: PAGE_KEYS,
    regions: [...REGIONS],
    region_fields: REGION_FIELDS,
    card_fields: ["title", "subtitle", "text", "price", "image"],
    card_plate_fields: ["title", "subtitle", "text", "footer", "image", "cards", "table", "fill", "color", "fit"],
    card_fits: [...CARD_FITS],
    logo_corners: [...LOGO_CORNERS],
    table_fields: ["columns", "rows"],
    enter: [...ENTER_TYPES],
    motion: {
      types: ["spin", "drift"],
      spin: { direction: [...SPIN_DIR], speed: [...SPEED] },
      drift: { zoom: [...DRIFT_ZOOM], direction: [...DRIFT_DIR], speed: [...SPEED] },
    },
    align: [...ALIGN],
    valign: [...VALIGN],
    viewing: [...VIEWING_DISTANCES],
    installed_fonts: GlobalFonts.families.map((family) => family.family).sort(),
    examples: {
      slide: {
        width: 1920,
        height: 1080,
        font: "Noto Serif",
        background: "#1C1410",
        brand: "#C9A227",
        text: "#F3E6D0",
        left: {
          enter: "fade-up",
          card: {
            title: "FIRE AT THE TABLE",
            text: "A four-course supper cooked over live coals.",
          },
        },
        right: {
          valign: "bottom",
          footer: "The Kiln Room · £86",
        },
      },
      menu: {
        width: 1920,
        height: 1080,
        font: "Noto Serif",
        background: "#14110C",
        brand: "#C9A227",
        text: "#F3E6D0",
        left: {
          card: {
            title: "Char & Bone",
            cards: [
              { title: "Coal-seared ribeye", price: "28" },
              { title: "Ember chicken, brown butter", price: "19" },
            ],
            footer: "Evening grill from 17:00",
          },
        },
        right: { image: "./dish.png" },
      },
      table: {
        width: 1920,
        height: 1080,
        font: "Noto Sans",
        background: "#0E1A2B",
        brand: "#FFB800",
        text: "#F4F7FA",
        fullpage: {
          title: "Saturday",
          table: {
            columns: ["Time", "Hall", "Event", "Status"],
            rows: [
              ["09:00", "A", "Doors", "Open"],
              ["10:30", "B", "Keynote", "Seated"],
              ["14:00", "A", "Labs", "Walk-in"],
            ],
          },
        },
      },
      overlay: {
        width: 1920,
        height: 1080,
        font: "Noto Serif",
        background: "#00000000",
        brand: "#C9A227",
        text: "#FFFFFF",
        video: "./clip.mp4",
        motion: { type: "drift", zoom: "in", direction: "none", speed: "slow" },
        bottom: {
          enter: "fade-up",
          valign: "bottom",
          card: {
            fit: "ink",
            title: "Lower third",
            text: "Keep copy on a snug plate over the picture.",
          },
        },
      },
      deck: {
        width: 1920,
        height: 1080,
        font: "Noto Serif",
        background: "#0D0D0D",
        brand: "#D4AF37",
        text: "#F2EDE4",
        pages: [
          {
            id: "supper",
            left: { title: "Fire at the table", text: "Four courses over live coals." },
            right: { valign: "bottom", footer: "The Kiln Room · £86" },
          },
          {
            id: "menu",
            fullpage: {
              title: "Tonight",
              cards: [{ title: "Ribeye", price: "28" }, { title: "Hispi", price: "8" }],
            },
          },
        ],
      },
    },
    rules: {
      authoring: "JSON page rails plus named regions. Unknown keys fail. Do not author fontSize, x, or y.",
      font: "page font must be installed on this host; a missing family is usage_error, not a silent fallback. Omit font to walk catalog fallbacks.",
      fontSize: false,
      xy: false,
      page_text: "On the page, text is the copy color. background, brand, and text are hex colors. muted copy is mixed from text toward background.",
      region_text: "In a region, text is body copy (string or array of lines). title, subtitle, and footer are roles; size is procedural.",
      title_color: "Region title and card-item title default to brand. subtitle, text, and footer default to text. Prices and table headers stay brand. Optional region or card color overrides every role in that box.",
      card: "card (singular) is a plate. card.fit is region|ink, default region. region: the plate fills the whole region rect. ink: the plate hugs measured type plus 24 px pad, placed with the region's align/valign. Default fill is the page background + B3 (30% transparency). Override with card.fill. Inner fields: title, subtitle, text, footer, image, cards, table, fill, color, fit. cards (plural) remains the menu-item list. No nested card. Sibling title/text/cards are not allowed next to card. Use a card to bring type forward over photo or video; do not wrap every region.",
      logo: 'Page or per-page logo is a path or { src, corner }. corner is top-left|top-right|bottom-left|bottom-right; default bottom-right. 32 px inset from the chosen corner, contain max 200×100, never upscaled, never stretched. Sits above regions. Card, type, and iframe holes inset so they do not overlap the mark (reserved box includes the 32 px margin).',
      iframe: "iframe and webapp reserve leftover space like an image and are not painted. Manifest media is { type: iframe|application, src, rect } in page coordinates. Omit PNG file when the layer is only iframe/webapp. URLs are allowed. Logo inset applies.",
      markdown: "Copy strings accept **bold**, *italic*, and __underline__. Nesting ***bold italic*** is allowed. Unmatched markers stay literal. No links, lists, or headings.",
      image_src: "local filesystem path relative to the spec file directory; iframe and webapp src may be a URL",
      shadow: 'Text over a page image or video with no fill gets a 1px unblurred drop shadow: #000000E6 on light type, #FFFFFFE6 on dark type. Set shadow to "none" or { x, y, color } to override. A card plate is backing, so type on a card does not get the automatic shadow.',
      outline: "outline is { width: 0.5-12, color } and is off unless set.",
      layered: "compose render writes one PNG per region plus manifest.json. --combined writes a flattened PNG for inspection. Default for agent work is layered.",
      envelope: "structured JSON, not pixels",
      viewing: viewingGuidance(),
      lint: `warnings (${lintCodesList()}); never errors. compose render, compose batch, and playlist validate emit lint ordered by page. --lint-only skips artifact writes.`,
      preview: LOOK_AT_THE_CONTACT_SHEET,
      wire: "Copy and chrome stay compose-local. Upload stills and place image primitives. Playlist wire remains image|video|iframe|application. Layered PNGs can later sit as image primitives at their manifest rects.",
    },
    wire_primitives: [...WIRE_PRIMITIVES],
    font_fallbacks: [...FONT_FALLBACKS],
  };
}

export function formatComposeCatalog(catalog: ComposeCatalog): string {
  return [
    "Local compose catalog",
    `page_keys: ${catalog.page_keys.join("|")}`,
    `regions: ${catalog.regions.join("|")}`,
    `region_fields: ${catalog.region_fields.join("|")}`,
    `card_fields: ${catalog.card_fields.join("|")}`,
    `card_plate_fields: ${catalog.card_plate_fields.join("|")}`,
    `card_fits: ${catalog.card_fits.join("|")}`,
    `logo_corners: ${catalog.logo_corners.join("|")}`,
    `table_fields: ${catalog.table_fields.join("|")}`,
    `enter: ${catalog.enter.join("|")}`,
    `motion: spin|drift`,
    `spin: ${catalog.motion.spin.direction.join("|")} ${catalog.motion.spin.speed.join("|")}`,
    `drift: ${catalog.motion.drift.zoom.join("|")} ${catalog.motion.drift.direction.join("|")} ${catalog.motion.drift.speed.join("|")}`,
    `align: ${catalog.align.join("|")}`,
    `valign: ${catalog.valign.join("|")}`,
    `viewing: ${catalog.viewing.join("|")}`,
    "fontSize: not authorable",
    "x,y: not authorable",
    `authoring: ${catalog.rules.authoring}`,
    `font: ${catalog.rules.font}`,
    `page_text: ${catalog.rules.page_text}`,
    `region_text: ${catalog.rules.region_text}`,
    `title_color: ${catalog.rules.title_color}`,
    `card: ${catalog.rules.card}`,
    `logo: ${catalog.rules.logo}`,
    `iframe: ${catalog.rules.iframe}`,
    `markdown: ${catalog.rules.markdown}`,
    `image_src: ${catalog.rules.image_src}`,
    `shadow: ${catalog.rules.shadow}`,
    `outline: ${catalog.rules.outline}`,
    `layered: ${catalog.rules.layered}`,
    `viewing: ${catalog.rules.viewing}`,
    `lint: ${catalog.rules.lint}`,
    `preview: ${catalog.rules.preview}`,
    `wire: ${catalog.rules.wire}`,
    `wire_primitives: ${catalog.wire_primitives.join("|")}`,
    "envelope: structured JSON, not pixels",
    `installed_fonts: ${catalog.installed_fonts.join(" | ")}`,
    `examples: ${JSON.stringify(catalog.examples)}`,
  ].join("\n");
}
