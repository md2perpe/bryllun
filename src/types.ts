export type NodeType = "group" | "scalar" | "table";

export interface MibNode {
  id: string;
  label: string;
  /** Absolute dotted OID, or "" if it couldn't be resolved. */
  oid: string;
  resolved: boolean;
  type: NodeType;
  children?: MibNode[];
}

export interface FileErrors {
  file: string;
  errors: string[];
}

/** Every file found under one configured MIB directory (including subdirectories). */
export interface DirFiles {
  dir: string;
  files: string[];
}

export interface ParseResult {
  tree: MibNode[];
  /** Alternate view: every table as a root, its columns as children. */
  tablesTree: MibNode[];
  errors: FileErrors[];
  dirFiles: DirFiles[];
}

export interface MibProfile {
  id: string;
  name: string;
  dirs: string[];
}

export interface MibProfilesResponse {
  profiles: MibProfile[];
  activeProfileId: string;
}

/** A YANG schema tree node - the gNMI-side counterpart to `MibNode`, built from local `.yang` files instead of a live Get. */
export interface YangNode {
  id: string;
  label: string;
  /** Absolute gNMI xpath-style path, or "" for a node that isn't itself a valid fetch target (an unresolved `uses`). */
  path: string;
  resolved: boolean;
  type: NodeType;
  children: YangNode[];
}

export interface YangParseResult {
  tree: YangNode[];
  errors: FileErrors[];
  dirFiles: DirFiles[];
}

export interface YangProfile {
  id: string;
  name: string;
  dirs: string[];
}

export interface YangProfilesResponse {
  profiles: YangProfile[];
  activeProfileId: string;
}

/** The NETCONF-side counterpart to `YangProfile` - a separate named set of `.yang` directories,
 * not shared with gNMI's (see the Rust `NetconfYangProfile`'s doc comment). */
export interface NetconfYangProfile {
  id: string;
  name: string;
  dirs: string[];
}

export interface NetconfYangProfilesResponse {
  profiles: NetconfYangProfile[];
  activeProfileId: string;
}

export interface HostProfile {
  id: string;
  label: string;
  addr: string;
  port: string;
  community: string;
  v3User: string;
}

export type SnmpVersion = "v1" | "v2c" | "v3";

/** The connection half of an SNMP request, as the Rust `ConnectionParams` expects it. */
export interface ConnectionParams {
  hostAddr: string;
  hostPort: string;
  version: SnmpVersion;
  community: string;
  v3User: string;
  v3Auth: string;
  v3Priv: string;
}

export type Theme = "dark" | "classic";

/** A fetched row's columns are whatever the selected MIB table defines - not fixed ahead of time. */
export type Row = Record<string, string>;

export type RowStatus = "added" | "removed" | "changed";

export interface RowMetaEntry {
  status: RowStatus;
  fields?: string[];
}

export type ColWidths = Record<string, number>;

/** What a query tab's Fetch runs: a table walk (or scalar GET) picked by the node's type, or an explicit single GET/GETNEXT. */
export type SnmpOp = "fetch" | "get" | "getnext";

export interface TabState {
  kind: "query";
  id: string;
  hostId: string;
  hostAddr: string;
  hostPort: string;
  version: SnmpVersion;
  community: string;
  v3User: string;
  v3Auth: string;
  v3Priv: string;
  selectedNode: string;
  /** Set to "get"/"getnext" by the tree's context menu; plain "fetch" otherwise. */
  snmpOp: SnmpOp;
  /** Column order from the last successful fetch; empty until the first fetch. */
  columns: string[];
  /** DISPLAY-HINT per column that has one (e.g. "d-1"), from the last successful fetch. */
  displayHints: Record<string, string>;
  /** Named values per column with an enumerated SYNTAX (e.g. "2" -> "ok"), from the last successful fetch. */
  enumLabels: Record<string, Record<string, string>>;
  sortCol: string;
  sortDir: 1 | -1;
  colWidths: ColWidths;
  autoRefresh: boolean;
  lastFetch: string;
  diffMode: boolean;
  /** When true, table column headers show a humanized form (shared prefix stripped, camelCase split into title-cased words) instead of the raw MIB identifier. */
  humanReadableColumns: boolean;
  /** When true, numeric values in a column with a DISPLAY-HINT (e.g. "d-1") are shown reformatted (123 -> 12.3) instead of raw. */
  useDisplayHints: boolean;
  /** When true, the table is shown transposed: one column per fetched row, one row per MIB column - handy for a table with many columns but few rows. */
  transposed: boolean;
  workingRows: Row[];
  rowMeta: Record<string, RowMetaEntry>;
  removedGhosts: Row[];
  fetchError: string | null;
}

/** One completed walk of a benchmark run, as timed by the backend. */
export interface WalkTiming {
  durationMs: number;
  varbinds: number;
  requests: number;
  /** True when the backend's iteration cap cut the walk short, so its timing covers only part of the subtree. */
  truncated: boolean;
}

/** A pane tab dedicated to timing repeated walks of one OID subtree - its own connection fields, independent of any query tab. */
export interface BenchmarkTabState {
  kind: "benchmark";
  id: string;
  nodeLabel: string;
  oid: string;
  hostAddr: string;
  hostPort: string;
  version: SnmpVersion;
  community: string;
  v3User: string;
  v3Auth: string;
  v3Priv: string;
  /** How many walks a run performs; editable while idle. */
  iterations: number;
  running: boolean;
  /** Set by "Stop": the in-flight walk still finishes (it can't be aborted), then the run ends. */
  cancelling: boolean;
  /** Timings of the walks that succeeded. */
  runs: WalkTiming[];
  /** Walks that failed (a dropped packet, a timeout); they're counted but have no timing to report. */
  failures: number;
  /** The most recent walk failure's message, kept on screen for the rest of the run. */
  error: string | null;
}

export type TlsMode = "insecure" | "tls" | "tlsSkipVerify";

/** The connection half of a gNMI request, as the Rust `gnmi::GnmiConnectionParams` expects it. */
export interface GnmiConnectionParams {
  hostAddr: string;
  hostPort: string;
  tlsMode: TlsMode;
  caCertPath: string | null;
  clientCertPath: string | null;
  clientKeyPath: string | null;
  username: string | null;
  password: string | null;
}

/** One element of a decoded gNMI Get result tree - a path segment, its value (present on leaves), and any children. */
export interface GnmiNode {
  name: string;
  value: string | null;
  children: GnmiNode[];
}

/** A pane tab dedicated to browsing a gNMI target's Capabilities and running one-shot Get requests against a manually-typed path - its own connection fields, independent of any SNMP query tab. */
export interface GnmiTabState {
  kind: "gnmi";
  id: string;
  hostAddr: string;
  hostPort: string;
  tlsMode: TlsMode;
  caCertPath: string;
  clientCertPath: string;
  clientKeyPath: string;
  username: string;
  password: string;
  /** Manually-typed gNMI xpath-style path, e.g. "/interfaces/interface[name=eth0]/state". */
  path: string;
  /** Last successful Capabilities response, or null before the first call. */
  capabilities: GnmiCapabilities | null;
  /** Last successful Get result's roots, or null before the first fetch. */
  result: GnmiNode[] | null;
  /** Tree-expand state for `result`, keyed by each node's path-so-far. */
  expandedIds: Record<string, boolean>;
  loading: boolean;
  fetchError: string | null;
  lastFetch: string;
}

/** A target's advertised gNMI version, encodings, and supported YANG models, from the Capabilities RPC. */
export interface GnmiCapabilities {
  gnmiVersion: string;
  supportedEncodings: string[];
  supportedModels: { name: string; organization: string; version: string }[];
}

/** The connection half of a NETCONF request (SSH, password auth only in Phase 1), as the Rust `netconf::NetconfConnectionParams` expects it. */
export interface NetconfConnectionParams {
  hostAddr: string;
  hostPort: string;
  username: string;
  password: string;
}

/** One element of a decoded NETCONF `<get>` reply tree - the NETCONF-side counterpart to `GnmiNode`. */
export interface NetconfNode {
  name: string;
  value: string | null;
  children: NetconfNode[];
}

/** A target's advertised NETCONF session id and capability URIs, from the `<hello>` exchange. */
export interface NetconfCapabilities {
  sessionId: string;
  capabilities: string[];
}

/** A pane tab dedicated to browsing a NETCONF target over SSH: a `<hello>` capabilities check and
 * one-shot `<get>` requests filtered by an XPath path staged from the shared YANG tree - the
 * NETCONF counterpart to `GnmiTabState`. */
export interface NetconfTabState {
  kind: "netconf";
  id: string;
  hostAddr: string;
  hostPort: string;
  username: string;
  password: string;
  /** Manually-typed XPath-style path, e.g. "/interfaces/interface[name='eth0']"; "/" fetches the whole datastore. */
  path: string;
  /** Last successful `<hello>` capabilities, or null before the first call. */
  capabilities: NetconfCapabilities | null;
  /** Last successful `<get>` result's roots, or null before the first fetch. */
  result: NetconfNode[] | null;
  /** Tree-expand state for `result`, keyed by each node's path-so-far. */
  expandedIds: Record<string, boolean>;
  loading: boolean;
  fetchError: string | null;
  lastFetch: string;
}

export interface TrapVarbind {
  oid: string;
  /** MIB-resolved name (e.g. "ifDescr.3"), or the same as `oid` when nothing matched. */
  name: string;
  value: string;
  /** DISPLAY-HINT declared on this varbind's MIB type, if any (e.g. "d-1"). */
  displayHint?: string;
  /** Enumerated-value labels keyed by the raw integer as a string (e.g. "2" -> "ok"). */
  enumLabels?: Record<string, string>;
}

export interface TrapEvent {
  seq: number;
  timeMs: number;
  /** "ip:port" the packet arrived from. */
  source: string;
  version: string;
  /** Community string (v1/v2c) or security user name (v3). */
  principal: string;
  trapType: string;
  trapOid: string;
  varbinds: TrapVarbind[];
  /** True for an SNMPv2c/v3 Inform, which RFC 3416 expects to be acknowledged; this listener never sends that ack. */
  confirmed: boolean;
  error: string | null;
}

export interface TrapListenerStatus {
  running: boolean;
  boundAddr: string;
}

export interface TrapTabState {
  kind: "trap";
  id: string;
  bindAddr: string;
  port: string;
  version: SnmpVersion;
  /** v1/v2c only: exact community a packet must carry to be accepted; empty accepts any. */
  community: string;
  v3User: string;
  v3Auth: string;
  v3Priv: string;
  running: boolean;
  /** The actual bound "ip:port" once started (e.g. after binding port 0). */
  boundAddr: string;
  /** Set when the last start attempt failed (bad address, port in use, ...). */
  startError: string | null;
  events: TrapEvent[];
  /** Highest event `seq` already merged in, so polling only asks for what's new. */
  lastSeq: number;
  expandedSeq: number | null;
  filterText: string;
  /** When true, varbind values are shown with a DISPLAY-HINT formatted or an enumerated value named, instead of raw. */
  useDisplayHints: boolean;
}

export type AnyTabState = TabState | TrapTabState | BenchmarkTabState | GnmiTabState | NetconfTabState;

export interface PaneState {
  id: string;
  /** Fixed pixel width; null means "flexible" (always true for the last pane). */
  width: number | null;
  /** null when the pane has no tabs open. */
  activeTabId: string | null;
  tabs: AnyTabState[];
}

export interface AppState {
  expanded: Record<string, boolean>;
  /** Id of the tree row highlighted by a single click; independent of any tab's `selectedNode` (which a double-click sets). */
  selectedTreeNodeId: string;
  /** When true, the sidebar shows only tables (as roots) with their columns as children, instead of the full group hierarchy. */
  tablesOnlyMode: boolean;
  /** Named sets of MIB directories (e.g. one per software release) - only the active one's directories are parsed. */
  mibProfiles: MibProfile[];
  activeMibProfileId: string;
  /** Inline text-entry draft for adding a MIB directory outside Tauri (no native picker there); null when not editing. */
  mibDirDraft: string | null;
  /** Inline text-entry draft for naming a new MIB profile; null when not editing. */
  mibProfileDraft: string | null;
  /** True while the active MIB profile's name is being edited inline. */
  renamingMibProfile: boolean;
  parseErrors: FileErrors[];
  parseErrorsOpen: boolean;
  /** Named sets of YANG directories, mirroring `mibProfiles` - only the active one's directories are parsed for the gNMI schema tree. */
  yangProfiles: YangProfile[];
  activeYangProfileId: string;
  yangDirDraft: string | null;
  yangProfileDraft: string | null;
  renamingYangProfile: boolean;
  yangParseErrors: FileErrors[];
  yangParseErrorsOpen: boolean;
  /** Id of the YANG tree row highlighted by a single click - the YANG counterpart to `selectedTreeNodeId`. */
  selectedYangNodeId: string;
  /** The NETCONF-side counterpart to `yangProfiles` and its surrounding UI state - kept entirely
   * separate rather than shared with gNMI's, since a target's NETCONF YANG modules commonly come
   * from a different directory than what's loaded for gNMI (see the Rust `NetconfYangProfile`). */
  netconfYangProfiles: NetconfYangProfile[];
  activeNetconfYangProfileId: string;
  netconfYangDirDraft: string | null;
  netconfYangProfileDraft: string | null;
  renamingNetconfYangProfile: boolean;
  netconfYangParseErrors: FileErrors[];
  netconfYangParseErrorsOpen: boolean;
  selectedNetconfYangNodeId: string;
  /** Whether the "SNMP (MIB)" sidebar section (profile/directories/tree) is collapsed to just its header. */
  mibSectionCollapsed: boolean;
  /** Explicit height (px) of the MIB tree area, dragged via the splitter below it. Ignored (the
   * section fills whatever space remains instead) when this is the last expanded sidebar section -
   * the same "explicit except for the trailing flexible one" convention `PaneState.width` uses. */
  mibTreeHeight: number;
  /** The gNMI/NETCONF YANG sections' counterparts to the two fields above. */
  yangSectionCollapsed: boolean;
  yangTreeHeight: number;
  netconfYangSectionCollapsed: boolean;
  netconfYangTreeHeight: number;
  leftWidth: number;
  leftCollapsed: boolean;
  panes: PaneState[];
  activePaneId: string;
  /** Right-click context menu on a tree node (MIB, gNMI's YANG, or NETCONF's YANG); null when closed. */
  treeContextMenu: { x: number; y: number; nodeId: string; kind: "mib" | "yang" | "netconf-yang" } | null;
  /** Fetch mode dropdown (manual vs. auto-refresh) for a pane's split button; null when closed. */
  refreshMenu: { paneId: string; x: number; y: number } | null;
  /** Export-format dropdown (CSV vs. PNG) for a pane's export button; null when closed. */
  exportMenu: { paneId: string; x: number; y: number } | null;
  theme: Theme;
  /** Theme picker dropdown; null when closed. */
  themeMenu: { x: number; y: number } | null;
  /** State of the in-app auto-updater (see update.ts); null until a check finds something worth showing. */
  updateStatus: UpdateStatus | null;
}

/** Lifecycle of an in-app update, driving the sidebar's update icon. */
export type UpdateStatus =
  | { phase: "available"; version: string; body: string | null }
  | { phase: "downloading"; version: string; downloaded: number; contentLength: number | null }
  | { phase: "ready"; version: string }
  | { phase: "error"; message: string };
