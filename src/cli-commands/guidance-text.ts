/** Help text shared by several command notes. */
export const IFRAME_FIELDS_HELP = " An iframe primitive takes optional reload_s (0, the default, never reloads; 60 to 86400 loads src again every reload_s seconds while the page is on glass), optional fallback_src (the page shown when src does not load, with the forms and rules of src; a recovered src replaces it at the next reload) and optional navigation_allowlist (1 to 64 host-sources of the form [scheme://]host[:port][path], such as example.com, *.example.com or https://example.com/docs/; with a list, the page's links, scripted navigations and redirects reach only src, fallback_src and matching addresses; omit it for no restriction, an empty list is refused). The src and fallback_src of an iframe may carry screen tokens in the path, query or fragment of an http or https address: {screen.id} (the screen id without its scr_ prefix), {screen.name}, {screen.timezone}, {screen.field.NAME}, {screen.location.lat}, {screen.location.lon}, {screen.location.name} and {screen.location.address}. The playlist stores the address as written, braces kept, and each screen's manifest carries its own address with every value percent-encoded for its place in it; a screen that lacks a value gets no iframe, and the write answers with a screen_fact_missing warning that names the screens. A token in the scheme, credentials, host or port, or in a YouTube, document or BI view address, is invalid_request at src. An application primitive takes optional params (up to 16 names of lower case letters, digits and underscores, ticket and policy reserved, values up to 512 characters, the same tokens) that its launch URL carries as query parameters after ticket.";

export const DOCUMENT_LINK_HELP = IFRAME_FIELDS_HELP + " An iframe page whose src or fallback_src is a Google Slides, Docs or Sheets share, Publish to web or embed link, or a Microsoft 365 Embed link (File → Share → Embed in Word, Excel or PowerPoint on OneDrive or SharePoint), is stored rebuilt for the screen: Slides and PowerPoint decks loop, a Slides deck advances on the link's own delay held to the page duration (give the page the time of the whole deck), and Docs, Sheets, Word and Excel reload every 5 minutes. A file that asks viewers to sign in is refused with document_not_shared, whose detail names the sharing setting to change.";

/** A container primitive that playlist validate accepts on a 1920x1080 page; the help shows it and a test validates it. */
export const CONTAINER_EXAMPLE = {
  id: "side", primitive: "container", rect: { x: 1440, y: 0, width: 480, height: 1080 }, layer: 1,
  turn: { on: "clock", every_ms: 10000 }, transition: { type: "fade", duration_ms: 400 },
  items: [
    { id: "clock", primitive: "card", card: "clock", major: 1, params: { face: "digital" }, layout: "full" },
    { id: "logo", primitive: "image", selector: { by: "id", media_id: "med_LOGO" }, content_fit: "contain" },
  ],
};

export const CONTAINER_HELP = " A container primitive {id, primitive: container, rect, layer, turn, transition?, items} shows one of its 1 to 8 items, cards and images, at a time in its rect." +
  " turn.on clock steps through the items without when every every_ms (1000 to 3600000; offset_ms, below every_ms, shifts the steps). turn.on video follows the page's one video primitive:" +
  " match tag (the default) shows the first item that shares a tag with the playing file's media tags, match index the item at the file's position, and no_match clock (the default), hold or hide applies when nothing matches." +
  " min_ms (0 to 60000) keeps an item on at least that long. transition is cut (the default) or fade, with duration_ms 0 to 2000." +
  " A card item is a card primitive's card, major, params, data, layout (required, as on a card primitive) and anchor, with no rect, layer or content_fit; an image item is a selector by id with optional alt and content_fit." +
  " Each item has its own id, unique across the page's primitives and items, optional tags (1 to 8 of letters and digits) and optional when {data: {key, path?, equals?}}, which shows that item instead of the others while it holds; at least one item has no when." +
  " A container takes no content_fit, controller or motion; a page holds at most 4, and the container and each of its items count toward the page's 24 primitives." +
  " The data key {page.video} is the page video's now-playing record (primitive_id, media_id, name, tags, index, count, lap, duration_ms, started_at_ms): a card's data, a when.data key or a page's visibility.data key may name it." +
  " Example: " + JSON.stringify(CONTAINER_EXAMPLE) + ".";
