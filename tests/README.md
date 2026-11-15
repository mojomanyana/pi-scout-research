# Offline checks

These suites exercise protocol validation, exact brief references,
branch/destination revocation, native Pi extension loading, the optional Daddy
definition, fake Docker ownership/cleanup, and automatic worker preparation.

Use Node 24.19.0 on Linux or WSL. Docker executables, model responses and credentials
in these tests are synthetic. The tests do not start Docker or contact a model
provider, and do not establish protected online egress or live research quality.

Install direct test dependencies into a separate directory with scripts disabled:

    npm install --prefix /tmp/scout-test-deps --ignore-scripts --no-audit --no-fund --save-exact @earendil-works/pi-coding-agent@1.5.0 @earendil-works/pi-ai@1.5.0 typebox@1.3.27 pi-daddy@0.50.0

From this repository root:

    SCOUT_PI_SDK_ROOT=/tmp/scout-test-deps/node_modules/@earendil-works/pi-coding-agent SCOUT_DADDY_ROOT=/tmp/scout-test-deps/node_modules/pi-daddy node --test --test-concurrency=1 tests/*.test.mjs

Both environment variables are required to exercise all native controls. Otherwise
native integration controls explicitly skip. The separate prefix is not a runtime
dependency of Scout. CI selects the same direct dependency versions.

The approved failure-reporting regression groups cover actionable categories;
bounded diagnostics without secrets; cleanup, cancellation and owner transitions;
and independent parent/worker source catalogs. Worker source failures are injected
into mock tools, and native Pi calls use synthetic responses. No test establishes
that a historical remote research failure has been repaired or retries that run.
