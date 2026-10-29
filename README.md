# Observational Memory on BEAM

Run Mastra's [Observational Memory](https://mastra.ai/docs/memory/observational-memory) (OM) on
[BEAM](https://arxiv.org/abs/2510.27246), the long-term memory benchmark from ICLR 2026, and score
it the way we scored the results in
[Observational Memory is state of the art on BEAM](https://mastra.ai/research/observational-memory-beam).

BEAM gives a memory system a long, generated chat between a user and an assistant, then asks 20
questions about it. The chats come in four sizes: 100K, 500K, 1M and 10M tokens. A grader model checks each
answer against a short list of points it should contain.

## Published results

Claude Opus 5.5 answering, Gemini 3 Flash grading, default OM, no system prompt. The mean of two runs.

| Size | Score | Strict score |
| --- | ---: | ---: |
| BEAM-100K | 83.3% | 81.3% |
| BEAM-1M | 80.6% | 78.6% |
| BEAM-10M | 66.4% | 64.6% |

We did not run BEAM-500K. Strict gives credit only for a full point on each rubric item. The headline is
the partial score the BEAM paper describes, where a half point counts as a half.

## How it works

Three steps, each writing to its own directory:

1. **Ingest** feeds a chat into a Mastra agent with OM turned on, one user and assistant pair at a time,
   at the original timestamps. OM's Observer and Reflector write and rewrite the notes. The finished memory is
   saved to `snapshots/`.
2. **Answer** asks every question on a fresh copy of the finished memory, so questions cannot affect
   each other. The agent is stock Mastra: no system prompt, no extra tools. OM's `recall` tool is on, so
   the agent can search the archive of every note.
3. **Judge** grades each answer against the question's rubric. Gemini 3 Flash grades, at temperature 0 and
   its lowest reasoning setting.

`pnpm report` then prints the score by ability.

## Setup

You need Node 22.13 or later and [pnpm](https://pnpm.io).

```sh
git clone https://github.com/mastra-ai/observational-memory-beam.git
cd observational-memory-beam
pnpm install
cp .env.example .env   # add your API keys
pnpm fetch-data        # about 0.9 GB: only the chats and questions the harness reads
```

The Observer, grader and embeddings use `OPENROUTER_API_KEY`. The answering model uses
`ANTHROPIC_API_KEY`, or the OpenRouter key if you set `BEAM_ACTOR=openrouter/anthropic/claude-opus-5.5`.

## Run it

Start with one conversation to see the whole loop before paying for a tier.

```sh
export BEAM_CONVERSATIONS=1

pnpm ingest 100K            # build the memory
pnpm answer 100K --judge    # answer and grade each question
pnpm report 100K            # scores by ability
```

Drop `BEAM_CONVERSATIONS` to run the whole tier. Every step skips work that is already on disk, so you can
stop and start again. Use `1M` or `10M` in place of `100K` for the larger tiers.

| To do this | Use |
| --- | --- |
| Answer without grading, then grade later | `pnpm answer 100K`, then `pnpm judge 100K` |
| Run a tier in parallel | `pnpm ingest 100K 0/4`, `1/4`, `2/4` and `3/4` in four processes. Each process takes a share of the conversations. |
| Answer the same memories again | `BEAM_RUN=2 pnpm answer 100K --judge` |
| Resume a long 10M ingest | `BEAM_RESUME=1 pnpm ingest 10M`. It keeps a checkpoint every 10 batches (`BEAM_SNAPSHOT_EVERY`). |

## Models

| Setting | Default | Used for |
| --- | --- | --- |
| `BEAM_OBSERVER` | `openrouter/google/gemini-3.8-flash` | OM's Observer and Reflector, through Mastra's model router at the provider's defaults |
| `BEAM_ACTOR` | `anthropic/claude-opus-5-5` | Answering the questions |
| `BEAM_JUDGE` | `google/gemini-3-flash-preview` | Grading, as an OpenRouter model id |
| `BEAM_RUN` | `1` | Names a set of answers |

Results land under the model names, for example
`answers/100K/openrouter/google/gemini-3.8-flash/anthropic/claude-opus-5-5-v1/`.
Changing one model re-runs only the steps after it.

The retrieval embeddings use `openai/text-embedding-3-large` through OpenRouter.

## What to expect

- **Pinned build.** `package.json` pins `@mastra/core` and `@mastra/memory` to
  `0.0.0-om-lifecycle-20261008200611`, the build our numbers came from. It has the OM fixes we found while
  running BEAM, including the Reflector instruction that keeps concrete facts and dated changes. A newer
  release may score differently, and we have not checked whether one matches this build exactly.
- **Cost.** Building the memory is the expensive part, because the Observer rereads its own notes on every call.
  Our full run spent about $1,250 on OpenRouter in total (Observer, embeddings and grading). By volume, the
  10M tier dominates: building one 10M memory reads about 104M input tokens, against 8M at 1M and 0.4M at 100K.
  A 10M conversation takes about 9 hours to ingest, and the ten finished memories take about 3 GB. A 100K
  conversation takes minutes.
- **Noise.** Two answer runs on the same 10M memories differed by up to 1.7 points. Ingesting the same conversation
  again changes the memory, and moved the score of two 10M conversations we re-ingested by +1.0 points, within
  ±4.5. BEAM-10M has only ten chats, so expect its score to vary more than the other tiers.
- **The answering transport.** We produced the published answers through Anthropic's Messages API with the
  provider's default settings. This repo sends the same kind of request with an API key. We have not rerun the
  full benchmark through the API-key route or through OpenRouter, so scores through those routes are unverified.
- **The grader.** Seven different graders scored the same 400 answers between 71.5% and 82.4%. Use the same grader
  to compare with our numbers.

## Layout

```
scripts/       fetch-dataset, ingest, answer, judge, report
src/ingest/    replays a chat through OM on a simulated clock
src/answer/    answers questions on a fresh copy of the memory
src/judge/     the BEAM judge prompt and scoring
src/report/    scores by ability
src/data/      loads chats and questions, assigns timestamps
src/storage/   an in-memory store that saves and restores a finished memory
tests/         unit tests (`pnpm test`; the dataset tests skip if data/ is missing)
```

## License

MIT. The judge prompt and scoring follow the [BEAM](https://github.com/mohammadtavakoli78/BEAM) code, which is
also MIT. The dataset is BEAM's and is downloaded from its repository.
