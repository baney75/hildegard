// SPDX-License-Identifier: AGPL-3.0-only
// The task `hildegard loop run` hands a coding agent, for each kind of loop.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loopTask } from '../src/loop.ts';

describe('loopTask', () => {
  const skills = join('/home', 'me', '.hildegard', 'skills');

  it('sends a print to the print skill, the printer and the measuring kit', () => {
    const t = loopTask({ idea: 'a shelf clip', kind: 'model', print: true, skills });
    expect(t).toContain('hildegard-loop, hildegard-3d, hildegard-print, and hildegard');
    expect(t).toContain('kind "model", print true');
    expect(t).toContain('Read printer_profile first');
    expect(t).toContain(join(skills, 'hildegard-print', 'scripts'));
  });

  it('keeps a model that isn’t printed to the 3D skill', () => {
    const t = loopTask({ idea: 'a fox for a game', kind: 'model', print: false, skills });
    expect(t).not.toContain('hildegard-print');
    expect(t).not.toContain('printer_profile');
  });

  it('builds a website as a folder that loads with nothing from outside', () => {
    const t = loopTask({ idea: 'a bakery site', kind: 'web', print: false });
    expect(t).toContain('hildegard-loop, hildegard-web, and hildegard');
    expect(t).toContain('kind "web"');
    expect(t).toContain('every font, image and script inside that folder');
    expect(t).not.toContain('Blender');
  });
});
