-- A memo's transcript can be kept as timed stretches of speech ([{ "start": 3.2, "end": 9.8, "text": "..." }]).
-- Reels need the timings to cut the right part of the recording and to time the captions.
alter table social_memos add column segments jsonb;

-- A brief can ask for a Reel (a vertical video with the owner's own voice, made from a voice memo).
alter table social_briefs drop constraint social_briefs_format_check;
alter table social_briefs add constraint social_briefs_format_check check (format in ('post', 'carousel', 'reel'));
