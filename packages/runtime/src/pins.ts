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
