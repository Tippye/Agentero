use super::super::journal::{identity, Journal};
use super::super::test_server::Server;
use super::*;

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap()
}

#[tokio::test]
async fn cloud_receipt_reuses_batch_after_poll_failure() {
    let server = Server::new(vec![
        (
            "POST",
            "/api/v4/file-urls/batch",
            200,
            r#"{"code":0,"data":{"batch_id":"batch-1","file_urls":["$BASE/upload"]}}"#,
        ),
        ("PUT", "/upload", 200, ""),
        (
            "GET",
            "/api/v4/extract-results/batch/batch-1",
            500,
            r#"{"code":500,"msg":"temporary"}"#,
        ),
        (
            "GET",
            "/api/v4/extract-results/batch/batch-1",
            200,
            r#"{"code":0,"data":{"extract_result":[{"file_name":"paper.pdf","state":"done","full_zip_url":"$BASE/result"}]}}"#,
        ),
        ("GET", "/result", 200, "raw-zip"),
    ]);
    let root = tempfile::tempdir().unwrap();
    let key = identity(&[b"cloud-test"]);
    let credentials = HostedProviderCredentials::default();
    let client = client();
    let mut first = Journal::open_in(root.path().into(), key.clone())
        .await
        .unwrap();
    assert!(run_cloud_extract(
        &client,
        &server.base,
        "test",
        b"pdf".to_vec(),
        "paper.pdf",
        &credentials,
        &|_, _, _| {},
        &|| false,
        &mut first
    )
    .await
    .is_err());
    drop(first);
    let mut restored = Journal::open_in(root.path().into(), key).await.unwrap();
    assert_eq!(
        run_cloud_extract(
            &client,
            &server.base,
            "test",
            b"pdf".to_vec(),
            "paper.pdf",
            &credentials,
            &|_, _, _| {},
            &|| false,
            &mut restored
        )
        .await
        .unwrap(),
        b"raw-zip"
    );
    server.finish(5);
}

#[tokio::test]
async fn task_upload_failure_resumes_same_task_and_never_creates_second_task() {
    let server = Server::new(vec![
        (
            "POST",
            "/v1/tasks",
            200,
            r#"{"task_id":"task-1","files":[{"upload":{"url":"$BASE/upload","headers":{"X-Upload":"signed"}}}]}"#,
        ),
        ("PUT", "/upload", 500, "temporary"),
        ("PUT", "/upload", 200, ""),
        (
            "GET",
            "/v1/tasks/task-1",
            200,
            r#"{"status":"completed","files":[{"status":"completed","result_url":"$BASE/result"}]}"#,
        ),
        ("GET", "/result", 200, "raw-zip"),
    ]);
    let root = tempfile::tempdir().unwrap();
    let key = identity(&[b"task-test"]);
    let credentials = HostedProviderCredentials::default();
    let client = client();
    let mut first = Journal::open_in(root.path().into(), key.clone())
        .await
        .unwrap();
    assert!(run_task_extract(
        &client,
        &server.base,
        "test",
        b"pdf".to_vec(),
        "paper.pdf",
        &credentials,
        &|_, _, _| {},
        &|| false,
        &mut first
    )
    .await
    .is_err());
    drop(first);
    let mut restored = Journal::open_in(root.path().into(), key).await.unwrap();
    assert_eq!(
        run_task_extract(
            &client,
            &server.base,
            "test",
            b"pdf".to_vec(),
            "paper.pdf",
            &credentials,
            &|_, _, _| {},
            &|| false,
            &mut restored
        )
        .await
        .unwrap(),
        b"raw-zip"
    );
    server.finish(5);
}

#[tokio::test]
async fn lost_task_submit_response_is_durable_unknown_and_not_replayed() {
    let server = Server::new(vec![("POST", "/v1/tasks", 0, "")]);
    let root = tempfile::tempdir().unwrap();
    let key = identity(&[b"unknown-test"]);
    let credentials = HostedProviderCredentials::default();
    let client = client();
    let mut first = Journal::open_in(root.path().into(), key.clone())
        .await
        .unwrap();
    assert!(run_task_extract(
        &client,
        &server.base,
        "test",
        b"pdf".to_vec(),
        "paper.pdf",
        &credentials,
        &|_, _, _| {},
        &|| false,
        &mut first
    )
    .await
    .is_err());
    drop(first);
    let mut restored = Journal::open_in(root.path().into(), key).await.unwrap();
    let error = run_task_extract(
        &client,
        &server.base,
        "test",
        b"pdf".to_vec(),
        "paper.pdf",
        &credentials,
        &|_, _, _| {},
        &|| false,
        &mut restored,
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("unknown"));
    server.finish(1);
}

#[tokio::test]
async fn legacy_receipt_resumes_known_task_without_post() {
    let server = Server::new(vec![
        ("GET", "/tasks/legacy-1", 200, r#"{"status":"done"}"#),
        ("GET", "/tasks/legacy-1/result", 200, "raw-zip"),
    ]);
    let root = tempfile::tempdir().unwrap();
    let mut journal = Journal::open_in(root.path().into(), identity(&[b"legacy-test"]))
        .await
        .unwrap();
    journal
        .save("legacy-poll", json!({"id":"legacy-1"}))
        .unwrap();
    assert_eq!(
        run_legacy_extract(
            &client(),
            &server.base,
            "test",
            b"pdf".to_vec(),
            "paper.pdf",
            &HostedProviderCredentials::default(),
            &|_, _, _| {},
            &|| false,
            &mut journal
        )
        .await
        .unwrap(),
        b"raw-zip"
    );
    server.finish(2);
}

#[tokio::test]
async fn v1_receipt_resumes_parse_job_without_upload_or_submit() {
    let server = Server::new(vec![
        (
            "GET",
            "/v1/parse/jobs/job-1",
            200,
            r#"{"status":"completed","files":[{"status":"completed","output_files":{"zip":{"file_id":"zip-1"}}}]}"#,
        ),
        ("GET", "/v1/files/zip-1/content", 200, "raw-zip"),
    ]);
    let root = tempfile::tempdir().unwrap();
    let mut journal = Journal::open_in(root.path().into(), identity(&[b"v1-test"]))
        .await
        .unwrap();
    journal.save("v1-poll", json!({"id":"job-1"})).unwrap();
    assert_eq!(
        run_v1_extract(
            &client(),
            &server.base,
            "test",
            b"pdf".to_vec(),
            "paper.pdf",
            &HostedProviderCredentials::default(),
            &|_, _, _| {},
            &|| false,
            &mut journal
        )
        .await
        .unwrap(),
        b"raw-zip"
    );
    server.finish(2);
}

#[test]
fn upload_receipts_do_not_persist_api_authentication() {
    let headers = json!({"Authorization":"Bearer secret", "X-API-Key":"secret", "custom":"secret", "X-Upload":"signed-value"});
    let saved = private_upload_headers(Some(&headers), "Bearer secret");
    assert_eq!(saved, json!({"X-Upload":"signed-value"}));
}
