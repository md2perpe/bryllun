pub mod gnmi;
pub mod mib;
pub mod netconf;
pub mod settings;
pub mod snmp;
pub mod trap;
pub mod yang;

use serde::Serialize;
use settings::{HostProfile, MibProfile, NetconfYangProfile, Settings, YangProfile};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{Manager, State};

struct AppState {
    settings_path: PathBuf,
    settings: Mutex<Settings>,
    last_parse: Mutex<Option<mib::ParseResult>>,
    trap_state: trap::TrapState,
}

impl AppState {
    fn save(&self) {
        settings::save(&self.settings_path, &self.settings.lock().unwrap());
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MibProfilesResponse {
    profiles: Vec<MibProfile>,
    active_profile_id: String,
}

fn profiles_response(settings: &Settings) -> MibProfilesResponse {
    MibProfilesResponse { profiles: settings.mib_profiles.clone(), active_profile_id: settings.active_mib_profile_id.clone() }
}

#[tauri::command]
fn list_mib_profiles(state: State<AppState>) -> MibProfilesResponse {
    profiles_response(&state.settings.lock().unwrap())
}

#[tauri::command]
fn add_mib_profile(state: State<AppState>, name: String) -> MibProfilesResponse {
    let resp = {
        let mut settings = state.settings.lock().unwrap();
        settings.add_mib_profile(name);
        profiles_response(&settings)
    };
    state.save();
    resp
}

#[tauri::command]
fn remove_mib_profile(state: State<AppState>, id: String) -> MibProfilesResponse {
    let resp = {
        let mut settings = state.settings.lock().unwrap();
        settings.remove_mib_profile(&id);
        profiles_response(&settings)
    };
    state.save();
    resp
}

#[tauri::command]
fn rename_mib_profile(state: State<AppState>, id: String, name: String) -> MibProfilesResponse {
    let resp = {
        let mut settings = state.settings.lock().unwrap();
        settings.rename_mib_profile(&id, name);
        profiles_response(&settings)
    };
    state.save();
    resp
}

#[tauri::command]
fn set_active_mib_profile(state: State<AppState>, id: String) -> MibProfilesResponse {
    let resp = {
        let mut settings = state.settings.lock().unwrap();
        if settings.mib_profiles.iter().any(|p| p.id == id) {
            settings.active_mib_profile_id = id;
        }
        profiles_response(&settings)
    };
    state.save();
    resp
}

#[tauri::command]
fn add_mib_dir(state: State<AppState>, path: String) -> MibProfilesResponse {
    let resp = {
        let mut settings = state.settings.lock().unwrap();
        if let Some(p) = settings.active_profile_mut() {
            if !p.dirs.contains(&path) {
                p.dirs.push(path);
            }
        }
        profiles_response(&settings)
    };
    state.save();
    resp
}

#[tauri::command]
fn remove_mib_dir(state: State<AppState>, path: String) -> MibProfilesResponse {
    let resp = {
        let mut settings = state.settings.lock().unwrap();
        if let Some(p) = settings.active_profile_mut() {
            p.dirs.retain(|d| d != &path);
        }
        profiles_response(&settings)
    };
    state.save();
    resp
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct YangProfilesResponse {
    profiles: Vec<YangProfile>,
    active_profile_id: String,
}

fn yang_profiles_response(settings: &Settings) -> YangProfilesResponse {
    YangProfilesResponse { profiles: settings.yang_profiles.clone(), active_profile_id: settings.active_yang_profile_id.clone() }
}

#[tauri::command]
fn list_yang_profiles(state: State<AppState>) -> YangProfilesResponse {
    yang_profiles_response(&state.settings.lock().unwrap())
}

#[tauri::command]
fn add_yang_profile(state: State<AppState>, name: String) -> YangProfilesResponse {
    let resp = {
        let mut settings = state.settings.lock().unwrap();
        settings.add_yang_profile(name);
        yang_profiles_response(&settings)
    };
    state.save();
    resp
}

#[tauri::command]
fn remove_yang_profile(state: State<AppState>, id: String) -> YangProfilesResponse {
    let resp = {
        let mut settings = state.settings.lock().unwrap();
        settings.remove_yang_profile(&id);
        yang_profiles_response(&settings)
    };
    state.save();
    resp
}

#[tauri::command]
fn rename_yang_profile(state: State<AppState>, id: String, name: String) -> YangProfilesResponse {
    let resp = {
        let mut settings = state.settings.lock().unwrap();
        settings.rename_yang_profile(&id, name);
        yang_profiles_response(&settings)
    };
    state.save();
    resp
}

#[tauri::command]
fn set_active_yang_profile(state: State<AppState>, id: String) -> YangProfilesResponse {
    let resp = {
        let mut settings = state.settings.lock().unwrap();
        if settings.yang_profiles.iter().any(|p| p.id == id) {
            settings.active_yang_profile_id = id;
        }
        yang_profiles_response(&settings)
    };
    state.save();
    resp
}

#[tauri::command]
fn add_yang_dir(state: State<AppState>, path: String) -> YangProfilesResponse {
    let resp = {
        let mut settings = state.settings.lock().unwrap();
        if let Some(p) = settings.active_yang_profile_mut() {
            if !p.dirs.contains(&path) {
                p.dirs.push(path);
            }
        }
        yang_profiles_response(&settings)
    };
    state.save();
    resp
}

#[tauri::command]
fn remove_yang_dir(state: State<AppState>, path: String) -> YangProfilesResponse {
    let resp = {
        let mut settings = state.settings.lock().unwrap();
        if let Some(p) = settings.active_yang_profile_mut() {
            p.dirs.retain(|d| d != &path);
        }
        yang_profiles_response(&settings)
    };
    state.save();
    resp
}

#[tauri::command]
fn get_yang_tree(state: State<AppState>) -> yang::YangParseResult {
    let dirs = state.settings.lock().unwrap().active_yang_profile().map(|p| p.dirs.clone()).unwrap_or_default();
    yang::parse_directories(&dirs)
}

/// The NETCONF-side counterpart to `YangProfilesResponse`/`yang_profiles_response` and the
/// commands built on them below - mirrors them exactly, over `settings.netconf_yang_profiles`
/// instead of `settings.yang_profiles`, since NETCONF keeps its own separate YANG directories
/// (see `NetconfYangProfile`'s doc comment).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NetconfYangProfilesResponse {
    profiles: Vec<NetconfYangProfile>,
    active_profile_id: String,
}

fn netconf_yang_profiles_response(settings: &Settings) -> NetconfYangProfilesResponse {
    NetconfYangProfilesResponse {
        profiles: settings.netconf_yang_profiles.clone(),
        active_profile_id: settings.active_netconf_yang_profile_id.clone(),
    }
}

#[tauri::command]
fn list_netconf_yang_profiles(state: State<AppState>) -> NetconfYangProfilesResponse {
    netconf_yang_profiles_response(&state.settings.lock().unwrap())
}

#[tauri::command]
fn add_netconf_yang_profile(state: State<AppState>, name: String) -> NetconfYangProfilesResponse {
    let resp = {
        let mut settings = state.settings.lock().unwrap();
        settings.add_netconf_yang_profile(name);
        netconf_yang_profiles_response(&settings)
    };
    state.save();
    resp
}

#[tauri::command]
fn remove_netconf_yang_profile(state: State<AppState>, id: String) -> NetconfYangProfilesResponse {
    let resp = {
        let mut settings = state.settings.lock().unwrap();
        settings.remove_netconf_yang_profile(&id);
        netconf_yang_profiles_response(&settings)
    };
    state.save();
    resp
}

#[tauri::command]
fn rename_netconf_yang_profile(state: State<AppState>, id: String, name: String) -> NetconfYangProfilesResponse {
    let resp = {
        let mut settings = state.settings.lock().unwrap();
        settings.rename_netconf_yang_profile(&id, name);
        netconf_yang_profiles_response(&settings)
    };
    state.save();
    resp
}

#[tauri::command]
fn set_active_netconf_yang_profile(state: State<AppState>, id: String) -> NetconfYangProfilesResponse {
    let resp = {
        let mut settings = state.settings.lock().unwrap();
        if settings.netconf_yang_profiles.iter().any(|p| p.id == id) {
            settings.active_netconf_yang_profile_id = id;
        }
        netconf_yang_profiles_response(&settings)
    };
    state.save();
    resp
}

#[tauri::command]
fn add_netconf_yang_dir(state: State<AppState>, path: String) -> NetconfYangProfilesResponse {
    let resp = {
        let mut settings = state.settings.lock().unwrap();
        if let Some(p) = settings.active_netconf_yang_profile_mut() {
            if !p.dirs.contains(&path) {
                p.dirs.push(path);
            }
        }
        netconf_yang_profiles_response(&settings)
    };
    state.save();
    resp
}

#[tauri::command]
fn remove_netconf_yang_dir(state: State<AppState>, path: String) -> NetconfYangProfilesResponse {
    let resp = {
        let mut settings = state.settings.lock().unwrap();
        if let Some(p) = settings.active_netconf_yang_profile_mut() {
            p.dirs.retain(|d| d != &path);
        }
        netconf_yang_profiles_response(&settings)
    };
    state.save();
    resp
}

#[tauri::command]
fn get_netconf_yang_tree(state: State<AppState>) -> yang::YangParseResult {
    let dirs = state.settings.lock().unwrap().active_netconf_yang_profile().map(|p| p.dirs.clone()).unwrap_or_default();
    yang::parse_directories(&dirs)
}

#[tauri::command]
fn list_host_profiles(state: State<AppState>) -> Vec<HostProfile> {
    state.settings.lock().unwrap().host_profiles.clone()
}

#[tauri::command]
fn get_mib_tree(state: State<AppState>) -> mib::ParseResult {
    let dirs = state.settings.lock().unwrap().active_profile().map(|p| p.dirs.clone()).unwrap_or_default();
    let result = mib::parse_directories(&dirs);
    *state.last_parse.lock().unwrap() = Some(result.clone());
    result
}

#[tauri::command]
fn fetch(state: State<AppState>, node_id: String, connection: snmp::ConnectionParams) -> Result<snmp::FetchResult, String> {
    let dirs = state.settings.lock().unwrap().active_profile().map(|p| p.dirs.clone()).unwrap_or_default();
    let mut cache = state.last_parse.lock().unwrap();
    if cache.is_none() {
        *cache = Some(mib::parse_directories(&dirs));
    }
    let parsed = cache.as_ref().unwrap();

    let symbol = parsed.symbols.get(&node_id).ok_or_else(|| format!("unknown OID node '{node_id}'"))?;
    match symbol.kind {
        mib::NodeKind::Table => {
            let table = parsed.tables.get(&node_id).ok_or_else(|| format!("no table definition found for '{node_id}'"))?;
            snmp::fetch_table(&connection, table)
        }
        mib::NodeKind::Scalar => {
            if !symbol.resolved {
                return Err(format!("'{node_id}' could not be resolved to an absolute OID"));
            }
            snmp::fetch_scalar(&connection, &symbol.oid)
        }
        mib::NodeKind::Group => Err(format!("'{node_id}' is a group, not a fetchable object")),
    }
}

#[tauri::command]
fn snmp_get(state: State<AppState>, node_id: String, op: snmp::SingleOp, connection: snmp::ConnectionParams) -> Result<snmp::FetchResult, String> {
    let dirs = state.settings.lock().unwrap().active_profile().map(|p| p.dirs.clone()).unwrap_or_default();
    let mut cache = state.last_parse.lock().unwrap();
    if cache.is_none() {
        *cache = Some(mib::parse_directories(&dirs));
    }
    snmp::get_single(&connection, cache.as_ref().unwrap(), &node_id, op)
}

#[tauri::command]
fn walk_timed(oid: String, connection: snmp::ConnectionParams) -> Result<snmp::WalkTiming, String> {
    snmp::walk_timed(&connection, &oid)
}

#[tauri::command]
fn start_trap_listener(state: State<AppState>, id: String, config: trap::TrapListenerConfig) -> Result<trap::TrapListenerStatus, String> {
    let dirs = state.settings.lock().unwrap().active_profile().map(|p| p.dirs.clone()).unwrap_or_default();
    let mut cache = state.last_parse.lock().unwrap();
    if cache.is_none() {
        *cache = Some(mib::parse_directories(&dirs));
    }
    let oid_index = Arc::new(mib::build_oid_index(&cache.as_ref().unwrap().tree));
    let value_hints = Arc::new(cache.as_ref().unwrap().value_hints.clone());
    state.trap_state.start(id, config, oid_index, value_hints)
}

#[tauri::command]
fn stop_trap_listener(state: State<AppState>, id: String) {
    state.trap_state.stop(&id);
}

#[tauri::command]
fn poll_traps(state: State<AppState>, id: String, after_seq: u64) -> Vec<trap::TrapEvent> {
    state.trap_state.poll(&id, after_seq)
}

#[tauri::command]
fn clear_traps(state: State<AppState>, id: String) {
    state.trap_state.clear(&id);
}

#[tauri::command]
fn local_ips() -> Vec<String> {
    trap::local_ips()
}

#[tauri::command]
async fn gnmi_capabilities(connection: gnmi::GnmiConnectionParams) -> Result<gnmi::GnmiCapabilities, String> {
    gnmi::capabilities(&connection).await
}

#[tauri::command]
async fn gnmi_get(connection: gnmi::GnmiConnectionParams, path: String) -> Result<gnmi::GnmiTree, String> {
    gnmi::get(&connection, &path).await
}

#[tauri::command]
async fn netconf_capabilities(connection: netconf::NetconfConnectionParams) -> Result<netconf::NetconfCapabilities, String> {
    netconf::capabilities(&connection).await
}

/// Unlike `gnmi_get`, this needs the active NETCONF YANG profile's parsed modules (specifically
/// their namespace URIs) to turn `path`'s `module-name:node-name` qualifiers into the target's
/// `<filter type="xpath">` - see `netconf.rs`'s doc comment for why, and `NetconfYangProfile`'s
/// doc comment for why this is its own profile rather than gNMI's `active_yang_profile`.
#[tauri::command]
async fn netconf_get(state: State<'_, AppState>, connection: netconf::NetconfConnectionParams, path: String) -> Result<netconf::NetconfTree, String> {
    let dirs = state.settings.lock().unwrap().active_netconf_yang_profile().map(|p| p.dirs.clone()).unwrap_or_default();
    let parsed = yang::parse_directories(&dirs);
    netconf::get(&connection, &path, &parsed.module_namespaces).await
}

/// Writes a table export (CSV or PNG, built client-side) to a path the user already chose via
/// the native save dialog - a plain custom command rather than the fs plugin, since a
/// user-picked absolute path doesn't fit that plugin's scope-based permission model.
#[tauri::command]
fn write_export_file(path: String, data: Vec<u8>) -> Result<(), String> {
    std::fs::write(&path, data).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            let settings_path = app.path().app_config_dir()?.join("settings.json");
            let settings = settings::load(&settings_path);
            // Write it back immediately so a fresh install gets a settings.json
            // on disk right away (seeded defaults), not just on first edit.
            settings::save(&settings_path, &settings);
            app.manage(AppState {
                settings_path,
                settings: Mutex::new(settings),
                last_parse: Mutex::new(None),
                trap_state: trap::TrapState::default(),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_mib_profiles,
            add_mib_profile,
            remove_mib_profile,
            rename_mib_profile,
            set_active_mib_profile,
            add_mib_dir,
            remove_mib_dir,
            list_yang_profiles,
            add_yang_profile,
            remove_yang_profile,
            rename_yang_profile,
            set_active_yang_profile,
            add_yang_dir,
            remove_yang_dir,
            get_yang_tree,
            list_netconf_yang_profiles,
            add_netconf_yang_profile,
            remove_netconf_yang_profile,
            rename_netconf_yang_profile,
            set_active_netconf_yang_profile,
            add_netconf_yang_dir,
            remove_netconf_yang_dir,
            get_netconf_yang_tree,
            list_host_profiles,
            get_mib_tree,
            fetch,
            snmp_get,
            walk_timed,
            start_trap_listener,
            stop_trap_listener,
            poll_traps,
            clear_traps,
            local_ips,
            gnmi_capabilities,
            gnmi_get,
            netconf_capabilities,
            netconf_get,
            write_export_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
