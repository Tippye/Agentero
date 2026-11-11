# DSH Remote protocol attribution

This module's Noise prologue, v1 envelopes, secure fragment codec and conformance fixtures are adapted from [liguobao/ds-harness-remote](https://github.com/liguobao/ds-harness-remote), commit `11064af` (0.6.4), specifically `packages/crypto/src/noise.ts`, `packages/protocol/src/index.ts`, `packages/webrtc/src/index.ts`, and `fixtures/crypto/v1` / `fixtures/protocol/v1`. The Typert unary/stream carrier, native workspace/session mappings, event ownership, timed-question claim lifecycle and workspace upload mapping also adapt `packages/client-core/src/remote-gateway.ts`, `harness-alpha-client.ts`, `harness-questions.ts`, `packages/plugin/src/remote-session-tools.ts`, and `remote-file-upload.ts`. The original crypto/envelope/relay fixed vectors are retained unchanged; `fixtures/native-typert.json` is an additional source-grounded adapter fixture assembled here. Cryptographic operations use the maintained Rust `snow` implementation. No DSH Go code is included.

MIT License

Copyright (c) 2026 DSH Remote contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
