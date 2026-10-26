// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Checks text meant for a skill: a suggested change from someone's agent, or a skill file in a pull request. A skill
 * is instructions an agent follows with its owner's computer, keys and files at hand, so a skill change is code, and a
 * hostile one is an attack: telling the agent to ignore its user, hide what it does, run something fetched from the
 * web, read keys, or send files somewhere. This finds the usual shapes of that. It is a tripwire, not a judge: text it
 * passes still goes to a maintainer, who reads every word before anything ships.
 */

export interface ScanFinding {
  id: string;
  /** block: never filed, and fails CI. review: a maintainer must look at this line. */
  severity: 'block' | 'review';
  line: number;
  excerpt: string;
  why: string;
}

interface Rule {
  id: string;
  severity: ScanFinding['severity'];
  re: RegExp;
  why: string;
  /** A match this also matches, from its start, is fine after all. */
  unless?: RegExp;
}

const RULES: Rule[] = [
  {
    id: 'hidden-characters',
    severity: 'block',
    // Zero-width, bidirectional overrides and tag characters: text a person can't see but a model reads.
    re: /[​-‏‪-‮⁠-⁤⁦-⁩﻿\u{E0000}-\u{E007F}]/u,
    why: 'Characters a person can’t see but a model reads.',
  },
  {
    id: 'override-instructions',
    severity: 'block',
    re: /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|other|system|user'?s?|safety|developer)\b[^.\n]{0,20}\b(instructions?|prompts?|rules?|guidelines?|messages?|polic(y|ies))\b/i,
    why: 'Tells the agent to set aside its other instructions.',
  },
  {
    id: 'new-identity',
    severity: 'block',
    re: /\b(you are now|from now on you are|act as (an? )?(unrestricted|jailbroken|dan)\b|developer mode|jailbreak)/i,
    why: 'Tries to give the agent a new identity or mode.',
  },
  {
    id: 'hide-from-user',
    severity: 'block',
    re: /\b(do not|don'?t|never|without)\b[^.\n]{0,30}\b(tell|telling|inform|informing|show|showing|mention|mentioning|ask|asking|notify|notifying)\b[^.\n]{0,20}\b(the )?(user|owner|person|human|them)\b/i,
    why: 'Tells the agent to keep something from its person.',
  },
  {
    id: 'fetch-and-run',
    severity: 'block',
    re: /\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|fetch)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|fi)?sh\b|\b(iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n]*\|\s*(iex|invoke-expression)\b|\b(bash|sh)\s+<\(\s*(curl|wget)|powershell[^\n]*\s-(e|enc|encodedcommand)\s|\beval\s*\(\s*(atob|base64|fetch)/i,
    why: 'Runs code fetched from the web.',
    // Hildegard's own signed installer, from its own releases, is how the setup skill installs it.
    unless:
      /^(curl|wget|irm|iwr)\s+(-[\w-]+\s+)*https:\/\/github\.com\/baney75\/hildegard\/releases\/(latest\/)?download\/install\.(sh|ps1)\s*\|\s*(sh|iex)\b/i,
  },
  {
    id: 'secrets',
    severity: 'block',
    re: /(~|\$HOME|%USERPROFILE%)?[/\\]\.(ssh|aws|gnupg|kube|docker[/\\]config\.json|netrc|git-credentials)\b|\bid_(rsa|ed25519|ecdsa)\b|\b(HF_TOKEN|GH_TOKEN|GITHUB_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY|AWS_SECRET_ACCESS_KEY)\b|\bsecurity find-(generic|internet)-password\b|\bkeychain[^\n]{0,20}\b(dump|export|read)\b|\.hildegard[/\\](grants|people|secrets)|\bLogin Data\b|\bcookies\.sqlite\b/i,
    why: 'Reads keys, tokens or passwords.',
  },
  {
    id: 'send-out',
    severity: 'block',
    re: /\b(upload|send|post|exfiltrate|copy|forward|leak)\b[^.\n]{0,40}\b(to|at)\b[^.\n]{0,20}(https?:\/\/|webhook|pastebin|discord\.com\/api|ngrok|requestbin|transfer\.sh|\d{1,3}(\.\d{1,3}){3})/i,
    why: 'Sends data to somewhere outside.',
  },
  {
    id: 'disable-safety',
    severity: 'block',
    re: /--dangerously|skip[-_ ]permissions|--no-verify\b|\b(disable|turn off|remove|skip|strip|bypass)\b[^.\n]{0,30}\b(safety|consent|watermark|c2pa|signature|sandbox|review_take|review_prompt|license)\b/i,
    why: 'Turns off one of Hildegard’s safeguards.',
  },
  {
    id: 'persistence',
    severity: 'block',
    re: /\b(crontab|launchctl load|systemctl (--user )?enable|schtasks|reg add\b[^\n]*\\Run\b)|>>?\s*~?[/\\]?\.(bashrc|zshrc|profile|bash_profile)\b|authorized_keys/i,
    why: 'Makes something start by itself, or lets someone log in.',
  },
  {
    id: 'destructive',
    severity: 'block',
    re: /\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\$HOME|\*)(\s|$)|\bmkfs\b|\bdd\s+if=[^\n]*of=\/dev\/|\bformat\s+[a-z]:|\bdel\s+\/[sq]\b[^\n]*[a-z]:\\|:\(\)\s*\{\s*:\|:&\s*\};:/i,
    why: 'Deletes or wipes a disk or a home folder.',
  },
  {
    id: 'encoded-blob',
    severity: 'block',
    re: /[A-Za-z0-9+/]{160,}={0,2}/,
    why: 'A long encoded blob no one can read.',
  },
  {
    id: 'html',
    severity: 'review',
    re: /<!--|<\s*(script|iframe|img|object|embed|style|svg|details)\b/i,
    why: 'HTML hides text where a rendered page won’t show it.',
  },
  {
    id: 'link',
    severity: 'review',
    re: /\bhttps?:\/\/(?!(www\.)?(github\.com\/baney75\/|dbaney\.com\/|huggingface\.co\/|docs\.comfy\.org\/|openscad\.org\/))[^\s)>"']+/i,
    why: 'A link to somewhere a maintainer should check.',
  },
  {
    id: 'shell',
    severity: 'review',
    re: /\b(sudo|chmod\s+[0-7]*7[0-7]*|chown|pip install|npm (i|install)|npx|pnpm (add|dlx)|uvx|brew install|apt(-get)? install|winget install|git clone|docker run)\b/i,
    why: 'Installs or runs something; check it’s needed and pinned.',
  },
  {
    id: 'authority',
    severity: 'review',
    re: /\b(system prompt|system message|anthropic|openai|xai)\b[^.\n]{0,30}\b(says|requires|instructs|authori[sz]es|allows)\b/i,
    why: 'Claims to speak with authority it doesn’t have.',
  },
];

/** Every line that looks like an attack, with the rule it matched. */
export function scanSkillText(text: string): ScanFinding[] {
  const out: ScanFinding[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const r of RULES) {
      const m = r.re.exec(line);
      if (!m || r.unless?.test(m[0])) continue;
      const at = Math.max(0, m.index - 30);
      const excerpt = line
        .slice(at, m.index + m[0].length + 30)
        // Show invisible characters as what they are, never as nothing.
        .replace(
          /[^\P{C}\t]|[​-‏‪-‮⁠-⁩﻿]/gu,
          (c) => `<U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}>`,
        )
        .trim();
      out.push({ id: r.id, severity: r.severity, line: i + 1, excerpt: excerpt.slice(0, 160), why: r.why });
    }
  });
  return out;
}

export function describeScan(findings: ScanFinding[]): string {
  if (!findings.length)
    return 'Safety scan: nothing found. A maintainer still reads every word before it ships.';
  return [
    `Safety scan: ${findings.length} finding${findings.length === 1 ? '' : 's'}.`,
    ...findings.map(
      (f) =>
        `- ${f.severity === 'block' ? 'BLOCK' : 'review'} ${f.id}, line ${f.line}: ${f.why} \`${f.excerpt.replace(/`/g, "'")}\``,
    ),
  ].join('\n');
}
