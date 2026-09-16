//! MIB directory scanning and parsing, built on the `tree-sitter-asn1` grammar.
//!
//! OID values in MIB source are relative (`::= { interfaces 2 }`): resolving
//! them to absolute dotted OIDs requires knowing the full path of whatever
//! symbol they reference, which may live in a different file, and that
//! symbol's own ancestors, and so on. We do this in two passes: first parse
//! every file into a flat list of `RawSymbol`s (name, kind, raw OID
//! components), then run a fixed-point resolution pass over that whole set
//! until no more progress can be made. Anything left over — most commonly
//! because the standard root MIBs (RFC1155-SMI etc.) weren't among the
//! configured directories — is reported as unresolved rather than guessed.
//!
//! The tree shown in the UI is built from declared parent/child name
//! references (the first component of each OID value), not from the
//! resolved numeric paths, so an unresolved node still lands in the right
//! place in the tree (as a leaf of its nominal parent, or as a top-level
//! entry if even that isn't known) and can be shown greyed out.

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use tree_sitter::{Node, Parser};

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    Group,
    Scalar,
    Table,
}

#[derive(Serialize, Clone, Debug)]
pub struct MibTreeNode {
    pub id: String,
    pub label: String,
    pub oid: String,
    pub resolved: bool,
    #[serde(rename = "type")]
    pub kind: NodeKind,
    pub children: Vec<MibTreeNode>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub arc: Option<u32>,
    pub enum_values: Vec<(i64, String)>,
    /// DISPLAY-HINT declared on the TEXTUAL-CONVENTION this column's SYNTAX references, if any
    /// (e.g. `"d-1"`, meaning a decimal point belongs one digit from the right).
    pub display_hint: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct TableInfo {
    pub oid: String,
    pub resolved: bool,
    pub columns: Vec<ColumnInfo>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SymbolInfo {
    pub oid: String,
    pub resolved: bool,
    #[serde(rename = "type")]
    pub kind: NodeKind,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct FileErrors {
    pub file: String,
    pub errors: Vec<String>,
}

/// Every file found under one configured MIB directory (including
/// subdirectories), so the UI can list them as subnodes of that directory.
#[derive(Serialize, Clone, Debug, Default)]
pub struct DirFiles {
    pub dir: String,
    pub files: Vec<String>,
}

/// `oid -> (display-hint, enum labels)` for every resolved OBJECT-TYPE definition (scalar or
/// table column) that carries one, sorted by arc count descending for a longest-prefix-match
/// walk (see `resolve_value_hint` in `trap.rs`) - the trap listener's equivalent of the
/// `displayHints`/`enumLabels` maps `snmp::fetch_table` returns per column.
pub type ValueHintIndex = Vec<(String, Option<String>, Vec<(i64, String)>)>;

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ParseResult {
    pub tree: Vec<MibTreeNode>,
    /// Flat list of every table as a root node, columns as its children - an
    /// alternate view of the same data for browsing tables directly instead
    /// of hunting through the group hierarchy.
    pub tables_tree: Vec<MibTreeNode>,
    pub tables: HashMap<String, TableInfo>,
    pub symbols: HashMap<String, SymbolInfo>,
    pub errors: Vec<FileErrors>,
    pub dir_files: Vec<DirFiles>,
    /// Not sent to the frontend (see `ValueHintIndex`) - only consumed server-side when starting
    /// a trap listener.
    #[serde(skip)]
    pub value_hints: ValueHintIndex,
}

/// Builds a reverse `oid -> name` index from a parsed tree, for labeling numeric OIDs (e.g.
/// from a received SNMP trap) with the MIB symbol they belong to. Sorted by arc count
/// descending so a longest-prefix-match walk (see `resolve_oid` in `trap.rs`) tries the most
/// specific symbol first - e.g. a table's column before the table itself.
pub fn build_oid_index(tree: &[MibTreeNode]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    fn walk(nodes: &[MibTreeNode], out: &mut Vec<(String, String)>) {
        for n in nodes {
            if n.resolved && !n.oid.is_empty() {
                out.push((n.oid.clone(), n.label.clone()));
            }
            walk(&n.children, out);
        }
    }
    walk(tree, &mut out);
    out.sort_by_key(|(oid, _)| std::cmp::Reverse(oid.matches('.').count()));
    out
}

/// Builds a `ValueHintIndex` from the intermediate state `parse_directories` already computes
/// while resolving OIDs - the same DISPLAY-HINT/enum lookup `build_tables` does for table
/// columns, but over every resolved scalar-shaped symbol (which, since a table's own columns
/// are individually parsed as `RawKind::Scalar` too, covers both).
fn build_value_hint_index(
    raw: &[RawSymbol],
    resolved: &HashMap<String, Vec<u32>>,
    display_hints: &HashMap<String, String>,
    tc_enum_values: &HashMap<String, Vec<(i64, String)>>,
) -> ValueHintIndex {
    let mut out: ValueHintIndex = raw
        .iter()
        .filter(|s| s.kind == RawKind::Scalar)
        .filter_map(|s| {
            let path = resolved.get(&s.name)?;
            let hint = s.syntax_type_name.as_ref().and_then(|t| display_hints.get(t)).cloned();
            let enum_values = if !s.enum_values.is_empty() {
                s.enum_values.clone()
            } else {
                s.syntax_type_name.as_ref().and_then(|t| tc_enum_values.get(t)).cloned().unwrap_or_default()
            };
            if hint.is_none() && enum_values.is_empty() {
                return None;
            }
            Some((dotted(path), hint, enum_values))
        })
        .collect();
    out.sort_by_key(|(oid, _, _)| std::cmp::Reverse(oid.matches('.').count()));
    out
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RawKind {
    Group,
    Scalar,
    Table,
    Other,
}

#[derive(Clone, Debug)]
enum OidComponent {
    Number(u32),
    Named(String, u32),
    Ident(String),
}

#[derive(Clone, Debug)]
struct RawSymbol {
    name: String,
    oid: Vec<OidComponent>,
    kind: RawKind,
    /// Set when SYNTAX is `SEQUENCE OF X` - X is the entry type name.
    sequence_of_target: Option<String>,
    enum_values: Vec<(i64, String)>,
    /// Set when SYNTAX is a bare reference to another named type (e.g. `SYNTAX DisplayString`),
    /// so a DISPLAY-HINT declared on that type's own TEXTUAL-CONVENTION can be looked up later.
    syntax_type_name: Option<String>,
    /// MAX-ACCESS not-accessible (e.g. a table's INDEX column) - such objects are never
    /// returned by the agent, not even during a table walk, so they can't be fetched.
    not_accessible: bool,
    /// Path of the file this symbol was declared in, for grouping error messages.
    file: String,
}

pub(crate) fn push_error(errors: &mut Vec<FileErrors>, file: &str, msg: String) {
    if let Some(entry) = errors.iter_mut().find(|e| e.file == file) {
        entry.errors.push(msg);
    } else {
        errors.push(FileErrors { file: file.to_string(), errors: vec![msg] });
    }
}

/// Recursively collects regular files beneath a directory while avoiding revisiting canonical paths.
///
/// Directory canonicalization and read failures are recorded in `errors`. Symlink cycles and
/// previously visited directories are skipped.
///
/// # Examples
///
/// This is a crate-private helper (also used by `yang.rs`), so the example below is
/// illustrative only (not run as a doctest, since it's unreachable from an external crate):
///
/// ```ignore
/// use std::collections::HashSet;
///
/// let mut files = Vec::new();
/// let mut errors = Vec::new();
/// let mut visited = HashSet::new();
/// collect_files(std::path::Path::new("./mibs"), &mut files, &mut errors, &mut visited);
/// ```
pub(crate) fn collect_files(
    dir: &std::path::Path,
    out: &mut Vec<std::path::PathBuf>,
    errors: &mut Vec<FileErrors>,
    visited: &mut HashSet<std::path::PathBuf>,
) {
    let canonical_dir = match dir.canonicalize() {
        Ok(path) => path,
        Err(e) => {
            push_error(errors, &dir.display().to_string(), format!("{e}"));
            return;
        }
    };
    if !visited.insert(canonical_dir) {
        return;
    }

    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) => {
            push_error(errors, &dir.display().to_string(), format!("{e}"));
            return;
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_files(&path, out, errors, visited);
        } else if path.is_file() {
            out.push(path);
        }
    }
}

/// Parses MIB files from the specified directories and builds their resolved data models.
///
/// Unresolved OIDs, syntax errors, and file-system errors are reported in the returned result.
///
/// # Examples
///
/// ```
/// use bryllun_lib::mib::parse_directories;
///
/// let result = parse_directories(&[]);
/// assert!(result.errors.is_empty());
/// ```
pub fn parse_directories(dirs: &[String]) -> ParseResult {
    let mut parser = Parser::new();
    if parser.set_language(&tree_sitter_asn1::LANGUAGE.into()).is_err() {
        return ParseResult {
            errors: vec![FileErrors { file: "<internal>".into(), errors: vec!["failed to load MIB grammar".into()] }],
            ..Default::default()
        };
    }

    let mut raw: Vec<RawSymbol> = Vec::new();
    let mut sequence_types: HashMap<String, Vec<String>> = HashMap::new();
    // Seeded with well-known SNMPv2-TC textual conventions so their DISPLAY-HINT is available
    // even when a vendor MIB imports them without SNMPv2-TC.txt itself being among the loaded
    // files. A loaded file that does define one of these overwrites the seeded value below.
    let mut display_hints: HashMap<String, String> =
        HashMap::from([("DateAndTime".to_string(), "2d-1d-1d,1d:1d:1d.1d,1a1d:1d".to_string())]);
    let mut tc_enum_values: HashMap<String, Vec<(i64, String)>> = HashMap::new();
    let mut errors: Vec<FileErrors> = Vec::new();
    let mut dir_files: Vec<DirFiles> = Vec::new();

    for dir in dirs {
        let mut files = Vec::new();
        collect_files(std::path::Path::new(dir), &mut files, &mut errors, &mut HashSet::new());
        dir_files.push(DirFiles { dir: dir.clone(), files: files.iter().map(|p| p.display().to_string()).collect() });
        for path in files {
            let Ok(src) = std::fs::read_to_string(&path) else {
                continue; // not a readable text file - skip silently
            };
            let file = path.display().to_string();
            let Some(tree) = parser.parse(&src, None) else {
                push_error(&mut errors, &file, "failed to parse".into());
                continue;
            };
            if tree.root_node().has_error() {
                push_error(&mut errors, &file, "contains syntax errors (parsed on a best-effort basis)".into());
            }
            walk_module(tree.root_node(), src.as_bytes(), &file, &mut raw, &mut sequence_types, &mut display_hints, &mut tc_enum_values);
        }
    }

    let (resolved, unresolved_names) = resolve_oids(&raw);
    let file_of: HashMap<&str, &str> = raw.iter().map(|s| (s.name.as_str(), s.file.as_str())).collect();
    for name in unresolved_names {
        let file = file_of.get(name.as_str()).copied().unwrap_or("<unknown>");
        push_error(&mut errors, file, format!("{name}: could not resolve to an absolute OID (missing ancestor definition)"));
    }

    let tree = build_tree(&raw, &resolved);
    let tables_tree = build_tables_tree(&raw, &resolved);
    let tables = build_tables(&raw, &sequence_types, &display_hints, &tc_enum_values, &resolved);
    let value_hints = build_value_hint_index(&raw, &resolved, &display_hints, &tc_enum_values);
    let symbols = raw
        .iter()
        .filter(|s| s.kind != RawKind::Other)
        .map(|s| {
            let path = resolved.get(&s.name);
            let kind = match s.kind {
                RawKind::Table => NodeKind::Table,
                RawKind::Group => NodeKind::Group,
                RawKind::Scalar | RawKind::Other => NodeKind::Scalar,
            };
            (s.name.clone(), SymbolInfo { oid: path.map(|p| dotted(p)).unwrap_or_default(), resolved: path.is_some(), kind })
        })
        .collect();

    ParseResult { tree, tables_tree, tables, symbols, errors, dir_files, value_hints }
}

pub(crate) fn node_text<'a>(node: Node, src: &'a [u8]) -> &'a str {
    node.utf8_text(src).unwrap_or("")
}

pub(crate) fn find_child_by_kind<'a>(node: Node<'a>, kind: &str) -> Option<Node<'a>> {
    let mut cursor = node.walk();
    let found = node.named_children(&mut cursor).find(|c| c.kind() == kind);
    found
}

fn walk_module(
    root: Node,
    src: &[u8],
    file: &str,
    raw: &mut Vec<RawSymbol>,
    sequence_types: &mut HashMap<String, Vec<String>>,
    display_hints: &mut HashMap<String, String>,
    tc_enum_values: &mut HashMap<String, Vec<(i64, String)>>,
) {
    let Some(module_def) = find_child_by_kind(root, "module_definition") else { return };
    let mut cursor = module_def.walk();
    for assignment in module_def.named_children(&mut cursor) {
        if assignment.kind() != "assignment" {
            continue;
        }
        let Some(inner) = assignment.named_child(0) else { continue };
        match inner.kind() {
            "object_identifier_assignment" | "object_identity_assignment" | "module_identity_assignment" => {
                let (Some(name_node), Some(oid_node)) = (inner.named_child(0), find_child_by_kind(inner, "object_identifier_value")) else { continue };
                raw.push(RawSymbol {
                    name: node_text(name_node, src).to_string(),
                    oid: parse_oid_value(oid_node, src),
                    kind: RawKind::Group,
                    sequence_of_target: None,
                    enum_values: vec![],
                    syntax_type_name: None,
                    not_accessible: false,
                    file: file.to_string(),
                });
            }
            "object_type_assignment" => {
                let (Some(name_node), Some(clauses), Some(oid_node)) = (
                    inner.named_child(0),
                    find_child_by_kind(inner, "object_type_clauses"),
                    find_child_by_kind(inner, "object_identifier_value"),
                ) else {
                    continue;
                };

                let mut kind = RawKind::Scalar;
                let mut sequence_of_target = None;
                let mut enum_values = vec![];
                let mut syntax_type_name = None;

                if let Some(syntax_clause) = clauses.child_by_field_name("syntax") {
                    if let Some(type_node) = find_child_by_kind(syntax_clause, "type") {
                        if let Some(seq_of) = find_child_by_kind(type_node, "sequence_of_type") {
                            kind = RawKind::Table;
                            if let Some(ident) = find_child_by_kind(seq_of, "identifier") {
                                sequence_of_target = Some(node_text(ident, src).to_string());
                            }
                        } else if let Some(enum_node) = find_child_by_kind(type_node, "enum_constraint") {
                            enum_values = parse_enum_constraint(enum_node, src);
                        } else if let Some(basetype) = find_child_by_kind(type_node, "basetype") {
                            // A bare reference to another named type (e.g. `SYNTAX DisplayString`)
                            // rather than an inline INTEGER/OCTET STRING/etc - record the name so
                            // build_tables() can look up a DISPLAY-HINT declared on it.
                            if let Some(ident) = find_child_by_kind(basetype, "identifier") {
                                syntax_type_name = Some(node_text(ident, src).to_string());
                            }
                        }
                    }
                }

                let not_accessible = clauses
                    .child_by_field_name("max_access")
                    .is_some_and(|n| node_text(n, src).contains("not-accessible"));

                raw.push(RawSymbol {
                    name: node_text(name_node, src).to_string(),
                    oid: parse_oid_value(oid_node, src),
                    kind,
                    sequence_of_target,
                    enum_values,
                    syntax_type_name,
                    not_accessible,
                    file: file.to_string(),
                });
            }
            "textual_convention_definition" => {
                let Some(name_node) = inner.child_by_field_name("name") else { continue };
                if let Some(clauses) = find_child_by_kind(inner, "textual_convention_clauses") {
                    if let Some(hint_clause) = clauses.child_by_field_name("display_hint") {
                        if let Some(string_node) = hint_clause.named_child(0) {
                            let hint = node_text(string_node, src).trim_matches('"').to_string();
                            display_hints.insert(node_text(name_node, src).to_string(), hint);
                        }
                    }
                    // A TC's own SYNTAX can be an enumerated INTEGER (e.g. `SYNTAX INTEGER
                    // { ok(1), alarm(2) }`), same as an inline OBJECT-TYPE SYNTAX - a column
                    // whose SYNTAX is just a reference to this TC's name inherits these labels.
                    if let Some(syntax_clause) = clauses.child_by_field_name("syntax") {
                        if let Some(type_node) = find_child_by_kind(syntax_clause, "type") {
                            if let Some(enum_node) = find_child_by_kind(type_node, "enum_constraint") {
                                tc_enum_values.insert(node_text(name_node, src).to_string(), parse_enum_constraint(enum_node, src));
                            }
                        }
                    }
                }
            }
            "notification_type_assignment" | "trap_type_assignment" => {
                // Not part of the browsable OID tree (no value to GET), but keep them
                // in the symbol table in case something legitimately parents off one.
                if let Some(name_node) = inner.named_child(0) {
                    let oid = find_child_by_kind(inner, "object_identifier_value")
                        .map(|n| parse_oid_value(n, src))
                        .unwrap_or_default();
                    raw.push(RawSymbol {
                        name: node_text(name_node, src).to_string(),
                        oid,
                        kind: RawKind::Other,
                        sequence_of_target: None,
                        enum_values: vec![],
                        syntax_type_name: None,
                        not_accessible: false,
                        file: file.to_string(),
                    });
                }
            }
            "type_assignment" => {
                let (Some(name_node), Some(type_node)) = (inner.named_child(0), inner.named_child(1)) else { continue };
                if let Some(seq_type) = find_child_by_kind(type_node, "sequence_type") {
                    let mut c2 = seq_type.walk();
                    let fields: Vec<String> = seq_type
                        .named_children(&mut c2)
                        .filter(|f| f.kind() == "sequence_field")
                        .filter_map(|f| f.child_by_field_name("name"))
                        .map(|n| node_text(n, src).to_string())
                        .collect();
                    sequence_types.insert(node_text(name_node, src).to_string(), fields);
                }
            }
            _ => {}
        }
    }
}

fn parse_enum_constraint(enum_node: Node, src: &[u8]) -> Vec<(i64, String)> {
    let mut cursor = enum_node.walk();
    enum_node
        .named_children(&mut cursor)
        .filter(|n| n.kind() == "named_number")
        .filter_map(|n| {
            let name = n.child_by_field_name("name")?;
            let value = n.child_by_field_name("value")?;
            let v: i64 = node_text(value, src).parse().ok()?;
            Some((v, node_text(name, src).to_string()))
        })
        .collect()
}

fn parse_oid_value(node: Node, src: &[u8]) -> Vec<OidComponent> {
    let mut cursor = node.walk();
    node.named_children(&mut cursor)
        .filter_map(|c| match c.kind() {
            "number" => node_text(c, src).parse::<u32>().ok().map(OidComponent::Number),
            "named_oid_component" => {
                let name = c.child_by_field_name("name")?;
                let value = c.child_by_field_name("value")?;
                let v: u32 = node_text(value, src).parse().ok()?;
                Some(OidComponent::Named(node_text(name, src).to_string(), v))
            }
            "identifier" => Some(OidComponent::Ident(node_text(c, src).to_string())),
            _ => None,
        })
        .collect()
}

/// The name of the parent this symbol was declared under, if any (a bare
/// leading number, e.g. a genuine root's `::= { 1 }`, has no named parent).
fn parent_name(components: &[OidComponent]) -> Option<String> {
    match components.first()? {
        OidComponent::Ident(name) | OidComponent::Named(name, _) => Some(name.clone()),
        OidComponent::Number(_) => None,
    }
}

fn last_arc(components: &[OidComponent]) -> Option<u32> {
    match components.last()? {
        OidComponent::Number(n) => Some(*n),
        OidComponent::Named(_, v) => Some(*v),
        OidComponent::Ident(_) => None,
    }
}

fn try_resolve(components: &[OidComponent], resolved: &HashMap<String, Vec<u32>>) -> Option<Vec<u32>> {
    let mut iter = components.iter();
    let mut path: Vec<u32> = match iter.next()? {
        OidComponent::Number(n) => vec![*n],
        OidComponent::Named(_, v) => vec![*v],
        OidComponent::Ident(name) => resolved.get(name)?.clone(),
    };
    for c in iter {
        match c {
            OidComponent::Number(n) => path.push(*n),
            OidComponent::Named(_, v) => path.push(*v),
            OidComponent::Ident(name) => path = resolved.get(name)?.clone(),
        }
    }
    Some(path)
}

/// The top-level arcs of the ASN.1 OID tree (X.680 §12.2) are primitives of
/// the notation itself - `iso OBJECT IDENTIFIER ::= { 1 }` never actually
/// appears in MIB source, yet nearly every MIB's whole ancestor chain roots
/// through `iso`. Seed them so resolution doesn't treat every module as
/// unresolvable just because none of them declares its own root.
const WELL_KNOWN_ROOTS: &[(&str, u32)] =
    &[("ccitt", 0), ("itu-t", 0), ("iso", 1), ("joint-iso-itu-t", 2), ("joint-iso-ccitt", 2)];

fn resolve_oids(raw: &[RawSymbol]) -> (HashMap<String, Vec<u32>>, Vec<String>) {
    let mut resolved: HashMap<String, Vec<u32>> = WELL_KNOWN_ROOTS.iter().map(|&(name, arc)| (name.to_string(), vec![arc])).collect();
    let mut remaining: Vec<&RawSymbol> = raw.iter().collect();
    loop {
        let mut progressed = false;
        remaining.retain(|s| {
            if resolved.contains_key(&s.name) {
                return false;
            }
            match try_resolve(&s.oid, &resolved) {
                Some(path) => {
                    resolved.insert(s.name.clone(), path);
                    progressed = true;
                    false
                }
                None => true,
            }
        });
        if !progressed {
            break;
        }
    }
    let unresolved = remaining.iter().map(|s| s.name.clone()).collect();
    (resolved, unresolved)
}

fn dotted(path: &[u32]) -> String {
    path.iter().map(u32::to_string).collect::<Vec<_>>().join(".")
}

/// A table's real children sit one level down, under a hidden "entry" object
/// (SMI convention: table -> entry -> columns) - collect columns from every
/// entry declared under this table, skipping the entry itself.
fn table_columns<'a>(table_name: &str, children_of: &HashMap<String, Vec<&'a RawSymbol>>) -> Vec<&'a RawSymbol> {
    let mut columns: Vec<&RawSymbol> = Vec::new();
    for entry in children_of.get(table_name).cloned().unwrap_or_default() {
        columns.extend(children_of.get(&entry.name).cloned().unwrap_or_default());
    }
    columns.sort_by(|a, b| a.name.cmp(&b.name));
    columns
}

fn build_tree(raw: &[RawSymbol], resolved: &HashMap<String, Vec<u32>>) -> Vec<MibTreeNode> {
    let by_name: HashMap<&str, &RawSymbol> = raw.iter().map(|s| (s.name.as_str(), s)).collect();
    let mut children_of: HashMap<String, Vec<&RawSymbol>> = HashMap::new();
    let mut roots: Vec<&RawSymbol> = Vec::new();

    for s in raw {
        if s.kind == RawKind::Other {
            continue;
        }
        match parent_name(&s.oid) {
            Some(p) if by_name.contains_key(p.as_str()) => children_of.entry(p).or_default().push(s),
            _ => roots.push(s),
        }
    }

    fn build_node(s: &RawSymbol, children_of: &HashMap<String, Vec<&RawSymbol>>, resolved: &HashMap<String, Vec<u32>>) -> MibTreeNode {
        let path = resolved.get(&s.name);
        let kind = match s.kind {
            RawKind::Table => NodeKind::Table,
            RawKind::Group => NodeKind::Group,
            RawKind::Scalar | RawKind::Other => NodeKind::Scalar,
        };
        let children = if s.kind == RawKind::Table {
            table_columns(&s.name, children_of).iter().map(|c| build_node(c, children_of, resolved)).collect()
        } else {
            let mut kids: Vec<&RawSymbol> = children_of.get(&s.name).cloned().unwrap_or_default();
            kids.sort_by(|a, b| a.name.cmp(&b.name));
            kids.iter().map(|k| build_node(k, children_of, resolved)).collect()
        };
        MibTreeNode {
            id: s.name.clone(),
            label: s.name.clone(),
            oid: path.map(|p| dotted(p)).unwrap_or_default(),
            resolved: path.is_some(),
            kind,
            children,
        }
    }

    // Keep only roots that actually resolve to somewhere under `iso` (arc 1) -
    // the other ASN.1 primitives (ccitt/itu-t, joint-iso-*) never appear in
    // real MIB data, and anything left unresolved can't be confirmed to
    // belong under iso at all. Nest them under a single synthetic `iso` node
    // so it's the tree's sole root, matching how OID trees are conventionally
    // browsed - unresolved *descendants* further down are unaffected by this
    // and still show up greyed out, as before.
    let mut iso_roots: Vec<&RawSymbol> =
        roots.into_iter().filter(|s| matches!(resolved.get(&s.name), Some(path) if path.first() == Some(&1))).collect();
    iso_roots.sort_by(|a, b| a.name.cmp(&b.name));
    let children = iso_roots.iter().map(|s| build_node(s, &children_of, resolved)).collect();

    vec![MibTreeNode { id: "iso".to_string(), label: "iso".to_string(), oid: "1".to_string(), resolved: true, kind: NodeKind::Group, children }]
}

/// Alternate tree shape for "tables only" browsing: every table as a root
/// node (alphabetical, no group hierarchy), its columns as direct children.
fn build_tables_tree(raw: &[RawSymbol], resolved: &HashMap<String, Vec<u32>>) -> Vec<MibTreeNode> {
    let by_name: HashMap<&str, &RawSymbol> = raw.iter().map(|s| (s.name.as_str(), s)).collect();
    let mut children_of: HashMap<String, Vec<&RawSymbol>> = HashMap::new();
    for s in raw {
        if s.kind == RawKind::Other {
            continue;
        }
        if let Some(p) = parent_name(&s.oid) {
            if by_name.contains_key(p.as_str()) {
                children_of.entry(p).or_default().push(s);
            }
        }
    }

    fn leaf_node(s: &RawSymbol, resolved: &HashMap<String, Vec<u32>>) -> MibTreeNode {
        let path = resolved.get(&s.name);
        MibTreeNode { id: s.name.clone(), label: s.name.clone(), oid: path.map(|p| dotted(p)).unwrap_or_default(), resolved: path.is_some(), kind: NodeKind::Scalar, children: Vec::new() }
    }

    let mut tables: Vec<&RawSymbol> = raw.iter().filter(|s| s.kind == RawKind::Table).collect();
    tables.sort_by(|a, b| a.name.cmp(&b.name));

    tables
        .into_iter()
        .map(|t| {
            let columns = table_columns(&t.name, &children_of);
            let path = resolved.get(&t.name);
            MibTreeNode {
                id: t.name.clone(),
                label: t.name.clone(),
                oid: path.map(|p| dotted(p)).unwrap_or_default(),
                resolved: path.is_some(),
                kind: NodeKind::Table,
                children: columns.iter().map(|c| leaf_node(c, resolved)).collect(),
            }
        })
        .collect()
}

fn build_tables(
    raw: &[RawSymbol],
    sequence_types: &HashMap<String, Vec<String>>,
    display_hints: &HashMap<String, String>,
    tc_enum_values: &HashMap<String, Vec<(i64, String)>>,
    resolved: &HashMap<String, Vec<u32>>,
) -> HashMap<String, TableInfo> {
    let by_name: HashMap<&str, &RawSymbol> = raw.iter().map(|s| (s.name.as_str(), s)).collect();
    let mut tables = HashMap::new();

    for s in raw {
        if s.kind != RawKind::Table {
            continue;
        }
        let Some(entry_type_name) = &s.sequence_of_target else { continue };
        let Some(field_names) = sequence_types.get(entry_type_name) else { continue };

        let columns = field_names
            .iter()
            // A not-accessible column (typically the table's INDEX column) is never
            // returned by the agent, even during a table walk - its value is only
            // ever visible in the synthetic "Index" column, so skip it here rather
            // than showing an always-empty duplicate.
            .filter(|field_name| !by_name.get(field_name.as_str()).is_some_and(|c| c.not_accessible))
            .map(|field_name| {
                let col = by_name.get(field_name.as_str());
                let display_hint = col.and_then(|c| c.syntax_type_name.as_ref()).and_then(|t| display_hints.get(t)).cloned();
                // A column's SYNTAX can enumerate its values inline (e.g. `SYNTAX INTEGER {
                // up(1), down(2) }`), or just reference a TEXTUAL-CONVENTION that does - fall
                // back to the TC's enum labels when the column itself declared none.
                let enum_values = col
                    .filter(|c| !c.enum_values.is_empty())
                    .map(|c| c.enum_values.clone())
                    .or_else(|| col.and_then(|c| c.syntax_type_name.as_ref()).and_then(|t| tc_enum_values.get(t)).cloned())
                    .unwrap_or_default();
                ColumnInfo { name: field_name.clone(), arc: col.and_then(|c| last_arc(&c.oid)), enum_values, display_hint }
            })
            .collect();

        let path = resolved.get(&s.name);
        tables.insert(
            s.name.clone(),
            TableInfo { oid: path.map(|p| dotted(p)).unwrap_or_default(), resolved: path.is_some(), columns },
        );
    }

    tables
}

#[cfg(test)]
mod tests {
    use super::*;

    const IF_TABLE_MIB: &str = r#"
TEST-MIB DEFINITIONS ::= BEGIN

mib-2 OBJECT IDENTIFIER ::= { 1 3 6 1 2 1 }
interfaces OBJECT IDENTIFIER ::= { mib-2 2 }

ifNumber OBJECT-TYPE
    SYNTAX INTEGER
    MAX-ACCESS read-only
    STATUS current
    DESCRIPTION "n"
    ::= { interfaces 1 }

ifTable OBJECT-TYPE
    SYNTAX SEQUENCE OF IfEntry
    MAX-ACCESS not-accessible
    STATUS current
    DESCRIPTION "t"
    ::= { interfaces 2 }

ifEntry OBJECT-TYPE
    SYNTAX IfEntry
    MAX-ACCESS not-accessible
    STATUS current
    DESCRIPTION "e"
    INDEX { ifIndex }
    ::= { ifTable 1 }

IfEntry ::= SEQUENCE {
    ifIndex INTEGER,
    ifDescr OCTET STRING,
    ifOperStatus INTEGER
}

ifIndex OBJECT-TYPE
    SYNTAX INTEGER
    MAX-ACCESS read-only
    STATUS current
    DESCRIPTION "i"
    ::= { ifEntry 1 }

ifDescr OBJECT-TYPE
    SYNTAX OCTET STRING
    MAX-ACCESS read-only
    STATUS current
    DESCRIPTION "d"
    ::= { ifEntry 2 }

ifOperStatus OBJECT-TYPE
    SYNTAX INTEGER { up(1), down(2), testing(3) }
    MAX-ACCESS read-only
    STATUS current
    DESCRIPTION "o"
    ::= { ifEntry 8 }

enterprises OBJECT IDENTIFIER ::= { private 1 }

END
"#;

    fn write_fixture(contents: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("TEST.mib"), contents).unwrap();
        dir
    }

    #[test]
    fn mib_files_in_subdirectories_are_found() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("nested").join("deeper");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("TEST.mib"), IF_TABLE_MIB).unwrap();

        let result = parse_directories(&[dir.path().to_string_lossy().to_string()]);

        let if_table = result.symbols.get("ifTable").expect("ifTable symbol should be found in a nested subdirectory");
        assert!(if_table.resolved);
    }

    #[cfg(unix)]
    #[test]
    fn directory_cycles_via_symlinks_do_not_recurse_forever() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("sub");
        std::fs::create_dir(&sub).unwrap();
        std::fs::write(sub.join("TEST.mib"), IF_TABLE_MIB).unwrap();
        // A symlink back to the root turns the tree into a cycle; without
        // tracking visited directories this would recurse until the stack
        // overflows.
        std::os::unix::fs::symlink(dir.path(), sub.join("loop")).unwrap();

        let result = parse_directories(&[dir.path().to_string_lossy().to_string()]);

        let if_table = result.symbols.get("ifTable").expect("ifTable symbol should still be found once");
        assert!(if_table.resolved);
    }

    #[test]
    fn resolves_absolute_oids_across_the_ancestor_chain() {
        let dir = write_fixture(IF_TABLE_MIB);
        let result = parse_directories(&[dir.path().to_string_lossy().to_string()]);

        let if_table = result.symbols.get("ifTable").expect("ifTable symbol");
        assert!(if_table.resolved, "ifTable should resolve via its full ancestor chain");
        assert_eq!(if_table.oid, "1.3.6.1.2.1.2.2");
        assert_eq!(if_table.kind, NodeKind::Table);
    }

    #[test]
    fn unresolvable_ancestor_is_reported_not_guessed() {
        let dir = write_fixture(IF_TABLE_MIB);
        let result = parse_directories(&[dir.path().to_string_lossy().to_string()]);

        // "private" is never defined in this fixture, so enterprises can't resolve.
        let enterprises = result.symbols.get("enterprises").expect("enterprises symbol");
        assert!(!enterprises.resolved);
        assert!(result.errors.iter().any(|fe| fe.errors.iter().any(|e| e.contains("enterprises"))));
    }

    #[test]
    fn well_known_asn1_roots_resolve_without_being_declared() {
        // Real MIBs never declare `iso OBJECT IDENTIFIER ::= { 1 }` themselves -
        // it's a primitive of the notation - so the whole ancestor chain must
        // still resolve through it.
        let mib = r#"
TEST-MIB DEFINITIONS ::= BEGIN
org OBJECT IDENTIFIER ::= { iso 3 }
dod OBJECT IDENTIFIER ::= { org 6 }
END
"#;
        let dir = write_fixture(mib);
        let result = parse_directories(&[dir.path().to_string_lossy().to_string()]);

        let dod = result.symbols.get("dod").expect("dod symbol");
        assert!(dod.resolved, "dod should resolve through the well-known 'iso' root");
        assert_eq!(dod.oid, "1.3.6");
    }

    #[test]
    fn table_columns_appear_as_children_of_the_table_skipping_the_hidden_entry_level() {
        let dir = write_fixture(IF_TABLE_MIB);
        let result = parse_directories(&[dir.path().to_string_lossy().to_string()]);

        let iso = &result.tree[0];
        let mib2 = iso.children.iter().find(|n| n.id == "mib-2").expect("mib-2 under iso");
        let interfaces = mib2.children.iter().find(|n| n.id == "interfaces").expect("interfaces group");
        let if_table = interfaces.children.iter().find(|n| n.id == "ifTable").expect("ifTable node");
        assert_eq!(if_table.kind, NodeKind::Table);

        let names: Vec<&str> = if_table.children.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(names, vec!["ifDescr", "ifIndex", "ifOperStatus"], "columns nest directly under the table, entry level skipped");
        assert!(if_table.children.iter().all(|c| c.kind == NodeKind::Scalar && c.children.is_empty()));
        assert!(interfaces.children.iter().all(|c| c.id != "ifEntry"), "hidden entry object itself should not appear in the tree");
    }

    #[test]
    fn iso_is_the_sole_tree_root_and_unrelated_roots_are_filtered_out() {
        let dir = write_fixture(IF_TABLE_MIB);
        let result = parse_directories(&[dir.path().to_string_lossy().to_string()]);

        assert_eq!(result.tree.len(), 1, "tree should have exactly one root");
        let iso = &result.tree[0];
        assert_eq!(iso.id, "iso");
        assert_eq!(iso.oid, "1");
        assert!(iso.resolved);

        // `enterprises ::= { private 1 }` never resolves (`private` isn't declared
        // anywhere in the fixture), so it can't be confirmed to live under iso and
        // must not appear anywhere in the tree - neither as a root nor nested.
        fn contains(nodes: &[MibTreeNode], id: &str) -> bool {
            nodes.iter().any(|n| n.id == id || contains(&n.children, id))
        }
        assert!(!contains(&result.tree, "enterprises"), "unresolved non-iso root should be filtered out");
    }

    #[test]
    fn tables_tree_lists_every_table_as_a_root_with_its_columns_as_children() {
        let dir = write_fixture(IF_TABLE_MIB);
        let result = parse_directories(&[dir.path().to_string_lossy().to_string()]);

        assert_eq!(result.tables_tree.len(), 1, "only one table in the fixture");
        let if_table = &result.tables_tree[0];
        assert_eq!(if_table.id, "ifTable");
        assert_eq!(if_table.oid, "1.3.6.1.2.1.2.2");
        assert_eq!(if_table.kind, NodeKind::Table);

        let names: Vec<&str> = if_table.children.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(names, vec!["ifDescr", "ifIndex", "ifOperStatus"], "columns sorted alphabetically, entry level skipped");
        for col in &if_table.children {
            assert_eq!(col.kind, NodeKind::Scalar);
            assert!(col.resolved, "{} should resolve through ifEntry -> ifTable", col.id);
            assert!(col.children.is_empty());
        }
        let if_descr = if_table.children.iter().find(|c| c.id == "ifDescr").unwrap();
        assert_eq!(if_descr.oid, "1.3.6.1.2.1.2.2.1.2");
    }

    #[test]
    fn table_columns_come_from_the_sequence_definition_in_order_with_arcs() {
        let dir = write_fixture(IF_TABLE_MIB);
        let result = parse_directories(&[dir.path().to_string_lossy().to_string()]);

        let table = result.tables.get("ifTable").expect("ifTable definition");
        assert!(table.resolved);
        assert_eq!(table.oid, "1.3.6.1.2.1.2.2");
        let names: Vec<&str> = table.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["ifIndex", "ifDescr", "ifOperStatus"]);
        let if_descr = table.columns.iter().find(|c| c.name == "ifDescr").unwrap();
        assert_eq!(if_descr.arc, Some(2));
        let if_oper = table.columns.iter().find(|c| c.name == "ifOperStatus").unwrap();
        assert_eq!(if_oper.enum_values, vec![(1, "up".to_string()), (2, "down".to_string()), (3, "testing".to_string())]);
    }

    #[test]
    fn not_accessible_columns_are_excluded_from_the_fetchable_table_columns() {
        const MIB: &str = r#"
TEST-MIB DEFINITIONS ::= BEGIN

mib-2 OBJECT IDENTIFIER ::= { 1 3 6 1 2 1 }
dcpLinkview OBJECT IDENTIFIER ::= { mib-2 99 }

dcpLinkviewTable OBJECT-TYPE
    SYNTAX SEQUENCE OF DcpLinkviewEntry
    MAX-ACCESS not-accessible
    STATUS current
    DESCRIPTION "t"
    ::= { dcpLinkview 1 }

dcpLinkviewEntry OBJECT-TYPE
    SYNTAX DcpLinkviewEntry
    MAX-ACCESS not-accessible
    STATUS current
    DESCRIPTION "e"
    INDEX { dcpLinkviewIndex }
    ::= { dcpLinkviewTable 1 }

DcpLinkviewEntry ::= SEQUENCE {
    dcpLinkviewIndex INTEGER,
    dcpLinkviewLocalHostname OCTET STRING
}

dcpLinkviewIndex OBJECT-TYPE
    SYNTAX INTEGER
    MAX-ACCESS not-accessible
    STATUS current
    DESCRIPTION "i"
    ::= { dcpLinkviewEntry 1 }

dcpLinkviewLocalHostname OBJECT-TYPE
    SYNTAX OCTET STRING
    MAX-ACCESS read-only
    STATUS current
    DESCRIPTION "h"
    ::= { dcpLinkviewEntry 2 }

END
"#;
        let dir = write_fixture(MIB);
        let result = parse_directories(&[dir.path().to_string_lossy().to_string()]);

        let table = result.tables.get("dcpLinkviewTable").expect("dcpLinkviewTable definition");
        let names: Vec<&str> = table.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["dcpLinkviewLocalHostname"], "not-accessible dcpLinkviewIndex should be excluded - its value is never returned by a table walk");
    }

    #[test]
    fn display_hint_is_resolved_from_a_referenced_textual_convention() {
        const MIB: &str = r#"
TEST-MIB DEFINITIONS ::= BEGIN

mib-2 OBJECT IDENTIFIER ::= { 1 3 6 1 2 1 }
dcpEnv OBJECT IDENTIFIER ::= { mib-2 99 }

DcpTemperature ::= TEXTUAL-CONVENTION
    DISPLAY-HINT "d-1"
    STATUS current
    DESCRIPTION "Tenths of a degree C"
    SYNTAX INTEGER

dcpEnvTable OBJECT-TYPE
    SYNTAX SEQUENCE OF DcpEnvEntry
    MAX-ACCESS not-accessible
    STATUS current
    DESCRIPTION "t"
    ::= { dcpEnv 1 }

dcpEnvEntry OBJECT-TYPE
    SYNTAX DcpEnvEntry
    MAX-ACCESS not-accessible
    STATUS current
    DESCRIPTION "e"
    INDEX { dcpEnvIndex }
    ::= { dcpEnvTable 1 }

DcpEnvEntry ::= SEQUENCE {
    dcpEnvIndex INTEGER,
    dcpEnvTemp DcpTemperature,
    dcpEnvLabel OCTET STRING
}

dcpEnvIndex OBJECT-TYPE
    SYNTAX INTEGER
    MAX-ACCESS not-accessible
    STATUS current
    DESCRIPTION "i"
    ::= { dcpEnvEntry 1 }

dcpEnvTemp OBJECT-TYPE
    SYNTAX DcpTemperature
    MAX-ACCESS read-only
    STATUS current
    DESCRIPTION "temp"
    ::= { dcpEnvEntry 2 }

dcpEnvLabel OBJECT-TYPE
    SYNTAX OCTET STRING
    MAX-ACCESS read-only
    STATUS current
    DESCRIPTION "label"
    ::= { dcpEnvEntry 3 }

END
"#;
        let dir = write_fixture(MIB);
        let result = parse_directories(&[dir.path().to_string_lossy().to_string()]);

        let table = result.tables.get("dcpEnvTable").expect("dcpEnvTable definition");
        let temp = table.columns.iter().find(|c| c.name == "dcpEnvTemp").expect("dcpEnvTemp column");
        assert_eq!(temp.display_hint, Some("d-1".to_string()));

        // A column whose SYNTAX doesn't reference a TC with a DISPLAY-HINT has none.
        let label = table.columns.iter().find(|c| c.name == "dcpEnvLabel").expect("dcpEnvLabel column");
        assert_eq!(label.display_hint, None);
    }

    #[test]
    fn date_and_time_display_hint_is_known_without_snmpv2_tc_being_loaded() {
        const MIB: &str = r#"
TEST-MIB DEFINITIONS ::= BEGIN

mib-2 OBJECT IDENTIFIER ::= { 1 3 6 1 2 1 }
dcpEnv OBJECT IDENTIFIER ::= { mib-2 99 }

dcpAlarmActiveListTable OBJECT-TYPE
    SYNTAX SEQUENCE OF DcpAlarmActiveListEntry
    MAX-ACCESS not-accessible
    STATUS current
    DESCRIPTION "t"
    ::= { dcpEnv 1 }

dcpAlarmActiveListEntry OBJECT-TYPE
    SYNTAX DcpAlarmActiveListEntry
    MAX-ACCESS not-accessible
    STATUS current
    DESCRIPTION "e"
    INDEX { dcpAlarmActiveListIndex }
    ::= { dcpAlarmActiveListTable 1 }

DcpAlarmActiveListEntry ::= SEQUENCE {
    dcpAlarmActiveListIndex INTEGER,
    dcpAlarmActiveListStartTime DateAndTime
}

dcpAlarmActiveListIndex OBJECT-TYPE
    SYNTAX INTEGER
    MAX-ACCESS not-accessible
    STATUS current
    DESCRIPTION "i"
    ::= { dcpAlarmActiveListEntry 1 }

dcpAlarmActiveListStartTime OBJECT-TYPE
    SYNTAX DateAndTime
    MAX-ACCESS read-only
    STATUS current
    DESCRIPTION "start time"
    ::= { dcpAlarmActiveListEntry 2 }

END
"#;
        // DateAndTime is only referenced here, never defined - SNMPv2-TC.txt (where RFC 2579
        // declares it) isn't among the loaded files, exercising the seeded fallback hint.
        let dir = write_fixture(MIB);
        let result = parse_directories(&[dir.path().to_string_lossy().to_string()]);

        let table = result.tables.get("dcpAlarmActiveListTable").expect("dcpAlarmActiveListTable definition");
        let start_time = table.columns.iter().find(|c| c.name == "dcpAlarmActiveListStartTime").expect("dcpAlarmActiveListStartTime column");
        assert_eq!(start_time.display_hint, Some("2d-1d-1d,1d:1d:1d.1d,1a1d:1d".to_string()));
    }

    #[test]
    fn enum_values_are_resolved_from_a_referenced_textual_convention() {
        const MIB: &str = r#"
TEST-MIB DEFINITIONS ::= BEGIN

mib-2 OBJECT IDENTIFIER ::= { 1 3 6 1 2 1 }
dcpEnv OBJECT IDENTIFIER ::= { mib-2 99 }

FanStatus ::= TEXTUAL-CONVENTION
    STATUS current
    DESCRIPTION "Fan status"
    SYNTAX INTEGER { notPresent(1), ok(2), alarm(3) }

dcpEnvTable OBJECT-TYPE
    SYNTAX SEQUENCE OF DcpEnvEntry
    MAX-ACCESS not-accessible
    STATUS current
    DESCRIPTION "t"
    ::= { dcpEnv 1 }

dcpEnvEntry OBJECT-TYPE
    SYNTAX DcpEnvEntry
    MAX-ACCESS not-accessible
    STATUS current
    DESCRIPTION "e"
    INDEX { dcpEnvIndex }
    ::= { dcpEnvTable 1 }

DcpEnvEntry ::= SEQUENCE {
    dcpEnvIndex INTEGER,
    dcpEnvFanStatus FanStatus
}

dcpEnvIndex OBJECT-TYPE
    SYNTAX INTEGER
    MAX-ACCESS not-accessible
    STATUS current
    DESCRIPTION "i"
    ::= { dcpEnvEntry 1 }

dcpEnvFanStatus OBJECT-TYPE
    SYNTAX FanStatus
    MAX-ACCESS read-only
    STATUS current
    DESCRIPTION "status"
    ::= { dcpEnvEntry 2 }

END
"#;
        let dir = write_fixture(MIB);
        let result = parse_directories(&[dir.path().to_string_lossy().to_string()]);

        let table = result.tables.get("dcpEnvTable").expect("dcpEnvTable definition");
        let status = table.columns.iter().find(|c| c.name == "dcpEnvFanStatus").expect("dcpEnvFanStatus column");
        assert_eq!(status.enum_values, vec![(1, "notPresent".to_string()), (2, "ok".to_string()), (3, "alarm".to_string())]);
    }

    /// The trap listener resolves a varbind's DISPLAY-HINT/enum labels by absolute OID (see
    /// `trap::resolve_value_hint`), not by column name - checks the index it's built from is
    /// keyed that way and only covers columns that actually have one or the other.
    #[test]
    fn value_hint_index_covers_table_columns_by_absolute_oid() {
        const MIB: &str = r#"
TEST-MIB DEFINITIONS ::= BEGIN

mib-2 OBJECT IDENTIFIER ::= { 1 3 6 1 2 1 }
dcpEnv OBJECT IDENTIFIER ::= { mib-2 99 }

DcpTemperature ::= TEXTUAL-CONVENTION
    DISPLAY-HINT "d-1"
    STATUS current
    DESCRIPTION "Tenths of a degree C"
    SYNTAX INTEGER

FanStatus ::= TEXTUAL-CONVENTION
    STATUS current
    DESCRIPTION "Fan status"
    SYNTAX INTEGER { notPresent(1), ok(2), alarm(3) }

dcpEnvTable OBJECT-TYPE
    SYNTAX SEQUENCE OF DcpEnvEntry
    MAX-ACCESS not-accessible
    STATUS current
    DESCRIPTION "t"
    ::= { dcpEnv 1 }

dcpEnvEntry OBJECT-TYPE
    SYNTAX DcpEnvEntry
    MAX-ACCESS not-accessible
    STATUS current
    DESCRIPTION "e"
    INDEX { dcpEnvIndex }
    ::= { dcpEnvTable 1 }

DcpEnvEntry ::= SEQUENCE {
    dcpEnvIndex INTEGER,
    dcpEnvTemp DcpTemperature,
    dcpEnvFanStatus FanStatus,
    dcpEnvLabel OCTET STRING
}

dcpEnvIndex OBJECT-TYPE
    SYNTAX INTEGER
    MAX-ACCESS not-accessible
    STATUS current
    DESCRIPTION "i"
    ::= { dcpEnvEntry 1 }

dcpEnvTemp OBJECT-TYPE
    SYNTAX DcpTemperature
    MAX-ACCESS read-only
    STATUS current
    DESCRIPTION "temp"
    ::= { dcpEnvEntry 2 }

dcpEnvFanStatus OBJECT-TYPE
    SYNTAX FanStatus
    MAX-ACCESS read-only
    STATUS current
    DESCRIPTION "status"
    ::= { dcpEnvEntry 3 }

dcpEnvLabel OBJECT-TYPE
    SYNTAX OCTET STRING
    MAX-ACCESS read-only
    STATUS current
    DESCRIPTION "label"
    ::= { dcpEnvEntry 4 }

END
"#;
        let dir = write_fixture(MIB);
        let result = parse_directories(&[dir.path().to_string_lossy().to_string()]);

        let temp = result.value_hints.iter().find(|(oid, _, _)| oid == "1.3.6.1.2.1.99.1.1.2").expect("dcpEnvTemp value hint");
        assert_eq!(temp.1, Some("d-1".to_string()));
        assert!(temp.2.is_empty());

        let status = result.value_hints.iter().find(|(oid, _, _)| oid == "1.3.6.1.2.1.99.1.1.3").expect("dcpEnvFanStatus value hint");
        assert_eq!(status.1, None);
        assert_eq!(status.2, vec![(1, "notPresent".to_string()), (2, "ok".to_string()), (3, "alarm".to_string())]);

        // Neither a DISPLAY-HINT nor enumerated values - not in the index.
        assert!(result.value_hints.iter().all(|(oid, _, _)| oid != "1.3.6.1.2.1.99.1.1.4"));
    }

    /// Locks down the wire shape the TypeScript frontend actually deserializes:
    /// `type` (not `kind`), camelCase field names, lowercase enum variants.
    #[test]
    fn json_shape_matches_what_the_frontend_expects() {
        let dir = write_fixture(IF_TABLE_MIB);
        let result = parse_directories(&[dir.path().to_string_lossy().to_string()]);
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains(r#""type":"table""#), "{json}");
        assert!(json.contains(r#""resolved":true"#), "{json}");
        assert!(!json.contains("sequence_of_target"), "internal snake_case field leaked: {json}");
        assert!(json.contains(r#""enumValues""#), "{json}");
    }
}
