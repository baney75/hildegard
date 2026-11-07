// SPDX-License-Identifier: AGPL-3.0-only
// Go live, the parts that need no FFmpeg: the key relay's byte swap (including a stream name split across chunks),
// the plan's command line, device lists, OBS, and who may call which route.
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_STREAM_SETTINGS,
  IngestServer,
  STREAM_DESTINATIONS,
  StreamSettings,
} from '@hildegard/presets';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { directorMay, type HgEnv } from '../src/access.ts';
import { explainFfmpeg, JpegSplitter, parseProgress, Streamer, twitchIngest } from '../src/stream.ts';
import { parseAvfoundation, parseDshow, parsePactl } from '../src/stream-devices.ts';
import { Obs } from '../src/stream-obs.ts';
import {
  availableScenes,
  buildPlan,
  encoderArgs,
  filterValue,
  inputArgs,
  sceneCommand,
  streamKbps,
  teePath,
} from '../src/stream-plan.ts';
import { KeyPatcher, KeyRelay, standIn } from '../src/stream-relay.ts';
import { streamRoutes } from '../src/stream-routes.ts';
import { memoryStore } from './helpers.ts';

// ── RTMP bytes, made by hand ────────────────────────────────────────────────────────────────────────────────────

const amfStr = (s: string) =>
  Buffer.concat([Buffer.from([2, s.length >> 8, s.length & 255]), Buffer.from(s, 'latin1')]);
const amfNum = (n: number) => {
  const b = Buffer.alloc(9);
  b.writeDoubleBE(n, 1);
  return b;
};
const amfNull = () => Buffer.from([5]);
/** One RTMP message cut into chunks of `size`: a full header first, then one-byte continuation headers. */
function message(csid: number, type: number, payload: Buffer, size = 128, streamId = 0): Buffer {
  const head = Buffer.alloc(12);
  head[0] = csid;
  head.writeUIntBE(0, 1, 3);
  head.writeUIntBE(payload.length, 4, 3);
  head[7] = type;
  head.writeUInt32LE(streamId, 8);
  const out: Buffer[] = [head];
  for (let o = 0; o < payload.length; o += size) {
    if (o > 0) out.push(Buffer.from([0xc0 | csid]));
    out.push(payload.subarray(o, o + size));
  }
  return Buffer.concat(out);
}
const handshake = () => randomBytes(1 + 1536 + 1536);
const command = (...parts: Buffer[]) => Buffer.concat(parts);
const connectCmd = (app: string) =>
  command(
    amfStr('connect'),
    amfNum(1),
    Buffer.concat([Buffer.from([3]), amfStr('app').subarray(1), amfStr(app), Buffer.from([0, 0, 9])]),
  );

/** What FFmpeg sends before it streams: connect, releaseStream, FCPublish, createStream, publish. */
function clientSession(stand: string, chunk = 128) {
  const parts = [
    handshake(),
    message(3, 20, connectCmd('live'), chunk),
    message(3, 20, command(amfStr('releaseStream'), amfNum(2), amfNull(), amfStr(stand)), chunk),
    message(3, 20, command(amfStr('FCPublish'), amfNum(3), amfNull(), amfStr(stand)), chunk),
    message(3, 20, command(amfStr('createStream'), amfNum(4), amfNull()), chunk),
    message(3, 20, command(amfStr('publish'), amfNum(5), amfNull(), amfStr(stand), amfStr('live')), chunk, 1),
  ];
  const media = randomBytes(5000);
  return { parts, media, whole: Buffer.concat([...parts, media]) };
}

/** Feeds `whole` through a patcher in pieces of the given sizes. */
function through(p: KeyPatcher, whole: Buffer, sizes: number[]): Buffer {
  const out: Buffer[] = [];
  let i = 0;
  for (let k = 0; i < whole.length; k++) {
    const n = sizes[k % sizes.length]!;
    out.push(...p.push(whole.subarray(i, i + n)));
    i += n;
  }
  out.push(...p.flush());
  return Buffer.concat(out);
}

describe('the key relay’s swap', () => {
  const key = 'live_93847261_aB3dEfGhIjKlMnOpQrStUvWxYz0123456789'; // 49 characters, longer than a chunk's tail
  it('replaces the stand-in with the key in the three messages that carry it, and touches nothing else', () => {
    const stand = standIn(key.length);
    const { whole, media } = clientSession(stand);
    for (const sizes of [[whole.length], [1], [7, 130, 3], [128, 129], [4096], [17]]) {
      const p = new KeyPatcher(stand, key);
      const out = through(p, whole, sizes);
      expect(out.length).toBe(whole.length);
      expect(out.includes(Buffer.from(stand))).toBe(false);
      expect(p.patched).toBe(3);
      expect(p.published).toBe(true);
      expect(p.mode).toBe('raw');
      // Everything but the stand-in's places is the same, byte for byte, and the media is untouched.
      expect(out.subarray(out.length - media.length).equals(media)).toBe(true);
      // A key split by chunk headers is not found whole, so compare by what changed instead.
      let changed = 0;
      for (let i = 0; i < out.length; i++) if (out[i] !== whole[i]) changed++;
      expect(changed).toBeGreaterThan(0);
      expect(changed).toBeLessThanOrEqual(key.length * 3);
    }
  });

  it('finds a stand-in wherever it falls against a chunk boundary, and keeps the chunk headers between its halves', () => {
    const stand = standIn(key.length);
    // Slide the stand-in across a 128-byte boundary, one byte at a time, so every split is tried.
    for (let pad = 0; pad < 140; pad++) {
      const cmd = command(amfStr('FCPublish'), amfNum(3), amfNull(), amfStr('x'.repeat(pad)), amfStr(stand));
      const wire = Buffer.concat([
        handshake(),
        message(3, 20, cmd),
        message(
          3,
          20,
          command(amfStr('publish'), amfNum(5), amfNull(), amfStr(stand), amfStr('live')),
          128,
          1,
        ),
      ]);
      const p = new KeyPatcher(stand, key);
      const out = through(p, wire, [33]);
      expect(out.includes(Buffer.from(stand)), `pad ${pad}`).toBe(false);
      expect(out.length).toBe(wire.length);
      expect(p.patched, `pad ${pad}`).toBe(2);
      expect(p.published).toBe(true);
      // Read the swapped message back through its chunks: the key is where the stand-in was.
      const text = out.toString('latin1');
      expect(text.replaceAll(/\xc3/g, '')).toContain(key);
    }
  });

  it('follows a chunk size change and still finds the stand-in', () => {
    const stand = standIn(key.length);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(4096);
    const wire = Buffer.concat([
      handshake(),
      message(2, 1, size),
      message(3, 20, connectCmd('live'), 4096),
      message(
        3,
        20,
        command(
          amfStr('publish'),
          amfNum(5),
          amfNull(),
          amfStr('y'.repeat(300)),
          amfStr(stand),
          amfStr('live'),
        ),
        4096,
        1,
      ),
      randomBytes(100),
    ]);
    const p = new KeyPatcher(stand, key);
    const out = through(p, wire, [200]);
    expect(out.includes(Buffer.from(stand))).toBe(false);
    expect(out.includes(Buffer.from(key))).toBe(true);
    expect(p.published).toBe(true);
  });

  it('never sends the key for a stream that isn’t RTMP: it stays a stand-in', () => {
    const stand = standIn(key.length);
    const junk = Buffer.concat([randomBytes(3073), Buffer.from([0xc7, 1, 2, 3])]);
    const p = new KeyPatcher(stand, key);
    const out = through(p, junk, [64]);
    expect(out.equals(junk)).toBe(true);
    expect(p.mode).toBe('raw');
  });

  it('refuses a stand-in and a key of different lengths', () => {
    expect(() => new KeyPatcher('abc', 'abcd')).toThrow();
  });

  it('makes stand-ins of the key’s length that differ every time', () => {
    const a = standIn(40);
    expect(a).toHaveLength(40);
    expect(a).not.toBe(standIn(40));
    expect(a).toMatch(/^[A-Za-z0-9]+$/);
  });
});

describe('the relay on a socket', () => {
  /** A stand-in service: records what it is sent, answers the publish with a status. */
  async function service() {
    const got: Buffer[] = [];
    const server = net.createServer((s) => {
      s.on('data', (d) => {
        got.push(d);
        s.write(Buffer.from('onStatus NetStream.Publish.Start'));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { port: (server.address() as net.AddressInfo).port, got, server };
  }
  const connect = (port: number) => (_h: string, _p: number, _s: boolean) =>
    net.connect({ host: '127.0.0.1', port });
  const key = 'abcdEFGH12345678abcdEFGH12345678';

  it('hands the service the key and FFmpeg only the stand-in, then goes live when the service says so', async () => {
    const svc = await service();
    const events: string[] = [];
    const relay = new KeyRelay({
      server: 'rtmp://ingest.example/live',
      key,
      connect: connect(svc.port),
      onEvent: (e) => events.push(e.type),
    });
    const { port, url } = await relay.listen();
    expect(url).toBe(`rtmp://127.0.0.1:${port}/live/${relay.stand}`);
    expect(url).not.toContain(key);
    const c = net.connect({ host: '127.0.0.1', port });
    const fromService: Buffer[] = [];
    c.on('data', (d) => fromService.push(d));
    c.write(clientSession(relay.stand).whole);
    await new Promise((r) => setTimeout(r, 300));
    expect(Buffer.concat(svc.got).includes(Buffer.from(key))).toBe(true);
    expect(Buffer.concat(svc.got).includes(Buffer.from(relay.stand))).toBe(false);
    expect(relay.isLive).toBe(true);
    expect(events).toContain('live');
    expect(Buffer.concat(fromService).toString()).toContain('Publish.Start');
    // A second connection to the same port finds nobody listening: the relay serves FFmpeg alone.
    await expect(
      new Promise((res, rej) =>
        net.connect({ host: '127.0.0.1', port }).once('connect', res).once('error', rej),
      ),
    ).rejects.toBeTruthy();
    c.destroy();
    await new Promise((r) => setTimeout(r, 100));
    expect(events.at(-1)).toBe('closed');
    svc.server.close();
  });

  it('says why when the service turns the stream down', async () => {
    const server = net.createServer((s) => {
      s.on('data', () => {
        s.write(Buffer.from('onStatus NetStream.Publish.BadName'));
        s.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    const seen: { type: string; reason?: string; rejected?: boolean }[] = [];
    const relay = new KeyRelay({
      server: 'rtmp://x/live',
      key,
      connect: connect(port),
      onEvent: (e) => seen.push(e),
    });
    const l = await relay.listen();
    const c = net.connect({ host: '127.0.0.1', port: l.port });
    c.write(clientSession(relay.stand).whole);
    await new Promise((r) => setTimeout(r, 300));
    const closed = seen.find((e) => e.type === 'closed');
    expect(closed?.rejected).toBe(true);
    expect(closed?.reason).toMatch(/stream key/);
    c.destroy();
    server.close();
  });

  it('sends nothing to a server whose TLS can’t be verified, and reports it', async () => {
    const got: Buffer[] = [];
    const server = net.createServer((s) => {
      s.on('data', (d) => {
        got.push(d);
        s.destroy();
      });
      s.on('error', () => {});
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    const seen: { type: string; reason?: string }[] = [];
    // rtmps:// to a server that doesn't speak TLS: the default connect is used, with certificate checks on.
    const relay = new KeyRelay({
      server: `rtmps://127.0.0.1:${port}/live`,
      key,
      onEvent: (e) => seen.push(e),
      timeoutMs: 1500,
    });
    const l = await relay.listen();
    const c = net.connect({ host: '127.0.0.1', port: l.port });
    c.on('error', () => {});
    c.write(clientSession(relay.stand).whole);
    await new Promise((r) => setTimeout(r, 800));
    expect(Buffer.concat(got).includes(Buffer.from(key))).toBe(false);
    expect(seen.some((e) => e.type === 'closed')).toBe(true);
    c.destroy();
    server.close();
  });

  it('refuses a key that has spaces or is too short, without echoing it', () => {
    for (const bad of ['short', 'has a space in it', 'tab\tinside12345']) {
      let msg = '';
      try {
        new KeyRelay({ server: 'rtmp://x/live', key: bad, onEvent: () => {} });
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).not.toBe('');
      expect(msg).not.toContain(bad);
    }
  });
});

// ── The plan ────────────────────────────────────────────────────────────────────────────────────────────────────

const settings = (over: Record<string, unknown> = {}) =>
  StreamSettings.parse({
    ...DEFAULT_STREAM_SETTINGS,
    sources: { screen: 'test', camera: 'test', mic: 'test' },
    ...over,
  });
const base = {
  platform: 'linux' as const,
  encoder: 'libx264' as const,
  rtmp: [{ id: 'youtube', url: 'rtmp://127.0.0.1:1/live/AAAAAAAAAAAAAAAA' }],
  recordFile: null,
  textDir: '/tmp/t',
  font: '/usr/share/fonts/x.ttf',
  progressPort: 5,
  preview: true,
};

describe('the plan', () => {
  it('asks for what every service asks for: CBR, a keyframe every two seconds, AAC 160k at 48 kHz', () => {
    const a = buildPlan({ ...base, settings: settings({ quality: '1080p30' }) });
    const j = a.args.join(' ');
    expect(a.kbps).toBe(6000);
    expect(j).toContain('-b:v 6000k -minrate 6000k -maxrate 6000k -bufsize 12000k');
    expect(j).toContain('-g 60 -keyint_min 60 -sc_threshold 0');
    expect(j).toContain('nal-hrd=cbr');
    expect(j).toContain('-c:a aac -b:a 160k -ar 48000 -ac 2');
    expect(j).toContain('-flags +global_header');
    const sixty = buildPlan({ ...base, settings: settings({ quality: '1080p60' }) });
    expect(sixty.args.join(' ')).toContain('-g 120');
  });

  it('holds the bit rate under every chosen service’s ceiling', () => {
    const kick = STREAM_DESTINATIONS.find((d) => d.id === 'kick')!;
    expect(kick.maxKbps).toBeLessThanOrEqual(8000);
    expect(streamKbps('1080p60', ['kick'])).toBeLessThanOrEqual(8000);
    expect(streamKbps('1080p60', ['twitch', 'kick'])).toBe(6000);
    expect(streamKbps('1080p30', ['youtube'])).toBe(6000);
    expect(streamKbps('720p30', ['youtube', 'x'])).toBe(4000);
    expect(streamKbps('1080p30', ['custom'], 2000)).toBe(2000);
  });

  it('writes every destination and the recording into one tee, and lets one fail without the others', () => {
    const two = buildPlan({
      ...base,
      settings: settings(),
      rtmp: [
        { id: 'youtube', url: 'rtmp://127.0.0.1:1/live/AAAA' },
        { id: 'twitch', url: 'rtmp://127.0.0.1:2/app/BBBB' },
      ],
      recordFile: '/tmp/rec/a|b.mkv',
    });
    const tee = two.args[two.args.indexOf('tee') + 1]!;
    expect(tee.split('|').length).toBe(4); // two destinations, a recording, and the escaped bar in its name
    expect(tee).toContain('[f=flv:flvflags=no_duration_filesize:onfail=ignore]rtmp://127.0.0.1:1/live/AAAA');
    expect(tee).toContain('[f=matroska:onfail=ignore]/tmp/rec/a\\|b.mkv');
    const one = buildPlan({ ...base, settings: settings() });
    expect(one.args[one.args.indexOf('tee') + 1]).toContain('onfail=abort');
  });

  it('never puts anything but the relay’s address and stand-in in the command', () => {
    const p = buildPlan({
      ...base,
      settings: settings({ lowerThird: { on: true, name: 'Ada', title: 'Host' } }),
    });
    const j = p.args.join(' ');
    expect(j).not.toMatch(/live_|sk_/);
    expect([...j.matchAll(/rtmps?:\/\/[^\s|]+/g)].every((m) => m[0].startsWith('rtmp://127.0.0.1:'))).toBe(
      true,
    );
  });

  it('builds a graph for every scene, one switch for all of them', () => {
    const s = settings();
    expect(availableScenes(s)).toEqual(['screen', 'camera', 'pip', 'starting', 'brb']);
    expect(availableScenes(settings({ sources: { screen: null, camera: null, mic: null } }))).toEqual([
      'starting',
      'brb',
    ]);
    expect(availableScenes(settings({ sources: { screen: 'test', camera: null, mic: null } }))).toEqual([
      'screen',
      'starting',
      'brb',
    ]);
    const p = buildPlan({ ...base, settings: settings({ scene: 'brb' }) });
    expect(p.args.join(' ')).toContain('streamselect@scene=inputs=5:map=4');
    expect(sceneCommand(p.scenes, 'camera')).toBe('cstreamselect@scene -1 map 1\n');
    expect(sceneCommand(['screen'], 'brb')).toBeNull();
  });

  it('refuses a scene whose source isn’t there, in words', () => {
    expect(() =>
      buildPlan({
        ...base,
        settings: settings({ scene: 'pip', sources: { screen: 'test', camera: null, mic: null } }),
      }),
    ).toThrow(/screen and a camera/);
  });

  it('puts the camera in the corner asked for, at the size asked for', () => {
    const at = (corner: string) =>
      buildPlan({ ...base, settings: settings({ scene: 'pip', pip: { corner, size: 30 } }) }).args.join(' ');
    expect(at('tl')).toContain('overlay=x=48:y=48');
    expect(at('br')).toContain('overlay=x=W-w-48:y=H-h-48');
    expect(at('br')).toContain('scale=576:-2'); // 30% of the 1920-wide picture
  });

  it('leaves out text when there is no font, and a logo only if it is a picture', () => {
    const none = buildPlan({
      ...base,
      font: null,
      settings: settings({ lowerThird: { on: true, name: 'A', title: 'B' } }),
    });
    expect(none.args.join(' ')).not.toContain('drawtext');
    const logo = buildPlan({ ...base, settings: settings({ logo: '/home/me/logo.png' }) });
    expect(logo.args.join(' ')).toContain('-loop 1');
    const notPic = buildPlan({ ...base, settings: settings({ logo: '/home/me/logo.exe' }) });
    expect(notPic.args.join(' ')).not.toContain('logo.exe');
  });

  it('opens no microphone for a preview alone', () => {
    const p = buildPlan({ ...base, rtmp: [], settings: settings() });
    expect(p.args.join(' ')).not.toContain('sine');
    expect(p.args).not.toContain('tee');
    expect(p.args.join(' ')).toContain('image2pipe');
  });

  it('escapes paths for the filter graph and the tee', () => {
    expect(filterValue("C:\\Windows\\Fonts\\a'b.ttf")).toBe(
      "C\\\\:\\\\\\\\Windows\\\\\\\\Fonts\\\\\\\\a\\\\\\'b.ttf",
    );
    expect(teePath("/a/b|c'd.mkv")).toBe("/a/b\\|c\\'d.mkv");
  });

  it('captures with each system’s own devices', () => {
    const ctx = (platform: NodeJS.Platform) => ({
      platform,
      width: 1920,
      height: 1080,
      fps: 30,
      env: { DISPLAY: ':1' },
    });
    expect(inputArgs('screen', 'x11', ctx('linux'))).toEqual(expect.arrayContaining(['x11grab', ':1']));
    expect(inputArgs('camera', '/dev/video0', ctx('linux'))!.join(' ')).toContain(
      '-f v4l2 -input_format mjpeg -framerate 30 -video_size 1920x1080 -i /dev/video0',
    );
    expect(inputArgs('mic', 'default', ctx('linux'))!.join(' ')).toContain('-f pulse -i default');
    expect(inputArgs('screen', 'avf:1', ctx('darwin'))!.join(' ')).toContain('-f avfoundation');
    expect(inputArgs('screen', 'avf:1', ctx('darwin'))!.at(-1)).toBe('1:none');
    expect(inputArgs('mic', 'avf:0', ctx('darwin'))!.at(-1)).toBe('none:0');
    expect(inputArgs('screen', 'desktop', ctx('win32'))!.join(' ')).toContain('-f gdigrab');
    expect(inputArgs('camera', 'dshow:Logi Cam', ctx('win32'))!.at(-1)).toBe('video=Logi Cam');
    expect(inputArgs('mic', null, ctx('linux'))).toBeNull();
    expect(inputArgs('mic', 'test', ctx('linux'))!.join(' ')).toContain('sine');
  });

  it('refuses device names that could be anything but a name', () => {
    const ctx = { platform: 'linux' as const, width: 1280, height: 720, fps: 30 };
    for (const bad of ['-f lavfi', 'a"b', 'a;b', 'a|b', 'a\nb', '']) {
      if (bad === '') expect(inputArgs('mic', '', ctx)).toBeNull();
      else expect(() => inputArgs('mic', bad, ctx)).toThrow();
    }
  });

  it('has a working argument list for each hardware encoder, ending in software', () => {
    for (const id of [
      'h264_nvenc',
      'h264_videotoolbox',
      'h264_qsv',
      'h264_vaapi',
      'h264_amf',
      'libx264',
    ] as const) {
      const e = encoderArgs(id, 6000, 30);
      expect(e.codec.join(' ')).toContain(`-c:v ${id}`);
      expect(e.codec.join(' ')).toContain('-g 60');
    }
    expect(encoderArgs('h264_vaapi', 6000, 30).filter).toBe('format=nv12,hwupload');
  });
});

describe('settings', () => {
  it('take only an RTMP address with an application name, and never a key in it', () => {
    for (const ok of [
      'rtmps://a.rtmps.youtube.com:443/live2',
      'rtmp://127.0.0.1:1935/live',
      'rtmps://x.example/app',
    ])
      expect(IngestServer.safeParse(ok).success, ok).toBe(true);
    for (const bad of [
      'https://x/live',
      'rtmp://x',
      'rtmp://x/',
      'rtmp://u:p@x/live',
      'rtmp://x/live?key=abc',
      'rtmp://x/live/KEY123',
      'rtmp://x/a|b',
      'rtmp://x/live/../k/x',
      'rtmp:///live',
      'ftp://x/live',
      'rtmp://x/live#k',
    ])
      expect(IngestServer.safeParse(bad).success, bad).toBe(false);
  });
});

describe('devices', () => {
  it('reads macOS’s list: screens are the “Capture screen” entries', () => {
    const t = `[AVFoundation indev @ 0x1] AVFoundation video devices:
[AVFoundation indev @ 0x1] [0] FaceTime HD Camera
[AVFoundation indev @ 0x1] [1] Capture screen 0
[AVFoundation indev @ 0x1] AVFoundation audio devices:
[AVFoundation indev @ 0x1] [0] MacBook Pro Microphone`;
    const r = parseAvfoundation(t);
    expect(r.video).toEqual([
      { id: 'avf:0', label: 'FaceTime HD Camera' },
      { id: 'avf:1', label: 'Capture screen 0' },
    ]);
    expect(r.audio).toEqual([{ id: 'avf:0', label: 'MacBook Pro Microphone' }]);
  });
  it('reads Windows’s list in both of FFmpeg’s layouts', () => {
    const modern = `[in#0 @ 0x1] "Integrated Camera" (video)\n[in#0 @ 0x1]   Alternative name "@device_pnp_x"\n[in#0 @ 0x1] "Microphone (Realtek)" (audio)`;
    expect(parseDshow(modern).video).toEqual([{ id: 'dshow:Integrated Camera', label: 'Integrated Camera' }]);
    expect(parseDshow(modern).audio).toEqual([
      { id: 'dshow:Microphone (Realtek)', label: 'Microphone (Realtek)' },
    ]);
    const old = `[dshow @ 0x1] DirectShow video devices\n[dshow @ 0x1]  "OBS Virtual Camera"\n[dshow @ 0x1] DirectShow audio devices\n[dshow @ 0x1]  "Line In"`;
    expect(parseDshow(old).video.map((d) => d.label)).toEqual(['OBS Virtual Camera']);
    expect(parseDshow(old).audio.map((d) => d.label)).toEqual(['Line In']);
  });
  it('lists microphones, not the speakers’ monitors', () => {
    const t = `55\talsa_output.pci.analog-stereo.monitor\tPipeWire\ts32le\tSUSPENDED\n56\talsa_input.usb-Blue_Yeti.analog-stereo\tPipeWire\ts16le\tRUNNING`;
    expect(parsePactl(t).map((d) => d.id)).toEqual(['alsa_input.usb-Blue_Yeti.analog-stereo']);
  });
});

describe('Twitch’s ingest list', () => {
  const list = {
    ingests: [
      { availability: 1, url_template_secure: 'rtmps://far.contribute.live-video.net/app/{stream_key}' },
      { availability: 0, url_template_secure: 'rtmps://down.contribute.live-video.net/app/{stream_key}' },
      { availability: 1, url_template_secure: 'rtmps://near.contribute.live-video.net:443/app/{stream_key}' },
      { availability: 1, url_template_secure: 'rtmp://insecure.example/app/{stream_key}?bandwidthtest=1' },
    ],
  };
  const fetchFn = (async () => new Response(JSON.stringify(list))) as unknown as typeof fetch;
  it('picks the nearest server that is up, without the key’s place in it', async () => {
    const ms: Record<string, number | null> = {
      'far.contribute.live-video.net': 90,
      'near.contribute.live-video.net': 12,
      'insecure.example': 1,
    };
    const pick = await twitchIngest(fetchFn, async (h) => ms[h] ?? null);
    expect(pick).toBe('rtmps://near.contribute.live-video.net:443/app');
    expect(IngestServer.safeParse(pick).success).toBe(true);
  });
  it('lets the default stand when Twitch can’t be asked or nothing answers', async () => {
    const offline = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await twitchIngest(offline)).toBeNull();
    expect(await twitchIngest(fetchFn, async () => null)).toBeNull();
    expect(
      await twitchIngest((async () => new Response('no', { status: 500 })) as unknown as typeof fetch),
    ).toBeNull();
  });
});

describe('small parts', () => {
  it('cuts a stream of JPEGs into pictures, however it arrives', () => {
    const jpg = (n: number) =>
      Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(n, 1), Buffer.from([0xff, 0xd9])]);
    const all = Buffer.concat([jpg(10), jpg(300), jpg(5)]);
    const s = new JpegSplitter();
    const got: Buffer[] = [];
    for (let i = 0; i < all.length; i += 7) got.push(...s.push(all.subarray(i, i + 7)));
    expect(got.map((g) => g.length)).toEqual([14, 304, 9]);
  });
  it('reads FFmpeg’s progress report', () => {
    const p = parseProgress(
      'frame=10\nfps=29.97\nbitrate=2100.5kbits/s\ndrop_frames=2\nspeed=0.98x\nprogress=continue',
    );
    expect(p.drop_frames).toBe('2');
    expect(p.speed).toBe('0.98x');
  });
  it('explains FFmpeg’s failures in words a person can act on', () => {
    expect(explainFfmpeg('Permission denied', 'darwin')).toMatch(/System Settings/);
    expect(explainFfmpeg('Device or resource busy', 'linux')).toMatch(/Another app/);
    expect(explainFfmpeg('Cannot open display :0', 'linux')).toMatch(/X11/);
    expect(explainFfmpeg('ffmpeg: not found', 'win32')).toMatch(/winget/);
    expect(explainFfmpeg('something odd', 'linux')).toMatch(/Show details/);
  });
});

// ── OBS, against a stand-in ─────────────────────────────────────────────────────────────────────────────────────

const sha = (s: string) => createHash('sha256').update(s).digest('base64');

/** An obs-websocket 5 server in memory. */
function fakeObs(password: string | null) {
  const log: { type: string; data: Record<string, unknown> | undefined }[] = [];
  const state = { scene: 'Main', streaming: false };
  class FakeSocket {
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    onclose: ((e: { code?: number }) => void) | null = null;
    private challenge = 'chal';
    private salt = 'salt';
    constructor(_url: string) {
      setTimeout(() => {
        const d: Record<string, unknown> = { obsWebSocketVersion: '5.5.0', rpcVersion: 1 };
        if (password) d.authentication = { challenge: this.challenge, salt: this.salt };
        this.emit({ op: 0, d });
      }, 0);
    }
    private emit(m: unknown) {
      setTimeout(() => this.onmessage?.({ data: JSON.stringify(m) }), 0);
    }
    send(data: string) {
      const m = JSON.parse(data) as { op: number; d: Record<string, unknown> };
      if (m.op === 1) {
        if (password && m.d.authentication !== sha(sha(password + this.salt) + this.challenge)) {
          setTimeout(() => this.onclose?.({ code: 4009 }), 0);
          return;
        }
        this.emit({ op: 2, d: { negotiatedRpcVersion: 1 } });
      } else if (m.op === 6) {
        const type = String(m.d.requestType);
        const data = m.d.requestData as Record<string, unknown> | undefined;
        log.push({ type, data });
        let res: Record<string, unknown> = {};
        if (type === 'GetVersion') res = { obsVersion: '31.0.0' };
        if (type === 'GetSceneList')
          res = {
            scenes: [{ sceneName: 'BRB' }, { sceneName: 'Main' }],
            currentProgramSceneName: state.scene,
          };
        if (type === 'GetStreamStatus') res = { outputActive: state.streaming };
        if (type === 'SetCurrentProgramScene') state.scene = String(data?.sceneName);
        if (type === 'StartStream') state.streaming = true;
        if (type === 'StopStream') state.streaming = false;
        this.emit({
          op: 7,
          d: {
            requestType: type,
            requestId: m.d.requestId,
            requestStatus: { result: true, code: 100 },
            responseData: res,
          },
        });
      }
    }
    close() {}
  }
  return { Socket: FakeSocket, log, state };
}

describe('OBS', () => {
  it('lists scenes, switches them, and starts and stops its stream', async () => {
    const f = fakeObs(null);
    const obs = new Obs({ secret: memoryStore(), WebSocket: f.Socket });
    const s = await obs.status();
    expect(s).toMatchObject({
      found: true,
      connected: true,
      scenes: ['Main', 'BRB'],
      currentScene: 'Main',
      streaming: false,
      version: '31.0.0',
    });
    await obs.setScene('BRB');
    await obs.start();
    expect(await obs.status()).toMatchObject({ currentScene: 'BRB', streaming: true });
    await obs.stop();
    expect((await obs.status()).streaming).toBe(false);
  });

  it('asks for the password, keeps it in the keychain, and says when it is wrong', async () => {
    const f = fakeObs('hunter2-hunter2');
    const secret = memoryStore();
    const obs = new Obs({ secret, WebSocket: f.Socket });
    expect(await obs.status()).toMatchObject({ found: true, needsPassword: true, connected: false });
    obs.setPassword('wrong');
    expect(await obs.status()).toMatchObject({
      needsPassword: true,
      detail: expect.stringContaining('didn’t accept'),
    });
    obs.setPassword('hunter2-hunter2');
    expect(secret.value).toBe('hunter2-hunter2');
    expect(await obs.status()).toMatchObject({ connected: true, needsPassword: false });
    obs.clearPassword();
    expect(secret.value).toBeNull();
  });

  it('sets the stream service from a saved destination, and the answer carries no key', async () => {
    const f = fakeObs(null);
    const keys = new Map<string, string>();
    const store = (a: string) => ({
      kind: 'keychain' as const,
      get: () => keys.get(a) ?? null,
      set: (v: string) => void keys.set(a, v),
      delete: () => void keys.delete(a),
    });
    const streamer = new Streamer({
      dataDir: mkdtempSync(join(tmpdir(), 'hg-obs-')),
      secrets: store,
      twitchIngest: async () => null,
    });
    streamer.setKey('twitch', 'live_1234567_SECRETSECRETSECRET');
    const obs = new Obs({ secret: memoryStore(), WebSocket: f.Socket });
    await streamer.useInObs(obs, 'twitch');
    const set = f.log.find((l) => l.type === 'SetStreamServiceSettings')!;
    expect(set.data).toMatchObject({
      streamServiceType: 'rtmp_custom',
      streamServiceSettings: { key: 'live_1234567_SECRETSECRETSECRET' },
    });
    expect(JSON.stringify(await obs.status())).not.toContain('SECRETSECRET');
    await expect(streamer.useInObs(obs, 'kick')).rejects.toThrow(/Kick stream key/);
  });

  it('is simply not found when nothing answers, and needs nothing', async () => {
    const obs = new Obs({ secret: memoryStore(), port: 1 });
    expect(await obs.status()).toMatchObject({ found: false, connected: false });
  });
});

// ── Who may do what ─────────────────────────────────────────────────────────────────────────────────────────────

describe('the routes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hg-routes-'));
  const keys = new Map<string, string>();
  const store = (a: string) => ({
    kind: 'keychain' as const,
    get: () => keys.get(a) ?? null,
    set: (v: string) => void keys.set(a, v),
    delete: () => void keys.delete(a),
  });
  const streamer = new Streamer({
    dataDir: dir,
    secrets: store,
    font: null,
    encoders: async () => ['libx264'],
  });
  const obs = new Obs({ secret: memoryStore(), port: 1 });
  const make = (flags: { local: boolean; owner: boolean }) => {
    const app = new Hono<HgEnv>();
    app.route(
      '/api/stream',
      streamRoutes({ streamer, obs, local: () => flags.local, owner: () => flags.owner }),
    );
    return app;
  };
  const H = { 'x-hildegard': '1', 'content-type': 'application/json' };
  const call = (app: Hono<HgEnv>, method: string, path: string, body?: unknown, env?: HgEnv['Bindings']) =>
    app.request(
      `/api/stream${path}`,
      { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) },
      env,
    );
  const KEY = 'live_4455667788_NotInAnyResponse0123456789';

  it('lets the person at this computer save a key, and never says it back', async () => {
    const here = make({ local: true, owner: true });
    const r = await call(here, 'PUT', '/keys/twitch', { key: KEY });
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).not.toContain(KEY);
    expect(JSON.parse(body).destinations.find((d: { id: string }) => d.id === 'twitch').keySet).toBe(true);
    for (const path of ['', '/devices', '/log', '/obs'])
      expect(await (await call(here, 'GET', path)).text(), path).not.toContain(KEY);
    expect(keys.get('stream-twitch')).toBe(KEY);
  });

  it('refuses a stream key that isn’t one, without echoing it', async () => {
    const here = make({ local: true, owner: true });
    const bad = 'not a key at all with spaces';
    const r = await call(here, 'PUT', '/keys/kick', { key: bad });
    expect(r.status).toBe(400);
    expect(await r.text()).not.toContain(bad);
  });

  it('answers an AI app’s start, stop, key and setting changes with needs-owner, even from this computer', async () => {
    const here = make({ local: true, owner: true });
    const agent = { as: { kind: 'local' as const } };
    for (const [m, p, b] of [
      ['POST', '/go-live', {}],
      ['POST', '/stop', {}],
      ['POST', '/cancel', {}],
      ['PUT', '/keys/youtube', { key: KEY }],
      ['DELETE', '/keys/twitch', undefined],
      ['PUT', '/settings', { scene: 'brb' }],
      [
        'PUT',
        '/settings',
        { destinations: { custom: { enabled: true, server: 'rtmp://evil.example/live' } } },
      ],
      ['POST', '/preview/start', {}],
      ['GET', '/devices', undefined],
      ['POST', '/preflight', {}],
      ['POST', '/obs/start', {}],
      ['POST', '/obs/service', { destination: 'twitch' }],
      ['PUT', '/obs/password', { password: 'x' }],
    ] as const) {
      const r = await call(here, m, p, b, agent);
      expect(r.status, `${m} ${p}`).toBe(403);
      expect(((await r.json()) as { code: string }).code, `${m} ${p}`).toBe('needs-owner');
    }
    expect(keys.get('stream-youtube')).toBeUndefined();
    expect(streamer.state().phase).toBe('idle');
  });

  it('lets an AI app read how the stream is going, with nothing private in it', async () => {
    const here = make({ local: true, owner: true });
    const r = await call(here, 'GET', '', undefined, { as: { kind: 'local' } });
    expect(r.status).toBe(200);
    const text = await r.text();
    const j = JSON.parse(text);
    expect(j.settings).toBeUndefined();
    expect(j.canStart).toBe(false);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('rtmps://');
    expect(j.destinations[0]).not.toHaveProperty('server');
  });

  it('keeps starting and the preview to the person at this computer, and settings that move the stream too', async () => {
    const far = make({ local: false, owner: true });
    for (const [m, p, b] of [
      ['POST', '/go-live', {}],
      ['PUT', '/keys/youtube', { key: KEY }],
      ['POST', '/preview/start', {}],
      ['GET', '/preview.jpg', undefined],
      ['PUT', '/settings', { quality: '720p30' }],
      ['GET', '/devices', undefined],
    ] as const) {
      const r = await call(far, m, p, b);
      expect(r.status, `${m} ${p}`).toBe(403);
      expect(((await r.json()) as { code: string }).code).toBe('local');
    }
    // The owner on a phone can switch scenes, mute, and stop.
    expect((await call(far, 'PUT', '/settings', { scene: 'brb' })).status).toBe(200);
    expect((await call(far, 'PUT', '/settings', { mute: true })).status).toBe(200);
    expect((await call(far, 'POST', '/stop', {})).status).toBe(200);
    // Someone who is not the owner can do none of it.
    const other = make({ local: false, owner: false });
    expect((await call(other, 'POST', '/stop', {})).status).toBe(403);
    expect((await call(other, 'PUT', '/settings', { scene: 'screen' })).status).toBe(403);
  });

  it('is closed to directors altogether', () => {
    const calls: [string, string][] = [
      ['GET', '/api/stream'],
      ['GET', '/api/stream/preview.mjpg'],
      ['PUT', '/api/stream/keys/youtube'],
      ['POST', '/api/stream/go-live'],
      ['POST', '/api/stream/stop'],
      ['GET', '/api/stream/obs'],
    ];
    for (const [m, p] of calls) expect(directorMay(m, p), `${m} ${p}`).toBe(false);
  });

  it('keeps every secret out of what is written to disk', () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(dir);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toContain(KEY);
  });

  it('saves destinations and rejects a bad server address in words', async () => {
    const here = make({ local: true, owner: true });
    const bad = await call(here, 'PUT', '/settings', {
      destinations: { custom: { enabled: true, server: 'https://x/live' } },
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/rtmps?:\/\//);
    const ok = await call(here, 'PUT', '/settings', {
      destinations: { custom: { enabled: true, server: 'rtmp://127.0.0.1:1935/live' } },
    });
    expect(ok.status).toBe(200);
    expect(streamer.settings().destinations.custom?.server).toBe('rtmp://127.0.0.1:1935/live');
  });

  it('refuses to start with no key, or nowhere to go', async () => {
    const here = make({ local: true, owner: true });
    await call(here, 'PUT', '/settings', { destinations: { youtube: { enabled: true } } });
    const r = await call(here, 'POST', '/go-live', {});
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/YouTube Live stream key/);
  });
});
