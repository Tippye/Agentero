//! Same-origin REST bootstrap. Requests are bounded and never automatically replayed.
use super::{
    crypto::DeviceIdentity,
    protocol::{key, strict_json, MAX_SAFE_INTEGER},
    RemoteError, Result,
};
use reqwest::{Client, Method};
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::{json, Value};
use std::{collections::HashSet, time::Duration};
use url::{Host, Url};

#[derive(Clone)]
pub struct ServerApi {
    base: Url,
    client: Client,
}

// Intentionally no Debug: account/device bearer credentials are sensitive.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TokenPair {
    pub access_token: String,
    pub access_token_expires_at: u64,
    pub refresh_token: String,
    pub refresh_token_expires_at: u64,
}
impl TokenPair {
    pub fn validate(&self) -> Result<()> {
        if [&self.access_token, &self.refresh_token]
            .iter()
            .any(|s| !(16..=8192).contains(&s.len()))
            || [self.access_token_expires_at, self.refresh_token_expires_at]
                .iter()
                .any(|n| *n == 0 || *n > MAX_SAFE_INTEGER)
        {
            return Err(RemoteError::invalid("Invalid device credential response"));
        }
        Ok(())
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountLogin {
    pub token: String,
    pub account: String,
    pub expires_at: u64,
    pub is_admin: bool,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostDevice {
    pub device_id: String,
    pub name: String,
    pub role: String,
    pub platform: String,
    pub membership_id: String,
    #[serde(default)]
    pub online: bool,
    pub client_version: Option<String>,
    pub harness_version: Option<String>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizedHost {
    #[serde(flatten)]
    pub device: HostDevice,
    pub identity_key: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DevicePage {
    items: Vec<HostDevice>,
    next_cursor: Option<String>,
}

/// Validate before any request. Public HTTP is rejected even when used by a native client.
pub fn validate_server_url(input: &str) -> Result<Url> {
    let mut url =
        Url::parse(input).map_err(|_| RemoteError::invalid("Invalid Remote server URL"))?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || (url.path() != "/" && !url.path().is_empty())
    {
        return Err(RemoteError::invalid(
            "Remote server URL must be an origin without credentials, path, query or fragment",
        ));
    }
    let private = match url.host() {
        Some(Host::Domain(name)) => {
            name.eq_ignore_ascii_case("localhost") || name.ends_with(".localhost")
        }
        Some(Host::Ipv4(ip)) => ip.is_private() || ip.is_loopback() || ip.is_link_local(),
        Some(Host::Ipv6(ip)) => {
            ip.is_loopback()
                || (ip.segments()[0] & 0xfe00 == 0xfc00)
                || (ip.segments()[0] & 0xffc0 == 0xfe80)
                || ip
                    .to_ipv4_mapped()
                    .is_some_and(|v| v.is_private() || v.is_loopback() || v.is_link_local())
        }
        None => false,
    };
    if url.host().is_none() || !(url.scheme() == "https" || (url.scheme() == "http" && private)) {
        return Err(RemoteError::invalid("Remote server requires HTTPS; HTTP is limited to literal private or loopback addresses"));
    }
    url.set_path("/");
    Ok(url)
}
impl ServerApi {
    pub fn new(origin: &str, timeout: Duration) -> Result<Self> {
        if timeout.is_zero() {
            return Err(RemoteError::invalid("REST timeout must be positive"));
        }
        let client = Client::builder()
            .timeout(timeout)
            .connect_timeout(timeout)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| {
                RemoteError::new("CONNECTION_FAILED", "Cannot initialize Remote HTTP client")
            })?;
        Ok(Self {
            base: validate_server_url(origin)?,
            client,
        })
    }
    pub fn websocket_url(&self) -> Result<Url> {
        let mut url = self
            .base
            .join("ws/v1/connect")
            .map_err(|_| RemoteError::invalid("Invalid WebSocket URL"))?;
        let scheme = if self.base.scheme() == "https" {
            "wss"
        } else {
            "ws"
        };
        url.set_scheme(scheme)
            .map_err(|_| RemoteError::invalid("Invalid WebSocket URL"))?;
        Ok(url)
    }
    pub async fn login(&self, email: &str, password: &str) -> Result<AccountLogin> {
        let login: AccountLogin = self
            .request(
                Method::POST,
                "api/v1/auth/login",
                None,
                Some(json!({"email":email.trim(),"password":password})),
            )
            .await?;
        if !(16..=8192).contains(&login.token.len())
            || login.account.is_empty()
            || login.expires_at == 0
            || login.expires_at > MAX_SAFE_INTEGER
        {
            return Err(RemoteError::invalid("Invalid account login response"));
        }
        Ok(login)
    }
    pub async fn register(
        &self,
        identity: &DeviceIdentity,
        name: &str,
        platform: &str,
        version: &str,
        account_token: &str,
    ) -> Result<TokenPair> {
        if uuid::Uuid::parse_str(&identity.device_id).is_err()
            || name.trim().is_empty()
            || name.len() > 128
            || version.is_empty()
            || version.len() > 64
            || platform.is_empty()
            || platform.len() > 64
            || !platform
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
            || !platform.as_bytes()[0].is_ascii_alphanumeric()
        {
            return Err(RemoteError::invalid("Invalid client device descriptor"));
        }
        key(&identity.public_key)?;
        let pair: TokenPair = self.request(Method::POST, "api/v1/devices/register", Some(account_token), Some(json!({"v":1,"device":{"deviceId":identity.device_id,"name":name,"role":"client","platform":platform,"identityKey":identity.public_key,"clientVersion":version}}))).await?;
        pair.validate()?;
        Ok(pair)
    }
    /// Caller must atomically persist the returned pair before using it. An error
    /// preserves the current credentials; HTTP status alone never revokes them.
    pub async fn refresh(&self, device_id: &str, refresh_token: &str) -> Result<TokenPair> {
        let pair: TokenPair = self
            .request(
                Method::POST,
                "api/v1/auth/refresh",
                None,
                Some(json!({"deviceId":device_id,"refreshToken":refresh_token})),
            )
            .await?;
        pair.validate()?;
        Ok(pair)
    }
    pub async fn list_hosts(&self, token: &str) -> Result<Vec<HostDevice>> {
        let mut hosts = Vec::new();
        let mut cursors = HashSet::new();
        let mut cursor: Option<String> = None;
        loop {
            let mut url = self
                .base
                .join("api/v1/devices")
                .map_err(|_| RemoteError::invalid("Invalid device URL"))?;
            url.query_pairs_mut().append_pair("limit", "50");
            if let Some(value) = &cursor {
                url.query_pairs_mut().append_pair("cursor", value);
            }
            let page: DevicePage = self
                .request_url(Method::GET, url, Some(token), None)
                .await?;
            for host in page.items {
                if host.role != "host"
                    || host.membership_id.is_empty()
                    || host.device_id.is_empty()
                    || hosts
                        .iter()
                        .any(|h: &HostDevice| h.device_id == host.device_id)
                {
                    return Err(RemoteError::invalid("Invalid or duplicate authorized Host"));
                }
                hosts.push(host);
            }
            match page.next_cursor {
                None => return Ok(hosts),
                Some(next)
                    if !next.is_empty()
                        && next.len() <= 4096
                        && cursors.insert(next.clone())
                        && cursors.len() < 10000 =>
                {
                    cursor = Some(next)
                }
                _ => {
                    return Err(RemoteError::invalid(
                        "Invalid or repeating Host catalog cursor",
                    ))
                }
            }
        }
    }
    pub async fn host(&self, token: &str, host_id: &str) -> Result<AuthorizedHost> {
        let mut url = self
            .base
            .join("api/v1/devices/")
            .map_err(|_| RemoteError::invalid("Invalid device URL"))?;
        url.path_segments_mut()
            .map_err(|_| RemoteError::invalid("Invalid device URL"))?
            .pop_if_empty()
            .push(host_id);
        let host: AuthorizedHost = self
            .request_url(Method::GET, url, Some(token), None)
            .await?;
        if host.device.device_id != host_id
            || host.device.role != "host"
            || host.device.membership_id.is_empty()
        {
            return Err(RemoteError::new(
                "PEER_IDENTITY_MISMATCH",
                "Host descriptor does not match authorized peer",
            ));
        }
        key(&host.identity_key)?;
        Ok(host)
    }
    async fn request<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> Result<T> {
        let url = self
            .base
            .join(path)
            .map_err(|_| RemoteError::invalid("Invalid API endpoint"))?;
        self.request_url(method, url, token, body).await
    }
    async fn request_url<T: DeserializeOwned>(
        &self,
        method: Method,
        url: Url,
        token: Option<&str>,
        body: Option<Value>,
    ) -> Result<T> {
        let mutation = method != Method::GET;
        let mut request = self
            .client
            .request(method, url)
            .header("Accept", "application/json");
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let mut response = request.send().await.map_err(|_| {
            let error = RemoteError::new(
                "CONNECTION_FAILED",
                "Remote HTTP request failed or timed out",
            );
            if mutation {
                error.unknown()
            } else {
                error
            }
        })?;
        let status = response.status();
        let mut bytes = Vec::new();
        let after_dispatch = |error: RemoteError| if mutation { error.unknown() } else { error };
        while let Some(chunk) = response.chunk().await.map_err(|_| {
            after_dispatch(RemoteError::new(
                "CONNECTION_FAILED",
                "Remote HTTP response interrupted",
            ))
        })? {
            if bytes.len() + chunk.len() > 4 * 1024 * 1024 {
                return Err(after_dispatch(RemoteError::invalid(
                    "Remote HTTP response exceeds limit",
                )));
            }
            bytes.extend_from_slice(&chunk);
        }
        let value = strict_json(&bytes).map_err(after_dispatch)?;
        if !status.is_success() {
            // Only structured protocol errors carry authoritative auth semantics.
            let code = value
                .pointer("/error/code")
                .and_then(Value::as_str)
                .unwrap_or("HTTP_ERROR");
            let error = RemoteError::new(code, "The Remote server rejected the request");
            return Err(if status.is_server_error() {
                after_dispatch(error)
            } else {
                error
            });
        }
        serde_json::from_value(value).map_err(|_| {
            after_dispatch(RemoteError::invalid("Invalid Remote HTTP response schema"))
        })
    }
}
