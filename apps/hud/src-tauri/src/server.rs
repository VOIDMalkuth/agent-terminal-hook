//! Local HTTP gateway (design.md §1/§2.4):
//! binds 127.0.0.1:7301 only, checks a shared X-Ath-Token. Pure transport:
//! auth -> size cap -> minimal shape check -> forward to the frontend as
//! `ath-event`. All semantics (state machine etc.) live in the HUD frontend.

use std::io::Read;
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};
use tauri::{Emitter, Manager};
use tiny_http::{Header, Method, Response, Server};

const PORT: u16 = 7301;
const MAX_BODY: usize = 256 * 1024;

#[derive(Clone, Debug, serde::Serialize)]
pub struct GatewayInfo {
    pub bound: bool,
    pub port: u16,
    pub token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

static GATEWAY: OnceLock<Mutex<Option<GatewayInfo>>> = OnceLock::new();

pub fn current() -> Option<GatewayInfo> {
    let guard = GATEWAY.get_or_init(|| Mutex::new(None)).lock().ok()?;
    guard.as_ref().cloned()
}

fn set_current(info: GatewayInfo) {
    if let Ok(mut guard) = GATEWAY.get_or_init(|| Mutex::new(None)).lock() {
        *guard = Some(info);
    }
}

pub fn spawn(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let token = load_or_create_token(&app);
        match Server::http(("127.0.0.1", PORT)) {
            Ok(server) => {
                set_current(GatewayInfo {
                    bound: true,
                    port: PORT,
                    token: token.clone(),
                    error: None,
                });
                let _ = app.emit("ath-gateway-status", json!({ "bound": true, "port": PORT }));
                eprintln!("[ath-hud] gateway listening on 127.0.0.1:{PORT}");
                serve(server, &app, &token);
            }
            Err(e) => {
                let msg = format!("端口 {PORT} 绑定失败：{e}");
                set_current(GatewayInfo {
                    bound: false,
                    port: PORT,
                    token,
                    error: Some(msg.clone()),
                });
                let _ = app.emit(
                    "ath-gateway-status",
                    json!({ "bound": false, "port": PORT, "error": msg }),
                );
                eprintln!("[ath-hud] {msg}");
            }
        }
    });
}

fn serve(server: Server, app: &tauri::AppHandle, token: &str) {
    for request in server.incoming_requests() {
        if let Err(e) = handle_request(request, app, token) {
            eprintln!("[ath-hud] request failed: {e}");
        }
    }
}

type ReqResult = Result<(), Box<dyn std::error::Error + Send + Sync>>;

// Header::from_bytes returns () on error; fine for these static valid literals
fn cors_header() -> Header {
    Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap()
}

fn respond(req: tiny_http::Request, status: u16, body: &str) -> ReqResult {
    let ctype = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
    req.respond(
        Response::from_string(body)
            .with_status_code(status)
            .with_header(cors_header())
            .with_header(ctype),
    )?;
    Ok(())
}

fn respond_empty(req: tiny_http::Request, status: u16) -> ReqResult {
    req.respond(Response::empty(status).with_header(cors_header()))?;
    Ok(())
}

fn handle_request(request: tiny_http::Request, app: &tauri::AppHandle, token: &str) -> ReqResult {
    let method = request.method().clone();
    let path = request.url().split('?').next().unwrap_or("/").to_string();

    if method == Method::Options {
        return respond_empty(request, 204);
    }

    match (&method, path.as_str()) {
        (Method::Get, "/health") => respond(
            request,
            200,
            &json!({ "ok": true, "service": "ath-hud", "protocol": 1 }).to_string(),
        ),
        (Method::Post, "/event") => handle_event(request, app, token),
        _ => respond(request, 404, r#"{"error":"not found"}"#),
    }
}

fn handle_event(
    mut request: tiny_http::Request,
    app: &tauri::AppHandle,
    token: &str,
) -> ReqResult {
    let authorized = request.headers().iter().any(|h| {
        h.field.as_str().as_str().eq_ignore_ascii_case("x-ath-token") && h.value.as_str() == token
    });
    if !authorized {
        return respond(request, 401, r#"{"error":"unauthorized"}"#);
    }

    let mut buf = Vec::new();
    request
        .as_reader()
        .take((MAX_BODY + 1) as u64)
        .read_to_end(&mut buf)?;
    if buf.len() > MAX_BODY {
        return respond(request, 413, r#"{"error":"payload too large"}"#);
    }
    let body = match std::str::from_utf8(&buf) {
        Ok(s) => s,
        Err(_) => return respond(request, 400, r#"{"error":"body must be utf-8 json"}"#),
    };
    let value: Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => {
            return respond(
                request,
                400,
                &json!({ "error": format!("invalid json: {e}") }).to_string(),
            );
        }
    };
    if let Err(msg) = validate_ath_v1(&value) {
        return respond(request, 400, &json!({ "error": msg }).to_string());
    }

    let _ = app.emit("ath-event", &value);
    respond_empty(request, 204)
}

/// Minimal shape validation only; detailed checks live in the frontend zod schema
fn validate_ath_v1(v: &Value) -> Result<(), String> {
    let obj = v.as_object().ok_or("message must be a json object")?;
    if obj.get("v").and_then(Value::as_i64) != Some(1) {
        return Err("unsupported protocol version: field v must be 1".into());
    }
    let ty = obj.get("type").and_then(Value::as_str).unwrap_or_default();
    if !matches!(ty, "register" | "state" | "op" | "report" | "bye") {
        return Err(format!("unknown message type: {ty}"));
    }
    if obj
        .get("sid")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .is_empty()
    {
        return Err("missing sid".into());
    }
    Ok(())
}

/// Token source: ATH_TOKEN env var -> %APPDATA%\com.ath.hud\token (created on first launch)
fn load_or_create_token(app: &tauri::AppHandle) -> String {
    use rand::distributions::Alphanumeric;
    use rand::Rng;

    if let Ok(t) = std::env::var("ATH_TOKEN") {
        let t = t.trim().to_string();
        if !t.is_empty() {
            // write-through: senders (hooks / MCP / Lua gateway) read the token file,
            // so an env override must land there too or every report 401s silently
            if let Ok(dir) = app.path().app_config_dir() {
                let _ = std::fs::create_dir_all(&dir);
                let _ = std::fs::write(dir.join("token"), &t);
            }
            return t;
        }
    }
    let Ok(dir) = app.path().app_config_dir() else {
        return "ath-insecure-default-token".to_string();
    };
    let _ = std::fs::create_dir_all(&dir);
    let file = dir.join("token");
    if let Ok(existing) = std::fs::read_to_string(&file) {
        let t = existing.trim();
        if !t.is_empty() {
            return t.to_string();
        }
    }
    let token: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(40)
        .map(char::from)
        .collect();
    let _ = std::fs::write(&file, &token);
    token
}
