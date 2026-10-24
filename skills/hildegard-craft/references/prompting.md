# Writing prompts for Hildegard's models

## The shape

One or two plain sentences, in the order things happen:

> **Who or what** + **doing one thing** + **where** + **in what light, when** + **one specific detail**.

> An old fisherman in a yellow oilskin hauls a crab pot over the rail as spray hits the deck; grey dawn, gulls behind
> him, rust running from the winch bolts.

Rules:

- **Literal, not poetic.** "Rain runs down the window" works; "tears of the sky" gets you a crying sky.
- **One action per shot.** Video models give a few seconds; two actions become one blurred morph.
- **Say what is there, not what isn't.** "An empty street", not "a street with no people".
- **No quality words.** "8k", "masterpiece", "cinematic", "hyperrealistic", "award-winning", "stunning", "epic". They
  make every result look the same.
- **No camera words in the prompt.** Hildegard sets the camera from fields: `camera_body`, `lens`, `focal_mm`,
  `aperture`, `motion`, `lighting`, `palette`, `genre`, `era`, `aspect`. Ids come from `list_presets`.
- **Repeat continuity details word for word** in every shot of a sequence (see slop.md, "A continuity list").
- **12 to 120 words.** Shorter leaves the frame to defaults; longer and the model drops details at random.

## Choosing the camera

| You want | Fields |
| --- | --- |
| Intimate, a face, a hand | `focal_mm` 50 to 85, `aperture` 1.4 to 2.8, `motion` `static` or `dolly-in` at low strength |
| A place, a person small in it | `focal_mm` 24 to 35, `aperture` 5.6 to 11, `static`, `crane-up` or `pull-back-reveal` |
| Tension | `static` then a cut; or slow `dolly-in`; `hard-practical` lighting |
| Memory, warmth | `super-8` or `vintage-16mm`, `faded-print` or `honey-moss` |
| Plain truth | `documentary` body, `even-daylight`, `handheld` at low strength |
| Black and white | `palette` `silver`; then light matters more, so name the source |

Use at most one camera move per shot unless the two belong together (a `follow` with a `rack-focus`). Keep
`motion_strength` at 0.4 to 0.6 for people; 0.8 and up makes faces and hands unstable.

## Models

| Model | Good at | Watch for |
| --- | --- | --- |
| LTX-2.5 distilled | Up to 10 s, with sound generated alongside; fast | Hands in fast motion; keep the action simple |
| LTX-2 distilled | Camera-move LoRAs | Same as above |
| Wan 2.2 5B | Apache-2.0 license, steady motion, up to 5 s, no sound | Short; plan sequences of 3 to 5 s shots |

`hildegard_status` says which are installed. Wan has no sound: add sound in the edit (hildegard-video-edit).

## Drafts and finals

Draft at `quality: "draft"` with `takes: 2`. Review both. When one is right, render it again with `quality: "final"`
and the **same seed**, and review again: finals can differ in detail.

## Start frames

`start_frame_path` anchors a shot to an image: a photo your user gave you, a still from a previous shot (for
continuity), or a frame you prepared. The shot begins exactly there, so put the composition right in the image first.
Only use photos of people who agreed to it.
