# pi-scout-research

Scout provides a portable Pi research skill, source snapshots and private briefs. Its optional Docker worker lets an agent delegate a public research question through one tool, `scout_research`. Released under MIT.

The skill does not depend on Principal, pi-daddy or skill-harness. Those packages can use Scout through normal Pi tool discovery and governance. The connector declares Pi 1.4.0 or later and Node 24 or later. Retained scripted native checks cover exact Pi 1.4.0 and 1.5.2 on Node 24.19.0; they do not qualify every later Pi version or live model quality. The worker pins Pi 1.4.0, Node 24.19.0 and pi-web-access 0.38.0.

To set up all five packages and resume a task across Pi sessions, follow the [Pi ecosystem quickstart](https://github.com/mojomanyana/pi-daddy#start-here).

## Use from Pi

With Pi and Docker running on the same computer, install Scout:

```bash
pi install npm:pi-scout-research
```

Start Pi, or `/reload` an idle Pi session after installation, and ask Scout a public research question. No environment variables or separate build command are required. On first use, Scout finds Docker, prepares its worker from the installed package and shows progress. Later requests reuse the matching image. An update rebuilds only when Docker build inputs change. Concurrent sessions share preparation instead of launching duplicate builds.

The first preparation downloads the pinned Node/Pi/web runtime and npm dependencies, which can take a few minutes. Docker must already be installed and running; Scout does not install Docker, start shared services or alter system settings. If Docker is unavailable, the tool explains what is missing. It does not fall back to host web access. The npm package contains the complete build context and lockfile; neither a Git checkout nor OpenShell is needed. No Docker image is published separately.

Choose your normal Pi model. Ask, for example: “Use Scout to compare the current Node.js support policies for these two public libraries. Give me the relevant sources and uncertainty.” No special skill sequence is required. Scout captures the parent's selected model and thinking level at dispatch. Each model turn uses Pi's native provider/authentication support in the parent and consumes its normal usage allowance. Credentials stay outside the container.

The tool accepts `question`, `scope` and optional `sourceUrls`. Send public material only. If you already know the relevant official documentation pages, provide up to six unique HTTPS URLs (each at most 2,000 characters after URL encoding, without credentials, spaces, control characters or fragments). With supplied URLs, the current worker limits research to those pages and the supplied catalog. It reads each applicable URL once, selects exact passages from up to 2 MiB of returned text per page, and shares a six-model-call budget across the request. Citation line numbers are local to the retained passage. The saved brief records unread pages and explicit release mismatches. For open-ended discovery, omit the URL list. A supplied URL does not verify publisher identity. Offline mode does not accept public source URLs or fetch them.

Scout saves a private brief under `~/.pi-scout-research/briefs/` and returns its saved path, exact reference and cleanup confirmation. A returned result may be complete or incomplete: retained partial findings and gaps remain useful without claiming the research question was answered. `PI_SCOUT_BRIEFS` can select another operator-owned root. Current-branch references are restored into Pi context after reload or compaction; brief bodies are retrieved only when needed. Notes from abandoned branches are not selected. Briefs are evidence, not approval or training labels.

WSL automatically uses Docker Desktop's Windows client when the Linux client is missing or is the WSL integration placeholder. If an existing Docker client cannot reach its daemon, Scout reports that problem rather than choosing another daemon. Advanced operator overrides remain available:

```bash
export PI_SCOUT_DOCKER_PATH='/mnt/c/Program Files/Docker/Docker/resources/bin/docker.exe'
export PI_SCOUT_DOCKER_HOST='npipe:////./pipe/dockerDesktopLinuxEngine'
```

`PI_SCOUT_WORKER_MODE=offline` disables worker web access. Public mode is the default. On the next research request Scout automatically prepares the worker matching the installed package's sources. To prewarm it, run `scout-worker-build` from that same installation. If you set `PI_SCOUT_WORKER_IMAGE=sha256:...`, rebuild from the updated package's Dockerfile and select the new immutable image ID, or unset the override to use automatic preparation. These settings must be present in Pi's environment.

Scout's `scout_research` implementation runs in the Pi session where Scout is loaded; no Docker command or image parameter is supplied by the model, and that session owns its worker lifecycle. A governed child can call it only when Daddy explicitly offers a parent-run tool for that delegation. Daddy's parent-tool proxy runs the real tool in the root session; it does not install Scout in the child. The proxy requires a callable parent tool and a supported host connection, and currently supports a direct child using the root's provider and model. It cannot be passed through another child. Permission alone does not supply a missing tool or proxy.

The optional `scout-public` skill is narrow guidance for that one tool and declares only `scout_research`. Use it inline (`/skill:scout-public`) wherever that tool is callable, or delegate it when Daddy reports the parent-run tool as available for the selected child. Use actual capability information, not the package version or the parent's tool catalog alone. On hosts without that route, including the tested pi-daddy 0.59.1, the parent or coordinator calls Scout and gives the findings and exact brief reference to Investigate, Architect, Decide or another role. Include the findings it needs: a research proxy does not give the child `scout_brief_read`, so the reference alone may not be readable there. Existing role tool restrictions remain; no Principal dependency is introduced.

## Use with the rest of the ecosystem

Start with the product question and existing evidence. A coordinator can retrieve a
selected Bookie record to recover scope or a prior finding, then use Scout only for
the external fact that remains unresolved. For example, checking an SDK's current
upload limit needs the public SDK/version and question, not the private handoff or
the whole repository. Keep returned source and brief references available for the
smallest relevant follow-up; recheck applicability when the question changes.

When research is incomplete, carry its exact brief reference, incomplete status
and unresolved reason into the product handoff. Reuse supported findings that still apply, and address
the missing evidence instead of repeating the whole investigation. A dependent
requirement stays open until its required evidence is available; a saved brief
alone does not satisfy it. Identify which missing facts block which requirements
and which independent work is already authorized. Preserve explicit user stop
conditions and evidence gates; explain a proposed narrower next step rather than
silently overriding a gate.

Harness's optional `jev_advice` may help the parent assess whether that proposed
lookup is useful when workflow advice is already enabled. It does not select tools
automatically, supply access, approve a result or replace evidence. The `scout-public`
skill still declares only `scout_research` and adds no Bookie or JEV capability; used
inline it is guidance and does not restrict the parent session's other tools. Scout
runs in the parent session and confirms its own worker cleanup. Daddy owns delegation
and cleanup of the roles that receive the result, and Principal (or another role package)
owns the product decision. No extra component is required for ordinary Scout use.

## Modes and limits

- `public`: standard Docker isolation with outbound networking. Keyless Exa discovery and public HTTPS fetch use the pinned reference engine. No browser login, cookies, remote extraction, JavaScript rendering or additional model summary is configured. Search output is a lead; important claims need an original source.
- `offline`: Docker networking is disabled. Optional `PI_SCOUT_CATALOG` supplies selected source snapshots. The model connection still runs through the parent, so selected inputs go to its provider. Offline refers to worker web access, not provider confidentiality.

**Public search.** Set `BRAVE_API_KEY` on the Pi host to use Brave first for the
original public question. A supplied URL goes directly to fetch. Without a usable
key or eligible question, discovery uses keyless Exa. Exa can also supply leads
if Brave is unavailable. Use `PI_SCOUT_SEARCH_PROVIDER=exa` for Exa only.
The existing `PI_SCOUT_SEARCH_FALLBACK=brave` setting keeps Exa first and Brave
as fallback. Set `PI_SCOUT_SEARCH_PROVIDER=brave` to override that older setting.
Brave receives the original public question within its [documented query limits](https://api-dashboard.search.brave.com/api-reference/web/search/get) of 600 characters and 75 words.
The search may consume your Brave quota. Scope, catalog text, worker-generated
queries and the model conversation stay outside this request. Five HTTPS leads
can be returned. The worker must fetch the underlying page to cite a supported
finding. Each research request can make at most one Brave call. Offline work never
uses public discovery. Brave-first requires an updated host package and worker
image. An earlier compatible worker/host pair retains its previous search order.

Both use an immutable image ID, UID 1000, read-only root, no host mounts or Docker socket, dropped capabilities, no new privileges, 1 GiB RAM without additional container swap, 2 CPUs and 128 PIDs. Two 128 MiB temporary filesystems hold ephemeral work. One worker may run per parent Pi session. A 20-minute process watchdog and bounded transport prevent indefinitely running or unbounded-output workers; no time/token instructions are added to the model prompt. Snapshots total at most 1 MiB, with at most 131,072 characters per source. Large, authenticated or dynamic pages may be unavailable.

The parent checks the effective Docker configuration, validates source identities and brief citations, waits for settlement and verifies removal before returning success. Cancellation attempts owned-container cleanup. Unconfirmed cleanup or an unsettled model request blocks another launch in that parent session. A forcibly killed parent can leave a stopped container after the worker's independent watchdog expires. Cleanup is not crash-proof.

**Public mode does not guarantee that every outbound URL, redirect or query is approved.** It does not enforce confidentiality of supplied text. OpenShell is not required. Strict protected online mode remains separate and unqualified. See [SECURITY.md](SECURITY.md).

## Incomplete research and failures

Research can return useful evidence without resolving the whole question. Scout
marks a result `incomplete` when the brief has gaps, unverified claims, no
findings, or a rejected final update. A result without those conditions is `complete`, but that label does not
independently verify the model's interpretation or approve a product decision.
The caller should state what is usable, what is missing and the smallest next
check. Source search and direct fetching are separate capabilities: a failed
search need not prevent fetching an already-known official page within the
agreed scope.

Brief validation gives the worker bounded correction guidance for field limits,
source IDs, line ranges, exact quotations and size constraints. It must preserve
the supplied question and scope. If the model ends normally without saving a
valid brief, Scout retains an explicitly incomplete receipt with gaps and the exact
unassessed source locators that fit. Full source snapshots remain in the original
tool result; the receipt does not retain them. It does not turn unvalidated answer
text into findings. If a later brief update was rejected, Scout preserves the
earlier valid draft unchanged and records that issue alongside its reference.
Carry this incomplete status and reason with the reference when handing work off:
the older draft alone does not describe the rejected update.
Provider errors, cancellation and unconfirmed cleanup remain execution failures,
not recovered research. Retention never relaxes session, branch or destination
checks.

Scout returns a failed tool result with a short explanation, a next step, and the
cleanup state. It saves the same bounded diagnostic in the current Pi session as
`scout-worker-failure-v1`; this is a failure record, not a completed brief. It
distinguishes setup, model, source, evidence, result and cleanup failures where the
origin is known. Older explicitly selected worker images may only provide an
unclassified failure. Automatic setup rebuilds when the packaged worker changes.

A known Docker connection failure during setup, before the research worker starts
and with no cleanup block, explicitly reports that no worker cleanup is needed for
that attempt. Its receipt keeps `cleanup: 'unknown'` for compatibility and adds
`workerStarted: false`; it does not confirm cleanup of earlier work. Once the selected
Docker connection is reachable, a deliberate retry through the normal tool may
proceed within the authorized scope. This does not apply to other setup failures
or unsettled setup, worker or model requests.

Earlier search/fetch failures may be listed separately when a later step fails.
They can be recovered during research and do not prove the final failure's cause.
Unknown causes remain unknown. There are no automatic worker retries or host-tool fallbacks.
Compatible workers send only newly appended conversation messages after the host
acknowledges their context, avoiding repeated-prefix traffic while keeping the
existing output and frame bounds. `FRAME_LIMIT` identifies a single frame/context
limit; `OUTPUT_LIMIT` identifies cumulative worker output. Safe diagnostics include
numeric traffic counters, not captured prompts or provider error bodies.
Successful and failed tool results retain host-observed model usage, including
explicit unmeasured or pending calls. These counters are separate from the worker's
session totals and must not be added together. They do not measure billed cost or
prefill/decode speed. See [worker transport and usage](docs/worker-transport.md).
Unconfirmed cleanup or model settlement continues to block another worker.

The parent `research_sources` list describes its local configured sources. It is
separate from sources discovered inside `scout_research`. An empty local list is
valid and does not establish why a public worker failed.

Failure diagnostics contain static categories and lifecycle facts; brief correction
guidance identifies the invalid field and an allowed correction. Neither forwards
raw exception text, provider responses, credentials, query text or command arguments.
If the session changes before failure, diagnostics are withheld from the new branch.

## Portable skill and local sources

`/skill:research` works without Docker using available Pi research tools. Installing the package alone does not isolate host tools. The `scout_research` tool always uses its Docker worker and prepares it automatically; Docker errors do not silently enable host web access.

When pi-daddy manages a task, starting the worker or fetching an uncached approved web page uses its shared admission and cancellation controls. A read of saved source lines needs no new allowance. Simultaneous requests for the same page on one branch share one fetch; a late result cannot add that page to another branch. A saved brief retains its own hash and coverage under the originating task.

The local extension provides `research_sources`, `research_read` and `research_brief`. Prepare a catalog with `npx --yes --package=pi-scout-research@0.3.0 scout-catalog approved-sources.json new-catalog.json`. The input is an explicit array:

```json
[{"id":"release","title":"Release notes","path":"./release-notes.txt","locator":"local:release-notes.txt"}]
```

Only those UTF-8 files are read, relative to the manifest. The new output must not exist. No recursive scan or network access occurs. Set `PI_SCOUT_CATALOG` before Pi starts. Source IDs and SHA-256 hashes identify exact snapshots; matching quotations do not establish semantic truth.

The separate experimental host adapter accepts `PI_SCOUT_WEB_PROFILE` with exact configured URLs via pi-web-access. The worker does not use it. It does not enforce whole-process networking. Historical offline/reference/dynamic fixtures and new worker checks have separate evidence; neither establishes live model quality.
# Compact evidence references

New local and Docker research briefs are retained as exact, content-addressed
references. Restoring the active branch inserts the reference rather than the
whole brief. `scout_brief_read` retrieves only a requested bounded UTF-8 excerpt;
the reference is not semantic approval and does not establish source freshness.
New briefs are limited to 24,000 serialized UTF-8 bytes. Excerpts default to
8,000 bytes and may be paged without splitting a Unicode character.

The standalone reader accepts references recorded on the active branch at
their original effective Pi model destination. It rejects missing, changed or
unauthorized evidence. Other trusted extensions can resolve an exact reference
through `scout:resolve:v1`, with current owner/destination checks and an explicit
in-process authorization callback for cross-session disclosure. A model cannot
provide that callback. No Bookie, Daddy or Principal installation is required.

Older briefs remain unchanged; their legacy bodies are no longer automatically
restored. They require explicit inspection before reuse because they do not
carry the new destination binding. This does not remove earlier tool messages,
assistant prose or compaction summaries from Pi history.

When Daddy is present, Scout contributes observed worker and retained-brief
status to its terminal dashboard, including whether retained research is incomplete.
On hosts that advertise inventory support, the visible dashboard can also refresh
bounded saved questions, a finding and gap preview, cited-source counts and saved
provenance. Reported complete coverage remains separate from semantic approval.
The latest failure stays separate from saved findings and current readiness.

New saves maintain a private workspace reference index (at most 40 references and
64 KiB), bound to the canonical workspace and its filesystem identity. It contains
metadata and exact references, never another copy of brief bodies. This supports
the human terminal view after `/new`. A failed index write cannot fail research;
the branch reference remains usable and inventory is explicitly incomplete.
Missing indexes mean history is unknown, not that research is empty. Legacy branch
references have limited branch coverage; Scout never scans the whole brief store
or retroactively attributes other sessions to a workspace. At most six exact
briefs are previewed per refresh, within the dashboard's 8 KiB inventory budget.

Terminal previews use a separate human-only workspace read grant. They are never
inserted into model context and do not expand `scout_brief_read` or trusted-peer
destination permissions. Owner changes, cancellation, removed references and
deleted or replaced workspaces revoke pending previews. Refresh resolves no
provider authentication and makes no model, search or research calls.

Worker readiness checks only the selected local Unix-socket or named-pipe Docker
engine, with bounded commands and the same explicit client/host and WSL fallback
selection. Remote or unknown endpoints are left untested. “Local Docker reachable”
does not certify the image or model, or clear an unsettled cleanup guard. Local
source configuration is reported separately and an empty local catalog does not
block public worker research. Configured local files remain “not checked” until a
normal research tool reads them; passive refresh uses the last observed count.
Refresh never builds an image, starts a worker,
repeats retrievals or retries a research request. Older Daddy hosts receive the
legacy status fields only.



## Source and development

The MIT source is at [mojomanyana/pi-scout-research](https://github.com/mojomanyana/pi-scout-research).
Version tags identify release source. Version 0.2.1 adds repository links and
release metadata; research, worker and disclosure behavior are unchanged from
0.2.0. The immutable 0.2.0 source anchor preserves the previously published
package bytes.

See the [offline test instructions](https://github.com/mojomanyana/pi-scout-research/blob/main/tests/README.md)
and [source provenance](https://github.com/mojomanyana/pi-scout-research/blob/main/docs/SOURCE-PROVENANCE.md).
The tests use synthetic Docker/model responses; running them does not make a
model request or start Docker.
