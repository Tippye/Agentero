//! Native import executor, including the desktop mobile-preview surface. The
//! renderer may enqueue/cancel and observe; it never owns execution or completion.
use super::{LookupImportBatchArgs, LookupImportBatchResult};
use crate::core::error::AppError;
use crate::features::jobs::{JobCenter, RunOutcome, StartedJob};
use serde::Deserialize;
use std::path::{Component, Path};
use tauri::Manager;
use tokio_util::sync::CancellationToken;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LookupParams {
    native: bool,
    mode: String,
    texts: Vec<String>,
    #[serde(default)]
    translator_base_url: Option<String>,
    #[serde(default)]
    concurrency: Option<usize>,
}
fn invalid() -> AppError {
    AppError::domain(
        "mobile_import_invalid",
        "Native paper imports require a bounded identifier/title lookup request",
    )
}
fn params(value: Option<&serde_json::Value>) -> Result<LookupParams, AppError> {
    let parsed: LookupParams =
        serde_json::from_value(value.cloned().ok_or_else(invalid)?).map_err(|_| invalid())?;
    if !parsed.native
        || parsed.mode != "lookup"
        || parsed.texts.is_empty()
        || parsed.texts.len() > 32
        || parsed.texts.iter().any(|text| {
            text.trim().is_empty()
                || text.len() > 8192
                || crate::features::paper::scholar_api::identifiers::extract_skill_source(text)
                    .is_some()
        })
        || parsed
            .translator_base_url
            .as_ref()
            .is_some_and(|base| base.len() > 4096)
        || parsed.concurrency.is_some_and(|count| count > 32)
    {
        return Err(invalid());
    }
    Ok(parsed)
}
pub(crate) fn validate(value: Option<&serde_json::Value>, parent: &str) -> Result<(), AppError> {
    params(value)?;
    if parent.is_empty()
        || parent.len() > 1024
        || parent.contains('\\')
        || !Path::new(parent)
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
    {
        return Err(invalid());
    }
    Ok(())
}

async fn collect_result(
    center: &JobCenter,
    job_id: &str,
    cancellation: &CancellationToken,
    work: impl std::future::Future<Output = Result<LookupImportBatchResult, AppError>>,
) -> RunOutcome {
    let result = tokio::select! { biased;
        _ = cancellation.cancelled() => return RunOutcome::Cancelled,
        result = work => result,
    };
    if cancellation.is_cancelled() {
        return RunOutcome::Cancelled;
    }
    match result {
        Ok(result) => {
            let only_errors = result.imported.is_empty()
                && result.search_candidates.is_empty()
                && !result.errors.is_empty();
            let error = result.errors.first().cloned();
            let result = match serde_json::to_value(result) {
                Ok(result) => result,
                Err(error) => return RunOutcome::Failed(Some(error.to_string())),
            };
            // Publish actual source flags and partial errors before the terminal
            // snapshot. A cancelled job ignores this merge and cannot resurrect.
            center
                .merge_running_job_params(job_id, serde_json::json!({"result": result}))
                .await;
            if cancellation.is_cancelled() {
                RunOutcome::Cancelled
            } else if only_errors {
                RunOutcome::Failed(error)
            } else {
                RunOutcome::Succeeded
            }
        }
        Err(error) => RunOutcome::Failed(Some(error.to_string())),
    }
}

pub(crate) fn import_runner(
    center: JobCenter,
    app: tauri::AppHandle,
    started: StartedJob,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
    if started.snapshot.host == crate::features::jobs::ExecHost::Renderer {
        return crate::features::jobs::renderer_offer_runner(center, app, started);
    }
    center.run_job(app, started, |center, app, started| async move {
        let parent = &started.paper_path;
        if let Err(error) = validate(started.snapshot.params.as_ref(), parent) {
            return RunOutcome::Failed(Some(error.to_string()));
        }
        let parsed = match params(started.snapshot.params.as_ref()) {
            Ok(parsed) => parsed,
            Err(error) => return RunOutcome::Failed(Some(error.to_string())),
        };
        let vault = match crate::features::paper::mobile::vault(
            &app,
            &started.vault_path.to_string_lossy(),
        ) {
            Ok(vault) => vault,
            Err(error) => return RunOutcome::Failed(Some(error.to_string())),
        };
        let args = LookupImportBatchArgs {
            vault_path: vault.to_string_lossy().into_owned(),
            parent_dir: parent.clone(),
            texts: parsed.texts,
            translator_base_url: parsed.translator_base_url,
            concurrency: parsed.concurrency.map(|count| count.min(4)),
            task_id: Some(started.snapshot.id.clone()),
        };
        if let Some(snapshot) = center
            .job_report(
                &started.snapshot.id,
                None,
                Some("Resolving metadata and downloading sources".into()),
                None,
                None,
            )
            .await
        {
            crate::features::jobs::emit_job_changed(&app, snapshot);
        }
        let cache = app.state::<crate::features::paper::catalog::CapsCache>();
        let host = crate::features::host_hooks::wrap(&app);
        let note_mode = super::note_mode_from_app(&app);
        let operation = crate::features::mobile_background::with_work(
            &app,
            crate::features::mobile_background::BackgroundReason::Transfer,
            async {
                let mut result =
                    super::import_by_identifier_batch(args, Some(&host), Some(&cache), note_mode)
                        .await?;
                // An explicitly retried import can encounter metadata committed
                // before cancellation. Recover missing sources through the same
                // downloader, without deleting or recreating a valid paper.
                for skipped in &result.skipped {
                    if skipped.reason != "already_in_library" {
                        continue;
                    }
                    let column = match skipped.kind.as_str() {
                        "arxiv" => "arxiv_id",
                        "doi" => "doi",
                        "pmid" => "pmid",
                        _ => continue,
                    };
                    let Some(paper) = crate::features::paper::catalog::papers::find_by_identifier(
                        &vault,
                        column,
                        &skipped.value,
                    )?
                    else {
                        continue;
                    };
                    if cache.caps_for(&vault, &paper.path).has_pdf() {
                        continue;
                    }
                    super::check_task_not_cancelled(Some(&started.snapshot.id))?;
                    match super::download_paper_assets_with_progress(
                        super::PaperDownloadAssetsArgs {
                            vault_path: vault.to_string_lossy().into_owned(),
                            path: paper.path.clone(),
                            task_id: Some(started.snapshot.id.clone()),
                        },
                        Some(&host),
                        Some(&cache),
                    )
                    .await
                    {
                        Ok(assets) if assets.pdf => {}
                        Ok(assets) => result.errors.push(format!(
                            "Source unavailable for {}: {}",
                            paper.id,
                            assets.messages.join("; ")
                        )),
                        Err(error) => result.errors.push(error.to_string()),
                    }
                    cache.invalidate(&vault, &paper.path);
                }
                Ok(result)
            },
        );
        collect_result(
            &center,
            &started.snapshot.id,
            &started.cancel_token,
            operation,
        )
        .await
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::jobs::{ExecHost, JobLane, JobState, StartOutcome};
    fn request() -> serde_json::Value {
        serde_json::json!({"native":true,"mode":"lookup","texts":["10.1234/example"],"concurrency":2})
    }
    fn result() -> LookupImportBatchResult {
        LookupImportBatchResult {
            imported: vec![],
            skills: vec![],
            skill_candidates: vec![],
            search_candidates: vec![],
            skipped: vec![],
            errors: vec!["source unavailable".into()],
        }
    }
    #[test]
    fn native_requests_reject_capability_escalation_and_parent_escape() {
        assert!(validate(Some(&request()), "papers/subdir").is_ok());
        for parent in [
            "",
            "/tmp",
            "../papers",
            "papers/../../escape",
            "papers\\..\\escape",
        ] {
            assert!(validate(Some(&request()), parent).is_err());
        }
        for patch in [
            serde_json::json!({"native":false}),
            serde_json::json!({"mode":"skill"}),
            serde_json::json!({"vaultPath":"/tmp"}),
            serde_json::json!({"taskId":"spoof"}),
            serde_json::json!({"texts":["https://github.com/owner/repo/tree/main/skills/test"]}),
        ] {
            let mut value = request();
            value
                .as_object_mut()
                .unwrap()
                .extend(patch.as_object().unwrap().clone());
            assert!(validate(Some(&value), "papers").is_err());
        }
    }
    #[tokio::test]
    async fn native_jobs_use_host_and_publish_result_only_after_work_settles() {
        let center = JobCenter::new();
        let dir = tempfile::tempdir().unwrap();
        let job = center
            .enqueue_import(
                dir.path(),
                "papers",
                JobLane::Normal,
                false,
                Some(request()),
            )
            .await;
        assert_eq!(job.host, ExecHost::Host);
        let StartOutcome::Started(started) = center.try_start(&job.id).await else {
            panic!("not started")
        };
        let (send, receive) = tokio::sync::oneshot::channel();
        let id = job.id.clone();
        let runner = center.clone();
        let task = tokio::spawn(async move {
            collect_result(&runner, &id, &started.cancel_token, async {
                receive.await.unwrap();
                Ok(result())
            })
            .await
        });
        assert!(center
            .snapshot(&job.id)
            .await
            .unwrap()
            .params
            .unwrap()
            .get("result")
            .is_none());
        send.send(()).unwrap();
        assert!(matches!(task.await.unwrap(), RunOutcome::Failed(_)));
        let saved = center.snapshot(&job.id).await.unwrap();
        assert_eq!(
            saved.params.unwrap()["result"]["errors"][0],
            "source unavailable"
        );
        assert_eq!(
            saved.vault_path,
            dir.path().canonicalize().unwrap().to_string_lossy()
        );
        assert_eq!(saved.paper_path.as_deref(), Some("papers"));
        #[cfg(desktop)]
        {
            let legacy = center
                .enqueue_import(
                    dir.path(),
                    "papers",
                    JobLane::Normal,
                    false,
                    Some(serde_json::json!({"mode":"lookup","texts":["legacy"]})),
                )
                .await;
            assert_eq!(legacy.host, ExecHost::Renderer);
        }
    }
    #[tokio::test]
    async fn cancellation_preserves_committed_files_and_cannot_publish_success_or_stall_retry() {
        let center = JobCenter::new();
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("committed-metadata");
        let job = center
            .enqueue_import(
                dir.path(),
                "papers",
                JobLane::Normal,
                false,
                Some(request()),
            )
            .await;
        let StartOutcome::Started(started) = center.try_start(&job.id).await else {
            panic!("not started")
        };
        std::fs::write(&marker, b"valid prior commit").unwrap();
        assert!(center.cancel(&job.id).await);
        let outcome = collect_result(
            &center,
            &job.id,
            &started.cancel_token,
            std::future::pending(),
        )
        .await;
        assert!(matches!(outcome, RunOutcome::Cancelled));
        assert_eq!(std::fs::read(marker).unwrap(), b"valid prior commit");
        let final_job = center.snapshot(&job.id).await.unwrap();
        assert_eq!(final_job.state, JobState::Cancelled);
        assert!(final_job.params.unwrap().get("result").is_none());
        let retry = center
            .enqueue_import(
                dir.path(),
                "papers",
                JobLane::Normal,
                false,
                Some(request()),
            )
            .await;
        assert_ne!(retry.id, job.id);
    }
}
