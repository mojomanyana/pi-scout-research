# Security boundary

## Standard public Docker mode

The operator selected this mode on 2026-10-30: isolated files/processes and resource limits, without a guarantee that every outbound request is approved. This is separate from the earlier protected-online requirement.

Docker contains the worker filesystem and resource use. There are no host mounts, real credentials, Docker socket, browser profile or inherited parent session. Scout receives the explicit question/scope and optional operator-selected catalog. Credentials are resolved by the parent Pi model registry. Bounded native model contexts and replies travel through standard input/output; the worker cannot select a host provider, credential, request URL or API options.

Negotiated context deltas can append only to the host's exact acknowledged request
snapshot. Full frames and reconstructed contexts remain bounded to 4 MiB; the
16 MiB lifetime stdout/stderr budget remains enforced. Host provider code receives
a separate context object, so mutations cannot change the retained prefix. Public
failure receipts include allowlisted counters and boundary labels only. Missing
or unsettled model usage remains explicitly unknown; response contents, credentials
and private provider diagnostics are not included in these receipts.

Public search and fetch send data outside the container. The model provider receives the worker conversation, including fetched material. Queries may disclose anything the parent supplies. Prompt guidance and reference-engine SSRF checks are not a whole-process egress boundary. Docker bridge networking must not be described as denying all private/LAN destinations, redirects, query-based exfiltration or malicious web behavior. Supply public, nonsecret material only.

No shell, filesystem edit/read, delegation or MCP tools are exposed to the worker model. Deferred web-engine tools are reached through research wrappers. The engine performs raw unauthenticated HTTPS fetches and keyless Exa search; no browser/cookie access, JavaScript rendering, remote page extraction or secondary model summary is configured. The external search service can change or become unavailable. A returned requested URL does not prove the final redirect destination.

An immutable image ID and inspection bind execution to a selected image/configuration, not proof that an arbitrary image is trustworthy. This profile excludes malicious Docker administrators/operators, compromised images/dependencies, container escapes, host-kernel vulnerabilities and hostile processes with host-account access. Other host extensions and the parent agent remain outside this boundary.

With no image override, first use builds the installed package's pinned Docker inputs and selects the resulting immutable ID. A content-derived tag and label identify reusable builds; a local process-owned preparation lock avoids duplicate builds across sessions. This uses the existing Docker daemon and its build cache. A matching label is cache identity, not an attestation against a malicious Docker administrator. Explicit image/client/endpoint/mode overrides remain operator-controlled. Public mode is the default; no network activity or build happens merely from loading the extension.

## Limits, cancellation and records

The runner checks user, image/entrypoint, read-only root, absence of mounts and extra devices/capabilities, network mode and resource limits before execution. Its protocol rejects extra provider options, oversized records, concurrent model requests and unmatched completions. Input source identities and brief quotations are checked; semantic support and answer truth still require judgment.

Success requires worker exit and confirmed owned-container removal. Interruption cancels the native model call and removes only the uniquely labelled container. A provider ignoring cancellation can outlive the bounded wait; that is reported and blocks reuse in the same parent session. Hard parent termination can bypass cleanup. The worker has its own 20-minute watchdog, but a stopped container can remain. Inspect only the recorded `scout-worker-*` container and verify its ownership label before removal; never prune unrelated containers.

Private brief files use content-addressed exclusive creation. Pi tool results retain snapshots and cleanup metadata; new custom entries retain current-branch references and the original effective destination identity, never credentials. Restoration injects references only. The bounded reader verifies exact bytes and identity and checks disclosure before and after reading. A trusted peer must separately authorize cross-session body access; a reference alone does not grant it. Missing or changed evidence is withheld. These are cooperating-extension checks, not protection against hostile host processes or arbitrary edits to Pi session files. Earlier tool messages, assistant prose and compaction summaries are outside this restoration boundary. Progress contains no model reasoning. No automatic training label is applied. Pi/providers may have their own retention behavior; this package does not attest to it. Review records before sharing them.

The worker's Docker log driver is disabled. The private model exchange travels through the attached pipe without a second persistent Docker stdout log. The parent stores the returned answer, sources and brief; it does not save raw worker model contexts as diagnostic output.

A host explicitly configured for Brave fallback can send one original public
question to the fixed HTTPS Web Search endpoint. It sends the subscription key
only in a request header and refuses redirects. The worker can request this
fallback once and cannot supply a URL, query, headers or credentials. Public mode,
current branch and destination, and the absence of supplied URLs are required.
The default limit is five discovery leads and 128 KiB of response data within
eight seconds. Provider errors do not enter diagnostics. Exa and Brave snippets
cannot substantiate a supported or conflicting brief finding.

The optional terminal inventory has a separate human-only local display grant:
the trusted current dashboard owner may preview exact references recorded for
the current canonical workspace, or the active branch with explicit limited
coverage. New saves write a bounded, private, atomic reference index; no background
scan attributes older sessions to a project. Workspace replacement, lost ownership,
host cancellation and removed access are checked before and after exact body reads.
The display does not resolve provider authentication, inject bodies into model
context, authorize a model-facing read after `/new`, or change peer disclosure
checks. It is intended for the human viewing this local terminal, not a new remote
consumer or access boundary against hostile processes with the host account.
Readiness refresh invokes only bounded local Docker client checks after proving
the selected endpoint is a Unix socket or named pipe; remote endpoints remain
untested. It has no worker-launch, image-build, retry, cleanup-clear or approval
authority. Saved findings, gaps and actual current readiness remain separate.

Failure diagnostics use a fixed vocabulary selected at known code boundaries.
Versioned worker error frames are bound to the request and allowlist; unknown codes,
extra fields and mismatched requests are protocol failures. Legacy worker error text
is discarded. The parent retains a bounded `scout-worker-failure-v1` session entry
with the category, static next step and cleanup/settlement facts. No raw exception,
provider body, stack, command arguments, source query or credential is included.
Recoverable source-tool failures are kept as a bounded list of codes, not asserted
as the terminal cause. Diagnostic records confer no result approval or disclosure
permission, and are not restored as research evidence. Owner changes prevent writing
the failure record or dashboard detail into the new branch.

## Other modes

`offline` disables worker networking. It reads supplied snapshots through its tools, but the parent still sends selected material to its provider. It is not air-gapped model execution.

Ordinary skill/local-extension installation does not sandbox parent Pi, other extensions, shell, MCP or host networking. The local source adapter restricts its own tools only. Skill instructions cannot enforce permissions or guarantee resistance to semantic prompt injection.

Strict protected online use requires separately qualified whole-process egress enforcement and disclosure policy. Local OpenShell admission failed on this WSL setup. No workaround or shared host-network change is part of this candidate. Standard public mode must not be represented as satisfying that stronger requirement.
