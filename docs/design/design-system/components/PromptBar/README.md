The prompt bar is the single entry point for every kind of work, with cost and privacy always visible.

- Structure: `hg-prompt` > `textarea`, a row of modality chips, then a meta row with where it runs (`hg-prompt__where`), privacy, the estimate (`hg-prompt__meta` with `.hg-num`) and the Create button.
- Always show the estimate as "Est. $x · saves $y" and where the work will run. If an outside API will be used, the privacy pill changes to name it.
- The faint gold edge and sapphire halo mark it as the one live input on the screen; never repeat that treatment elsewhere.
- Textarea text is 17px so iOS never zooms. Accepts dropped files (transcribe, label, reference image).
- Consumer provides the text, the selected modality, the target device and the estimate.
