# Reels from voice memos

A voice memo can become a **Reel**: a vertical video (1080×1920, up to 60 seconds) with **your own voice**, a headline
across the top, big captions, and key-point cards. You never appear on camera. It goes to the review queue like every
other draft, with a caption per channel that takes video.

## What you get

- **Your voice.** The engine picks one stretch of the memo that stands on its own (a clear first sentence, one point, a
  clean end) and cuts the recording there. The sound is evened out and given a short fade.
- **A headline** at the top (what the Reel is about, written by Claude from what you said).
- **Captions**, a few words at a time, one word in the accent colour.
- **Key-point cards** (up to four) that appear while each point is spoken, like the boxes in an explainer video.
- **The picture behind:** a sound wave on the dark brand background, or, if the idea has your own photos attached
  (*Skapa*, or `--assets`), those photos in turn with a slow zoom.
- A caption text for each channel, written like any other post. The video is attached to each.

## How to get one

Record a memo and share it to the Drive folder as m4a ([MEMOS.md](MEMOS.md)). When the engine finds a stretch worth a
Reel, it makes one; otherwise you get posts or carousels as before. Nothing else to do or choose.

## What it needs

- `ffmpeg` on the machine that makes it. The **Voice memos** workflow installs it itself. **Check setup** shows a line
  `ffmpeg` and tells you if it is missing.
- Public storage (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`) for the finished file.
- The memo's recording stays in Drive. It is fetched again if the Reel is made in a later run than the transcription.
- Optional variables: `REEL_MAX_SECONDS` (10–180, default 60) and `MEMO_REELS=false` to switch Reels off.

## What it costs

Nothing extra beyond the memo itself: ffmpeg runs on the GitHub machine. A 40-second Reel takes well under a minute to draw
and the file is a few MB (the storage bucket accepts up to 50 MB; the engine refuses anything above 45 MB).

## How accurate are the captions? (read this)

Gemini gives the time each sentence begins, but those times are approximate: they come from the language model, in
tenths of a second at best, not from an alignment tool. The engine snaps each sentence to the nearest real pause in the
audio (within 1.5 s) and spreads the words over each sentence by their length. The result is **close, not frame exact**:
a caption can appear a fraction of a second early or late, mostly mid-sentence. Test it with one memo and watch.

Sound-synced word-by-word captions in the style of professional Reels need word timestamps from a speech-recognition
tool (for example Whisper). That is the upgrade if the sync bothers you.

## Limits

- The audio is published **exactly as spoken**. The planner is told to avoid stretches with anything private or
  confidential, slips, or a pause in the middle of a thought, but **watch the whole video before you approve it.**
- A stretch shorter than 8 seconds is not made into a Reel. One longer than the limit loses whole sentences from its end.
- If a Reel cannot be made (no ffmpeg, the recording is gone, the stretch is unusable) the idea becomes an ordinary post
  and the memo's note says why.
- Only memos picked up from Drive with timings can become Reels. `memo --text` and memos transcribed by an earlier
  version have no timings (they get posts and carousels).
- Not yet run against a live Gemini key, and the video encoding has been tried here with test recordings only. Check the
  first one on your phone (Instagram, LinkedIn and TikTok each re-encode video; the engine does not know their specs
  beyond the file being H.264 + AAC at 1080×1920).
