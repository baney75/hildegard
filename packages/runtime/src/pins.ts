// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Everything Hildegard downloads to run ComfyUI, pinned. A download whose hash doesn't match is refused.
 * Python packages come from PyPI and the PyTorch index through uv, which checks their hashes against the index.
 */

export const COMFYUI = {
  version: '0.42.1',
  url: 'https://github.com/comfyanonymous/ComfyUI/archive/refs/tags/v0.42.1.tar.gz',
  sha256: '8fb71e51c10c6261fe8dcfdbebe550a1d4ec6b74b6c57515e1b7313dbe4a215b',
  /** The folder the archive unpacks to. */
  root: 'ComfyUI-0.42.1',
} as const;

/** Comfy's own proxy that serves the Comfy API v2 in front of ComfyUI; Hildegard talks to ComfyUI only through it. */
export const PROXY = 'comfy-api-proxy==0.1.6';

/** ComfyUI recommends 3.13. uv downloads it if the computer has no Python, with no admin rights. */
export const PYTHON = '3.13';

/** uv, if it isn't installed already: Astral's release builds, by hash. */
export const UV = {
  version: '0.13.2',
  assets: {
    'linux-x64': [
      'uv-x86_64-unknown-linux-gnu.tar.gz',
      'e14d48c117ec33601d6f860dda47aa5ea490d77a5a9ef770529c448fa6747d9f',
    ],
    'linux-arm64': [
      'uv-aarch64-unknown-linux-gnu.tar.gz',
      '3143e25fccac6f81b3b400792caa2ec431a5e8824d855cde9550a25f0fac8ea0',
    ],
    'darwin-x64': [
      'uv-x86_64-apple-darwin.tar.gz',
      '08f0cb0d63a012ffa07659d1872030c1110fccdd665d49bc3683b0ca262b4a62',
    ],
    'darwin-arm64': [
      'uv-aarch64-apple-darwin.tar.gz',
      '4a5d878cd0db3a57d79eec638c275e71c394e10533ae54c77b33d940866f53b7',
    ],
    'win32-x64': [
      'uv-x86_64-pc-windows-msvc.zip',
      '9cfb447a4027550f134753253fdffbcd35b79a66dd888260bf6776891916069e',
    ],
    'win32-arm64': [
      'uv-aarch64-pc-windows-msvc.zip',
      '305d3a87a3c83ced9a9347e0b2e9d1719013db1ed8d7b34ba42ee1558f968686',
    ],
  } as Record<string, [file: string, sha256: string]>,
  url: (file: string) => `https://github.com/astral-sh/uv/releases/download/0.13.2/${file}`,
};

/**
 * cloudflared, for a Cloudflare tunnel, when the owner asks Hildegard to fetch it (`hildegard tunnel install
 * cloudflare`, or the button in Settings › Sharing): Cloudflare's release builds, by GitHub's SHA-256 of each asset.
 * The Mac builds are archives that hold the one binary.
 */
export const CLOUDFLARED = {
  version: '2026.10.3',
  assets: {
    'linux-x64': [
      'cloudflared-linux-amd64',
      '053b80b0a23031a038fdbf3c073f59f82b8f1f152aa67971d7383ffafc0dbab0',
    ],
    'linux-arm64': [
      'cloudflared-linux-arm64',
      '89297ebfb9e8c99c0dc013a1140601453cf3798d8306c5591651f4a3f5210be8',
    ],
    'darwin-x64': [
      'cloudflared-darwin-amd64.tgz',
      '81b7b85f2376815c4f59b1aa323887b62e16ce8b67555c2e1577dc23f2a82000',
    ],
    'darwin-arm64': [
      'cloudflared-darwin-arm64.tgz',
      '1165d14b6f6360a3b8c283d7d1100024d6ec7cd9bc9e32519e96150645f3ec55',
    ],
    'win32-x64': [
      'cloudflared-windows-amd64.exe',
      '76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2',
    ],
  } as Record<string, [file: string, sha256: string]>,
  url: (file: string) => `https://github.com/cloudflare/cloudflared/releases/download/2026.10.3/${file}`,
};
