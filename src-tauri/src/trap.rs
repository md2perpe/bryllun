//! SNMP trap/inform listener: a background UDP receiver per listener id, decoding v1/v2c/v3
//! traps with the `snmp2` crate and labeling OIDs against the parsed MIB tree.
//!
//! Traps are unsolicited: unlike `snmp.rs`'s client requests, there's no round trip to
//! recover from an SNMPv3 message we can't yet decode. `snmp2` models v3 decoding as a
//! request/response discovery flow (see its `Error::AuthUpdated`, meaning "I just learned
//! the agent's engine ID/boots from this message, decode it again") - which for a trap means
//! "parse these exact same bytes again", since the `Security` object has now been mutated in
//! place with what it learned. `decode` below does exactly that, once.
//!
//! Received events are kept in a per-listener ring buffer that the frontend polls
//! (`poll_traps`), the same "frontend pulls on an interval" shape already used for
//! auto-refreshing table tabs, so it works identically under Tauri and the standalone HTTP
//! dev server (`bin/server.rs`), neither of which currently has a push/event channel.

use crate::mib::ValueHintIndex;
use crate::snmp::format_value;
use serde::{Deserialize, Serialize};
use snmp2::{v3, Error as SnmpError, MessageType, Pdu, Value, Version};
use std::collections::{HashMap, VecDeque};
use std::net::{SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Per-listener cap on retained events; oldest are dropped once exceeded.
const MAX_EVENTS: usize = 2000;
/// Socket read timeout, so the receive loop wakes up periodically to check for a stop request.
const RECV_TIMEOUT: Duration = Duration::from_millis(500);
const SNMP_TRAP_OID: &str = "1.3.6.1.6.3.1.1.4.1.0";
/// RFC1215 generic-trap names, indexed by the v1 `generic-trap` field (0-5); the SNMPv2-MIB
/// OID for each is `1.3.6.1.6.3.1.1.5.{index+1}`.
const GENERIC_TRAP_NAMES: [&str; 6] = ["coldStart", "warmStart", "linkDown", "linkUp", "authenticationFailure", "egpNeighborLoss"];

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrapListenerConfig {
    pub bind_addr: String,
    pub port: String,
    /// "v1", "v2c", or "v3" - which single wire version this listener accepts, mirroring the
    /// query tabs' version switch. Packets of any other version are silently ignored, same as
    /// how a query tab only ever speaks the one version it's set to.
    pub version: String,
    /// v1/v2c only: exact community a packet must carry to be accepted. Empty accepts any.
    pub community: String,
    pub v3_user: String,
    pub v3_auth: String,
    pub v3_priv: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrapVarbind {
    pub oid: String,
    pub name: String,
    pub value: String,
    /// DISPLAY-HINT declared on this varbind's MIB type, if any - mirrors a table column's
    /// `displayHints` entry, applied client-side only while "Display hint" is toggled on.
    pub display_hint: Option<String>,
    /// Enumerated-value labels keyed by the raw integer as a string (e.g. `"2"` -> `"ok"`),
    /// mirrors a table column's `enumLabels` entry.
    pub enum_labels: HashMap<String, String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrapEvent {
    pub seq: u64,
    pub time_ms: i64,
    pub source: String,
    pub version: String,
    /// Community string (v1/v2c) or security user name (v3).
    pub principal: String,
    pub trap_type: String,
    pub trap_oid: String,
    pub varbinds: Vec<TrapVarbind>,
    /// True for an SNMPv2c/v3 Inform - a confirmed notification that RFC 3416 requires
    /// acknowledging. This listener is a passive observer and doesn't send that
    /// acknowledgement, so a real agent will keep retransmitting it; shown in the UI so
    /// that isn't mistaken for the app dropping events.
    pub confirmed: bool,
    pub error: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrapListenerStatus {
    pub running: bool,
    pub bound_addr: String,
}

struct ListenerHandle {
    stop: Arc<AtomicBool>,
    thread: JoinHandle<()>,
    events: Arc<Mutex<VecDeque<TrapEvent>>>,
}

#[derive(Default)]
pub struct TrapState {
    listeners: Mutex<HashMap<String, ListenerHandle>>,
}

fn build_security(config: &TrapListenerConfig) -> Option<v3::Security> {
    if config.v3_user.trim().is_empty() {
        return None;
    }
    // Mirrors `snmp.rs::open_session`'s v3 defaults (SHA1 + AES-128, auth/priv skipped when
    // their password is empty) so a trap listener's v3 fields behave the same as a query tab's.
    let auth_mode = match (config.v3_auth.is_empty(), config.v3_priv.is_empty()) {
        (true, _) => v3::Auth::NoAuthNoPriv,
        (false, true) => v3::Auth::AuthNoPriv,
        (false, false) => v3::Auth::AuthPriv { cipher: v3::Cipher::Aes128, privacy_password: config.v3_priv.as_bytes().to_vec() },
    };
    Some(
        v3::Security::new(config.v3_user.as_bytes(), config.v3_auth.as_bytes())
            .with_auth_protocol(v3::AuthProtocol::Sha1)
            .with_auth(auth_mode),
    )
}

/// Longest-prefix-match `oid` against `index` (see `mib::build_oid_index`), returning e.g.
/// `"ifDescr.3"` for a table column instance, `"sysDescr.0"` for a scalar, or the raw dotted
/// OID unchanged if nothing in the configured MIB directories covers it.
pub(crate) fn resolve_oid(index: &[(String, String)], oid: &str) -> String {
    for (base, name) in index {
        if oid == base {
            return name.clone();
        }
        if let Some(rest) = oid.strip_prefix(base.as_str()) {
            if rest.starts_with('.') {
                return format!("{name}{rest}");
            }
        }
    }
    oid.to_string()
}

/// Longest-prefix-match `oid` against a `ValueHintIndex` (see `mib::build_value_hint_index`),
/// the same walk `resolve_oid` does against the name index, returning that symbol's
/// DISPLAY-HINT/enum labels or `None`/empty if `oid` isn't covered by one.
pub(crate) fn resolve_value_hint(index: &ValueHintIndex, oid: &str) -> (Option<String>, HashMap<String, String>) {
    for (base, hint, enum_values) in index {
        let matches = oid == base || oid.strip_prefix(base.as_str()).is_some_and(|rest| rest.starts_with('.'));
        if matches {
            let enum_labels = enum_values.iter().map(|(v, name)| (v.to_string(), name.clone())).collect();
            return (hint.clone(), enum_labels);
        }
    }
    (None, HashMap::new())
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn error_event(seq: u64, src: SocketAddr, message: String) -> TrapEvent {
    TrapEvent {
        seq,
        time_ms: now_ms(),
        source: src.to_string(),
        version: "?".to_string(),
        principal: String::new(),
        trap_type: String::new(),
        trap_oid: String::new(),
        varbinds: Vec::new(),
        confirmed: false,
        error: Some(message),
    }
}

fn event_from_pdu(pdu: Pdu, seq: u64, src: SocketAddr, oid_index: &[(String, String)], value_hints: &ValueHintIndex) -> TrapEvent {
    let version = pdu.version().map(|v| v.to_string()).unwrap_or_else(|_| "unknown".to_string());
    let principal = String::from_utf8_lossy(pdu.community).into_owned();

    if let Some(v1) = &pdu.v1_trap_info {
        let enterprise = v1.enterprise.to_id_string();
        let (trap_oid, trap_type) = if v1.generic_trap == 6 {
            (format!("{enterprise}.0.{}", v1.specific_trap), String::new())
        } else {
            let oid = format!("1.3.6.1.6.3.1.1.5.{}", v1.generic_trap + 1);
            let name = GENERIC_TRAP_NAMES.get(v1.generic_trap as usize).map(|s| s.to_string()).unwrap_or_default();
            (oid, name)
        };
        let trap_type = if trap_type.is_empty() { resolve_oid(oid_index, &trap_oid) } else { trap_type };
        let varbinds = pdu
            .varbinds
            .clone()
            .map(|(oid, val)| {
                let oid_s = oid.to_id_string();
                let (display_hint, enum_labels) = resolve_value_hint(value_hints, &oid_s);
                TrapVarbind { name: resolve_oid(oid_index, &oid_s), oid: oid_s, value: format_value(&val, &[]), display_hint, enum_labels }
            })
            .collect();
        return TrapEvent { seq, time_ms: now_ms(), source: src.to_string(), version, principal, trap_type, trap_oid, varbinds, confirmed: false, error: None };
    }

    let mut trap_oid = String::new();
    let varbinds: Vec<TrapVarbind> = pdu
        .varbinds
        .clone()
        .map(|(oid, val)| {
            let oid_s = oid.to_id_string();
            if oid_s == SNMP_TRAP_OID {
                if let Value::ObjectIdentifier(inner) = &val {
                    trap_oid = inner.to_id_string();
                }
            }
            let (display_hint, enum_labels) = resolve_value_hint(value_hints, &oid_s);
            TrapVarbind { name: resolve_oid(oid_index, &oid_s), oid: oid_s, value: format_value(&val, &[]), display_hint, enum_labels }
        })
        .collect();
    let trap_type = if trap_oid.is_empty() { "(no snmpTrapOID varbind)".to_string() } else { resolve_oid(oid_index, &trap_oid) };
    let confirmed = pdu.message_type == MessageType::InformRequest;

    TrapEvent { seq, time_ms: now_ms(), source: src.to_string(), version, principal, trap_type, trap_oid, varbinds, confirmed, error: None }
}

fn next_seq(counter: &Mutex<u64>) -> u64 {
    let mut s = counter.lock().unwrap();
    *s += 1;
    *s
}

/// Decodes one packet, or returns `None` if it's out of scope for this listener's selected
/// version/community - the same "wrong dialect, not shown" filtering a query tab gets for
/// free by only ever speaking the one version it's configured for.
fn decode(
    bytes: &[u8],
    src: SocketAddr,
    config: &TrapListenerConfig,
    security: &mut Option<v3::Security>,
    oid_index: &[(String, String)],
    value_hints: &ValueHintIndex,
    seq_counter: &Mutex<u64>,
) -> Option<TrapEvent> {
    match config.version.as_str() {
        "v1" | "v2c" => {
            let pdu = Pdu::from_bytes(bytes).ok()?;
            let wanted = if config.version == "v1" { Version::V1 } else { Version::V2C };
            if pdu.version().ok()? != wanted {
                return None;
            }
            if !config.community.is_empty() && pdu.community != config.community.as_bytes() {
                return None;
            }
            Some(event_from_pdu(pdu, next_seq(seq_counter), src, oid_index, value_hints))
        }
        "v3" => {
            // `start` requires a v3 user before a v3-mode listener is allowed to run, so this
            // is unreachable in practice; surfaced as an error event rather than a silent drop
            // as a defensive fallback.
            let Some(sec) = security.as_mut() else {
                return Some(error_event(next_seq(seq_counter), src, "no SNMPv3 security user configured for this listener".to_string()));
            };
            let mut result = Pdu::from_bytes_with_security(bytes, Some(&mut *sec));
            if matches!(result, Err(SnmpError::AuthUpdated)) {
                // First packet from a not-yet-seen engine: `sec` just learned its engine
                // ID/boots - decode the same bytes again now that it knows how to.
                result = Pdu::from_bytes_with_security(bytes, Some(&mut *sec));
            }
            match result {
                Ok(pdu) => Some(event_from_pdu(pdu, next_seq(seq_counter), src, oid_index, value_hints)),
                // Unlike a version/community mismatch, this is the version the listener is
                // configured for, but decoding still failed (bad credentials, corrupt packet,
                // ...) - worth surfacing rather than silently dropping.
                Err(e) => Some(error_event(next_seq(seq_counter), src, format!("failed to decode SNMPv3 message: {e}"))),
            }
        }
        _ => None,
    }
}

impl TrapState {
    pub fn start(
        &self,
        id: String,
        config: TrapListenerConfig,
        oid_index: Arc<Vec<(String, String)>>,
        value_hints: Arc<ValueHintIndex>,
    ) -> Result<TrapListenerStatus, String> {
        let mut listeners = self.listeners.lock().unwrap();
        if listeners.contains_key(&id) {
            return Err("this tab's trap listener is already running".to_string());
        }
        if !matches!(config.version.as_str(), "v1" | "v2c" | "v3") {
            return Err(format!("unknown SNMP version '{}'", config.version));
        }
        if config.version == "v3" && config.v3_user.trim().is_empty() {
            return Err("SNMPv3 selected but no security user is configured".to_string());
        }
        let addr = format!("{}:{}", config.bind_addr.trim(), config.port.trim());
        let socket = UdpSocket::bind(&addr).map_err(|e| format!("failed to bind {addr}: {e}"))?;
        socket.set_read_timeout(Some(RECV_TIMEOUT)).ok();
        let bound_addr = socket.local_addr().map(|a| a.to_string()).unwrap_or(addr);

        let stop = Arc::new(AtomicBool::new(false));
        let stop_bg = stop.clone();
        let events: Arc<Mutex<VecDeque<TrapEvent>>> = Arc::new(Mutex::new(VecDeque::new()));
        let events_bg = events.clone();
        let next_seq_counter = Mutex::new(0u64);
        let mut security = build_security(&config);

        let thread = std::thread::spawn(move || {
            let mut buf = [0u8; 65_507];
            while !stop_bg.load(Ordering::Relaxed) {
                match socket.recv_from(&mut buf) {
                    Ok((n, src)) => {
                        let Some(event) = decode(&buf[..n], src, &config, &mut security, &oid_index, &value_hints, &next_seq_counter) else { continue };
                        let mut q = events_bg.lock().unwrap();
                        q.push_back(event);
                        while q.len() > MAX_EVENTS {
                            q.pop_front();
                        }
                    }
                    Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => continue,
                    Err(_) => continue,
                }
            }
        });

        listeners.insert(id, ListenerHandle { stop, thread, events });
        Ok(TrapListenerStatus { running: true, bound_addr })
    }

    pub fn stop(&self, id: &str) {
        let handle = self.listeners.lock().unwrap().remove(id);
        if let Some(h) = handle {
            h.stop.store(true, Ordering::Relaxed);
            let _ = h.thread.join();
        }
    }

    pub fn poll(&self, id: &str, after_seq: u64) -> Vec<TrapEvent> {
        let listeners = self.listeners.lock().unwrap();
        let Some(h) = listeners.get(id) else { return Vec::new() };
        let events = h.events.lock().unwrap().iter().filter(|e| e.seq > after_seq).cloned().collect();
        events
    }

    /// Clears retained events but leaves the sequence counter running, so a poll already in
    /// flight with an old `after_seq` doesn't see cleared events reappear as "new".
    pub fn clear(&self, id: &str) {
        let listeners = self.listeners.lock().unwrap();
        if let Some(h) = listeners.get(id) {
            h.events.lock().unwrap().clear();
        }
    }
}

/// This machine's non-loopback IPv4 addresses, so the UI can tell the user what to configure
/// as the trap destination on the SNMP agent/device side. IPv6 is left out since SNMP trap
/// destinations are almost always configured as an IPv4 address in practice.
pub fn local_ips() -> Vec<String> {
    let mut ips: Vec<String> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter(|i| !i.is_loopback())
        .filter_map(|i| match i.ip() {
            std::net::IpAddr::V4(v4) => Some(v4.to_string()),
            std::net::IpAddr::V6(_) => None,
        })
        .collect();
    ips.sort();
    ips.dedup();
    ips
}
