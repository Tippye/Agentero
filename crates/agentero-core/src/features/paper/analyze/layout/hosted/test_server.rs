//! Minimal real HTTP fixture; never connects to a provider or reads credentials.
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub(super) struct Server {
    pub base: String,
    requests: Arc<Mutex<Vec<String>>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Server {
    pub fn new(replies: Vec<(&'static str, &'static str, u16, &'static str)>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let origin = base.clone();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let seen = requests.clone();
        let thread = std::thread::spawn(move || {
            for (method, path, status, body) in replies {
                let started = Instant::now();
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(
                                started.elapsed() < Duration::from_secs(10),
                                "missing {method} {path}"
                            );
                            std::thread::sleep(Duration::from_millis(1));
                        }
                        Err(error) => panic!("fixture accept: {error}"),
                    }
                };
                // Darwin accept can inherit the listener's O_NONBLOCK flag.
                // A read timeout does not clear it; otherwise a request whose
                // headers arrive just after accept fails with EWOULDBLOCK.
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(10)))
                    .unwrap();
                let mut bytes = Vec::new();
                let header_end = loop {
                    let mut chunk = [0; 4096];
                    let size = stream.read(&mut chunk).unwrap();
                    assert!(size > 0);
                    bytes.extend_from_slice(&chunk[..size]);
                    if let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                        break end + 4;
                    }
                };
                let headers = String::from_utf8_lossy(&bytes[..header_end]);
                let request = headers.lines().next().unwrap().to_string();
                seen.lock().unwrap().push(request.clone());
                assert!(
                    request.starts_with(&format!("{method} {path} ")),
                    "{request}"
                );
                let length = headers
                    .lines()
                    .find_map(|line| {
                        let (key, value) = line.split_once(':')?;
                        key.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                while bytes.len() - header_end < length {
                    let mut chunk = [0; 4096];
                    let size = stream.read(&mut chunk).unwrap();
                    assert!(size > 0);
                    bytes.extend_from_slice(&chunk[..size]);
                }
                if status == 0 {
                    // This point is reached only after the complete HTTP request
                    // was consumed: simulate response loss, not admission failure.
                    stream.shutdown(std::net::Shutdown::Both).unwrap();
                    drop(stream);
                    continue;
                }
                let body = body.replace("$BASE", &origin);
                write!(stream, "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        Self {
            base,
            requests,
            thread: Some(thread),
        }
    }

    pub fn finish(mut self, expected: usize) {
        self.thread.take().unwrap().join().unwrap();
        assert_eq!(self.requests.lock().unwrap().len(), expected);
    }
}
