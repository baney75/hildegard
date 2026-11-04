// SPDX-License-Identifier: AGPL-3.0-only
// Preloaded (NODE_OPTIONS=--require) by inflight.fixture.ts: holds a Node process for five seconds before it runs, so
// `hildegard start` is still going, and its server not yet started, when the fixture's test times out.
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
