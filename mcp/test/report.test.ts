// SPDX-License-Identifier: AGPL-3.0-only
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import {
  createMcpServer,
  type Draft,
  draftReport,
  HildegardClient,
  redact,
  searchTerms,
  similarIssues,
} from '../src/index.ts';

describe('redact', () => {
  it('takes out keys and tokens of every kind Hildegard and its apps use', () => {
    // Made up, and put together here so secret scanners don't mistake the test for a leak.
    const secrets = [
      ['hf_', 'abcdefghijklmnopqrstuvwxyz123456'],
      ['ghp_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'],
      ['github_pat_', '11ABCDEFG0123456789_abcdefghijklmnop'],
      ['sk-ant-', 'api03-abcdefghijklmnopqrstuvwx'],
      ['sk-proj-', 'abcdefghijklmnopqrstuv'],
      ['hgk_', 'Zm9vYmFyYmF6cXV4cXV1eGNvcmdl'],
      ['hga_', 'Zm9vYmFyYmF6cXV4cXV1eGNvcmdl'],
      ['rpa_', 'ABCDEFGHIJKLMNOPQRSTUVWX'],
      ['tskey-', 'auth-kAbCdEf123456'],
      ['AKIA', 'ABCDEFGHIJKLMNOP'],
      ['eyJ', `${'a'.repeat(12)}.eyJ${'b'.repeat(12)}.${'c'.repeat(16)}`],
    ].map(([a, b]) => a! + b!);
    for (const s of secrets) {
      const r = redact(`it said ${s} and stopped`);
      expect(r.text, s).not.toContain(s);
      expect(r.removed.key, s).toBeGreaterThan(0);
    }
    const r = redact(
      `Authorization: ${'Bear'}er ${'abcdefgh'}ijklmnop1234\n${'pass'}word=hunter2hunter2\nGET /media/a.mp4?exp=1&sig=Zx9_abcDEF https://bob:${'pw'}123@host.example`,
    );
    expect(r.text).not.toMatch(/abcdefghijklmnop1234|hunter2|Zx9_abcDEF|bob:pw123/);
  });

  it('turns home folders into ~, on every system, and names into placeholders', () => {
    const r = redact(
      'at /Users/donovan/Projects/x.ts and C:\\Users\\Donovan\\AppData\\x and /home/sam/.config and D:\\Hildegard\\data',
      { home: '/Users/donovan', user: 'donovan', host: 'rectory1', names: ['gatehouse1'] },
    );
    expect(r.text).toBe('at ~/Projects/x.ts and ~\\AppData\\x and ~/.config and D:\\Hildegard\\data');
    const n = redact(
      'rendering on gatehouse1 from rectory1.tail1234.ts.net (100.101.5.6), mail sam@example.com',
      {
        host: 'rectory1',
        names: ['gatehouse1'],
      },
    );
    expect(n.text).toBe('rendering on <name> from <tailnet name> (<address>), mail <email>');
  });

  it('leaves what a maintainer needs: versions, model ids, commits, loopback, error words', () => {
    const keep =
      'Hildegard 0.1.7 (c0875dd) ltx-2-3-22b-distilled-fp8 on 127.0.0.1:7341, commit c0875dd4b0a1e2f3a4b5c6d7e8f9a0b1c2d3e4f5, CUDA out of memory, exit code 1';
    expect(redact(keep).text).toBe(keep);
  });
});

describe('drafts', () => {
  const diag = {
    os: 'Linux' as const,
    facts: { Hildegard: '0.1.7', GPU: 'NVIDIA GeForce GTX 1650, 4 GB' },
    checks: ['✗ ComfyUI: Not answering.'],
    log: Array.from({ length: 40 }, (_, i) => `line ${i} ${'x'.repeat(300)} /home/sam/x`),
  };

  it('writes the bug under the form’s own headings, with nothing private in the body or the link', () => {
    const d = draftReport(
      {
        kind: 'bug',
        title: 'Takes fail at /home/sam/films',
        what: `It crashed with ${'hf_'}abcdefghijklmnopqrstuvwxyz12`,
        agent: 'Claude Code',
      },
      diag,
      { home: '/home/sam', user: 'sam' },
    );
    expect(d.title).toBe('Takes fail at ~/films');
    for (const h of [
      '### What happened',
      '### hildegard doctor',
      '### Computer\n\nLinux',
      '### Anything else',
    ])
      expect(d.body).toContain(h);
    expect(d.body).toContain('Drafted by Claude Code');
    expect(d.body + d.url).not.toMatch(/hf_abc|\/home\/sam|sam\b/);
    expect(d.labels).toEqual(['bug']);
    expect(d.removed.path).toBeGreaterThan(0);
    const u = new URL(d.url);
    expect(u.searchParams.get('template')).toBe('bug.yml');
    expect(u.searchParams.get('os')).toBe('Linux');
    // A long log is too much for a link; it stays in the body.
    expect(d.url.length).toBeLessThanOrEqual(7500);
  });

  it('fills the idea form', () => {
    const d = draftReport(
      { kind: 'idea', title: 'Cut a trailer from my takes', what: 'I want a trailer' },
      diag,
      {},
    );
    const u = new URL(d.url);
    expect(u.searchParams.get('template')).toBe('idea.yml');
    expect(u.searchParams.get('want')).toBe('I want a trailer');
    expect(u.searchParams.get('gpu')).toBe('NVIDIA GeForce GTX 1650, 4 GB');
    expect(d.body).toContain('### What you want to make or do');
  });
});

describe('finding issues like it', () => {
  it('searches the repository with the title’s words only, open issues first, and no pull requests', async () => {
    let asked = '';
    const fetchFn = (async (u: string) => {
      asked = decodeURIComponent(u);
      return Response.json({
        items: [
          { number: 3, title: 'Old', html_url: 'https://github.com/x/3', state: 'closed', comments: 0 },
          {
            number: 9,
            title: 'PR',
            html_url: 'https://github.com/x/9',
            state: 'open',
            comments: 0,
            pull_request: {},
          },
          { number: 7, title: 'Same', html_url: 'https://github.com/x/7', state: 'open', comments: 2 },
        ],
      });
    }) as unknown as typeof fetch;
    const s = await similarIssues('The draft takes don’t start on my GPU', 'baney75/hildegard', fetchFn);
    expect(asked).toContain('repo:baney75/hildegard is:issue draft takes start gpu');
    expect(s!.map((x) => x.number)).toEqual([7, 3]);
    expect(
      await similarIssues(
        'x y',
        'r/r',
        (async () => new Response('', { status: 403 })) as unknown as typeof fetch,
      ),
    ).toEqual([]);
    expect(
      await similarIssues(
        'broken thing',
        'r/r',
        (async () => new Response('', { status: 403 })) as unknown as typeof fetch,
      ),
    ).toBeNull();
    expect(searchTerms('<name> can’t render 4K')).toBe('render 4k');
  });
});

describe('the report tools', () => {
  async function connect(fetchFn: typeof fetch) {
    const server = createMcpServer(new HildegardClient('https://studio.example', fetchFn));
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 'unit', version: '1' });
    await client.connect(b);
    return client;
  }

  it('show the exact text and ask before filing, and file only with confirm', async () => {
    const draft: Draft = {
      id: 'r0123456789ab',
      kind: 'bug',
      at: '2026-10-26T00:00:00Z',
      repo: 'baney75/hildegard',
      title: 'It broke',
      body: '### What happened\n\nIt broke',
      labels: ['bug'],
      url: 'https://github.com/baney75/hildegard/issues/new?template=bug.yml',
      removed: { path: 2 },
      similar: [
        {
          number: 4,
          title: 'It broke too',
          url: 'https://github.com/baney75/hildegard/issues/4',
          state: 'open',
          comments: 1,
        },
      ],
    };
    const sent: unknown[] = [];
    const client = await connect((async (u: string, init: RequestInit = {}) => {
      if (u.endsWith('/api/report/draft')) {
        sent.push(JSON.parse(String(init.body)));
        return Response.json({ draft, filer: 'baney75' });
      }
      if (u.endsWith('/api/report/file'))
        return Response.json({
          draft: { ...draft, filed: { url: 'https://github.com/baney75/hildegard/issues/5', at: 'now' } },
        });
      return Response.json({ error: 'no' }, { status: 404 });
    }) as unknown as typeof fetch);
    const r = (await client.callTool({
      name: 'report_draft',
      arguments: { kind: 'bug', title: 'It broke', what: 'It broke' },
    })) as CallToolResult;
    const out = JSON.stringify(r.content);
    expect(r.isError).toBeFalsy();
    expect(out).toContain('Nothing has been sent');
    expect(out).toContain('### What happened');
    expect(out).toContain('#4 (open)');
    expect(out).toContain('ask whether to file');
    expect(out).toContain('2 folder paths');
    expect(sent[0]).toMatchObject({ kind: 'bug', how: 'An AI app over MCP', logs: true, agent: 'unit' });
    const no = (await client.callTool({
      name: 'report_file',
      arguments: { draft: draft.id },
    })) as CallToolResult;
    expect(no.isError).toBe(true);
    const yes = (await client.callTool({
      name: 'report_file',
      arguments: { draft: draft.id, confirm: true },
    })) as CallToolResult;
    expect(JSON.stringify(yes.content)).toContain('issues/5');
    await client.close();
  });

  it('still drafts, with a link to send it, when Hildegard isn’t running', async () => {
    const client = await connect((async (u: string) => {
      if (u.includes('api.github.com')) return Response.json({ items: [] });
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch);
    const r = (await client.callTool({
      name: 'report_draft',
      arguments: { kind: 'bug', title: 'Hildegard won’t start', what: 'start says nothing' },
    })) as CallToolResult;
    const out = JSON.stringify(r.content);
    expect(out).toContain('isn’t running');
    expect(out).toContain('https://github.com/baney75/hildegard/issues/new?');
    await client.close();
  });
});
