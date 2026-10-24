# The slop catalogue

Each entry: what it looks like, why it happens, how to catch it, and what to do instead. "Check" names the
`review_take` / `hildegard review` check or rubric question that catches it.

## Pictures (stills and video frames)

| Mark | Why it happens | Check | Instead |
| --- | --- | --- | --- |
| Glossy, oversaturated, glowing colour | Quality words in the prompt; models trained on attention-seeking images | `colour`, rubric `colour` | Delete quality words; pick a palette preset (`faded-print`, `honey-moss`, `silver`) or describe a restrained one; grade saturation down |
| Teal shadows, orange skin on everything | The default "cinematic" grade | rubric `colour` | Choose the palette for the story; `steel-rust` only when it means something |
| Subject dead centre, nothing else considered | No composition in the brief | rubric `subject` | Decide the subject's place: a third, or centred for a reason |
| Generic place, generic person | No specifics in the prompt | rubric `specific` | One true detail per shot: a material, a mark of use, a local object |
| Waxy, airbrushed skin; plastic materials | "Perfect", "flawless", "beautiful" in prompts; heavy denoising | rubric `surface` | Describe texture (pores, wool, rust); use a film body preset for grain |
| Melting or extra fingers, wrong teeth, odd eyes | Diffusion models are weak at hands and faces in motion | rubric `anatomy` | Another seed; frame hands out; simplify the action; a tighter or wider shot |
| Garbled lettering on signs and screens | Models draw the shape of text, not text | rubric `text` | Remove writing from the prompt; add real text in the edit |
| Light from nowhere, shadows that disagree | No light source in the prompt | rubric `light` | Name the source and time of day; choose a lighting preset |
| Blown highlights, crushed blacks | Exposure left to chance | `highlights`, `shadows` | Lower the light in the prompt, pick another take, or grade |
| Flat, grey, washed out | Over-correcting away from oversaturation | `contrast` | Give the scene a key light and a dark area |

## Motion (video)

| Mark | Why | Check | Instead |
| --- | --- | --- | --- |
| Several half-finished actions blending | Too many beats for a few seconds | lint `too-many-beats`, rubric `one-action` | One action per shot; split into a sequence |
| Morphing objects, popping limbs, identity drift | Unstable generation | rubric `stable` | Another seed; shorter clip; less `motion_strength`; a start frame |
| Brightness pumping frame to frame | Unstable generation, strong motion | `flicker` | Another seed; a steadier light; less motion |
| A still image passed off as video | The model stalled | `frozen` | Another seed, or a clear action in the prompt |
| Camera moving for no reason | Moves chosen because they're there | rubric `motivated-camera` | Lock the camera unless a move reveals or follows something |
| Floaty, weightless movement | Physics left to the model | rubric `physics` | Slow, simple actions; contact with the ground and objects |

## Sequences and edits

| Mark | Why | Check | Instead |
| --- | --- | --- | --- |
| Faces, clothes, light change between shots | Each shot prompted separately | rubric `continuity` | A continuity list (below) repeated word for word in every prompt; fixed lighting and palette presets; start frames |
| Cuts that change nothing | Shots made because they could be | rubric `cut` | Each cut changes size, angle or information, on an action or a look |
| Padding: establishing shots of nothing, slow-motion for length | Filling time | rubric `length` | Cut it. Shorter is better. |
| Transitions (spins, glitches, flashes) on every cut | Hiding weak cuts | rubric `cut` | Straight cuts; a dissolve only for time passing |
| Music that fights the picture; "epic" library music | Mood words only | lint `mood-only`, rubric `fits` | Music for the scene: instruments, tempo, where it rises |

### A continuity list

Keep one per film and paste the relevant lines into every shot's prompt, word for word:

```
Mara: woman, about 40, short grey-streaked black hair, small scar through left eyebrow, navy wool peacoat, red scarf.
The bakery: narrow, white tiled walls, brass scales on the counter, flour on the dark wooden floor, one window left.
Light: early morning, low sun through the left window, warm; the rest of the room cool and dim.
```

## Sound

| Mark | Why | Check | Instead |
| --- | --- | --- | --- |
| Crackle, distortion | Clipping | `clipping` | Lower the level before the limiter; keep peaks under -1 dBTP |
| Too loud and squashed, or too quiet | No loudness target | `loudness` | About -14 LUFS for web and phones, -16 for podcasts and speech, -23 for broadcast |
| Clicks at every cut | Hard audio cuts | rubric `clean` | 5 to 20 ms fades at every audio edit |
| Robotic, even, breathless voice | Text written for reading, not speaking | rubric `delivery` | Short sentences; punctuation for pauses; re-generate the bad line |
| Lyrics made of stock lines | Clichés | lint `lyric-cliches` | One concrete scene: a place, an object, a name |

## Words (titles, captions, narration, descriptions)

| Mark | Instead |
| --- | --- |
| "Delve", "tapestry", "testament to", "in a world where", "unleash", "elevate", "embark", "symphony of", "not just X but Y" | Say the plain thing with a noun or a number from this project |
| "Stunning", "breathtaking", "epic", "masterpiece" about your own work | Describe what it is; the viewer decides if it's stunning |
| Em-dashes everywhere | Full stops and commas |
| Three adjectives where one would do | Pick the truest one |

## Process

These aren't visible in one frame, but they produce everything above:

- Rendering before writing a brief.
- Not looking at the result. **Never describe or deliver work you haven't seen or heard.**
- Retrying blindly with a new seed instead of changing one thing on purpose.
- Delivering the first take that has no obvious error, instead of the best of several.
- Calling a draft final, or a check passed that wasn't run.
- Overselling the result to your user.
