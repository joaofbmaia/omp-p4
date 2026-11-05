# omp-p4

Perforce support for [oh-my-pi](https://github.com/can1357/oh-my-pi), written as an omp extension. omp's own version-control layer only knows git and Jujutsu, so this extension uses omp's extension hooks instead of forking it. Where omp has a built-in feature that only needs the right input (conflict resolution, code review, annotations), the extension feeds it Perforce data rather than reimplementing it.

Outside a Perforce client, or on a machine without `p4`, it does nothing.

## Editing

**Check-out on write.** Depot files are read-only until opened. When omp's `edit` or `write` tool fails with a permission error on one of them, the extension runs `p4 edit` and retries the write. If the check-out fails (exclusive lock held by someone else, file outside the client view), the write fails and the agent is told why. If the file isn't at the head revision, or is open somewhere else, the agent is told that too, so it doesn't build on stale code without saying so.

**Adds and deletes are the agent's call.** Not every file the agent writes belongs in the depot: scratch scripts, notes and generated output don't. So new and deleted files are not opened automatically. The first time `edit` or `write` creates or deletes a file inside a client, the agent is told ("`rtl/x.sv` is new and not in Perforce"), and it opens what belongs in the change with `p4_reconcile`. That notice costs no p4 call: the extension knows from the file system whether the file existed before the tool ran. Changes made by bash are the agent's to open the same way. `/p4-change` still previews `p4 reconcile -n` and offers whatever was left out.

**Edits never wait on p4.** Editing a file that is already open makes no p4 call on the agent's side. Which changelist the file is in (for routing, the footer and the end-of-prompt line) is looked up in the background.

## Changelists

You don't manage changelists unless you want to. Work lands where you'd have put it, you can see where it went, you steer it in plain words, and rewind undoes it.

```
you:   fix the fifo depth bug
       fifo.sv is already in your CL 4711, so the edit stays there; the new fifo_pkg.sv follows it.
       footer: p4 · 4711 fifo depth (3)

you:   also add a testbench for the alu
       nothing to follow, so a changelist is created for the task; the agent describes it when done.
       p4 · new CL 4730 "Add ALU testbench": 2 added

you:   actually put the testbench in my alu CL
       the agent finds 4720 by its description and moves the files; the empty 4730 is deleted.

you:   send both for review
       each changelist gets #review and is shelved; each is its own review.
```

- **Perforce is the record.** A file that is already open stays in its changelist. The extension keeps no separate idea of what belongs where.
- **New files follow the work.** A file the agent checks out or opens with `p4_reconcile` goes to the changelist of the file it last edited. With nothing to follow, a changelist is created for the task when the first file needs it, with your prompt as a provisional description. The agent is asked to replace that with a real one, in the style of your recent submits, once the work in it is done. Nothing ever goes into the default changelist.
- **You steer in words.** "New CL for this", "put it in my fifo CL", "move alu_tb to 4720", "rename that CL" all work through the `p4_change` tool, which finds a changelist by number or by words from its description. Moving files between pending changelists is reversible, so it's reported rather than confirmed. Files the agent just created can be "moved" too: they're opened directly in the named changelist.
- **Your descriptions are yours.** The agent rewrites the descriptions of changelists it created without asking. These are remembered across sessions in `~/.omp/agent/omp-p4.json`, together with the description the agent last set. Once you edit one by hand it counts as yours, and changing it asks you first. In headless runs the agent refuses and asks you in its reply instead.
- **Tidy by default.** Changelists the agent created that end up empty are deleted; ones with shelves are kept.
- **One file, one changelist.** Perforce allows a file in only one pending changelist. If a file needs changes for two separate pieces of work, the agent is told to say so rather than mix them.
- **Shown, not asked.** The footer lists the changelists in play (`p4 · 4711 fifo depth (3) · 4730 alu tb (2)`). A one-line summary appears at the end of a prompt, but only when work went somewhere new. The agent's instructions list the session's changelists too, so "shelve both for review" works without numbers.

**Rewind restores everything.** At the first change of each prompt, the extension records which files are open on the client and in which changelist (one `p4 fstat`). Then each file's content is copied into memory just before its first change. `edit` and `write` name their files; before `bash`, the files open in the session's changelists are copied. Copying stops after 3 s, since a copy taken after the tool starts could hold half-written output. Prompts that change nothing cost nothing. When you rewind with `/branch`, you're offered to put things back as they were at that message, across every changelist:
- files opened later are reverted (added files are removed);
- old contents are written back;
- files moved between changelists go back;
- deleted or reverted files are reopened in their old changelist.
- files the agent created without opening them are removed, and unopened files it changed get their old content back.

The snapshots are local only; nothing is shelved. They last for the omp session, and content beyond 64 MB per prompt isn't kept.

**Search skips build outputs.** omp's grep, glob and find honor `.ignore` and `.gitignore` but not P4IGNORE, so in a large workspace they also walk simulation, synthesis and layout outputs. When there's a P4IGNORE file but no `.ignore`, the footer shows a tip. `/p4 ignore` then generates a `.ignore` at the client root that mirrors your P4IGNORE file and keeps it in sync, and `/p4 ignore off` hides the tip for that client for good. A hand-written `.ignore` is never touched. Add `.ignore` to your P4IGNORE so p4 doesn't see the generated file; the extension's own reconciles already skip it.

**Footer.** Shows the changelists the session works in (`p4 · 4711 fifo depth (3) · 4730 alu tb (2)`), or `p4 · N open` before anything changed, plus `M to resolve` when resolves are pending. It's refreshed in the background, and only after something Perforce-related happened.

**Transcript.** The p4 tools render like omp's own: a one-line summary collapsed (files and +/- counts, opened files by action, resolves left, a review's state and open tasks), and the full output expanded. Diffs use omp's own diff renderer, with word-level highlighting.

**Messages.** Expired tickets ("run `p4 login`") and untrusted SSL servers ("check the fingerprint and run `p4 trust`"; the extension never trusts a server for you) are reported as such, instead of the extension silently doing nothing. In headless `omp -p` runs, messages go to stderr.

**Slow servers and site wrappers.** omp gives up on an extension handler after 30 s, so every handler here waits on p4 for at most 10 s. Past that, the work carries on in the background, and you're told once that Perforce is slow (with a pointer to `OMP_P4_TRACE`). Each p4 call runs in its own process group, and a call that times out is killed along with anything it started. Without that, a site `p4` wrapper script would leave the real p4 running, and the extension would keep waiting for its output.

**Server round trips.** Only `p4 info` blocks startup; the footer and autocomplete data load in the background, and autocomplete refreshes at most every five minutes. Writing to new folders inside a known workspace doesn't repeat `p4 info`. One small task (edit a read-only file, create a file in a new folder) went from 22 p4 calls to 11. Set `OMP_P4_TRACE=<file>` to log every p4 call with its duration.

## Multi-root sessions: Perforce and git together

omp sessions can have several folders (`/add-dir`). They can be any mix of Perforce clients and git repositories, and each folder is handled by its own version control.

- **The nearest version control wins.** A git checkout inside a Perforce client is git. This matters because client roots are often broad (`~` or `/`) and would otherwise claim every repo below them. When git and Perforce share the same root (git-p4, or a local git kept on top of a workspace), Perforce owns it.
- **Per file, not per session.** Check-out on write, reconcile and `/p4-change`'s reconcile preview only touch files Perforce owns. A file the agent writes inside a nested git checkout, or in a git root, is never opened for add, and neither is anything under `.git/`.
- **Re-checked every time.** A repo the agent clones or initializes mid-session is recognized immediately. Asking p4 about a folder costs a server round trip, so "not a Perforce client" answers are cached for five minutes, and files inside a git root never ask at all.
- **Every client.** `p4_opened`, `p4_resolve status`, rewind snapshots, the footer (`p4 · a: 4711 fifo (2) | b: 3 open`) and `.ignore` sync cover every Perforce root. Each client routes its own changelists. Tools given paths or a changelist pick the client that owns them, and `p4_unshelve` takes a `root` when it's ambiguous. `/p4-change` and `/p4-review` ask which client when there are several.
- **The agent is told** which root uses which version control, and to use git in git roots. The p4 tools are hidden while no root is a Perforce client and appear when you `/add-dir` one. `p4://` URLs resolve through the session's client even when the current folder is a git repo.
- **omp's own git features are unchanged.** They follow omp's usual rules, which center on the main folder.

## Agent tools

| Tool | What it does |
|---|---|
| `p4_opened` | Files in the changelists worked in this session, grouped by changelist, or everything open on the client |
| `p4_change` | `list`, `find` (by number or words), `new`, `use` (new files go there), `move` (open or new files), `describe` (asks before changing your own descriptions) |
| `p4_diff` | Unified diffs of opened files, adds and deletes included |
| `p4_changes` | Recent submitted changelists for a path, with full descriptions |
| `p4_describe` | One changelist's description, files and optional diff (`-S` for shelved) |
| `p4_reconcile` | Opens what the agent changed through bash or generators, in the changelist new files follow or a named one |
| `p4_shelve` | Shelves a numbered changelist (`shelve -r`, replacing the previous shelf). `review: true` adds `#review` to the description first (starts a review); `review: <id>` adds `#review-<id>` (joins that review). Reports the review id. Refuses while resolves are pending or conflict markers remain |
| `p4_unshelve` | Brings a shelf into this workspace: your own pending changelist's shelf back into that changelist (so re-shelving updates its review), anyone else's into a new changelist named after it, or `into` a given one |
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

- `/p4`: show each root's version control and the changelists in play, with their files.
- `/p4-change [<n>] [--single] [--shelve] [--review] [instructions]`: split a changelist by topic. Without a number, it uses the changelist new files currently follow.
  1. Previews `p4 reconcile -n` on the current directory and offers to open whatever bash left behind, in that changelist.
  2. Checks for pending resolves and leftover conflict markers. `--shelve` refuses if there are any; otherwise it asks before going on.
  3. Asks the current model, with the conversation as context, to group the files and describe each group. It sees the diffs, your recent submitted descriptions as a style guide, and your other pending changelists. A group that clearly continues one of those joins it instead of becoming a new changelist.
  4. Shows you the plan and waits for your confirmation.
  5. Applies it. The first new group keeps the original changelist number, so shelves and reviews on it stay attached. Other new groups get new changelists, and groups that join yours are moved there. With `--shelve`, every resulting changelist is shelved. With `--review`, new descriptions get `#review` first, and the review each one started is reported. It never submits.

  Splits are by file: Perforce can't put hunks of one file into different changelists. Both halves of a move always land in the same changelist. To enforce a description format, put a template in `.omp/p4-description.md` (or `.p4-description.md`) in the current directory or the client root.
- `/p4-review [<change>] [--all] [--annotate] [focus]`: runs omp's own code-review pipeline (the one behind `/review`) on a Perforce diff.
  - No number: the changelists worked in this session. `--all`: everything open on the client.
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

1. Work with the agent, then ask it to "send this for review" (`p4_shelve` with `review: true` on each changelist). Each gets `#review`, is shelved, and you get its review id. To split a changelist by topic first, use `/p4-change --review`.
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
omp plugin install "github:joaofbmaia/omp-p4#main"
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

Type-checked against omp 18.13.3 and 18.15.0. It loads in omp's RPC mode with all its commands and `p4://` registered. `bun test` runs two suites:

- **Unit tests:** changelist routing (provisional descriptions, the end-of-prompt line, what the agent created across sessions), changelist plans including joins, marker conversion, review sizing, comment formatting, `.ignore` sync, `p4://` parsing and multi-root classification.
- **Live tests** (`test/live.test.ts`): run against a real, throwaway Perforce server (verified with p4/p4d 2026.1). They check out read-only files, open adds, reconcile, diff, take and restore rewind snapshots (including files in your own changelists and moves between changelists), route new files into your changelist and find it by its words, delete empty agent changelists, create changelists, shelve (including `shelve -r` on a never-shelved change), unshelve onto open files, resolve (`-am` and `-af`), convert markers, and resolve `p4://` URLs through omp's own router. Files in a nested git checkout are left alone. The tests skip when `p4`/`p4d` aren't installed, and need nothing beyond `brew install --cask perforce`.
- **Edge-case tests** (`test/live-edge.test.ts`), each with its own throwaway server:
  - **Exclusive-lock (`+l`) files:** the error names who holds the lock.
  - **Stream depots:** check-out, reconcile, shelve, unshelve and diffs in a stream client.
  - **Unicode-mode servers:** no `P4CHARSET` needed, since p4 2026.1 detects the mode itself.
  - **SSL servers:** untrusted fingerprints are reported, and everything works once trusted.
  - **Tickets expiring mid-session.**
  - **Large changelists:** 2,000 files in 0.3 s locally.

  The server uses an `rsh:` port (p4d starts per command, so no daemon and no open port) in a temp folder, with `P4CONFIG`, `P4TICKETS` and `P4ENVIRO` pointed there. A real Perforce setup in your environment is never touched. Recent servers require the first user to have a password, so the tests give the throwaway user a random one and log in; it's never printed or stored.

- **Review-server tests** (`test/live-review.test.ts`, opt-in): verified against P4 Code Review 2026.1. They start a review the team way (`#review` + shelve), add a second changelist to it with `#review-<id>`, find it by changelist and by id, post an inline task, threaded replies and a general comment, mark the task addressed, list your reviews, and resolve `p4://review/<id>` and its diff through omp's router. To run them, point them at a workspace whose `.p4config` user is logged in with `p4 login -a`, plus the review server URL:

  ```sh
  OMP_P4_REVIEW_WS=~/my-ws OMP_P4_REVIEW_URL=http://review.example.com bun test test/live-review.test.ts
  ```

  Each run works under its own `//depot/omp-p4-test/<run>/` folder and creates one review.

- **Full omp sessions** (`omp -p` with a real model against a throwaway server, a user changelist "ALU: saturating adds" holding `alu.sv`):
  1. Editing `alu.sv` and creating `alu_pkg.sv`: both ended up in the user's changelist.
  2. Then, in a new session, editing the read-only `fifo.sv` and adding a testbench: a changelist was created for the task, and the agent replaced the provisional description.
  3. "The testbench should be its own changelist; add `fifo_if.sv` to my saturating adds CL": both landed where asked.
  4. A file created before "start a new changelist" stayed in its own changelist.
  5. Renaming a changelist the agent created in an earlier session went through; renaming the user's own was refused until confirmed.

  Earlier, a run checked out a read-only depot file and opened a new file for add at the end of the turn.

  That run also found a bug: omp reports the session folder as given (`/tmp/…`), while Perforce reports the client root with symlinks resolved (`/private/tmp/…`), so new files weren't recognized as depot files. All path comparisons now resolve symlinks first, which also covers client roots under symlinked or automounted folders.

**Still unverified:**

- **Reconciling a moved file** opens an add plus a delete rather than a paired move. Both submit fine.

## Known gaps

- New and deleted files are opened only when the agent decides to. If it forgets one, `/p4-change`'s reconcile preview or a `p4 reconcile -n` finds it before submit.
- Formatter writes made by an LSP subprocess, such as Biome's, bypass omp's write hook. Run `/p4-change` or `p4 reconcile` afterwards.
- Concurrent omp sessions on the same client each create their own changelists; they don't know about each other's until a file is open in one.
- In headless `omp -p` runs, a changelist the agent created but never put a file in can be left behind, since the process exits right after the prompt.
- Upgrading from 0.1: an existing `[omp-work]` changelist is left as it is. Its files stay there, and new files follow it once the agent edits one of them. Split or rename it with `/p4-change <n>`.
- In a multi-root session, a root added with `/add-dir` shows up in the system note and tools on the next prompt, not instantly.
- Rewind snapshots live in memory, so they don't survive restarting omp. Only `/branch` rewinds restore files, not `/tree` navigation.
