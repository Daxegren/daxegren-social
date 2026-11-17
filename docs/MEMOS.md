# Voice memos

Talk for a few minutes. The engine turns it into text, finds the points worth publishing and writes drafts of them: a
carousel for a list or an explanation, an ordinary post for a story or an opinion. The drafts wait in the review queue
like any other.

## The short way

1. Record a voice memo on your phone (the Voice Memos app is fine).
2. Share it to the Google Drive folder the engine watches (the same folder as your photos).
3. Within the hour you get a notification: *Röstmemo klart: N utkast väntar*. To not wait, open the GitHub app →
   Actions → **Voice memos** → Run workflow.

Share the recording as **m4a or mp3**. Other formats (for example `.caf` or `.qta`) are skipped with a note saying so.
Recordings over about 25 minutes (14 MB) are skipped too; split them.

## What it costs and what is kept

- Transcription: Gemini, audio costs the same as text on the default model (about 0.30 USD per million input tokens;
  one minute of audio is about 2,000 tokens), so a three-minute memo is a fraction of a cent. Google's docs list the
  default model as free to use on the free tier, **but then Google may use what you send to improve its products**.
  Use a key from a billed project, as you need for images anyway. Voice memos are more personal than posts.
- Ideas and drafts: a few Claude calls, cents.
- Only the **transcript** is stored (table `social_memos`, readable only by signed-in reviewers). The audio stays where you put it (Drive). Delete the Drive file whenever you like.

## What it does with what you said

- It picks at most three distinct points (`MEMO_MAX_IDEAS`, 1–6). If the memo holds one good idea you get one; if it
  holds none you get a notification saying so.
- Each point is stated **in your own facts and opinions**. The writer is told never to add numbers, results or claims you
  did not say, but check every draft: speech is loose, and a transcript can mishear (names, numbers).
- It leaves out anything that sounds private or confidential (full names of private people, customers, internal
  figures, health, family) unless you clearly mean it to be public. That is a safeguard, not a guarantee: the review
  step is yours.
- Drafts go to every configured channel, or only to the ones in `MEMO_CHANNELS` (for example `linkedin,instagram`).
  Carousels only go to channels that take at least four images. Without `SUPABASE_*` or `ANTHROPIC_API_KEY` carousel
  ideas become ordinary posts.

## Other ways in

```bash
npm run social -- memo "Ny inspelning.m4a"                 # transcribe a file and draft ideas
npm run social -- memo --text "Jag tänkte prata om marginal …" --name Marginal   # text you already have
npm run social -- memo-sync                                # what the workflow runs
```

`--text` skips transcription and costs only the Claude calls, so dictate with your phone's keyboard microphone, or paste
notes from Wispr Flow, Granola or any notes app.

## Setup

Secrets: `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `DRIVE_FOLDER_ID` (see
[DEPLOY.md](DEPLOY.md)); run migration `0008`. Optional variables: `GEMINI_TRANSCRIBE_MODEL` (default
`gemini-3.5-flash-lite`; a larger model may hear names and numbers better), `MEMO_CHANNELS`, `MEMO_MAX_IDEAS`.

## Limits

- Not yet tried against a live Gemini key: the first memo is the test. Run **Check setup** first.
- A memo that cannot be drafted is retried on the next runs, three times in all, then marked failed in the database.
  A recording Gemini cannot accept (format, size, no speech) is marked failed at once and not retried.
- The transcript is not shown in the review app; look in the `social_memos` table if you want to compare a draft with
  what was said.
- One speaker is assumed. Several voices are written out as one stream of text.
