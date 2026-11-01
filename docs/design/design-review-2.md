# Design review 2: Hildegard · Studio canvas

Reviewed 2026-10-18 against `design-review-1.md`.
Canvas: https://claude.ai/artifact/HDHruShi7AMyD2ccwgMqEA. It now has 103 artboards: 19 new boards and 41 changed since review 1.

Method: same as review 1. I rendered every board (no errors or missing assets), looked at all the new and changed ones, and ran axe-core 4.10 on all 103.

## Verdict

Almost everything from review 1 is fixed, and fixed well. The automated accessibility check now finds **zero issues on all 103 boards**, down from 6 kinds of issue across 25+ boards. Three items remain:

- One new issue, caused by a decision made after the design brief was written: the phone Connect screens don't offer Hildegard Link.
- Two small leftovers.

## What remains

1. **Hildegard Link is missing from Connect (new).**
   - On 2026-10-18 you approved Hildegard Link (our relay, at `name.hildegard.link/mcp`) as the default public link. The Connect screens on iOS and Android offer only Tailscale, which is marked Recommended, plus Cloudflare Tunnel and Same Wi-Fi only.
   - The footer says "Nothing passes through us", which won't be true once traffic goes through the relay. The traffic is end-to-end encrypted, so accurate copy would be something like "Our relay only passes encrypted traffic. It can't read anything."
   - The fix: add Hildegard Link as the first option and mark it Recommended. Keep Tailscale and Cloudflare as alternatives, add a "Through Hildegard Link" variant of the trust screen, and correct the footer copy.
2. **Empty state initial.** The "E" is now a framed illuminated tile, which reads as more clearly decorative. But "E" followed by "very film begins" still asks the reader to join the two, and some people will read it as a typo. This is optional, since it may be a deliberate brand moment.
3. **Brother Konrad's reference strip.** His portrait is fixed, but the third reference slot in his strip is still an empty square.

Minor point: there's a failure screen for iOS but not for Android. It's a small gap if Android ships at the same time.

## Confirmed fixed

- **Contrast:** the text under the Create button now uses its own token at full opacity. VoiceSpeak grey is fixed, and all ARIA issues are fixed.
- **Phone Connect:**
  - Scan the code on your computer, then "Found Studio PC, checking it's really yours".
  - Trust screen with the fingerprint, connection route and latency, and "Only your devices can reach this. Each phone gets its own key you can revoke."
  - Connected, which shows the whole Choir and a Face ID toggle.
  - Asleep, with three choices: Wake it via Den NAS, Use Den NAS for now, or Queue it for later.
  - "Couldn't reach Studio PC", with a step-by-step check and "Nothing was sent anywhere while we checked."
  - iOS and Android both have Connect, Trust and Asleep screens.
- **Live Activity:**
  - Compact reads "Rendering 3/7 · Studio PC".
  - Expanded has a single Stop button.
  - The Lock Screen shows step, progress, time left and a stop control.
  - The "Still working. Open Hildegard" end state is there, after 8 hours.
- **Phone screens:**
  - Library with modality filter.
  - Full-screen video player with Share, Save and Retake. The audio player has A/B.
  - 3D viewer with Clay and Wire modes, "See it in your room" and Save USDZ.
  - Costs with Alert only / Hard stop, 50/75/100% alerts and per-account limits.
  - Settings with several servers, keys, sign-out that revokes keys, and Face ID.
  - Push banners with "Retry on Studio PC · $0.00".
  - Force now as a bottom sheet naming what it pauses.
  - A Server switch per device in Choir.
  - A mic button in Home.
  - A status pill naming the server and "via Tailscale".
- **Queue:** Run next, Cancel all except current, Cancel batch, and Keep 2 / Discard 2 on candidates.
- **Models:** "Fits", "May be slow" and "Won't fit" in words. There's a Problems panel with Install all, and pinned versions with "Updates wait for you".
- **Costs:** Alert only / Hard stop with an explanation, 50/75/100% alerts, per-key limits with reset dates and masked keys, and "Copy link to this view".
- **Choir:**
  - Pinned "New device found: Living room PC" with a code match, plus Approve and Not mine.
  - Add a device now means approving with a code.
  - Each device shows link speed and what it can't run (for example "Can't run Wan 2.2, 8 of 16 GB").
- **3D Studio:**
  - Pipeline stepper (Image, Shape, Texture, Export) and the image preview used first.
  - Quick look / Game asset / Print presets.
  - Clay mode, Studio light and Auto-rotate.
  - 3MF for printing.
  - A new compare board with a watertight check and printable size.
- **Smaller fixes:**
  - Main: the shot III take labels are clear of the fade.
  - MusicCreate: memory is on its own line under Length.
  - Saved this month reads $41.20 everywhere.
  - Phone cloning is now "Quick clone", with "Continue on Studio PC" for Pro.

## Follow-up prompt for Claude Design

> Nearly there. Three small changes, keep everything else:
>
> 1. Phone Connect (iOS and Android):
>    - Add **Hildegard Link** as the first option, marked Recommended: "Works anywhere · free · no account · end-to-end encrypted".
>    - Keep Tailscale, Your Cloudflare Tunnel and Same Wi-Fi only below it.
>    - Add a Trust screen variant that reads "Through Hildegard Link · end-to-end encrypted".
>    - Change the footer to "Our relay only passes encrypted traffic. It can't read anything."
>    - Add the "Couldn't reach Studio PC" screen for Android too.
> 2. Empty state: either keep the illuminated "E" but set the full word "Every" beside it, or choose a headline where the initial reads naturally.
> 3. Elements: fill Brother Konrad's third reference slot, or show only two.
