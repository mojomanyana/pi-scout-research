# Offline checks

These suites exercise protocol validation, exact brief references,
branch/destination revocation, native Pi extension loading, the optional Daddy
definition, fake Docker ownership/cleanup, and automatic worker preparation.

Use Node 24.19.0 on Linux or WSL. Docker executables, model responses and credentials
in these tests are synthetic. The tests do not start Docker or contact a model
provider, and do not establish protected online egress or live research quality.

Install direct test dependencies into a separate directory with scripts disabled:

    npm install --prefix /tmp/scout-test-deps --ignore-scripts --no-audit --no-fund --save-exact @earendil-works/pi-coding-agent@1.5.2 @earendil-works/pi-ai@1.5.2 typebox@1.4.7 pi-daddy@0.59.1

From this repository root:

    SCOUT_PI_SDK_ROOT=/tmp/scout-test-deps/node_modules/@earendil-works/pi-coding-agent SCOUT_DADDY_ROOT=/tmp/scout-test-deps/node_modules/pi-daddy node --test --test-concurrency=1 tests/*.test.mjs

Both environment variables are required to exercise all native controls. Otherwise
native integration controls explicitly skip. The separate prefix is not a runtime
dependency of Scout. CI selects the same direct dependency versions.

The Daddy child-delivery control asks the installed Daddy's own planner rule
whether `scout_research` can reach a governed child. A parent catalog entry alone
must be refused. If the installed host has the parent-tool proxy, the control also
checks eligible direct-child delivery and refusal without its required facts or
with a different model. On a released host without that capability, research stays
in the parent. Only a Daddy older than 0.57.0 without the child-delivery rule skips
this control. It launches no child and no worker; full proxy execution belongs to
Daddy's integration checks.

The approved failure-reporting regression groups cover actionable categories;
bounded diagnostics without secrets; cleanup, cancellation and owner transitions;
and independent parent/worker source catalogs. Worker source failures are injected
into mock tools, and native Pi calls use synthetic responses. No test establishes
that a historical remote research failure has been repaired or retries that run.

The approved recovery batch adds checks for field-specific brief corrections,
direct known URLs without a search prerequisite, incomplete evidence retention,
honest partial references/dashboard state, unchanged failure and disclosure
boundaries, and worker packaging. On 2026-11-15, the full suite passed 86/86 on
Pi 1.5.2 with Daddy 0.57.0, and the affected native compatibility subset passed
21/21 on Pi 1.4.0 with Daddy 0.57.0; neither run skipped a test. These are distinct
runtime checks, not 107 unique scenarios. No fixture contacts the official URLs
it names. Live search availability remains a separate question.

The dashboard inventory batch adds bounded workspace retention, `/new`, explicit
unknown history, partial/complete coverage, later failure preservation, legacy
host negotiation, human-only previews with unchanged model-facing permissions,
owner/model/cancellation/replacement revocation, and fake local Docker readiness
including remote-endpoint refusal, WSL fallback and timeout. These fixtures do not
launch Docker, resolve live provider auth, fetch sources or repeat research.
For the new host-schema integration, set `SCOUT_DASHBOARD_CONTRACT` to the explicitly
selected Daddy `src/kernel/dashboard-observation.ts` (or built equivalent).
That check uses the real host validator to verify complete native Scout snapshots,
including long retained failure details; it skips explicitly when no host contract
is selected. The legacy Daddy renderer remains independently exercised through
`SCOUT_DADDY_ROOT`.

The reference-notice placement controls use synthetic Pi context messages and the
natively loaded context handlers. They check that the notice keeps one position
while later requests grow, stays after all tool results of the turn that saved the
brief, and otherwise leads the context after summaries. They send no provider
request and do not measure prompt-cache reads or cost.
