// SPDX-License-Identifier: AGPL-3.0-only
// What esbuild makes of the files the page imports (scripts/build-ui.mjs): an image's URL, and CSS beside the script.
declare module '*.svg' {
  const url: string;
  export default url;
}
declare module '*.css';
