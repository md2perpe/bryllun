import { el, startDrag, startDragY, svgIcon } from "./dom";
import { exportTableCsv, exportTablePng } from "./export";
import { DEFAULT_COL_WIDTH } from "./mockData";
import { computeStats, type Store } from "./state";
import type {
  BenchmarkTabState,
  FileErrors,
  GnmiNode,
  GnmiTabState,
  MibNode,
  NetconfNode,
  NetconfTabState,
  NodeType,
  PaneState,
  Row,
  RowStatus,
  SnmpVersion,
  TabState,
  Theme,
  TlsMode,
  TrapEvent,
  TrapTabState,
  TrapVarbind,
  YangNode,
} from "./types";

const THEME_OPTIONS: { id: Theme; label: string }[] = [
  { id: "dark", label: "Dark" },
  { id: "classic", label: "Classic Light" },
];

/** Standard "sidebar" icon (rounded panel outline with a left-panel divider), used to toggle the sidebar. */
function sidebarToggleIcon(): SVGSVGElement {
  return svgIcon('<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/>');
}

/** Standard "chevron down" icon, used for the fetch-mode dropdown trigger. */
function chevronDownIcon(): SVGSVGElement {
  return svgIcon('<path d="M6 9l6 6 6-6"/>');
}

/** Download-tray icon, used for the "export table" buttons. */
function downloadIcon(): SVGSVGElement {
  return svgIcon('<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 21h16"/>');
}

/** Broadcast-tower icon, used for the "new trap listener tab" action. */
function trapListenerIcon(): SVGSVGElement {
  return svgIcon('<path d="M12 2v5"/><path d="M12 22v-6"/><path d="M5 9a7 7 0 0 1 14 0"/><circle cx="12" cy="9" r="2"/>');
}

/** Connected-nodes icon, used for the "new gNMI tab" action. */
function gnmiTabIcon(): SVGSVGElement {
  return svgIcon(
    '<circle cx="5" cy="6" r="2.5"/><circle cx="19" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M7 7l3 8"/><path d="M17 7l-3 8"/>',
  );
}

/** Terminal icon (SSH transport), used for the "new NETCONF tab" action. */
function netconfTabIcon(): SVGSVGElement {
  return svgIcon(
    '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l4 3-4 3"/><path d="M13 15h4"/>',
  );
}

/** Paint-palette icon, used for the theme picker. */
function paletteIcon(): SVGSVGElement {
  return svgIcon(
    '<path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.6-.7 1.6-1.7 0-.4-.2-.8-.4-1.1-.3-.3-.4-.6-.4-1.1 0-.9.7-1.6 1.6-1.6H16c3 0 5.5-2.5 5.5-5.5C21.5 5.6 17.2 2 12 2z"/><circle cx="6.5" cy="11.5" r="1"/><circle cx="9.5" cy="7.5" r="1"/><circle cx="14.5" cy="7.5" r="1"/><circle cx="17.5" cy="11.5" r="1"/>',
  );
}

function openThemeMenu(store: Store, e: MouseEvent) {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  store.toggleThemeMenu(rect.left, rect.bottom + 4);
}

/** Circled-up-arrow icon, used for the "new version available" notice, and (spinning, via CSS) while it downloads. */
function updateAvailableIcon(): SVGSVGElement {
  return svgIcon('<circle cx="12" cy="12" r="10"/><path d="M12 16V8"/><path d="M8 12l4-4 4 4"/>');
}

/** Circular-arrow "restart" icon, used once a downloaded update is installed and waiting for a relaunch. */
function updateReadyIcon(): SVGSVGElement {
  return svgIcon('<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>');
}

/** Alert-triangle icon, used when a download/install attempt failed. */
function updateErrorIcon(): SVGSVGElement {
  return svgIcon(
    '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  );
}

/**
 * Icon button reflecting `store.state.updateStatus` (see update.ts and
 * `installUpdate()`/`relaunchForUpdate()` in state.ts); null while there's
 * nothing to show. Each phase's click does the next step in the flow -
 * download, then relaunch - so getting the update running never takes more
 * than two clicks, each one explicit.
 */
function renderUpdateButton(store: Store): HTMLElement | null {
  const status = store.state.updateStatus;
  if (!status) return null;
  switch (status.phase) {
    case "available":
      return el(
        "button",
        {
          class: "icon-btn update-available-btn",
          title: `Version ${status.version} is available - click to download and install`,
          onclick: () => void store.installUpdate(),
        },
        [updateAvailableIcon()],
      );
    case "downloading": {
      const pct = status.contentLength ? Math.min(100, Math.round((status.downloaded / status.contentLength) * 100)) : null;
      return el(
        "button",
        {
          class: "icon-btn update-available-btn update-downloading-btn",
          title: pct == null ? `Downloading version ${status.version}...` : `Downloading version ${status.version}... ${pct}%`,
        },
        [updateAvailableIcon()],
      );
    }
    case "ready":
      return el(
        "button",
        {
          class: "icon-btn update-available-btn",
          title: `Version ${status.version} is installed - click to restart and finish updating`,
          onclick: () => void store.relaunchForUpdate(),
        },
        [updateReadyIcon()],
      );
    case "error":
      return el(
        "button",
        {
          class: "icon-btn update-error-btn",
          title: `Update failed: ${status.message} - click to retry`,
          onclick: () => store.retryUpdate(),
        },
        [updateErrorIcon()],
      );
  }
}

const AUTO_REFRESH_RING_RADIUS = 9;
const AUTO_REFRESH_RING_CIRCUMFERENCE = 2 * Math.PI * AUTO_REFRESH_RING_RADIUS;

/** Pie-chart-style countdown ring showing time left until the next auto-refresh fetch; drains clockwise as time passes. */
function autoRefreshRingIcon(tabId: string, fraction: number): SVGSVGElement {
  const offset = AUTO_REFRESH_RING_CIRCUMFERENCE * (1 - fraction);
  const svg = svgIcon(
    `<circle cx="12" cy="12" r="${AUTO_REFRESH_RING_RADIUS}" fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="3"/>` +
      `<circle cx="12" cy="12" r="${AUTO_REFRESH_RING_RADIUS}" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" ` +
      `stroke-dasharray="${AUTO_REFRESH_RING_CIRCUMFERENCE}" stroke-dashoffset="${offset}" transform="rotate(-90 12 12)"/>`,
  );
  svg.setAttribute("data-autorefresh-ring", tabId);
  return svg;
}

/**
 * Patches every auto-refresh countdown ring's stroke-dashoffset directly,
 * without touching the rest of the DOM. Called on the 200ms UI tick instead
 * of doing a full re-render, since replacing the whole tree that often would
 * intermittently eat clicks elsewhere in the app (e.g. tab switching) by
 * removing an element mid-mousedown/mouseup.
 */
export function updateAutoRefreshRings(store: Store, root: HTMLElement) {
  root.querySelectorAll<SVGSVGElement>("svg[data-autorefresh-ring]").forEach((svg) => {
    const tabId = svg.getAttribute("data-autorefresh-ring")!;
    const fraction = store.autoRefreshFraction(tabId) ?? 1;
    const offset = AUTO_REFRESH_RING_CIRCUMFERENCE * (1 - fraction);
    const ring = svg.querySelectorAll("circle")[1];
    ring?.setAttribute("stroke-dashoffset", String(offset));
  });
}

function copyIcon(size = 12): SVGSVGElement {
  const svg = svgIcon('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>');
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  return svg;
}

/** Copies `text` to the clipboard and briefly highlights `trigger` (a button wrapping `copyIcon()`) to confirm the copy. */
function copyToClipboard(trigger: HTMLElement, text: string) {
  void navigator.clipboard.writeText(text).then(() => {
    trigger.classList.add("copied");
    setTimeout(() => trigger.classList.remove("copied"), 1000);
  });
}

/** A small button that copies `text` to the clipboard, meant to sit next to a name the user would want to paste elsewhere (a tree node or table column). */
function copyButton(className: string, text: string, title: string): HTMLElement {
  return el(
    "button",
    {
      class: className,
      title,
      onclick: (e: MouseEvent) => {
        e.stopPropagation();
        copyToClipboard(e.currentTarget as HTMLElement, text);
      },
    },
    [copyIcon()],
  );
}

function nodeIcon(node: { type: NodeType }): HTMLElement {
  const color = node.type === "table" ? "var(--icon-table)" : node.type === "scalar" ? "var(--icon-scalar)" : "var(--icon-group)";
  if (node.type === "group") {
    return el("div", { class: "tree-icon-group" }, [
      el("div", { class: "lid", style: { background: color } }),
      el("div", { class: "body", style: { background: color } }),
    ]);
  }
  if (node.type === "scalar") {
    return el("div", { class: "tree-icon-scalar", style: { background: color } });
  }
  return el(
    "div",
    { class: "tree-icon-table" },
    [0, 1, 2, 3].map(() => el("div", { style: { background: color } })),
  );
}

function renderTreeRow(store: Store, node: MibNode, depth: number, selectedNodeId: string): HTMLElement {
  const selected = node.id === selectedNodeId;
  const caretVisible = !!node.children;
  const expanded = !!store.state.expanded[node.id];
  const textColor = selected ? "var(--tree-selected-text)" : node.type === "group" ? "var(--text-secondary)" : "var(--tree-item-text)";
  const fontWeight = selected ? "600" : node.type === "group" ? "600" : "400";
  const bg = selected ? "var(--accent-selected-bg)" : "transparent";
  const title = node.resolved ? node.oid : `Could not resolve an absolute OID for '${node.label}' - its ancestor chain isn't fully defined in the configured MIB directories.`;
  return el(
    "div",
    {
      class: "tree-row",
      title,
      "data-node-id": node.id,
      style: { paddingLeft: depth * 16 + 2 + "px", opacity: node.resolved ? "1" : "0.45" },
      onclick: () => store.selectTreeNode(node),
      ondblclick: node.type === "table" ? () => store.openNodeInNewTab(node.id) : undefined,
      oncontextmenu: (e: MouseEvent) => {
        e.preventDefault();
        store.openTreeContextMenu(e.clientX, e.clientY, node.id);
      },
    },
    [
      el(
        "div",
        { class: "tree-row-bg", style: { background: bg } },
        [
          el(
            "div",
            {
              class: "tree-caret",
              style: { visibility: caretVisible ? "visible" : "hidden", transform: `rotate(${caretVisible && expanded ? 90 : 0}deg)` },
              onclick: caretVisible
                ? (e: MouseEvent) => {
                    e.stopPropagation();
                    store.toggleExpand(node.id);
                  }
                : undefined,
            },
            ["▶"],
          ),
          nodeIcon(node),
          el("div", { class: "tree-label", style: { color: textColor, fontWeight } }, [node.label]),
          copyButton("tree-copy-btn", node.label, `Copy name "${node.label}"`),
        ],
      ),
    ],
  );
}

function renderSidebar(store: Store): HTMLElement {
  const selectedNodeId = store.state.selectedTreeNodeId;
  const visibleNodes = store.getVisibleNodes();
  const errors = store.state.parseErrors;

  const activeProfile = store.activeMibProfile();
  const dirRows: HTMLElement[] = (activeProfile?.dirs ?? []).flatMap((dir) => {
    const files = store.dirFiles.find((d) => d.dir === dir)?.files ?? [];
    const expandKey = `mibdir:${dir}`;
    const expanded = files.length > 0 && !!store.state.expanded[expandKey];

    const row = el("div", { class: "mib-dir-row" }, [
      el(
        "div",
        {
          class: "mib-dir-caret",
          style: { visibility: files.length ? "visible" : "hidden", transform: `rotate(${expanded ? 90 : 0}deg)` },
          onclick: files.length ? () => store.toggleExpand(expandKey) : undefined,
        },
        ["▶"],
      ),
      el("div", { class: "mib-dir-icon" }),
      el("div", { class: "mib-dir-path", title: dir }, [dir]),
      el("button", { class: "mib-dir-remove", title: "Remove directory", onclick: () => store.removeMibDir(dir) }, ["×"]),
    ]);

    if (!expanded) return [row];

    const fileRows = files.map((file) => {
      const fileErrors = errors.find((fe) => fe.file === file)?.errors;
      const hasIssue = !!fileErrors?.length;
      const relativePath = file.startsWith(dir) ? file.slice(dir.length).replace(/^[/\\]/, "") : file;
      const title = hasIssue ? `${file}\n\n${fileErrors!.join("\n")}` : file;
      return el("div", { class: "mib-file-row", title }, [
        el("div", { class: "mib-file-icon" + (hasIssue ? " mib-file-icon-issue" : "") }),
        el("div", { class: "mib-file-name" + (hasIssue ? " mib-file-name-issue" : "") }, [relativePath]),
      ]);
    });

    return [row, ...fileRows];
  });
  if (errors.length) {
    const issueCount = errors.reduce((n, fe) => n + fe.errors.length, 0);
    dirRows.push(
      el(
        "button",
        { class: "mib-dir-warning", onclick: () => store.toggleParseErrors() },
        [`⚠ ${issueCount} issue${issueCount === 1 ? "" : "s"} while parsing`],
      ),
    );
  }

  const draft = store.state.mibDirDraft;
  const draftRow =
    draft === null
      ? null
      : el("div", { class: "mib-dir-draft-row" }, [
          el("input", {
            class: "mib-dir-draft-input snmp-dir-draft-input",
            placeholder: "/absolute/path/to/mibs",
            value: draft,
            "data-focus-key": "mibDirDraft",
            oninput: (e: Event) => store.updateMibDirDraft((e.target as HTMLInputElement).value),
            onkeydown: (e: KeyboardEvent) => {
              if (e.key === "Enter") void store.submitMibDirDraft();
              else if (e.key === "Escape") store.cancelMibDirDraft();
            },
          }),
          el("button", { class: "mib-dir-draft-confirm", title: "Add", onclick: () => void store.submitMibDirDraft() }, ["✓"]),
          el("button", { class: "mib-dir-draft-cancel", title: "Cancel", onclick: () => store.cancelMibDirDraft() }, ["×"]),
        ]);

  const profiles = store.state.mibProfiles;
  const canDeleteProfile = profiles.length > 1;
  const profileRow = el("div", { class: "mib-profile-row" }, [
    el(
      "select",
      {
        class: "mib-profile-select",
        value: store.state.activeMibProfileId,
        onchange: (e: Event) => void store.switchMibProfile((e.target as HTMLSelectElement).value),
      },
      profiles.map((p) => el("option", { value: p.id }, [p.name])),
    ),
    el(
      "button",
      {
        class: "mib-profile-btn",
        title: "Rename profile",
        onclick: () => {
          store.startRenamingMibProfile();
          document.querySelector<HTMLInputElement>(".mib-profile-rename-input")?.select();
        },
      },
      ["✎"],
    ),
    canDeleteProfile
      ? el(
          "button",
          {
            class: "mib-profile-btn",
            title: "Delete profile",
            onclick: () => void store.removeMibProfile(store.state.activeMibProfileId),
          },
          ["×"],
        )
      : null,
    el(
      "button",
      {
        class: "mib-profile-btn",
        title: "New profile",
        onclick: () => {
          store.startMibProfileDraft();
          document.querySelector<HTMLInputElement>(".mib-profile-draft-input")?.focus();
        },
      },
      ["+"],
    ),
  ]);

  const renameRow = store.state.renamingMibProfile
    ? el("div", { class: "mib-dir-draft-row" }, [
        el("input", {
          class: "mib-dir-draft-input mib-profile-rename-input",
          value: activeProfile?.name ?? "",
          "data-focus-key": "mibProfileRename",
          onkeydown: (e: KeyboardEvent) => {
            if (e.key === "Enter") void store.renameMibProfile(store.state.activeMibProfileId, (e.target as HTMLInputElement).value);
            else if (e.key === "Escape") store.cancelRenamingMibProfile();
          },
        }),
        el(
          "button",
          {
            class: "mib-dir-draft-confirm",
            title: "Save",
            onclick: () => {
              const input = document.querySelector<HTMLInputElement>(".mib-profile-rename-input");
              void store.renameMibProfile(store.state.activeMibProfileId, input?.value ?? "");
            },
          },
          ["✓"],
        ),
        el("button", { class: "mib-dir-draft-cancel", title: "Cancel", onclick: () => store.cancelRenamingMibProfile() }, ["×"]),
      ])
    : null;

  const profileDraft = store.state.mibProfileDraft;
  const profileDraftRow =
    profileDraft === null
      ? null
      : el("div", { class: "mib-dir-draft-row" }, [
          el("input", {
            class: "mib-dir-draft-input mib-profile-draft-input",
            placeholder: "Profile name (e.g. v4.0)",
            value: profileDraft,
            "data-focus-key": "mibProfileDraft",
            oninput: (e: Event) => store.updateMibProfileDraft((e.target as HTMLInputElement).value),
            onkeydown: (e: KeyboardEvent) => {
              if (e.key === "Enter") void store.submitMibProfileDraft();
              else if (e.key === "Escape") store.cancelMibProfileDraft();
            },
          }),
          el("button", { class: "mib-dir-draft-confirm", title: "Create", onclick: () => void store.submitMibProfileDraft() }, ["✓"]),
          el("button", { class: "mib-dir-draft-cancel", title: "Cancel", onclick: () => store.cancelMibProfileDraft() }, ["×"]),
        ]);

  // Which of the three collapsible sections is the last expanded one - it fills whatever space
  // remains instead of using its own dragged height; see `sidebarTreeFlex()`.
  const sectionsExpanded = [!store.state.mibSectionCollapsed, !store.state.yangSectionCollapsed, !store.state.netconfYangSectionCollapsed];
  const lastExpanded = sectionsExpanded.lastIndexOf(true);

  const mibExpanded = sectionsExpanded[0];
  const mibStartHeight = store.state.mibTreeHeight;
  const mibSectionBody: (HTMLElement | null)[] = !mibExpanded
    ? []
    : [
        el("div", { class: "mib-dirs" }, [
          profileRow,
          renameRow,
          profileDraftRow,
          el("div", { class: "mib-dirs-head" }, [
            el("div", { class: "mib-dirs-title" }, ["MIB Directories"]),
            el(
              "button",
              {
                class: "mib-dir-add",
                title: "Add MIB directory",
                onclick: () => {
                  // addMibDir() runs synchronously up to its first `await` (only taken
                  // on the native-picker path), so the draft input already exists
                  // in the DOM by the time this call returns in browser mode.
                  void store.addMibDir();
                  document.querySelector<HTMLInputElement>(".snmp-dir-draft-input")?.focus();
                },
              },
              ["+"],
            ),
          ]),
          el("div", { class: "mib-dir-list" }, dirRows),
          draftRow,
        ]),
        el("div", { class: "tree-mode-box" }, [
          el(
            "div",
            { class: "tree-mode-toggle" },
            [
              { label: "Tree", value: false },
              { label: "Tables", value: true },
            ].map(({ label, value }) =>
              el(
                "button",
                {
                  class: "tree-mode-btn" + (store.state.tablesOnlyMode === value ? " active" : ""),
                  onclick: () => store.setTablesOnlyMode(value),
                },
                [label],
              ),
            ),
          ),
        ]),
        el(
          "div",
          { class: "tree", "data-preserve-scroll": "tree", style: { flex: sidebarTreeFlex(mibStartHeight, lastExpanded === 0) } },
          visibleNodes.map(({ node, depth }) => renderTreeRow(store, node, depth, selectedNodeId)),
        ),
        lastExpanded === 0 ? null : renderSplitterH((e) => startDragY(e, (dy) => store.setMibTreeHeight(mibStartHeight + dy))),
      ];

  return el("div", { class: "sidebar", style: { width: store.state.leftWidth + "px" } }, [
    el("div", { class: "sidebar-header" }, [
      el("button", { class: "icon-btn", title: "Hide sidebar", onclick: () => store.toggleLeft() }, [sidebarToggleIcon()]),
      el("div", { class: "spacer" }),
      renderUpdateButton(store),
      el("button", { class: "icon-btn", title: "Theme", onclick: (e: MouseEvent) => openThemeMenu(store, e) }, [paletteIcon()]),
    ]),
    sidebarSectionHead("SNMP (MIB)", !mibExpanded, () => store.toggleMibSectionCollapsed()),
    ...mibSectionBody,
    ...renderYangSection(store, lastExpanded === 1),
    ...renderNetconfYangSection(store, lastExpanded === 2),
  ]);
}

function renderParseErrorsModal(title: string, errors: FileErrors[], onClose: () => void): HTMLElement {
  const groups = errors.map((fe) =>
    el("div", { class: "parse-error-group" }, [
      el("div", { class: "parse-error-file" }, [fe.file]),
      el(
        "ul",
        { class: "parse-error-list" },
        fe.errors.map((e) => el("li", {}, [e])),
      ),
    ]),
  );

  return el("div", { class: "modal-overlay", onclick: onClose }, [
    el("div", { class: "modal-panel", onclick: (e: Event) => e.stopPropagation() }, [
      el("div", { class: "modal-header" }, [
        el("div", { class: "modal-title" }, [title]),
        el("button", { class: "icon-btn", title: "Close", onclick: onClose }, ["✕"]),
      ]),
      el("div", { class: "modal-body" }, groups),
    ]),
  ]);
}

function mibTreeContextMenuItems(store: Store, nodeId: string): HTMLElement[] {
  const node = store.findNode(store.activeTree(), nodeId);

  const items: HTMLElement[] = [];
  if (node) {
    items.push(
      el(
        "button",
        {
          class: "context-menu-item",
          onclick: () => {
            void navigator.clipboard.writeText(node.label);
            store.closeTreeContextMenu();
          },
        },
        [`Copy name "${node.label}"`],
      ),
    );
  }
  if (node && node.type !== "group") {
    items.push(
      el("button", { class: "context-menu-item", onclick: () => store.openNodeInNewTab(nodeId) }, [
        `Open "${node.label}" in new tab`,
      ]),
    );
  }
  if (node && store.canFetch(node, "get")) {
    items.push(el("button", { class: "context-menu-item", onclick: () => void store.runSingleOp(nodeId, "get") }, [`Get "${node.label}"`]));
  }
  if (node && store.canFetch(node, "getnext")) {
    items.push(
      el("button", { class: "context-menu-item", onclick: () => void store.runSingleOp(nodeId, "getnext") }, [`GetNext "${node.label}"`]),
    );
  }
  if (store.canBenchmark(node)) {
    items.push(
      el("button", { class: "context-menu-item", onclick: () => store.openBenchmarkTab(nodeId) }, [
        `Benchmark "${node?.label ?? nodeId}" walk`,
      ]),
    );
  }
  return items;
}

/** The YANG-tree counterpart to `mibTreeContextMenuItems`. No benchmark item - walk timing is
 * SNMP-only (see `snmp::walk_timed`); gNMI has no equivalent yet. */
function yangTreeContextMenuItems(store: Store, nodeId: string): HTMLElement[] {
  const node = store.findYangNode(store.yangTree, nodeId);

  const items: HTMLElement[] = [];
  if (node) {
    const copyText = node.path || node.label;
    items.push(
      el(
        "button",
        {
          class: "context-menu-item",
          onclick: () => {
            void navigator.clipboard.writeText(copyText);
            store.closeTreeContextMenu();
          },
        },
        [`Copy ${node.path ? "path" : "name"} "${copyText}"`],
      ),
    );
  }
  if (node && node.path) {
    items.push(
      el("button", { class: "context-menu-item", onclick: () => store.openYangNodeInNewTab(node) }, [
        `Open "${node.label}" in new tab`,
      ]),
    );
  }
  return items;
}

/** The NETCONF YANG-tree counterpart to `yangTreeContextMenuItems`, over `store.netconfYangTree`
 * and `store.openNetconfYangNodeInNewTab` instead of gNMI's. */
function netconfYangTreeContextMenuItems(store: Store, nodeId: string): HTMLElement[] {
  const node = store.findNetconfYangNode(store.netconfYangTree, nodeId);

  const items: HTMLElement[] = [];
  if (node) {
    const copyText = node.path || node.label;
    items.push(
      el(
        "button",
        {
          class: "context-menu-item",
          onclick: () => {
            void navigator.clipboard.writeText(copyText);
            store.closeTreeContextMenu();
          },
        },
        [`Copy ${node.path ? "path" : "name"} "${copyText}"`],
      ),
    );
  }
  if (node && node.path) {
    items.push(
      el("button", { class: "context-menu-item", onclick: () => store.openNetconfYangNodeInNewTab(node) }, [
        `Open "${node.label}" in new tab`,
      ]),
    );
  }
  return items;
}

function renderTreeContextMenu(store: Store): HTMLElement | null {
  const menu = store.state.treeContextMenu;
  if (!menu) return null;

  const items: HTMLElement[] =
    menu.kind === "yang"
      ? yangTreeContextMenuItems(store, menu.nodeId)
      : menu.kind === "netconf-yang"
        ? netconfYangTreeContextMenuItems(store, menu.nodeId)
        : mibTreeContextMenuItems(store, menu.nodeId);
  if (items.length === 0) return null;

  return el(
    "div",
    { class: "context-menu-overlay", onclick: () => store.closeTreeContextMenu(), oncontextmenu: (e: Event) => e.preventDefault() },
    [el("div", { class: "context-menu", style: { left: menu.x + "px", top: menu.y + "px" }, onclick: (e: Event) => e.stopPropagation() }, items)],
  );
}

function renderRefreshMenu(store: Store): HTMLElement | null {
  const menu = store.state.refreshMenu;
  if (!menu) return null;
  const pane = store.getPane(menu.paneId);
  const tab = pane && store.getPaneActiveTab(pane);
  if (!pane || !tab || tab.kind !== "query") return null;

  const item = (label: string, active: boolean, onclick: () => void) =>
    el("button", { class: "context-menu-item" + (active ? " active" : ""), onclick }, [
      el("span", { class: "context-menu-check" }, [active ? "✓" : ""]),
      label,
    ]);

  return el(
    "div",
    { class: "context-menu-overlay", onclick: () => store.closeRefreshMenu(), oncontextmenu: (e: Event) => e.preventDefault() },
    [
      el(
        "div",
        { class: "context-menu", style: { left: menu.x + "px", top: menu.y + "px" }, onclick: (e: Event) => e.stopPropagation() },
        [
          item("Manual", !tab.autoRefresh, () => store.setAutoRefresh(pane.id, false)),
          item("Auto-refresh (10s)", tab.autoRefresh, () => store.setAutoRefresh(pane.id, true)),
        ],
      ),
    ],
  );
}

function renderThemeMenu(store: Store): HTMLElement | null {
  const menu = store.state.themeMenu;
  if (!menu) return null;

  const item = (label: string, active: boolean, onclick: () => void) =>
    el("button", { class: "context-menu-item" + (active ? " active" : ""), onclick }, [
      el("span", { class: "context-menu-check" }, [active ? "✓" : ""]),
      label,
    ]);

  return el(
    "div",
    { class: "context-menu-overlay", onclick: () => store.closeThemeMenu(), oncontextmenu: (e: Event) => e.preventDefault() },
    [
      el(
        "div",
        { class: "context-menu", style: { left: menu.x + "px", top: menu.y + "px" }, onclick: (e: Event) => e.stopPropagation() },
        THEME_OPTIONS.map((opt) => item(opt.label, store.state.theme === opt.id, () => store.setTheme(opt.id))),
      ),
    ],
  );
}

function renderCollapsedRail(store: Store): HTMLElement {
  return el("div", { class: "sidebar-rail" }, [
    el("button", { class: "icon-btn", title: "Show sidebar", onclick: () => store.toggleLeft() }, [sidebarToggleIcon()]),
    renderUpdateButton(store),
    el("button", { class: "icon-btn", title: "Theme", onclick: (e: MouseEvent) => openThemeMenu(store, e) }, [paletteIcon()]),
  ]);
}

function renderSplitter(onMouseDown: (e: MouseEvent) => void): HTMLElement {
  return el("div", { class: "splitter", onmousedown: onMouseDown }, [el("div", { class: "splitter-line" })]);
}

/** The vertical-drag counterpart to `renderSplitter`, between two resizable sidebar sections. */
function renderSplitterH(onMouseDown: (e: MouseEvent) => void): HTMLElement {
  return el("div", { class: "splitter-h", onmousedown: onMouseDown }, [el("div", { class: "splitter-h-line" })]);
}

/** A collapsible sidebar section's header row: a rotating caret plus its label, click anywhere on
 * the row to toggle. Shared by the "SNMP (MIB)", "YANG (gNMI)", and "YANG (NETCONF)" sections. */
function sidebarSectionHead(label: string, collapsed: boolean, onToggle: () => void): HTMLElement {
  return el("button", { type: "button", class: "sidebar-section-head", "aria-expanded": collapsed ? "false" : "true", onclick: onToggle }, [
    el("div", { class: "sidebar-section-caret", style: { transform: `rotate(${collapsed ? 0 : 90}deg)` } }, ["▶"]),
    el("span", {}, [label]),
  ]);
}

/** A resizable sidebar section's tree area's flex-basis: fills whatever space remains when it's
 * the last expanded section (mirroring `PaneState.width`'s "null means flexible, but only ever for
 * the actual last pane" convention), otherwise the explicit height its splitter was dragged to. */
function sidebarTreeFlex(height: number, isLast: boolean): string {
  return isLast ? "1 1 0%" : `0 0 ${height}px`;
}

function renderTabBar(store: Store, pane: PaneState): HTMLElement {
  const tabs = pane.tabs.map((tab) => {
    const active = tab.id === pane.activeTabId;
    let label: string;
    let dotClass = "tab-dot";
    if (tab.kind === "trap") {
      label = "Trap Listener · " + (tab.running ? tab.boundAddr : "stopped");
      dotClass += tab.startError ? " error" : tab.running ? "" : " off";
    } else if (tab.kind === "benchmark") {
      label = "Benchmark · " + tab.nodeLabel;
      dotClass += tab.error ? " error" : tab.running ? "" : " off";
    } else if (tab.kind === "gnmi") {
      label = "gNMI · " + (tab.hostAddr || "(no target)");
      dotClass += tab.fetchError ? " error" : "";
    } else if (tab.kind === "netconf") {
      label = "NETCONF · " + (tab.hostAddr || "(no target)");
      dotClass += tab.fetchError ? " error" : "";
    } else {
      const host = store.hostProfiles.find((h) => h.id === tab.hostId);
      const op = tab.snmpOp === "get" ? "Get " : tab.snmpOp === "getnext" ? "GetNext " : "";
      label = (host ? host.label : tab.hostAddr || "(no address)") + " · " + op + tab.selectedNode;
    }
    return el(
      "div",
      {
        class: "tab",
        style: {
          borderBottomColor: active ? "var(--accent)" : "transparent",
          background: active ? "var(--bg-sidebar)" : "transparent",
          color: active ? "var(--text-primary)" : "var(--text-muted)",
          fontWeight: active ? "600" : "400",
        },
        onclick: () => store.selectTab(pane.id, tab.id),
      },
      [
        el("div", { class: dotClass }),
        el("div", { class: "tab-label" }, [label]),
        el(
          "button",
          {
            class: "tab-close",
            onclick: (e: Event) => {
              e.stopPropagation();
              store.closeTabInPane(pane.id, tab.id);
            },
          },
          ["×"],
        ),
      ],
    );
  });

  const canSplit = store.state.panes.length < 2;
  const canClosePane = store.state.panes.length > 1;

  const bar: (HTMLElement | null)[] = [
    ...tabs,
    el(
      "button",
      { class: "pane-action", title: "New trap listener tab", onclick: () => store.openTrapListenerTab(pane.id) },
      [trapListenerIcon()],
    ),
    el("button", { class: "pane-action", title: "New gNMI tab", onclick: () => store.openGnmiTab(pane.id) }, [gnmiTabIcon()]),
    el("button", { class: "pane-action", title: "New NETCONF tab", onclick: () => store.openNetconfTab(pane.id) }, [netconfTabIcon()]),
    el("div", { class: "tab-bar-spacer" }),
    canSplit ? el("button", { class: "pane-action", title: "Split right", onclick: () => store.splitPane(pane.id) }, ["⊟"]) : null,
    canClosePane ? el("button", { class: "pane-action", title: "Close group", onclick: () => store.closePane(pane.id) }, ["✕"]) : null,
  ];

  return el("div", { class: "tab-bar" }, bar);
}

function renderToolbar(store: Store, pane: PaneState, tab: TabState): HTMLElement {
  const isV3 = tab.version === "v3";

  const versionRow = el(
    "div",
    { class: "version-toggle" },
    (["v1", "v2c", "v3"] as SnmpVersion[]).map((v) =>
      el(
        "button",
        {
          class: "version-btn" + (tab.version === v ? " active" : ""),
          onclick: () => store.setVersion(pane.id, v),
        },
        [v],
      ),
    ),
  );

  const fields: HTMLElement[] = [
    el("div", { class: "field" }, [
      el("label", { class: "field-label" }, ["Address"]),
      el("input", {
        class: "field-input field-addr field-mono",
        value: tab.hostAddr,
        "data-focus-key": `tab:${tab.id}:addr`,
        oninput: (e: Event) => store.updateActiveTabInPane(pane.id, { hostAddr: (e.target as HTMLInputElement).value }),
      }),
    ]),
    el("div", { class: "field" }, [
      el("label", { class: "field-label" }, ["Port"]),
      el("input", {
        class: "field-input field-port field-mono",
        value: tab.hostPort,
        "data-focus-key": `tab:${tab.id}:port`,
        oninput: (e: Event) => store.updateActiveTabInPane(pane.id, { hostPort: (e.target as HTMLInputElement).value }),
      }),
    ]),
    el("div", { class: "field" }, [el("label", { class: "field-label" }, ["Version"]), versionRow]),
  ];

  if (isV3) {
    fields.push(
      el("div", { class: "v3-fields" }, [
        el("div", { class: "field" }, [
          el("label", { class: "field-label" }, ["Security User"]),
          el("input", {
            class: "field-input field-v3-user",
            value: tab.v3User,
            "data-focus-key": `tab:${tab.id}:v3user`,
            oninput: (e: Event) => store.updateActiveTabInPane(pane.id, { v3User: (e.target as HTMLInputElement).value }),
          }),
        ]),
        el("div", { class: "field" }, [
          el("label", { class: "field-label" }, ["Auth"]),
          el("input", {
            type: "password",
            class: "field-input field-v3-secret",
            value: tab.v3Auth,
            "data-focus-key": `tab:${tab.id}:v3auth`,
            oninput: (e: Event) => store.updateActiveTabInPane(pane.id, { v3Auth: (e.target as HTMLInputElement).value }),
          }),
        ]),
        el("div", { class: "field" }, [
          el("label", { class: "field-label" }, ["Priv"]),
          el("input", {
            type: "password",
            class: "field-input field-v3-secret",
            value: tab.v3Priv,
            "data-focus-key": `tab:${tab.id}:v3priv`,
            oninput: (e: Event) => store.updateActiveTabInPane(pane.id, { v3Priv: (e.target as HTMLInputElement).value }),
          }),
        ]),
      ]),
    );
  } else {
    fields.push(
      el("div", { class: "field" }, [
        el("label", { class: "field-label" }, ["Community"]),
        el("input", {
          class: "field-input field-community field-mono",
          value: tab.community,
          "data-focus-key": `tab:${tab.id}:community`,
          oninput: (e: Event) => store.updateActiveTabInPane(pane.id, { community: (e.target as HTMLInputElement).value }),
        }),
      ]),
    );
  }

  const selectedNode = store.findNode(store.activeTree(), tab.selectedNode);
  const canFetch = store.canFetch(selectedNode, tab.snmpOp) && store.hasCompleteConnection(tab);
  const fetchDisabledReason = !store.canFetch(selectedNode, tab.snmpOp)
    ? "Select a resolvable scalar or table in the tree first"
    : !store.hasCompleteConnection(tab)
      ? "Fill in the host address, port, and " + (tab.version === "v3" ? "security user" : "community") + " first"
      : "";

  fields.push(el("div", { class: "spacer" }));
  fields.push(
    el("div", { class: "split-btn" }, [
      el(
        "button",
        {
          class: "split-btn-main",
          disabled: !canFetch,
          title: fetchDisabledReason,
          onclick: () => store.manualFetch(pane.id),
        },
        [tab.snmpOp === "get" ? "Get" : tab.snmpOp === "getnext" ? "GetNext" : "Fetch"],
      ),
      el(
        "button",
        {
          class: "split-btn-toggle" + (tab.autoRefresh ? " on" : ""),
          title: tab.autoRefresh ? "Auto-refresh every 10s - click to choose fetch mode" : "Manual fetch - click to choose fetch mode",
          onclick: (e: MouseEvent) => {
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            store.toggleRefreshMenu(pane.id, rect.right - 172, rect.bottom + 4);
          },
        },
        [tab.autoRefresh ? autoRefreshRingIcon(tab.id, store.autoRefreshFraction(tab.id) ?? 1) : chevronDownIcon()],
      ),
    ]),
  );

  return el("div", { class: "toolbar" }, [el("div", { class: "toolbar-row" }, fields)]);
}

function renderTableToolbar(store: Store, pane: PaneState, tab: TabState): HTMLElement {
  const node = store.findNode(store.activeTree(), tab.selectedNode);
  const label = node ? node.label : "(nothing selected)";
  const oid = node ? node.oid || "(unresolved)" : "";

  const children: HTMLElement[] = [
    el("div", { class: "selected-node-label" }, [label]),
    el("div", { class: "selected-node-oid" }, [oid]),
  ];
  if (tab.diffMode) {
    children.push(
      el("div", { class: "diff-legend" }, [
        el("span", { class: "swatch added" }, ["Added"]),
        el("span", { class: "swatch removed" }, ["Removed"]),
        el("span", { class: "swatch changed" }, ["Changed"]),
      ]),
    );
  }
  children.push(el("div", { class: "spacer" }));
  children.push(
    el("label", { class: "toggle-label", title: "Highlight rows added, removed, or changed since the previous fetch", onclick: () => store.toggleDiffMode(pane.id) }, [
      el("div", { class: "toggle-track" + (tab.diffMode ? " on" : "") }, [el("div", { class: "toggle-knob" })]),
      "Diff mode",
    ]),
  );
  children.push(
    el("label", { class: "toggle-label", title: "Show column headers as e.g. \"Local Hostname\" instead of the raw MIB identifier", onclick: () => store.toggleHumanReadableColumns(pane.id) }, [
      el("div", { class: "toggle-track" + (tab.humanReadableColumns ? " on" : "") }, [el("div", { class: "toggle-knob" })]),
      "Readable names",
    ]),
  );
  children.push(
    el(
      "label",
      {
        class: "toggle-label",
        title: 'Show values with a DISPLAY-HINT formatted (e.g. 123 -> 12.3) or an enumerated value named (e.g. 2 -> "ok") instead of raw',
        onclick: () => store.toggleUseDisplayHints(pane.id),
      },
      [
        el("div", { class: "toggle-track" + (tab.useDisplayHints ? " on" : "") }, [el("div", { class: "toggle-knob" })]),
        "Display hint",
      ],
    ),
  );
  children.push(
    el(
      "label",
      {
        class: "toggle-label",
        title: "Show one column per fetched row and one row per MIB column - handy when there are many columns but few rows",
        onclick: () => store.toggleTransposed(pane.id),
      },
      [el("div", { class: "toggle-track" + (tab.transposed ? " on" : "") }, [el("div", { class: "toggle-knob" })]), "Transpose"],
    ),
  );
  const canExport = tab.columns.length > 0;
  children.push(
    el(
      "button",
      {
        class: "export-btn",
        disabled: !canExport,
        title: "Export the table",
        onclick: (e: MouseEvent) => {
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          store.toggleExportMenu(pane.id, rect.left, rect.bottom + 4);
        },
      },
      [downloadIcon(), "Export", chevronDownIcon()],
    ),
  );
  return el("div", { class: "table-toolbar" }, children);
}

/** Runs a table export, surfacing any failure (e.g. a disk write error) with a native alert - the app has no toast/notification system for an error path this rare. */
function runTableExport(store: Store, tab: TabState, labelHint: string, fn: (store: Store, tab: TabState, labelHint: string) => Promise<void>) {
  void fn(store, tab, labelHint).catch((e) => alert("Export failed: " + (e instanceof Error ? e.message : String(e))));
}

/** Format picker opened by the table toolbar's "Export" button. */
function renderExportMenu(store: Store): HTMLElement | null {
  const menu = store.state.exportMenu;
  if (!menu) return null;
  const pane = store.getPane(menu.paneId);
  const tab = pane && store.getPaneActiveTab(pane);
  if (!pane || !tab || tab.kind !== "query" || tab.columns.length === 0) return null;
  const node = store.findNode(store.activeTree(), tab.selectedNode);
  const labelHint = node ? node.label : tab.selectedNode;

  const item = (label: string, fn: (store: Store, tab: TabState, labelHint: string) => Promise<void>) =>
    el(
      "button",
      {
        class: "context-menu-item",
        onclick: () => {
          runTableExport(store, tab, labelHint, fn);
          store.closeExportMenu();
        },
      },
      [label],
    );

  return el(
    "div",
    { class: "context-menu-overlay", onclick: () => store.closeExportMenu(), oncontextmenu: (e: Event) => e.preventDefault() },
    [
      el(
        "div",
        { class: "context-menu", style: { left: menu.x + "px", top: menu.y + "px" }, onclick: (e: Event) => e.stopPropagation() },
        [item("Export as CSV", exportTableCsv), item("Export as PNG", exportTablePng)],
      ),
    ],
  );
}

/** A couple of literal values read like a status enum regardless of which MIB table they came from. */
function statusColor(value: string): string | null {
  const v = value.toLowerCase();
  if (v === "up") return "var(--green)";
  if (v === "down") return "var(--red)";
  return null;
}

/** Splits a MIB identifier into its camelCase/acronym/underscore-delimited words, e.g. "dcpLinkviewIPAddress" -> ["dcp", "Linkview", "IP", "Address"]. */
function splitIdentifierWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_]+/)
    .filter(Boolean);
}

function capitalizeWord(word: string): string {
  if (word === word.toUpperCase()) return word; // keep acronyms (e.g. "IP") as-is
  return word[0].toUpperCase() + word.slice(1);
}

/**
 * Maps each raw column name to a human-readable label: the word-sequence prefix shared by
 * every multi-word column (typically the table name, e.g. "dcpLinkview") is stripped, then
 * the remaining words are title-cased, e.g. "dcpLinkviewLocalHostname" -> "Local Hostname".
 */
export function humanizeColumnNames(cols: string[]): Record<string, string> {
  const wordLists = cols.map(splitIdentifierWords);
  const multiWordLists = wordLists.filter((w) => w.length > 1);

  let prefixLen = 0;
  if (multiWordLists.length > 1) {
    const minLen = Math.min(...multiWordLists.map((w) => w.length));
    outer: for (let i = 0; i < minLen - 1; i++) {
      const word = multiWordLists[0][i].toLowerCase();
      for (const words of multiWordLists) {
        if (words[i].toLowerCase() !== word) break outer;
      }
      prefixLen++;
    }
  }

  const labels: Record<string, string> = {};
  cols.forEach((col, i) => {
    const words = wordLists[i];
    const kept = words.length > 1 ? words.slice(Math.min(prefixLen, words.length - 1)) : words;
    labels[col] = kept.map(capitalizeWord).join(" ");
  });
  return labels;
}

/** The exact DISPLAY-HINT that RFC 2579's DateAndTime TEXTUAL-CONVENTION declares. */
const DATE_AND_TIME_HINT = "2d-1d-1d,1d:1d:1d.1d,1a1d:1d";

/**
 * Parses a DateAndTime (RFC 2579) OCTET STRING - shown raw as colon-separated hex
 * bytes, e.g. "07:e7:09:03:0f:1f:0f:00" - into an ISO 8601 timestamp. The value is
 * 8 bytes (year-hi, year-lo, month, day, hour, minute, second, deci-second) with an
 * optional 3 more (UTC-offset direction as ASCII '+'/'-', offset hours, offset
 * minutes). Returns null if `raw` isn't a hex-byte string of the expected length.
 */
function applyDateAndTimeHint(raw: string): string | null {
  const bytes = raw.split(":").map((b) => Number.parseInt(b, 16));
  if (bytes.length !== 8 && bytes.length !== 11) return null;
  if (bytes.some((b) => Number.isNaN(b) || b < 0 || b > 0xff)) return null;

  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  const [yearHi, yearLo, month, day, hour, minute, second, deciSecond] = bytes;
  const year = (yearHi << 8) | yearLo;
  let iso = `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}.${deciSecond}`;
  if (bytes.length === 11) {
    const sign = String.fromCharCode(bytes[8]) === "-" ? "-" : "+";
    iso += `${sign}${pad(bytes[9])}:${pad(bytes[10])}`;
  }
  return iso;
}

/**
 * Applies a numeric SNMP DISPLAY-HINT ("d" or "d-N": insert a decimal point N
 * digits from the right, e.g. "d-1" turns 123 into "12.3"), or the DateAndTime
 * hint (formatted as an ISO 8601 timestamp), to a raw value string. Returns null
 * - meaning "show raw as-is" - for hint forms this doesn't recognize (e.g. OCTET
 * STRING hex/octal/ASCII hints) or a value that doesn't match the hint's shape.
 */
function applyDisplayHint(raw: string, hint: string): string | null {
  if (hint === DATE_AND_TIME_HINT) return applyDateAndTimeHint(raw);

  const match = /^d(?:-(\d+))?$/.exec(hint);
  if (!match) return null;
  const places = match[1] ? Number(match[1]) : 0;
  if (places === 0) return null;
  if (!/^-?\d+$/.test(raw)) return null;

  const sign = raw.startsWith("-") ? "-" : "";
  const digits = sign ? raw.slice(1) : raw;
  const padded = digits.padStart(places + 1, "0");
  const intPart = padded.slice(0, padded.length - places);
  const fracPart = padded.slice(padded.length - places);
  return `${sign}${intPart}.${fracPart}`;
}

/**
 * Resolves a raw cell value to what should actually be shown: an enumerated column's named
 * value takes precedence over a numeric DISPLAY-HINT - in practice a column only ever has one
 * or the other, never both. `hinted` is true when `value` differs from `raw` (i.e. it needed
 * some translation), which callers use to decide whether to also surface the raw value.
 */
export function resolveCellValue(raw: string, displayHint?: string, enumLabels?: Record<string, string>): { value: string; hinted: boolean } {
  const hinted =
    (enumLabels && Object.prototype.hasOwnProperty.call(enumLabels, raw) ? enumLabels[raw] : null) ??
    (displayHint ? applyDisplayHint(raw, displayHint) : null);
  return { value: hinted ?? raw, hinted: hinted !== null && hinted !== raw };
}

/**
 * `rowStatus` is only passed in transposed mode, where a fetched row becomes a column and its
 * added/removed styling (normally set once on the `<tr>`) has to be repeated on every cell in that column.
 */
function renderCell(
  colKey: string,
  row: Row,
  changed: boolean,
  displayHint?: string,
  enumLabels?: Record<string, string>,
  rowStatus?: RowStatus,
): HTMLTableCellElement {
  const bg = changed ? "var(--yellow-bg)" : rowStatus === "added" ? "var(--added-bg)" : rowStatus === "removed" ? "var(--removed-bg)" : "transparent";
  const opacity = rowStatus === "removed" ? "0.55" : "1";
  const textDecoration = rowStatus === "removed" ? "line-through" : "none";
  const raw = row[colKey] ?? "";
  const { value, hinted } = resolveCellValue(raw, displayHint, enumLabels);
  const title = hinted ? `raw: ${raw}` : undefined;
  const color = statusColor(value);
  if (color) {
    return el("td", { style: { background: bg, opacity, textDecoration }, title }, [
      el("span", { class: "status-chip", style: { color } }, [el("span", { class: "status-dot", style: { background: color } }), value]),
    ]);
  }
  return el("td", { style: { background: bg, opacity, textDecoration }, title }, [value]);
}

/** The sortable column-name button shown in a table header (or, in transposed mode, a row header) - label click sorts, copy button copies the raw column name. */
function renderColumnHeaderBtn(
  store: Store,
  pane: PaneState,
  tab: TabState,
  col: string,
  columnLabels: Record<string, string> | null,
  sorted: boolean,
): HTMLElement {
  return el("div", { class: "th-btn" + (sorted ? " sorted" : "") }, [
    el("span", { class: "th-label", onclick: () => store.setSortCol(pane.id, col) }, [
      columnLabels ? columnLabels[col] : col,
      sorted ? el("span", { style: { fontSize: "9px" } }, [tab.sortDir === 1 ? "▲" : "▼"]) : null,
    ]),
    copyButton("th-copy-btn", col, `Copy column name "${col}"`),
  ]);
}

function renderTable(store: Store, pane: PaneState, tab: TabState): HTMLElement {
  if (tab.columns.length === 0) {
    return el("div", { class: "table-scroll" }, [el("div", { class: "table-empty" }, [tab.fetchError ?? "No data yet - click Fetch."])]);
  }
  if (tab.transposed) return renderTransposedTable(store, pane, tab);

  const columnLabels = tab.humanReadableColumns ? humanizeColumnNames(tab.columns) : null;
  const displayHints = tab.useDisplayHints ? tab.displayHints : null;
  const enumLabels = tab.useDisplayHints ? tab.enumLabels : null;

  const headRow = el(
    "tr",
    {},
    tab.columns.map((col) => {
      const startWidth = store.colWidth(tab, col);
      const sorted = tab.sortCol === col;
      const hint = tab.displayHints[col];
      const title = hint ? `${col} (has DISPLAY-HINT "${hint}")` : tab.enumLabels[col] ? `${col} (has named values)` : col;
      return el("th", { style: { width: startWidth + "px" }, title }, [
        renderColumnHeaderBtn(store, pane, tab, col, columnLabels, sorted),
        el("div", {
          class: "th-resize-handle",
          onmousedown: (e: MouseEvent) => startDrag(e, (dx) => store.setColWidth(pane.id, col, startWidth + dx)),
        }),
      ]);
    }),
  );

  const rows = store.getSortedRows(tab).map((row) => {
    const meta = store.rowMetaFor(tab, row);
    const status = meta?.status;
    const rowBg = status === "added" ? "var(--added-bg)" : status === "removed" ? "var(--removed-bg)" : "transparent";
    const opacity = status === "removed" ? "0.55" : "1";
    const textDecoration = status === "removed" ? "line-through" : "none";
    const changedFields = meta?.fields ?? [];
    return el(
      "tr",
      { style: { background: rowBg, opacity, textDecoration } },
      tab.columns.map((col) => renderCell(col, row, changedFields.includes(col), displayHints?.[col], enumLabels?.[col])),
    );
  });

  return el("div", { class: "table-scroll" }, [
    el("table", { class: "data-table" }, [el("thead", {}, [headRow]), el("tbody", {}, rows)]),
  ]);
}

/** Transposed layout: one column per fetched row (identified by its first column's value), one row per MIB column. Sorting still works, just clicked on the MIB-column's row label instead of a `<th>`. */
function renderTransposedTable(store: Store, pane: PaneState, tab: TabState): HTMLElement {
  const columnLabels = tab.humanReadableColumns ? humanizeColumnNames(tab.columns) : null;
  const displayHints = tab.useDisplayHints ? tab.displayHints : null;
  const enumLabels = tab.useDisplayHints ? tab.enumLabels : null;
  const rows = store.getSortedRows(tab);
  const rowMetas = rows.map((row) => store.rowMetaFor(tab, row));

  const headRow = el("tr", {}, [
    el("th", { class: "transposed-corner" }, []),
    ...rows.map((row, i) => {
      const status = rowMetas[i]?.status;
      const bg = status === "added" ? "var(--added-bg)" : status === "removed" ? "var(--removed-bg)" : "transparent";
      const opacity = status === "removed" ? "0.55" : "1";
      const textDecoration = status === "removed" ? "line-through" : "none";
      return el("th", { style: { width: DEFAULT_COL_WIDTH + "px", background: bg, opacity, textDecoration } }, [row[tab.columns[0]] ?? String(i + 1)]);
    }),
  ]);

  const bodyRows = tab.columns.map((col) => {
    const sorted = tab.sortCol === col;
    const hint = tab.displayHints[col];
    const title = hint ? `${col} (has DISPLAY-HINT "${hint}")` : tab.enumLabels[col] ? `${col} (has named values)` : col;
    const headerCell = el("th", { style: { width: DEFAULT_COL_WIDTH + "px" }, title }, [
      renderColumnHeaderBtn(store, pane, tab, col, columnLabels, sorted),
    ]);
    const cells = rows.map((row, i) =>
      renderCell(col, row, (rowMetas[i]?.fields ?? []).includes(col), displayHints?.[col], enumLabels?.[col], rowMetas[i]?.status),
    );
    return el("tr", {}, [headerCell, ...cells]);
  });

  return el("div", { class: "table-scroll" }, [
    el("table", { class: "data-table data-table-transposed" }, [el("thead", {}, [headRow]), el("tbody", {}, bodyRows)]),
  ]);
}

function renderStatusBar(tab: TabState): HTMLElement {
  const rowCount = tab.workingRows.length;
  const versionLabel = tab.version.replace("v", "");
  const connCell = tab.fetchError
    ? el("div", { class: "status-conn", title: tab.fetchError }, [el("span", { class: "status-conn-dot error" }), tab.fetchError])
    : el("div", { class: "status-conn" }, [el("span", { class: "status-conn-dot" }), `Connected to ${tab.hostAddr}:${tab.hostPort}`]);
  return el("div", { class: "status-bar" }, [
    connCell,
    el("div", {}, [`${rowCount} rows`]),
    el("div", {}, [tab.lastFetch ? `Last fetch: ${tab.lastFetch}` : "Not fetched yet"]),
    el("div", { class: "spacer" }),
    el("div", {}, [`SNMPv${versionLabel}`]),
  ]);
}

function renderEmptyPane(): HTMLElement {
  return el("div", { class: "pane-empty" }, [
    el("div", { class: "pane-empty-text" }, ["No tab open - double-click a node in the sidebar to open it"]),
  ]);
}

function renderPane(store: Store, pane: PaneState, isLast: boolean): HTMLElement {
  const tab = store.getPaneActiveTab(pane);
  const flexCss = isLast ? "1 1 0%" : `0 0 ${pane.width}px`;
  let body: HTMLElement[];
  if (!tab) {
    body = [renderEmptyPane()];
  } else if (tab.kind === "trap") {
    body = [renderTrapToolbar(store, pane, tab), renderTrapTable(store, pane, tab)];
  } else if (tab.kind === "benchmark") {
    body = renderBenchmarkPane(store, pane, tab);
  } else if (tab.kind === "gnmi") {
    body = renderGnmiPane(store, pane, tab);
  } else if (tab.kind === "netconf") {
    body = renderNetconfPane(store, pane, tab);
  } else {
    body = [renderToolbar(store, pane, tab), renderTableToolbar(store, pane, tab), renderTable(store, pane, tab), renderStatusBar(tab)];
  }
  return el(
    "div",
    { class: "pane", style: { flex: flexCss }, onclick: () => store.focusPane(pane.id) },
    [renderTabBar(store, pane), ...body],
  );
}

// ---------- Trap listener tab ----------

function renderTrapToolbar(store: Store, pane: PaneState, tab: TrapTabState): HTMLElement {
  const isV3 = tab.version === "v3";

  const versionRow = el(
    "div",
    { class: "version-toggle" },
    (["v1", "v2c", "v3"] as SnmpVersion[]).map((v) =>
      el(
        "button",
        {
          class: "version-btn" + (tab.version === v ? " active" : ""),
          disabled: tab.running,
          onclick: () => store.setTrapVersion(pane.id, v),
        },
        [v],
      ),
    ),
  );

  const fields: HTMLElement[] = [
    el("div", { class: "field" }, [
      el("label", { class: "field-label" }, ["Bind Address"]),
      el("input", {
        class: "field-input field-addr field-mono",
        value: tab.bindAddr,
        disabled: tab.running,
        "data-focus-key": `trap:${tab.id}:addr`,
        oninput: (e: Event) => store.updateActiveTrapTabInPane(pane.id, { bindAddr: (e.target as HTMLInputElement).value }),
      }),
    ]),
    el("div", { class: "field" }, [
      el("label", { class: "field-label" }, ["Port"]),
      el("input", {
        class: "field-input field-port field-mono",
        value: tab.port,
        disabled: tab.running,
        "data-focus-key": `trap:${tab.id}:port`,
        oninput: (e: Event) => store.updateActiveTrapTabInPane(pane.id, { port: (e.target as HTMLInputElement).value }),
      }),
    ]),
    el("div", { class: "field" }, [el("label", { class: "field-label" }, ["Version"]), versionRow]),
  ];

  if (isV3) {
    fields.push(
      el("div", { class: "v3-fields" }, [
        el("div", { class: "field" }, [
          el("label", { class: "field-label" }, ["Security User"]),
          el("input", {
            class: "field-input field-v3-user",
            value: tab.v3User,
            disabled: tab.running,
            "data-focus-key": `trap:${tab.id}:v3user`,
            oninput: (e: Event) => store.updateActiveTrapTabInPane(pane.id, { v3User: (e.target as HTMLInputElement).value }),
          }),
        ]),
        el("div", { class: "field" }, [
          el("label", { class: "field-label" }, ["Auth"]),
          el("input", {
            type: "password",
            class: "field-input field-v3-secret",
            value: tab.v3Auth,
            disabled: tab.running,
            "data-focus-key": `trap:${tab.id}:v3auth`,
            oninput: (e: Event) => store.updateActiveTrapTabInPane(pane.id, { v3Auth: (e.target as HTMLInputElement).value }),
          }),
        ]),
        el("div", { class: "field" }, [
          el("label", { class: "field-label" }, ["Priv"]),
          el("input", {
            type: "password",
            class: "field-input field-v3-secret",
            value: tab.v3Priv,
            disabled: tab.running,
            "data-focus-key": `trap:${tab.id}:v3priv`,
            oninput: (e: Event) => store.updateActiveTrapTabInPane(pane.id, { v3Priv: (e.target as HTMLInputElement).value }),
          }),
        ]),
      ]),
    );
  } else {
    fields.push(
      el("div", { class: "field" }, [
        el("label", { class: "field-label" }, ["Community (blank = any)"]),
        el("input", {
          class: "field-input field-community field-mono",
          value: tab.community,
          disabled: tab.running,
          "data-focus-key": `trap:${tab.id}:community`,
          oninput: (e: Event) => store.updateActiveTrapTabInPane(pane.id, { community: (e.target as HTMLInputElement).value }),
        }),
      ]),
    );
  }

  fields.push(el("div", { class: "spacer" }));
  fields.push(
    el(
      "button",
      {
        class: "split-btn-main" + (tab.running ? " trap-stop-btn" : ""),
        style: { borderRadius: "7px", alignSelf: "flex-end" },
        onclick: () => (tab.running ? store.stopTrapListenerTab(pane.id) : store.startTrapListener(pane.id)),
      },
      [tab.running ? "Stop" : "Listen"],
    ),
  );

  const statusText = tab.startError ? `Error: ${tab.startError}` : tab.running ? `Listening on ${tab.boundAddr}` : "Stopped";
  const statusRow = el("div", { class: "toolbar-row trap-status-row" }, [
    el("div", { class: "status-conn", title: tab.startError ?? undefined }, [
      el("span", { class: "status-conn-dot" + (tab.startError ? " error" : tab.running ? "" : " off") }),
      statusText,
    ]),
    el("div", {}, [`${tab.events.length} trap${tab.events.length === 1 ? "" : "s"}`]),
    el("input", {
      class: "field-input trap-filter",
      placeholder: "Filter by source, community/user, or trap name…",
      value: tab.filterText,
      "data-focus-key": `trap:${tab.id}:filter`,
      oninput: (e: Event) => store.setTrapFilter(pane.id, (e.target as HTMLInputElement).value),
    }),
    el(
      "button",
      {
        type: "button",
        class: "toggle-label",
        role: "switch",
        "aria-checked": tab.useDisplayHints ? "true" : "false",
        title: 'Show varbind values with a DISPLAY-HINT formatted (e.g. 123 -> 12.3) or an enumerated value named (e.g. 2 -> "ok") instead of raw',
        onclick: () => store.toggleTrapUseDisplayHints(pane.id),
      },
      [
        el("div", { class: "toggle-track" + (tab.useDisplayHints ? " on" : "") }, [el("div", { class: "toggle-knob" })]),
        "Display hint",
      ],
    ),
    el("button", { class: "trap-clear-btn", onclick: () => void store.clearTraps(pane.id) }, ["Clear"]),
  ]);

  const ipHint =
    store.localIps.length > 0
      ? el("div", { class: "trap-ip-hint" }, [
          "Point the device's trap destination at: ",
          ...store.localIps.map((ip) => el("button", { class: "trap-ip-chip", title: "Click to copy", onclick: (e: Event) => copyTrapIp(e.currentTarget as HTMLButtonElement, ip) }, [ip])),
        ])
      : null;

  return el("div", { class: "toolbar" }, [el("div", { class: "toolbar-row" }, fields), ipHint, statusRow]);
}

/** Copies an IP chip's text to the clipboard and briefly swaps its label to confirm, reverting after a moment. */
function copyTrapIp(chip: HTMLButtonElement, ip: string) {
  void navigator.clipboard.writeText(ip).then(() => {
    const original = chip.textContent;
    chip.textContent = "Copied!";
    chip.classList.add("copied");
    setTimeout(() => {
      chip.textContent = original;
      chip.classList.remove("copied");
    }, 1000);
  });
}

function formatTrapTime(ms: number): string {
  return new Date(ms).toLocaleTimeString();
}

function trapMatchesFilter(e: TrapEvent, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (!needle) return true;
  if (e.source.toLowerCase().includes(needle)) return true;
  if (e.principal.toLowerCase().includes(needle)) return true;
  if (e.trapType.toLowerCase().includes(needle)) return true;
  if (e.trapOid.includes(needle)) return true;
  return e.varbinds.some((v) => v.name.toLowerCase().includes(needle) || v.oid.includes(needle) || v.value.toLowerCase().includes(needle));
}

function renderTrapVarbindRow(v: TrapVarbind, useDisplayHints: boolean): HTMLElement {
  const { value, hinted } = useDisplayHints ? resolveCellValue(v.value, v.displayHint, v.enumLabels) : { value: v.value, hinted: false };
  return el("div", { class: "trap-varbind-row" }, [
    el("span", { class: "trap-varbind-name", title: v.oid }, [v.name]),
    el("span", { class: "trap-varbind-value", title: hinted ? `raw: ${v.value}` : undefined }, [value || "(empty)"]),
  ]);
}

function renderTrapRow(store: Store, pane: PaneState, tab: TrapTabState, e: TrapEvent): HTMLElement[] {
  if (e.error) {
    return [
      el("tr", { class: "trap-row trap-row-error" }, [
        el("td", {}, [formatTrapTime(e.timeMs)]),
        el("td", { class: "field-mono" }, [e.source]),
        el("td", { colspan: 3 }, [`⚠ ${e.error}`]),
      ]),
    ];
  }

  const expanded = tab.expandedSeq === e.seq;
  const rows: HTMLElement[] = [
    el(
      "tr",
      { class: "trap-row" + (expanded ? " expanded" : ""), onclick: () => store.toggleTrapExpanded(pane.id, e.seq) },
      [
        el("td", {}, [formatTrapTime(e.timeMs)]),
        el("td", { class: "field-mono" }, [e.source]),
        el("td", {}, [e.version.replace(/^SNMP/, "")]),
        el("td", {}, [e.principal]),
        el("td", {}, [
          e.trapType,
          e.confirmed
            ? el(
                "span",
                {
                  class: "trap-confirmed-badge",
                  title: "SNMPv2c/v3 Inform - this listener doesn't send the acknowledgement RFC 3416 expects, so the sender will keep retransmitting it",
                },
                ["INFORM"],
              )
            : null,
        ]),
      ],
    ),
  ];
  if (expanded) {
    rows.push(
      el("tr", { class: "trap-detail-row" }, [
        el("td", { colspan: 5 }, [
          el("div", { class: "trap-varbinds" }, [
            el("div", { class: "trap-varbind-header" }, [`Trap OID: ${e.trapOid || "(none)"}`]),
            ...e.varbinds.map((v) => renderTrapVarbindRow(v, tab.useDisplayHints)),
          ]),
        ]),
      ]),
    );
  }
  return rows;
}

function renderTrapTable(store: Store, pane: PaneState, tab: TrapTabState): HTMLElement {
  const events = tab.events.filter((e) => trapMatchesFilter(e, tab.filterText)).reverse();
  if (events.length === 0) {
    const empty = tab.events.length > 0 ? "No traps match the filter." : tab.running ? "No traps received yet." : "Not listening - click Listen to start.";
    return el("div", { class: "table-scroll" }, [el("div", { class: "table-empty" }, [empty])]);
  }

  const headRow = el("tr", {}, [
    el("th", {}, ["Time"]),
    el("th", {}, ["Source"]),
    el("th", {}, ["Ver"]),
    el("th", {}, ["Community / User"]),
    el("th", {}, ["Trap"]),
  ]);
  const rows = events.flatMap((e) => renderTrapRow(store, pane, tab, e));

  return el("div", { class: "table-scroll" }, [
    el("table", { class: "data-table trap-table" }, [el("thead", {}, [headRow]), el("tbody", {}, rows)]),
  ]);
}

// ---------- Walk benchmark ----------

/** Enough decimals to tell two runs apart without printing noise: finer for short walks, coarser for long ones. */
function formatMs(ms: number): string {
  if (ms >= 1000) return ms.toFixed(0);
  if (ms >= 100) return ms.toFixed(1);
  return ms.toFixed(2);
}

/** "240 varbinds", or "238-240 varbinds" when a per-walk count wasn't identical across runs (an agent whose table changed mid-benchmark). */
function formatPerWalkCount(values: number[], noun: string): string {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const plural = max === 1 ? noun : noun + "s";
  return min === max ? `${min} ${plural}` : `${min}-${max} ${plural}`;
}

function benchStatTile(label: string, value: string): HTMLElement {
  return el("div", { class: "bench-stat" }, [
    el("div", { class: "bench-stat-label" }, [label]),
    el("div", { class: "bench-stat-value" }, [value, el("span", { class: "bench-stat-unit" }, ["ms"])]),
  ]);
}

/** The per-run bar chart: one row per completed walk, bars scaled against the slowest one. */
function renderBenchRuns(bench: BenchmarkTabState): HTMLElement {
  const durations = bench.runs.map((r) => r.durationMs);
  const slowest = Math.max(...durations);
  const fastest = Math.min(...durations);

  const rows = bench.runs.map((run, i) => {
    // An all-identical set of timings would otherwise render every bar at 0 width.
    const width = slowest > 0 ? (run.durationMs / slowest) * 100 : 100;
    const extreme = bench.runs.length > 1 ? (run.durationMs === fastest ? " fastest" : run.durationMs === slowest ? " slowest" : "") : "";
    const title =
      `${run.varbinds} varbinds in ${run.requests} request${run.requests === 1 ? "" : "s"}` +
      (run.truncated ? " - stopped at the walk iteration cap, so this run covers only part of the subtree" : "");
    return el("div", { class: "bench-run", title }, [
      el("div", { class: "bench-run-index" }, [`#${i + 1}`]),
      el("div", { class: "bench-run-track" }, [el("div", { class: "bench-run-bar" + extreme, style: { width: width + "%" } })]),
      el("div", { class: "bench-run-time" }, [run.truncated ? "⚠ " : "", formatMs(run.durationMs) + " ms"]),
    ]);
  });

  return el("div", { class: "bench-runs" }, rows);
}

function renderBenchmarkToolbar(store: Store, pane: PaneState, tab: BenchmarkTabState): HTMLElement {
  const isV3 = tab.version === "v3";

  const versionRow = el(
    "div",
    { class: "version-toggle" },
    (["v1", "v2c", "v3"] as SnmpVersion[]).map((v) =>
      el(
        "button",
        {
          class: "version-btn" + (tab.version === v ? " active" : ""),
          disabled: tab.running,
          onclick: () => store.setBenchmarkVersion(pane.id, v),
        },
        [v],
      ),
    ),
  );

  const fields: HTMLElement[] = [
    el("div", { class: "field" }, [
      el("label", { class: "field-label" }, ["Address"]),
      el("input", {
        class: "field-input field-addr field-mono",
        value: tab.hostAddr,
        disabled: tab.running,
        "data-focus-key": `bench:${tab.id}:addr`,
        oninput: (e: Event) => store.updateActiveBenchmarkTabInPane(pane.id, { hostAddr: (e.target as HTMLInputElement).value }),
      }),
    ]),
    el("div", { class: "field" }, [
      el("label", { class: "field-label" }, ["Port"]),
      el("input", {
        class: "field-input field-port field-mono",
        value: tab.hostPort,
        disabled: tab.running,
        "data-focus-key": `bench:${tab.id}:port`,
        oninput: (e: Event) => store.updateActiveBenchmarkTabInPane(pane.id, { hostPort: (e.target as HTMLInputElement).value }),
      }),
    ]),
    el("div", { class: "field" }, [el("label", { class: "field-label" }, ["Version"]), versionRow]),
  ];

  if (isV3) {
    fields.push(
      el("div", { class: "v3-fields" }, [
        el("div", { class: "field" }, [
          el("label", { class: "field-label" }, ["Security User"]),
          el("input", {
            class: "field-input field-v3-user",
            value: tab.v3User,
            disabled: tab.running,
            "data-focus-key": `bench:${tab.id}:v3user`,
            oninput: (e: Event) => store.updateActiveBenchmarkTabInPane(pane.id, { v3User: (e.target as HTMLInputElement).value }),
          }),
        ]),
        el("div", { class: "field" }, [
          el("label", { class: "field-label" }, ["Auth"]),
          el("input", {
            type: "password",
            class: "field-input field-v3-secret",
            value: tab.v3Auth,
            disabled: tab.running,
            "data-focus-key": `bench:${tab.id}:v3auth`,
            oninput: (e: Event) => store.updateActiveBenchmarkTabInPane(pane.id, { v3Auth: (e.target as HTMLInputElement).value }),
          }),
        ]),
        el("div", { class: "field" }, [
          el("label", { class: "field-label" }, ["Priv"]),
          el("input", {
            type: "password",
            class: "field-input field-v3-secret",
            value: tab.v3Priv,
            disabled: tab.running,
            "data-focus-key": `bench:${tab.id}:v3priv`,
            oninput: (e: Event) => store.updateActiveBenchmarkTabInPane(pane.id, { v3Priv: (e.target as HTMLInputElement).value }),
          }),
        ]),
      ]),
    );
  } else {
    fields.push(
      el("div", { class: "field" }, [
        el("label", { class: "field-label" }, ["Community"]),
        el("input", {
          class: "field-input field-community field-mono",
          value: tab.community,
          disabled: tab.running,
          "data-focus-key": `bench:${tab.id}:community`,
          oninput: (e: Event) => store.updateActiveBenchmarkTabInPane(pane.id, { community: (e.target as HTMLInputElement).value }),
        }),
      ]),
    );
  }

  fields.push(
    el("div", { class: "field" }, [
      el("label", { class: "field-label" }, ["Runs"]),
      el("input", {
        type: "number",
        min: "1",
        max: "1000",
        class: "field-input field-runs",
        value: String(tab.iterations),
        disabled: tab.running,
        "data-focus-key": `bench:${tab.id}:iterations`,
        oninput: (e: Event) => store.setBenchmarkIterations(pane.id, Number((e.target as HTMLInputElement).value)),
      }),
    ]),
  );

  fields.push(el("div", { class: "spacer" }));

  const canRun = store.hasCompleteConnection(tab);
  const runDisabledReason = canRun
    ? ""
    : "Fill in the host address, port, and " + (tab.version === "v3" ? "security user" : "community") + " first";
  fields.push(
    tab.running
      ? el(
          "button",
          {
            class: "split-btn-main bench-stop-btn",
            style: { borderRadius: "7px", alignSelf: "flex-end" },
            disabled: tab.cancelling,
            onclick: () => store.cancelBenchmark(pane.id),
          },
          [tab.cancelling ? "Stopping…" : "Stop"],
        )
      : el(
          "button",
          {
            class: "split-btn-main",
            style: { borderRadius: "7px", alignSelf: "flex-end" },
            disabled: !canRun,
            title: runDisabledReason,
            onclick: () => void store.runBenchmark(pane.id),
          },
          [tab.runs.length ? "Run again" : "Run"],
        ),
  );

  return el("div", { class: "toolbar" }, [el("div", { class: "toolbar-row" }, fields)]);
}

function renderBenchmarkBody(tab: BenchmarkTabState): HTMLElement {
  const stats = computeStats(tab.runs.map((r) => r.durationMs));

  const body: (HTMLElement | null)[] = [
    el("div", { class: "bench-target" }, [
      el("div", { class: "bench-target-node" }, [tab.nodeLabel]),
      el("div", { class: "bench-target-oid" }, [tab.oid]),
    ]),
  ];

  const attempts = tab.runs.length + tab.failures;
  if (tab.running || (attempts > 0 && attempts < tab.iterations)) {
    const fraction = tab.iterations > 0 ? (attempts / tab.iterations) * 100 : 0;
    body.push(
      el("div", { class: "bench-progress" }, [
        el("div", { class: "bench-progress-track" }, [el("div", { class: "bench-progress-bar", style: { width: fraction + "%" } })]),
        el("div", { class: "bench-progress-text" }, [`${attempts} of ${tab.iterations} walks`]),
      ]),
    );
  }

  if (tab.error) {
    const prefix = tab.failures > 1 ? `${tab.failures} walks failed, most recently: ` : "Walk failed: ";
    body.push(el("div", { class: "bench-error" }, [prefix + tab.error]));
  }

  if (stats) {
    body.push(
      el("div", { class: "bench-stats" }, [
        benchStatTile("Min", formatMs(stats.min)),
        benchStatTile("Median", formatMs(stats.median)),
        benchStatTile("Mean", formatMs(stats.mean)),
        benchStatTile("P95", formatMs(stats.p95)),
        benchStatTile("Max", formatMs(stats.max)),
        benchStatTile("Std dev", formatMs(stats.stdDev)),
      ]),
    );
    body.push(
      el("div", { class: "bench-summary" }, [
        `${stats.count} walk${stats.count === 1 ? "" : "s"}` +
          (tab.failures > 0 ? ` (${tab.failures} failed, not counted)` : "") +
          " · " +
          `${formatPerWalkCount(tab.runs.map((r) => r.varbinds), "varbind")} and ` +
          `${formatPerWalkCount(tab.runs.map((r) => r.requests), "request")} per walk · ` +
          `${formatMs(stats.total)} ms total`,
      ]),
    );
    body.push(renderBenchRuns(tab));
  } else if (!tab.running && !tab.error) {
    body.push(el("div", { class: "bench-empty" }, ["No timings yet - set how many walks to run, then click Run."]));
  }

  return el("div", { class: "benchmark-body" }, body);
}

function renderBenchmarkPane(store: Store, pane: PaneState, tab: BenchmarkTabState): HTMLElement[] {
  return [renderBenchmarkToolbar(store, pane, tab), renderBenchmarkBody(tab)];
}

// ---------- gNMI tab ----------

const TLS_MODE_OPTIONS: { id: TlsMode; label: string }[] = [
  { id: "insecure", label: "Insecure" },
  { id: "tls", label: "TLS" },
  { id: "tlsSkipVerify", label: "Skip Verify" },
];

function renderGnmiToolbar(store: Store, pane: PaneState, tab: GnmiTabState): HTMLElement {
  const tlsRow = el(
    "div",
    { class: "version-toggle" },
    TLS_MODE_OPTIONS.map((opt) =>
      el(
        "button",
        {
          class: "version-btn" + (tab.tlsMode === opt.id ? " active" : ""),
          disabled: tab.loading,
          onclick: () => store.setGnmiTlsMode(pane.id, opt.id),
        },
        [opt.label],
      ),
    ),
  );

  const fields: HTMLElement[] = [
    el("div", { class: "field" }, [
      el("label", { class: "field-label" }, ["Address"]),
      el("input", {
        class: "field-input field-addr field-mono",
        value: tab.hostAddr,
        disabled: tab.loading,
        "data-focus-key": `gnmi:${tab.id}:addr`,
        oninput: (e: Event) => store.updateActiveGnmiTabInPane(pane.id, { hostAddr: (e.target as HTMLInputElement).value }),
      }),
    ]),
    el("div", { class: "field" }, [
      el("label", { class: "field-label" }, ["Port"]),
      el("input", {
        class: "field-input field-port field-mono",
        value: tab.hostPort,
        disabled: tab.loading,
        "data-focus-key": `gnmi:${tab.id}:port`,
        oninput: (e: Event) => store.updateActiveGnmiTabInPane(pane.id, { hostPort: (e.target as HTMLInputElement).value }),
      }),
    ]),
    el("div", { class: "field" }, [el("label", { class: "field-label" }, ["TLS"]), tlsRow]),
    el("div", { class: "field" }, [
      el("label", { class: "field-label" }, ["Username"]),
      el("input", {
        class: "field-input field-v3-user",
        value: tab.username,
        disabled: tab.loading,
        "data-focus-key": `gnmi:${tab.id}:username`,
        oninput: (e: Event) => store.updateActiveGnmiTabInPane(pane.id, { username: (e.target as HTMLInputElement).value }),
      }),
    ]),
    el("div", { class: "field" }, [
      el("label", { class: "field-label" }, ["Password"]),
      el("input", {
        type: "password",
        class: "field-input field-v3-secret",
        value: tab.password,
        disabled: tab.loading,
        "data-focus-key": `gnmi:${tab.id}:password`,
        oninput: (e: Event) => store.updateActiveGnmiTabInPane(pane.id, { password: (e.target as HTMLInputElement).value }),
      }),
    ]),
  ];

  if (tab.tlsMode === "tls") {
    fields.push(
      el("div", { class: "field" }, [
        el("label", { class: "field-label" }, ["CA Cert Path"]),
        el("input", {
          class: "field-input field-community field-mono",
          value: tab.caCertPath,
          disabled: tab.loading,
          "data-focus-key": `gnmi:${tab.id}:cacert`,
          oninput: (e: Event) => store.updateActiveGnmiTabInPane(pane.id, { caCertPath: (e.target as HTMLInputElement).value }),
        }),
      ]),
    );
  }

  const canRun = store.hasCompleteGnmiConnection(tab);
  const runDisabledReason = canRun ? "" : "Fill in the target address and port first";
  fields.push(el("div", { class: "spacer" }));
  fields.push(
    el(
      "button",
      {
        class: "toolbar-btn",
        disabled: !canRun || tab.loading,
        title: runDisabledReason,
        onclick: () => void store.runGnmiCapabilities(pane.id),
      },
      ["Capabilities"],
    ),
  );

  const pathRow = el("div", { class: "toolbar-row" }, [
    el("div", { class: "field", style: { flex: "1" } }, [
      el("label", { class: "field-label" }, ["Path"]),
      el("input", {
        class: "field-input field-mono",
        style: { width: "100%" },
        placeholder: "/interfaces/interface[name=eth0]/state",
        value: tab.path,
        disabled: tab.loading,
        "data-focus-key": `gnmi:${tab.id}:path`,
        oninput: (e: Event) => store.updateActiveGnmiTabInPane(pane.id, { path: (e.target as HTMLInputElement).value }),
      }),
    ]),
    el(
      "button",
      {
        class: "split-btn-main",
        style: { borderRadius: "7px", alignSelf: "flex-end", height: "28px" },
        disabled: !canRun || tab.loading || !tab.path.trim(),
        title: runDisabledReason,
        onclick: () => void store.runGnmiGet(pane.id),
      },
      [tab.loading ? "Fetching…" : "Get"],
    ),
  ]);

  return el("div", { class: "toolbar" }, [el("div", { class: "toolbar-row" }, fields), pathRow]);
}

/** Stable identity for a gNMI result node's expand/collapse state - its path-so-far, since the tree has no other per-node id. */
function gnmiNodeKey(parentKey: string, node: GnmiNode): string {
  return parentKey ? `${parentKey}/${node.name}` : node.name;
}

function gnmiNodeIcon(hasChildren: boolean): HTMLElement {
  if (hasChildren) {
    return el("div", { class: "tree-icon-group" }, [
      el("div", { class: "lid", style: { background: "var(--icon-group)" } }),
      el("div", { class: "body", style: { background: "var(--icon-group)" } }),
    ]);
  }
  return el("div", { class: "tree-icon-scalar", style: { background: "var(--icon-scalar)" } });
}

function renderGnmiNode(store: Store, pane: PaneState, tab: GnmiTabState, node: GnmiNode, parentKey: string, depth: number): HTMLElement[] {
  const key = gnmiNodeKey(parentKey, node);
  const hasChildren = node.children.length > 0;
  const expanded = !!tab.expandedIds[key];
  const selected = key === tab.path;
  const row = el(
    "div",
    {
      class: "gnmi-tree-row" + (selected ? " selected" : ""),
      style: { paddingLeft: depth * 16 + 2 + "px" },
      title: key,
      onclick: () => store.updateActiveGnmiTabInPane(pane.id, { path: key }),
      ondblclick: () => {
        store.updateActiveGnmiTabInPane(pane.id, { path: key });
        void store.runGnmiGet(pane.id);
      },
    },
    [
      el(
        "div",
        {
          class: "gnmi-tree-caret",
          style: { visibility: hasChildren ? "visible" : "hidden", transform: `rotate(${hasChildren && expanded ? 90 : 0}deg)` },
          onclick: hasChildren
            ? (e: MouseEvent) => {
                e.stopPropagation();
                store.toggleGnmiNodeExpanded(pane.id, key);
              }
            : undefined,
        },
        ["▶"],
      ),
      gnmiNodeIcon(hasChildren),
      el("span", { class: "gnmi-tree-name" }, [node.name]),
      node.value != null ? el("span", { class: "gnmi-tree-value" }, [node.value]) : null,
      copyButton("tree-copy-btn", node.value ?? node.name, `Copy ${node.value != null ? "value" : "name"}`),
    ],
  );
  const out: HTMLElement[] = [row];
  if (hasChildren && expanded) {
    for (const child of node.children) out.push(...renderGnmiNode(store, pane, tab, child, key, depth + 1));
  }
  return out;
}

function renderGnmiCapabilities(caps: NonNullable<GnmiTabState["capabilities"]>): HTMLElement {
  return el("div", { class: "gnmi-caps" }, [
    el("div", { class: "gnmi-caps-row" }, [el("span", { class: "gnmi-caps-label" }, ["gNMI version"]), caps.gnmiVersion]),
    el("div", { class: "gnmi-caps-row" }, [
      el("span", { class: "gnmi-caps-label" }, ["Encodings"]),
      caps.supportedEncodings.join(", ") || "(none reported)",
    ]),
    el("div", { class: "gnmi-caps-row" }, [el("span", { class: "gnmi-caps-label" }, ["Models"]), String(caps.supportedModels.length)]),
    el(
      "div",
      { class: "gnmi-caps-models" },
      caps.supportedModels.map((m) => el("div", { class: "gnmi-caps-model" }, [`${m.name} (${m.organization}) ${m.version}`])),
    ),
  ]);
}

function renderGnmiBody(store: Store, pane: PaneState, tab: GnmiTabState): HTMLElement {
  if (tab.fetchError) {
    return el("div", { class: "table-scroll" }, [el("div", { class: "table-empty" }, [tab.fetchError])]);
  }
  if (tab.result) {
    const rows = tab.result.flatMap((n) => renderGnmiNode(store, pane, tab, n, "", 0));
    return el("div", { class: "table-scroll" }, [el("div", { class: "gnmi-tree" }, rows)]);
  }
  if (tab.capabilities) {
    return el("div", { class: "table-scroll" }, [renderGnmiCapabilities(tab.capabilities)]);
  }
  return el("div", { class: "table-scroll" }, [
    el("div", { class: "table-empty" }, ["Enter a target and path, then click Get - or click Capabilities to see what the target supports."]),
  ]);
}

function renderYangTreeRow(store: Store, node: YangNode, depth: number): HTMLElement[] {
  const expandKey = `yang:${node.id}`;
  const hasChildren = node.children.length > 0;
  const expanded = !!store.state.expanded[expandKey];
  const selected = node.id === store.state.selectedYangNodeId;
  const textColor = selected ? "var(--tree-selected-text)" : "var(--tree-item-text)";
  const bg = selected ? "var(--accent-selected-bg)" : "transparent";
  const row = el(
    "div",
    {
      class: "tree-row",
      title: node.path || `${node.label} could not be resolved`,
      style: { paddingLeft: depth * 16 + 2 + "px", opacity: node.resolved ? "1" : "0.45" },
      onclick: () => store.selectYangNode(node),
      ondblclick: () => store.openYangNodeInNewTab(node),
      oncontextmenu: (e: MouseEvent) => {
        e.preventDefault();
        store.openYangTreeContextMenu(e.clientX, e.clientY, node.id);
      },
    },
    [
      el("div", { class: "tree-row-bg", style: { background: bg } }, [
        el(
          "div",
          {
            class: "tree-caret",
            style: { visibility: hasChildren ? "visible" : "hidden", transform: `rotate(${hasChildren && expanded ? 90 : 0}deg)` },
            onclick: hasChildren
              ? (e: MouseEvent) => {
                  e.stopPropagation();
                  store.toggleExpand(expandKey);
                }
              : undefined,
          },
          ["▶"],
        ),
        nodeIcon(node),
        el("div", { class: "tree-label", style: { color: textColor, fontWeight: selected ? "600" : "400" } }, [node.label]),
        copyButton("tree-copy-btn", node.path || node.label, `Copy ${node.path ? "path" : "name"}`),
      ]),
    ],
  );
  const out: HTMLElement[] = [row];
  if (hasChildren && expanded) {
    for (const child of node.children) out.push(...renderYangTreeRow(store, child, depth + 1));
  }
  return out;
}

/** The YANG directories/profile UI plus the schema tree, shown in the left sidebar below the MIB
 * section - the gNMI counterpart to the MIB directory list and OID tree above it. Clicking a node
 * stages its path into whichever gNMI tab is currently active (see `Store.selectYangNode`).
 * `isLast` - whether this is the last expanded sidebar section - is threaded down to its tree
 * area's flex-basis; see `sidebarTreeFlex()`. */
function renderYangSection(store: Store, isLast: boolean): (HTMLElement | null)[] {
  const collapsed = store.state.yangSectionCollapsed;
  const activeProfile = store.activeYangProfile();
  const errors = store.state.yangParseErrors;
  const dirRows: HTMLElement[] = (activeProfile?.dirs ?? []).flatMap((dir) => {
    const files = store.yangDirFiles.find((d) => d.dir === dir)?.files ?? [];
    const expandKey = `yangdir:${dir}`;
    const expanded = files.length > 0 && !!store.state.expanded[expandKey];

    const row = el("div", { class: "mib-dir-row" }, [
      el(
        "div",
        {
          class: "mib-dir-caret",
          style: { visibility: files.length ? "visible" : "hidden", transform: `rotate(${expanded ? 90 : 0}deg)` },
          onclick: files.length ? () => store.toggleExpand(expandKey) : undefined,
        },
        ["▶"],
      ),
      el("div", { class: "mib-dir-icon" }),
      el("div", { class: "mib-dir-path", title: dir }, [dir]),
      el("button", { class: "mib-dir-remove", title: "Remove directory", onclick: () => void store.removeYangDir(dir) }, ["×"]),
    ]);

    if (!expanded) return [row];

    const fileRows = files.map((file) => {
      const fileErrors = errors.find((fe) => fe.file === file)?.errors;
      const hasIssue = !!fileErrors?.length;
      const relativePath = file.startsWith(dir) ? file.slice(dir.length).replace(/^[/\\]/, "") : file;
      const title = hasIssue ? `${file}\n\n${fileErrors!.join("\n")}` : file;
      return el("div", { class: "mib-file-row", title }, [
        el("div", { class: "mib-file-icon" + (hasIssue ? " mib-file-icon-issue" : "") }),
        el("div", { class: "mib-file-name" + (hasIssue ? " mib-file-name-issue" : "") }, [relativePath]),
      ]);
    });

    return [row, ...fileRows];
  });
  if (errors.length) {
    const issueCount = errors.reduce((n, fe) => n + fe.errors.length, 0);
    dirRows.push(
      el(
        "button",
        { class: "mib-dir-warning", onclick: () => store.toggleYangParseErrors() },
        [`⚠ ${issueCount} issue${issueCount === 1 ? "" : "s"} while parsing`],
      ),
    );
  }

  const draft = store.state.yangDirDraft;
  const draftRow =
    draft === null
      ? null
      : el("div", { class: "mib-dir-draft-row" }, [
          el("input", {
            class: "mib-dir-draft-input yang-dir-draft-input",
            placeholder: "/absolute/path/to/yang",
            value: draft,
            "data-focus-key": "yangDirDraft",
            oninput: (e: Event) => store.updateYangDirDraft((e.target as HTMLInputElement).value),
            onkeydown: (e: KeyboardEvent) => {
              if (e.key === "Enter") void store.submitYangDirDraft();
              else if (e.key === "Escape") store.cancelYangDirDraft();
            },
          }),
          el("button", { class: "mib-dir-draft-confirm", title: "Add", onclick: () => void store.submitYangDirDraft() }, ["✓"]),
          el("button", { class: "mib-dir-draft-cancel", title: "Cancel", onclick: () => store.cancelYangDirDraft() }, ["×"]),
        ]);

  const profiles = store.state.yangProfiles;
  const canDeleteProfile = profiles.length > 1;
  const profileRow = el("div", { class: "mib-profile-row" }, [
    el(
      "select",
      {
        class: "mib-profile-select",
        value: store.state.activeYangProfileId,
        onchange: (e: Event) => void store.switchYangProfile((e.target as HTMLSelectElement).value),
      },
      profiles.map((p) => el("option", { value: p.id }, [p.name])),
    ),
    el(
      "button",
      {
        class: "mib-profile-btn",
        title: "Rename profile",
        onclick: () => {
          store.startRenamingYangProfile();
          document.querySelector<HTMLInputElement>(".yang-profile-rename-input")?.select();
        },
      },
      ["✎"],
    ),
    canDeleteProfile
      ? el(
          "button",
          {
            class: "mib-profile-btn",
            title: "Delete profile",
            onclick: () => void store.removeYangProfile(store.state.activeYangProfileId),
          },
          ["×"],
        )
      : null,
    el(
      "button",
      {
        class: "mib-profile-btn",
        title: "New profile",
        onclick: () => {
          store.startYangProfileDraft();
          document.querySelector<HTMLInputElement>(".yang-profile-draft-input")?.focus();
        },
      },
      ["+"],
    ),
  ]);

  const renameRow = store.state.renamingYangProfile
    ? el("div", { class: "mib-dir-draft-row" }, [
        el("input", {
          class: "mib-dir-draft-input yang-profile-rename-input",
          value: activeProfile?.name ?? "",
          "data-focus-key": "yangProfileRename",
          onkeydown: (e: KeyboardEvent) => {
            if (e.key === "Enter") void store.renameYangProfile(store.state.activeYangProfileId, (e.target as HTMLInputElement).value);
            else if (e.key === "Escape") store.cancelRenamingYangProfile();
          },
        }),
        el(
          "button",
          {
            class: "mib-dir-draft-confirm",
            title: "Save",
            onclick: () => {
              const input = document.querySelector<HTMLInputElement>(".yang-profile-rename-input");
              void store.renameYangProfile(store.state.activeYangProfileId, input?.value ?? "");
            },
          },
          ["✓"],
        ),
        el("button", { class: "mib-dir-draft-cancel", title: "Cancel", onclick: () => store.cancelRenamingYangProfile() }, ["×"]),
      ])
    : null;

  const profileDraft = store.state.yangProfileDraft;
  const profileDraftRow =
    profileDraft === null
      ? null
      : el("div", { class: "mib-dir-draft-row" }, [
          el("input", {
            class: "mib-dir-draft-input yang-profile-draft-input",
            placeholder: "Profile name",
            value: profileDraft,
            "data-focus-key": "yangProfileDraft",
            oninput: (e: Event) => store.updateYangProfileDraft((e.target as HTMLInputElement).value),
            onkeydown: (e: KeyboardEvent) => {
              if (e.key === "Enter") void store.submitYangProfileDraft();
              else if (e.key === "Escape") store.cancelYangProfileDraft();
            },
          }),
          el("button", { class: "mib-dir-draft-confirm", title: "Create", onclick: () => void store.submitYangProfileDraft() }, ["✓"]),
          el("button", { class: "mib-dir-draft-cancel", title: "Cancel", onclick: () => store.cancelYangProfileDraft() }, ["×"]),
        ]);

  const treeRows = store.yangTree.flatMap((n) => renderYangTreeRow(store, n, 0));
  const startHeight = store.state.yangTreeHeight;

  const head = sidebarSectionHead("YANG (gNMI)", collapsed, () => store.toggleYangSectionCollapsed());
  if (collapsed) return [head];

  return [
    head,
    el("div", { class: "mib-dirs" }, [
      profileRow,
      renameRow,
      profileDraftRow,
      el("div", { class: "mib-dirs-head" }, [
        el("div", { class: "mib-dirs-title" }, ["YANG Directories"]),
        el(
          "button",
          {
            class: "mib-dir-add",
            title: "Add YANG directory",
            onclick: () => {
              void store.addYangDir();
              document.querySelector<HTMLInputElement>(".yang-dir-draft-input")?.focus();
            },
          },
          ["+"],
        ),
      ]),
      el("div", { class: "mib-dir-list" }, dirRows),
      draftRow,
    ]),
    el(
      "div",
      { class: "tree", "data-preserve-scroll": "yangTree", style: { flex: sidebarTreeFlex(startHeight, isLast) } },
      treeRows.length ? treeRows : [el("div", { class: "table-empty" }, ["No YANG files found - add a directory above."])],
    ),
    isLast ? null : renderSplitterH((e) => startDragY(e, (dy) => store.setYangTreeHeight(startHeight + dy))),
  ];
}

function renderNetconfYangTreeRow(store: Store, node: YangNode, depth: number): HTMLElement[] {
  const expandKey = `netconf-yang:${node.id}`;
  const hasChildren = node.children.length > 0;
  const expanded = !!store.state.expanded[expandKey];
  const selected = node.id === store.state.selectedNetconfYangNodeId;
  const textColor = selected ? "var(--tree-selected-text)" : "var(--tree-item-text)";
  const bg = selected ? "var(--accent-selected-bg)" : "transparent";
  const row = el(
    "div",
    {
      class: "tree-row",
      title: node.path || `${node.label} could not be resolved`,
      style: { paddingLeft: depth * 16 + 2 + "px", opacity: node.resolved ? "1" : "0.45" },
      onclick: () => store.selectNetconfYangNode(node),
      ondblclick: () => store.openNetconfYangNodeInNewTab(node),
      oncontextmenu: (e: MouseEvent) => {
        e.preventDefault();
        store.openNetconfYangTreeContextMenu(e.clientX, e.clientY, node.id);
      },
    },
    [
      el("div", { class: "tree-row-bg", style: { background: bg } }, [
        el(
          "div",
          {
            class: "tree-caret",
            style: { visibility: hasChildren ? "visible" : "hidden", transform: `rotate(${hasChildren && expanded ? 90 : 0}deg)` },
            onclick: hasChildren
              ? (e: MouseEvent) => {
                  e.stopPropagation();
                  store.toggleExpand(expandKey);
                }
              : undefined,
          },
          ["▶"],
        ),
        nodeIcon(node),
        el("div", { class: "tree-label", style: { color: textColor, fontWeight: selected ? "600" : "400" } }, [node.label]),
        copyButton("tree-copy-btn", node.path || node.label, `Copy ${node.path ? "path" : "name"}`),
      ]),
    ],
  );
  const out: HTMLElement[] = [row];
  if (hasChildren && expanded) {
    for (const child of node.children) out.push(...renderNetconfYangTreeRow(store, child, depth + 1));
  }
  return out;
}

/** The NETCONF-side counterpart to `renderYangSection`, over its own separate profile/directory
 * state and schema tree (`netconfYang*`) - see `NetconfYangProfile`'s doc comment for why NETCONF
 * doesn't just reuse gNMI's YANG section. Clicking a node stages its path into whichever NETCONF
 * tab is currently active (see `Store.selectNetconfYangNode`). `isLast` - see `renderYangSection`. */
function renderNetconfYangSection(store: Store, isLast: boolean): (HTMLElement | null)[] {
  const collapsed = store.state.netconfYangSectionCollapsed;
  const activeProfile = store.activeNetconfYangProfile();
  const errors = store.state.netconfYangParseErrors;
  const dirRows: HTMLElement[] = (activeProfile?.dirs ?? []).flatMap((dir) => {
    const files = store.netconfYangDirFiles.find((d) => d.dir === dir)?.files ?? [];
    const expandKey = `netconf-yangdir:${dir}`;
    const expanded = files.length > 0 && !!store.state.expanded[expandKey];

    const row = el("div", { class: "mib-dir-row" }, [
      el(
        "div",
        {
          class: "mib-dir-caret",
          style: { visibility: files.length ? "visible" : "hidden", transform: `rotate(${expanded ? 90 : 0}deg)` },
          onclick: files.length ? () => store.toggleExpand(expandKey) : undefined,
        },
        ["▶"],
      ),
      el("div", { class: "mib-dir-icon" }),
      el("div", { class: "mib-dir-path", title: dir }, [dir]),
      el("button", { class: "mib-dir-remove", title: "Remove directory", onclick: () => void store.removeNetconfYangDir(dir) }, ["×"]),
    ]);

    if (!expanded) return [row];

    const fileRows = files.map((file) => {
      const fileErrors = errors.find((fe) => fe.file === file)?.errors;
      const hasIssue = !!fileErrors?.length;
      const relativePath = file.startsWith(dir) ? file.slice(dir.length).replace(/^[/\\]/, "") : file;
      const title = hasIssue ? `${file}\n\n${fileErrors!.join("\n")}` : file;
      return el("div", { class: "mib-file-row", title }, [
        el("div", { class: "mib-file-icon" + (hasIssue ? " mib-file-icon-issue" : "") }),
        el("div", { class: "mib-file-name" + (hasIssue ? " mib-file-name-issue" : "") }, [relativePath]),
      ]);
    });

    return [row, ...fileRows];
  });
  if (errors.length) {
    const issueCount = errors.reduce((n, fe) => n + fe.errors.length, 0);
    dirRows.push(
      el(
        "button",
        { class: "mib-dir-warning", onclick: () => store.toggleNetconfYangParseErrors() },
        [`⚠ ${issueCount} issue${issueCount === 1 ? "" : "s"} while parsing`],
      ),
    );
  }

  const draft = store.state.netconfYangDirDraft;
  const draftRow =
    draft === null
      ? null
      : el("div", { class: "mib-dir-draft-row" }, [
          el("input", {
            class: "mib-dir-draft-input netconf-yang-dir-draft-input",
            placeholder: "/absolute/path/to/yang",
            value: draft,
            "data-focus-key": "netconfYangDirDraft",
            oninput: (e: Event) => store.updateNetconfYangDirDraft((e.target as HTMLInputElement).value),
            onkeydown: (e: KeyboardEvent) => {
              if (e.key === "Enter") void store.submitNetconfYangDirDraft();
              else if (e.key === "Escape") store.cancelNetconfYangDirDraft();
            },
          }),
          el("button", { class: "mib-dir-draft-confirm", title: "Add", onclick: () => void store.submitNetconfYangDirDraft() }, ["✓"]),
          el("button", { class: "mib-dir-draft-cancel", title: "Cancel", onclick: () => store.cancelNetconfYangDirDraft() }, ["×"]),
        ]);

  const profiles = store.state.netconfYangProfiles;
  const canDeleteProfile = profiles.length > 1;
  const profileRow = el("div", { class: "mib-profile-row" }, [
    el(
      "select",
      {
        class: "mib-profile-select",
        value: store.state.activeNetconfYangProfileId,
        onchange: (e: Event) => void store.switchNetconfYangProfile((e.target as HTMLSelectElement).value),
      },
      profiles.map((p) => el("option", { value: p.id }, [p.name])),
    ),
    el(
      "button",
      {
        class: "mib-profile-btn",
        title: "Rename profile",
        onclick: () => {
          store.startRenamingNetconfYangProfile();
          document.querySelector<HTMLInputElement>(".netconf-yang-profile-rename-input")?.select();
        },
      },
      ["✎"],
    ),
    canDeleteProfile
      ? el(
          "button",
          {
            class: "mib-profile-btn",
            title: "Delete profile",
            onclick: () => void store.removeNetconfYangProfile(store.state.activeNetconfYangProfileId),
          },
          ["×"],
        )
      : null,
    el(
      "button",
      {
        class: "mib-profile-btn",
        title: "New profile",
        onclick: () => {
          store.startNetconfYangProfileDraft();
          document.querySelector<HTMLInputElement>(".netconf-yang-profile-draft-input")?.focus();
        },
      },
      ["+"],
    ),
  ]);

  const renameRow = store.state.renamingNetconfYangProfile
    ? el("div", { class: "mib-dir-draft-row" }, [
        el("input", {
          class: "mib-dir-draft-input netconf-yang-profile-rename-input",
          value: activeProfile?.name ?? "",
          "data-focus-key": "netconfYangProfileRename",
          onkeydown: (e: KeyboardEvent) => {
            if (e.key === "Enter") void store.renameNetconfYangProfile(store.state.activeNetconfYangProfileId, (e.target as HTMLInputElement).value);
            else if (e.key === "Escape") store.cancelRenamingNetconfYangProfile();
          },
        }),
        el(
          "button",
          {
            class: "mib-dir-draft-confirm",
            title: "Save",
            onclick: () => {
              const input = document.querySelector<HTMLInputElement>(".netconf-yang-profile-rename-input");
              void store.renameNetconfYangProfile(store.state.activeNetconfYangProfileId, input?.value ?? "");
            },
          },
          ["✓"],
        ),
        el("button", { class: "mib-dir-draft-cancel", title: "Cancel", onclick: () => store.cancelRenamingNetconfYangProfile() }, ["×"]),
      ])
    : null;

  const profileDraft = store.state.netconfYangProfileDraft;
  const profileDraftRow =
    profileDraft === null
      ? null
      : el("div", { class: "mib-dir-draft-row" }, [
          el("input", {
            class: "mib-dir-draft-input netconf-yang-profile-draft-input",
            placeholder: "Profile name",
            value: profileDraft,
            "data-focus-key": "netconfYangProfileDraft",
            oninput: (e: Event) => store.updateNetconfYangProfileDraft((e.target as HTMLInputElement).value),
            onkeydown: (e: KeyboardEvent) => {
              if (e.key === "Enter") void store.submitNetconfYangProfileDraft();
              else if (e.key === "Escape") store.cancelNetconfYangProfileDraft();
            },
          }),
          el("button", { class: "mib-dir-draft-confirm", title: "Create", onclick: () => void store.submitNetconfYangProfileDraft() }, ["✓"]),
          el("button", { class: "mib-dir-draft-cancel", title: "Cancel", onclick: () => store.cancelNetconfYangProfileDraft() }, ["×"]),
        ]);

  const treeRows = store.netconfYangTree.flatMap((n) => renderNetconfYangTreeRow(store, n, 0));
  const startHeight = store.state.netconfYangTreeHeight;

  const head = sidebarSectionHead("YANG (NETCONF)", collapsed, () => store.toggleNetconfYangSectionCollapsed());
  if (collapsed) return [head];

  return [
    head,
    el("div", { class: "mib-dirs" }, [
      profileRow,
      renameRow,
      profileDraftRow,
      el("div", { class: "mib-dirs-head" }, [
        el("div", { class: "mib-dirs-title" }, ["YANG Directories"]),
        el(
          "button",
          {
            class: "mib-dir-add",
            title: "Add YANG directory",
            onclick: () => {
              void store.addNetconfYangDir();
              document.querySelector<HTMLInputElement>(".netconf-yang-dir-draft-input")?.focus();
            },
          },
          ["+"],
        ),
      ]),
      el("div", { class: "mib-dir-list" }, dirRows),
      draftRow,
    ]),
    el(
      "div",
      { class: "tree", "data-preserve-scroll": "netconfYangTree", style: { flex: sidebarTreeFlex(startHeight, isLast) } },
      treeRows.length ? treeRows : [el("div", { class: "table-empty" }, ["No YANG files found - add a directory above."])],
    ),
    isLast ? null : renderSplitterH((e) => startDragY(e, (dy) => store.setNetconfYangTreeHeight(startHeight + dy))),
  ];
}

function renderGnmiPane(store: Store, pane: PaneState, tab: GnmiTabState): HTMLElement[] {
  return [renderGnmiToolbar(store, pane, tab), renderGnmiBody(store, pane, tab)];
}

/** The NETCONF-tab counterpart to `renderGnmiToolbar`: address/port/username/password (SSH,
 * password auth only in Phase 1 - see `netconf.rs`) instead of gNMI's address/port/TLS/username/
 * password, otherwise the same Capabilities-button-plus-path-and-Get-row shape. */
function renderNetconfToolbar(store: Store, pane: PaneState, tab: NetconfTabState): HTMLElement {
  const fields: HTMLElement[] = [
    el("div", { class: "field" }, [
      el("label", { class: "field-label" }, ["Address"]),
      el("input", {
        class: "field-input field-addr field-mono",
        value: tab.hostAddr,
        disabled: tab.loading,
        "data-focus-key": `netconf:${tab.id}:addr`,
        oninput: (e: Event) => store.updateActiveNetconfTabInPane(pane.id, { hostAddr: (e.target as HTMLInputElement).value }),
      }),
    ]),
    el("div", { class: "field" }, [
      el("label", { class: "field-label" }, ["Port"]),
      el("input", {
        class: "field-input field-port field-mono",
        value: tab.hostPort,
        disabled: tab.loading,
        "data-focus-key": `netconf:${tab.id}:port`,
        oninput: (e: Event) => store.updateActiveNetconfTabInPane(pane.id, { hostPort: (e.target as HTMLInputElement).value }),
      }),
    ]),
    el("div", { class: "field" }, [
      el("label", { class: "field-label" }, ["Username"]),
      el("input", {
        class: "field-input field-v3-user",
        value: tab.username,
        disabled: tab.loading,
        "data-focus-key": `netconf:${tab.id}:username`,
        oninput: (e: Event) => store.updateActiveNetconfTabInPane(pane.id, { username: (e.target as HTMLInputElement).value }),
      }),
    ]),
    el("div", { class: "field" }, [
      el("label", { class: "field-label" }, ["Password"]),
      el("input", {
        type: "password",
        class: "field-input field-v3-secret",
        value: tab.password,
        disabled: tab.loading,
        "data-focus-key": `netconf:${tab.id}:password`,
        oninput: (e: Event) => store.updateActiveNetconfTabInPane(pane.id, { password: (e.target as HTMLInputElement).value }),
      }),
    ]),
  ];

  const canRun = store.hasCompleteNetconfConnection(tab);
  const runDisabledReason = canRun ? "" : "Fill in the target address, port, username, and password first";
  fields.push(el("div", { class: "spacer" }));
  fields.push(
    el(
      "button",
      {
        class: "toolbar-btn",
        disabled: !canRun || tab.loading,
        title: runDisabledReason,
        onclick: () => void store.runNetconfCapabilities(pane.id),
      },
      ["Capabilities"],
    ),
  );

  const pathRow = el("div", { class: "toolbar-row" }, [
    el("div", { class: "field", style: { flex: "1" } }, [
      el("label", { class: "field-label" }, ["Path"]),
      el("input", {
        class: "field-input field-mono",
        style: { width: "100%" },
        placeholder: "/interfaces/interface[name='eth0']",
        value: tab.path,
        disabled: tab.loading,
        "data-focus-key": `netconf:${tab.id}:path`,
        oninput: (e: Event) => store.updateActiveNetconfTabInPane(pane.id, { path: (e.target as HTMLInputElement).value }),
      }),
    ]),
    el(
      "button",
      {
        class: "split-btn-main",
        style: { borderRadius: "7px", alignSelf: "flex-end", height: "28px" },
        disabled: !canRun || tab.loading || !tab.path.trim(),
        title: runDisabledReason,
        onclick: () => void store.runNetconfGet(pane.id),
      },
      [tab.loading ? "Fetching…" : "Get"],
    ),
  ]);

  return el("div", { class: "toolbar" }, [el("div", { class: "toolbar-row" }, fields), pathRow]);
}

/** Stable identity for a NETCONF result node's expand/collapse state. Unlike `gnmiNodeKey` (whose
 * gNMI path elements already carry list keys), this includes the sibling index: an XML `<get>`
 * reply repeats element names for list entries (e.g. two `<interface>` under `<interfaces>`), so
 * the name alone isn't unique among siblings. */
function netconfNodeKey(parentKey: string, node: NetconfNode, index: number): string {
  const self = `${node.name}[${index}]`;
  return parentKey ? `${parentKey}/${self}` : self;
}

function renderNetconfNode(store: Store, pane: PaneState, tab: NetconfTabState, node: NetconfNode, parentKey: string, depth: number, index: number): HTMLElement[] {
  const key = netconfNodeKey(parentKey, node, index);
  const hasChildren = node.children.length > 0;
  const expanded = !!tab.expandedIds[key];
  const row = el(
    "div",
    {
      class: "gnmi-tree-row",
      style: { paddingLeft: depth * 16 + 2 + "px" },
      title: key,
      onclick: hasChildren ? () => store.toggleNetconfNodeExpanded(pane.id, key) : undefined,
    },
    [
      el(
        "div",
        {
          class: "gnmi-tree-caret",
          style: { visibility: hasChildren ? "visible" : "hidden", transform: `rotate(${hasChildren && expanded ? 90 : 0}deg)` },
          onclick: hasChildren
            ? (e: MouseEvent) => {
                e.stopPropagation();
                store.toggleNetconfNodeExpanded(pane.id, key);
              }
            : undefined,
        },
        ["▶"],
      ),
      gnmiNodeIcon(hasChildren),
      el("span", { class: "gnmi-tree-name" }, [node.name]),
      node.value != null ? el("span", { class: "gnmi-tree-value" }, [node.value]) : null,
      copyButton("tree-copy-btn", node.value ?? node.name, `Copy ${node.value != null ? "value" : "name"}`),
    ],
  );
  const out: HTMLElement[] = [row];
  if (hasChildren && expanded) {
    node.children.forEach((child, childIndex) => out.push(...renderNetconfNode(store, pane, tab, child, key, depth + 1, childIndex)));
  }
  return out;
}

function renderNetconfCapabilities(caps: NonNullable<NetconfTabState["capabilities"]>): HTMLElement {
  return el("div", { class: "gnmi-caps" }, [
    el("div", { class: "gnmi-caps-row" }, [el("span", { class: "gnmi-caps-label" }, ["Session ID"]), caps.sessionId || "(none reported)"]),
    el("div", { class: "gnmi-caps-row" }, [el("span", { class: "gnmi-caps-label" }, ["Capabilities"]), String(caps.capabilities.length)]),
    el(
      "div",
      { class: "gnmi-caps-models" },
      caps.capabilities.map((c) => el("div", { class: "gnmi-caps-model" }, [c])),
    ),
  ]);
}

function renderNetconfBody(store: Store, pane: PaneState, tab: NetconfTabState): HTMLElement {
  if (tab.fetchError) {
    return el("div", { class: "table-scroll" }, [el("div", { class: "table-empty" }, [tab.fetchError])]);
  }
  if (tab.result) {
    const rows = tab.result.flatMap((n, index) => renderNetconfNode(store, pane, tab, n, "", 0, index));
    return el("div", { class: "table-scroll" }, [el("div", { class: "gnmi-tree" }, rows)]);
  }
  if (tab.capabilities) {
    return el("div", { class: "table-scroll" }, [renderNetconfCapabilities(tab.capabilities)]);
  }
  return el("div", { class: "table-scroll" }, [
    el("div", { class: "table-empty" }, ["Enter a target and path, then click Get - or click Capabilities to see what the target supports."]),
  ]);
}

function renderNetconfPane(store: Store, pane: PaneState, tab: NetconfTabState): HTMLElement[] {
  return [renderNetconfToolbar(store, pane, tab), renderNetconfBody(store, pane, tab)];
}

function renderPaneGroup(store: Store): HTMLElement {
  const panes = store.state.panes;
  const children: HTMLElement[] = [];
  panes.forEach((pane, idx) => {
    const isLast = idx === panes.length - 1;
    children.push(renderPane(store, pane, isLast));
    if (!isLast) {
      const startWidth = pane.width ?? 620;
      children.push(renderSplitter((e) => startDrag(e, (dx) => store.setPaneWidth(pane.id, startWidth + dx))));
    }
  });
  return el("div", { class: "pane-group" }, children);
}

export function renderApp(store: Store): HTMLElement {
  const bodyChildren: HTMLElement[] = [];
  if (!store.state.leftCollapsed) {
    const startWidth = store.state.leftWidth;
    bodyChildren.push(renderSidebar(store));
    bodyChildren.push(renderSplitter((e) => startDrag(e, (dx) => store.setLeftWidth(startWidth + dx))));
  } else {
    bodyChildren.push(renderCollapsedRail(store));
  }
  bodyChildren.push(renderPaneGroup(store));
  const appBody = el("div", { class: "app-body" }, bodyChildren);

  const overlays: HTMLElement[] = [];
  if (store.state.parseErrorsOpen && store.state.parseErrors.length > 0) {
    overlays.push(renderParseErrorsModal("Parse issues", store.state.parseErrors, () => store.toggleParseErrors()));
  }
  if (store.state.yangParseErrorsOpen && store.state.yangParseErrors.length > 0) {
    overlays.push(renderParseErrorsModal("gNMI YANG parse issues", store.state.yangParseErrors, () => store.toggleYangParseErrors()));
  }
  if (store.state.netconfYangParseErrorsOpen && store.state.netconfYangParseErrors.length > 0) {
    overlays.push(renderParseErrorsModal("NETCONF YANG parse issues", store.state.netconfYangParseErrors, () => store.toggleNetconfYangParseErrors()));
  }
  const contextMenu = renderTreeContextMenu(store);
  if (contextMenu) overlays.push(contextMenu);
  const refreshMenu = renderRefreshMenu(store);
  if (refreshMenu) overlays.push(refreshMenu);
  const exportMenu = renderExportMenu(store);
  if (exportMenu) overlays.push(exportMenu);
  const themeMenu = renderThemeMenu(store);
  if (themeMenu) overlays.push(themeMenu);
  if (overlays.length === 0) return appBody;

  // Wrapped in a `display: contents` div so fixed-position overlays sit
  // alongside `.app-body` without becoming a flex child of `#app` itself.
  return el("div", { style: { display: "contents" } }, [appBody, ...overlays]);
}
