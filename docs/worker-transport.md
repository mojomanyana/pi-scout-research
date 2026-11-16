# Worker transport and usage

The first model request still contains the complete public worker context. A
compatible host acknowledges the exact request ID with `contextAck` on its model
response. Only after receiving that acknowledgement may the worker send a
`model_request_delta`: a new request ID, that acknowledged `baseId`, and newly
appended messages. The host reconstructs the same context for the selected
provider. This changes transport volume, not the model's input or permissions.

The worker keeps a snapshot of the acknowledged context. Changed instructions,
tool definitions or earlier messages cause a complete request instead. The host
retains its own snapshot separately from provider code, rejects stale bases and
repeated/concurrent request IDs, and bounds the reconstructed context as well as
the incoming frame. No history is inferred from another request or session.

An old host does not acknowledge this capability, so a new worker keeps sending
complete contexts. A new host also accepts old workers' complete requests. The
start request and result schema are unchanged. Automatic worker setup already
rebuilds when packaged worker inputs change; a manually pinned old image retains
its old transport behavior until the operator updates it.

Limits remain 4 MiB per protocol frame and reconstructed model context, 16 MiB
cumulative worker stdout plus stderr, and the existing process/cleanup deadlines.
Consumed valid traffic is still counted. The optimization avoids retransmitting
unchanged prefixes; it does not disable or raise a resource bound. `FRAME_LIMIT`
now has a distinct public diagnosis from `OUTPUT_LIMIT`. Safe receipts identify
the observed boundary (`worker-frame`, `host-frame`, `model-context`, or
`worker-output`) when the host can determine it, with byte totals and request
counts. They contain no frame contents or raw provider/command text. These
counters can diagnose a run; a successful small probe alone cannot establish why
a larger historical run failed.

`runtime.usage` is counted once from actual host provider responses. It records
calls started, settled, measured, unmeasured and pending. Token totals cover only
responses containing a complete set of valid reported counters; missing usage is
not silently treated as a measured zero. The snapshot is retained on failures,
including cancellation, before an outstanding provider callback can finish later.
`result.usage`, when present, remains the worker's session accounting of the same
calls. Never add the two records together. Neither represents billed cost,
prefill/decode speed or end-to-end elapsed time.

This transport change does not add automatic retries, extra research runs, model
calls, context compaction, or a fixed number of subquestions. A partial sourced
brief remains partial and must be used within its documented gaps.
