/**
 * @vitest-environment jsdom
 *
 * Bare pull-request references become links; everything that must not, does not.
 *
 * The plugin rewrites prose during the parse — see `lib/prReferences.ts` — so
 * these assert on the rendered anchors: their hrefs, their text, and above all
 * their absence in the places a false link would mislead (code, existing
 * links, prose with no repository to resolve against). The repository is
 * whatever the workspace's `origin` names, on any host: the GitHub case is the
 * original, and the Forgejo and GitLab cases are the ones that used to render
 * as dead text.
 */

import { describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { afterEach } from 'vitest';
import { parseRemoteUrl } from '@rx-artemis/protocol';

import { Markdown } from '@/components/Markdown';
import { TooltipProvider } from '@/components/ui/tooltip';

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);

const GITHUB = parseRemoteUrl('git@github.com:Rx-Ventures/artemis.git')!;
const FORGEJO = parseRemoteUrl('http://100.82.237.80:8300/david/cortex.git')!;
const GITLAB = parseRemoteUrl('https://gitlab.com/group/sub/project.git')!;

function anchors(): Array<{ href: string; text: string }> {
  return Array.from(document.querySelectorAll('a')).map((a) => ({
    href: a.getAttribute('href') ?? '',
    text: a.textContent ?? '',
  }));
}

afterEach(cleanup);

describe('pull-request references', () => {
  it('links a bare #N against the workspace repository', () => {
    render(<TooltipProvider><Markdown origin={GITHUB}>{'Fixed in #141 and #209.'}</Markdown></TooltipProvider>);
    expect(anchors()).toEqual([
      { href: 'https://github.com/Rx-Ventures/artemis/pull/141', text: '#141' },
      { href: 'https://github.com/Rx-Ventures/artemis/pull/209', text: '#209' },
    ]);
  });

  it('links a bare #N on a self-hosted forge, spelled the way that forge spells it', () => {
    // The case that used to be dead text: a Forgejo on a LAN address and port,
    // reached over plain http. Scheme, host and port all survive into the link.
    render(<TooltipProvider><Markdown origin={FORGEJO}>{'Merged as #134, replacing #133.'}</Markdown></TooltipProvider>);
    expect(anchors()).toEqual([
      { href: 'http://100.82.237.80:8300/david/cortex/pulls/134', text: '#134' },
      { href: 'http://100.82.237.80:8300/david/cortex/pulls/133', text: '#133' },
    ]);
  });

  it('spells a GitLab reference as a merge request, subgroup and all', () => {
    render(<TooltipProvider><Markdown origin={GITLAB}>{'See #41.'}</Markdown></TooltipProvider>);
    expect(anchors()).toEqual([
      { href: 'https://gitlab.com/group/sub/project/-/merge_requests/41', text: '#41' },
    ]);
  });

  it('links owner/repo#N with no workspace at all, on github.com', () => {
    render(<TooltipProvider><Markdown>{'See Rx-Ventures/cerebro#7 for the decision.'}</Markdown></TooltipProvider>);
    expect(anchors()).toEqual([
      { href: 'https://github.com/Rx-Ventures/cerebro/pull/7', text: 'Rx-Ventures/cerebro#7' },
    ]);
  });

  it('reads owner/repo#N on the workspace forge when there is one', () => {
    // A self-hosted checkout naming a neighbour means the neighbour there,
    // not the same name on github.com.
    render(<TooltipProvider><Markdown origin={FORGEJO}>{'Tracked in david/medulla#4.'}</Markdown></TooltipProvider>);
    expect(anchors()).toEqual([
      { href: 'http://100.82.237.80:8300/david/medulla/pulls/4', text: 'david/medulla#4' },
    ]);
  });

  it('leaves a bare #N as text when there is no repository to resolve it', () => {
    // A link invented for the wrong repository is worse than dead text — and
    // the self-naming form in the same sentence still gets its link.
    render(<TooltipProvider><Markdown>{'Compare #12 with o/r#12.'}</Markdown></TooltipProvider>);
    expect(anchors()).toEqual([{ href: 'https://github.com/o/r/pull/12', text: 'o/r#12' }]);
  });

  it('never touches code, existing links, or run-together text', () => {
    render(
      <TooltipProvider><Markdown origin={GITHUB}>
        {'Run `git show #141` then see [old #7](https://example.com/x) — issue#9 and #10abc stay.\n\n```\n# 141 is a comment, #142 too\n```'}
      </Markdown></TooltipProvider>,
    );
    // The only anchor is the one that was already a link, untouched.
    expect(anchors()).toEqual([{ href: 'https://example.com/x', text: 'old #7' }]);
  });

  it('keeps the surrounding sentence byte-for-byte', () => {
    render(<TooltipProvider><Markdown origin={GITHUB}>{'Before (#5), after.'}</Markdown></TooltipProvider>);
    expect(document.body.textContent).toContain('Before (#5), after.');
  });
});
