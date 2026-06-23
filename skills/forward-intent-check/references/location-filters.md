# Location Filters — pinning a check to an ingress/egress device

Path-based checks (Existential / Isolation / Reachability) take a **source** and
**destination** endpoint. The CLI exposes these as `--src-ip` / `--dst-ip`, but
the flags are misnamed: the value can be **either an IP/CIDR or a bare device
name**. Which one you pass changes the *kind* of endpoint filter Forward builds,
and that is the lever for turning a plain delivery check into a **path / plane
sentinel**.

## The mechanism (what the code actually does)

`create_check.py` → `_ip_or_device_location(value)` picks the filter type by a
single regex:

```python
if re.match(r'^\d+\.\d+', value):
    return {"type": "SubnetLocationFilter", "value": value}   # IP or CIDR
return {"type": "DeviceFilter", "value": value}               # bare device name
```

Then `build_path_filter()` places it:

| CLI flag    | PathQuery endpoint | Meaning when value is a **device name** |
|-------------|--------------------|------------------------------------------|
| `--src-ip`  | `from`             | **ingress** — flow must *enter* at this device |
| `--dst-ip`  | `to`               | **egress** — flow must *leave* (be delivered) at this device |

So:

- `--src-ip 10.1.0.5` → `SubnetLocationFilter` (a host/subnet, "from anywhere this IP lives")
- `--src-ip ny-srv1-host` → `DeviceFilter` ("ingress at device ny-srv1-host")
- `--dst-ip lon-pe-sr` → `DeviceFilter` ("egress via device lon-pe-sr")

No new flags are needed — "ingress/egress keywords" are simply **device names in
the existing endpoint args**.

## Why this matters: delivery checks vs. path/plane sentinels

A normal Existential check (`--src-ip A --dst-ip B`) answers *"does traffic get
delivered?"* — it is **path-agnostic**. It passes no matter which devices,
links, or backbone plane the packet rides, as long as it arrives. That is the
right check for an SLA ("payments must reach the DB"), but it is **blind to
which plane carries the traffic**.

Pinning an endpoint to a **device** constrains the *shape* of the path:

> Existential check, `--dst-ip <plane-specific-device>` → passes **only while the
> flow actually egresses through that device**. If traffic falls back to the
> other plane / another egress, the check flips to **FAIL** — even though
> end-to-end delivery still works.

This is what makes it a **migration / plane sentinel**: the assertion is no
longer "is it delivered?" but "is it delivered *via this box*?".

## Worked example — LDP→SR migration sentinel (bank-global)

During a per-prefix LDP→SR migration, end-to-end delivery is identical on either
plane (dual-homed CEs, back-to-back PEs), so a plain delivery check can't tell
you whether a prefix has actually moved to the SR backbone. Pin the egress to
the SR-plane PE:

```bash
# Plane-agnostic baseline: just proves the prefix is still delivered
create_check.py --network-id 2407 --type Existential \
    --name "SR-MIGRATION: payments 172.16.1.0/24 (ny-srv1 -> lon-srv1)" \
    --src-ip ny-srv1-host --dst-ip lon-srv1-host

# Ingress/egress device pins: enter at ny-srv1-host, leave at lon-srv1-host
create_check.py --network-id 2407 --type Existential \
    --name "SR-MIG payments: ingress ny-srv1-host -> egress lon-srv1-host" \
    --src-ip ny-srv1-host --dst-ip lon-srv1-host

# THE SENTINEL: egress pinned to the SR-plane PE.
# PASSES only while 172.16.1.0/24 rides SR; FAILS the moment it falls back to LDP.
create_check.py --network-id 2407 --type Existential \
    --name "SR-MIG payments: ny-srv1-host egresses via lon-pe-sr (SR-plane assert)" \
    --src-ip ny-srv1-host --dst-ip lon-pe-sr
```

**Validate the sentinel by toggling:** roll the prefix off `MIGRATE-SR` (remove
the `route-map SR-PREFER` / `local-preference` that pulls it onto SR) and
confirm the sentinel flips to FAIL, then re-migrate and confirm it returns to
PASS. A sentinel you've never seen fail is a sentinel you can't trust.

## Gotchas

- **Flag name is a misnomer.** `--src-ip` / `--dst-ip` accept device names. The
  regex only checks for a leading `\d+\.\d+`, so anything non-IP-shaped becomes a
  `DeviceFilter`. A typo in a device name silently becomes a `DeviceFilter` for a
  device that doesn't exist → the check fails for the wrong reason. Verify the
  device name against `forward-inventory/list_devices.py`.
- **Direction is fixed by flag.** `--src-ip` is always ingress (`from`),
  `--dst-ip` always egress (`to`). To assert a *transit* device (neither first
  nor last hop) you cannot use these endpoint filters — use
  `forward-path-analysis` and inspect the hop list, or an NQE check over the
  forwarding model.
- **Reachability type rejects a `to` device filter in some builds** ("'to'
  header filters not allowed in Reachability check"). Use **Existential** for
  egress-device sentinels.
- **Mixing IP + device is fine.** `--src-ip ny-srv1-host --dst-ip 172.16.1.28`
  is a perfectly valid "ingress at this device, delivered to this subnet" check.
- **Sentinels are still path-based checks** — they re-evaluate on every future
  snapshot like any other, so a migration sentinel keeps guarding the plane
  assignment long after the change window closes.

## When to reach for a device-pinned check

| You want to assert… | Pin |
|---|---|
| "Traffic is delivered to B" (any path) | `--dst-ip <ip/cidr>` (SubnetLocationFilter) |
| "Traffic enters at device A" | `--src-ip <deviceName>` (ingress DeviceFilter) |
| "Traffic leaves via device E" (plane/edge assertion) | `--dst-ip <deviceName>` (egress DeviceFilter) |
| "Prefix rides plane X, not Y" (migration sentinel) | `--dst-ip <plane-X edge device>` |
| "Traffic transits a middle device" | not expressible here → `forward-path-analysis` / NQE |
