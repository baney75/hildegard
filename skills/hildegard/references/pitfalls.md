# Why pieces come out bad (from real prior work)

Read this before building anything, every time. Each pitfall names the piece it came from, what happened, and the check that would have caught it. `SKILL.md` refers to them by number.

Pitfalls 1–6, 13, 14, 18–20, 25–28, 31–33 and 35 apply to every medium. Pitfalls 7–12, 15–17, 21–24, 29, 30 and 34 come from pictures and film, and apply to 3D renders and sculpted figures too. The song pitfalls are in `references/song-suno.md` and the music-video pitfalls in `references/music-video.md`. Each domain file ends with its own checklist.

1. **Made before the user was asked.** In Hoc Signo Vinces needed three corrections after delivery:
   - the medium: dots or ASCII, not a flat emblem;
   - the meaning: DGX Sparks, because the point was "conquering through local AI";
   - the real hardware detail: ports and cables.

   All three were knowable in the interview. The interview catches the medium, the claim and the true details before the first mark, note or word.
2. **Weak figures hidden in a strong design.** We Hold the Compute's hands were simple shapes, not anatomy. In Now the Machine Brands Man, both blind critics called the people "blocky mannequins" after the rest of the piece was strong. Figures, hands and faces made in code, whether drawn or sculpted, are the usual weak point. Plan for them; don't hope. When figures carry the claim, decide in the interview how they'll be made: a rig built from reference photos, the user's photo, an AI base with the user's okay, or a deliberate stylization such as backlit silhouettes or tenebrist shadow that hides what code can't draw.
3. **Too busy.** The Right to Intelligence poster was called "too busy" and "cluttered" more than once. Depth means layers of meaning and fine detail inside a simple composition, not more objects. The same failure shows up as too many voices in music and too many images in a poem.
4. **Last change never checked.** The Ninth Hour's final adjustments shipped without a new render. Every change gets re-rendered, re-measured or re-read before delivery.
5. **Destination ignored.** An 8.7 MB PNG went to X, whose image limit is 5 MB. Letterforms and laurel leaves that worked at full size broke at feed size. Where the piece lives sets its size, format, smallest legible detail, loudness, printer limits and reading length.
6. **Research as decoration.** Facts pasted in as labels. Research has to change what gets made: the right inscription, the real object, the canonical color, the true port layout, the actual hymn tune, the exact verse.
7. **Hands fixed one round at a time.** The hands in Don't Quit took five rounds of feedback ("pill-like", "still looks bad", then proportions). Build a real hand once, before the first delivery, and check it at 100% against a reference photo:
   - the palm about as long as the middle finger;
   - each finger in three tapering segments, with knuckle breaks and nails;
   - the thumb rooted low on the side of the palm, opposing the fingers;
   - the fingers wrapping around whatever is held.
8. **Contact faked.** A man "sitting" floated in front of his chair. Wherever a body meets an object, the contact must show:
   - the pelvis on the seat, with the thighs along it;
   - the feet planted;
   - the chair and the body hiding each other in the right places;
   - the fingers closing around what they hold.
9. **Props facing the camera instead of the character.** The Bible faced the viewer while he read it. Objects face whoever uses them.
10. **Flat staging with perspective added later.** Perspective took two full rounds. Set the camera first:
    - one vanishing point per shot, at eye level;
    - every receding edge runs to it;
    - boxes show only their visible faces;
    - windows and doors have depth;
    - floors and ceilings carry receding lines.

    In 3D the camera is real, so choose the lens and the camera height on purpose.
11. **Unmotivated light.** The user had to say: "Make sure lighting is logical." Every bright area needs a source, shown or clearly implied. A patch of light is the source's shape, projected the right way. A shadow is light held back, never dark paint laid on top. A window frame's shadow on frosted glass is softer and dimmer than the frame itself.
12. **Painterly blur eating small details, and stamped effects.** In Don't Quit:
    - a pendant lamp painted into the background became a glowing blob;
    - a lightning silhouette redrawn by hand didn't line up with the painted church;
    - a projected cross read as a mark painted on the glass.

    Small, high-contrast details (lamps, text, faces, crosses, screens, hands) go on top of the painted layer, crisp; in a film, they are drawn every frame. Effects that change existing shapes (silhouettes, flashes, reveals) are built from a mask of the real geometry.
13. **Fixing only the instance the user pointed at.** The same flaw is almost always elsewhere. Fix the whole class of problem across the piece, then show that you did:
    - every hand;
    - every shot;
    - every section of a track;
    - every face of a model;
    - every stanza.
14. **An invented symbol read as something else.** In Now the Machine Brands Man, the machine's mark was a horned, armed figure after the sign of Tanit. Glowing on the end of a branding iron near a furnace, it read to two blind critics as "a child fed to the fire." The subject's genre (Moloch, so child sacrifice) told them what to see. Test every invented symbol at its smallest use size, in context, before building around it: show it alone to a fresh eye and ask "what is this?" Keep figure-shaped symbols away from places where a figure could also be.
15. **The claim hinged on the weakest-drawn element.** The thesis was "the machine brands man." The man being branded was a dim, half-drawn kneeling shape, so the brand floated free and changed the meaning. Find the one element the claim depends on (the receiver of the action, the face, the held object) and give it the most care: the best figure work, its own light, and the crisp layer from pitfall 12. Make an action read through its receiver, not through the tool alone.
16. **The second medium dimmed the first.** When the painting dissolved into ASCII, the code cells darkened every glow they touched. The fill glyphs (`@ % e`) read as generic filler, or as "encoding errors." Text that only replaced scattered cells broke into "A E 7" fragments that read as glitch. When converting into a mark-based second medium, preserve the far tone. Make the dense fill carry meaning, and keep any text unbroken (see the ASCII bullets in `images.md`).
17. **A foreign block pasted on, and a pale mass stealing the eye.** The throne, rendered as code inside a hard dark rectangle, read as "a phone screen pasted onto a painting." The machine on it was the largest light-gray mass, so it outranked the small furnace. Every element, in any medium, takes the scene's light (here, firelight from below) and has a silhouette of its own, not a panel's. Size counts as much as contrast: darken big secondary masses until the focal point is the brightest thing that also has room around it.
18. **The hero detail was too small for the destination.** In Who Do You Say That I Am?, the viewer's reflection in Christ's pupil was about a tenth of the frame's width. At feed size the blind critic saw "a blue smudge," so the punchline didn't land. Before composing, work out how big the element the claim hinges on will be on the destination screen. An X post on a phone is about 400 CSS px wide, and the hero needs to be about 40 px tall or more there. Crop around the hero, not around the subject. Judge the work on a preview at roughly 420 px wide, because that is the size most people will see.
19. **Original-language text handed to the user before it was checked.** Mid-interview, the Peshitta of Matthew 16:15 was given with ܥܠܝ ("about me"). That word belongs to the parallel in Mark 8:29, and research only caught the error later. Verify scripture and other source-language text against a primary source before stating it, in conversation as much as in the piece. When an earlier answer was wrong, correct it openly in the delivery.
20. **A missing glyph rendered as a box.** A bullet separator inside the Syriac iris text had no glyph in the Syriac font, so it drew as a "tofu" box. Check every character's coverage in the chosen font (fontTools `cmap`, or `font.getmask(ch).getbbox()`), and use the script's own punctuation instead (Syriac ܀, Hebrew ׃, Greek ·).
21. **The paint pass erased the thin dark details.** Brow hairs, lashes and blood vanished because the stroke-error test averaged over grid cells and fine lines fell under the threshold. Build in layers (see "Layer stack" in `images.md`): a faint version of each fine detail in the underpainting for its tone, the strokes, then the crisp detail composited on top.
22. **A crisp region with a hard edge read as pasted on, and so did a "filter" look.** In Who Do You Say That I Am?, a clean procedural eye sat inside painted skin, and the critic read it as "clashing styles: painterly skin filter, clean digital eye, vector thorns." Feather the crisp mask inside the object, so that the paint reaches the iris's edge. Light every layer with the same source, and give flat vector shapes real shading (a distance-field profile, grain). Square-capped strokes in even short rows look like a Photoshop oil-paint filter, so round the stroke caps and vary stroke length.
23. **A tiny figure read as a child, then as a robot.** A big round head with simple features read as "a child." A rim light along the tops of the shoulders then made a T-bar that read as a robot. Use adult proportions even at small sizes: the head no wider than about a third of the shoulders, and a jaw narrower than the cranium. Don't let rim lights draw geometric bars. Ask a fresh eye "who is this, and how old?"
24. **Fluids without a cause or any interaction with the surface.** Blood started in mid-forehead with a pin-head bead, then ran straight through the brow as if the hairs weren't there. A fluid starts at a visible cause (the thorn tip in the skin). It pools and widens where it meets hair or a fold, thins as it runs, and ends in an elongated drop. Blood is darker and browner than "red."
25. **A hidden layer nobody can find, and dead space.** The text in the iris was "practically invisible even at 100%." The bottom quarter of the frame was empty black holding one small line of script. The up-close layer must be findable at 100%, at a luminance difference of about 15% or more from its ground. Every region of the frame must do work; if it doesn't, crop it.
26. **A stray highlight.** A tear bead too small to read became a white speck that looked like a defect. If an effect doesn't read at 100% and at feed size, enlarge it or delete it.
27. **The user had to interrupt to steer.** Mid-build, the user broke in to say "I like the crown of thorns being shown." Once a full composition exists, send its thumbnail right away and ask for one reaction before polishing. Add whatever the user says to the standing requirements at once.
28. **Realism didn't match the brief.** In Making an Icon of the Word, the brief was "It needs to look like Christ… as though God is truly among us." The agent still built a capsule-and-polygon hand because it was quick to code, deferring the hard part, though this skill already named figures as the usual weak point. The user stopped the work on sight: "the hand must look real." Read the realism level the brief implies, and decide in the interview how each face, hand and limb will be made. Render the hardest part first, alone, and judge it at 100% before building anything around it (`references/code-rendering.md`).
29. **A feature built as a symbol, not from its anatomy.** The nails were ellipse "stickers" on the fingers ("the nails must be realistic"). For any anatomical feature, list its parts before modeling it: plate, lateral folds, cuticle, lunula, bed, free edge, gloss. If you can't list them, research them first.
30. **Only the visible part was drawn.** The forearm floated out of the sleeve because the agent never asked where the shoulder and elbow were. The user sent three icons that all answered that question. Trace every limb from its root joint (shoulder, elbow, wrist, hand) with lengths from a canon, even where cloth hides most of it. A forearm aimed at the viewer keeps its length as depth.
31. **The subject was researched, but not the craft.** The iconography was researched to the inscription, while the craft of drawing bodies, the part most likely to fail, wasn't researched at all. Research the craft as hard as the subject, then turn every canon into a measurement and run it on your own output. Measured with `scripts/canon_check.py`, the face's thirds came to 288 / 458 / 382 px: a forehead far too short, visible all along.
32. **An unrequested change bundled into a requested one.** A pose fix went out with an unrequested nail sliver, and the user stopped it mid-flight. Make one requested change per step and show it before compounding.
33. **Realism is relative.** Once the hand became real, the flat face, hair and drapery beside it became the defects. After any part improves, re-audit its neighbors at 100% and raise them to its level, or the improvement makes the piece worse.
34. **A seam where every ring of text started.** Every ring of words started at angle 0, leaving a dark radial seam, and ring direction flipped from run to run. Give rings a random start angle and a fixed reading direction, and check the ring at 100% where the lines meet.
35. **Reference photos and provenance.** The user supplied a licensed stock photo for the blessing hand. It was used for the pose only and none of its pixels were used, which was right; say so in the delivery. Licensed or third-party images inform pose and proportion only, unless the user owns them or has the right to transform them.
