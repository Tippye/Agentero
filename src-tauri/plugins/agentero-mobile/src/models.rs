use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum BackgroundPlatform {
    Desktop,
    Android,
    Ios,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum NotificationPermission {
    Prompt,
    Granted,
    Denied,
}

/// OS capability and observed state; permission does not imply a running service.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackgroundState {
    pub platform: BackgroundPlatform,
    pub persistent_connection: bool,
    pub finite_tasks: bool,
    pub background_transfer: bool,
    pub enabled: bool,
    pub foreground: bool,
    pub notification_permission: NotificationPermission,
    pub notifications_enabled: bool,
    pub battery_optimization_ignored: Option<bool>,
    pub agent_active: bool,
    pub sync_active: bool,
    pub finite_task_active: bool,
    pub finite_task_expired: bool,
}
impl BackgroundState {
    pub fn unsupported(platform: BackgroundPlatform) -> Self {
        Self {
            platform,
            persistent_connection: false,
            finite_tasks: false,
            background_transfer: false,
            enabled: false,
            foreground: true,
            notification_permission: NotificationPermission::Denied,
            notifications_enabled: false,
            battery_optimization_ignored: None,
            agent_active: false,
            sync_active: false,
            finite_task_active: false,
            finite_task_expired: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackgroundCounts {
    /// Process-wide monotonic decimal u64; native adapters reject stale applies.
    pub generation: String,
    pub agent_count: u32,
    pub sync_count: u32,
    pub transfer_count: u32,
}
impl Default for BackgroundCounts {
    fn default() -> Self {
        Self {
            generation: "0".into(),
            agent_count: 0,
            sync_count: 0,
            transfer_count: 0,
        }
    }
}
impl BackgroundCounts {
    pub fn is_empty(&self) -> bool {
        self.agent_count == 0 && self.sync_count == 0 && self.transfer_count == 0
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum BackgroundSettingsTarget {
    Battery,
    Notifications,
    App,
}
