# Remote Agent contract (tablet S5)

This module supplies a provider-neutral contract and a working registry/service.
It contains no network transport and registers no production provider. The
initial preferred ID is `ds-harness-remote`; selecting that ID does not establish
that its adapter is installed or connected.

Application integration:

1. Register `features::remote_agent` without a desktop/target gate.
2. Manage one `RemoteAgentService` for the process, shared by every window and
   background task. Register concrete `Arc<dyn RemoteAgentProvider>` adapters at
   startup. `set_default_provider` accepts a registered provider ID.
3. An adapter owns versioned configuration, credential storage, trust decisions,
   transport, and sharing the host connection. `ConnectRequest` addresses this
   stored configuration by provider ID, connection instance ID and version.
4. Register commands and exported DTOs in the parent application when adding an
   IPC surface. This module defines no Tauri command or Tauri event, so it does
   not independently change generated bindings or the event registry.

## Boundaries

References nest connection → host → workspace/backend → session. Backend is
part of identity, so equal native IDs in Harness, ACP and Codex stay distinct.
The service validates input and adapter output namespaces, negotiated backend
availability, operation capability and attachment route limits. Adapters still
must validate host/workspace/session authority and the actual uploaded file;
caller-supplied size or path metadata is not authorization. Approval/question
responses must be revalidated against the authenticated peer and current remote
request, so another device cannot answer by knowing an ID.

Adapters advertise only negotiated operations. Optional trait methods return
`remote_agent_unsupported` by default. Advertising a method without implementing
it is an adapter defect. Capability changes become visible through the
`ConnectionInfo` returned by `resume`. Registry locks never span adapter awaits;
connection operations are serialized per configured instance. This favors clear
lifecycle/write ordering over parallel calls within one connection.

## Writes and receipts

Every mutation needs a 16–128 character ASCII operation ID. The service journals
the request as `Unknown` **before** awaiting the adapter, including when the local
future is later cancelled. Repeated identical requests return the recorded
outcome without dispatch; reusing an ID for a different request fails. Any
adapter dispatch error or invalid success result becomes `Unknown`, because the
write may already have happened. `Accepted` means queued, not remote task success.

`lookup_receipt` is read-only. It also imports retained IDs into the local journal
before checking connectivity/capabilities or awaiting the lookup. A missing,
expired, unsupported or failed receipt query cannot make that ID eligible for
redispatch. A definitive receipt can resolve the cached outcome.

The journal is process-local, retains request data for the service lifetime and
survives disconnect/resume within that lifetime. Durable pending-operation
storage is an application integration responsibility. After restart the caller
must restore retained IDs through `lookup_receipt` before submitting new work;
the service cannot infer a forgotten operation ID. An absent receipt never proves
the remote operation did not execute. There are no retry loops for mutations.

## Events and recovery

`resume` restores the connection only. `recover_session` reads a complete official
snapshot and opens a subscription with its opaque cursor. The adapter must close
the history/subscription race using the backend's official snapshot/stream
mechanism; the service does not invent a replay protocol or use `sync.from`.

Source event IDs identify immutable events. Source stream IDs distinguish epochs
where IDs may be reused. The service removes duplicate IDs inside each snapshot,
then seeds each subscriber's own deduplication set from that snapshot. Snapshot
history is never globally consumed: multiple windows each receive the full
baseline. Deduplication retains only identity keys until subscription drop or
cancellation; it currently has no size cap. Error/EOF closes that subscriber;
recovery is explicit and never resends writes.

Adapters must release local resources when a subscription is dropped, close the
remote stream on explicit cancellation, and terminate subscriptions on connection
disconnect. There is no background worker, automatic reconnect scheduler, durable
history store, production adapter or UI in this module.

## Focused verification

```sh
cargo test -p agentero --no-default-features features::remote_agent
```

The test adapter is confined to unit tests. Tests cover capabilities, namespace
and backend isolation, lifecycle sharing, concurrent and cancelled writes,
receipt uncertainty, negotiated upload boundaries, and snapshot/stream recovery
across overlapping events, source epochs and independent windows.
