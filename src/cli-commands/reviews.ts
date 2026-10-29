import type { CommandActionBinder } from "./types.js";
import { handleReviewsList, handleReviewsShow, handleReviewsWithdraw } from "../handlers/reviews.js";
import { type Command, Option } from "commander";
import { addCommandNotes } from "./notes.js";
import { positiveInteger } from "./options.js";

/**
 * Reviews of proposed playlist and screen changes, and of ad creatives. An
 * agent reads them and withdraws its own; only a person decides them, in the
 * dashboard (sellers decide ad creatives with ads reviews).
 */
export function registerReviewsCommands(root: Command, bind: CommandActionBinder): void {
  const reviews = root.command("reviews").description("Read and withdraw changes waiting for a person's review");
  addCommandNotes(reviews, "Under Propose access, or in a project that requires review for agent changes, playlist create and update, screen assign, playlist schedules and takeovers answer pending_review instead of applying: the change waits for a person to approve, reject or ask for changes in the dashboard, and nothing changes on glass until it is approved. The write returns the review id and its dashboard URL. Tell the person it is waiting and give them the URL; do not repeat the write or poll. Check the decision later with reviews show ID; a rejection or a change request carries the person's note in decision_note, so fix the change and propose it again with --note explaining it. A media replace or restore answers pending_review the same way. Media a Propose credential uploads or retags gets its own review (subject type media) when approving it would change what the tag, folder or all selectors of approved playlists or open playlist proposals play. Agents cannot approve playlist or screen reviews.");

  reviews.command("list").description("List reviews, pending first by default")
    .addOption(new Option("--state <STATE>", "pending (default), decided, or all").choices(["pending", "decided", "all"]))
    .addOption(new Option("--kind <KIND>", "Only this kind of review").choices(["playlist_change", "screen_change", "ad_creative"]))
    .option("--limit <N>", "Reviews per page, 1-100 (default 50)", positiveInteger("limit"))
    .option("--cursor <CURSOR>", "Continue from data.next_cursor of the previous page")
    .action(bind(handleReviewsList));

  addCommandNotes(reviews.command("show").description("Inspect one review and its decision")
    .argument("<review-id>", "Review identifier (rvw_ or an ad review id)")
    .action(bind(handleReviewsShow)), "state is pending, approved, rejected, changes_requested, withdrawn, superseded (a newer proposal replaced it) or stale (the live playlist moved on before approval; propose again; a stale media review is replaced by a fresh one within seconds). decision_note is the person's reason or requested changes. A playlist change carries preview.live and preview.proposed; playlist show returns the live version, not the proposal. A media review (subject type media, operation selector_refresh) has no preview: playlist_change.media_change holds the tags (one sorted set) and folder (empty at the library root) before (as last approved; null for a new upload) and after, and playlist_change.media_playlists lists each approved playlist or open playlist proposal whose selection changes, with its screens and the media it starts (media_added) and stops (media_removed) playing; impact.screens adds them up. A media replacement or restore (subject type media, operation media_replace; media replace and media restore under Propose access) has no preview either: playlist_change.media_replace holds the file now in service (before) and the file approving puts in service (after) with content_type, size and sha256, the version it becomes, source (replace or restore), the proposer's note, aspect_changed and the playlists that use the media; impact.screens counts their screens. The media keeps playing its current file until a person approves. A screen change shows blockers, the playlist reviews it waits on with their state now, and after approval result, with applying true while large fleets finish.");

  addCommandNotes(reviews.command("withdraw").description("Withdraw a pending change this credential proposed")
    .argument("<review-id>", "Review identifier")
    .action(bind(handleReviewsWithdraw)), "Withdraws a pending playlist or screen change that this agent or service client proposed; nothing reaches the screens. A withdrawn new playlist stays unapproved.");
}
