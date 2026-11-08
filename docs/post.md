# Post: files and words for each platform, and your sites inside Hildegard

Hildegard prepares. You press Post. It holds no account, key or address for any platform, makes no request to one, and
has no way to post for you. What it does is make the work ready, then take you to the site.

## The Post sheet

Open it from **Export film** (once the film is exported) or from an image in **Images**. Choose where it is going and
give it facts: a title, a line about it in your words, your own hashtags, a link. Hildegard makes, in a **Ready to post**
folder in its data folder:

- the file in that platform's own size, shape, length and loudness,
- a thumbnail,
- a `.txt` with the title and caption, and
- the title and caption on screen, within the platform's limits, to copy.

Then, for each platform, **Open X** (or TikTok, Reddit and the rest) copies the caption, shows the file in its folder and
opens the site's page for posting. You drop the file in, paste, and press Post. Tick **Posted** as you go; the list
keeps its place if you close the sheet.

| Platform | File | Longest | Caption | Notes |
| --- | --- | --- | --- | --- |
| YouTube | 16:9, 1920×1080 (3840×2160 on request) | none set | title 100, description 5000 | thumbnail 1280×720 under 2 MB |
| YouTube Shorts | 9:16, 1080×1920 | 3 min | as YouTube | text kept clear of the buttons |
| Instagram Reels | 9:16, 1080×1920 | 3 min | 2200, 30 tags | |
| Instagram feed | 4:5, 1080×1350 | none set | 2200, 30 tags | also takes pictures |
| TikTok | 9:16, 1080×1920 | 10 min | 2200, 30 tags | under 287 MB |
| X | 16:9 1920×1080, or 1:1 1080×1080 for a tall picture | 2:20 | 280, counted as X counts | under 512 MB |
| Facebook | 4:5, 1080×1350 | none set | 5000 | |
| Threads | 9:16, 1080×1920 | 5 min | 500, 1 tag | |
| Reddit | 16:9, 1920×1080 | 15 min | title 300, no tags | |
| LinkedIn | 16:9, 1920×1080 | 10 min | 3000, 5 tags | |

Every film is H.264 (High, BT.709) with AAC at 48 kHz, set to −14 LUFS and a true peak under −1 dBTP; a film with no
sound gets a silent track. A picture of another shape is fitted whole over a soft copy of itself, or fills the frame if
you ask (which crops the edges). A film longer than the platform takes is cut to its limit, and the sheet says so.
The numbers are in `packages/presets/src/post.ts`.

**The words** come only from what you gave: your title, your description, your tags, your link, and one note that it is
AI-generated (on by default; the platforms ask for it, and each file says so in its metadata too). In what order a short
limit gives things up: the description first, then tags. What was cut or left out is listed. Nothing is invented: no
trending tags, no hooks.

**On-screen text** is off unless you turn it on. When on, it sits in the platform's safe area, clear of the buttons and
captions its app draws over the picture.

## Your sites, inside Hildegard

In the Hildegard app, a **Browse** menu (in the tray, and in the menu bar on macOS) opens X, YouTube, Instagram, TikTok,
Facebook, Threads, Reddit and LinkedIn, and any site you add under **Sites** in the Post sheet's footer or from
**Add a site…**. Each opens in a window of its own with a profile of its own, so signing in to one never shows in another.
Hildegard never reads what you sign in with.

What a site window can and can't do:

- **No capability.** `capabilities/main.json` names the `main` window only, and no remote URL. A page in a site window can
  call nothing in the app. The app adds no script to its pages and keeps the webview's own user agent.
- **Its own pages and frames only.** The window shows the site's domains, their subdomains and the few its sign-in uses
  (`presets/post-sites.json`, which the Studio and the server read too), as a page or as a frame in one. A link or popup
  that asks for a new window opens in your browser when it goes elsewhere, and in the same window when it doesn't. Any
  other page or frame from elsewhere is simply not loaded: Linux and macOS report a frame's navigation like a click, so
  a navigation never opens anything outside the window. On Windows, where wry reports the page's navigations only,
  every document the window loads, its frames' included, passes the same check before it is fetched (`frames.rs`,
  WebView2's `WebResourceRequested`); a refused one gets an empty 403. A WebView2 too old for that check (before
  1.0.2365) doesn't open site windows.
- **Downloads** go to your Downloads folder, under a name nothing there has.
- **Files** can be dropped on the page or chosen with its own file picker, so the prepared file goes in the site's
  upload box.
- **Sign out of this site** clears that site's profile (its Browse submenu, or the **Site** menu in its window).
  Removing a site you added closes its window and clears its profile too.
- A site you add is an `https` address on a real host: never an IP address, `localhost`, a bare name or a port. Its window
  shows that host and its subdomains and nothing else.

**Google.** Google forbids signing in from an embedded window
(<https://developers.google.com/identity/protocols/oauth2/policies#browsers>), so Hildegard never shows a Google sign-in
page and never changes its user agent to get around that. Posting to YouTube opens your browser. If a site's window
opens `accounts.google.com` in a new window or popup (YouTube's **Sign in**, or "Continue with Google" on another site),
the window stays where it was and Hildegard offers your browser instead, with the caption copied and the file shown. A
Google sign-in page or frame inside the window (Google's sign-in button, One Tap) is not loaded and offers nothing. Where
a site has its own email or username sign-in, use that in the app.

**Captchas and bot checks.** A site's sign-in often loads a captcha in a frame. Those hosts are in the site's `auth`
list, and only for the site whose sign-in uses them. An entry is a domain (with its subdomains) or a host and the start of
a path, so `www.google.com/recaptcha/` lets in Google's captcha and nothing else on www.google.com. Only pages and frames
are checked, so a captcha's scripts and images need no entry. Each one, and where it comes from:

| Entry | Sites | Source |
| --- | --- | --- |
| `www.google.com/recaptcha/`, `recaptcha.google.com/recaptcha/` | Reddit, Instagram, Facebook, Threads, TikTok | Google's reCAPTCHA frame hosts (<https://developers.google.com/recaptcha/docs/faq>, the frame-src list). Reddit: its admins say its login uses reCAPTCHA (r/help, "Changes to old Reddit login flow", May 2024). Facebook's and Instagram's login pages allow `www.google.com` and `*.google.com` frames in their CSP; Threads signs in through Instagram. TikTok's login CSP lists `recaptcha.google.com` and `www.google.com`. |
| `recaptcha.net/recaptcha/`, `www.recaptcha.net/recaptcha/`, `recaptcha.google.com/recaptcha/` | X | X's login CSP (`x.com/i/flow/login`) frame-src names exactly these. Google: <https://developers.google.com/recaptcha/docs/faq> (www.recaptcha.net). |
| `iframe.arkoselabs.com` | X | X's login CSP frame-src. |
| `arkoselabs.com` | TikTok | TikTok's login CSP allows `*.arkoselabs.com` (frames fall back to its default-src) and loads `client-api.arkoselabs.com` and its own `tx41v.arkoselabs.com`. Arkose's client domains: <https://developer.arkoselabs.com/docs/domain-policy>. |
| `hcaptcha.com` | TikTok | TikTok's login CSP lists `js.hcaptcha.com` and `newassets.hcaptcha.com`; hCaptcha asks for `hcaptcha.com` and `*.hcaptcha.com` in frame-src (<https://docs.hcaptcha.com/>, Content Security Policy). |
| `static.captchami.com` | TikTok | TikTok's login CSP default-src, which its frames fall back to. |
| `fbsbx.com` | Instagram, Facebook, Threads | Meta's captcha frame host: all three login pages' CSP frame-src allow `*.fbsbx.com`. |

LinkedIn's login page refuses a plain request, so its CSP couldn't be read, and no primary source names its captcha:
it has none listed. Cloudflare Turnstile (`challenges.cloudflare.com`) is in no listed site's login CSP, so it isn't
listed either. The CSPs were read on 2026-11-07; sites change them, and a new captcha host is a line here and a test.

**Profiles.** Each site's cookies and storage live under `<data>/browse/<site>/` (mode 0700 where the system has modes),
nowhere else. On macOS 14 and later each site gets its own data store. macOS 11 to 13 has no way to keep them apart, so
those sites share one cookie store with each other and with the Studio. There Hildegard can't sign out of one site or
clear a removed one's cookies without clearing the Studio's too, so it doesn't: **Sign out of this site** and removing a
site say to sign out on the site itself. On macOS 14 and later, removing a site removes its data store once its window
has closed, and the app removes any store left from a site removed while it wasn't running.

## For agents

`prepare_post` (MCP) makes the same files and words and returns them. It never posts and cannot. Don't sign in to a site,
click inside one, read its pages or read `<data>/browse/` for the person: signing in and pressing Post are theirs.

## Checks

`apps/server/test/post.test.ts` makes a film on the stand-in GPU and prepares every platform from it, measures each file
(size, codec, length, loudness, thumbnail) with a meter that did not make it, holds every caption to its limit, and
watches the whole run for any request that leaves this computer. `apps/desktop/test/config.test.ts` checks the
capabilities and the site windows' build; `browse.rs` tests which pages a site window shows.
