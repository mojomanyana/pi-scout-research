# pi-scout-research

Scout provides a portable Pi research skill, source snapshots and private briefs. Its optional Docker worker lets an agent delegate a public research question through one tool, `scout_research`. Released under MIT.

The skill does not depend on Principal, pi-daddy or skill-harness. Those packages can use Scout through normal Pi tool discovery and governance. The connector declares Pi 1.4.0 or later and Node 24 or later. Retained scripted native checks cover exact Pi 1.4.0 and 1.5.0 on Node 24.19.0; they do not qualify every later Pi version or live model quality. The worker pins Pi 1.4.0, Node 24.19.0 and pi-web-access 0.38.0.

## Use from Pi

With Pi and Docker running on the same computer, install Scout:

```bash
pi install npm:pi-scout-research@0.2.0
```

Start Pi, or `/reload` an idle Pi session after installation, and ask Scout a public research question. No environment variables or separate build command are required. On first use, Scout finds Docker, prepares its worker from the installed package and shows progress. Later requests reuse the matching image. An update rebuilds only when Docker build inputs change. Concurrent sessions share preparation instead of launching duplicate builds.

The first preparation downloads the pinned Node/Pi/web runtime and npm dependencies, which can take a few minutes. Docker must already be installed and running; Scout does not install Docker, start shared services or alter system settings. If Docker is unavailable, the tool explains what is missing. It does not fall back to host web access. The npm package contains the complete build context and lockfile; neither a Git checkout nor OpenShell is needed. No Docker image is published separately.

Choose your normal Pi model. Ask, for example: “Use Scout to compare the current Node.js support policies for these two public libraries. Give me the relevant sources and uncertainty.” No special skill sequence is required. Scout captures the parent's selected model and thinking level at dispatch. Each model turn uses Pi's native provider/authentication support in the parent and consumes its normal usage allowance. Credentials stay outside the container.

The tool accepts only `question` and `scope`. Send public material only. It starts a worker, returns a sourced answer and saves a private brief under `~/.pi-scout-research/briefs/`. The result includes the saved path, exact reference and cleanup confirmation. `PI_SCOUT_BRIEFS` can select another operator-owned root. Current-branch references are restored into Pi context after reload or compaction; brief bodies are retrieved only when needed. Notes from abandoned branches are not selected. Briefs are evidence, not approval or training labels.

WSL automatically uses Docker Desktop's Windows client when the Linux client is missing or is the WSL integration placeholder. If an existing Docker client cannot reach its daemon, Scout reports that problem rather than choosing another daemon. Advanced operator overrides remain available:

```bash
export PI_SCOUT_DOCKER_PATH='/mnt/c/Program Files/Docker/Docker/resources/bin/docker.exe'
export PI_SCOUT_DOCKER_HOST='npipe:////./pipe/dockerDesktopLinuxEngine'
```

`PI_SCOUT_WORKER_MODE=offline` explicitly disables worker web access; public mode is the default. `PI_SCOUT_WORKER_IMAGE=sha256:...` selects an operator-built image and disables automatic image selection; an invalid or missing override is reported, never silently replaced. These settings must be present in Pi's environment. Normal users need none of them. Optional prewarming is available through `npx --yes --package=pi-scout-research@0.2.0 scout-worker-build`, but first-use preparation performs the same work automatically.

Governed children need Scout in their selected resources and permission for `scout_research`; no Docker command or image parameter is supplied by the model. A child Pi with the tool loaded owns its worker lifecycle.

The optional `scout-public` skill supplies a narrow pi-daddy agent definition declaring only `scout_research`. After loading resources, `/grants init` can discover it; approve that capability through the existing operator flow. A Principal coordinator can delegate public research to `scout-public` and give its returned evidence to Investigate, Architect or Decide. Existing Principal definitions keep their current tool restrictions. A role from another skill package can use the same tool or wrapper; no Principal dependency is introduced.

## Modes and limits

- `public`: standard Docker isolation with outbound networking. Keyless Exa discovery and public HTTPS fetch use the pinned reference engine. No browser login, cookies, remote extraction, JavaScript rendering or additional model summary is configured. Search output is a lead; important claims need an original source.
- `offline`: Docker networking is disabled. Optional `PI_SCOUT_CATALOG` supplies selected source snapshots. The model connection still runs through the parent, so selected inputs go to its provider. Offline refers to worker web access, not provider confidentiality.

Both use an immutable image ID, UID 1000, read-only root, no host mounts or Docker socket, dropped capabilities, no new privileges, 1 GiB RAM without additional container swap, 2 CPUs and 128 PIDs. Two 128 MiB temporary filesystems hold ephemeral work. One worker may run per parent Pi session. A 20-minute process watchdog and bounded transport prevent indefinitely running or unbounded-output workers; no time/token instructions are added to the model prompt. Snapshots total at most 1 MiB, with at most 131,072 characters per source. Large, authenticated or dynamic pages may be unavailable.

The parent checks the effective Docker configuration, validates source identities and brief citations, waits for settlement and verifies removal before returning success. Cancellation attempts owned-container cleanup. Unconfirmed cleanup or an unsettled model request blocks another launch in that parent session. A forcibly killed parent can leave a stopped container after the worker's independent watchdog expires. Cleanup is not crash-proof.

**Public mode does not guarantee that every outbound URL, redirect or query is approved.** It does not enforce confidentiality of supplied text. OpenShell is not required. Strict protected online mode remains separate and unqualified. See [SECURITY.md](SECURITY.md).

## Portable skill and local sources

`/skill:research` works without Docker using available Pi research tools. Installing the package alone does not isolate host tools. The `scout_research` tool always uses its Docker worker and prepares it automatically; Docker errors do not silently enable host web access.

The local extension provides `research_sources`, `research_read` and `research_brief`. Prepare a catalog with `npx --yes --package=pi-scout-research@0.2.0 scout-catalog approved-sources.json new-catalog.json`. The input is an explicit array:

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
status to its terminal dashboard. This optional display connection creates no
model calls, timer, dispatch authority or additional evidence store.

