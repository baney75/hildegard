# Image editing: retouching, cutouts, compositing, restoration

Load this for any work on existing images: the user's photos, scans, renders, AI bases, product shots, portraits, composites, thumbnails and covers. The craft goal: **every edit is invisible, or else deliberate.** A composite should look photographed; a retouch should look like a good day, not a filter.

## Ground rules

- **Non-destructive, always.** Keep the original untouched. Work in layers or in scripts that write new files, and keep an edit list. Work in 16-bit or float for any heavy tonal change, and convert to 8-bit only at export.
- **Color management.** Know the working space (sRGB for screens; Display P3 if the destination supports it; Adobe RGB or CMYK proofing for print). Convert, don't just assign, when changing spaces. Embed the profile on export.
- **Privacy.** Strip GPS and other EXIF data before anything is published (5f).
- **People's faces.** Retouch only what the person would want retouched: blemishes, stray hairs, glare. Never change face shape, body shape, skin color or identity unless the subject asked. Never "restore" a face into someone else.

## Core operations

**Tone and color.** Do these in order:
1. **White balance** from something neutral in the scene.
2. **Exposure and black/white points:** check the histogram, but don't clip what matters.
3. **Contrast with curves:** an S-curve for punch; lift the blacks for a matte look.
4. **Local dodge and burn** to steer the eye. This is the classic darkroom method: brighten the focal point, darken the edges and distractions.
5. **Saturation and vibrance,** sparingly.

See `color.md` for grading.

**Retouching:**
- **Frequency separation:** split the image into a low layer (color and tone) and a high layer (texture). Smooth blotchy tone on the low layer while keeping the pores on the high layer. Overdoing it makes plastic skin, the most common retouching failure.
- **Healing and cloning:** sample from matching texture and light, and vary the source so no pattern repeats. For large removals, use content-aware fill or inpainting. An AI model is allowed with disclosure; check the fill at 100%, because inpainting invents plausible but wrong details.
- **Sharpening** goes last, at output size. Use unsharp mask or high-pass on the luminance only. Halos at edges mean it's overdone.
- **Noise:** denoise before sharpening. Add a little grain back after heavy edits, so the result matches the rest of the image.

**Cutouts and background removal** (`scripts/cutout.py`):
- **Models, best first (2026):**
  - BiRefNet and BRIA RMBG-2.0 for general subjects (RMBG-2.0 is open, but check its license for commercial use);
  - SAM 2 when you need to pick a specific object by clicking or boxing it;
  - a hosted service such as remove.bg for the hardest hair, if the user allows uploading.

  In a 2025 benchmark, the best open model trailed the best commercial one by about two points. The gap was mostly in hair.
- **The matte is the work:**
  - check the edge at 100% on black, then on white;
  - halos show on one, chopped hair on the other;
  - refine hair with a matting model or by hand: a soft brush on the mask, following the hair direction.
- **Color decontamination:** edge pixels carry the old background's color (green fringe from a green field). Remove that spill (`--decontaminate`), or the subject looks pasted on (pitfall 22).
- **Feather by the subject's real edge:** sharp for a product in focus, soft for hair or for anything out of focus.

**Compositing** (making separate images into one believable photograph). Check each of these:
- **Perspective and lens:** match the horizon line, the camera height and the focal length. A subject shot from below cannot stand in a background shot from above.
- **Light:** the same direction, hardness and color temperature on every element. Relight the subject (dodge and burn, a color layer on the lit side) rather than hoping it matches.
- **Contact and shadows:** add a contact (occlusion) shadow where the subject touches the ground; it is the darkest and sharpest shadow in the area. Then add a cast shadow following the light (pitfall 8).
- **Color and tone:** match the black point, white point and saturation. Match the color cast of the shadows; grade the whole composite together at the end.
- **Focus and depth:** match the blur to each element's distance. Something in the background can't be sharper than the subject.
- **Grain and noise:** match them across every element. A clean cutout in a grainy scene looks pasted on.
- **Edges and light wrap:** let a little of the background's light spill onto the subject's edges. Add atmospheric haze for distance.
- **Reflections:** wet floors, glass and eyes must reflect the composited elements.

**Blending and meshing** (making two images into one surface):
- **Masks and gradients:**
  - use a soft gradient mask where the two images meet;
  - align them first, by features (matching keypoints) or manually;
  - match tone across the seam before blending.
- **Poisson blending** (OpenCV's `seamlessClone`): the source keeps its texture but takes the target's tone and color at the seam. Use it for patches and for objects inserted into a surface.
- **Multiband (Laplacian pyramid) blending:** low frequencies blend over a wide zone, high frequencies over a narrow one. It is the panorama-stitching method, and the best for joining two photos.
- **Texture onto form (displacement):** to wrap a pattern or label onto a curved or folded surface, displace it with a map made from the surface's own luminance, then multiply it by the surface's shading.
- **Meshing in 3D sense** (turning images into geometry: photogrammetry, depth to mesh): see `sculpture-3d.md`.

**Upscaling and restoration:**
- **Upscaling:** use a model upscaler (Real-ESRGAN class, or a diffusion upscaler) for enlargement. Check faces and text at 100%; upscalers hallucinate letters and features. Never upscale a source and then present it as original resolution.
- **Restoring old photos:**
  1. Scan at 600 dpi or more.
  2. Remove dust and scratches (healing and cloning).
  3. Fix fading with curves per channel.
  4. Colorize only if the user asks, and research the real colors (uniforms, hair, places).
  5. Keep an unrestored copy.

**Perspective and geometry:** correct converging verticals in architecture (keystone correction), straighten horizons, and fix lens distortion with the lens's own profile.

## Thumbnails, covers and feed images

- Design for the smallest size it will be seen at: the feed (pitfall 18), a YouTube thumbnail (1280×720, judged at about 320 px wide), an album cover (3000×3000, judged at about 200 px).
- **One focal subject, high value contrast, at most three words** on a thumbnail, readable at that size.
- **Faces with a readable expression** draw the eye most. Use the expression the piece's claim needs, not stock surprise.
- Check the image on the platform's real background, light and dark, and around its UI (avatar, play button, timestamp).

## Tools

- **Python:** Pillow, OpenCV (`seamlessClone`, `inpaint`, feature matching), scikit-image, numpy, rembg, Real-ESRGAN.
- **GIMP** from the command line, and **ImageMagick** for batch work.
- **The user's own apps** (Photoshop, Affinity, Pixelmator) are often fastest for brush work on a mask. Hand them a clean layered file (PSD through `psd-tools`, or layered TIFF) with the masks done, rather than a flattened image.
- **AI edits** (inpainting, relighting, outpainting), with the user's okay and disclosed: use Hildegard's own models first (`make_character_stills`, or a held shot), or another image tool the user has connected.

## Checklist

- [ ] The original is untouched, and the edit list is kept.
- [ ] Edges are checked at 100% on black and on white: no halo, no fringe, hair intact.
- [ ] Composites match in perspective, light direction and temperature, contact shadow, black point, blur and grain.
- [ ] No plastic skin, no repeated cloned texture, no invented text or features from inpainting or upscaling.
- [ ] Color space is correct and embedded; EXIF and GPS are stripped for publishing.
- [ ] It reads at the size where it will be seen.
