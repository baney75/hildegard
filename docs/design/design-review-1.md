# Design review 1: Hildegard · Studio canvas

Reviewed 2026-10-18 against `hildegard-claude-design-prompt-2.md` and `interface-research.md`.
Canvas: https://claude.ai/artifact/HDHruShi7AMyD2ccwgMqEA (84 artboards: 61 desktop, 23 tablet, phone and widget).

Method: I rendered every artboard in a headless browser (all 84 loaded, no missing assets), looked at each one, and ran an automated accessibility check (axe-core 4.10) on every board.

## Verdict

This is strong, finished-looking work, and most of it is ready to build from. Cinema Studio, Voice and Music are close to complete and in places go beyond the prompt (consent and voice rights especially). The brand rules hold almost everywhere: green for actions, gold for running, sapphire for queued, ember only for Force now and outside spend, cost and privacy under every Create button.

What's missing is mostly in Round 4 (phones): the Connect flow, phone Library, Costs and Settings were never drawn, and the Live Activity doesn't match the spec. There's also one contrast bug that repeats on 25 boards and has a one-line fix.

## Fix first

1. **Contrast under the Create button (25 boards).** The small line under every green Create button, like "~3 min on Studio PC", is `#cad5c1` on `#2c7350` at 12px, which measures 3.75:1. It needs 4.5:1. Changing that text to `#e6ece0` or lighter (or making it 14px semibold) fixes all 25 boards.
2. **Phone Connect flow is missing.** There's no QR scan, no Tailscale or Cloudflare choice, no trust step with fingerprint, and no failure or "Studio PC is asleep" state. This is the first screen anyone sees on a phone.
3. **Live Activity doesn't match the spec.**
   - Compact shows only "1:48". It should read "Rendering 3/7 · Studio PC".
   - Expanded has Pause and Open. The spec asks for a single Stop button.
   - The end state shows "Ready". It's missing "Still working. Open Hildegard" for renders that outlast the activity.
4. **Accessibility markup** (from the automated check):
   - The voice list (`st-vlist`, role listbox) has no label.
   - `aria-selected` is used on plain buttons in the VoiceSpeak tag tabs. Use role="tab" or `aria-pressed`.
   - The `@` picker listbox holds buttons. Use role="option" children.
   - `aria-label` sits on a plain span (the play control on Main). Make it a button.
   - The swatch pill button on Phone has no name.
   - VoiceSpeak secondary text `#666662` on `#0a0e13` is 3.35:1. Lighten it to about `#8a8a84`.

## What's working well

- **Cinema Studio.** The board of shots and takes, with settings in mono on every result. Clear queued, running (gold ring) and failed states. "Out of memory, Retry on Studio PC, FREE" and "Declined by Runway, did not charge" are exactly the honesty the research called for.
- **Craft tools.** Rig uses generic camera names. Motion has 24 presets, combinable with weights. There are also Project look, Frames with Loop, Elements ("Update 4 shots that use Mara"), Annotate with per-model "good at" notes, Draft vs Final, Retake by range, and Extend ("Reads last 3 s"). Timeline export covers 720p to 4K and ProRes. Compare runs across 4 models, and the Nodes view has compatible-node search.
- **Voice.** Tag autocomplete with "never spoken". Unsupported controls are greyed out with a reason ("Orpheus 3B doesn't support this. Chatterbox does."). The Enhance diff promises "Your words are exactly as you wrote them". Also takes A/B with Lock, IPA pronunciation, M4B export with LUFS, and Design a voice returning 3 candidates.
- **Cloning and consent.** These boards go further than the prompt: CloneWhose, CloneInvite, PhoneConsent ("Sam would like to make a voice from yours", read-aloud consent, "Nothing is recorded until you tap"), VoiceRights with every use and watermark id, and CloneBlocked (wrong speaker, not charged). This is a real differentiator.
- **Music.** Simple and Custom modes, a "Leave out" field, VRAM per option, takes showing seed and Reuse, a staged-changes banner, Replace with comp lanes, Extend with "Listens to", and Stems with a DAW export.
- **Platform screens.**
  - Choir orbit with Server, Opportunistic and Rented devices.
  - ChoirAdd with LAN discovery and pairing code.
  - The ForceNow dialog ("pauses another job, costs nothing").
  - Agents: "Approve $0.16" next to "Run free on my devices", per-agent permissions, and `hildegard mcp add`.
  - "Set up this Mac for me" onboarding.
  - Costs (saved vs spent, cap, "not charged" rows), DeviceSettings with an idle heatmap, and Compute with RunPod.
- **Phones.**
  - Native-feeling iOS and Android versions with a consistent five-tab bar.
  - The Shot settings sheet keeps Create in thumb reach, with cost and privacy shown.
  - Swipe-to-force in Queue.
  - "This iPhone directs your Choir. It doesn't lend its own power." is a great line.
  - The Android shade carries agent spend approval.
  - The Lock Screen shows "frame 3 of 7 · $0.00".

## Gaps against the prompt

**Round 1, Cinema Studio**
- Main: shot III take labels are hidden under the prompt bar fade.
- Empty state: the drop initial "E" followed by "very film begins" may read as a typo to most people. Consider a plain first word or a larger, clearly decorative initial.
- Elements: Brother Konrad's tile is a blank blue square and looks unfinished.

**Round 2, Voice and Music**
- MusicCreate: "Length 9.4 GB" reads as if the length is in gigabytes. Separate memory from Length.

**Round 3, platform**
- **Queue:** no Run next, Cancel all except current, or Cancel batch (unless they're in the ⋯ menu, which should be drawn). Done jobs show only Open, with no Keep or Discard for candidates.
- **Models:** fit chips use letter codes (P/M/L/N). The research recommended words: "Fits", "May be slow", "Won't fit". There's no Problems panel with Install all, and no version pinning.
- **Costs:**
  - No named "Alert only" vs "Hard stop" choice, and no 50/75/100% alert defaults.
  - No per-key limits with reset dates.
  - No shareable filtered view.
- **Choir:** no pinned "New device found. Approve?" row (ChoirAdd uses one-click Add, which is weaker for security). No link speeds, and no reason shown when a device can't run a job.
- **3D Studio:** missing image-preview-first, model compare, the pipeline stepper and quality presets named by use. The viewer lacks Clay, Environment and Auto-rotate. There's no 3MF export, which matters for printing.
- Onboarding doesn't use the Uncial drop initial (minor).

**Round 4, phones**
- Connect flow is missing (see Fix first).
- Home: the prompt bar has no voice input button. The status pill shows load and savings but not the server name or connection type.
- Force now is a swipe and a button. The prompt asked for a bottom sheet confirming what gets paused.
- Push notifications: no "Your track is ready" or "Job failed on Laptop, retry on Studio PC?" banners (the Android shade comes close).
- Phone Library (modality filter, full-screen players, 3D viewer, Share and Save) is not drawn.
- Phone Costs with budget alerts are not drawn.
- Phone Settings (several servers, revoke keys, Face ID lock) are not drawn.
- Choir on the phone has no Server / Opportunistic switch per device.
- PhoneClone exists, but the prompt kept pro cloning off the phone. If it's instant cloning, label it that way and add "Continue on Studio PC" for pro.
- Small inconsistency: the widget shows "$41" and the Lock Screen shows "$41.20". Pick one rounding rule.

## Scope note

Photo and Design studios (PhotoEdit, logo concepts, brand kit) were not in the prompt. They look good, and Design Kit's own palette is fine as content. But they add build scope before the challenge closes on 2026-10-30. I'd mark them post-challenge so nobody builds them now.

## Follow-up prompt for Claude Design

Paste this into the same Claude Design project:

> Great work on Hildegard · Studio. Please do one more pass and keep everything else as it is.
>
> 1. Raise contrast on the small estimate line inside every green Create button to at least 4.5:1 (try #e6ece0). Lighten VoiceSpeak's secondary grey to about #8a8a84.
> 2. Phone Connect flow, iOS and Android: scan the desktop QR code, or choose Tailscale (recommended) or your own Cloudflare Tunnel. Then a trust step with the device name, its fingerprint and "Only your devices can reach this". Then success, failure, and "Studio PC is asleep" states.
> 3. Live Activity: compact reads "Rendering 3/7 · Studio PC". Expanded has the step, progress and one Stop button. Add the end state "Still working. Open Hildegard".
> 4. Phone screens still missing:
>    - Library with modality filter, full-screen audio and video players, a 3D viewer, and Share and Save to device.
>    - Costs with budget alerts.
>    - Settings with several servers, view and revoke keys, and a Face ID or fingerprint lock.
>    - Push banners for "Your track is ready" and "Job failed on Laptop, retry on Studio PC?".
>    - Force now as a bottom sheet that says what gets paused.
>    - A Server / Opportunistic switch per device in phone Choir.
>    - A voice input button in the Home prompt bar.
>    - A status pill naming the server and connection type.
> 5. Queue: show Run next, Cancel all except current and Cancel batch. Done jobs with candidates get Keep and Discard.
> 6. Models: replace the P/M/L/N chips with the words "Fits", "May be slow" and "Won't fit". Add a Problems panel with Install all, and show the pinned version.
> 7. Costs: name the two limit modes "Alert only" and "Hard stop", default alerts at 50/75/100%, per-key limits with reset dates, and a "Copy link to this view" action.
> 8. Choir: a pinned "New device found: Laptop. Approve?" row instead of one-click Add, link speed per device, and a plain reason when a device can't run a job.
> 9. 3D Studio:
>    - Show an image preview first, then the pipeline stepper (image, shape, texture, export).
>    - Compare two models side by side.
>    - Quality presets named by use (Quick look, Game asset, Print).
>    - Viewer modes Clay, Environment and Auto-rotate.
>    - 3MF export.
> 10. Small fixes:
>     - Main: keep shot III take labels clear of the prompt bar fade.
>     - Empty state: make sure the drop initial doesn't read as a typo.
>     - Elements: give Brother Konrad a real portrait.
>     - MusicCreate: separate memory from Length.
>     - Use one rounding rule for Saved this month on the widget and Lock Screen.
>     - Fix the ARIA issues: label the voice listbox, use tabs or aria-pressed for the tag tabs, use options in the @ picker, make the Main play control a button, and name the Phone swatch button.
> 11. End with the list of new components and tokens you needed, so I can add them to the design system.
