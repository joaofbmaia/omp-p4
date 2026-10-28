# omp-p4

Perforce support for [oh-my-pi](https://github.com/can1357/oh-my-pi), written as an omp extension. omp's own version-control layer only knows git and Jujutsu, so this extension uses omp's extension hooks instead of forking it. Where omp has a built-in feature that only needs the right input (conflict resolution, code review, annotations), the extension feeds it Perforce data rather than reimplementing it.

Outside a Perforce client, or on a machine without `p4`, it does nothing.

## Editing

**Check-out on write.** Depot files are read-only until opened. When omp's `edit` or `write` tool fails with a permission error on one of them, the extension runs `p4 edit` and retries the write. If the check-out fails (exclusive lock held by someone else, file outside the client view), the write fails and the agent is told why. If the file isn't at the head revision, or is open somewhere else, the agent is told that too, so it doesn't build on stale code without saying so.

**Adds, deletes and moves.** Files that `edit`/`write` created, removed or moved are opened with a single `p4 reconcile` at the end of each turn, rather than one server round trip per edit. Anything that needs p4 to be current (the tools below, `/p4-change`, rewind snapshots) reconciles first. Files covered by your P4IGNORE are skipped.

**Files changed by bash.** After a bash command that looks like it writes files (redirects, `mv`/`cp`/`rm`, `sed -i`, scripts and generators; not `grep` or `ls`), a quick `p4 reconcile -n` of the command's folder and the paths it names shows what Perforce doesn't know about yet. The agent is told and decides what belongs in the change; nothing is opened automatically, because build outputs belong in P4IGNORE rather than the changelist.

**One work changelist.** Everything the agent opens goes into a single pending changelist tagged `[omp-work]`. There's one per client, created the first time the agent opens a file. Files you already have open stay where they are.

**Rewind restores code.** Just before the first edit, write or bash command of each prompt, the content of the files open in the work changelist is copied into memory. Prompts that change nothing cost nothing. When you rewind with `/branch`, you're offered to put the files back as they were at that message. Files opened later are reverted, and files that were open have their old content written back. The snapshots are local only; nothing is shelved. They last for the omp session and are skipped if the changelist holds more than 64 MB.

**Search skips build outputs.** omp's grep, glob and find honor `.ignore` and `.gitignore` but not P4IGNORE, so in a large workspace they also walk simulation, synthesis and layout outputs. When there's a P4IGNORE file but no `.ignore`, the footer shows a tip. `/p4 ignore` then generates a `.ignore` at the client root that mirrors your P4IGNORE file and keeps it in sync, and `/p4 ignore off` hides the tip for that client for good. A hand-written `.ignore` is never touched. Add `.ignore` to your P4IGNORE so p4 doesn't see the generated file; the extension's own reconciles already skip it.

**Footer.** Shows `p4 <client> · N open · M to resolve`. It's refreshed in the background, and only after something Perforce-related happened.

**Transcript.** The p4 tools render like omp's own: a one-line summary collapsed (files and +/- counts, opened files by action, resolves left, a review's state and open tasks), and the full output expanded. Diffs use omp's own diff renderer, with word-level highlighting.

**Messages.** Expired tickets ("run `p4 login`") and untrusted SSL servers ("check the fingerprint and run `p4 trust`"; the extension never trusts a server for you) are reported as such, instead of the extension silently doing nothing. In headless `omp -p` runs, messages go to stderr.

**Server round trips.** Only `p4 info` blocks startup; the footer and autocomplete data load in the background, and autocomplete refreshes at most every five minutes. Writing to new folders inside a known workspace doesn't repeat `p4 info`. One small task (edit a read-only file, create a file in a new folder) went from 22 p4 calls to 11. Set `OMP_P4_TRACE=<file>` to log every p4 call with its duration.

## Multi-root sessions: Perforce and git together

omp sessions can have several folders (`/add-dir`). They can be any mix of Perforce clients and git repositories, and each folder is handled by its own version control.

- **The nearest version control wins.** A git checkout inside a Perforce client is git. This matters because client roots are often broad (`~` or `/`) and would otherwise claim every repo below them. When git and Perforce share the same root (git-p4, or a local git kept on top of a workspace), Perforce owns it.
- **Per file, not per session.** Check-out on write, reconcile and `/p4-change`'s reconcile preview only touch files Perforce owns. A file the agent writes inside a nested git checkout, or in a git root, is never opened for add, and neither is anything under `.git/`.
- **Re-checked every time.** A repo the agent clones or initializes mid-session is recognized immediately.
- **Every client.** `p4_opened`, `p4_resolve status`, rewind snapshots, the footer (`p4 a · 2 open | b · 1 open`) and `.ignore` sync cover every Perforce root. Tools given paths or a changelist pick the client that owns them, and `p4_unshelve` takes a `root` when it's ambiguous. `/p4-change` and `/p4-review` ask which client when there are several.
- **The agent is told** which root uses which version control, and to use git in git roots. The p4 tools are hidden while no root is a Perforce client and appear when you `/add-dir` one. `p4://` URLs resolve through the session's client even when the current folder is a git repo.
- **omp's own git features are unchanged.** They follow omp's usual rules, which center on the main folder.

## Agent tools

| Tool | What it does |
|---|---|
| `p4_opened` | Files in the work changelist, or everything open on the client |
| `p4_diff` | Unified diffs of opened files, adds and deletes included |
| `p4_changes` | Recent submitted changelists for a path, with full descriptions |
| `p4_describe` | One changelist's description, files and optional diff (`-S` for shelved) |
| `p4_reconcile` | Opens what the agent changed through bash or generators |
| `p4_shelve` | Shelves a numbered changelist (`shelve -r`, replacing the previous shelf). `review: true` adds `#review` to the description first (starts a review); `review: <id>` adds `#review-<id>` (joins that review). Reports the review id. Refuses while resolves are pending or conflict markers remain |
| `p4_unshelve` | Brings a shelf (yours or a colleague's) into the work changelist (`unshelve -s <n> -c <work>`) |
| `p4_resolve` | `status`, `auto` (`-am`), `markers` (`-af`), `theirs` (`-at`), `yours` (`-ay`); `redo` re-resolves (`-f`) |
| `p4_review_comments` | A P4 Code Review review: state, votes, comments with file:line, open tasks first, replies threaded |
| `p4_review_reply` | Reply to a comment, comment on a file line, or add a general comment or task |
| `p4_review_task` | Mark a task addressed, or reopen it |

A note in the system prompt tells the agent it's in a Perforce client and not to use git, and explains the flows below. Nothing is blocked: the agent can shelve, submit and post review comments when asked, subject to omp's normal approval settings. The review tools are marked as writes, and the agent is told to post only when you asked, since posts appear under your name.

## `p4://` URLs

The Perforce counterpart of omp's `pr://`. The agent can `read` these URLs, and you can type them in prompts ("fix the open tasks in p4://review/4521"), where they autocomplete.

| URL | Returns |
|---|---|
| `p4://12345` | Description, status, author and files of any changelist: pending, shelved or submitted |
| `p4://12345/diff` | Its diff: the shelf if pending, the submitted revisions otherwise |
| `p4://review/4521` | A P4 Code Review review: state, votes, threaded comments, open tasks |
| `p4://review/4521/diff` | The diff of the review's latest version |
| `p4://depot/main/rtl/fifo.sv#5` | A depot file at any revision (`#5`, `@12345`, `@=12345`, `#head`), branch or stream, **without syncing** |
| `p4://depot/main/rtl/` | A folder listing, with links to follow |

A depot path is Perforce syntax with `p4:` in front. Perforce forbids purely numeric depot names, so a leading number is always a changelist. Line ranges work as on files: `read p4://depot/main/rtl/fifo.sv#5:10-40`. File content is returned exactly as stored, so line numbers match the file. Specific revisions are cached as unchanging; `#head` is re-read each time.

Autocomplete offers your pending changelists, your open reviews and the depot roots. The list is refreshed at session start and after each turn, not on every keystroke.

omp has no extension API for URL schemes, so `p4://` is registered on omp's internal URL router, the one behind `pr://` and `conflict://`. If a future omp moves that router, `p4://` silently stops working and the rest of the extension carries on. If omp ever ships its own `p4://`, the built-in wins.

## Commands

- `/p4`: show the client, the work changelist and its files.
- `/p4-change [--single] [--shelve] [--review] [instructions]`: turn the work changelist into described pending changelists.
  1. Previews `p4 reconcile -n` on the current directory and offers to open whatever bash left behind.
  2. Checks for pending resolves and leftover conflict markers. `--shelve` refuses if there are any; otherwise it asks before going on.
  3. Asks the current model, with the conversation as context, to group the files and write descriptions. It sees the diffs and your recent submitted descriptions as a style guide.
  4. Shows you the plan and waits for your confirmation.
  5. Creates the changelists and moves the files in. With `--shelve`, it also shelves each one. With `--review`, it also adds `#review` to each description before shelving, then reports the review each one started. It never submits.

  Splits are by file: Perforce can't put hunks of one file into different changelists. Both halves of a move always land in the same changelist. To enforce a description format, put a template in `.omp/p4-description.md` (or `.p4-description.md`) in the current directory or the client root.
- `/p4-review [<change>] [--all] [--annotate] [focus]`: runs omp's own code-review pipeline (the one behind `/review`) on a Perforce diff.
  - No number: the agent's work changelist. `--all`: everything open on the client.
  - A number: that shelf if it's pending, or that change if it's submitted.
  - If the change is in a P4 Code Review review, the existing discussion is passed along so the review doesn't repeat it.
  - omp caps a review at 20 files and 50k characters. Larger diffs are cut to the highest-priority files (RTL and code before docs and tests), and you're asked first.
  - `--annotate` opens omp's diff annotation overlay instead, where you leave line comments for the agent.
- `/p4-review-fix <review | change>`: fetches a review's open tasks and asks the agent to address them. It unshelves if needed, fixes, then shows you a summary and **waits for your go-ahead** before re-shelving, marking tasks addressed or replying.

## P4 Code Review (formerly Swarm)

The server URL comes from the `P4.Swarm.URL` property that P4 Code Review registers on your Perforce server; set `OMP_P4_REVIEW_URL` to override it. Authentication uses your p4 user and existing ticket from `p4 tickets`, so there's no separate login. If the review server runs on a different host from where you logged in, the ticket must be host-unlocked: `p4 login -a`.

Reads use REST API v9, which every server since Swarm 2019 offers. Posting is split by what each API version can do:

- **Inline comments** go through v9, which fills in the file context itself.
- **General comments and replies** go through v11 when the server has it (2022.2+). v9 needs a file on every comment, so it can't reply to a general comment.

**Reviews are only started the team way:** a changelist whose description contains `#review` is shelved, and P4 Code Review opens a review for it; `#review-<id>` adds the changelist to review `<id>` instead. Re-shelving a changelist that's already in a review updates the review. The extension never calls the "create review" API.

An inline comment made right after a review is created waits briefly for the server to finish processing the review; P4 Code Review 2026.1 otherwise fails with an HTTP 500.

A typical pre-submit review:

1. Work with the agent, then `/p4-change --review`. Each changelist gets `#review`, is shelved, and you get its review id. Or ask the agent to "shelve 12345 for review" (`p4_shelve` with `review: true`).
2. To put a follow-up changelist into the same review, ask the agent to shelve it into review 4521 (`#review-4521`).
3. When comments come in: `/p4-review-fix 12345`. Re-shelving updates the review.
4. To review a colleague's shelf: `/p4-review 12346`, or `--annotate` to go through it yourself.

## Conflicts

Resolves come from `p4 sync`, `p4_unshelve` onto files you have open, or integrations.

1. `p4_resolve auto` accepts every clean merge (`p4 resolve -am`).
2. `p4_resolve markers` accepts the remaining conflicts with markers in the file (`-af`). The extension then rewrites Perforce's markers (`>>>> ORIGINAL`, `==== THEIRS`, `==== YOURS`, `<<<<`) into git's 3-way format (`<<<<<<<`, `|||||||`, `=======`, `>>>>>>>`).
3. That lets omp's built-in conflict handling take over. `read` lists each block as `conflict://<id>`, and the agent resolves it with `write conflict://<id>`, writing merged code or using the `@ours`, `@theirs`, `@base` and `@both` shortcuts. Ours is YOURS (your workspace); theirs is the incoming revision or shelf.
4. Binary, filetype, move and delete resolves use `theirs` or `yours`. The agent is told to say which it picked.
5. `p4_resolve status` must show nothing pending and no markers before shelving.

Perforce records a resolve accepted with markers as resolved, which is why shelving and `/p4-change` also scan for leftover markers.

## Install

From GitHub:

```sh
omp plugin install github:joaofbmaia/omp-p4
omp plugin upgrade omp-p4   # later, to pull the latest commit
```

From a local checkout, for development:

```sh
mkdir -p ~/.omp/agent/extensions
ln -s ~/Documents/GitHub/omp-p4 ~/.omp/agent/extensions/p4
```

To load it for one run only: `omp -e ~/Documents/GitHub/omp-p4/index.ts`.

Requires `p4` on `PATH`, a client configured for the directory (`P4CONFIG`, `P4CLIENT`, …) and a valid ticket. When a ticket expires mid-session, p4 errors tell you to run `p4 login`. For an SSL server, trust its fingerprint once with `p4 trust`.

## Status

Type-checked against omp 18.12.5. It loads in omp's RPC mode with all its commands and `p4://` registered. `bun test` runs two suites:

- **Unit tests:** changelist plans, marker conversion, review sizing, comment formatting, `.ignore` sync, `p4://` parsing and multi-root classification.
- **Live tests** (`test/live.test.ts`): run against a real, throwaway Perforce server (verified with p4/p4d 2026.1). They check out read-only files, open adds, reconcile, diff, take and restore rewind snapshots, create changelists, shelve (including `shelve -r` on a never-shelved change), unshelve onto open files, resolve (`-am` and `-af`), convert markers, and resolve `p4://` URLs through omp's own router. Files in a nested git checkout are left alone. The tests skip when `p4`/`p4d` aren't installed, and need nothing beyond `brew install --cask perforce`.
- **Edge-case tests** (`test/live-edge.test.ts`), each with its own throwaway server:
  - **Exclusive-lock (`+l`) files:** the error names who holds the lock.
  - **Stream depots:** check-out, reconcile, shelve, unshelve and diffs in a stream client.
  - **Unicode-mode servers:** no `P4CHARSET` needed, since p4 2026.1 detects the mode itself.
  - **SSL servers:** untrusted fingerprints are reported, and everything works once trusted.
  - **Tickets expiring mid-session.**
  - **Large changelists:** 2,000 files in 0.3 s locally.
  - **Bash changes:** files a command changed are detected, without scanning unrelated folders.

  The server uses an `rsh:` port (p4d starts per command, so no daemon and no open port) in a temp folder, with `P4CONFIG`, `P4TICKETS` and `P4ENVIRO` pointed there. A real Perforce setup in your environment is never touched. Recent servers require the first user to have a password, so the tests give the throwaway user a random one and log in; it's never printed or stored.

- **Review-server tests** (`test/live-review.test.ts`, opt-in): verified against P4 Code Review 2026.1. They start a review the team way (`#review` + shelve), add a second changelist to it with `#review-<id>`, find it by changelist and by id, post an inline task, threaded replies and a general comment, mark the task addressed, list your reviews, and resolve `p4://review/<id>` and its diff through omp's router. To run them, point them at a workspace whose `.p4config` user is logged in with `p4 login -a`, plus the review server URL:

  ```sh
  OMP_P4_REVIEW_WS=~/my-ws OMP_P4_REVIEW_URL=http://review.example.com bun test test/live-review.test.ts
  ```

  Each run works under its own `//depot/omp-p4-test/<run>/` folder and creates one review.

- **A full omp session** (`omp -p` with only the read/edit/write tools, against the review setup's Perforce server). The model edited a read-only depot file, which was checked out into the work changelist, and created a new file, which was opened for add at the end of the turn.

  That run also found a bug: omp reports the session folder as given (`/tmp/…`), while Perforce reports the client root with symlinks resolved (`/private/tmp/…`), so new files weren't recognized as depot files. All path comparisons now resolve symlinks first, which also covers client roots under symlinked or automounted folders.

**Still unverified:**

- **Reconciling a moved file** opens an add plus a delete rather than a paired move. Both submit fine.

## Known gaps

- Files changed by bash are reported to the agent, not opened automatically; a command that writes outside its own folder without naming the path isn't seen until `/p4-change`.
- Formatter writes made by an LSP subprocess, such as Biome's, bypass omp's write hook. Run `/p4-change` or `p4 reconcile` afterwards.
- Every concurrent omp session on the same client shares one work changelist.
- In a multi-root session, a root added with `/add-dir` shows up in the system note and tools on the next prompt, not instantly.
- Rewind snapshots live in memory, so they don't survive restarting omp. Only `/branch` rewinds restore files, not `/tree` navigation.
