import { LOOK_AT_THE_CONTACT_SHEET } from "./playlist-preview.js";

export const CREDIT_HELP = "Credits:\n  Remaining is a nonnegative whole number (never negative; empty remaining\n  displays 0). Below 1000 credits, authenticated responses may warn\n  credits_low. Until 1 Jan 2027 08:00 UTC (midnight PT), production fails open:\n  billed commands are not rejected for empty remaining and do not return\n  HTTP 402. After that instant, remaining below 1 credit is payment_required.\n  Empty remaining does not stop or shut off screens in this window.\n  media generate is the exception: it is billed per token.\n  Text input is $10 / 1M tokens, image input is $16 / 1M, image output is\n  $60 / 1M. Quality changes how detailed the still is and therefore how\n  many tokens it uses. Remaining that cannot cover the debit returns\n  payment_required / 402, including during this window.";

export const SUMMARIES: Record<string, string> = {
  account: "Inspect your account and credits",
  agent: "Enroll, connect, and manage this agent",
  dashboard: "Open the account dashboard",
  app: "Pack, upload, and inspect applications",
  media: "Generate, upload, and manage images and videos",
  compose: "Render and inspect local page compositions",
  playlist: "Author, validate, preview, and manage playlists",
  screen: "Pair, configure, and inspect screens",
  browser: "Complete browser Player setup",
  kv: "Read and write application key-value data",
  comment: "Read and manage screen and playlist comments",
  operations: "Inspect, wait for, or cancel operations",
  events: "List or follow account events",
  playback: "Inspect playback records",
  feedback: "Submit bugs and feature requests",
  doctor: "Check this CLI installation and configuration",
  version: "Show CLI and protocol versions",
  help: "Discover commands and their options",
};

export const ACTION_SUMMARIES: Record<string, string> = {
  enroll: "Create the first agent with an email address", connect: "Connect this installation with approval",
  status: "Inspect this agent's connection", disconnect: "Disconnect this agent",
  pack: "Pack a local application directory", upload: "Upload a local file or directory",
  update: "Update an existing resource", list: "List resources", show: "Inspect a resource",
  generate: "Generate an image from a prompt", download: "Download media to a file",
  "upload-batch": "Upload a manifest with resumable state", delete: "Delete a resource",
  catalog: "Browse local composition capabilities and examples", batch: "Render a batch of compositions",
  render: "Render a composition locally", validate: "Validate a playlist file",
  preview: "Render playlist previews and a contact sheet", templates: "Browse playlist templates",
  create: "Create a playlist from a file", export: "Export a playlist bundle", import: "Import a playlist bundle",
  pair: "Claim a Player pairing code", provision: "Create a screen and browser handoff",
  setup: "Complete browser setup from a code", assign: "Assign a playlist to a screen",
  "set-timezone": "Set a screen's timezone", archive: "Archive a screen", unarchive: "Restore an archived screen",
  "rotate-public-id": "Rotate a screen's public identifier", toast: "Show a temporary screen message",
  screenshot: "Capture and download a screen screenshot", get: "Read the current value or operation",
  set: "Write a value", wait: "Wait for an operation to finish", cancel: "Cancel an operation",
  follow: "Stream account events", bug: "Submit a bug report", feature: "Submit a feature request",
};

export const NOTES: Record<string, string> = {
  "agent connect": "Approval expires after 24 hours; --timeout defaults to 86400000 ms. Retry agent connect to resume after an interrupted wait.",
  "media generate": CREDIT_HELP,
  "account show": CREDIT_HELP,
  "compose render": LOOK_AT_THE_CONTACT_SHEET,
  "compose batch": `Render 1 to 2000 pages. ${LOOK_AT_THE_CONTACT_SHEET}`,
  "playlist preview": LOOK_AT_THE_CONTACT_SHEET,
};

