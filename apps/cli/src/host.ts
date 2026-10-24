// SPDX-License-Identifier: AGPL-3.0-only
import { createInterface } from 'node:readline/promises';
import type {
  AgentGrant,
  GrantsResponse,
  HostState,
  NewInvite,
  NewKey,
  PeopleResponse,
  Person,
  Role,
} from '@hildegard/presets';
import type { Step } from '@hildegard/runtime';
import { api, askSecret, type Ctx, ensureRunning } from './commands.ts';
import { bold, type Result, result } from './output.ts';

const FUNNEL_WARNING =
  'Funnel puts this Hildegard on the public internet: anyone who finds the link can reach its sign-in page and try passphrases (Hildegard slows them down). Only the people you invite can get in. Turn it off with `hildegard host off`.';

/** Everything after the last newline is part of the passphrase, spaces included; one trailing newline is not. */
async function readPassphrase(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
}

const hostStep = (h: HostState): Step =>
  h.on && h.url
    ? {
        id: 'host',
        title: 'Host at a link',
        status: 'done',
        detail: `${h.url} · ${{ tailscale: 'HTTPS on your tailnet (Tailscale Serve)', funnel: 'HTTPS on the public internet (Tailscale Funnel)', address: 'plain HTTP on your tailnet, which WireGuard encrypts' }[h.via!]}. Everyone signs in there.`,
      }
    : h.on
      ? {
          id: 'host',
          title: 'Host at a link',
          status: h.fix ? 'needs-owner' : 'failed',
          detail: h.problem ?? 'The link isn’t working.',
          ...(h.fix ? { command: h.fix } : {}),
        }
      : {
          id: 'host',
          title: 'Host at a link',
          status: 'skipped',
          detail: 'Off. Only this computer can use Hildegard.',
          command: 'hildegard host --json',
        };

/**
 * How AI apps on other devices reach the MCP at this link. Tailscale Serve is inside the tailnet, so only the owner's
 * own devices can; chatbots that live on the web (claude.ai, ChatGPT) need the public internet: Funnel.
 */
const mcpStep = (h: HostState): Step | null =>
  h.on && h.url
    ? {
        id: 'mcp',
        title: 'MCP for AI apps elsewhere',
        status: 'done',
        detail:
          h.via === 'funnel'
            ? `${h.url}/mcp. Paste it into claude.ai (Settings › Connectors › Add custom connector) or ChatGPT (developer mode), then sign in there with your name and passphrase. Apps on your own devices use a key: \`hildegard host key "<app and device>"\`.`
            : `${h.url}/mcp, for AI apps on your own devices, with a key: \`hildegard host key "<app and device>"\`. Chatbots on the web (claude.ai, ChatGPT) can't reach your tailnet: they need \`hildegard host --funnel\`.`,
      }
    : null;

const grantStep = (g: AgentGrant): Step => ({
  id: `grant-${g.id}`,
  title: g.name,
  status: 'done',
  detail: `${g.kind === 'key' ? 'Key' : 'Chatbot'} · acts as ${g.person.name} · ${g.lastUsedAt ? `last used ${g.lastUsedAt}` : 'not used yet'}${g.expiresAt ? ` · until ${g.expiresAt}` : ''} · id ${g.id}`,
});

const ownerStep = (): Step => ({
  id: 'owner',
  title: 'Make the owner account',
  status: 'needs-owner',
  detail:
    'The owner signs in with it from other devices. Its passphrase is theirs alone: ask them to run the command in a terminal on this computer, or to use Settings › Sharing in the Studio here. Never choose it for them.',
  command: 'hildegard host owner',
});

const personStep = (p: Person): Step => ({
  id: `person-${p.name}`,
  title: p.name,
  status: 'done',
  detail: `${p.role === 'owner' ? 'Owner' : 'Director'} · ${p.sessions === 1 ? 'signed in on 1 device' : `signed in on ${p.sessions} devices`}${p.lastSeenAt ? ` · last here ${p.lastSeenAt}` : ''}`,
});

/** Turn API refusals into a step: the owner's to fix when the server says how. */
function failure(id: string, title: string, e: unknown): Result {
  const err = e as Error & { status?: number; data?: { fix?: string | null } };
  const fix = err.data?.fix ?? null;
  return result(
    [
      {
        id,
        title,
        status: fix ? 'needs-owner' : 'failed',
        detail: err.message,
        ...(fix ? { command: fix } : {}),
      },
    ],
    err.message,
  );
}

/**
 * `hildegard host [on|off|status|owner|invite|people|revoke|role]`: this Hildegard at a link, with sign-in, for the
 * owner's other devices and the people they invite.
 */
export async function host(ctx: Ctx, args: string[]): Promise<Result> {
  const pre = await ensureRunning(ctx);
  if (pre?.status === 'failed') return result([pre], 'Hildegard isn’t running.');
  const c = ctx.config;
  const action = args[0] ?? 'on';
  const interactive = process.stdin.isTTY && !ctx.json;

  switch (action) {
    case 'status': {
      const h = await api<HostState>(c, '/api/host');
      const mcp = mcpStep(h);
      return result(
        [
          h.owner ? hostStep(h) : { ...ownerStep(), status: h.on ? 'needs-owner' : 'skipped' },
          ...(mcp ? [mcp] : []),
        ],
        '',
        { host: h, mcpUrl: h.url ? `${h.url}/mcp` : null },
      );
    }

    case 'owner': {
      let name = ctx.opts.get('name') ?? '';
      let passphrase = '';
      if (ctx.flags.has('passphrase-stdin')) passphrase = await readPassphrase();
      else if (interactive) {
        if (!name) {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          name = (await rl.question('Your name, to sign in with: ')).trim();
          rl.close();
        }
        console.log('Choose a passphrase of at least 10 characters. A few words you’ll remember work well.');
        passphrase = await askSecret('Passphrase (it won’t show): ');
        if (passphrase !== (await askSecret('Once more: ')))
          return result(
            [
              {
                id: 'owner',
                title: 'Make the owner account',
                status: 'failed',
                detail: 'Those didn’t match.',
              },
            ],
            'Those didn’t match. Nothing changed.',
          );
      }
      if (!name || !passphrase)
        return result(
          [
            {
              ...ownerStep(),
              ...(name ? { command: `hildegard host owner --name ${JSON.stringify(name)}` } : {}),
            },
          ],
          'Waiting on the owner to choose a passphrase.',
        );
      try {
        const r = await api<{ owner: { name: string; created: boolean } }>(c, '/api/people/owner', {
          method: 'POST',
          body: { name, passphrase },
        });
        return result(
          [
            {
              id: 'owner',
              title: 'Make the owner account',
              status: 'done',
              detail: r.owner.created
                ? `${r.owner.name} owns this Hildegard and signs in with that passphrase from other devices.`
                : `New passphrase set for ${r.owner.name}. They’re signed out everywhere else.`,
            },
          ],
          r.owner.created ? 'Next: `hildegard host` puts it at a link.' : '',
        );
      } catch (e) {
        return failure('owner', 'Make the owner account', e);
      }
    }

    case 'on': {
      const funnel = ctx.flags.has('funnel');
      const address = ctx.opts.get('address');
      const via = funnel ? 'funnel' : address ? 'address' : 'tailscale';
      if (funnel && !ctx.json) console.log(`${bold('Careful.')} ${FUNNEL_WARNING}\n`);
      let h = await api<HostState>(c, '/api/host');
      const steps: Step[] = [];
      if (!h.owner) {
        if (!interactive) return result([ownerStep()], 'Waiting on the owner account.', { host: h });
        const made = await host(ctx, ['owner']);
        steps.push(...made.steps);
        if (!made.ok || made.needsOwner) return { ...made, steps };
      }
      try {
        h = await api<HostState>(c, '/api/host', { method: 'POST', body: { via, address } });
      } catch (e) {
        const f = failure('host', 'Host at a link', e);
        return { ...f, steps: [...steps, ...f.steps] };
      }
      steps.push(hostStep(h));
      // The host step stays last, as agents read it; how AI apps reach the MCP rides along as fields.
      const mcp = mcpStep(h);
      return result(
        steps,
        h.url
          ? `Open ${h.url} on your other devices and sign in. Invite people with \`hildegard host invite\`.`
          : (h.problem ?? ''),
        {
          host: h,
          url: h.url,
          mcpUrl: h.url ? `${h.url}/mcp` : null,
          ...(mcp ? { mcp: mcp.detail } : {}),
          ...(funnel ? { warning: FUNNEL_WARNING } : {}),
        },
      );
    }

    case 'off': {
      const h = await api<HostState>(c, '/api/host/off', { method: 'POST' });
      return result(
        [
          {
            id: 'host',
            title: 'Host at a link',
            status: 'done',
            detail: 'Off. Only this computer can use Hildegard.',
          },
        ],
        'The link is off. People and their films stay, for the next time.',
        { host: h },
      );
    }

    case 'invite': {
      const role = (ctx.opts.get('role') ?? 'director') as Role;
      if (role !== 'director' && role !== 'owner')
        return result([], 'A role is `director` (their own films) or `owner` (everything).', { ok: false });
      const hours = ctx.opts.has('hours') ? Number(ctx.opts.get('hours')) : undefined;
      const now = await api<HostState>(c, '/api/host');
      // A link made before the host link exists would point at this computer only: make the host link first.
      if (!now.on || !now.url)
        return result(
          [{ ...hostStep(now), status: 'needs-owner' }],
          'Turn host mode on first, so the invite points at the link: `hildegard host`.',
          { host: now },
        );
      try {
        const r = await api<NewInvite>(c, '/api/people/invites', { method: 'POST', body: { role, hours } });
        if (!ctx.json)
          console.log(
            `Send this link to the person you’re inviting. It works once, until ${r.invite.expiresAt}; keep it private:\n\n${r.url}\n`,
          );
        return result(
          [
            {
              id: 'invite',
              title: `Invite a ${role}`,
              status: 'done',
              detail: `One link, for one person, until ${r.invite.expiresAt}.`,
            },
          ],
          '',
          { url: r.url, invite: r.invite },
        );
      } catch (e) {
        return failure('invite', `Invite a ${role}`, e);
      }
    }

    case 'people': {
      const r = await api<PeopleResponse>(c, '/api/people');
      return result(
        [
          ...r.people.map(personStep),
          ...r.invites.map(
            (i): Step => ({
              id: `invite-${i.id}`,
              title: `Invite for a ${i.role}`,
              status: 'skipped',
              detail: `Not used yet; works until ${i.expiresAt}.`,
            }),
          ),
        ],
        r.people.length ? '' : 'No one yet. `hildegard host owner` makes the owner account.',
        { people: r.people, invites: r.invites },
      );
    }

    case 'limit': {
      const n = args[1];
      try {
        const r = n
          ? await api<PeopleResponse>(c, '/api/people/settings', {
              method: 'PATCH',
              body: { directorQueue: Number(n) },
            })
          : await api<PeopleResponse>(c, '/api/people');
        const each = r.directorQueue === 1 ? '1 take' : `${r.directorQueue} takes`;
        return result(
          [
            {
              id: 'limit',
              title: 'Takes waiting per director',
              status: n ? 'done' : 'skipped',
              detail: `Each director may have ${each} waiting or rendering at once. Owners and this computer have no limit.`,
            },
          ],
          '',
          { directorQueue: r.directorQueue },
        );
      } catch (e) {
        return failure('limit', 'Takes waiting per director', e);
      }
    }

    case 'revoke':
    case 'role': {
      const name = args[1];
      const role = args[2] as Role | undefined;
      if (!name || (action === 'role' && role !== 'owner' && role !== 'director'))
        return result(
          [],
          action === 'role'
            ? 'Say who and which role: `hildegard host role <name> director|owner`.'
            : 'Say who: `hildegard host revoke <name>`.',
          { ok: false },
        );
      const r = await api<PeopleResponse>(c, '/api/people');
      const p = r.people.find((x) => x.name.toLocaleLowerCase() === name.toLocaleLowerCase());
      if (!p) return result([], `There’s no one called ${name} here.`, { ok: false });
      try {
        const after =
          action === 'revoke'
            ? await api<PeopleResponse>(c, `/api/people/${p.id}`, { method: 'DELETE' })
            : await api<PeopleResponse>(c, `/api/people/${p.id}`, { method: 'PATCH', body: { role } });
        return result(
          [
            action === 'revoke'
              ? {
                  id: 'revoke',
                  title: `Remove ${p.name}`,
                  status: 'done',
                  detail: 'Signed out everywhere, and can’t sign in again. Their films stay, for you.',
                }
              : {
                  id: 'role',
                  title: `Make ${p.name} ${role === 'owner' ? 'an owner' : 'a director'}`,
                  status: 'done',
                  detail: '',
                },
          ],
          '',
          { people: after.people, invites: after.invites },
        );
      } catch (e) {
        return failure(action, action === 'revoke' ? `Remove ${p.name}` : `Change ${p.name}’s role`, e);
      }
    }

    case 'key': {
      const name = args.slice(1).join(' ').trim() || ctx.opts.get('name') || '';
      if (!name)
        return result(
          [],
          'Name the key for the app and device it’s for: `hildegard host key "Claude Code on my laptop"`.',
          { ok: false },
        );
      const days = ctx.opts.has('days') ? Number(ctx.opts.get('days')) : undefined;
      try {
        const r = await api<NewKey>(c, '/api/auth/keys', {
          method: 'POST',
          body: { name, person: ctx.opts.get('person'), days },
        });
        const remote = r.mcpUrl?.replace(/\/mcp$/, '') ?? '<this link>';
        if (!ctx.json)
          console.log(
            `This key lets an AI app act as ${r.grant.person.name} here. It shows only now; treat it as a password:\n\n${r.key}\n\nOn the other device: hildegard connect <app> --remote ${remote} --key-stdin (and paste it)\nOr give the app ${r.mcpUrl ?? '<link>/mcp'} with the header  Authorization: Bearer <key>\n`,
          );
        return result(
          [
            {
              id: 'key',
              title: `Key for ${r.grant.name}`,
              status: 'done',
              detail: `Acts as ${r.grant.person.name}${r.grant.expiresAt ? ` until ${r.grant.expiresAt}` : ', until revoked'}. Hand it straight to the next step; never log it.`,
              command: `hildegard connect <app> --remote ${remote} --key-stdin`,
            },
          ],
          r.mcpUrl ? '' : 'Turn host mode on (`hildegard host`) so other devices can reach this Hildegard.',
          { key: r.key, grant: r.grant, mcpUrl: r.mcpUrl },
        );
      } catch (e) {
        return failure('key', `Key for ${name}`, e);
      }
    }

    case 'keys': {
      const r = await api<GrantsResponse>(c, '/api/auth/grants');
      if (args[1] === 'revoke') {
        const which = args.slice(2).join(' ').trim();
        const g =
          r.grants.find((x) => x.id === which) ??
          r.grants.find((x) => x.name.toLocaleLowerCase() === which.toLocaleLowerCase());
        if (!which || !g)
          return result(
            [],
            which
              ? `No key or chatbot called ${which}.`
              : 'Say which: `hildegard host keys revoke <id|name>`.',
            {
              ok: false,
            },
          );
        const after = await api<GrantsResponse>(c, `/api/auth/grants/${g.id}`, { method: 'DELETE' });
        return result(
          [
            {
              id: 'revoke',
              title: `Disconnect ${g.name}`,
              status: 'done',
              detail: 'It can’t use this Hildegard any more.',
            },
          ],
          '',
          { grants: after.grants },
        );
      }
      return result(
        r.grants.map(grantStep),
        r.grants.length
          ? ''
          : 'No keys or chatbots yet. `hildegard host key "<app and device>"` makes a key.',
        { grants: r.grants, mcpUrl: r.mcpUrl },
      );
    }

    default:
      return result(
        [],
        'Use `hildegard host`, `host off`, `host status`, `host owner`, `host invite`, `host people`, `host revoke <name>`, `host role <name> <role>`, `host limit [<takes>]`, `host key <name>` or `host keys [revoke <id|name>]`.',
        { ok: false },
      );
  }
}

export { FUNNEL_WARNING, hostStep };
