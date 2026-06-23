# `ResourcePool` shapes

`resourcePools[]` is a Jackson-polymorphic array. Each item has a `type` discriminator and a per-subtype keyset. The Java contract is:

```java
sealed interface ResourcePool permits DeviceZone, OnPremPool, CloudPool;
// (or pre-sealed: @JsonTypeInfo(use=NAME, property="type") + @JsonSubTypes)
```

The `name` field is **required on every subtype** and must be non-empty.

## `DEVICE_ZONE`

A zone defined by a single (device, zone-name) pair. `device` carries the device's hostname (Java side wraps it in a `DeviceName` value object via `DeviceName.of(...)`, which serializes to the bare string).

```json
{
  "type": "DEVICE_ZONE",
  "name": "sjc-dc1out-forti-fw1 INSIDE_FW-DMZ",
  "device": "sjc-dc1out-forti-fw1",
  "zone":   "INSIDE_FW-DMZ"
}
```

| Field | Required | Notes |
|---|---|---|
| `type` | ✅ | Literal string `"DEVICE_ZONE"` |
| `name` | ✅ | Display name; convention seen in CHG_DEMO is `"<device> <zone>"` |
| `device` | ✅ | Device hostname (string) |
| `zone` | ✅ | Zone name on that device (string) |

## `ON_PREM`

An on-prem pool defined by any combination of devices, VRFs, and subnets. All three lists may coexist or be empty, but at least one of them must be populated for the pool to be useful.

```json
{
  "type": "ON_PREM",
  "name": "ATL Web Servers",
  "devices": [],
  "vrfs":    [],
  "subnets": ["10.55.101.11", "10.55.101.42", "10.55.103.22"]
}
```

| Field | Required | Notes |
|---|---|---|
| `type` | ✅ | Literal string `"ON_PREM"` |
| `name` | ✅ | Display name |
| `devices` | ⚠️ optional but typed | Array of device hostnames |
| `vrfs` | ⚠️ optional but typed | Array of VRF identifiers |
| `subnets` | ⚠️ optional but typed | Array of CIDR or IP literal strings |

## `CLOUD`

A cloud pool defined by subnet IDs and/or security-group IDs.

```json
{
  "type": "CLOUD",
  "name": "AWS App-1 VM",
  "subnets":        ["subnet-0ac93ee92766eddbe"],
  "securityGroups": []
}
```

| Field | Required | Notes |
|---|---|---|
| `type` | ✅ | Literal string `"CLOUD"` |
| `name` | ✅ | Display name |
| `subnets` | ⚠️ optional but typed | Array of provider-native subnet IDs (e.g. `subnet-…`) |
| `securityGroups` | ⚠️ optional but typed | Array of provider-native SG IDs |

## Validation behavior

- **Missing `type`** → server rejects the whole filter as `provideInvalidMatrixFilters` shows (`Map.of("bla", "bla")` case). Jackson's polymorphic deserializer needs the discriminator to pick a subtype.
- **Unknown `type`** → same outcome.
- **Unknown keys for the picked subtype** → server may accept silently if Jackson's `FAIL_ON_UNKNOWN_PROPERTIES` is off, but the create / import scripts in this skill reject them client-side to keep imports lossless and reversible.
- **`name` missing or empty** → rejected.

## Source of truth

- Java DTO: `NewSecurityMatrixFilter(name, deviceZones, protocolExclusions, timeoutMins)` — `deviceZones` parameter name is misleading; the underlying type is `List<ResourcePool>`, not `List<DeviceZone>`.
- The `provideInvalidMatrixFilters` test data and the live CHG_DEMO export (network 212984, 13 filters, 77 pools) together cover all three subtypes.
- Only the `DEVICE_ZONE` subtype appears in the `provideMatrixFilters()` JavaDoc examples — that's why the OpenAPI spec is incomplete and we needed empirical data to fill in `ON_PREM` / `CLOUD`.
