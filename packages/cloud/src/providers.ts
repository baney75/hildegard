// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Where Hildegard can rent or borrow a GPU, what each is good for, how private it is, and what its terms allow.
 * `hildegard cloud` shows this; docs/cloud.md explains it.
 */

export interface Provider {
  id: 'runpod' | 'huggingface' | 'colab';
  name: string;
  /** How Hildegard uses it. */
  mode: string;
  /** Who can see the prompts and videos. */
  privacy: string;
  /** What the provider's terms mean for it. */
  terms: string;
  termsUrl: string;
  /** The command that sets it up, for an agent. */
  command: string;
  /** False while it is designed but not built yet: `hildegard cloud` says so instead of pretending. */
  ready: boolean;
}

export const PROVIDERS: Provider[] = [
  {
    id: 'runpod',
    name: 'Runpod',
    mode: 'A GPU joins your fleet: renders go there as to any of your devices, and it stops itself when idle.',
    privacy:
      'The GPU is Runpod’s and its HTTPS proxy carries your prompts and videos; secure cloud (the default) runs in Runpod’s own data centres, community cloud on other people’s machines.',
    terms: 'Runpod rents GPUs for exactly this; billed by the second to your Runpod account.',
    termsUrl: 'https://www.runpod.io/legal/terms-of-service',
    command: 'hildegard cloud runpod up --json',
    ready: true,
  },
  {
    id: 'huggingface',
    name: 'Hugging Face Jobs',
    mode: 'A batch: Hildegard packs the shots, a Job renders them on a Hugging Face GPU, and the videos come back into your films.',
    privacy:
      'Runs in your Hugging Face account; shots and videos pass through a private dataset repository of yours.',
    terms: 'Jobs are pay-as-you-go compute on your account (a PRO, Team or Enterprise plan or credits).',
    termsUrl: 'https://huggingface.co/terms-of-service',
    command: 'hildegard cloud hf run <film> --json',
    ready: false,
  },
  {
    id: 'colab',
    name: 'Google Colab',
    mode: 'A notebook you run yourself: it renders a batch of shots and saves the videos to your Google Drive.',
    privacy: 'Runs in your Google account; shots and videos pass through your Drive.',
    terms:
      'Colab forbids remote proxies, web services and (on free runtimes) remote UIs and distributed workers, so Hildegard never joins Colab to your fleet: the notebook renders in front of you and stops. Paid runtimes are steadier.',
    termsUrl: 'https://research.google.com/colaboratory/faq.html',
    command: 'hildegard cloud colab pack <film> --json',
    ready: false,
  },
];
