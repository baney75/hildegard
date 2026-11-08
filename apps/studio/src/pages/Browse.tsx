// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useId, useState } from 'react';
import { Button, Icon, toast, toastError } from '../components/ui.tsx';
import { api, type BrowseSites } from '../lib/api.ts';

/** The sites the Hildegard app opens in windows of their own, and the ones the person adds. */
export function Browse() {
  const [data, setData] = useState<BrowseSites | null>(null);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const nameId = useId();
  const urlId = useId();
  const load = useCallback(() => api.browse().then(setData).catch(toastError), []);
  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    try {
      setData(await api.addBrowseSite(name, url));
      setName('');
      setUrl('');
      toast('Added. It is in the app’s Browse menu now.');
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <>
      <header className="hg-app__top">
        <div className="cs-crumb">
          <span className="t">Sites</span>
          <span className="s">Where you post</span>
        </div>
      </header>
      <main className="cs-stage hg-scroll" id="main">
        <div className="st-page hg-narrow">
          <p className="body sec-text hg-measure">
            In the Hildegard app each of these opens in a window of its own, with its own sign-in. Hildegard
            never reads what you sign in with, and it never posts: you sign in and press Post yourself. In a
            browser they open as tabs.{' '}
            {data?.sharedCookies
              ? 'To sign out of a site, use its own Sign out in its window.'
              : 'Sign out of a site from the Browse menu in the app.'}
          </p>
          <section className="hg-section" aria-labelledby="br-sites">
            <h2 id="br-sites" className="st-h2">
              Sites
            </h2>
            <ul className="hg-browse">
              {data?.sites.map((s) => (
                <li key={s.id}>
                  <a href={s.home} target="_blank" rel="noopener noreferrer">
                    <Icon name="link" size={18} />
                    {s.name}
                  </a>
                  {s.opensIn === 'browser' ? (
                    <small className="muted">
                      Google doesn’t allow signing in inside an app, so posting here opens your browser
                    </small>
                  ) : null}
                </li>
              ))}
              {data?.custom.map((s) => (
                <li key={s.id}>
                  <a href={s.url} target="_blank" rel="noopener noreferrer">
                    <Icon name="link" size={18} />
                    {s.name}
                  </a>
                  <Button
                    kind="ghost"
                    icon="trash"
                    aria-label={`Remove ${s.name}`}
                    onClick={() =>
                      api
                        .removeBrowseSite(s.id)
                        .then((next) => {
                          setData(next);
                          if (next.notice) toast(next.notice);
                        })
                        .catch(toastError)
                    }
                  />
                </li>
              ))}
            </ul>
            {data?.sharedCookies ? (
              <p className="body-sm hg-err" role="note">
                On macOS 11 to 13 every site in the app shares one set of cookies, with each other and with
                the Studio, so a sign-in in one is visible to the others and Hildegard can’t sign you out of
                just one. Sign out on the site itself, before you remove it. macOS 14 and later keeps them
                apart.
              </p>
            ) : null}
          </section>
          <section className="hg-section" aria-labelledby="br-add">
            <h2 id="br-add" className="st-h2">
              Add a site
            </h2>
            <p className="body-sm muted">
              An https address. The window shows that site and its subdomains; everything else opens in your
              browser. This works from the computer Hildegard runs on.
            </p>
            <div className="hg-postdlg__two">
              <label className="hg-field--block" htmlFor={nameId}>
                Name
                <input id={nameId} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="hg-field--block" htmlFor={urlId}>
                Address
                <input
                  id={urlId}
                  value={url}
                  placeholder="https://bsky.app"
                  onChange={(e) => setUrl(e.target.value)}
                />
              </label>
            </div>
            <div>
              <Button kind="primary" icon="plus" disabled={!name.trim() || !url.trim()} onClick={add}>
                Add
              </Button>
            </div>
          </section>
        </div>
      </main>
    </>
  );
}
