Job rows list work across the Choir, and Force now explains exactly what it will interrupt.

- `hg-job` > `hg-job__thumb` (modality icon or preview), title, `hg-job__meta` (status, device, model and time in mono), `hg-job__actions`, optional `hg-job__bar`.
- Queued jobs on an opportunistic device carry `hg-btn--force`. Pressing it opens `hg-dialog` (sheet on compact) listing Interrupts, Pauses, Starts and Cost before the ember confirm. The alternative ("Wait until 11:40 pm") is always offered.
- Errors say what failed and offer a concrete retry ("Retry on Studio PC").
