import { type Command, Option } from "commander";
import { WEBHOOK_HANDSHAKES, WEBHOOK_VERIFY_ENCODINGS, WEBHOOK_VERIFY_VENDORS, verifyHeaderOption, verifyToleranceOption } from "../webhook-verify.js";
import { requireOptionGroup } from "./notes.js";

/** What the vendor options belong to: the words that name it in their help. */
export interface VerifyOptionsTarget {
  /** Opens each description: "With --card" or "Overlay". */
  scope: string;
  /** The credential the vendor's signature stands in for. */
  secret: string;
}

/**
 * The vendor signature and handshake options of a card webhook and of an overlay
 * trigger, with the relationships between them. update adds the two that remove.
 */
export function addVerifyOptions(command: Command, target: VerifyOptionsTarget, update: boolean): void {
  const { scope, secret } = target;
  command
    .addOption(new Option("--verify <VENDOR>", `${scope}: accept posts that carry this vendor's own signature in place of ${secret}, which keeps working beside it: ${WEBHOOK_VERIFY_VENDORS.join(", ")}`)
      .choices([...WEBHOOK_VERIFY_VENDORS]).conflicts(update ? ["clearVerify"] : []))
    .option("--verify-secret-file <FILE>", `${scope}: read the vendor's secret from this file, or - for stdin (never an argument): the webhook secret GitHub, Stripe, Shopify, Slack, Linear or Vercel shows, or a generic_hmac sender's. asana takes none (its handshake delivers it)`)
    .option("--verify-header <NAME>", `${scope}: with --verify generic_hmac, the header that carries the signature`, verifyHeaderOption("--verify-header"))
    .addOption(new Option("--verify-encoding <ENCODING>", `${scope}: with --verify generic_hmac, how the signature is written (default hex); it may begin with sha256=`).choices([...WEBHOOK_VERIFY_ENCODINGS]))
    .option("--verify-timestamp-header <NAME>", `${scope}: with --verify generic_hmac, a header that carries the Unix time in seconds (or milliseconds, 13 digits); the signed text is then <timestamp>.<body>`, verifyHeaderOption("--verify-timestamp-header"))
    .option("--verify-tolerance <SECONDS>", `${scope}: with --verify-timestamp-header, how far the timestamp may sit from the server's clock, 1 to 86400 (default 300)`, verifyToleranceOption)
    .addOption(new Option("--handshake <VENDOR>", `${scope}: answer the setup challenge of a vendor that has no signature scheme here: ${WEBHOOK_HANDSHAKES.join(", ")} (slack and asana answer theirs through --verify)`)
      .choices([...WEBHOOK_HANDSHAKES]).conflicts(update ? ["clearHandshake"] : []));
  if (update) {
    command
      .addOption(new Option("--clear-verify", `${scope}: stop accepting a vendor's signature and forget its secret`).conflicts(["verify"]))
      .addOption(new Option("--clear-handshake", `${scope}: stop answering the vendor handshake`).conflicts(["handshake"]));
  }
  requireOptionGroup(command, "requires", ["--verify-secret-file", "--verify"]);
  requireOptionGroup(command, "requires", ["--verify-header", "--verify"]);
  requireOptionGroup(command, "requires", ["--verify-encoding", "--verify"]);
  requireOptionGroup(command, "requires", ["--verify-timestamp-header", "--verify"]);
  requireOptionGroup(command, "requires", ["--verify-tolerance", "--verify-timestamp-header"]);
}
