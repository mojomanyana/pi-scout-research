# Changelog

## 0.3.2 — 2026-11-18

- Correct the documented pi-daddy integration using actual tool availability.
  Use `scout-public` inline where `scout_research` is callable, or delegate it when
  Daddy explicitly offers a supported parent-run tool for that child. On hosts
  without that route, keep research in the parent and pass the findings and exact
  brief reference to the delegated role. The session hosting Scout still owns
  worker execution and cleanup. The skill name, single declared tool, research
  behavior and disclosure checks are unchanged.
- Add an offline control that asks the installed Daddy's own child-delivery rule,
  with and without eligible parent-tool facts. The same control supports released
  hosts without a proxy. Test dependencies select pi-daddy 0.59.1.
- Keep the saved-reference notice at a stable position in the model request instead
  of re-appending it after the newest message, so provider prompt caching of earlier
  conversation is not disturbed on every request. The notice follows the tool
  results of the turn that saved the brief, or leads the context after summaries
  when that result is no longer present. Saving a newer brief moves the notice once,
  to the newer result; until then the inserted message is identical on every
  request. Its text, the selected reference and all branch, destination and read
  checks are unchanged. The cost effect has not been measured.

## 0.3.1 — 2026-11-16

- Negotiate append-only model context transfers so later research turns do not
  repeatedly spend the worker's output budget on the same conversation prefix.
  Preserve full-context compatibility, the 4 MiB frame/context limit, 16 MiB
  cumulative output limit, timeouts and owned cleanup.
- Retain host-observed model usage for successful, incomplete and failed runs,
  explicitly identifying unmeasured or still-pending calls. Keep worker session
  counters separate to prevent double counting; no billed-cost claim is made.
- Distinguish individual frame/context limits from cumulative output exhaustion
  and retain bounded numeric traffic diagnostics without prompts, source text,
  private provider errors or Docker arguments.

## 0.3.0 — 2026-11-16

- Show bounded saved research topics, sourced or unverified findings, gaps and
  saved provenance in compatible Daddy dashboards. Keep partial evidence and the
  latest failure separate from current readiness.
- Retain a private workspace reference index for human terminal previews after
  `/new`, with explicit limited history and exact bounded reads. Preserve existing
  model-facing branch and destination permissions; refresh makes no provider,
  authentication, search or research calls.
- Refresh local Docker readiness only for proven local socket or named-pipe
  endpoints. Preserve active-worker and unsettled-cleanup guards, and leave remote
  endpoints untested. Local source readiness uses previously observed configuration.
- Negotiate additive inventory support, retain legacy status compatibility, and
  revoke pending previews on owner, model, access or workspace changes.

## 0.2.5 — 2026-11-16

- Explain when a known Docker connection failure stopped setup before a research
  worker started, so missing cleanup evidence for that attempt is not mistaken for
  an unresolved worker. Keep the compatible cleanup status and expose the narrow
  `workerStarted: false` observation; ordinary authorized retry remains available
  after the selected Docker connection is reachable.
- Keep unsettled setup, worker and model restrictions unchanged. Preserve useful
  partial research and identify which missing facts block which requirements,
  while respecting explicit user stop conditions and evidence gates.

## 0.2.4 — 2026-11-15

- Give the research worker safe, field-specific brief corrections, including
  citation and size limits, so it can repair a rejected brief without guessing.
- Accept optional exact public source URLs and explain direct official-page
  fetching without a search prerequisite. Keep discovery, fetching and local
  source configuration distinct.
- Retain incomplete findings and explicit gaps without claiming research success.
  On a normal model finish without a valid brief, retain gaps and bounded source
  leads instead of treating unvalidated answer text as evidence. Preserve an
  earlier valid draft unchanged when a final update is rejected, with the issue
  recorded alongside its reference. Execution, cancellation and cleanup failures
  remain failures.
- Carry incomplete status with retained references and dashboard observations;
  explain how callers can reuse supported findings and continue the missing check.

## 0.2.3 — 2026-11-15

- Report actionable, static failure categories and next steps for worker setup,
  model requests, source tools, evidence briefs and result validation. Retain a
  bounded failure record in the owning Pi session without raw exception text.
- Preserve cancellation, cleanup and unsettled-work restrictions. Keep recoverable
  tool failures separate from the terminal cause, and withhold failed-job details
  after a session or branch change.
- Clarify that an empty parent source catalog does not diagnose public worker
  availability. Add offline regression coverage without research or model calls.

## 0.2.2 — 2026-11-07

- Include the brief-reference helper in the Docker worker build context and image identity, fixing startup of workers that retain compact brief references. Add an import-closure and image-invalidation regression.
- Clarify optional Bookie evidence reuse, parent-owned JEV advice and narrow Scout delegation. Existing accepted decisions remain authoritative; memory and source hashes do not grant approval or establish freshness.
- Keep standalone Pi use and standard Docker boundaries unchanged. The exact worker inputs passed a scripted offline container check; this does not qualify live web research or model quality.

## 0.2.1 — 2026-11-06

- Link npm metadata to the public GitHub source, issues and README.
- Add a public source history anchored to the exact previously published 0.2.0 payload, with existing offline controls and model-free CI.
- Update installation examples. Research, worker, disclosure and permission behavior is unchanged.

## 0.2.0 — 2026-11-06

- Retain exact private brief references on the active Pi branch instead of restoring whole brief bodies; resolve only bounded requested excerpts with current destination and disclosure checks.
- Add an optional trusted peer resolver and Daddy dashboard contribution without requiring Bookie, Principal or Daddy, granting authority, or adding model calls during restoration/display.
- Preserve existing briefs and the public/offline Docker worker boundaries. Historical body-only briefs need explicit inspection; protected online egress remains unqualified.
- Carry the exact published 0.1.1 Docker preparation/runtime inputs forward. Scripted Pi 1.4.0/1.5.0 evidence remains distinct from live answer quality.

## 0.1.1 — 2026-11-03

- Publish lazy first-use Docker preparation, exact packaged build inputs, image reuse and duplicate-build prevention, WSL client discovery and explicit operator overrides.
- Retained publication evidence verifies the exact npm archive and a fresh scripted Pi 1.4 installation. No GitHub repository or Git tag was created for this source-only npm release.
