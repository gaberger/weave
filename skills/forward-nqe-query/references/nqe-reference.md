# NQE Reference — Forward Networks Network Query Engine

A thorough grammar and reference for writing NQE queries against Forward Enterprise.  
All syntax and examples are verified against Forward Networks community documentation,
official blog posts, and ground-truth queries fetched from the live NQE catalog
(via `get_query_source.py`).

---

## Table of Contents

1. [Overview](#1-overview)
2. [Query Structure — Grammar](#2-query-structure--grammar)
3. [Type System](#3-type-system)
4. [Operators](#4-operators)
5. [Clauses in Depth](#5-clauses-in-depth)
   - [foreach](#foreach)
   - [where](#where)
   - [let](#let)
   - [group-by](#group-by)
   - [select](#select)
6. [Expressions](#6-expressions)
   - [if-then-else](#if-then-else)
   - [when (enum switch)](#when-enum-switch)
   - [Inline list comprehension](#inline-list-comprehension)
7. [Built-in Functions](#7-built-in-functions)
   - [String functions](#string-functions)
   - [Numeric/type conversion](#numerictype-conversion)
   - [IP and network functions](#ip-and-network-functions)
   - [Collection functions](#collection-functions)
   - [Optional / presence](#optional--presence)
   - [Config/device functions](#configdevice-functions)
8. [Pattern Matching](#8-pattern-matching)
   - [Pattern string syntax](#pattern-string-syntax)
   - [patternMatch](#patternmatch)
   - [patternMatches](#patternmatches)
   - [blockMatches + parseConfigBlocks](#blockmatches--parseconfigblocks)
9. [User-Defined Functions — export / import](#9-user-defined-functions--export--import)
10. [Parameterized Queries — @query](#10-parameterized-queries--query)
11. [Comments and Annotations](#11-comments-and-annotations)
12. [Data Model Schema](#12-data-model-schema)
    - [network root](#network-root)
    - [device](#device)
    - [interface / subinterface / IP](#interface--subinterface--ip)
    - [Config tree](#config-tree-devicefilesconfig)
    - [Routing / forwarding](#routing--forwarding)
    - [BGP](#bgp)
    - [Cloud accounts](#cloud-accounts)
    - [Custom commands](#custom-commands)
13. [Enum Reference](#13-enum-reference)
14. [Common Patterns](#14-common-patterns)
15. [Gotchas and Caveats](#15-gotchas-and-caveats)
16. [API Execution](#16-api-execution)
17. [Sources](#17-sources)

---

## 1. Overview

NQE (Network Query Engine) is a **functional, relational query language** built into
Forward Enterprise. It lets you traverse the normalized network data model as if it were
a database, producing tabular results you can view in the UI, export as CSV, or retrieve
via the REST API.

Key design decisions that shape every query:

- **Foreach is a nested-loop join.** Each `foreach` clause is an implicit iteration over
  a collection. Multiple consecutive `foreach` clauses produce the Cartesian product of
  the matching rows, filtered by `where`. This is how "joins" happen — no `JOIN` keyword.
- **Functional expressions.** `let`, `if`, `when`, and inline `foreach...select` are
  expressions, not statements. They evaluate to a value and can appear anywhere an
  expression is expected.
- **Immutable bindings.** `let` creates a named binding, not a mutable variable.
- **OpenConfig-aligned data model.** The schema is largely derived from OpenConfig and
  exposes vendor-neutral fields across platforms (Arista, Cisco, Juniper, Palo Alto, etc.).

---

## 2. Query Structure — Grammar

```
query       ::= clause* select_clause

clause      ::= foreach_clause
              | where_clause
              | let_clause
              | group_by_clause
              | import_clause

foreach_clause   ::= "foreach" IDENT "in" expr
where_clause     ::= "where" bool_expr
let_clause       ::= "let" IDENT "=" expr
group_by_clause  ::= "group" expr "as" IDENT "by" expr "as" IDENT
select_clause    ::= "select" "{" field_list "}"

field_list  ::= field ("," field)*
field       ::= IDENT ":" expr
              | IDENT                        -- shorthand: field name == variable name
              | STRING_LITERAL ":" expr      -- quoted name for names with spaces

import_clause    ::= "import" STRING_LITERAL ";"

export_decl ::= "export" IDENT "(" param_list ")" "=" expr ";"
param_list  ::= param ("," param)*
param       ::= IDENT ":" TYPE

query_decl  ::= "@query" "query" "(" param_list ")" "=" expr
```

A minimal query:

```nqe
foreach device in network.devices
select { name: device.name }
```

A full-featured example (from `nqe/sr-node-sids.nqe` in this repo):

```nqe
foreach device in network.devices
foreach iface in device.interfaces
where iface.loopbackMode == true
foreach sub in iface.subinterfaces
foreach addr in sub.ipv4.addresses
where addr.prefixLength == 32
let srgbBase =
  if device.platform.vendor == Vendor.ARISTA then 90000
  else if device.platform.vendor == Vendor.CISCO then 16000
  else 16000
let nodeSidIndex = toNumber(addr.ip) % 256
let srEnabled = substring(device.name, 0, 2) == "s-"
select {
  device:         device.name,
  vendor:         device.platform.vendor,
  routerId:       addr.ip,
  nodeSidIndex:   nodeSidIndex,
  prefixSidLabel: srgbBase + nodeSidIndex,
  srEnabled:      srEnabled
}
```

---

## 3. Type System

| Type | Literal / Constructor | Notes |
|------|-----------------------|-------|
| `Int` | `0`, `42`, `-1` | 64-bit integer |
| `String` | `"hello"` | Double-quoted |
| `Bool` | `true`, `false` | |
| `IpAddress` | `addr.ip` (model field) | IPv4 or IPv6 address |
| `IpPrefix` | `ipSubnet(ip, prefixLen)` | CIDR prefix e.g. `10.0.0.0/24` |
| `List<T>` | `["a", "b"]`, or from `foreach…select` | Ordered, may contain duplicates |
| `Bag<T>` | Function parameter type | Unordered multiset; used in type annotations |
| `Optional<T>` | Absent field or failed pattern | Test with `isPresent()` |
| Record | `{ field: value, … }` | Select output; structural typing |
| Enum | `Vendor.ARISTA`, `OS.IOS_XE`, … | Namespaced constants; compared with `==` |
| `ConfigBlocks` | `parseConfigBlocks(os, text)` | Opaque; used with `blockMatches()` |
| `Device` | `device` in `foreach device in network.devices` | Complex object; pass to helpers |

**Subtyping**: `IpAddress` covers both IPv4 and IPv6. Functions like `toNumber()` only
accept IPv4 — use `patternMatch(toString(a), '{ipv4Subnet}')` to test if an address is
IPv4 before converting.

---

## 4. Operators

### Comparison
| Operator | Types | Example |
|----------|-------|---------|
| `==` | Any scalar, enum, string | `device.platform.vendor == Vendor.ARISTA` |
| `!=` | Any scalar, enum, string | `device.platform.model != "ASAv"` |
| `>` `>=` `<` `<=` | Int, numeric | `iface.mtu > 1500` |

### Logical
| Operator | Notes |
|----------|-------|
| `&&` | Logical AND |
| `\|\|` | Logical OR |
| `not`, `!` | Logical NOT; both forms work: `!isPresent(x)`, `not isPresent(x)` |

### Arithmetic
| Operator | Types |
|----------|-------|
| `+` | Int+Int, or String+String (concatenation) |
| `-` `*` `/` `%` | Int arithmetic; `%` is modulo |

### Membership
| Operator | Example |
|----------|---------|
| `in` | `device.platform.osVersion not in approved_os` |
| `not in` | `vpcId not in idsOfCollected` |

These work against `List<T>` literals or let-bound lists.

---

## 5. Clauses in Depth

### foreach

```nqe
foreach <variable> in <collection-expression>
```

Iterates every element in the collection and binds it to `<variable>` for the clauses
that follow. Multiple `foreach` clauses compose as nested loops:

```nqe
foreach device in network.devices
foreach iface in device.interfaces        -- for each device, for each interface
foreach sub in iface.subinterfaces        -- for each interface, for each subinterface
```

Each combination of `(device, iface, sub)` becomes a candidate row. `where` clauses
filter rows; `select` projects the final output.

### where

```nqe
where <bool-expression>
```

Filters rows. The expression must evaluate to `Bool`. Multiple `where` clauses can appear
at any point in the clause chain — they filter immediately after the preceding `foreach`.

```nqe
foreach device in network.devices
where device.platform.vendor == Vendor.CISCO   -- only Cisco devices
foreach iface in device.interfaces
where iface.operStatus == OperStatus.UP        -- only up interfaces
```

Combining conditions on a single `where` with `&&`:
```nqe
where iface.adminStatus == AdminStatus.UP && iface.mtu >= 9000
```

### let

```nqe
let <name> = <expression>
```

Binds a computed value to a name for use in subsequent clauses and the `select`.
`let` is an expression-level construct — any valid NQE expression may appear on the
right-hand side, including `if`, `when`, and inline `foreach…select`.

```nqe
let lastOctet = toNumber(addr.ip) % 256
let expectedSeg = "node-segment ipv4 index " + toString(lastOctet)
let srEnabled = substring(device.name, 0, 2) == "s-"
```

**Declare `let` before `group-by`** to preserve access to parent-scope fields after
scope narrows (see group-by).

### group-by

```nqe
group <varying-expr> as <listAlias> by <shared-expr> as <singleAlias>
```

Collapses rows with the same `shared-expr` value into one output row, collecting the
`varying-expr` values into a list.

Mental model: **"group DIFFERENT as X by SAME as Y"**
- `listAlias` becomes a `List<T>` — all the varying items for each group
- `singleAlias` remains a single item — the shared key

```nqe
foreach device in network.devices
let deviceName = device.name           -- capture BEFORE group-by narrows scope
foreach iface in device.interfaces
group iface.name as ifaceNames by iface.operStatus as status
select {
  deviceName,
  ifaceNames,     -- List<String>: all interface names with this status
  status          -- OperStatus: the shared status value
}
```

**Scope note**: After `group-by`, only the `listAlias`, `singleAlias`, and `let` bindings
declared before the group-by are accessible. Variables from earlier `foreach` bindings
(except via `let`) are out of scope.

**Deduplication**: There is no `distinct` keyword. Use `group-by` to identify and collapse
duplicates:
```nqe
group item.key as grouped by item.key as key
select { key, count: length(grouped) }
```
Then filter `where count == 1` for uniques, or `where count > 1` for duplicates.

### select

```nqe
select { fieldName: expression, … }
```

Projects the output record. Each field maps a name to a value expression.

- **Shorthand**: `{ deviceName }` is equivalent to `{ deviceName: deviceName }`.
- **Quoted names**: `{ "Access Vlan": vlanId }` for field names containing spaces.
- **Nested list in select**: `{ neighbors: (foreach n in iface.neighbors select n.ip) }`
  — inline comprehension produces a `List<IpAddress>` field.
- **Boolean flags**: `{ violation: someCondition }` — directly use a `Bool` expression.

---

## 6. Expressions

### if-then-else

```nqe
if <condition> then <value>
else if <condition> then <value>
else <default>
```

The entire chain is an expression, usable in `let` or directly in `select`:

```nqe
let srgbBase =
  if device.platform.vendor == Vendor.ARISTA then 90000
  else if device.platform.vendor == Vendor.CISCO then 16000
  else 16000
```

The `else` branch is mandatory — NQE is fully typed, all branches must return the same type.

### when (enum switch)

```nqe
when <enumExpr> is
  CONST1 -> value1;
  CONST2 -> value2;
  otherwise <default>
```

More readable than chained `if` when discriminating on enum values:

```nqe
let parserFn =
  when device.platform.os is
    OS.PAN_OS  -> getPaloAltoNtp(device);
    OS.IOS_XE  -> getCiscoNtp(device);
    OS.EOS     -> getAristaNtp(device);
    otherwise     getGenericNtp(device)
```

Note: the last `otherwise` branch has **no** trailing semicolon.

### Inline list comprehension

A `foreach…select` expression in parentheses produces a `List`:

```nqe
let ips = (foreach addr in sub.ipv4.addresses select addr.ip)
let servers = (foreach s in device.files.config
               where substring(s.text, 0, 4) == "ntp "
               select s.text)
```

This is how you build a list value inside a `let` or `select` field — no `select` output
row is produced, just the list value.

---

## 7. Built-in Functions

### String functions

| Function | Signature | Behavior |
|----------|-----------|----------|
| `substring(s, start, end)` | `(String, Int, Int) → String` | Characters from index `start` (inclusive) to `end` (exclusive). `substring("hello", 0, 3)` → `"hel"`. Used as prefix check: `substring(s, 0, N) == "prefix"`. |
| `prefix(s, n)` | `(String, Int) → String` | First `n` characters. Equivalent to `substring(s, 0, n)`. |
| `suffix(s, n)` | `(String, Int) → String` | Last `n` characters. |
| `length(s)` | `(String) → Int` | Character count. Also works on `List<T>`. |
| `matches(s, pattern)` | `(String, String) → Bool` | **Glob wildcard** match (`*` matches any sequence, `?` matches one char). This is NOT a regex. `matches(device.name, "atl*spine*")` matches any device whose name starts with `atl` and contains `spine`. |
| `replace(s, from, to)` | `(String, String, String) → String` | Literal string substitution (not regex). `replace(vpcId, "/", " ")` replaces slashes with spaces. |
| `join(delim, list)` | `(String, List<String>) → String` | Joins a list of strings with the delimiter. |
| `toString(x)` | `(T) → String` | Converts `Int`, `IpAddress`, `IpPrefix`, enum, etc. to string. Required before string concat with non-string values. |

### Numeric/type conversion

| Function | Signature | Behavior |
|----------|-----------|----------|
| `toNumber(ip)` | `(IpAddress) → Int` | Converts IPv4 address to its 32-bit integer representation. **IPv4 only** — use `isPresent(patternMatch(toString(a), '{ipv4Subnet}'))` to verify IPv4 before calling. Enables arithmetic: `toNumber(addr.ip) % 256` extracts the last octet. |

### IP and network functions

| Function | Signature | Behavior |
|----------|-----------|----------|
| `ipSubnet(ip, prefixLen)` | `(IpAddress, Int) → IpPrefix` | Constructs an `IpPrefix` from an address and prefix length. `ipSubnet(addr.ip, addr.prefixLength)` → `"10.0.0.1/24"`. |
| `networkAddress(prefix)` | `(IpPrefix) → IpAddress` | Returns the network address portion of a prefix. `networkAddress("10.0.1.5/24")` → `"10.0.1.0"`. |
| `broadcastAddress(prefix)` | `(IpPrefix) → IpAddress` | Returns the broadcast address of a subnet. |
| `ipInSubnet(ip, prefix)` | `(IpAddress, IpPrefix) → Bool` | Tests whether an IP is within a subnet. |
| `ipAddressSet(...)` | `(…) → Set<IpAddress>` | Constructs an IP address set; supports set arithmetic (subtraction) for CIDR space calculations. |

### Collection functions

| Function | Signature | Behavior |
|----------|-----------|----------|
| `length(list)` | `(List<T>) → Int` | Number of elements. `length(platform.components)` → component count. |
| `max(list)` | `(List<T>) → Optional<T>` | Maximum element; returns `Optional` (absent if list is empty). Chain with `isPresent()`. Common idiom: `!isPresent(max(ntpServers))` checks whether the list is empty. |
| `join(delim, list)` | `(String, List<String>) → String` | See String functions. |

### Optional / presence

| Function | Signature | Behavior |
|----------|-----------|----------|
| `isPresent(opt)` | `(Optional<T>) → Bool` | Returns `true` if the optional value is present (not absent/null). Used to test fields that may be missing and the result of `patternMatch()`. |

### Config/device functions

| Function | Signature | Behavior |
|----------|-----------|----------|
| `ouiAssignee(mac)` | `(MacAddress) → String` | Looks up the vendor name for a MAC address from its OUI (Organizationally Unique Identifier). |

---

## 8. Pattern Matching

Pattern matching lets you extract structured data from raw text — especially useful for
parsing `device.files.config` and custom command output where fields are not modelled.

### Pattern string syntax

Patterns are **backtick-delimited strings** containing literal text and typed capture groups:

```
`interface {name:string} switchport access vlan {vlan:number}`
```

| Syntax | Meaning |
|--------|---------|
| `{varName:string}` | Capture one whitespace-delimited token as `String` |
| `{varName:number}` | Capture one numeric token as `Int` |
| `{varName:(string*)}` | Capture multiple space-delimited words into a `List<String>` |
| `{field:(string \| empty)}` | Optional capture — matches a token or is absent |
| `{varName:(A \| B)}` | Union pattern — matches either form; only common fields exposed |
| `{!"literal"}` | Negation — line must NOT contain this literal |
| `{string*}` | Wildcard — match remaining text (unnamed) |

Captures become fields accessed via `.data.varName` after a successful match.

### patternMatch

```nqe
patternMatch(text: String, pattern: Pattern) → Optional<{data: {…}}>
```

Tests a **single string** against a pattern. Returns `Optional` — use `isPresent()` to
check success, then access `.data.fieldName` for captures.

```nqe
let m = patternMatch(line.text, `ip address {ip:string} {mask:string}`)
where isPresent(m)
select { ip: m.data.ip, mask: m.data.mask }
```

Common idiom — IPv4 check via patternMatch:
```nqe
let isIPv4 = isPresent(patternMatch(toString(addr.ip), `{ipv4Subnet}`))
```

### patternMatches

```nqe
patternMatches(text: String, pattern: Pattern) → List<{data: {…}}>
```

Like `patternMatch` but returns **all** matches in the text (not just the first). Used
with `foreach` to iterate each match:

```nqe
foreach match in patternMatches(block.text, `neighbor {peer:string} remote-as {asn:number}`)
select { peer: match.data.peer, asn: match.data.asn }
```

For patterns with `|` (union), properties to the left of `|` go to `match.data.left`
and right-side properties go to `match.data.right`.

### blockMatches + parseConfigBlocks

`blockMatches` matches against **hierarchical config block structures**, making it ideal
for Cisco/Arista-style indented config where you need the parent stanza context.

```nqe
parseConfigBlocks(os: OS, text: String) → ConfigBlocks
blockMatches(blocks: ConfigBlocks, pattern: Pattern) → List<{data: {…}}>
```

**Usage with device.files.config** (native config tree — no parseConfigBlocks needed):

```nqe
let pattern = `interface {name:string} switchport access vlan {vlan:number}`
foreach device in network.devices
foreach match in blockMatches(device.files.config, pattern)
select {
  interface:    match.data.name,
  "Access Vlan": match.data.vlan
}
```

**Usage with custom command output** (raw text → parse first):

```nqe
foreach device in network.devices
foreach cmd in device.outputs.commands
where cmd.commandType == CommandType.CONFIG
let parsed = parseConfigBlocks(OS.IOS_XE, cmd.response)
foreach match in blockMatches(parsed, `interface {IntName:string} description {desc:(string*)}`)
select { device: device.name, iface: match.data.IntName, desc: join(" ", match.data.desc) }
```

---

## 9. User-Defined Functions — export / import

Functions can be stored in the NQE Library and imported by other queries, enabling
reusable helper logic.

### Defining an exportable function

```nqe
export functionName(paramName: ParamType, …) =
  <NQE expression returning a value>;
```

The body is any NQE expression — typically a `foreach…select` chain wrapped in
parentheses to produce a list:

```nqe
export getNtpServers(device: Device) =
  (foreach block in device.files.config
   where matches(block.text, "ntp server *")
   select block.text);
```

```nqe
export get_list_match_from_tags(tags: Bag<String>, expectedValues: Bag<String>) =
  max(foreach v in expectedValues where v in tags select v);
```

The function is saved to a Library path (e.g. `Helper Functions/GET NTP Servers`).

### Importing and calling

```nqe
import "Helper Functions/GET NTP Servers";

foreach device in network.devices
let servers = getNtpServers(device)
select {
  device:    device.name,
  violation: !isPresent(max(servers)),
  servers
}
```

Standard library imports use the `@fwd/` prefix:

```nqe
import "@fwd/L3/Interface Utilities";
foreach device in network.devices
foreach iface in getL3Interfaces(device)
select { device: device.name, iface: iface.name }
```

Common `@fwd/` helpers:
- `@fwd/L3/Interface Utilities` → `getL3Interfaces(device)` — all L3 interfaces
- `@fwd/L3/IpAddressUtils` → IP helper predicates
- `@fwd/L3/BGP/BGP Utilities` — BGP helpers
- `@fwd/Security/STIGs/…/util.nqe` — STIG device identification

---

## 10. Parameterized Queries — @query

Introduced in Forward Enterprise 23.11. Allows defining query functions with typed
parameters that the UI or API can supply at runtime:

```nqe
@query query(
  Operating_Systems:    List<OS>,
  Device_Name_Patterns: List<String>,
  Config_Pattern:       PatternBlocks<{}>
) =
foreach device in network.devices
where device.platform.os in Operating_Systems
where matches(device.name, Device_Name_Patterns)
…
```

Parameters appear in the NQE UI as input fields. Via the API, supply them in the
`queryOptions.parameters` field of the POST body.

---

## 11. Comments and Annotations

```nqe
// Single-line comment

/* Multi-line
   block comment */

@intent "Verify CGW RTRs are receiving BGP NLRI for AWS US-EAST-1 Region"
@description "Returns one row per device with a violation flag"
```

`@intent` and `@description` are documentary annotations displayed in the NQE Library UI.
They have no effect on query execution.

---

## 12. Data Model Schema

### network root

```
network.devices                 — List<Device>       all modelled devices
network.cloudAccounts           — List<CloudAccount> AWS / Azure / GCP accounts
```

### device

```
device.name                     — String
device.locationName             — String
device.platform.vendor          — Vendor.*
device.platform.os              — OS.*
device.platform.osVersion       — String
device.platform.model           — String
device.platform.components      — List<Component>    (count with length())

device.interfaces               — List<Interface>
device.files.config             — List<ConfigBlock>  parsed config tree
device.outputs.commands         — List<Command>      custom command outputs
device.networkInstances         — List<NetworkInstance>
device.bgpRib                   — BgpRib
device.hosts                    — List<Host>
device.natEntries               — List<NatEntry>
device.aclEntries               — List<AclEntry>
```

### interface / subinterface / IP

```
iface.name                      — String
iface.description               — String
iface.loopbackMode              — Bool            true for loopback interfaces
iface.operStatus                — OperStatus.*
iface.adminStatus               — AdminStatus.*
iface.mtu                       — Int
iface.interfaceType             — IfaceType.*
iface.routedVlan                — (routed VLAN fields)
iface.subinterfaces             — List<Subinterface>

sub.ipv4.addresses              — List<{ip: IpAddress, prefixLength: Int}>
sub.ipv4.neighbors              — List<{ip: IpAddress, linkLayerAddress: MacAddress}>
sub.ipv6.addresses              — List<{ip: IpAddress, prefixLength: Int}>
```

**Key**: IP addresses live on `subinterfaces`, not directly on `interfaces`. Always
traverse `foreach sub in iface.subinterfaces` before accessing `sub.ipv4.addresses`.

### Config tree (device.files.config)

The config is modelled as a recursive tree of config lines:

```
ConfigBlock {
  text:       String         — the config line text (trimmed, no indentation)
  lineNumber: Int            — line number in the original config file
  children:   List<ConfigBlock>  — nested child lines (indented stanza members)
}
```

Example — finding a specific child line:
```nqe
foreach block in device.files.config
where substring(block.text, 0, 18) == "interface Loopback"
foreach child in block.children
where substring(child.text, 0, 24) == "node-segment ipv4 index "
select { device: device.name, configLine: child.text }
```

### Routing / forwarding

```
device.networkInstances[]
  .name                         — String (VRF name; "default" for global table)
  .afts.ipv4Unicast.ipEntries[]
      .prefix                   — IpPrefix
      .nextHops[]
          .ipAddress            — IpAddress
          .interfaceName        — String
          .originProtocol       — String  ("BGP", "CONNECTED", "STATIC", …)
  .afts.ipv6Unicast.ipEntries[]
  .protocols.bgp.routerId       — IpAddress
```

Checking for a default route:
```nqe
where ipEntry.prefix == ipSubnet("0.0.0.0", 0)
```

### BGP

```
device.bgpRib
  .afiSafis[]
      .neighbors[]
          .neighborAddress      — IpAddress
          .adjRibInPost.routes[]
              .prefix           — IpPrefix
```

### Cloud accounts

```
network.cloudAccounts[]
  .name                         — String
  .vpcs[]
      .id                       — String
      .name                     — String
      .ipv4CidrBlocks           — List<IpPrefix>
      .routeTables[]
      .subnets[]
          .id, .name, .region, .availabilityZone
          .addresses            — List<IpAddress>
          .tags                 — List<{key, value}>
          .routeTableId         — String
```

VPC peering traversal:
```nqe
foreach cloudAccount in network.cloudAccounts
foreach vpc in cloudAccount.vpcs
```

### Custom commands

```
device.outputs.commands[]
  .commandType                  — CommandType.CONFIG | …
  .response                     — String  (raw CLI output text)
```

Use `parseConfigBlocks(OS.IOS_XE, cmd.response)` to parse the raw response before
using `blockMatches`.

---

## 13. Enum Reference

These are the most commonly used enum namespaces and values. The NQE editor's
auto-complete provides the full list in-platform.

### Vendor
```
Vendor.ARISTA
Vendor.CISCO
Vendor.JUNIPER
Vendor.PALO_ALTO
Vendor.FORTINET
Vendor.FORWARD_CUSTOM    -- Forward-defined virtual/cloud devices
```

### OS (Operating System)
```
OS.EOS            -- Arista EOS
OS.IOS            -- Cisco IOS
OS.IOS_XE         -- Cisco IOS-XE
OS.NX_OS          -- Cisco NX-OS
OS.IOS_XR         -- Cisco IOS-XR
OS.JUNOS          -- Juniper JunOS
OS.PAN_OS         -- Palo Alto PAN-OS
OS.FORTIOS        -- Fortinet FortiOS
```

### Interface type
```
IfaceType.IF_TUNNEL_IPSEC
IfaceType.IF_ETHERNET
IfaceType.IF_LOOPBACK
IfaceType.IF_LAG
```

### Status
```
AdminStatus.UP
AdminStatus.DOWN
OperStatus.UP
OperStatus.DOWN
OperStatus.TESTING
```

### Command type
```
CommandType.CONFIG
```

---

## 14. Common Patterns

### Loopback /32 enumeration
```nqe
foreach device in network.devices
foreach iface in device.interfaces
where iface.loopbackMode == true
foreach sub in iface.subinterfaces
foreach addr in sub.ipv4.addresses
where addr.prefixLength == 32
select { device: device.name, loopback: addr.ip }
```

### SR/MPLS SID derivation (from repo)
```nqe
let nodeSidIndex = toNumber(addr.ip) % 256
let prefixSidLabel = srgbBase + nodeSidIndex
```

### Config line prefix check (from repo)
```nqe
where substring(block.text, 0, 18) == "interface Loopback"
```
Because `matches(a, b)` is an exact-match / glob, not a prefix search, use `substring`
for literal prefix comparisons.

### Violation flag pattern
```nqe
select {
  device:    device.name,
  violation: someCondition,    -- Bool; true means non-compliant
  actual:    actualValue,
  expected:  expectedValue
}
```

### Multi-vendor config parsing
```nqe
let parserFn =
  when device.platform.os is
    OS.IOS_XE -> parseIosXeNtp(device);
    OS.EOS    -> parseEosNtp(device);
    otherwise    parseGenericNtp(device)
let servers = parserFn
```

### Interface with IP (L3 helper)
```nqe
import "@fwd/L3/Interface Utilities";
foreach device in network.devices
foreach iface in getL3Interfaces(device)
let ip = (foreach addr in iface.ipv4.addresses select ipSubnet(addr.ip, addr.prefixLength))
select { device: device.name, iface: iface.name, ip }
```

### Group interfaces by status
```nqe
foreach device in network.devices
let deviceName = device.name
foreach iface in device.interfaces
group iface.name as ifaceNames by iface.operStatus as status
select { deviceName, ifaceNames, status }
```

### Deduplication / uniqueness check
```nqe
let grouped = (foreach item in items
               group item.key as grouped by item.key as k
               select { k, count: length(grouped) })
let duplicates = (foreach g in grouped where g.count > 1 select g.k)
```

### Check OS version compliance
```nqe
let approved_os = ["4.15.0F", "4.26.0F"]
foreach device in network.devices
select {
  device:    device.name,
  osVersion: device.platform.osVersion,
  violation: device.platform.osVersion not in approved_os
}
```

### Route table query
```nqe
foreach device in network.devices
foreach vrf in device.networkInstances
foreach ipEntry in vrf.afts.ipv4Unicast.ipEntries
foreach nextHop in ipEntry.nextHops
select {
  device:    device.name,
  vrf:       vrf.name,
  prefix:    ipEntry.prefix,
  nextHopIp: nextHop.ipAddress,
  protocol:  nextHop.originProtocol
}
```

### Pattern match on config text
```nqe
foreach device in network.devices
foreach block in device.files.config
let m = patternMatch(block.text, `router ospf {pid:number}`)
where isPresent(m)
select { device: device.name, ospfPid: m.data.pid }
```

### blockMatches on access VLAN config
```nqe
let pattern = `interface {name:string} switchport access vlan {vlan:number}`
foreach device in network.devices
foreach match in blockMatches(device.files.config, pattern)
select {
  device:       device.name,
  interface:    match.data.name,
  "Access Vlan": match.data.vlan
}
```

---

## 15. Gotchas and Caveats

1. **`matches()` is glob, NOT regex.**  
   `matches("ge-0/0/0", "ge-*")` works (glob wildcard).  
   `matches("ge-0/0/0", "ge-[0-9]+")` does NOT (no regex syntax).  
   For prefix checks, use `substring(s, 0, N) == "prefix"` instead.

2. **`substring(s, start, end)` — end is exclusive.**  
   `substring("hello", 0, 3)` → `"hel"` (chars 0, 1, 2 — not including index 3).

3. **`toNumber()` is IPv4-only.**  
   Calling `toNumber()` on an IPv6 address will produce an error. Guard with:  
   `isPresent(patternMatch(toString(addr.ip), '{ipv4Subnet}'))`.

4. **No `distinct` keyword.**  
   Use `group X by X` then filter on `length(grouped) == 1` to find unique values.

5. **`group-by` narrows the variable scope.**  
   After a `group...by`, only the `as` aliases and `let` bindings declared before the
   group-by are accessible. Bind parent fields with `let` before the group-by.

6. **`patternMatch()` returns `Optional` — access fields on the result, not the Optional.**  
   Always `where isPresent(m)` before using `m.data.fieldName`.

7. **`blockMatches()` result fields are in `.data.fieldName`, not at the top level.**  
   `match.data.name`, not `match.name`.

8. **String concatenation requires matching types.**  
   `"prefix-" + device.name` works.  
   `"index " + 42` fails — must be `"index " + toString(42)`.

9. **IPs live on subinterfaces, not interfaces.**  
   Always go `iface.subinterfaces` → `sub.ipv4.addresses`. There is no
   `iface.ipv4.addresses` shortcut at the interface level.

10. **Config tree children are siblings, not nested.**  
    Under `interface Loopback0`, both `ip address 10.0.0.1/32` and
    `node-segment ipv4 index 1` appear as sibling `children` entries.
    They are NOT hierarchically nested further (for Arista EOS flat stanzas).

11. **Vendor-aware SRGB bases vary.**  
    Arista EOS defaults to SRGB base 90000; Cisco IOS/XR defaults to 16000.
    Never hardcode a base without a vendor check.

---

## 16. API Execution

NQE queries saved to the Library are assigned a `queryId` (e.g. `FQ_ac651cb2901b…`) and
exposed as REST endpoints.

```
POST /api/nqe?networkId=<networkId>

Content-Type: application/json
Authorization: Basic <base64(user:token)>

{
  "queryId": "FQ_ac651cb2901b067fe7dbfb511613ab44776d8029",
  "queryOptions": {
    "offset": 0,
    "limit": 10000
  }
}
```

Response is a JSON array of row objects matching the `select` field names.

**Defaults**: `limit` defaults to 1000. Use `offset` + repeated calls to paginate.  
**Inline queries**: Some API versions accept an `"nqeCode"` field with inline NQE text
instead of a `queryId` — check your platform version's OpenAPI spec at
`GET /api/spec/nqe.yaml`.

The NQE Library query editor also exposes a REST URL for each committed query via the
`⋮ > Get API link` menu.

---

## 17. Sources

All facts in this reference are verified against one or more of the following:

- **Ground-truth repo queries** — `nqe/sr-node-sids.nqe`, `nqe/sr-sid-config-check.nqe`
- [Learn NQE series index](https://community.forwardnetworks.com/learn-nqe-103)
- [NQE foreach and where statements](https://community.forwardnetworks.com/learn-nqe-103/nqe-foreach-and-where-statements-246)
- [NQE let and group-by](https://community.forwardnetworks.com/learn-nqe-103/nqe-let-and-groupby-248)
- [NQE if expressions](https://community.forwardnetworks.com/learn-nqe-103/nqe-if-expressions-247)
- [NQE list data type](https://community.forwardnetworks.com/learn-nqe-103/nqe-list-data-type-244)
- [NQE string data type](https://community.forwardnetworks.com/learn-nqe-103/nqe-using-string-data-type-180)
- [NQE numbers and booleans](https://community.forwardnetworks.com/learn-nqe-103/nqe-numbers-and-booleans-data-types-243)
- [NQE comparison operators](https://community.forwardnetworks.com/nqe-39/nqe-comparison-operators-245)
- [5 IP address tricks in NQE](https://community.forwardnetworks.com/nqe-discussions-39/5-ip-address-tricks-you-might-not-know-in-nqe-605)
- [patternMatch, patternMatches, blockMatches](https://community.forwardnetworks.com/nqe-discussions-39/three-techniques-for-pattern-matching-text-with-patternmatch-patternmatches-and-blockmatches-233)
- [Demystifying group-by (CDP neighbors)](https://community.forwardnetworks.com/nqe-discussions-39/demystifying-group-by-in-nqe-a-practical-guide-with-cdp-neighbors-581)
- [Helper functions (unlocking efficiency)](https://community.forwardnetworks.com/nqe-discussions-39/unlocking-efficiency-with-forward-networks-helper-functions-496)
- [Create an exportable function](https://community.forwardnetworks.com/nqe-discussions-39/create-an-exportable-function-to-validate-a-device-setting-for-any-device-type-523)
- [Reusable function blog post](https://www.forwardnetworks.com/blog/2025/09/30/create-a-reusable-function-to-validate-configuration-settings-across-device-types/)
- [@query new parameterized query functionality](https://community.forwardnetworks.com/top-nqes-63/new-query-functionality-atquery-268)
- [Checking unique values / deduplication](https://community.forwardnetworks.com/nqe-discussions-39/how-to-check-for-unique-values-in-nqe-and-how-to-share-a-query-with-the-community-469)
- [From CLI to NQE (blockMatches example)](https://community.forwardnetworks.com/nqe-discussions-39/from-cli-to-nqe-how-i-use-forward-to-be-a-more-efficient-network-operator-549)
- [Route table entries and next hops](https://community.forwardnetworks.com/nqe-discussions-39/nqe-list-route-table-entries-and-next-hops-270)
- [NQE intent verification (BGP/routing)](https://community.forwardnetworks.com/nqe-discussions-39/using-nqe-to-verify-network-intent-281)
- [IP inventory table NQE](https://community.forwardnetworks.com/top-nqes-63/ip-inventory-table-nqe-365)
- [WAN circuit visibility NQE](https://community.forwardnetworks.com/top-nqes-63/wan-circuit-visibility-358)
- [External data sources (22.5 release)](https://www.forwardnetworks.com/blog/2022/05/31/forward-networks-22-5-release-adds-external-sources-to-provide-a-powerful-data-aggregation-layer-for-comprehensive-testing-and-integration/)
- [AWS VPC subnet enumeration NQE](https://community.forwardnetworks.com/nqe-discussions-39/nqe-query-to-enumerate-aws-vpc-subnets-and-allocation-269)
- [Azure VNet NQE (patternMatch / replace)](https://community.forwardnetworks.com/nqe-discussions-39/nqe-find-azure-vnets-that-are-not-modeled-273)
- [Forward Networks API docs](https://docs.fwd.app/25.12/api-doc/)
