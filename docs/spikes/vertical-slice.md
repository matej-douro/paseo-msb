# Vertical slice spike

Status: static contract verified; VM runtime checks blocked on this host.

Run date: 2026-11-09. Runner: `scripts/spikes/verify-vertical-slice.mjs`.

The spike proves the pinned image, package, and configuration contract without exposing raw
credentials or microsandbox configuration. Guest boot, Pi installation, port publishing,
detached jobs, VM-backed registration, and live secret substitution remain unverified because
this host cannot boot a microsandbox VM.

## Commands

```bash
npm ci
npm run spike:vertical:static
npm run spike:vertical:contract
npm run spike:vertical:regression
npm run spike:vertical
```

`--static-only` verifies pins, image layers, package metadata, and the built sandbox contract.
It exits zero only when no static check fails. Runtime groups remain blocked.

`spike:vertical:regression` checks report classification, isolated-daemon temp-home cleanup,
controlled-HTTPS certificate cleanup, and the configured disallowed destination. It does not
boot a guest.

`npm run spike:vertical` runs the parent-daemon contract and then attempts the VM-backed suite.
It exits nonzero whenever any acceptance group is blocked or failed.

The runner uses only fake credential values. It starts isolated Paseo daemons in temporary homes
with a sanitized environment and does not read or forward host credentials.

## Pins

| Component | Pin |
| --- | --- |
| Paseo parent daemon and CLI | `0.15.0` |
| microsandbox SDK | `0.7.14` |
| microsandbox runtime | `0.7.14`, resolved from the platform package |
| libkrunfw | `5.6.1` |
| Guest image | `ghcr.io/getpaseo/paseo:0.15.0` |
| Image index digest | `sha256:b2ea682ad520518f027bf6e6ed2e1c94f2de4a60b23ef31098a60dd64c09c7f8` |
| `linux/amd64` manifest | `sha256:012e62d54de93f3f3e846d7fe1aa12c5472c8f00bc5290acb6b0076442aa8bce` |
| `linux/arm64` manifest | `sha256:93646309f75c4201afd79c1c04049f7ec7df228d2a9de09556d0b35f014fed1b` |
| Guest Node | `22.23.4` |
| Guest npm | `10.9.9` |
| Pi package | `@earendil-works/pi-coding-agent` `1.5.0` |
| Pi integrity | `sha512-xNDZ5kqowO6Z03FS2gwAkPEGk1ssxVcYKQ6qZId84mFEvwACvvyc2l0vAMOS+c5zvxLRMLBE9r4y44IGYkMJaQ==` |
| Pi engine floor | `>=22.19.0` |
| Pi install prefix | `/home/paseo/.npm-global` |
| Fixed resources | 2 CPUs, 2048 MiB, guest port `6767`, loopback publish |

## Static results

`npm run spike:vertical:static` on 2026-11-09 reported 12 static passes, no failures, and five
blocked runtime groups.

| Check | Result | Evidence |
| --- | --- | --- |
| `pins.packages` | pass | manifest and lockfile match |
| `pins.node` | pass | local Node `26.13.0`, above the engine floor |
| `pins.image` | pass | tag digest and `linux/arm64` manifest match; 12 layers scanned |
| `pins.image-runtime` | pass | guest Node and npm match the pins |
| `pins.image-init` | pass | zero init candidates; tini and Paseo entrypoint present |
| `pins.pi` | pass | version, integrity, and engine match the npm registry |
| `pins.microsandbox` | pass | SDK, runtime, and libkrunfw match the pins |
| `pins.parent-cli` | pass | Paseo CLI `0.15.0` |
| `pins.config-contract` | pass | 2 CPUs, 2048 MiB, guest port 6767, loopback bind, five header-only credential entries, no password environment entry, fallback init |
| `init.auto-accepted` | pass | the builder records the auto init strategy |
| `init.auto-config` | pass | the image comparison config builds |
| `init.auto-unavailable` | pass | the image scan found no init auto candidates |

The official image contains none of the init binaries probed by `init("auto")` on this platform.
It has tini and the Paseo entrypoint, so the narrowed fallback is:

```text
/usr/bin/tini -- /usr/local/bin/paseo-docker-entrypoint
```

This is a boot strategy fallback only. It does not add product scope.

## Parent daemon contract

`npm run spike:vertical:contract` also passed six host-daemon checks:

| Check | Result |
| --- | --- |
| standalone child daemon reports Pi | pass |
| `hosts.add` persists sourceKey and metadata | pass |
| routed child reaches online | pass |
| routed `providers.refresh()` sees Pi | pass |
| registration survives a parent-daemon restart | pass |
| `hosts.remove` removes the registration | pass |

These use isolated host daemons, not a microsandbox guest. They verify the parent API contract
and routing behavior that the VM-backed runner will consume. Each isolated daemon owns a
temporary home, and the contract removes those homes and the controlled HTTPS certificate
directory after both successful and failed startup.

## Acceptance status

- [x] Record the image digest, parent daemon version, microsandbox SDK/runtime versions, and Pi version.
- [ ] Verify guest Node >= 22.19, npm, `init("auto")`, non-root global Pi installation, and Pi on the daemon user PATH. Blocked: guest could not boot.
- [ ] Verify loopback publishing with host port `0` and release after stop. Blocked: guest could not boot.
- [ ] Verify detached survival, stable-ID replacement checks, persisted labels/config/logs, and detached-job inspection after restarts. Blocked: guest could not boot.
- [ ] Verify a loopback child without a password, routed online, `hosts.remove`, and Pi detection after `providers.refresh()`. The host-daemon contract passed; the VM-backed path is blocked.
- [ ] Verify header-only substitution and blocked-destination behavior at runtime. Static policy checks passed; live substitution is blocked.
- [x] Record results and the narrow fallback in this document.

## Blockers

1. `/dev/kvm` is absent and inaccessible on this Linux `aarch64` host. The CPU exposes no
   virtualization flags. The microsandbox SDK requires Linux with KVM, so sandbox creation cannot
   start. This blocks every runtime acceptance group.
2. Because no VM boots, the spike cannot verify the guest-side Pi install, daemon-user PATH,
   published-port behavior, detached jobs, VM-backed registration, or live secret substitution.
3. The parent-daemon contract runs on host daemons only. It does not replace the VM-backed checks.

The full runner reports these as blocked, not passed, and exits nonzero. No runtime success is
claimed.

## Re-running when unblocked

Run on a Linux host with accessible KVM, the same pinned image, and the pinned Paseo CLI:

```bash
npm ci
npm run spike:vertical -- --json
```

The VM suite creates one detached pinned sandbox, verifies guest Node and npm, installs the pinned
Pi package as the non-root daemon user, starts a detached install job, observes it from a second
process, registers the child with an isolated parent, refreshes Pi through the routed client,
restarts the parent, removes the registration, checks secret placeholders and header-only request
handling against a controlled HTTPS endpoint, stops the sandbox to verify port release, and tests
stable-ID replacement protection. It then removes its sandbox. The blocked-destination probe
resolves a host outside the secret allowlist to the same controlled upstream through a guest
hosts alias, so only a secret-policy denial can keep the request from being observed.

A successful run must report every acceptance group as `pass`. Until then, the runtime bar in
TASKS.md remains open.
