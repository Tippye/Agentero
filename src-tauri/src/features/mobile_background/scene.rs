//! iPad scene activation is not an application-wide suspend signal.
use std::collections::HashSet;
use std::sync::Mutex;

struct Scenes {
    active: HashSet<String>,
    foreground: bool,
}
pub struct ForegroundScenes(Mutex<Scenes>);
impl ForegroundScenes {
    pub fn new(labels: impl IntoIterator<Item = String>) -> Self {
        Self(Mutex::new(Scenes {
            active: labels.into_iter().collect(),
            foreground: true,
        }))
    }
    /// Publish only aggregate transitions. Focus restoration also covers UIKit's
    /// didBecomeActive after interruptions that never enter the background.
    pub fn update(&self, label: &str, active: bool) -> Option<bool> {
        let mut scenes = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if active {
            scenes.active.insert(label.to_owned());
        } else {
            scenes.active.remove(label);
        }
        let foreground = !scenes.active.is_empty();
        if scenes.foreground == foreground {
            return None;
        }
        scenes.foreground = foreground;
        Some(foreground)
    }
}

#[cfg(test)]
mod tests {
    use super::ForegroundScenes;
    #[test]
    fn transient_resign_active_recovers_on_focus_without_enter_foreground() {
        let scenes = ForegroundScenes::new(["main".into()]);
        assert_eq!(scenes.update("main", false), Some(false));
        assert_eq!(scenes.update("main", true), Some(true));
        assert_eq!(scenes.update("main", true), None);
    }
    #[test]
    fn one_inactive_or_destroyed_scene_cannot_suspend_an_active_scene() {
        let scenes = ForegroundScenes::new(["main".into(), "comparison".into()]);
        assert_eq!(scenes.update("comparison", false), None);
        assert_eq!(scenes.update("comparison", false), None);
        assert_eq!(scenes.update("main", false), Some(false));
        assert_eq!(scenes.update("comparison", true), Some(true));
    }
    #[test]
    fn initialization_before_windows_still_publishes_first_suspend() {
        let scenes = ForegroundScenes::new([]);
        assert_eq!(scenes.update("main", false), Some(false));
        assert_eq!(scenes.update("main", true), Some(true));
    }
}
