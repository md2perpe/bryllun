# Bryllun

A desktop app for browsing MIB and YANG files and polling live values from SNMP-, gNMI-, and NETCONF-managed devices — switches, routers, and similar network equipment.

Point it at your MIB or YANG directories and it parses them into a browsable tree; pick a scalar, table, or path, connect to a device (SNMPv1/v2c/v3, gNMI, or NETCONF), and fetch live values in a sortable, diffable table view.

## Features

- **MIB parsing** — recursively parses `.mib` files in one or more directories and builds the group/table hierarchy; flags files that fail to parse.
- **Profiles** — group MIB directories into named profiles (e.g. per firmware version) and switch between them instantly.
- **Tree and Tables views** — browse the full group hierarchy, or flatten straight to SNMP tables.
- **Tabs and split panes** — open multiple tables/scalars in tabs, across up to two side-by-side panes, to compare devices or tables at once.
- **SNMPv1/v2c/v3** — per-tab connection settings, including v3 security/auth/priv.
- **Manual or auto-refresh** fetching, with a **diff mode** that highlights added/removed/changed rows between fetches.
- **Readable column names** and **DISPLAY-HINT-aware formatting** for raw MIB identifiers and numeric values.
- **Walk benchmark** — time repeated SNMP walks of any subtree and see min/median/mean/P95/max/std dev across the runs.
- **gNMI support** — browse a target's advertised Capabilities and run Get requests against any path, over TLS (with an optional skip-verify mode).
- **NETCONF support** — browse a target's advertised `<hello>` capabilities and run `<get>` requests over SSH, filtered by an XPath path built from the same YANG tree gNMI uses.
- **YANG parsing** — parses `.yang` directories into a browsable path tree, shared by both gNMI and NETCONF.
- **Trap and inform listener** — listen for SNMPv1/v2c/v3 traps and informs, decoded live and labeled against your parsed MIBs, with a filterable event log.

See [USAGE.md](USAGE.md) for a full walkthrough.

## Tech stack

- **Frontend**: TypeScript + [Vite](https://vitejs.dev/), no framework.
- **Backend**: [Tauri 2](https://tauri.app/) (Rust), using [`snmp2`](https://crates.io/crates/snmp2) for SNMP, [`tonic`](https://github.com/hyperium/tonic)/`prost` for gNMI over gRPC, [`russh`](https://github.com/Eugeny/russh)/`quick-xml` for NETCONF over SSH, and [`tree-sitter`](https://tree-sitter.github.io/tree-sitter/) with custom ASN.1 and YANG grammars to parse MIB and YANG files.

## Development

Prerequisites: [Node.js](https://nodejs.org/), [Rust](https://www.rust-lang.org/tools/install), and the [Tauri](https://tauri.app/start/prerequisites/) platform dependencies for your OS.

```sh
npm install
npm run tauri dev   # run the app in development mode
```

Other scripts:

```sh
npm run dev          # Vite dev server only (frontend)
npm run build         # type-check and build the frontend
npm run tauri build   # build a distributable app bundle
```

## Releases

Pushing to `main` with a bumped version in `src-tauri/tauri.conf.json` triggers a GitHub Actions build for macOS, Linux, and Windows, and publishes a draft release.

## License

[MIT](LICENSE)
