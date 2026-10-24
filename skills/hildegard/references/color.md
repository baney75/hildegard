# Color: theory, palettes, color coding, correction and grading

Load this for any piece where color decides the result: grading a film or photo, building a palette or a color script, or color coding information (charts, maps, systems, covers, a series). The color basics in `images.md` (5a) still apply; this file goes deeper.

## Sources

- **Josef Albers, *Interaction of Color* (1963):** color is relative. The same swatch changes with its neighbors, so judge every color in context.
- **Johannes Itten, *The Art of Color* (1961):** the seven contrasts: of hue, light-dark, cold-warm, complementary, simultaneous, saturation, extension (proportion).
- **James Gurney, *Color and Light* (2010):**
  - light temperature, with shadows in the complementary temperature;
  - atmospheric perspective;
  - gamut mapping: choose a limited gamut shape on the color wheel and paint only inside it;
  - the color script.
- **Margaret Livingstone, *Vision and Art* (2002):** value carries form, depth and motion through a color-blind pathway. Equiluminant colors vibrate and lose their edges.
- **Alexis Van Hurkman, *Color Correction Handbook* (2nd ed., 2014) and *Color Correction Look Book*:** professional film grading, from primaries through secondaries to looks.
- **Pixar's color scripts** (Lou Romano, Ralph Eggleston): a strip of small frames showing the whole film's emotional color arc at a glance.
- **Colorblindness research and Cynthia Brewer's ColorBrewer** (for maps): palettes that stay distinct for color-blind viewers and in print.

## Palettes

- **Start from value, then pick hues.** Build the palette as a value ladder first (darkest, mid, lightest), then assign hues.
- **Dominant, supporting, accent:** about 60/30/10 of the area. The accent is the most saturated color, and it marks the focal point.
- **Limited gamuts** (Gurney): pick a triangle or other shape on the wheel and use only colors inside it, so the picture holds together.
- **Symbolic color comes from research,** not habit: liturgical colors, period dyes, a brand's or object's real colors, heraldry.
- **Test it in context:** put the palette on a gray, a black and a white ground (Albers) before committing.

## Color coding (color as information)

Use this when color must mean something: data, maps, diagrams, a series, a recurring motif.

- **Pick the palette by the data's type:**
  - categories (no order): distinct hues at similar lightness;
  - sequences (low to high): one hue, light to dark;
  - diverging data (below and above a midpoint): two hues meeting at a neutral.

  For charts, load the `dataviz` skill when present.
- **No meaning by hue alone.** About 8% of men have red-green color deficiency. Back every color code with value difference, labels, patterns or position. Simulate deuteranopia and protanopia (for example with `colorspacious` or the Coblis simulator) and check that the code still reads.
- **At most 6–8 categorical colors.** Past that, viewers can't hold the mapping; group or label instead.
- **Keep the code consistent** across every piece in a series. Write the mapping into the visual bible (`music-video.md` step 4) or into `decisions.md`.
- **Color motifs in narrative work** (a recurring color tied to a character, a theme or a turn): introduce it, repeat it, transform it at the turn. This is the color-script version of a motif.
- **Contrast for text:** WCAG ratios, at least 4.5:1 for body text and 3:1 for large text.

## Correction and grading (film, video, photo)

**Correct, then grade.** First make it right, then make it say something. Work in this order:
1. **Technical normalization.** Convert log footage to a display space with the camera maker's LUT or a color-managed transform (ACES, or DaVinci Wide Gamut / Intermediate). Never grade log footage by eye.
2. **Primary balance:** match the black point, white point and white balance on a neutral reference. Use scopes, not your eyes (see below).
3. **Shot matching:** every shot in a scene matches the hero shot in exposure, balance and contrast. Match skin tones first; viewers notice skin before anything else.
4. **Secondaries:** isolate elements by hue, saturation or luminance key, or by power window (a shape mask), and adjust them: skin, sky, a single object that must carry the eye.
5. **The look:** the creative grade that serves the claim. It can be split-toning (shadow and highlight hues), a contrast curve, a palette limit, or a film emulation (grain, halation, print stock). Keep skin in a believable range unless the claim needs it not to be.
6. **The color script:** the grade changes with the story (pitfall 4 of film: the arc in the grade).
7. **Output:** Rec.709, gamma 2.4 for broadcast; sRGB for the web; HDR (Rec.2100 PQ or HLG) only when the destination supports it. Check on a calibrated display, or at least on two different screens and a phone.

**Scopes** (read them, don't eyeball):
- **Waveform:** luminance by position. Blacks sit at about 0–5%, highlights below 100% unless they are speculars.
- **Vectorscope:** hue and saturation. Skin tones of every ethnicity fall near the "skin tone line," between red and yellow. Watch for saturation beyond the broadcast-safe limit.
- **RGB parade:** balance per channel. In a neutral, the three channels line up.
- **Histogram:** the distribution of values, and any clipping.

In code, render scopes with ffmpeg: `waveform`, `vectorscope` and `histogram` filters. For example, `ffmpeg -i in.mp4 -vf "split[a][b];[b]waveform=g=green:fl=1[w];[a][w]vstack" -frames:v 1 scope.png`.

**Common looks, and what they say:**
- **Teal-orange** (skin against complementary shadows): blockbuster, and a cliché unless chosen on purpose.
- **Bleach bypass** (low saturation, high contrast): war, grit.
- **Warm amber nostalgia;** cold blue-green isolation.
- **Monochrome with one accent color:** the accent is the claim.

Choose by meaning, never by default.

**In code:**
- ffmpeg's `curves`, `colorbalance`, `colorchannelmixer`, `eq`, `lut3d` (with `.cube` files), `colortemperature` and `selectivecolor`. Use `lut3d` to apply a look consistently across a whole film.
- numpy for stills, working in linear light for exposure and blending math (convert from sRGB, apply, convert back).
- DaVinci Resolve (free) when the user has it: the industry tool. Hand off with a timeline (OpenTimelineIO, EDL or XML) and the conformed media.

## Checklist

- [ ] Every color decision is a choice with a reason, recorded in the bible or `decisions.md`.
- [ ] The image reads in grayscale.
- [ ] Color codes are backed by value, label or pattern, and checked with a color-blindness simulation.
- [ ] Shots match within each scene, and skin sits on the skin-tone line unless deliberately pushed.
- [ ] Nothing is clipped that matters (checked on the waveform), and saturation is within the destination's limit.
- [ ] The grade follows the color script across the whole piece (checked on a contact sheet).
