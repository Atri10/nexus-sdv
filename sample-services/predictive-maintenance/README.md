# predictive-maintenance

Predictive maintenance prototype service.

## Message contract

`proto/pm-message.proto` defines `PmMessage` (package `pm`) — the message
serialized over NATS by the detector service and decoded by the web client.
The betterproto stub is committed at
`src/predictive_maintenance/model/pm_message.py` (generated, DO NOT EDIT).

Regenerate after changing the proto:

```bash
make proto
```

## Test

```bash
uv run pytest tests/ -v
```
