# Go live

Stream your screen, camera and microphone to YouTube, X, Twitch, Kick or any RTMP server from Hildegard, to several at
once, with scenes, a lower third and a recording. The page is **Go live** in the Studio. Nothing leaves your computer
until you press the button.

## What you need

- **FFmpeg** on your PATH (or `HILDEGARD_FFMPEG=/path/to/ffmpeg`). `brew install ffmpeg` on a Mac,
  `winget install Gyan.FFmpeg` on Windows, the `ffmpeg` package on Linux (the `.deb` recommends it). **Check everything**
  tells you if it is missing.
- A stream key from each service you stream to. Go live says where to find it. It goes into your keychain.
- Optional: OBS Studio, if you would rather use it ([below](#use-obs-instead)).

## The first time

1. Open **Go live**. Pick a screen, a camera and a microphone (or the **Test pattern**, which checks a key or a
   connection without showing anything of yours).
2. Turn on a destination and paste its **stream key** into the password box. X, Kick and Custom also want the server
   address the service shows next to the key.
3. **Check everything** looks at FFmpeg, the encoder, each device (it opens each for one frame, so macOS asks for
   permission now rather than mid-stream), whether each server answers, and your upload speed.
4. **Go live** counts down five seconds (**Cancel** works), then streams. **Stop** is always there and always works.

## What it sends

| | |
| --- | --- |
| Video | H.264, constant bit rate, a keyframe every 2 seconds. Hardware encoder when one works (NVENC, VideoToolbox, Quick Sync, VA-API, AMF), otherwise x264 `veryfast`. |
| Audio | AAC, 160 kbps, 48 kHz, stereo. Silence if no microphone is on, because Twitch and others want an audio track. |
| Quality | 720p30 (4 Mbps), 1080p30 (6 Mbps), 1080p60 (9 Mbps), held under the lowest limit of the places you stream to. Kick is held to 8 Mbps. |
| Scenes | Screen, Camera, Camera over screen (corner and size), Starting soon, Be right back. Switch them while live. A lower third, a caption and a logo sit over any scene. |
| Several places | One encode, written to every destination and the recording at once (FFmpeg's `tee` muxer, `onfail=ignore`). A destination that fails does not stop the others. If every destination is lost, Hildegard waits 2, 4, 8, 15 and 30 seconds and tries again. |
| Recording | **Keep a copy** writes an MKV beside the stream, in the data folder under `stream/recordings`. |

Encoders are tried, not trusted: an FFmpeg build can list NVENC on a computer with no NVIDIA card, so a hardware encoder
counts only after it encodes a few frames. **Processor** in the encoder setting skips the check.

## Where each service's address comes from

| Service | Server | Notes |
| --- | --- | --- |
| YouTube Live | `rtmps://a.rtmps.youtube.com:443/live2` | Studio, Create, Go live, Stream. |
| X | the URL X Live Studio shows | RTMPS. |
| Twitch | `rtmps://ingest.global-contribute.live-video.net:443/app` | Change it to a nearer ingest from Twitch's list if you like. |
| Kick | the URL your Kick dashboard shows | RTMPS, H.264 only, about 8 Mbps at most. |
| Custom | yours | `rtmp://` or `rtmps://`, one application name (`/live`), no key in it. |

## Stream keys

A key is typed into a password box, goes to the keychain (a 0600 file where there is none, like Hugging Face's token),
and is never sent back: no route, tool or log returns it. FFmpeg never has it either. FFmpeg's `ps` line, its
`/proc/<pid>/cmdline` and its environment would show anything it was given, and FFmpeg cannot read its address from a
file, a descriptor or the environment (tried: `-/option file` does not reach protocol options). So each destination gets a relay
on `127.0.0.1` (`apps/server/src/stream-relay.ts`). FFmpeg publishes to it under a random stand-in exactly as long as
the key. The relay carries the connection to the service, over TLS for `rtmps://` (certificate checked), and swaps the
real key in on the three RTMP messages that carry the stream name. Lengths are equal, so nothing else shifts and the rest
of the stream is a plain byte pipe. The relay serves one connection, FFmpeg's, and closes.

`apps/server/test/stream.test.ts` streams ten seconds to a service that checks the key and proves the key reached it,
the stand-in did not, and the key is in no command line, environment, log, API answer or file.

## Who can start a stream

Only the person at the computer Hildegard runs on, in the Studio. Starting uses that computer's screen, camera and
microphone and sends the key somewhere, so:

- An AI app gets `stream_status` (is the owner live, how is it going; no keys, devices or addresses). `stream_start`
  and `stream_stop` return `needs-owner` and make no request. The server refuses the same calls from any request
  carrying an app's identity, even from this computer.
- The owner signed in on another device can switch scenes, mute, change the lower third and caption, and Stop. Setup, the
  preview, devices, keys and OBS are for this computer.
- Directors cannot reach any of it.

This is a rule about the Hildegard API and its MCP. A program running as you on this computer can call the same loopback
API you can, as it can for every other Hildegard feature.

## Use OBS instead

If OBS Studio is running with its WebSocket server on (Tools, WebSocket Server Settings; port 4455), Go live shows an
**OBS Studio** section: its scenes, switching them, starting and stopping its stream, and **Send OBS to** a destination
you have saved a key for, which sets OBS's stream service. If OBS has a password, Hildegard asks for it once and keeps it
in the keychain. Nothing is installed or changed in OBS other than what you press.

## Permissions

- **macOS.** Camera, Microphone and Screen Recording each ask once, with the words in
  `apps/desktop/src-tauri/Info.plist`. If you said no, turn Hildegard on in System Settings, Privacy & Security, then quit
  and reopen it. Screen Recording takes effect only after a restart of the app.
- **Windows.** Settings, Privacy & security: let desktop apps use the camera and microphone. The whole desktop is
  captured with `gdigrab`.
- **Linux.** Screen capture uses X11 (`x11grab`). On a Wayland session it sees only X11 apps, and Go live says so; sign in
  with an X11 session or use OBS. Cameras are `/dev/video*` (your user needs the `video` group). Microphones come from
  PulseAudio or PipeWire.

## Tests

`pnpm --filter @hildegard/server exec vitest run test/stream.test.ts test/stream-unit.test.ts` (FFmpeg on PATH for the
first). Sources are FFmpeg's test pattern and a sine tone, since CI has no camera. The ten-second stream is measured
at the server: bit rate within 15% of the target, a keyframe every 2 seconds, sound and picture within 100 ms from start
to end, and zero dropped frames on a quiet computer (the check relaxes when the machine's load is high). Tests use the
software encoder and never touch a video card.
