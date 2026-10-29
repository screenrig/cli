// Command handlers for the agent-notes commands, loaded on demand.
import { readAuthoringText } from "../authoring-input.js";
import { flagBool, flagString, type ParsedArgs } from "../command-input.js";
import { ApiClient, requireToken } from "../client.js";
import { ExitCode } from "../exit-codes.js";
import { usageError } from "../problems.js";
import type { CliRuntime } from "../runtime.js";
import { NOTE_INPUT_MAX_BYTES, NOTE_MATCHED_OPEN, NotesApi, matchedOpenNote, noteBody, noteDetailLines, noteId, noteListLines, noteReason, parseNoteAbout, parseNoteTtl, reviewWarning, type Note, type NoteList, type NoteState } from "../agent-notes.js";
import { clientFor, commandHandler, jsonBody, requireFlagValue, type ResolvedCommandConfig } from "../commands.js";


export function notesFor(runtime: CliRuntime, args: ParsedArgs, resolved: ResolvedCommandConfig): { client: ApiClient; notes: NotesApi } {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  return { client, notes: new NotesApi(client) };
}

export const handleNotesList = commandHandler(async (args, runtime, resolved) => {
  requireFlagValue(args, "limit", "50");
  requireFlagValue(args, "after", "CURSOR");
  const state: NoteState = flagBool(args.flags, "all") ? "all" : flagBool(args.flags, "resolved") ? "resolved" : "open";
  const about = flagString(args.flags, "about");
  const { client, notes } = notesFor(runtime, args, resolved);
  const response = await notes.list({
    // Open is the server's default.
    ...(state === "open" ? {} : { state }),
    aboutId: about === undefined ? undefined : parseNoteAbout(about).id,
    authorId: flagString(args.flags, "author"),
    after: flagString(args.flags, "after"),
    limit: flagString(args.flags, "limit"),
  });
  const list = (response.body ?? {}) as NoteList;
  const review = reviewWarning(list);
  return {
    envelope: jsonBody(response, client.requestId, undefined, review ? [review] : []),
    exitCode: ExitCode.Success,
    human: noteListLines(list, runtime.now(), state).join("\n"),
  };
});

export const handleNotesShow = commandHandler(async (args, runtime, resolved) => {
  const id = noteId(args.positionals[2], "show");
  const { client, notes } = notesFor(runtime, args, resolved);
  const response = await notes.show(id);
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: noteDetailLines(response.body as Note, runtime.now()).join("\n") };
});

export const handleNotesAdd = commandHandler(async (args, runtime, resolved) => {
  const text = args.positionals[2];
  const file = flagString(args.flags, "file");
  if ((text === undefined) === (file === undefined)) {
    throw usageError("notes add takes the note as TEXT, - for stdin, or --file FILE; supply exactly one.");
  }
  const source = file ?? (text === "-" ? "-" : undefined);
  const body = noteBody(source === undefined ? text! : await readAuthoringText(source, runtime, NOTE_INPUT_MAX_BYTES));
  const about = flagString(args.flags, "about");
  const ttl = flagString(args.flags, "ttl");
  const replaces = flagString(args.flags, "replaces");
  const { client, notes } = notesFor(runtime, args, resolved);
  const response = await notes.add({
    body,
    ...(about !== undefined ? { about: parseNoteAbout(about) } : {}),
    ...(ttl !== undefined ? { ttlSeconds: parseNoteTtl(ttl) } : {}),
    ...(replaces !== undefined ? { replaces } : {}),
  });
  const note = response.body as Note;
  const matched = matchedOpenNote(response);
  const message = matched
    ? `Matched open note ${note.id}; confirmed it.`
    : `Added note ${note.id}.${replaces ? ` ${replaces} is resolved as replaced.` : ""}`;
  return {
    envelope: jsonBody(response, client.requestId, undefined, matched ? [{ code: NOTE_MATCHED_OPEN, message }] : []),
    exitCode: ExitCode.Success,
    human: message,
  };
});

export const handleNotesConfirm = commandHandler(async (args, runtime, resolved) => {
  const id = noteId(args.positionals[2], "confirm");
  const { client, notes } = notesFor(runtime, args, resolved);
  const response = await notes.confirm(id);
  const reviewAt = (response.body as Note | undefined)?.review_at;
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: `Confirmed ${id}.${reviewAt ? ` Next review ${reviewAt}.` : ""}` };
});

export const handleNotesResolve = commandHandler(async (args, runtime, resolved) => {
  const id = noteId(args.positionals[2], "resolve");
  const reason = noteReason(args.positionals.slice(3).join(" "));
  const { client, notes } = notesFor(runtime, args, resolved);
  const response = await notes.resolve(id, reason);
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: `Resolved ${id}.` };
});
