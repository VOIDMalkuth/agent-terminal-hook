use crate::server::GatewayInfo;

#[tauri::command]
pub fn gateway_info() -> Option<GatewayInfo> {
    crate::server::current()
}
