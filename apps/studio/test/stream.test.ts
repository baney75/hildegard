// SPDX-License-Identifier: AGPL-3.0-only
// The Studio’s small copy of the streaming facts stays equal to the presets’ own, which the server streams by.
import { STREAM_QUALITY as quality, STREAM_SCENES as scenes } from '@hildegard/presets';
import { describe, expect, it } from 'vitest';
import { STREAM_QUALITY, STREAM_SCENES } from '../src/lib/stream.ts';

describe('the Studio’s copy of the streaming facts', () => {
  it('matches packages/presets', () => {
    expect(STREAM_QUALITY).toEqual(quality);
    expect(STREAM_SCENES).toEqual(scenes);
  });
});
