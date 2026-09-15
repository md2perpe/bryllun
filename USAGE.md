# Bryllun — Usage Guide

A desktop app (macOS, Windows, Linux) for browsing MIB and YANG files and
polling live values from SNMP- and gNMI-managed devices (switches, routers,
and similar network equipment). It can also listen for SNMP traps and
informs.

## Installing

1. Open the `.dmg` file and drag **Bryllun** into **Applications**.
2. On first launch, macOS will likely refuse to open it with an "Apple could
   not verify this app is free of malware" warning — the app isn't signed
   with a paid Apple Developer certificate. To open it anyway:
   - Right-click (or Control-click) the app in Applications → **Open** →
     confirm **Open Anyway** in the dialog that appears.
   - Or: **System Settings → Privacy & Security**, scroll down to the
     blocked-app notice, and click **Open Anyway**.

   You only need to do this once — after the first approval, it opens
   normally like any other app.

## The window, at a glance

- **Left sidebar** — two stacked sections: **SNMP (MIB)** (the MIB
  directories you've configured, and the OID tree parsed from them) and
  **YANG (gNMI)** below it (the same, for `.yang` directories and their
  schema tree).
- **Right side** — one or two panes, each with its own tabs. Each tab is an
  independent connection to a device — a query tab (table or scalar), a
  gNMI tab, a benchmark tab, or a trap listener tab.

## Getting started

### 1. Add a MIB directory

MIB directories live in **profiles** — useful if you track MIBs for more
than one release of your software, since only one profile's directories are
parsed at a time and switching between them is instant:

- The dropdown at the top of the sidebar switches the active profile.
- **✎** renames the active profile; **×** deletes it (only shown once you
  have more than one).
- **+** creates a new, empty profile and switches to it — name it (e.g.
  `v4.0`), then add its directories as below. A fresh install starts with
  one profile named "Default".

Within the active profile, click the **+** above the MIB directory list and
choose a folder containing your `.mib` files. Every directory you add is
parsed immediately (searched recursively, so subdirectories are included)
and its contents appear in the tree below; add as many as you need; remove
one with the **×** next to it. If any files fail to parse, a warning banner
appears — click it to see which files and what went wrong.

### 2. Browse the tree

- **Tree** mode (default) shows the full group hierarchy, exactly as the
  MIBs define it — click the caret to expand/collapse a branch.
- **Tables** mode flattens the view to just the SNMP tables, each listed as
  a root with its columns underneath — useful when you know you want a
  specific table and don't want to hunt through the group hierarchy.

Single-clicking a row just highlights it. **Double-click a table to open
it in a new tab.** Scalars don't open on double-click — right-click one
instead and choose "Open in new tab" from the context menu. Right-clicking
a table offers the same item. Any resolvable node, groups included, also
offers "Benchmark" from that menu — see [below](#6-benchmark-a-walk).

### 3. Set the connection details

Each tab has its own connection fields at the top:

| Field | Notes |
|---|---|
| Address | Hostname or IP of the device |
| Port | Defaults to `161` (standard SNMP) |
| Version | `v1`, `v2c`, or `v3` |
| Community | For v1/v2c — defaults to `public` |
| Security User / Auth / Priv | For v3 only, replaces Community |

### 4. Fetch data

The **Fetch** button is disabled until a node is selected and the
connection fields above are filled in — hover it to see what's missing.

Click the small chevron next to Fetch to choose the fetch mode:
- **Manual** (default) — fetch only when you click the button.
- **Auto-refresh (10s)** — fetches every 10 seconds; the chevron turns into
  a small ring that drains down to empty as the next fetch approaches.

### 5. Read the results

- Click a column header to sort by it; click again to reverse.
- Drag a column's right edge to resize it.
- **Diff mode** highlights what changed between fetches — added rows in
  green, removed rows struck through in red, changed cells in yellow. Handy
  when watching a table for changes over time with auto-refresh on.
- **Readable names** turns raw MIB identifiers like
  `dcpLinkviewLocalHostname` into `Local Hostname` in the column headers
  (strips the shared table-name prefix, splits the rest into words).
- **Display hint** reformats numeric columns whose MIB defines a DISPLAY-HINT
  (e.g. `d-1`, meaning "insert a decimal point one digit from the right") —
  a raw `123` shows as `12.3`. A column header's tooltip says whether it has
  one; a reformatted cell's tooltip shows the original raw value. Columns
  without a hint, or with a hint this doesn't recognize (only the numeric
  `d`/`d-N` form is supported), are unaffected either way.
- Status-like values (`up`/`down`/etc.) get a colored dot for a quick read.

### 6. Benchmark a walk

**Benchmark** times repeated SNMP walks of a node's subtree, to see how fast
— and how consistently — a device serves it. It's its own kind of tab,
separate from a query tab, with its own connection fields.

Right-click a node in the tree and choose **Benchmark** to open one, aimed
at that node. Fill in the connection fields, choose how many walks to run
(10 by default, up to 1000), and click **Run**; results fill in as each walk
finishes, and **Stop** ends the run early (the walk already in flight
finishes first).

You get **min**, **median**, **mean**, **P95**, **max** and **standard
deviation** over the run, the varbind and request counts per walk, and a bar
per walk with the fastest one in green and the slowest in yellow.

Worth knowing:
- Unlike Fetch, this works on **group nodes** too — any node with a
  resolvable OID can be walked, so you can time a whole subtree, not just a
  single table or scalar.
- Timing covers the walk itself. Opening the session (including SNMPv3
  engine discovery) happens before the clock starts, so every run measures
  the same work.
- Each walk uses a fresh session, one at a time, so runs don't contend with
  each other. Expect the first run to be the slowest.
- SNMP rides on UDP, so a dropped packet shows up as a failed walk. Failures
  are counted and reported but don't abort the run or skew the statistics —
  unless the very first walk fails, which means nothing is reachable and
  there's nothing to measure.

### 7. Browse YANG and query a gNMI target

The **YANG (gNMI)** section, below the MIB section in the sidebar, works the
same way as MIB directories: pick a profile (or create one), click **+** to
add a directory of `.yang` files, and its modules parse immediately into a
schema tree.

To query a target:

- Click the connected-nodes icon in a pane's tab bar to open a **gNMI** tab
  — it's independent of any SNMP query tab, with its own connection fields.
- Fill in **Address**, **Port** (defaults to `57400`), and **TLS** mode
  (**Insecure**, **TLS**, or **Skip Verify** for a self-signed certificate
  the target can't otherwise be verified against — providing a **CA Cert
  Path** switches back to full verification). **Skip Verify** accepts any
  server certificate and disables certificate validation, so prefer **CA
  Cert Path** for self-signed targets when possible. **Username**/**Password**
  are optional, for targets that require them — avoid **Insecure** when
  credentials are set, since it sends them, and all other traffic,
  unencrypted; use **TLS** (with certificate validation) instead.
- Click **Capabilities** to see the target's advertised gNMI version,
  encodings, and supported YANG models.
- Type a path into the **Path** field (e.g.
  `/interfaces/interface[name=eth0]/state`) and click **Get** — or, instead
  of typing, double-click a node in the YANG tree to open it straight into a
  new gNMI tab, or single-click one to stage its path into the active gNMI
  tab. Results render as an expandable tree; double-clicking a result row
  re-fetches with that row's path.

This is a one-shot Get, not a subscription — there's no live streaming or
Set support yet, and walk benchmarking (see above) is SNMP-only.

### 8. Listen for traps and informs

Click the broadcast-tower icon in a pane's tab bar to open a **Trap
Listener** tab. Fill in a **Bind Address** (`0.0.0.0` by default, to listen
on every interface), **Port** (`162` by default — the standard trap port,
which needs elevated privileges on most systems unless you pick a port
above 1024), and **Version**. For v1/v2c, **Community** restricts which
community string is accepted (blank accepts any); for v3, fill in
**Security User**/**Auth**/**Priv** instead. Click **Listen** to start (the
fields lock while running) and **Stop** to end it.

Once listening, a hint shows the local IP addresses you can point a
device's trap destination at — click one to copy it. Received traps and
informs appear newest-first, decoded and labeled against your parsed MIBs;
click a row to expand its varbinds. Use the filter box to search by source,
community/user, or trap name; toggle **Display hint** to format varbind
values the same way query tabs do; **Clear** empties the log.

## Working with tabs and panes

- Double-clicking a table in the sidebar opens it in a new tab in the active
  pane; right-click any resolvable node for "Open in new tab" (scalars and
  tables) or "Benchmark" (any resolvable node, groups included).
- The two icons at the right of a pane's tab bar open a new **trap
  listener** or **gNMI** tab in that pane, independent of the sidebar tree.
- **×** on a tab closes it.
- **⊟** splits the pane in two, side by side (up to two panes) — handy for
  comparing two tables, or the same table on two devices, at once.
- **✕** on a split pane merges back down to one.
- Switch between a pane's tabs with the keyboard: **Ctrl+Tab** /
  **Ctrl+Shift+Tab**, or **⌘+Shift+]** / **⌘+Shift+[** — either pair cycles
  forward/backward and wraps around at the ends.

## A couple of things worth knowing

- A table's index column (e.g. `dcpLinkviewIndex`) is intentionally never
  shown as its own column — SNMP agents don't return values for it during a
  table walk, so its value only ever appears in the **Index** column, which
  is where you'll find it.
- MIB and YANG profiles and their directories are remembered between
  launches; connection details (address/port/etc.) are per-tab and are not
  saved once a tab is closed.
